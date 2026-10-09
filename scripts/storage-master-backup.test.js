'use strict';
const assert=require('assert/strict'),fs=require('fs'),os=require('os'),path=require('path'),zlib=require('zlib');
const B=require('../src/db/master-backup'),H=require('../src/db/storage-health'),S=require('../src/db/evidence-state'),Store=require('../src/db/github-store'),A=require('../src/db/github-archive');
(async()=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'sw-backup-test-'));
 try{
  const raw=JSON.stringify({hash:'a'.repeat(64)})+'\n',shard='evidence/2026/10/08/events.ndjson.gz';
  const state=S.genesis([{address:'rTest',scan_coverage_through:100}],{anchor_ledger:100,anchor_close:'2026-10-08T13:00:00.000Z',evidence_shards:[{path:shard,sha256:B.sha256(zlib.gzipSync(raw)),rows:1}]});
  const data={'README.md':Buffer.from('private evidence\n'),[Store.STATE_PATH]:Buffer.from(S.serialize(state)),[Store.historyPath(1)]:Buffer.from(S.serialize(state)),[shard]:zlib.gzipSync(raw)};
  const entries=Object.entries(data).map(([p,b])=>({path:p,type:'blob',mode:'100644',sha:B.blobSha(b),size:b.length}));
  const tree={tree:entries,truncated:false},treeHash=B.treeSha(entries.map(e=>({path:e.path,git_blob_sha:e.sha}))),commit='c'.repeat(40);let writes=0;
  const gh=async(method,p)=>{if(method!=='GET'){writes++;throw Error('write');}if(p.startsWith('/git/ref'))return{object:{sha:commit}};if(p.startsWith('/git/commits'))return{tree:{sha:treeHash}};if(p.startsWith('/git/trees'))return tree;if(p==='')return{size:7*1024*1024};
   if(p.startsWith('/contents/')){const name=p.slice(10).split('?')[0];const b=data[name];return b?{content:b.toString('base64'),encoding:'base64',size:b.length}:null;}throw Error('unexpected '+p);};
  const deps={env:{SHADOWWATCH_EVIDENCE_TOKEN:'fixture'},gh};
  const health=await H.health(deps);assert.equal(health.capacity_status,'WARNING');assert.equal(health.backup.status,'NOT_VERIFIED');assert(health.checkpoint.verified);assert.equal(health.current_files,4);assert.equal(health.deletion_enabled,false);
  assert.throws(()=>H.inventory({tree:[],truncated:true}),/INCOMPLETE/);assert.throws(()=>H.inventory({tree:[{type:'blob',mode:'120000',size:2}]}),/UNSUPPORTED/);
  const out=path.join(root,'backup');const done=await B.backup(out,deps);assert(done.verified);assert.equal(done.files,4);assert.equal(writes,0);assert.equal(done.checkpoint_versions,1);
  const restored=path.join(root,'restore');assert(B.restore(out,restored,commit).restore_verified);assert.throws(()=>B.restore(out,restored),/EEXIST/);assert.throws(()=>B.verify(out,'d'.repeat(40)),/COMMIT_MISMATCH/);
  const file=path.join(out,'README.md');fs.appendFileSync(file,'altered');assert.throws(()=>B.verify(out),/FILE_MISMATCH/);fs.writeFileSync(file,data['README.md']);
  const manifestFile=path.join(out,'manifest.json'),manifest=JSON.parse(fs.readFileSync(manifestFile));
  const missing={...manifest,files:manifest.files.slice(1)};missing.file_count=missing.files.length;missing.total_bytes=missing.files.reduce((n,e)=>n+e.bytes,0);missing.manifest_sha256=B.seal(missing);fs.writeFileSync(manifestFile,JSON.stringify(missing));assert.throws(()=>B.verify(out),/TREE_MISMATCH/);fs.writeFileSync(manifestFile,JSON.stringify(manifest));
  fs.unlinkSync(file);fs.symlinkSync('/etc/hostname',file);assert.throws(()=>B.verify(out),/FILE_REFUSED/);
  for(const p of ['../x','/x','a/../x','a\\x','manifest.json'])assert.throws(()=>B.relative(p),/REFUSED/);
  console.log('PASS storage inventory, immutable complete backup, Git tree/blob + SHA256 verification, checkpoint/shard proof, isolated restore, tamper/path/symlink/truncation rejection; zero source writes');
 }finally{fs.rmSync(root,{recursive:true,force:true});}
})().catch(e=>{console.error(e);process.exitCode=1;});
