'use strict';

const zlib = require('zlib');
const crypto = require('crypto');

const OWNER='REDCANDLEKILLER1';
const REPO='XRPShadowwatch';
const DATA_BRANCH='hub/genesis-lineage-data';
const DATA_ROOT='data/genesis-lineage';
const MANIFEST_PATH=DATA_ROOT+'/manifest.json';
const GITHUB_API='https://api.github.com';
const BASE_TIP=106504852;
const EXPECTED_EFFECTS=199661;
const WORKERS=8;
const MAX_PAGES=600;
const PART_CHARS=700000;
const XRPL_ENDPOINTS=['https://s1.ripple.com:51234/','https://s2.ripple.com:51234/','https://xrplcluster.com/'];
const RANGES=[
  [32570,165989],[165990,437980],[437981,1179152],[1179153,4181979],
  [4181980,10852617],[10852618,18006990],[18006991,26648973],[26648974,35470455],
  [35470456,44091943],[44091944,52431069],[52431070,60596731],[60596732,68710262],
  [68710263,76811783],[76811784,84974491],[84974492,93153308],[93153309,101257402],
  [101257403,106477809],[106477810,-1]
];
const EXPECTED_GAPS={
  'rnziParaNb8nsU4aruQdwYE3j5jUcqjzFm|4181980|10852617':{txCount:30974,effectCount:4564,flowCount:23},
  'r9hEDb4xBGRfBCcX3E4FirDWQBAYtpxC8K|4181980|10852617':{txCount:77407,effectCount:27039,flowCount:30}
};

function token(){const t=process.env.GITHUB_TOKEN;if(!t)throw new Error('GITHUB_TOKEN is required');return t}
function ghHeaders(extra){return Object.assign({Accept:'application/vnd.github+json',Authorization:'Bearer '+token(),'X-GitHub-Api-Version':'2022-11-28','User-Agent':'ShadowWatch-Genesis-Exact-Base/1.0'},extra||{})}
async function gh(path,options){
  options=options||{};
  const r=await fetch(GITHUB_API+path,{method:options.method||'GET',headers:ghHeaders(options.headers),body:options.body==null?undefined:JSON.stringify(options.body)});
  if(!r.ok){let detail='';try{detail=(await r.text()).slice(0,900)}catch(_){};throw new Error('GitHub '+r.status+' '+r.statusText+(detail?': '+detail:''))}
  if(r.status===204)return null;return r.json();
}
async function ghRaw(path){
  const r=await fetch(`${GITHUB_API}/repos/${OWNER}/${REPO}/contents/${path}?ref=${encodeURIComponent(DATA_BRANCH)}`,{headers:ghHeaders({Accept:'application/vnd.github.raw'})});
  if(!r.ok)throw new Error('GitHub raw '+r.status+' for '+path);return r;
}
async function readManifest(){const m=await (await ghRaw(MANIFEST_PATH)).json();if(m?.schema!=='shadowwatch.genesis-lineage-hub.v1')throw new Error('manifest schema mismatch');return m}
function sha(buf){return crypto.createHash('sha256').update(buf).digest('hex')}

