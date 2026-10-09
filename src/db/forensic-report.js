'use strict';
const crypto=require('crypto'),F=require('./forensic-patterns'),A=require('./github-archive'),Store=require('./github-store');
const PATH='forensics/report/latest.json',SCHEMA='shadowwatch-forensic-report/1';
const seal=s=>{const copy={...s};delete copy.sha256;return crypto.createHash('sha256').update(JSON.stringify(copy)).digest('hex');};
function build(records,verified,now=new Date().toISOString()){
 if(!verified?.verified||!verified.restore_verified)throw Error('FORENSIC_REPORT_RESTORE_REQUIRED');
 const end=Date.parse(verified.anchor_close),start=end-86400000;
 if(!Number.isFinite(end))throw Error('FORENSIC_REPORT_WINDOW_INVALID');
 const selected=records.filter(r=>Date.parse(r.close_time)>start&&Date.parse(r.close_time)<=end),seen=new Set();
 for(const r of selected){if(seen.has(r.hash))throw Error('FORENSIC_REPORT_DUPLICATE');seen.add(r.hash);}
 const result=F.summarize(selected),sells=[],buys=[],transactions=new Set(),exchangeWallets=new Set();
 for(const r of selected)for(const t of r.exchanges){
  (t.side==='SELL_XRP'?sells:buys).push(t.xrp);transactions.add(r.hash);exchangeWallets.add(t.account);
 }
 const walletsFor=kind=>new Set(result.flags.filter(f=>f.kind===kind).map(f=>f.account)).size;
 const summary={schema:SCHEMA,generated_at:now,window_start:new Date(start).toISOString(),window_end:new Date(end).toISOString(),
  source_commit:verified.source_commit,source_manifest_sha256:verified.manifest_sha256,
  observed_records:selected.length,classified_records:result.statuses.ANALYZED||0,
  unclassified_records:selected.filter(r=>!['ANALYZED','NOT_SUCCESSFUL_VALIDATED'].includes(r.status)).length,
  excluded_unsuccessful_records:result.statuses.NOT_SUCCESSFUL_VALIDATED||0,
  exchange_transactions:transactions.size,exchange_wallets:exchangeWallets.size,
  xrp_sold_for_rlusd:sells.reduce((a,b)=>F.add(a,b),'0'),xrp_bought_with_rlusd:buys.reduce((a,b)=>F.add(a,b),'0'),
  repeated_quote_wallets:walletsFor('REPEATED_LIMIT_PRICE'),repeated_cancel_wallets:walletsFor('REPEATED_CONFIRMED_CANCEL'),
  regular_transfer_wallets:walletsFor('REGULAR_TRANSFER_INTERVAL'),scope:'OBSERVED_WALLETS_AND_COUNTERPARTIES',
  whole_market_complete:false,price_control_proven:false,ownership_proven:false,
  pattern_details:result.flags.slice().sort((a,b)=>b.count-a.count||a.account.localeCompare(b.account)||a.kind.localeCompare(b.kind)).slice(0,24).map(f=>({
   kind:f.kind,account:f.account,count:f.count,hashes:f.hashes.slice(0,3),
   ...(f.to?{to:f.to,interval_seconds:f.interval_seconds}:{}),
   ...(f.price_key?{price_key:f.price_key}:{})})),
  pattern_details_total:result.flags.length};
 summary.sha256=seal(summary);validate(summary);return summary;
}
function validate(s){
 if(!s||s.schema!==SCHEMA||s.sha256!==seal(s)||Buffer.byteLength(JSON.stringify(s))>16384||
  !/^[a-f0-9]{40}$/.test(s.source_commit)||!/^[a-f0-9]{64}$/.test(s.source_manifest_sha256)||
  s.scope!=='OBSERVED_WALLETS_AND_COUNTERPARTIES'||s.whole_market_complete!==false||s.price_control_proven!==false||s.ownership_proven!==false)throw Error('FORENSIC_REPORT_INVALID');
 if(!Number.isFinite(Date.parse(s.generated_at))||Date.parse(s.window_end)-Date.parse(s.window_start)!==86400000)throw Error('FORENSIC_REPORT_WINDOW_INVALID');
 for(const key of ['observed_records','classified_records','unclassified_records','excluded_unsuccessful_records','exchange_transactions','exchange_wallets','repeated_quote_wallets','repeated_cancel_wallets','regular_transfer_wallets']){
  if(!Number.isSafeInteger(s[key])||s[key]<0||s[key]>1000000)throw Error('FORENSIC_REPORT_COUNTS_INVALID');}
 if(s.classified_records+s.unclassified_records+s.excluded_unsuccessful_records!==s.observed_records||s.exchange_transactions>s.classified_records)throw Error('FORENSIC_REPORT_COUNTS_INVALID');
 for(const key of ['xrp_sold_for_rlusd','xrp_bought_with_rlusd'])if(typeof s[key]!=='string'||!/^\d+(?:\.\d{1,6})?$/.test(s[key])||s[key].length>40)throw Error('FORENSIC_REPORT_AMOUNT_INVALID');
 if(s.pattern_details!==undefined){
  if(!Array.isArray(s.pattern_details)||s.pattern_details.length>24||!Number.isSafeInteger(s.pattern_details_total)||s.pattern_details_total<s.pattern_details.length)throw Error('FORENSIC_REPORT_DETAILS_INVALID');
  const address=/^r[1-9A-HJ-NP-Za-km-z]{24,34}$/;
  for(const d of s.pattern_details){
   if(!['REPEATED_LIMIT_PRICE','REPEATED_CONFIRMED_CANCEL','REGULAR_TRANSFER_INTERVAL'].includes(d.kind)||!address.test(d.account)||
    !Number.isSafeInteger(d.count)||d.count<3||!Array.isArray(d.hashes)||!d.hashes.length||d.hashes.length>3||d.hashes.some(h=>!/^[a-fA-F0-9]{64}$/.test(h))||
    (d.kind==='REGULAR_TRANSFER_INTERVAL'&&(!address.test(d.to)||!Number.isFinite(d.interval_seconds)||d.interval_seconds<10))||
    (d.price_key!==undefined&&(typeof d.price_key!=='string'||d.price_key.length>200)))throw Error('FORENSIC_REPORT_DETAILS_INVALID');
  }
 }
 return s;
}
async function read(deps={}){
 const target=A.evidenceTarget(deps.env),fetcher=deps.fetch||((url,opts)=>fetch(url,{...opts,signal:AbortSignal.timeout(5000)})),gh=deps.gh||A.client(target.token,target.repo,fetcher);
 const ref=await gh('GET','/git/ref/heads/'+target.branch);
 const text=await Store.readFile(gh,target.branch,PATH,ref.object.sha);if(text===null)return{status:'UNAVAILABLE'};
 const summary=validate(JSON.parse(text)),now=deps.now??Date.now(),age=now-Date.parse(summary.window_end);
 if(age<0||Date.parse(summary.generated_at)>now+300000)throw Error('FORENSIC_REPORT_FUTURE');
 return{status:age>36*3600000?'STALE':'AVAILABLE',summary};
}
async function publish(summary,deps={}){
 validate(summary);const target=A.evidenceWriteTarget(deps.env),gh=deps.gh||A.client(target.token,target.repo,deps.fetch||fetch);
 for(let attempt=0;attempt<3;attempt++){
  const ref=await gh('GET','/git/ref/heads/'+target.branch),old=await Store.readFile(gh,target.branch,PATH,ref.object.sha);
  if(old){const previous=validate(JSON.parse(old));if(Date.parse(previous.window_end)>Date.parse(summary.window_end))return{published:false,reason:'NEWER_SUMMARY_EXISTS'};
   if(previous.sha256===summary.sha256)return{published:true,unchanged:true};}
  try{return{published:true,...await A.commitFiles(gh,target.branch,ref.object.sha,{[PATH]:JSON.stringify(summary,null,2)+'\n',
   ['forensics/report/history/'+summary.sha256+'.json']:JSON.stringify(summary,null,2)+'\n'},'forensics: publish verified report summary')};}
  catch(e){if(!e.refConflict||attempt===2)throw e;}
 }
}
module.exports={SCHEMA,PATH,build,validate,seal,read,publish};
