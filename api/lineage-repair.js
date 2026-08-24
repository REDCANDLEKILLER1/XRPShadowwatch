'use strict';

const zlib = require('zlib');
const crypto = require('crypto');

const OWNER = 'REDCANDLEKILLER1';
const REPO = 'XRPShadowwatch';
const DATA_BRANCH = 'hub/genesis-lineage-data';
const DATA_ROOT = 'data/genesis-lineage';
const MANIFEST_PATH = DATA_ROOT + '/manifest.json';
const GITHUB_API = 'https://api.github.com';
const XRPL_ENDPOINTS = [
  'https://s1.ripple.com:51234/',
  'https://s2.ripple.com:51234/',
  'https://xrplcluster.com/'
];
const MAX_PAGES = 220;
const PART_CHARS = 300000;

const GAPS = {
  r9h: { address:'r9hEDb4xBGRfBCcX3E4FirDWQBAYtpxC8K', from:4181980, to:10852617, shards:16 },
  rnzi:{ address:'rnziParaNb8nsU4aruQdwYE3j5jUcqjzFm', from:4181980, to:10852617, shards:12 }
};

function token(){ return process.env.SHADOWWATCH_HUB_GITHUB_TOKEN || process.env.GITHUB_TOKEN || ''; }
function ghHeaders(extra){
  const t=token();
  return Object.assign({
    'Accept':'application/vnd.github+json',
    'X-GitHub-Api-Version':'2022-11-28',
    'User-Agent':'ShadowWatch-Lineage-Repair/3.0'
  }, t ? {'Authorization':'Bearer '+t} : {}, extra||{});
}
async function gh(path, options){
  options=options||{};
  const r=await fetch(GITHUB_API+path,{
    method:options.method||'GET',headers:ghHeaders(options.headers),
    body:options.body==null?undefined:JSON.stringify(options.body)
  });
  if(!r.ok){
    let detail=''; try{detail=(await r.text()).slice(0,700)}catch(_){ }
    const e=new Error('GitHub '+r.status+' '+r.statusText+(detail?': '+detail:'')); e.status=r.status; throw e;
  }
  if(r.status===204)return null;
  return r.json();
}
async function ghRaw(path){
  const url=GITHUB_API+'/repos/'+OWNER+'/'+REPO+'/contents/'+path+'?ref='+encodeURIComponent(DATA_BRANCH);
  const r=await fetch(url,{headers:ghHeaders({'Accept':'application/vnd.github.raw'})});
  if(!r.ok){ const e=new Error('GitHub raw '+r.status+' for '+path); e.status=r.status; throw e; }
  return r;
}
async function readManifest(){
  const r=await ghRaw(MANIFEST_PATH), m=await r.json();
  if(!m||m.schema!=='shadowwatch.genesis-lineage-hub.v1')throw new Error('hub manifest schema mismatch');
  return m;
}
async function createBlob(content){
  return gh('/repos/'+OWNER+'/'+REPO+'/git/blobs',{method:'POST',body:{content,encoding:'utf-8'}});
}
async function atomicCommit(files,message){
  const refPath='/repos/'+OWNER+'/'+REPO+'/git/ref/heads/'+DATA_BRANCH.split('/').map(encodeURIComponent).join('/');
  const ref=await gh(refPath), parentSha=ref.object.sha;
  const parentCommit=await gh('/repos/'+OWNER+'/'+REPO+'/git/commits/'+parentSha);
  const entries=[];
  for(const f of files){
    const blob=await createBlob(f.content);
    entries.push({path:f.path,mode:'100644',type:'blob',sha:blob.sha});
  }
  const tree=await gh('/repos/'+OWNER+'/'+REPO+'/git/trees',{method:'POST',body:{base_tree:parentCommit.tree.sha,tree:entries}});
  const commit=await gh('/repos/'+OWNER+'/'+REPO+'/git/commits',{method:'POST',body:{message,tree:tree.sha,parents:[parentSha]}});
  await gh('/repos/'+OWNER+'/'+REPO+'/git/refs/heads/'+DATA_BRANCH.split('/').map(encodeURIComponent).join('/'),{method:'PATCH',body:{sha:commit.sha,force:false}});
  return commit.sha;
}

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
  const fee=tx.Account===address&&isDrops(tx.Fee)?bi(tx.Fee):0n;
  let out=delta<0n?(-delta-fee):0n;if(out<0n)out=0n;
  return {address,hash:tx.hash||item.hash||'',ledger:Number(item.ledger_index||tx.ledger_index||0),date:tx.date==null?null:Number(tx.date),year:rippleYear(tx.date),type:tx.TransactionType||'UNKNOWN',txAccount:tx.Account||null,destination:tx.Destination||null,balanceDeltaDrops:delta.toString(),feeDrops:fee.toString(),outflowDrops:out.toString(),inflowDrops:(delta>0n?delta:0n).toString()};
}
function nativeDeliveredDrops(tx,item){const m=txMeta(item),d=m.delivered_amount!=null?m.delivered_amount:m.DeliveredAmount;if(isDrops(d))return d;if(isDrops(tx.Amount))return tx.Amount;return null}
function directFlow(source,item){
  if(!successful(item))return null;
  const tx=txObj(item),meta=txMeta(item),type=tx.TransactionType||'';
  if(tx.Account!==source)return null;
  let dest=null,drops=null,classification=null;
  if(type==='Payment'){dest=tx.Destination;drops=nativeDeliveredDrops(tx,item);if(!drops)return null;classification='NATIVE_PAYMENT'}
  else if(type==='EscrowCreate'){dest=tx.Destination;if(!isDrops(tx.Amount))return null;drops=tx.Amount;classification='ESCROW_LOCK'}
  else if(type==='PaymentChannelCreate'){dest=tx.Destination;if(!isDrops(tx.Amount))return null;drops=tx.Amount;classification='PAYCHAN_LOCK'}
  else if(type==='AccountDelete'){dest=tx.Destination;const d=dest?accountBalanceDeltaDrops(meta,dest):null;if(d===null||d<=0n)return null;drops=d.toString();classification='ACCOUNT_DELETE_TRANSFER'}
  else return null;
  if(!dest||dest===source||bi(drops)<=0n)return null;
  return {source,dest,type,classification,drops,ledger:Number(item.ledger_index||tx.ledger_index||0),hash:tx.hash||item.hash||'',date:tx.date==null?null:Number(tx.date),year:rippleYear(tx.date)};
}

