'use strict';
const assert=require('assert/strict'),fs=require('fs'),os=require('os'),path=require('path'),{pipeline}=require('stream/promises');
const U=require('./forensic-archive'),R=require('./r2-master-backup');
(async()=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'sw-archive-test-'));
 try{
  const archive=path.join(root,'source.tar.gz'),remote=path.join(root,'remote'),source='a'.repeat(40);
  // The previous 100 MiB guard rejected legitimate exports. A sparse fixture
  // exercises a larger transfer without holding its contents in memory.
  fs.closeSync(fs.openSync(archive,'wx'));fs.truncateSync(archive,101*1024*1024);
  const objects=new Map();let puts=0,gets=0,full=false,corrupt=false,failPut=false,largestChunk=0;
  const s3={send:async command=>{
   const x=command.input;
   if(command.constructor.name==='ListObjectsV2Command')return{Contents:[...objects].map(([Key,Size])=>({Key,Size})).concat(full?[{Key:'other',Size:R.LIMIT}]:[]),IsTruncated:false};
   if(command.constructor.name==='PutObjectCommand'){
    puts++;assert.equal(x.IfNoneMatch,'*');assert.equal(x.ContentLength,fs.statSync(archive).size);assert(!Buffer.isBuffer(x.Body));
    if(failPut)throw Error('INTERRUPTED_UPLOAD');
    x.Body.on('data',b=>{largestChunk=Math.max(largestChunk,b.length);});await pipeline(x.Body,fs.createWriteStream(remote));objects.set(x.Key,fs.statSync(remote).size);return{};
   }
   if(command.constructor.name==='GetObjectCommand'){gets++;if(corrupt){const fd=fs.openSync(remote,'r+');fs.writeSync(fd,Buffer.from([1]),0,1,0);fs.closeSync(fd);}return{Body:fs.createReadStream(remote)};}
   throw Error('UNEXPECTED_COMMAND');
  }};
  const first=await U.publish(archive,source,s3);assert.equal(first.bytes,101*1024*1024);assert(first.independent_readback_verified);assert.equal(puts,1);assert.equal(gets,1);assert(largestChunk<1024*1024);
  assert.equal((await U.publish(archive,source,s3)).new_bytes,0);assert.equal(puts,1);assert.equal(gets,2,'reused objects still receive an independent readback');
  corrupt=true;await assert.rejects(U.publish(archive,source,s3),/READBACK_HASH_MISMATCH/);corrupt=false;
  objects.set(first.key,1);await assert.rejects(U.publish(archive,source,s3),/EXISTING_SIZE_MISMATCH/);objects.clear();
  full=true;await assert.rejects(U.publish(archive,source,s3),/CAPACITY_STOP/);assert.equal(puts,1);full=false;
  failPut=true;await assert.rejects(U.publish(archive,source,s3),/INTERRUPTED_UPLOAD/);assert.equal(gets,3);
  await assert.rejects(U.digest((async function*(){yield Buffer.from('a');})(),2),/SIZE_MISMATCH/);
  await assert.rejects(U.digest((async function*(){yield Buffer.from('ab');})(),1),/SIZE_MISMATCH/);
  console.log('PASS >100 MiB streamed export, bounded chunks, independent readback, corrupt/truncated rejection, reuse, interrupted upload and unchanged bucket capacity stop');
 }finally{fs.rmSync(root,{recursive:true,force:true});}
})().catch(e=>{console.error(e);process.exitCode=1;});
