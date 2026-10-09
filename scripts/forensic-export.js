#!/usr/bin/env node
'use strict';
// Operator-only: consume a verified, independently restored master snapshot.
const fs=require('fs'),path=require('path'),zlib=require('zlib'),readline=require('readline');
const B=require('../src/db/master-backup'),F=require('../src/db/forensic-patterns'),Store=require('../src/db/github-store');
const MAX_DAY_EVENTS=250000,MAX_LINE_BYTES=4*1024*1024;
function retention(manifest,{now,keepDays=30,flaggedDays=[]}={}){
 const ms=Date.parse(now);if(!Number.isFinite(ms)||!Number.isInteger(keepDays)||keepDays<30)throw Error('RETENTION_WINDOW_INVALID');
 const cutoff=new Date(ms-keepDays*86400000).toISOString().slice(0,10),flagged=new Set(flaggedDays);
 const files=manifest.files.map(e=>{const m=e.path.match(/^evidence\/(\d{4})\/(\d{2})\/(\d{2})\//),day=m?m.slice(1).join('-'):null;
  return{path:e.path,bytes:e.bytes,sha256:e.sha256,day,action:!day?'KEEP_PROOF':day>=cutoff?'KEEP_RECENT':flagged.has(day)?'KEEP_FLAGGED':'ARCHIVE_CANDIDATE'};});
 return{schema:'shadowwatch-retention-preview/1',mode:'DRY_RUN',deletion_enabled:false,keep_days:keepDays,cutoff_utc:cutoff,
  current_file_bytes:manifest.total_bytes,review_threshold_bytes:5000000000,threshold_reached:manifest.total_bytes>=5000000000,
  git_history_bytes:'NOT_MEASURED',archive_candidate_bytes:files.filter(e=>e.action==='ARCHIVE_CANDIDATE').reduce((n,e)=>n+e.bytes,0),
  source_commit:manifest.source_commit,source_manifest_sha256:manifest.manifest_sha256,files,
  removal_blockers:['SOURCE_READERS_STILL_REQUIRE_GITHUB_SHARDS','CHECKPOINT_REFERENCES_MUST_REMAIN_RESOLVABLE','NO_DELETE_IMPLEMENTATION'],
  note:'Candidates are not deletions. Git file removal does not shrink existing history. Preserve every original in verified private R2; summaries are not substitutes.'};
}
async function* rows(file){
 const input=fs.createReadStream(file).pipe(zlib.createGunzip());
 const lines=readline.createInterface({input,crlfDelay:Infinity});
 try{for await(const line of lines){if(Buffer.byteLength(line)>MAX_LINE_BYTES)throw Error('FORENSIC_ROW_TOO_LARGE');if(line)yield JSON.parse(line);}}
 finally{lines.close();input.destroy();}
}
function write(root,name,data,gzip=false){B.relative(name);const p=path.join(root,name);fs.mkdirSync(path.dirname(p),{recursive:true});
 fs.writeFileSync(p,gzip?zlib.gzipSync(data):data,{flag:'wx'});}
const json=v=>JSON.stringify(v,null,2)+'\n';
const ndjson=values=>values.map(v=>JSON.stringify(v)).join('\n')+(values.length?'\n':'');
function csv(rows){return rows.map(row=>row.map(v=>'"'+String(v??'').replace(/"/g,'""')+'"').join(',')).join('\n')+'\n';}
function dayShards(source,state){
 // A day's old plain shard can survive the switch to numbered shards. The
 // newest checkpoint that wrote that day selects its authoritative file set.
 const days=new Map();let current=state;
 while(current){const grouped=new Map();
  for(const e of current.evidence_shards||[]){const m=e.path.match(/^evidence\/(\d{4})\/(\d{2})\/(\d{2})\//);if(!m)continue;
   const day=m.slice(1).join('-');if(!grouped.has(day))grouped.set(day,[]);grouped.get(day).push(e.path);}
  for(const [day,paths]of grouped)if(!days.has(day)){
   const files={events:[],payloads:[],checkpoint_state_version:current.state_version};
   for(const file of paths){const m=file.match(/\/(events|payloads)(?:\.\d+)?\.ndjson\.gz$/);if(m)files[m[1]].push(file);}
   if(!files.events.length)throw Error('FORENSIC_DAY_EVENTS_UNMANIFESTED');days.set(day,files);
  }
  if(current.state_version<=1)break;
  current=JSON.parse(fs.readFileSync(path.join(source,Store.historyPath(current.state_version-1))));
 }
 return days;
}
async function exportForensics(source,destination,{now}={}){
 const verified=B.verify(source),manifest=JSON.parse(fs.readFileSync(path.join(source,'manifest.json')));
 const state=JSON.parse(fs.readFileSync(path.join(source,Store.STATE_PATH)));
 now=now||state.anchor_close;const cutoff=retention(manifest,{now}).cutoff_utc;
 fs.mkdirSync(destination,{recursive:false});
 const days=dayShards(source,state),walletDays=new Map(),flaggedDays=[],stats=[],walletRows=[['day_utc','wallet','direct_xrp_received','direct_xrp_sent','offer_create_count','confirmed_cancel_count','exchange_legs','flag_count']],
  csvRows=[['day_utc','wallet','currency','issuer','bought_xrp','sold_xrp','stable_spent','stable_received','wallet_legs']];
 const selected=new Set([...days.values()].flatMap(d=>d.events.concat(d.payloads)));
 const excluded=manifest.files.filter(e=>/^evidence\/\d{4}\/\d{2}\/\d{2}\/(events|payloads)(?:\.\d+)?\.ndjson\.gz$/.test(e.path)&&!selected.has(e.path)).map(e=>e.path);
 if(!days.size)throw Error('FORENSIC_NO_DAILY_SHARDS');
 for(const [day,files] of [...days].sort((a,b)=>a[0].localeCompare(b[0]))){
  const events=new Map(),processed=new Set(),records=[];
  for(const file of files.events.sort())for await(const e of rows(path.join(source,file))){
   if(!/^[A-Fa-f0-9]{64}$/.test(e.hash)||!Number.isSafeInteger(e.ledger_index)||!e.close_time?.startsWith(day))throw Error('FORENSIC_EVENT_INVALID');
   if(events.has(e.hash)){if(JSON.stringify(events.get(e.hash))!==JSON.stringify(e))throw Error('FORENSIC_CONFLICTING_EVENT');continue;}
   if(events.size>=MAX_DAY_EVENTS)throw Error('FORENSIC_DAY_LIMIT_EXCEEDED');events.set(e.hash,e);
  }
  for(const file of files.payloads.sort())for await(const p of rows(path.join(source,file))){
   if(!events.has(p.hash))throw Error('FORENSIC_ORPHAN_PAYLOAD');if(processed.has(p.hash))throw Error('FORENSIC_DUPLICATE_PAYLOAD');
   processed.add(p.hash);records.push(F.inspect(events.get(p.hash),p));
  }
  for(const e of events.values())if(!processed.has(e.hash))records.push(F.inspect(e,null));
  records.sort((a,b)=>a.ledger_index-b.ledger_index||(a.transaction_index??Infinity)-(b.transaction_index??Infinity)||a.hash.localeCompare(b.hash));
  const result=F.summarize(records),flagged=new Set(result.flags.flatMap(f=>f.hashes));
  if(flagged.size)flaggedDays.push(day);
  const summary={day,events:events.size,payloads:processed.size,statuses:result.statuses,flags:result.flags.length,wallets:result.wallets.length,
   source_shards:files,scope:'Observed transactions in this pinned source; no assertion of global market or wallet lifetime completeness.'};stats.push(summary);
  write(destination,'days/'+day+'/summary.json',json(summary));
  write(destination,'days/'+day+'/flags.json',json({flags:result.flags,rules:result.rules,interpretation:result.interpretation}));
  if(day>=cutoff)write(destination,'days/'+day+'/facts.ndjson.gz',ndjson(records),true);
  if(flagged.size){
   write(destination,'days/'+day+'/flagged-facts.ndjson.gz',ndjson(records.filter(r=>flagged.has(r.hash))),true);
   const raw=[];for(const file of files.payloads)for await(const p of rows(path.join(source,file)))if(flagged.has(p.hash))raw.push(p);
   if(raw.length!==flagged.size)throw Error('FORENSIC_FLAG_PAYLOAD_MISSING');
   write(destination,'days/'+day+'/flagged-payloads.ndjson.gz',ndjson(raw),true);
  }
  for(const w of result.wallets){
   if(!/^r[1-9A-HJ-NP-Za-km-z]{24,34}$/.test(w.account))throw Error('FORENSIC_WALLET_PATH_INVALID');
   if(!walletDays.has(w.account))walletDays.set(w.account,[]);walletDays.get(w.account).push(day);
   const coverage=state.wallets.find(a=>a.address===w.account)||null;
   // Historical totals persist; recent/flagged transaction references persist too.
   const detail=day>=cutoff?w:{...w,orders:w.orders.filter(o=>flagged.has(o.hash)),exchanges:w.exchanges.filter(t=>flagged.has(t.hash))};
   write(destination,'wallets/'+w.account+'/'+day+'.json',json({...detail,day,coverage,
    flags:result.flags.filter(f=>f.account===w.account||f.to===w.account),source_commit:verified.source_commit}));
   walletRows.push([day,w.account,w.xrp_received,w.xrp_sent,w.orders.filter(o=>o.kind==='OfferCreate').length,
    w.orders.filter(o=>o.cancel_confirmed).length,w.exchanges.length,result.flags.filter(f=>f.account===w.account||f.to===w.account).length]);
   for(const [asset,t] of Object.entries(w.stable_totals)){const [currency,issuer]=asset.split(':');csvRows.push([day,w.account,currency,issuer,t.buy_xrp,t.sell_xrp,t.stable_spent,t.stable_received,t.legs]);}
  }
 }
 for(const w of state.wallets)if(!walletDays.has(w.address))walletDays.set(w.address,[]);
 for(const [account,observedDays] of walletDays){
  if(!/^r[1-9A-HJ-NP-Za-km-z]{24,34}$/.test(account))throw Error('FORENSIC_WALLET_PATH_INVALID');
  write(destination,'wallets/'+account+'/index.json',json({account,observed_days:observedDays,
   latest_checkpoint:state.wallets.find(w=>w.address===account)||null,source_commit:verified.source_commit,
   lifetime_history_complete:false,note:'An empty day list means no classified activity in this export, not proof of no activity.'}));
 }
 write(destination,'daily-wallet-totals.csv',csv(walletRows));
 write(destination,'daily-exchange-totals.csv',csv(csvRows));
 write(destination,'retention-preview.json',json(retention(manifest,{now,flaggedDays})));
 const result={schema:F.SCHEMA,generated_at:new Date().toISOString(),source:verified,analysis_as_of:now,assets:F.ASSETS,days:stats,
  excluded_unselected_shards:excluded,
  causal_price_analysis:'NOT_EVALUATED: market/history.json, when present, contains descriptive comparisons only; a price pattern does not identify its cause.',
  limits:{max_events_per_day:MAX_DAY_EVENTS,raw_details_days:30,stablecoin_scope:'Only the exact listed currency/issuer pairs; all other assets remain unclassified.',
   ownership_attribution:false,manipulation_attribution:false,source_deletion:false}};
 write(destination,'index.json',json(result));return result;
}
if(require.main===module){const [source,destination]=process.argv.slice(2);if(!source||!destination)throw Error('Usage: node scripts/forensic-export.js VERIFIED_BACKUP NEW_OUTPUT_DIRECTORY');
 exportForensics(source,destination).then(r=>console.log(JSON.stringify({source_commit:r.source.source_commit,days:r.days.length}))).catch(e=>{console.error(e.message);process.exitCode=1;});}
module.exports={exportForensics,retention,csv,rows,dayShards};
