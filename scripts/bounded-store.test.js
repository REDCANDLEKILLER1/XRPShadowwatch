'use strict';
const assert=require('assert/strict'),zlib=require('zlib');
const B=require('../src/db/bounded-store'),S=require('../src/db/evidence-state'),J=require('../src/db/run-journal');
const {createMemoryProvider}=require('../src/db/bounded-object-provider');
const start='2026-09-01T00:00:00.000Z',DAY=86400000;
const genesis=S.genesis(['rAlice','rBob'].map(address=>({address,scan_coverage_through:100,balance_drops:'1000000',balance_ledger:100})),{anchor_ledger:100,anchor_close:start});
const clone=v=>JSON.parse(JSON.stringify(v));
function data(hash,day,extra={}) {return {events:[{hash,ledger_index:110,close_time:day+'T12:00:00.000Z',tx_type:'Payment',amount_drops:'100',...extra}],participants:[{tx_hash:hash,address:'rAlice',role:'sender'},{tx_hash:hash,address:'rBob',role:'receiver'}],payloads:[{hash,raw_tx:{TransactionType:'Payment',ParentBatchID:'b'.repeat(64)},raw_meta:{TransactionResult:'tesSUCCESS'}}]};}
async function run(store,n,records={},extra={}) {
 const prior=(await store.readState()).state,anchor=100+n;
 const files={},shards=[];
 for(const [day,kinds]of Object.entries(records))for(const [kind,rows]of Object.entries(kinds)) {
  const b=zlib.gzipSync(Buffer.from(rows.map(JSON.stringify).join('\n')+'\n'));
  const path='evidence/'+day.replaceAll('-','/')+'/'+kind+'.'+B.sha(b)+'.ndjson.gz';files[path]=b;shards.push({path,sha256:B.sha(b),rows:rows.length});
 }
 return {report_id:'SW-20260901-'+String(n).padStart(5,'0'),anchor_ledger:anchor,anchor_close:new Date(Date.parse(start)+n*3600000).toISOString(),target_wallets:2,complete_wallets:2,balance_contradictions:0,
  wallets:prior.wallets.map(w=>({...w,last_proven_ledger:anchor,balance_drops:'1000000',balance_ledger:anchor,reconciliation:'RECONCILED'})),evidence_shards:shards,files,...extra};
}
const emptyLegacy={readPinnedState:async d=>({ref:d.ref,state:genesis}),resolveDayManifests:async(days,d)=>({ref:d.ref,state:d.loaded_state,byDay:Object.fromEntries(days.map(day=>[day,{shards:{}}]))}),readDays:async()=>({events:[]})};
async function fresh(options={}) {const provider=options.provider||createMemoryProvider();const store=await B.bootstrap(provider,genesis,{legacy:emptyLegacy,legacyRef:'a'.repeat(40),cutoverDay:'2026-09-01',...options});return {provider,store};}
(async()=>{
 assert.equal(B.runtime({env:{}}),null);
 const {store,provider}=await fresh(),h='1'.repeat(64),day='2026-09-01';
 const first=await run(store,13,{[day]:data(h,day)},{flagged_hashes:[{hash:h,reason:'fixture'}]});
 await store.commitRun(first);const root1=await store.inspect();
 await store.commitRun(first);assert.deepEqual(await store.inspect(),root1,'replay changes nothing');
 const second=await run(store,14,{[day]:data(h,day)});await store.commitRun(second);
 assert.equal((await store.readDaily(day)).observed_transactions,1);
 assert.equal((await store.readDaily(day)).participant_observations,2);
 assert.deepEqual((await store.readDaily(day)).wallet_role_counts,{'rAlice|sender':1,'rBob|receiver':1});
 assert.equal((await store.readFlag(h)).parent_batch_id,'b'.repeat(64));
 // Third sighting adds another role without duplicating the transaction.
 const multi=data(h,day);multi.participants.push({tx_hash:h,address:'rAlice',role:'affected'});
 await store.commitRun(await run(store,15,{[day]:multi}));assert.equal((await store.readDaily(day)).participant_observations,3);
 assert.equal((await store.readFlag(h)).participants.length,3);
 const revision=data(h,day,{amount_drops:'200'}),before=await store.inspect();
 await assert.rejects(store.commitRun(await run(store,16,{[day]:revision})),/REVISION_REQUIRES/);assert.deepEqual(await store.inspect(),before);
 const old=(await store.readDays([day])).events[0];
 const correction=await run(store,16,{[day]:revision},{corrections:{['events:'+h]:B.sha(Buffer.from(JSON.stringify(old)))}});
 await store.commitRun(correction);await store.commitRun(correction);
 assert.equal((await store.readDays([day])).events[0].amount_drops,'200');assert.equal((await store.readDaily(day)).observed_transactions,1);
 // An older run is also idempotent after other runs have committed.
 const historicalReplay=await store.commitRun(first);assert.equal((await store.readState({ref:historicalReplay.commit_sha})).state.anchor_ledger,113);assert.equal((await store.readState()).state.anchor_ledger,116);
 await assert.rejects(store.readState({ref:'bounded-state:'+genesis.state_sha256}),/REF_INVALID/);
 const baseline=await store.resolveStateAtOrBefore(Date.parse(start));assert.equal(baseline.state.state_sha256,genesis.state_sha256);assert.equal(baseline.state.wallets[0].balance_drops,'1000000');
 // Report shape and opaque Batch inners across UTC rollover. Never synthesize
 // transactions from RawTransactions; separately stored inner hashes count once.
 const batch='2'.repeat(64),inner='3'.repeat(64),d2='2026-09-02';
 const nested=data(batch,d2,{tx_type:'Batch'});nested.events.push({...nested.events[0],hash:inner,tx_type:'Payment'});nested.payloads[0].raw_tx={TransactionType:'Batch',RawTransactions:[{RawTransaction:{hash:inner}}]};nested.payloads.push({hash:inner,raw_tx:{ParentBatchID:batch},raw_meta:{}});
 await store.commitRun(await run(store,37,{[d2]:nested}));
 const batchRead=await store.readDays([d2]);assert.equal(batchRead.events.length,2);assert.equal((await store.readDays([d2],{},'payloads')).events[1].raw_tx.ParentBatchID,batch);
 const snapshot=await store.readPinnedState();
 for(const hours of [24,48,60,72]) {
  const end=Date.parse('2026-09-03T12:00:00Z'),from=end-hours*3600000;
  const days=[day,d2].filter(d=>Date.parse(d)+DAY>from&&Date.parse(d)<=end);
  const actual=(await store.readDays(days,{},'events')).events.filter(e=>Date.parse(e.close_time)>=from&&Date.parse(e.close_time)<=end);
  const expected=[{...old,amount_drops:'200'},...nested.events].filter(e=>Date.parse(e.close_time)>=from&&Date.parse(e.close_time)<=end);
  assert.deepEqual(actual,expected,hours+'h event parity');
 }
 // Many days: seven complete UTC dates plus current date, not seven rolling
 // 24h periods. The frozen manifest remains read-only and independently readable.
 for(let n=3;n<=35;n++) {
  const date=new Date(Date.parse(start)+(n-1)*DAY).toISOString().slice(0,10),hash=n.toString(16).padStart(64,'0');
  await store.commitRun(await run(store,(n-1)*24+13,{[date]:data(hash,date)}));
  const root=await store.inspect();assert(Object.keys(root.days).length<=8);assert(root.active_bytes<=root.budgets.active);
 }
 assert.equal((await store.readDays([day])).events[0].amount_drops,'200');
 assert.equal((await store.readDays([day],{ref:snapshot.ref})).events[0].amount_drops,'200');
 const oldRoot=await store.inspect();
 await assert.rejects(store.commitRun(await run(store,900,{[day]:data('f'.repeat(64),day)})),/ARCHIVE_OLDER_DAY_REVISION/);
 assert.deepEqual(await store.inspect(),oldRoot);
 // Verify all-or-nothing multi-day retrieval: a late object failure must not
 // deliver an earlier segment to report assembly.
 const brokenProvider={...provider,get:async key=>{if(key===oldRoot.frozen[d2].key)throw Error('provider unavailable');return provider.get(key);}};
 let result='NO_REPORT';await assert.rejects(B.createStore(brokenProvider).readDays([day,d2]).then(v=>{result=v;}),/unavailable/);assert.equal(result,'NO_REPORT');
 // Journal quarantines raw rows and holds older active days during another run.
 const f=await fresh();const j=J.begin({report_id:'SW-20260901-HOLD1',from_state_version:1,from_state_sha256:genesis.state_sha256,anchor_ledger:1000,anchor_close:'2026-10-01T00:00:00Z'});
 await f.store.appendJournal(j,{wallets:[],rows:[{hash:h,raw_tx:{ParentBatchID:batch}}]});
 assert.equal((await f.store.readJournalRows((await f.store.readJournal()).journal))[0].raw_tx.ParentBatchID,batch);
 await f.store.commitRun(await run(f.store,240,{'2026-09-01':data(h,day)}));assert(Object.keys((await f.store.inspect()).days).length>8,'incomplete-run retention hold');
 await f.store.clearJournal(j);await f.store.commitRun(await run(f.store,241,{}));assert(Object.keys((await f.store.inspect()).days).length<=8);
 // Capacity is checked before the first object PUT, including local uploads.
 const tiny=await fresh({budgets:{active:10}});let writes=0;
 const watched={...tiny.provider,putImmutable:async(...args)=>{writes++;return tiny.provider.putImmutable(...args);}};
 const limited=B.createStore(watched);const tooLarge=await run(limited,13,{[day]:data(h,day)});
 for(const path of Object.keys(tooLarge.files))tooLarge.files[path]=await limited.uploadBlob(tooLarge.files[path]);assert.equal(writes,0);
 await assert.rejects(limited.commitRun(tooLarge),/CAPACITY_REFUSED/);assert.equal(writes,0);assert.equal((await limited.readState()).state.state_version,1);
 // Provider/CAS failures leave the published root unchanged, with exact replay
 // able to resume from immutable staging once the provider recovers.
 const recovery=await fresh();let fail=true;
 const flaky={...recovery.provider,compareAndSwap:async(...a)=>{if(fail)throw Error('CAS unavailable');return recovery.provider.compareAndSwap(...a);}};
 const retry=B.createStore(flaky);const operation=await run(retry,13,{[day]:data(h,day)});
 await assert.rejects(retry.commitRun(operation),/CAS unavailable/);assert.equal((await retry.readState()).state.state_version,1);
 fail=false;await retry.commitRun(operation);assert.equal((await retry.readState()).state.state_version,2);
 await assert.rejects(B.createStore({...provider,getVersioned:async()=>{throw Error('provider denied');}}).readState(),/provider denied/);
 await assert.rejects(B.bootstrap(createMemoryProvider(),genesis,{legacyRef:'a'.repeat(40),cutoverDay:'2026-09-02'}),/CUTOVER_DAY_INVALID/);

 // An anchor ledger at exactly midnight may contain real events. Import it
 // from the independently pinned legacy state; acquisition starts at +1.
 const midnight=data('a'.repeat(64),day);midnight.events[0].close_time=start;
 const imported=await fresh({legacy:{...emptyLegacy,readDays:async(_days,_d,kind)=>({events:midnight[kind]})}});
 assert.equal((await imported.store.readDays([day])).events[0].close_time,start);
 assert.equal((await imported.store.readDaily(day)).observed_transactions,1);
 await assert.rejects(fresh({legacy:{...emptyLegacy,readPinnedState:async d=>({ref:d.ref,state:S.seal({...genesis,anchor_ledger:99})})}}),/STATE_NOT_AT_PIN/);
 const dup=await fresh(),divergent=data(h,day);divergent.events.push({...divergent.events[0],amount_drops:'999'});
 await assert.rejects(dup.store.commitRun(await run(dup.store,13,{[day]:divergent})),/DIVERGENT_BATCH_DUPLICATE/);
 const badPath=await run(dup.store,14,{[day]:data(h,day)});const sh=badPath.evidence_shards[0],oldPath=sh.path;
 sh.path=oldPath.replace(sh.sha256,'0'.repeat(64));badPath.files[sh.path]=badPath.files[oldPath];delete badPath.files[oldPath];
 await assert.rejects(dup.store.commitRun(badPath),/CONTENT_PATH_REQUIRED/);
 assert.equal((await store.readFlag(h)).reason,'fixture');
 await assert.rejects(store.commitRun(await run(store,901,{}, {flagged_hashes:['d'.repeat(64)]})),/FLAG_NOT_IN_CHANGED_DAY/);
 // Fail publication AFTER durable reservation. A new process recovers the same
 // operation; unrelated attempts cannot spend additional unaccounted bytes.
 const reserved=await fresh();let calls=0,putCalls=0,breakFinal=true;
 const faulted={...reserved.provider,putImmutable:async(...a)=>{putCalls++;return reserved.provider.putImmutable(...a);},compareAndSwap:async(...a)=>{calls++;if(breakFinal&&calls===2)throw Error('final CAS failed');return reserved.provider.compareAndSwap(...a);}};
 const writer=B.createStore(faulted),beforePin=await writer.readPinnedState();
 const wanted=await run(writer,13,{[day]:data(h,day)});
 await assert.rejects(writer.commitRun(wanted),/final CAS failed/);
 const held=await writer.inspect();assert(held.pending);assert(held.allocated_bytes>0);
 assert.equal((await writer.readPinnedState()).ref,beforePin.ref);assert.equal((await writer.readState()).state.state_version,1);
 const putCount=putCalls;
 for(let n=14;n<24;n++)await assert.rejects(writer.commitRun(await run(writer,n,{[day]:data(String(n).padStart(64,'0'),day)})),/PENDING_WRITE_REQUIRES_RECOVERY/);
 assert.equal(putCalls,putCount);
 breakFinal=false;await B.createStore(faulted).commitRun(wanted);assert.equal((await writer.readState()).state.state_version,2);
 // Lost success responses: reservation is recoverable, publication is detected
 // by idempotent run identity without a second checkpoint or duplicate charge.
 for(const lostAt of [1,2]) {
  const setup=await fresh();let count=0;
  const loss={...setup.provider,compareAndSwap:async(...a)=>{const etag=await setup.provider.compareAndSwap(...a);if(++count===lostAt)throw Error('response lost');return etag;}};
  const w=B.createStore(loss),operation=await run(w,13,{[day]:data(h,day)});
  await assert.rejects(w.commitRun(operation),/response lost/);
  await B.createStore(loss).commitRun(operation);assert.equal((await w.readState()).state.state_version,2);
 }
 const pinnedRead=await store.readPinnedState();
 assert.equal(await pinnedRead.gh('GET','/contents/evidence/backup/latest.json'),null,'legacy backup never qualifies new backend');
 assert.throws(()=>B.runtime({env:{SHADOWWATCH_BOUNDED_STORAGE_MODE:'r2',VERCEL_ENV:'production',SHADOWWATCH_BOUNDED_CAS_VERIFIED:'true'}}),/PRODUCTION_CUTOVER_NOT_QUALIFIED/);
 console.log('PASS bounded-store: immutable batches, idempotent replay/corrections, multiwallet roles, flags and ParentBatchID, no inner expansion, baselines, 24/48/60/72h row parity, 35-day bound, incomplete hold, atomic late failure, capacity preflight, failure/recovery, pinned snapshots, older-day refusal; no production I/O');
})().catch(e=>{console.error(e);process.exitCode=1;});