function isDrops(v){return typeof v==='string'&&/^\d+$/.test(v)}
function bi(v){try{return BigInt(v||'0')}catch(_){return 0n}}
function txObj(item){return item&&(item.tx||item.tx_json||item.transaction||item)||{}}
function txMeta(item){return item&&(item.meta||item.metaData||item.metadata)||{}}
function successful(item){const m=txMeta(item),r=m.TransactionResult||m.transaction_result||(item&&item.engine_result);return !r||r==='tesSUCCESS'}
function accountBalanceDeltaDrops(meta,address){
  let delta=0n,found=false;
  for(const wrap of (meta&&meta.AffectedNodes||[])){
    const n=wrap.ModifiedNode||wrap.CreatedNode||wrap.DeletedNode;
    if(!n||n.LedgerEntryType!=='AccountRoot')continue;
    const f=n.FinalFields||{},p=n.PreviousFields||{},nw=n.NewFields||{},acct=f.Account||nw.Account;
    if(acct!==address)continue;
    if(wrap.ModifiedNode&&isDrops(f.Balance)&&isDrops(p.Balance)){delta+=bi(f.Balance)-bi(p.Balance);found=true}
    else if(wrap.CreatedNode&&isDrops(nw.Balance)){delta+=bi(nw.Balance);found=true}
    else if(wrap.DeletedNode&&isDrops(f.Balance)){delta-=bi(f.Balance);found=true}
  }
  return found?delta:null;
}
function rippleYear(sec){if(sec==null||!Number.isFinite(Number(sec)))return null;return new Date((Number(sec)+946684800)*1000).getUTCFullYear()}
function normalizeEffect(address,item){
  if(!successful(item))return null;
  const tx=txObj(item),meta=txMeta(item),delta=accountBalanceDeltaDrops(meta,address);
  if(delta===null||delta===0n)return null;
  const fee=tx.Account===address&&isDrops(tx.Fee)?bi(tx.Fee):0n;let out=delta<0n?(-delta-fee):0n;if(out<0n)out=0n;
  return {address,hash:tx.hash||item.hash||'',ledger:Number(item.ledger_index||tx.ledger_index||0),date:tx.date==null?null:Number(tx.date),year:rippleYear(tx.date),type:tx.TransactionType||'UNKNOWN',txAccount:tx.Account||null,destination:tx.Destination||null,balanceDeltaDrops:delta.toString(),feeDrops:fee.toString(),outflowDrops:out.toString(),inflowDrops:(delta>0n?delta:0n).toString()};
}
function nativeDeliveredDrops(tx,item){const m=txMeta(item),d=m.delivered_amount!=null?m.delivered_amount:m.DeliveredAmount;if(isDrops(d))return d;if(isDrops(tx.Amount))return tx.Amount;return null}
function directFlow(source,item){
  if(!successful(item))return null;
  const tx=txObj(item),meta=txMeta(item),type=tx.TransactionType||'';if(tx.Account!==source)return null;
  let dest=null,drops=null,classification=null;
  if(type==='Payment'){dest=tx.Destination;drops=nativeDeliveredDrops(tx,item);if(!drops)return null;classification='NATIVE_PAYMENT'}
  else if(type==='EscrowCreate'){dest=tx.Destination;if(!isDrops(tx.Amount))return null;drops=tx.Amount;classification='ESCROW_LOCK'}
  else if(type==='PaymentChannelCreate'){dest=tx.Destination;if(!isDrops(tx.Amount))return null;drops=tx.Amount;classification='PAYCHAN_LOCK'}
  else if(type==='AccountDelete'){dest=tx.Destination;const d=dest?accountBalanceDeltaDrops(meta,dest):null;if(d===null||d<=0n)return null;drops=d.toString();classification='ACCOUNT_DELETE_TRANSFER'}
  else return null;
  if(!dest||dest===source||bi(drops)<=0n)return null;
  return {source,dest,type,classification,drops,ledger:Number(item.ledger_index||tx.ledger_index||0),hash:tx.hash||item.hash||'',date:tx.date==null?null:Number(tx.date),year:rippleYear(tx.date)};
}

