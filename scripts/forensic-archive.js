'use strict';
// Operator-only. Stream the archive and its independent R2 readback so the
// size of legitimate evidence is not also the worker's memory requirement.
const fs=require('fs'),crypto=require('crypto');
const {finished}=require('stream/promises');
const {PutObjectCommand,GetObjectCommand}=require('@aws-sdk/client-s3');
const R=require('./r2-master-backup');
async function digest(stream,expectedBytes){
 const hash=crypto.createHash('sha256');let bytes=0;
 for await(const chunk of stream){bytes+=chunk.length;if(bytes>expectedBytes)throw Error('FORENSIC_ARCHIVE_SIZE_MISMATCH');hash.update(chunk);}
 if(bytes!==expectedBytes)throw Error('FORENSIC_ARCHIVE_SIZE_MISMATCH');return hash.digest('hex');
}
async function publish(archive,sourceCommit,s3){
 if(!/^[a-f0-9]{40}$/.test(sourceCommit))throw Error('FORENSIC_ARCHIVE_SOURCE_INVALID');
 const stat=fs.lstatSync(archive),bytes=stat.size;
 if(!stat.isFile()||!Number.isSafeInteger(bytes)||bytes<=0||bytes>R.LIMIT)throw Error('FORENSIC_ARCHIVE_SIZE_STOP');
 const sha256=await digest(fs.createReadStream(archive),bytes),key='forensics/'+sourceCommit+'/'+sha256+'/shadowwatch-forensics.tar.gz';
 const before=await R.inventory(s3),exists=before.objects.has(key);
 if(exists&&before.objects.get(key)!==bytes)throw Error('FORENSIC_ARCHIVE_EXISTING_SIZE_MISMATCH');
 const added=exists?0:bytes;
 if(before.total+added>R.LIMIT)throw Error('FORENSIC_CAPACITY_STOP');
 if(!exists){
  const body=fs.createReadStream(archive),closed=finished(body);closed.catch(()=>{});
  try{await s3.send(new PutObjectCommand({Bucket:R.BUCKET,Key:key,Body:body,ContentLength:bytes,IfNoneMatch:'*',ContentType:'application/gzip'}));}
  finally{body.destroy();await closed.catch(()=>{});}
 }
 const remote=await s3.send(new GetObjectCommand({Bucket:R.BUCKET,Key:key}));
 if(await digest(remote.Body,bytes)!==sha256)throw Error('FORENSIC_ARCHIVE_READBACK_HASH_MISMATCH');
 return{key,sha256,bytes,independent_readback_verified:true,new_bytes:added,projected_bucket_bytes:before.total+added};
}
module.exports={digest,publish};
