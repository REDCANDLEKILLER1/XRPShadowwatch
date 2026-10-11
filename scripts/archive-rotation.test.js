'use strict';
const assert=require('assert/strict'),fs=require('fs'),os=require('os'),path=require('path'),zlib=require('zlib');
const C=require('../research/archive-rotation/catalog'),B=require('../src/db/master-backup'),S=require('../src/db/evidence-state'),Store=require('../src/db/github-store'),A=require('../src/db/github-archive');
(async()=>{const root=fs.mkdtempSync(path.join(os.tmpdir(),'sw-rotation-'));try{
 const data={},states=[];
 function fixture(n){const date='2026-10-0'+n;const shards=[];
  for(const kind of ['events','participants','payloads']){const p='evidence/'+date.replaceAll('-','/')+'/'+kind+'.ndjson.gz';const b=zlib.gzipSync(JSON.stringify({hash:String(n).repeat(64),kind})+'\n');data[p]=b;shards.push({path:p,sha256:B.sha256(b),rows:1});}
  const state=n===1?S.genesis([{address:'rTest',scan_coverage_through:100}],{anchor_ledger:100,anchor_close:'2026-10-02T00:00:00Z',evidence_shards:shards}):S.seal({...states[n-2],state_version:n,previous_state_sha256:states[n-2].state_sha256,anchor_ledger:100*n,anchor_close:'2026-10-03T00:00:00Z',evidence_shards:shards});states.push(state);
  data[Store.STATE_PATH]=Buffer.from(S.serialize(state));data[Store.historyPath(n)]=Buffer.from(S.serialize(state));
  const dir=path.join(root,'p'+n);fs.mkdirSync(dir);const files=Object.entries(data).map(([p,b])=>{fs.mkdirSync(path.dirname(path.join(dir,p)),{recursive:true});fs.writeFileSync(path.join(dir,p),b);return{path:p,bytes:b.length,sha256:B.sha256(b),git_blob_sha:B.blobSha(b)};});
  const m={schema:B.SCHEMA,source_commit:String(n).repeat(40),source_repository:A.EVIDENCE_REPO,source_tree:B.treeSha(files),files,file_count:files.length,total_bytes:files.reduce((v,e)=>v+e.bytes,0)};m.manifest_sha256=B.seal(m);fs.writeFileSync(path.join(dir,'manifest.json'),JSON.stringify(m));
  const recovery=path.join(root,'r'+n);B.restore(dir,recovery,m.source_commit,m.manifest_sha256);return{id:'segment-'+n,first:date,last:date,primary:dir,recovery};
 }
 const one=fixture(1),two=fixture(2),empty=C.seal([]);
 const first=await C.append(empty,empty.sha256,one),second=await C.append(first,first.sha256,two);
 assert.equal(first.segments.length,1);assert.equal(empty.segments.length,0);
 assert.deepEqual(await C.append(second,second.sha256,two),second,'resume/replay idempotent');
 const loc={'segment-1':[one.primary,one.recovery],'segment-2':[two.primary,two.recovery]};
 for(const kind of ['events','participants','payloads']){const rows=await C.query(second,second.sha256,one.first,two.last,loc,kind);assert.deepEqual(rows.flatMap(r=>r.events.map(e=>e.hash)),['1'.repeat(64),'2'.repeat(64)]);}
 await assert.rejects(C.query(second,'a'.repeat(64),one.first,two.last,loc),/UNVERIFIED/);
 await assert.rejects(C.query(second,second.sha256,'2026-09-30',two.last,loc),/UNCOVERED/);
 await assert.rejects(C.append(first,first.sha256,{...two,first:one.first}),/BOUNDARY/);
 await assert.rejects(C.append(first,first.sha256,{...two,recovery:two.primary}),/NOT_SEPARATE/);
 await assert.rejects(C.append(first,first.sha256,{...two,last:'2026-10-03'}),/INVALID/);
 await assert.rejects(C.append(second,second.sha256,{...two,id:one.id}),/REPLAY_CONFLICT/);
 // Interrupted preparation cannot change an existing catalog or old-history reads.
 await assert.rejects(C.append(first,first.sha256,{...two,recovery:path.join(root,'missing')}));
 assert.equal((await C.query(first,first.sha256,one.first,one.last,loc))[0].events.length,1);
 const shard=path.join(one.primary,'evidence/2026/10/01/events.ndjson.gz');fs.appendFileSync(shard,'corrupt');
 assert.equal((await C.query(second,second.sha256,one.first,two.last,loc))[0].recovered,true);
 fs.rmSync(one.recovery,{recursive:true});await assert.rejects(C.query(second,second.sha256,one.first,two.last,loc),/UNAVAILABLE/);
 // A valid but unrelated checkpoint history must not join the catalog.
 const prior=JSON.parse(fs.readFileSync(path.join(two.primary,Store.historyPath(1))));prior.anchor_ledger=99;
 const fork=S.seal(prior),next=S.seal({...states[1],previous_state_sha256:fork.state_sha256});
 for(const dir of [two.primary,two.recovery]){fs.writeFileSync(path.join(dir,Store.historyPath(1)),S.serialize(fork));fs.writeFileSync(path.join(dir,Store.historyPath(2)),S.serialize(next));fs.writeFileSync(path.join(dir,Store.STATE_PATH),S.serialize(next));const m=JSON.parse(fs.readFileSync(path.join(dir,'manifest.json')));for(const e of m.files){const b=fs.readFileSync(path.join(dir,e.path));Object.assign(e,{bytes:b.length,sha256:B.sha256(b),git_blob_sha:B.blobSha(b)});}m.total_bytes=m.files.reduce((v,e)=>v+e.bytes,0);m.source_tree=B.treeSha(m.files);m.manifest_sha256=B.seal(m);fs.writeFileSync(path.join(dir,'manifest.json'),JSON.stringify(m));}
 await assert.rejects(C.append(first,first.sha256,two),/ANCESTRY/);
 console.log('PASS offline archive: cross-segment three-kind retrieval, catalog pinning, ancestry, gaps, boundaries, recovery, corruption, replay, interrupted preparation and rollback; no production I/O');
 }finally{fs.rmSync(root,{recursive:true,force:true});}})().catch(e=>{console.error(e);process.exitCode=1;});