function split(g){
  const span=g.to-g.from+1,base=Math.floor(span/g.shards),rem=span%g.shards,out=[];let from=g.from;
  for(let i=0;i<g.shards;i++){const size=base+(i<rem?1:0);out.push({from,to:from+size-1});from+=size}
  return out;
}
async function xrplAt(url,method,params,timeout=30000){
  const c=new AbortController(),t=setTimeout(()=>c.abort(),timeout);
  try{
    const r=await fetch(url,{method:'POST',headers:{'content-type':'application/json','user-agent':'ShadowWatch-Lineage-Repair/3.0'},body:JSON.stringify({method,params:[params||{}]}),signal:c.signal});
    if(!r.ok)throw new Error('XRPL HTTP '+r.status+' '+url);
    const j=await r.json(),x=j&&j.result;
    if(!x||x.status==='error'||x.error)throw new Error('XRPL '+((x&&(x.error_message||x.error))||'invalid response'));
    return x;
  }finally{clearTimeout(t)}
}
async function scanOnServer(address,from,to,url){
  let marker=null,pages=0,txCount=0;const effects=[],flows=[],seen=new Set();
  do{
    if(++pages>MAX_PAGES)throw new Error('page cap exceeded');
    const q={account:address,ledger_index_min:from,ledger_index_max:to,binary:false,forward:true,limit:400};if(marker)q.marker=marker;
    let r,last;
    for(let a=0;a<4;a++){
      try{r=await xrplAt(url,'account_tx',q);break}catch(e){last=e;await new Promise(x=>setTimeout(x,250*(a+1)))}
    }
    if(!r)throw last;
    for(const item of (r.transactions||[])){txCount++;const e=normalizeEffect(address,item);if(e)effects.push(e);const f=directFlow(address,item);if(f)flows.push(f)}
    marker=r.marker||null;
    if(marker){const k=JSON.stringify(marker);if(seen.has(k))throw new Error('marker cycle');seen.add(k)}
  }while(marker);
  return {from,to,pages,txCount,effects,flows,server:url};
}
async function scanPinned(address,from,to){
  let last;
  for(const url of XRPL_ENDPOINTS){
    try{return await scanOnServer(address,from,to,url)}
    catch(e){last=e}
  }
  throw last||new Error('XRPL unavailable');
}
function dedupe(a,key){const s=new Set(),o=[];for(const x of a){const k=key(x);if(s.has(k))continue;s.add(k);o.push(x)}return o}
function sha(buf){return crypto.createHash('sha256').update(buf).digest('hex')}

