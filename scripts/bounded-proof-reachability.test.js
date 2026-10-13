'use strict';
// Entirely offline. Permanent state and run proofs retain their raw evidence
// even when no published root/day manifest owns those objects.
const assert=require('assert/strict'),zlib=require('zlib');
const Store=require('../src/db/bounded-store'),State=require('../src/db/evidence-state');
const Backup=require('../src/db/bounded-backup'),Retention=require('../src/db/bounded-retention');
const {createMemoryProvider}=require('../src/db/bounded-object-provider');
const day='2026-10-13',old=Date.parse('2026-09-01T00:00:00Z');
const state=State.genesis([{address:'rAlice',scan_coverage_through:100,balance_drops:'1000',balance_ledger:100}],{
 anchor_ledger:100,anchor_close:day+'T00:00:00.000Z',
 // The exact imported checkpoint is backed by the separately pinned Git
 // history. Its old, non-content-addressed paths are not bounded references.
 evidence_shards:[{path:'evidence/2026/10/12/events.ndjson.gz',sha256:'e'.repeat(64),rows:1}]
});
const identity=account=>({account,bucket:account+'-fixture'});
async function fresh(){
 const provider=createMemoryProvider({identity:identity('source'),now:()=>old});
 const legacy={readPinnedState:async d=>({ref:d.ref,state}),resolveDayManifests:async(ds,d)=>({ref:d.ref,state:d.loaded_state,byDay:Object.fromEntries(ds.map(x=>[x,{shards:{}}]))}),readDays:async()=>({events:[]})};
 await Store.bootstrap(provider,state,{legacy,legacyRef:'a'.repeat(40),cutoverDay:day});return provider;
}
async function permanent(provider,value){const bytes=Buffer.from(JSON.stringify(value)),key=Store.PREFIX+'permanent/'+Backup.sha256(bytes);await provider.putImmutable(key,bytes);return key;}
async function shard(provider,kind,rows=[{hash:'a'.repeat(64)}]){
 const bytes=zlib.gzipSync(Buffer.from(rows.map(JSON.stringify).join('\n')+(rows.length?'\n':''))),sha256=Backup.sha256(bytes),key=Store.PREFIX+'objects/'+sha256;
 await provider.putImmutable(key,bytes);return {key,path:'evidence/2026/10/13/'+kind+'.'+sha256+'.ndjson.gz',sha256,rows:rows.length};
}
function run(ref){return {report_id:'SW-20261013-00001',anchor_ledger:101,anchor_close:day+'T01:00:00.000Z',target_wallets:1,complete_wallets:1,wallets:state.wallets.map(w=>({...w,last_proven_ledger:101,balance_ledger:101})),evidence_shards:[{path:ref.path,sha256:ref.sha256,rows:ref.rows}]};}
async function copy(provider){const result=createMemoryProvider({identity:identity('recovery'),now:()=>old});for(const e of await provider.list()){const b=await provider.get(e.key);if(e.key===Store.ROOT)await result.compareAndSwap(e.key,null,b);else await result.putImmutable(e.key,b);}return result;}
function without(provider,key){return {...provider,list:async()=>(await provider.list()).filter(e=>e.key!==key),get:async k=>k===key?null:provider.get(k)};}
(async()=>{
 const source=await fresh();assert.equal((await Backup.capture(source)).coverage.recursive_references_verified,true);
 const a=await shard(source,'events'),orphan=State.advance(state,run(a));await permanent(source,orphan);
 const b=await shard(source,'payloads',[{hash:'b'.repeat(64),raw_tx:{}}]);
 const runProof={...run(b),state_version:2,state_sha256:orphan.state_sha256,input_digest:'f'.repeat(64)};await permanent(source,runProof);
 const recovery=await copy(source),manifest=await Backup.capture(source);
 assert.equal((await Backup.verifyRestore(manifest,recovery,{recoveryIdentity:recovery.identity})).restore_verified,true);
 const plan=await Retention.planRetention(source,recovery,{sourceIdentity:source.identity,recoveryIdentity:recovery.identity,now:Date.parse('2026-10-14T00:00:00Z')});
 for(const ref of [a,b]){const e=plan.entries.find(e=>e.key===ref.key);assert.equal(e.disposition,'HOLD');assert(e.reasons.includes('PERMANENT_PROOF_DEPENDENCY'));await assert.rejects(Backup.capture(without(source,ref.key)),/PROOF_SHARD_MISSING/);await assert.rejects(Backup.verifyRestore(manifest,without(recovery,ref.key),{recoveryIdentity:recovery.identity}),/PROOF_SHARD_MISSING/);}
 // A same-version unrelated orphan cannot claim the bootstrap legacy exemption.
 const ambiguous=await fresh();await permanent(ambiguous,State.seal({...state,evidence_shards:[{path:a.path,sha256:a.sha256,rows:1}]}));
 await assert.rejects(Backup.capture(ambiguous),/PROOF_LEGACY_BOUNDARY_INVALID/);
 for(const path of ['evidence/2026/10/12/events.'+a.sha256+'.ndjson.gz','evidence/2026/10/13/events.'+'0'.repeat(64)+'.ndjson.gz','evidence/2026/10/13/events.ndjson.gz']){
  const invalid=await fresh();await permanent(invalid,{...runProof,evidence_shards:[{path,sha256:a.sha256,rows:1}]});await assert.rejects(Backup.capture(invalid),/PROOF_(LEGACY_BOUNDARY|SHARD)_INVALID/);
 }
 // State serialization records a zero-row shard count as null. It still owns
 // the hash-named shard, whose compression/JSON is independently validated.
 const empty=await fresh(),emptyShard=await shard(empty,'events',[]);await permanent(empty,State.advance(state,run(emptyShard)));await Backup.capture(empty);
 console.log('PASS bounded proof reachability: orphan state/run dependencies, independent restore omissions, exact legacy exemption, malformed paths, empty shards; no production I/O');
})().catch(e=>{console.error(e);process.exitCode=1;});