async function xrplAt(url,method,params,timeout=30000){
  const c=new AbortController(),t=setTimeout(()=>c.abort(),timeout);
  try{
    const r=await fetch(url,{method:'POST',headers:{'content-type':'application/json','user-agent':'ShadowWatch-Genesis-Exact-Base/1.0'},body:JSON.stringify({method,params:[params||{}]}),signal:c.signal});
    if(!r.ok)throw new Error('XRPL HTTP '+r.status+' '+url);
    const j=await r.json(),x=j&&j.result;if(!x||x.status==='error'||x.error)throw new Error('XRPL '+((x&&(x.error_message||x.error))||'invalid response'));return x;
  }finally{clearTimeout(t)}
}
async function scanOnServer(address,requestedFrom,requestedTo,resolvedTo,url){
  let marker=null,pages=0,txCount=0;const effects=[],flows=[],seen=new Set();
  do{
    if(++pages>MAX_PAGES)throw new Error(`page cap exceeded ${address} ${requestedFrom}-${requestedTo}`);
    const q={account:address,ledger_index_min:requestedFrom,ledger_index_max:resolvedTo,binary:false,forward:true,limit:400};if(marker)q.marker=marker;
    let r,last;
    for(let a=0;a<4;a++){try{r=await xrplAt(url,'account_tx',q);break}catch(e){last=e;await new Promise(x=>setTimeout(x,250*(a+1)))}}
    if(!r)throw last;
    for(const item of (r.transactions||[])){txCount++;const e=normalizeEffect(address,item);if(e)effects.push(e);const f=directFlow(address,item);if(f)flows.push(f)}
    marker=r.marker||null;if(marker){const k=JSON.stringify(marker);if(seen.has(k))throw new Error('marker cycle');seen.add(k)}
  }while(marker);
  effects.sort((a,b)=>a.ledger-b.ledger||a.hash.localeCompare(b.hash));flows.sort((a,b)=>a.ledger-b.ledger||a.hash.localeCompare(b.hash));
  return {server:url,pages,txCount,effects,flows};
}
async function scanPinned(job){
  let last;
  for(const url of XRPL_ENDPOINTS){
    try{
      const resolvedTo=job.to===-1?BASE_TIP:job.to;
      const r=await scanOnServer(job.address,job.from,job.to,resolvedTo,url);
      const value={schema:'shadowwatch.genesis-drop-evidence.segment.v2',evidenceMode:'EVERY_DROP_V1',collectorMode:'GITHUB_ACTION_PINNED_V1',address:job.address,from:job.from,to:job.to,resolvedTo,server:r.server,serverPolicy:'PINNED_PARENT_RESTART_ON_FAIL',finishedAt:new Date().toISOString(),pages:r.pages,txCount:r.txCount,effectCount:r.effects.length,flowCount:r.flows.length,effects:r.effects,flows:r.flows,complete:true,truncated:false};
      return {key:`${job.address}|${job.from}|${job.to}`,value};
    }catch(e){last=e}
  }
  throw last||new Error('XRPL unavailable');
}

async function createBlob(content){return gh(`/repos/${OWNER}/${REPO}/git/blobs`,{method:'POST',body:{content,encoding:'utf-8'}})}
async function atomicCommit(files,message){
  const refPath='/repos/'+OWNER+'/'+REPO+'/git/ref/heads/'+DATA_BRANCH.split('/').map(encodeURIComponent).join('/');
  const ref=await gh(refPath),parentSha=ref.object.sha,parent=await gh(`/repos/${OWNER}/${REPO}/git/commits/${parentSha}`),entries=[];
  for(const f of files){const blob=await createBlob(f.content);entries.push({path:f.path,mode:'100644',type:'blob',sha:blob.sha})}
  const tree=await gh(`/repos/${OWNER}/${REPO}/git/trees`,{method:'POST',body:{base_tree:parent.tree.sha,tree:entries}});
  const commit=await gh(`/repos/${OWNER}/${REPO}/git/commits`,{method:'POST',body:{message,tree:tree.sha,parents:[parentSha]}});
  await gh('/repos/'+OWNER+'/'+REPO+'/git/refs/heads/'+DATA_BRANCH.split('/').map(encodeURIComponent).join('/'),{method:'PATCH',body:{sha:commit.sha,force:false}});
  return commit.sha;
}