async function buildParent(id){
  const g=GAPS[id];if(!g)throw Object.assign(new Error('invalid gap'),{status:400});
  const pieces=split(g),results=new Array(pieces.length);let next=0;
  async function worker(){while(true){const i=next++;if(i>=pieces.length)return;const p=pieces[i];results[i]=await scanPinned(g.address,p.from,p.to)}}
  await Promise.all(Array.from({length:Math.min(4,pieces.length)},worker));
  let effects=dedupe(results.flatMap(x=>x.effects),e=>`${e.hash}|${e.ledger}|${e.balanceDeltaDrops}|${e.type}`),
      flows=dedupe(results.flatMap(x=>x.flows),f=>`${f.hash}|${f.ledger}|${f.dest}|${f.classification}|${f.drops}`);
  effects.sort((a,b)=>a.ledger-b.ledger||a.hash.localeCompare(b.hash));
  flows.sort((a,b)=>a.ledger-b.ledger||a.hash.localeCompare(b.hash));
  const value={schema:'shadowwatch.genesis-drop-evidence.segment.v2',evidenceMode:'EVERY_DROP_V1',collectorMode:'HTTP_SHARDED_PINNED_V3',address:g.address,from:g.from,to:g.to,resolvedTo:g.to,serverPolicy:'PINNED_PER_SHARD_RESTART_ON_FAIL',finishedAt:new Date().toISOString(),shards:g.shards,shardRanges:results.map(x=>({from:x.from,to:x.to,pages:x.pages,txCount:x.txCount,server:x.server})),pages:results.reduce((n,x)=>n+x.pages,0),txCount:results.reduce((n,x)=>n+x.txCount,0),effectCount:effects.length,flowCount:flows.length,effects,flows,complete:true,truncated:false};
  const key=`${g.address}|${g.from}|${g.to}`;
  const raw=Buffer.from(JSON.stringify({key,value})),gz=zlib.gzipSync(raw,{level:9});
  return {id,key,g,value,raw,gz,sha256:sha(raw),gzipSha256:sha(gz),gzipBase64:gz.toString('base64')};
}

