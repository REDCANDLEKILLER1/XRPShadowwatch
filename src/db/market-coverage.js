'use strict';
// Compact derived summaries only. Raw ledgers, object keys and credentials stay private.
const crypto=require('crypto'),A=require('./github-archive'),Store=require('./github-store'),E=require('./market-executions');
const SCHEMA='shadowwatch-market-coverage/1',PATH='forensics/market/latest.json',MAX_BYTES=24576;
const seal=s=>{const copy={...s};delete copy.sha256;return crypto.createHash('sha256').update(JSON.stringify(copy)).digest('hex');};
const int=(n,min=0)=>Number.isSafeInteger(n)&&n>=min;
function keys(value,allowed){if(!value||Object.keys(value).some(k=>!allowed.split(' ').includes(k)))throw Error('MARKET_COVERAGE_FIELDS_INVALID');}
function validate(s){
 keys(s,'schema code_sha generated_at state scope read_only automatic_admission continuous whole_market_complete classification_complete unique_market_volume coverage storage executions samples sha256');
 if(!s||s.schema!==SCHEMA||s.sha256!==seal(s)||Buffer.byteLength(JSON.stringify(s))>MAX_BYTES||
  s.read_only!==true||s.automatic_admission!==false||s.continuous!==false||s.whole_market_complete!==false||
  s.classification_complete!==false||s.unique_market_volume!==null||s.scope!=='VALIDATED_LEDGERS_SINCE_ACTIVATION'||
  !/^[a-f0-9]{40}$/.test(s.code_sha)||!Number.isFinite(Date.parse(s.generated_at))||
  !['RUNNING','CAUGHT_UP','CAPPED','GAP','ERROR'].includes(s.state))throw Error('MARKET_COVERAGE_INVALID');
 const c=s.coverage;
 keys(c,'start next verified_ledgers observed_tip observed_tip_close last_verified_close collection_delay_ms schedule_delay_ms missing_ranges');
 if(!c||!int(c.start,2)||!int(c.next,c.start)||c.verified_ledgers!==c.next-c.start||
  (c.observed_tip!==null&&!int(c.observed_tip,c.next-1))||
  (c.observed_tip===null?c.observed_tip_close!==null:!Number.isFinite(Date.parse(c.observed_tip_close)))||
  (c.last_verified_close!==null&&!Number.isFinite(Date.parse(c.last_verified_close)))||
  !int(c.collection_delay_ms)||!int(c.schedule_delay_ms)||!Array.isArray(c.missing_ranges)||c.missing_ranges.length>2)
  throw Error('MARKET_COVERAGE_RANGE_INVALID');
 for(const r of c.missing_ranges){keys(r,'from through reason');if(!int(r.from,c.next)||!int(r.through,r.from)||typeof r.reason!=='string'||!/^[A-Z_]+$/.test(r.reason))throw Error('MARKET_COVERAGE_GAP_INVALID');}
 const storage=s.storage;
 keys(storage,'bucket_bytes bucket_limit daily_charged_bytes daily_limit day_utc measured_at');
 if(!storage||!int(storage.bucket_bytes)||!int(storage.bucket_limit,1)||!int(storage.daily_charged_bytes)||
  !int(storage.daily_limit,1)||!Number.isFinite(Date.parse(storage.measured_at))||storage.day_utc!==storage.measured_at.slice(0,10))throw Error('MARKET_COVERAGE_STORAGE_INVALID');
 keys(s.executions,Object.keys(E.empty()).join(' '));
 for(const [key,defaultValue]of Object.entries(E.empty())){
  const v=s.executions?.[key];
  if(typeof defaultValue==='string'?(typeof v!=='string'||!/^\d+(?:\.\d+)?$/.test(v)||v.length>80):!int(v))throw Error('MARKET_COVERAGE_TOTAL_INVALID');
 }
 if(s.executions.execution_transactions>s.executions.transactions||s.executions.unclassified_transactions>s.executions.transactions||
  s.executions.partial_fills>s.executions.order_book_fills)throw Error('MARKET_COVERAGE_TOTAL_INVALID');
 if(!Array.isArray(s.samples)||s.samples.length>12)throw Error('MARKET_COVERAGE_SAMPLES_INVALID');
 for(const f of s.samples){keys(f,'hash ledger_index account venue completion side xrp rlusd');if(!/^[A-Fa-f0-9]{64}$/.test(f.hash)||!/^r[1-9A-HJ-NP-Za-km-z]{24,34}$/.test(f.account)||
  !int(f.ledger_index,c.start)||f.ledger_index>=c.next||!['ORDER_BOOK','AMM'].includes(f.venue)||
  !['PARTIAL','FULL','PARTIAL_REMOVED','POOL_NET_SWAP'].includes(f.completion)||
  !['BUY_XRP','SELL_XRP'].includes(f.side)||!/^\d+(?:\.\d+)?$/.test(f.xrp)||!/^\d+(?:\.\d+)?$/.test(f.rlusd))throw Error('MARKET_COVERAGE_SAMPLES_INVALID');}
 return s;
}
async function read(deps={}){
 const target=A.evidenceTarget(deps.env),gh=deps.gh||A.client(target.token,target.repo,deps.fetch||((u,o)=>fetch(u,{...o,signal:AbortSignal.timeout(5000)})));
 const ref=await gh('GET','/git/ref/heads/'+target.branch),text=await Store.readFile(gh,target.branch,PATH,ref.object.sha);
 if(text===null)return{status:'UNAVAILABLE'};
 const summary=validate(JSON.parse(text)),age=(deps.now??Date.now())-Date.parse(summary.generated_at);
 if(age< -300000)throw Error('MARKET_COVERAGE_FUTURE');
 return{status:age>45*60000?'STALE':'AVAILABLE',summary};
}
async function publish(summary,deps={}){
 validate(summary);const target=A.evidenceWriteTarget(deps.env),gh=deps.gh||A.client(target.token,target.repo,deps.fetch||fetch);
 for(let attempt=0;attempt<3;attempt++){
  const ref=await gh('GET','/git/ref/heads/'+target.branch),old=await Store.readFile(gh,target.branch,PATH,ref.object.sha);
  if(old){const previous=validate(JSON.parse(old));
   if(previous.coverage.start!==summary.coverage.start)throw Error('MARKET_COVERAGE_ORIGIN_CHANGED');
   if(previous.coverage.next>summary.coverage.next||Date.parse(previous.generated_at)>Date.parse(summary.generated_at))return{published:false,reason:'NEWER_SUMMARY_EXISTS'};
   if(previous.sha256===summary.sha256)return{published:true,unchanged:true};}
  try{return{published:true,...await A.commitFiles(gh,target.branch,ref.object.sha,{[PATH]:JSON.stringify(summary)+'\n'},'market: publish verified coverage and execution summary')};}
  catch(e){if(!e.refConflict||attempt===2)throw e;}
 }
}
module.exports={SCHEMA,PATH,MAX_BYTES,seal,validate,read,publish};
