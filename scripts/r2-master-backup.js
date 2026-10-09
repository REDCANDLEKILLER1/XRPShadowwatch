#!/usr/bin/env node
'use strict';
// Operator-only worker. Never imported by the browser or a Vercel Function.
const fs=require('fs'),path=require('path');
const {S3Client,ListObjectsV2Command,PutObjectCommand,GetObjectCommand}=require('@aws-sdk/client-s3');
const B=require('../src/db/master-backup');
const ENDPOINT='https://3038dc05227c27ee2bf516c3d3d5d297.r2.cloudflarestorage.com';
const BUCKET='shadowwatch-backups',LIMIT=8_000_000_000;
function client(env=process.env){
 for(const key of ['R2_ACCESS_KEY_ID','R2_SECRET_ACCESS_KEY'])if(!env[key])throw Error('MISSING_'+key);
 return new S3Client({endpoint:ENDPOINT,region:'auto',maxAttempts:3,
  requestChecksumCalculation:'WHEN_REQUIRED',responseChecksumValidation:'WHEN_REQUIRED',
  credentials:{accessKeyId:env.R2_ACCESS_KEY_ID,secretAccessKey:env.R2_SECRET_ACCESS_KEY}});
}
async function inventory(s3){
 const objects=new Map(),tokens=new Set();let token,total=0;
 do{
  const page=await s3.send(new ListObjectsV2Command({Bucket:BUCKET,ContinuationToken:token}));
  for(const o of page.Contents||[]){
   if(typeof o.Key!=='string'||!Number.isSafeInteger(o.Size)||o.Size<0||objects.has(o.Key))throw Error('R2_INVENTORY_INVALID');
   objects.set(o.Key,o.Size);total+=o.Size;
  }
  if(!page.IsTruncated)break;
  token=page.NextContinuationToken;
  if(!token||tokens.has(token))throw Error('R2_INVENTORY_INCOMPLETE');tokens.add(token);
 }while(true);
 return{objects,total};
}
async function download(s3,key,expectedBytes,expectedSha){
 const result=await s3.send(new GetObjectCommand({Bucket:BUCKET,Key:key}));
 const chunks=[];let size=0;
 for await(const chunk of result.Body){size+=chunk.length;if(size>expectedBytes)throw Error('R2_DOWNLOAD_SIZE_MISMATCH');chunks.push(Buffer.from(chunk));}
 const data=Buffer.concat(chunks);
 if(size!==expectedBytes||B.sha256(data)!==expectedSha)throw Error('R2_DOWNLOAD_HASH_MISMATCH');
 return data;
}
async function roundTrip(source,downloaded,restored,s3){
 const verified=B.verify(source);
 if(fs.existsSync(downloaded)||fs.existsSync(restored))throw Error('R2_DESTINATION_EXISTS');
 const manifestBytes=fs.readFileSync(path.join(source,'manifest.json'));
 const manifest=JSON.parse(manifestBytes);
 const manifestKey='manifests/'+verified.source_commit+'/'+verified.manifest_sha256+'.json';
 const planned=new Map();
 for(const e of manifest.files){
  if(!/^[a-f0-9]{64}$/.test(e.sha256))throw Error('R2_HASH_INVALID');
  planned.set('objects/sha256/'+e.sha256,{bytes:e.bytes,sha:e.sha256,file:path.join(source,e.path)});
 }
 planned.set(manifestKey,{bytes:manifestBytes.length,sha:B.sha256(manifestBytes),file:path.join(source,'manifest.json')});
 const before=await inventory(s3);let added=0;
 for(const [key,e] of planned){
  if(before.objects.has(key)){if(before.objects.get(key)!==e.bytes)throw Error('R2_EXISTING_OBJECT_SIZE_MISMATCH');}
  else added+=e.bytes;
 }
 if(before.total+added>LIMIT)throw Error('R2_CAPACITY_STOP');
 // All source checks and the complete capacity plan pass before any upload.
 // Manifest is last; partial attempts leave reusable objects, never a receipt.
 for(const [key,e] of planned)if(!before.objects.has(key)){
  const body=fs.readFileSync(e.file);
  if(body.length!==e.bytes||B.sha256(body)!==e.sha)throw Error('R2_SOURCE_CHANGED');
  await s3.send(new PutObjectCommand({Bucket:BUCKET,Key:key,Body:body,IfNoneMatch:'*',ContentType:'application/octet-stream'}));
 }
 fs.mkdirSync(downloaded);
 // Read back every byte from R2, including reused objects and the manifest.
 const remoteManifest=await download(s3,manifestKey,manifestBytes.length,B.sha256(manifestBytes));
 fs.writeFileSync(path.join(downloaded,'manifest.json'),remoteManifest,{flag:'wx'});
 for(const e of manifest.files){
  const data=await download(s3,'objects/sha256/'+e.sha256,e.bytes,e.sha256);
  const dest=path.join(downloaded,B.relative(e.path));fs.mkdirSync(path.dirname(dest),{recursive:true});fs.writeFileSync(dest,data,{flag:'wx'});
 }
 const result=B.restore(downloaded,restored,verified.source_commit,verified.manifest_sha256);
 return{...result,destination_uri:ENDPOINT+'/'+BUCKET+'/'+manifestKey,bucket_bytes_before:before.total,new_bytes:added,projected_bucket_bytes:before.total+added};
}
async function run(){
 const root=process.argv[2];if(!root)throw Error('Usage: node scripts/r2-master-backup.js NEW_WORK_DIRECTORY');
 const s3=client();fs.mkdirSync(root,{recursive:false});
 const source=path.join(root,'source'),downloaded=path.join(root,'downloaded'),restored=path.join(root,'restored');
 await B.backup(source,{onProgress:(n,total)=>{if(n%100===0||n===total)console.log('Verified source files: '+n+'/'+total);}});
 const result=await roundTrip(source,downloaded,restored,s3);
 fs.writeFileSync(path.join(root,'result.json'),JSON.stringify(result,null,2)+'\n',{flag:'wx'});
 console.log(JSON.stringify(result,null,2));
 // This is independent source/manifest evidence, not a private data artifact.
 if(process.env.GITHUB_STEP_SUMMARY)fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY,
  'R2 download and isolated restore passed.\n\nSource commit: `'+result.source_commit+'`\n\nManifest SHA256: `'+result.manifest_sha256+'`\n\nFiles: '+result.files+'; bytes: '+result.bytes+'\n');
}
if(require.main===module)run().catch(e=>{console.error('R2 backup failed:',String(e.message).replace(/https?:\/\/\S+/g,'[endpoint]'));process.exitCode=1;});
module.exports={roundTrip,inventory,download,client,LIMIT,BUCKET};
