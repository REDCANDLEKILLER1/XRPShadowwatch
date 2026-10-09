'use strict';
const assert=require('assert/strict'),fs=require('fs'),os=require('os'),path=require('path');
const B=require('../src/db/master-backup'),S=require('../src/db/evidence-state'),Store=require('../src/db/github-store'),A=require('../src/db/github-archive');
const R=require('./r2-master-backup');
(async()=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'sw-r2-test-'));
 try{
  const source=path.join(root,'source');fs.mkdirSync(source);
  const state=S.genesis([{address:'rTest',scan_coverage_through:100}],{anchor_ledger:100,anchor_close:new Date().toISOString(),evidence_shards:[]});
  const data={'README.md':Buffer.from('private fixture'),[Store.STATE_PATH]:Buffer.from(S.serialize(state)),[Store.historyPath(1)]:Buffer.from(S.serialize(state))};
  const files=Object.entries(data).map(([p,b])=>{const file=path.join(source,p);fs.mkdirSync(path.dirname(file),{recursive:true});fs.writeFileSync(file,b);return{path:p,bytes:b.length,sha256:B.sha256(b),git_blob_sha:B.blobSha(b)};});
  const m={schema:B.SCHEMA,source_commit:'c'.repeat(40),source_repository:A.EVIDENCE_REPO,source_tree:B.treeSha(files),files,file_count:files.length,total_bytes:files.reduce((n,e)=>n+e.bytes,0)};m.manifest_sha256=B.seal(m);
  fs.writeFileSync(path.join(source,'manifest.json'),JSON.stringify(m));
  const objects=new Map();let writes=0,gets=0,corrupt=false,missing=false,failPut=false,overCapacity=false;
  const s3={send:async command=>{
   const {Key,Body,IfNoneMatch}=command.input;
   switch(command.constructor.name){
    case 'ListObjectsV2Command':return{Contents:[...objects].map(([Key,b])=>({Key,Size:b.length})).concat(overCapacity?[{Key:'unrelated',Size:R.LIMIT}]:[]),IsTruncated:false};
    case 'PutObjectCommand':if(failPut)throw Error('upload interrupted');assert.equal(IfNoneMatch,'*');assert(!objects.has(Key));objects.set(Key,Buffer.from(Body));writes++;return{};
    case 'GetObjectCommand':gets++;if(missing)throw Error('NoSuchKey');return{Body:(async function*(){yield corrupt?Buffer.from('corrupt'):objects.get(Key);})()};
    default:throw Error('Unexpected operation');
   }
  }};
  const go=n=>R.roundTrip(source,path.join(root,'download-'+n),path.join(root,'restore-'+n),s3);
  assert((await go(1)).restore_verified);assert.equal(gets,files.length+1);const initialWrites=writes;
  assert((await go(2)).restore_verified);assert.equal(writes,initialWrites,'identical objects reused');
  await assert.rejects(go(2),/DESTINATION_EXISTS/);
  corrupt=true;await assert.rejects(go(3),/DOWNLOAD/);assert(!fs.existsSync(path.join(root,'restore-3')));corrupt=false;
  missing=true;await assert.rejects(go(4),/NoSuchKey/);missing=false;
  overCapacity=true;await assert.rejects(go(5),/CAPACITY_STOP/);assert.equal(writes,initialWrites);overCapacity=false;
  objects.clear();failPut=true;await assert.rejects(go(6),/upload interrupted/);assert(!fs.existsSync(path.join(root,'download-6')));
  await assert.rejects(R.inventory({send:async()=>({IsTruncated:true})}),/INCOMPLETE/);
  await assert.rejects(R.inventory({send:async()=>({IsTruncated:true,NextContinuationToken:'same'})}),/INCOMPLETE/);
  assert.throws(()=>R.client({}),/MISSING_R2_ACCESS_KEY_ID/);
  console.log('PASS R2 independent full restore, deduplication, corruption/missing/interrupted-object rejection, capacity preflight, pagination failure, credential preflight');
 }finally{fs.rmSync(root,{recursive:true,force:true});}
})().catch(e=>{console.error(e);process.exitCode=1;});
