'use strict';
const assert=require('assert/strict'),crypto=require('crypto'),zlib=require('zlib'),{Readable}=require('stream');
const C=require('./market-collector'),R=require('./r2-master-backup');
const clone=x=>JSON.parse(JSON.stringify(x));
const digest=b=>crypto.createHash('sha256').update(b).digest('hex');
const hash=i=>digest(String(i)).toUpperCase();
const now=Date.parse('2026-10-10T00:00:00Z');
function ledger(index,transactions=[]) {
 return {validated:true,ledger_hash:hash(index),ledger_index:index,
  ledger:{closed:true,ledger_hash:hash(index),ledger_index:index,parent_hash:hash(index-1),close_time:844830351+index,transactions}};
}
const tx=(i=0)=>({hash:hash(1000+i),tx_json:{Account:'rFixture',TransactionType:'AccountSet',Fee:'12'},
 meta:{TransactionIndex:i,TransactionResult:'tesSUCCESS',AffectedNodes:[]}});
function rpcFixture({fail=null,badParent=null,duplicate=false,wrongHash=false}={}) {
 let calls=0;
 const rpc=async(method,p)=>{
  calls++;assert.equal(method,'ledger');assert.equal(p.ledger_index==='validated',false);
  const i=p.ledger_index??[99,100,101,102,103,104,105].find(n=>hash(n)===p.ledger_hash);
  if(i===fail)throw Error('private response with a wallet');
  const v=ledger(i,p.transactions?[tx()]:[]);
  if(p.expand===false)v.ledger.transactions=[wrongHash?hash(2000):tx().hash];
  if(duplicate&&p.expand===true)v.ledger.transactions.push(tx());
  if(i===badParent)v.ledger.parent_hash=hash(0);
  return v;
 };
 return {rpc,get calls(){return calls;}};
}
function fakeS3({corrupt=false,total=0,failPut=false,failSave=false}={}) {
 const objects=new Map(),versions=new Map();let writes=0;
 const failure=name=>{const e=Error(name);e.name=name;return e;};
 return {objects,versions,get writes(){return writes;},async send(cmd) {
  const p=cmd.input;assert.equal(p.Bucket,R.BUCKET);
  switch(cmd.constructor.name) {
   case 'ListObjectsV2Command':return {Contents:[{Key:'existing-evidence',Size:total},...[...objects].map(([Key,b])=>({Key,Size:b.length}))]};
   case 'GetObjectCommand': {
    if(!objects.has(p.Key))throw failure('NoSuchKey');
    const b=corrupt&&p.Key.includes('/objects/')?Buffer.from('corrupt'):objects.get(p.Key);
    return {Body:Readable.from([b]),ETag:versions.get(p.Key)};
   }
   case 'PutObjectCommand': {
    if(failPut&&p.Key.includes('/objects/'))throw failure('WriteFailed');
    if(failSave&&p.Key.includes('/ranges/')&&objects.has(p.Key))throw failure('WriteFailed');
    if(p.IfNoneMatch==='*'&&objects.has(p.Key))throw failure('PreconditionFailed');
    if(p.IfMatch&&p.IfMatch!==versions.get(p.Key))throw failure('PreconditionFailed');
    assert(p.IfMatch||p.IfNoneMatch);assert.equal(p.ACL,undefined);
    const b=Buffer.from(p.Body);objects.set(p.Key,b);versions.set(p.Key,digest(b));writes++;return {};
   }
   default:throw Error('Unexpected storage operation');
  }
 }};
}
const run=(s,r,opts={})=>C.collect({start:100,end:102,store:C.r2Store(s),rpc:r.rpc,clock:()=>now,...opts});
const state=s=>JSON.parse(s.objects.get(C.stateKey(100,102)).toString());
(async()=>{
 for(const [a,b] of [[1,3],[100,99],[100,132],[NaN,102],[100.5,102]])assert.throws(()=>C.bounds(a,b),/RANGE/);
 const s=fakeS3(),r=rpcFixture(),first=await run(s,r);
 assert.equal(first.interval_complete,true);assert.equal(first.processed_ledgers,3);assert.equal(r.calls,8);
 assert.equal(state(s).next,103);assert.equal(state(s).history_complete,false);assert.equal(state(s).automatic_admission,false);
 assert.equal(first.unique_market_volume,null);
 const before=s.writes,again=await run(s,r);assert.equal(again.reused_ledgers,3);assert.equal(again.processed_ledgers,0);
 assert.equal(s.writes,before);assert.equal(r.calls,8,'completed replay makes no RPC calls or writes');
 // Completed replay includes stored-object verification time, with no new RPC/write.
 const timedStore=C.r2Store(s);let replayClock=now;
 const verify=timedStore.verify.bind(timedStore);
 timedStore.verify=async receipt=>{const body=await verify(receipt);replayClock+=1000;return body;};
 const replay=await run(s,r,{store:timedStore,clock:()=>replayClock});
 assert.equal(replay.elapsed_ms,3000);assert.equal(replay.rpc_requests,0);
 assert.equal(replay.reused_ledgers,3);assert.equal(s.writes,before);assert.equal(r.calls,8);
 // Separate full-collector regressions: only the corroborating response contradicts.
 for(const field of ['parent_hash','close_time','account_hash','transaction_hash','total_coins',
   'close_flags','close_time_resolution','parent_close_time']) {
  const bad=fakeS3(),source=rpcFixture();
  const rpc=async(method,p)=>{const v=await source.rpc(method,p);
   if(p.expand===false&&v.ledger_index===100)v.ledger[field]=field.endsWith('hash')?hash(0):123;
   return v;};
  const out=await run(bad,{rpc});
  assert.equal(out.stop_reason,'PILOT_LEDGER_HEADER_MISMATCH',field);
  assert.equal(out.interval_complete,false,field);assert.equal(out.processed_ledgers,0,field);
  assert.equal(state(bad).next,100,field);assert.equal(state(bad).receipts.length,0,field);
  assert.equal([...bad.objects.keys()].filter(k=>k.includes('/objects/')).length,0,field);
 }
 const g=fakeS3(),gap=await run(g,rpcFixture({fail:101}));assert.equal(gap.next,101);assert.equal(gap.processed_ledgers,1);
 assert.deepEqual(state(g).gap,{from:101,through:102,reason:'PILOT_LEDGER_READ_FAILED',recoverable:'UNKNOWN_RETRY_SAME_LEDGER'});
 const recovered=await run(g,rpcFixture());assert.equal(recovered.reused_ledgers,1);assert.equal(recovered.processed_ledgers,2);
 assert.equal(state(g).gap,null);assert.equal(state(g).receipts.length,3);
 for(const options of [{badParent:101},{duplicate:true},{wrongHash:true}]) {
  const bad=fakeS3(),out=await run(bad,rpcFixture(options));assert.equal(out.interval_complete,false);assert(out.remaining_ledgers>0);
 }
 await assert.rejects(()=>run(fakeS3({corrupt:true}),rpcFixture()),/HASH|SIZE/);
 const failed=fakeS3({failPut:true});await assert.rejects(()=>run(failed,rpcFixture()),/WriteFailed/);assert.equal(state(failed).next,100);
 const crash=fakeS3({failSave:true});await assert.rejects(()=>run(crash,rpcFixture()),/WriteFailed/);assert.equal(state(crash).next,100);
 assert([...crash.objects.keys()].some(k=>k.includes('/objects/')),'orphan retained for safe replay');
 const resumedCrash=fakeS3();for(const [k,b] of crash.objects)resumedCrash.objects.set(k,b);for(const [k,v] of crash.versions)resumedCrash.versions.set(k,v);
 const orphanCount=[...resumedCrash.objects.keys()].filter(k=>k.includes('/objects/')).length;
 assert.equal(orphanCount,1);await run(resumedCrash,rpcFixture());
 assert.equal([...resumedCrash.objects.keys()].filter(k=>k.includes('/objects/')).length,3);
 const overlap=fakeS3();const simultaneous=await Promise.allSettled([run(overlap,rpcFixture()),run(overlap,rpcFixture())]);
 assert.equal(simultaneous.filter(r=>r.status==='fulfilled').length,1);assert.equal(state(overlap).next,103);
 const cap=fakeS3({total:R.LIMIT-100});await assert.rejects(()=>run(cap,rpcFixture()),/CAPACITY/);assert.equal(cap.writes,0);
 const daily=fakeS3();daily.objects.set(C.PREFIX+'budgets/2026-10-10/'+C.LIMITS.day+'-abcd.json',Buffer.from('{}'));
 await assert.rejects(()=>run(daily,rpcFixture()),/CAPACITY/);assert.equal(daily.writes,0);
 const budget=fakeS3(),bounded=await run(budget,rpcFixture(),{end:105});assert.equal(bounded.processed_ledgers,4);assert.equal(bounded.next,104);assert.equal(bounded.interval_complete,false);
 const time=fakeS3();let tick=now;const timed=await run(time,rpcFixture(),{clock:()=>{const old=tick;tick+=30000;return old;}});
 assert.equal(timed.interval_complete,false);assert.equal(timed.stop_reason,'PILOT_RUN_BUDGET_STOP');
 const store=C.r2Store(s),loaded=await store.load(C.stateKey(100,102));
 await assert.rejects(()=>store.save(C.stateKey(100,102),loaded.state,'wrong-etag'),/Precondition/);
 // Restore tampering cannot silently resume.
 const corrupted=fakeS3();for(const [k,b] of s.objects)corrupted.objects.set(k,b);for(const [k,v] of s.versions)corrupted.versions.set(k,v);
 const receipt=state(corrupted).receipts[0];corrupted.objects.set(receipt.key,Buffer.from('lost'));
 await assert.rejects(()=>run(corrupted,rpcFixture()),/HASH|SIZE/);
 const invalid=ledger(100,[tx()]);invalid.validated=false;assert.throws(()=>C.reconcile(invalid,ledger(100,[tx().hash]),100,hash(99)),/UNPROVEN/);
 const mismatch=ledger(100,[tx()]);mismatch.ledger.transactions[0].meta.TransactionIndex=2;
 assert.throws(()=>C.reconcile(mismatch,ledger(100,[tx().hash]),100,hash(99)),/INDEX_GAP/);
 // Existing real transaction fixture is a TWO-TX EXCERPT, not full-ledger proof.
 // Synthetic surrounding header/indexes only exercise the classifier integration.
 const real=require('./fixtures/forensic-live-ledger-107530078.json');
 const transactions=clone(real.transactions).map((t,i)=>{
  delete t.ledger_index;delete t.ledger_hash;t.meta.TransactionIndex=i;return t;
 });
 const reconciled=C.reconcile(ledger(100,transactions),ledger(100,transactions.map(t=>t.hash)),100,hash(99));
 assert.equal(reconciled.recognized_exchange_transactions,2);assert.equal(reconciled.recognized_wallet_legs,4);
 assert.equal(reconciled.unique_market_volume,null);
 assert.deepEqual(reconciled.facts.map(f=>f.exchanges.find(e=>e.basis==='OFFERCREATE_OWNER').xrp),['359.045227','545.075376']);
 const raw=zlib.gunzipSync(s.objects.get(state(s).receipts[0].key));assert(JSON.parse(raw).raw.expanded);
 console.log('PASS contradictory immutable headers rejected without advancement; completed replay measures 3000ms with zero RPC/writes; bounded acquisition, hash/index/parent checks, private readback, CAS conflicts, restart/gap recovery, duplicate rejection, corrupt restore, storage/time limits, and real-fixture classifier integration');
})().catch(e=>{console.error(e);process.exitCode=1;});