async function commitParent(id){
  if(!token())throw Object.assign(new Error('hub repository token is not configured'),{status:503});
  const p=await buildParent(id),manifest=await readManifest(),now=new Date().toISOString();
  const parts=[];
  for(let i=0;i<p.gzipBase64.length;i+=PART_CHARS){
    parts.push({path:`${DATA_ROOT}/repairs/${id}/parent-${String(parts.length+1).padStart(2,'0')}.b64`,content:p.gzipBase64.slice(i,i+PART_CHARS)});
  }
  const spec={id,key:p.key,address:p.g.address,from:p.g.from,to:p.g.to,encoding:'gzip+base64-parts',parts:parts.map(x=>x.path),partsCount:parts.length,rawBytes:p.raw.length,gzipBytes:p.gz.length,sha256:p.sha256,gzipSha256:p.gzipSha256,pages:p.value.pages,txCount:p.value.txCount,effectCount:p.value.effectCount,flowCount:p.value.flowCount,collectorMode:p.value.collectorMode,serverPolicy:p.value.serverPolicy,storedAt:now};
  manifest.updatedAt=now;
  manifest.database=manifest.database||{};
  manifest.database.repairEvidenceStored=true;
  manifest.coverage=manifest.coverage||{};
  manifest.coverage.repairs=Object.assign({},manifest.coverage.repairs||{},{[id]:spec});
  const missing=(manifest.coverage.missingSegments||[]).filter(x=>!(x.address===p.g.address&&Number(x.from)===p.g.from&&Number(x.to)===p.g.to));
  manifest.coverage.missingSegments=missing;
  const req=Number(manifest.coverage.requiredSegments||2448);
  manifest.coverage.evidenceComplete=req-missing.length;
  manifest.coverage.scanComplete=manifest.coverage.evidenceComplete===req;
  manifest.coverage.sealed=Boolean(manifest.coverage.scanComplete&&manifest.database.exactEvidenceArchiveStored===true);
  manifest.coverage.note=manifest.coverage.sealed
    ? 'All required historical Every-Drop evidence is repo-stored and sealed.'
    : (manifest.coverage.scanComplete
      ? 'All 2448 historical segments are accounted for, including server-recomputed pinned repair records; repo seal remains false until the registered 2446-segment base exact archive is physically stored.'
      : `Historical Every-Drop coverage is ${manifest.coverage.evidenceComplete}/${req}; listed missing segments remain unsealed.`);
  const commitSha=await atomicCommit(parts.concat([{path:MANIFEST_PATH,content:JSON.stringify(manifest,null,2)+'\n'}]),`lineage hub: store pinned repair ${id}`);
  return {ok:true,commitSha,spec,evidenceComplete:manifest.coverage.evidenceComplete,requiredSegments:req,scanComplete:manifest.coverage.scanComplete,sealed:manifest.coverage.sealed};
}

module.exports=async function handler(req,res){
  res.setHeader('cache-control','no-store');res.setHeader('access-control-allow-origin','*');
  try{
    if(req.method!=='GET')return res.status(405).json({error:'GET only'});
    const id=String(req.query&&req.query.gap||'');
    if(String(req.query&&req.query.commit)==='1')return res.status(200).json(await commitParent(id));
    const g=GAPS[id],i=Number(req.query&&req.query.shard);
    if(Number.isInteger(i)){
      if(!g||i<0||i>=g.shards)throw Object.assign(new Error('invalid repair shard'),{status:400});
      const p=split(g)[i],record=await scanPinned(g.address,p.from,p.to),raw=Buffer.from(JSON.stringify({schema:'shadowwatch.genesis-lineage-hub.repair-shard.v3',id,shard:i,shards:g.shards,address:g.address,from:p.from,to:p.to,record})),gz=zlib.gzipSync(raw,{level:9});
      return res.status(200).json({schema:'shadowwatch.genesis-lineage-hub.repair-envelope.v3',id,shard:i,shards:g.shards,address:g.address,from:p.from,to:p.to,server:record.server,pages:record.pages,txCount:record.txCount,effectCount:record.effects.length,flowCount:record.flows.length,rawBytes:raw.length,gzipBytes:gz.length,sha256:sha(raw),gzipSha256:sha(gz),gzipBase64:String(req.query&&req.query.meta)==='1'?undefined:gz.toString('base64')});
    }
    const p=await buildParent(id);
    const out={schema:'shadowwatch.genesis-lineage-hub.repair-parent-envelope.v3',id,address:p.g.address,from:p.g.from,to:p.g.to,pages:p.value.pages,txCount:p.value.txCount,effectCount:p.value.effectCount,flowCount:p.value.flowCount,rawBytes:p.raw.length,gzipBytes:p.gz.length,sha256:p.sha256,gzipSha256:p.gzipSha256,serverPolicy:p.value.serverPolicy,shardServers:p.value.shardRanges.map(x=>x.server)};
    if(String(req.query&&req.query.meta)!=='1')out.gzipBase64=p.gzipBase64;
    return res.status(200).json(out);
  }catch(e){res.status(Number(e&&e.status)||(/abort/i.test(String(e&&e.message))?504:500)).json({error:String(e&&e.message||e)})}
};
module.exports._test={split,accountBalanceDeltaDrops,directFlow};