async function main(){
  const manifest=await readManifest();
  if(manifest.database?.exactEvidenceArchiveStored===true&&manifest.base?.evidence?.available===true){console.log('[SKIP] exact evidence archive already stored');return}
  const addresses=manifest.sync?.trackedAddresses||[];
  if(addresses.length!==136)throw new Error(`expected 136 tracked addresses, got ${addresses.length}`);
  const jobs=[];for(const address of addresses)for(const [from,to] of RANGES)jobs.push({address,from,to});
  if(jobs.length!==2448)throw new Error(`expected 2448 jobs, got ${jobs.length}`);
  jobs.sort((a,b)=>((a.from===4181980?-1:0)-(b.from===4181980?-1:0))||a.from-b.from||a.address.localeCompare(b.address));
  const out=new Array(jobs.length);let next=0,done=0;
  async function worker(){
    while(true){const i=next++;if(i>=jobs.length)return;const row=await scanPinned(jobs[i]);out[i]=row;done++;if(done%50===0||done===jobs.length)console.log(`[SCAN] ${done}/${jobs.length}`)}
  }
  await Promise.all(Array.from({length:WORKERS},()=>worker()));
  out.sort((a,b)=>a.key.localeCompare(b.key));
  let effects=0,flows=0,txCount=0,pages=0;
  for(const row of out){effects+=row.value.effectCount;flows+=row.value.flowCount;txCount+=row.value.txCount;pages+=row.value.pages;const ex=EXPECTED_GAPS[row.key];if(ex){for(const f of ['txCount','effectCount','flowCount'])if(Number(row.value[f])!==ex[f])throw new Error(`${row.key} ${f} expected ${ex[f]} got ${row.value[f]}`)}}
  if(effects!==EXPECTED_EFFECTS)throw new Error(`total effect count expected ${EXPECTED_EFFECTS}, got ${effects}`);
  const payload={schema:'shadowwatch.genesis-drop-evidence.v1',exportedAt:new Date().toISOString(),source:{schema:'shadowwatch.xrpl.genesis-history.v1',snapshotLedger:32570,resolvedThroughLedger:BASE_TIP,collectorMode:'GITHUB_ACTION_PINNED_V1',serverPolicy:'PINNED_PARENT_RESTART_ON_FAIL'},segments:out};
  const raw=Buffer.from(JSON.stringify(payload)),gz=zlib.gzipSync(raw,{level:9}),b64=gz.toString('base64');
  const parts=[];for(let i=0;i<b64.length;i+=PART_CHARS)parts.push({path:`${DATA_ROOT}/base/evidence-${String(parts.length+1).padStart(2,'0')}.b64`,content:b64.slice(i,i+PART_CHARS)});
  const partIntegrity=parts.map(p=>({path:p.path,chars:p.content.length,sha256:sha(Buffer.from(p.content))}));
  const now=new Date().toISOString(),integrity={schema:'shadowwatch.genesis-lineage-hub.evidence-integrity.v1',createdAt:now,source:'server-recomputed XRPL account_tx',snapshotLedger:32570,resolvedThroughLedger:BASE_TIP,segments:out.length,txCount,effectCount:effects,flowCount:flows,pages,rawBytes:raw.length,gzipBytes:gz.length,sha256:sha(raw),gzipSha256:sha(gz),encoding:'gzip+base64-parts',parts:partIntegrity};
  manifest.updatedAt=now;manifest.database.exactEvidenceArchiveStored=true;manifest.database.evidenceIntegrityPath=`${DATA_ROOT}/EVIDENCE_INTEGRITY.json`;
  manifest.base.evidence={path:null,parts:parts.map(p=>p.path),encoding:'gzip+base64-parts',schema:'shadowwatch.genesis-drop-evidence.v1',sha256:integrity.sha256,gzipSha256:integrity.gzipSha256,bytes:raw.length,compressedBytes:gz.length,segments:out.length,txCount,effectCount:effects,flowCount:flows,pages,resolvedThroughLedger:BASE_TIP,available:true,source:'server-recomputed XRPL account_tx',collectorMode:'GITHUB_ACTION_PINNED_V1',serverPolicy:'PINNED_PARENT_RESTART_ON_FAIL'};
  manifest.coverage.evidenceComplete=2448;manifest.coverage.missingSegments=[];manifest.coverage.scanComplete=true;manifest.coverage.sealed=true;manifest.coverage.validatedTip=BASE_TIP;manifest.coverage.note=`SEALED: 2448/2448 exact Every-Drop segments are physically repo-stored, server-recomputed from XRPL, and fixed through ledger ${BASE_TIP}.`;
  manifest.sync.fixedThroughLedger=BASE_TIP;manifest.sync.tipByAccount={};
  const files=parts.concat([{path:`${DATA_ROOT}/EVIDENCE_INTEGRITY.json`,content:JSON.stringify(integrity,null,2)+'\n'},{path:MANIFEST_PATH,content:JSON.stringify(manifest,null,2)+'\n'}]);
  console.log(`[ARCHIVE] raw=${raw.length} gzip=${gz.length} parts=${parts.length} tx=${txCount} effects=${effects} flows=${flows}`);
  const commitSha=await atomicCommit(files,`lineage hub: seal exact 2448-segment base through L${BASE_TIP}`);
  console.log(`[SEALED] data commit ${commitSha}`);
}
main().catch(e=>{console.error('[FAIL]',e&&e.stack||e);process.exitCode=1});
