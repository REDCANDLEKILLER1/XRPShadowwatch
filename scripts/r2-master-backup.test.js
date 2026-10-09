'use strict';
const assert=require('assert/strict'),fs=require('fs'),os=require('os'),path=require('path');
const B=require('../src/db/master-backup'),S=require('../src/db/evidence-state'),Store=require('../src/db/github-store'),A=require('../src/db/github-archive');
const R=require('./r2-master-backup');
const P=require('./publish-restore-receipt'),Receipt=require('../src/db/backup-receipt');
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
  const restored=await go(1);assert(restored.restore_verified);assert.equal(gets,files.length+1);const initialWrites=writes;
  // The handoff uses the real R2-downloaded fixture and isolated restore.
  let published=null,commits=0,conflict=false,badReadback=false,badTree=false;
  const now=Date.now(),env={SHADOWWATCH_EVIDENCE_TOKEN:'fixture'};
  const gh=async(method,p)=>{assert.equal(method,'GET');if(p.startsWith('/git/commits/'))return{tree:{sha:badTree?'d'.repeat(40):m.source_tree}};if(p.startsWith('/git/ref/'))return{object:{sha:'e'.repeat(40)}};throw Error('unexpected '+p);};
  const readFile=async(_gh,_branch,p,ref)=>{assert.equal(p,P.LATEST);if(badReadback&&ref==='f'.repeat(40))return 'corrupt';return published;};
  const commitFiles=async(_gh,_branch,_parent,files)=>{commits++;if(conflict){conflict=false;throw Object.assign(Error('raced collector'),{refConflict:true});}assert.deepEqual(Object.keys(files),[P.LATEST],'only receipt metadata changes');published=files[P.LATEST];return{commit_sha:'f'.repeat(40)};};
  const deps={env,gh,readFile,commitFiles,now:()=>now};
  assert((await P.publish(path.join(root,'restore-1'),restored,deps)).published);
  const receipt=JSON.parse(published);assert.equal(receipt.source_commit,m.source_commit);assert.equal(receipt.manifest_sha256,m.manifest_sha256);
  assert(Receipt.status(receipt,now).independent_restore_verified,'production recognizes automated R2 proof');
  assert.match(Receipt.status(receipt,now).verification_method,/R2-downloaded/);
  assert(!Receipt.status({...receipt,independent_readback_verified:false},now).independent_restore_verified);
  assert(!Receipt.status({...receipt,source_tree:null},now).independent_restore_verified);
  assert(!Receipt.status({...receipt,verified_at:new Date(now-25*3600000).toISOString()},now).independent_restore_verified);
  assert(!Receipt.status({...receipt,evidence_anchor_close:new Date(now-25*3600000).toISOString()},now).independent_restore_verified);
  assert(Receipt.status({...receipt,destination_verification:'OPERATOR_DOWNLOADED_AND_RESTORED'},now).independent_restore_verified,'manual receipts remain supported');
  const before=commits;
  await assert.rejects(P.publish(path.join(root,'restore-1'),{...restored,independent_readback_verified:false},deps),/INDEPENDENT_RESTORE/);assert.equal(commits,before);
  await assert.rejects(P.publish(path.join(root,'restore-1'),restored,{...deps,env:{...env,VERCEL_ENV:'preview'}}),/REFUSED/);assert.equal(commits,before);
  badTree=true;await assert.rejects(P.publish(path.join(root,'restore-1'),restored,deps),/NOT_CANONICAL/);badTree=false;assert.equal(commits,before);
  await assert.rejects(P.publish(path.join(root,'restore-1'),restored,{...deps,now:()=>now+25*3600000}),/NOT_RECENT/);assert.equal(commits,before);
  published=JSON.stringify({...receipt,evidence_anchor_close:new Date(now+1).toISOString()});assert.equal((await P.publish(path.join(root,'restore-1'),restored,deps)).reason,'NEWER_RESTORE_RECEIPT_PRESENT');assert.equal(commits,before);
  published=null;conflict=true;assert((await P.publish(path.join(root,'restore-1'),restored,deps)).published);assert.equal(commits,before+2);
  badReadback=true;await assert.rejects(P.publish(path.join(root,'restore-1'),restored,deps),/READBACK_MISMATCH/);badReadback=false;
  fs.appendFileSync(path.join(root,'restore-1','README.md'),'tampered');const prior=commits;await assert.rejects(P.publish(path.join(root,'restore-1'),restored,deps),/FILE_MISMATCH/);assert.equal(commits,prior);
  for(const script of ['r2-master-backup.js','forensic-backup.js'])assert.match(fs.readFileSync(path.join(__dirname,script),'utf8'),/publish-restore-receipt.*\.publish\(restored,/,'both workers wire the actual restore to receipt publication');
  assert((await go(2)).restore_verified);assert.equal(writes,initialWrites,'identical objects reused');
  await assert.rejects(go(2),/DESTINATION_EXISTS/);
  corrupt=true;await assert.rejects(go(3),/DOWNLOAD/);assert(!fs.existsSync(path.join(root,'restore-3')));corrupt=false;
  missing=true;await assert.rejects(go(4),/NoSuchKey/);missing=false;
  overCapacity=true;await assert.rejects(go(5),/CAPACITY_STOP/);assert.equal(writes,initialWrites);overCapacity=false;
  objects.clear();failPut=true;await assert.rejects(go(6),/upload interrupted/);assert(!fs.existsSync(path.join(root,'download-6')));
  await assert.rejects(R.inventory({send:async()=>({IsTruncated:true})}),/INCOMPLETE/);
  await assert.rejects(R.inventory({send:async()=>({IsTruncated:true,NextContinuationToken:'same'})}),/INCOMPLETE/);
  assert.throws(()=>R.client({}),/MISSING_R2_ACCESS_KEY_ID/);
  console.log('PASS R2 independent full restore and production receipt handoff: canonical tree, readback, freshness, preview refusal, conflict retry, newer-proof preservation, tampered restore rejection; unchanged capacity and source data');
 }finally{fs.rmSync(root,{recursive:true,force:true});}
})().catch(e=>{console.error(e);process.exitCode=1;});
