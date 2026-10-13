'use strict';
const assert=require('assert/strict'),zlib=require('zlib');
const B=require('../src/db/bounded-store'),S=require('../src/db/evidence-state'),J=require('../src/db/run-journal');
const Backup=require('../src/db/bounded-backup'),R=require('../src/db/bounded-retention');
const {createMemoryProvider}=require('../src/db/bounded-object-provider');
const start='2026-09-01T00:00:00.000Z';
const genesis=S.genesis([{address:'rAlice',scan_coverage_through:100,balance_drops:'1000000',balance_ledger:100}],{anchor_ledger:100,anchor_close:start});
const legacy={readPinnedState:async d=>({ref:d.ref,state:genesis}),resolveDayManifests:async(days,d)=>({ref:d.ref,state:d.loaded_state,byDay:Object.fromEntries(days.map(day=>[day,{shards:{}}]))}),readDays:async()=>({events:[]})};
async function fixture(){
 const source=createMemoryProvider({identity:{account:'source',bucket:'source-fixture'},now:()=>Date.parse('2026-08-01T00:00:00Z')});
 const store=await B.bootstrap(source,genesis,{legacy,legacyRef:'a'.repeat(40),cutoverDay:'2026-09-01'});
 return {source,store};
}
async function copy(source){
 const dest=createMemoryProvider({identity:{account:'recovery',bucket:'recovery-fixture'}});
 for(const entry of await source.list()){const bytes=await source.get(entry.key);if(entry.key===B.ROOT)await dest.compareAndSwap(entry.key,null,bytes);else await dest.putImmutable(entry.key,bytes);}
 return dest;
}
async function put(p,bytes,kind='objects'){const sha256=B.sha(bytes),key=B.PREFIX+kind+'/'+sha256;await p.putImmutable(key,bytes);return {key,sha256,size:bytes.length};}
async function plan(source,dest){return R.planRetention(source,dest,{sourceIdentity:source.identity,recoveryIdentity:dest.identity,now:Date.parse('2026-09-02T00:00:00Z')});}
(async()=>{
 // Active raw detail and immutable historical report pins stay reachable
 // even when the provider timestamps are old enough for staging cleanup.
 const pinned=await fixture(),raw=zlib.gzipSync(Buffer.from('{"hash":"'+ '1'.repeat(64)+'","ledger_index":101,"close_time":"2026-09-01T01:00:00Z","tx_type":"Payment"}\n'));
 const rawHash=B.sha(raw),path='evidence/2026/09/01/events.'+rawHash+'.ndjson.gz';
 await pinned.store.commitRun({report_id:'SW-20260901-PIN01',anchor_ledger:101,anchor_close:'2026-09-01T01:00:00.000Z',target_wallets:1,complete_wallets:1,balance_contradictions:0,
  wallets:genesis.wallets.map(w=>({...w,last_proven_ledger:101,balance_ledger:101,reconciliation:'RECONCILED'})),evidence_shards:[{path,sha256:rawHash,rows:1}],files:{[path]:raw}});
 const pinnedPlan=await plan(pinned.source,await copy(pinned.source));
 const pinnedEntry=pinnedPlan.entries.find(e=>e.key===B.PREFIX+'objects/'+rawHash);
 assert.equal(pinnedEntry.disposition,'HOLD');assert(pinnedEntry.reasons.includes('HISTORICAL_SNAPSHOT'));
 const {source,store}=await fixture();
 const staging=await put(source,Buffer.from('unreferenced abandoned staging'));
 // Even a permanent frozen manifest no longer named by any root owns its raw
 // shard forever until a separately approved archive routing policy exists.
 const bytes=zlib.gzipSync(Buffer.from('{"hash":"fixture"}\n'));
 const shard=await put(source,bytes);
 const frozen=await put(source,Buffer.from(JSON.stringify({state_version:1,state_sha256:genesis.state_sha256,shards:[{kind:'events',path:'evidence/2026/09/01/events.'+shard.sha256+'.ndjson.gz',sha256:shard.sha256,rows:1,corrections:[],object:shard}]})),'permanent');
 const recovery=await copy(source),before=await source.list();
 const result=await plan(source,recovery);
 assert.equal(result.gc_enabled,false);assert.equal(result.deletion_authorized,false);assert.equal(result.capacity_relief_applied,false);
 assert.equal(result.totals.review_candidate_count,1);assert.equal(result.totals.review_candidate_bytes,staging.size);
 assert.equal(result.entries.find(e=>e.key===staging.key).disposition,'REVIEW_CANDIDATE');
 assert(result.entries.find(e=>e.key===shard.key).reasons.includes('FROZEN_ARCHIVE_READ_ROUTE'));
 assert(result.entries.find(e=>e.key===frozen.key).reasons.includes('PERMANENT_EVIDENCE'));
 assert(result.entries.filter(e=>e.key.includes('/snapshots/')).every(e=>e.reasons.includes('HISTORICAL_SNAPSHOT')));
 assert.deepEqual(await source.list(),before,'planning must be read-only');
 // Unknown age and a new object can never become eligible.
 const unknown={...source,list:async()=> (await source.list()).map(({last_modified,...e})=>e)};
 assert.equal((await plan(unknown,recovery)).totals.review_candidate_count,0);
 const fresh={...source,list:async()=> (await source.list()).map(e=>({...e,last_modified:'2026-09-01T00:00:00.000Z'}))};
 assert.equal((await plan(fresh,recovery)).totals.review_candidate_count,0);
 // A valid old receipt is insufficient when destination bytes are now missing.
 const receipt=await Backup.verifyRestore(await Backup.capture(source),recovery,{recoveryIdentity:recovery.identity});
 assert(Backup.verifyReceipt(receipt).ok);
 await assert.rejects(plan(source,{...recovery,get:async key=>key===staging.key?null:recovery.get(key)}),/MISSING_OR_LENGTH/);
 const missingInventory={...recovery,list:async()=> (await recovery.list()).filter(e=>e.key!==staging.key)};
 await assert.rejects(plan(source,missingInventory),/RESTORE_MISMATCH/);
 // A source mutation after initial capture cannot escape as a usable plan.
 const changing=await fixture(),changingCopy=await copy(changing.source);let lists=0;
 const concurrent={...changing.source,list:async()=>{if(++lists===3)await put(changing.source,Buffer.from('concurrent staging'));return changing.source.list();}};
 await assert.rejects(plan(concurrent,changingCopy),/RETENTION_SOURCE_CHANGED/);
 // An incomplete acquisition journal holds even old backed-up staging.
 const journal=J.begin({report_id:'SW-20260901-HOLD1',from_state_version:1,from_state_sha256:genesis.state_sha256,anchor_ledger:110,anchor_close:'2026-09-01T01:00:00Z'});
 await store.appendJournal(journal,{wallets:[],rows:[]});
 assert.equal((await plan(source,await copy(source))).totals.review_candidate_count,0);
 const rootRead=await source.getVersioned(B.ROOT),root=JSON.parse(rootRead.bytes);root.pending={previous_ref:'bounded:'+B.sha(rootRead.bytes)};
 await source.compareAndSwap(B.ROOT,rootRead.etag,Buffer.from(JSON.stringify(root)));
 await assert.rejects(plan(source,recovery),/PENDING_ROOT_BLOCKED/);
 console.log('PASS bounded retention: protected snapshots/permanent frozen shards, staging-only candidates, stale recovery, journal/reservation holds; zero deletes');
})().catch(e=>{console.error(e);process.exitCode=1;});
