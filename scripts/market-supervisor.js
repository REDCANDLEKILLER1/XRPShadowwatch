#!/usr/bin/env node
'use strict';
const crypto=require('crypto'),zlib=require('zlib'),C=require('./market-collector'),M=require('./market-evidence'),R=require('./r2-master-backup');
const Auto=require('./market-auto-store'),E=require('../src/db/market-executions'),S=require('../src/db/market-coverage');
const KEY=Auto.PREFIX+'state.json',SCHEMA='shadowwatch-market-supervisor/1',CADENCE=15*60000;
const hash=h=>typeof h==='string'&&/^[A-Fa-f0-9]{64}$/.test(h);
function validate(s){
 if(s?.schema!==SCHEMA||s.sha256!==S.seal(s)||Buffer.byteLength(JSON.stringify(s))>S.MAX_BYTES||
  !Number.isSafeInteger(s.start)||s.start<2||!Number.isSafeInteger(s.next)||s.next<s.start||
  !Number.isFinite(Date.parse(s.created_at))||!Number.isFinite(Date.parse(s.updated_at))||!s.executions||!Array.isArray(s.samples)||s.samples.length>12||
  (s.next>s.start&&(!hash(s.last_hash)||s.last_receipt?.hash!==s.last_hash||s.last_receipt.index!==s.next-1||
   !hash(s.last_receipt.parent)||!Number.isSafeInteger(s.last_receipt.bytes)||s.last_receipt.bytes<=0||s.last_receipt.bytes>C.LIMITS.object||
   !/^[a-f0-9]{64}$/.test(s.last_receipt.sha256)||s.last_receipt.key!==C.PREFIX+'objects/'+s.last_receipt.sha256+'.json.gz'||s.last_close!==s.last_receipt.close_time)))throw Error('AUTO_STATE_INVALID');
 if(s.active){C.bounds(s.active.start,s.active.end);
  if(s.active.start>s.next||s.active.end<s.next-1||s.active.end-s.active.start>=16||
   (s.active.parent!==null&&!hash(s.active.parent)))throw Error('AUTO_STATE_RANGE_INVALID');}
 return s;
}
async function record(store,receipt){
 const body=await store.verify(receipt),r=JSON.parse(zlib.gunzipSync(body,{maxOutputLength:C.LIMITS.response*2}).toString());
 if(r.schema!==C.SCHEMA||r.header.hash!==receipt.hash||r.header.index!==receipt.index||r.header.parent!==receipt.parent)throw Error('AUTO_RESTORE_MISMATCH');
 const proven=C.reconcile(r.raw.expanded,r.raw.hashes,receipt.index,receipt.parent).header;
 for(const field of ['index','hash','parent','close_time'])if(proven[field]!==receipt[field]||r.header[field]!==receipt[field])throw Error('AUTO_RESTORE_MISMATCH');
 return r;
}
async function run({store,rpc=M.rpc,clock=Date.now,codeSha=process.env.GITHUB_SHA,id=()=>crypto.randomUUID()}={}){
 const begun=clock(),day=new Date(begun).toISOString().slice(0,10),loaded=await store.load(KEY);
 let s=loaded?validate(loaded.state):null,version=loaded?.version,tip=null,reason=null,calls=0,control=false;
 const previousAttempt=s?.updated_at,initialNext=s?.next;
 const read=async(method,p)=>{if(method!=='ledger'||calls>=11||clock()-begun>=120000)throw Error('AUTO_RUN_BUDGET_STOP');calls++;return rpc(method,p);};
 // Revalidate the last committed bytes even when capacity prevents collection.
 if(s?.last_receipt)await record(store,s.last_receipt);
 try{
  const latest=await read('ledger',{ledger_index:'validated',transactions:false});
  tip=C.header(latest,Number(latest.ledger_index));
  if(clock()-Date.parse(tip.close_time)>120000||Date.parse(tip.close_time)>clock()+10000||
   (s&&tip.index<s.next-1))throw Error('AUTO_TIP_STALE_OR_REGRESSED');
 }catch(e){reason=/^(AUTO|PILOT)_[A-Z_]+$/.test(e.message)?e.message:'AUTO_TIP_UNAVAILABLE';tip=null;if(!s)throw Error(reason);}
 if(!s)s={schema:SCHEMA,start:tip.index,next:tip.index,created_at:new Date(begun).toISOString(),updated_at:new Date(begun).toISOString(),
  last_hash:null,last_receipt:null,last_close:null,active:null,executions:E.empty(),samples:[]};
 const save=async()=>{s.updated_at=new Date(clock()).toISOString();s.sha256=S.seal(s);validate(s);version=await store.save(KEY,s,version);};
 try{
  await store.control(day,id());control=true;
  if(tip&&!reason&&s.next<=tip.index){
   if(!s.active)s.active={start:s.next,end:Math.min(s.next+15,tip.index),parent:s.last_hash};
   await save(); // persist the chosen range before the collector can write its checkpoint
   let result;
   try{result=await C.collect({start:s.active.start,end:s.active.end,store,rpc:read,clock,id:id(),
    ...(s.active.parent?{expectedParent:s.active.parent}:{})});await store.settle();}
   catch(e){reason=/^(AUTO|PILOT)_[A-Z_]+$/.test(e.message)?e.message:'AUTO_STORAGE_OR_COLLECTION_FAILED';}
   const range=await store.load(C.stateKey(s.active.start,s.active.end));
   if(range){
    const c=range.state;C.validateState(c,s.active.start,s.active.end);
    if(s.active.parent!==null&&c.anchor_parent!==s.active.parent)throw Error('AUTO_CHAIN_MISMATCH');
    let parent=s.last_hash;
    // Only receipts beyond the supervisor cursor are counted; crash recovery is idempotent.
    for(const receipt of c.receipts.filter(r=>r.index>=s.next)){
     if(receipt.index!==s.next||(parent&&receipt.parent!==parent))throw Error('AUTO_CHAIN_MISMATCH');
     const r=await record(store,receipt);
     const executions=r.raw.expanded.ledger.transactions.map(t=>E.classify({...t,validated:true}));
     s.executions=E.add(s.executions,E.totals(executions));
     for(const t of executions)for(const f of t.fills)s.samples.push({hash:t.hash,ledger_index:receipt.index,
      account:f.account,venue:f.venue,completion:f.completion,side:f.side,xrp:f.xrp,rlusd:f.rlusd});
     s.samples=s.samples.slice(-12);s.next++;s.last_hash=receipt.hash;s.last_close=receipt.close_time;s.last_receipt=receipt;parent=receipt.hash;
    }
    if(s.next>c.end)s.active=null;
   }
   reason=reason||(result?.stop_reason==='PILOT_RUN_BUDGET_STOP'?null:result?.stop_reason)||null;
  }
  await save();
 }catch(e){reason=/^(AUTO|PILOT)_[A-Z_]+$/.test(e.message)?e.message:'AUTO_STORAGE_OR_COLLECTION_FAILED';
  // Never publish uncommitted cursor/totals if the final state write failed.
  const durable=await store.load(KEY);if(!durable)throw Error(reason);s=validate(durable.state);
 }
 const now=clock(),usageDay=new Date(now).toISOString().slice(0,10),usage=await store.usage(usageDay);
 const summary={schema:S.SCHEMA,code_sha:codeSha,generated_at:new Date(now).toISOString(),
  state:reason?.includes('CAPACITY')?'CAPPED':reason?'GAP':tip&&s.next>tip.index?'CAUGHT_UP':'RUNNING',
  scope:'VALIDATED_LEDGERS_SINCE_ACTIVATION',read_only:true,automatic_admission:false,continuous:false,
  whole_market_complete:false,classification_complete:false,unique_market_volume:null,
  coverage:{start:s.start,next:s.next,verified_ledgers:s.next-s.start,observed_tip:tip?.index??null,
   observed_tip_close:tip?.close_time??null,last_verified_close:s.last_close,
   collection_delay_ms:Math.max(0,now-Date.parse(s.last_close||s.created_at)),
   schedule_delay_ms:previousAttempt?Math.max(0,begun-Date.parse(previousAttempt)-CADENCE):0,
   missing_ranges:tip&&s.next<=tip.index?[{from:s.next,through:tip.index,reason:reason||'BACKLOG'}]:
    reason?[{from:s.next,through:s.active?.end||s.next,reason}]:[]},
  storage:{bucket_bytes:usage.total,bucket_limit:R.LIMIT,daily_charged_bytes:usage.dayBytes,daily_limit:C.LIMITS.day,day_utc:usageDay,measured_at:new Date(now).toISOString()},
  executions:s.executions,samples:s.samples};
 summary.sha256=S.seal(summary);S.validate(summary);
 return{summary,metrics:{processed_ledgers:s.next-(initialNext??s.start),rpc_requests:calls,elapsed_ms:now-begun,control_reserved:control,reason}};
}
function lane(env){
 if(env.GITHUB_ACTIONS!=='true'||env.GITHUB_REPOSITORY!=='REDCANDLEKILLER1/XRPShadowwatch'||
  env.GITHUB_WORKFLOW!=='Automatic market evidence'||env.GITHUB_REF!=='refs/heads/main'||
  !['schedule','workflow_dispatch'].includes(env.GITHUB_EVENT_NAME)||env.SHADOWWATCH_AUTOROSTER_ENABLED!=='false'||
  env.SHADOWWATCH_MARKET_AUTOCOLLECT_ENABLED!=='true')throw Error('AUTO_OPERATOR_LANE_REQUIRED');
}
async function main(){lane(process.env);
 const result=await run({store:Auto.store(R.client())});
 const publication=await S.publish(result.summary);
 console.log(JSON.stringify({state:result.summary.state,coverage:result.summary.coverage,storage:result.summary.storage,...result.metrics,published:publication.published}));
 if(['GAP','ERROR'].includes(result.summary.state))process.exitCode=2;
}
if(require.main===module)main().catch(()=>{console.error('Automatic market collector stopped; no unverified cursor or raw evidence was published.');process.exitCode=1;});
module.exports={run,lane,validate,record,KEY,SCHEMA};
