#!/usr/bin/env node
'use strict';
// Operator-only bounded acquisition pilot. Never imported by the app/API.
// This module has no account roster, signing, submission or deletion path.
const zlib = require('zlib');
const {GetObjectCommand, PutObjectCommand} = require('@aws-sdk/client-s3');
const R = require('./r2-master-backup');
const B = require('../src/db/master-backup');
const M = require('./market-evidence');
const F = require('../src/db/forensic-patterns');
const T = require('../src/db/transactions');
const X = require('../src/db/evidence-export');
const SCHEMA = 'shadowwatch-market-collector/1';
const PREFIX = 'market-pilot/v1/';
const LIMITS = Object.freeze({ledgers:32, response:16*1024*1024, object:2*1024*1024,
  run:8*1024*1024, day:32*1024*1024, milliseconds:120000, requests:66});
const hashOK = h => typeof h === 'string' && /^[A-Fa-f0-9]{64}$/.test(h);
const sha = b => B.sha256(b);
const encode = v => Buffer.from(JSON.stringify(v)+'\n');
function bounds(start, end) {
  if (!Number.isSafeInteger(start) || start < 2 || !Number.isSafeInteger(end) || end < start || end-start+1 > LIMITS.ledgers)
    throw Error('PILOT_RANGE_INVALID');
}
function header(result, index) {
  const l = result?.ledger;
  if (result?.validated !== true || !l || l.closed !== true || Number(result.ledger_index) !== index ||
      Number(l.ledger_index) !== index || !hashOK(result.ledger_hash) || l.ledger_hash !== result.ledger_hash ||
      !hashOK(l.parent_hash) || !Number.isSafeInteger(l.close_time) || l.close_time < 0)
    throw Error('PILOT_LEDGER_UNPROVEN');
  return {index, hash:l.ledger_hash, parent:l.parent_hash, close_time:new Date((l.close_time+946684800)*1000).toISOString()};
}
function transaction(item, index, h) {
  const tx = item.tx_json || item.tx || item, meta = item.meta || item.metaData;
  const id = item.hash || tx.hash;
  if (!hashOK(id) || (tx.hash && tx.hash !== id) || !meta || !Number.isSafeInteger(meta.TransactionIndex) ||
      meta.TransactionIndex < 0 || !Array.isArray(meta.AffectedNodes) || typeof meta.TransactionResult !== 'string' ||
      typeof tx.Account !== 'string' || typeof tx.TransactionType !== 'string' || item.validated === false ||
      (item.ledger_index !== undefined && Number(item.ledger_index) !== index) ||
      (item.ledger_hash !== undefined && item.ledger_hash !== h)) throw Error('PILOT_TRANSACTION_INVALID');
  return {tx, meta, hash:id};
}
function reconcile(expanded, hashes, index, parent) {
  const h = header(expanded,index), second = header(hashes,index);
  for (const field of ['parent_hash','close_time','account_hash','transaction_hash','total_coins',
    'close_flags','close_time_resolution','parent_close_time']) {
    if (expanded.ledger[field] !== hashes.ledger[field]) throw Error('PILOT_LEDGER_HEADER_MISMATCH');
  }
  if (h.hash !== second.hash || h.parent !== parent || !Array.isArray(expanded.ledger.transactions) ||
      !Array.isArray(hashes.ledger.transactions)) throw Error('PILOT_LEDGER_CHAIN_MISMATCH');
  const rows = expanded.ledger.transactions.map(t => transaction(t,index,h.hash));
  const ids = new Set(rows.map(t => t.hash.toUpperCase()));
  const expected = hashes.ledger.transactions;
  if (ids.size !== rows.length || expected.length !== rows.length || expected.some(x => !hashOK(x)) ||
      new Set(expected.map(x=>x.toUpperCase())).size !== expected.length || expected.some(x => !ids.has(x.toUpperCase())))
    throw Error('PILOT_TRANSACTION_SET_MISMATCH');
  rows.sort((a,b)=>a.meta.TransactionIndex-b.meta.TransactionIndex);
  if (rows.some((r,i)=>r.meta.TransactionIndex !== i)) throw Error('PILOT_TRANSACTION_INDEX_GAP');
  const facts = rows.map(r => {
    const row = T.rowFromAccountTx({tx_json:{...r.tx,date:expanded.ledger.close_time},meta:r.meta,
      hash:r.hash,ledger_index:index,validated:true});
    return F.inspect(X.eventOf({...row,close_time:h.close_time}),X.payloadOf(row));
  });
  // Participant legs are retained for later reconciliation, never summed into market volume.
  const statuses = {}, types = {};
  for (const f of facts) statuses[f.status] = (statuses[f.status]||0)+1;
  for (const r of rows) types[r.tx.TransactionType] = (types[r.tx.TransactionType]||0)+1;
  return {header:h, facts, transaction_count:rows.length, statuses, transaction_types:types,
    recognized_exchange_transactions:facts.filter(f=>f.exchanges.length).length,
    recognized_wallet_legs:facts.reduce((n,f)=>n+f.exchanges.length,0),
    unique_market_volume:null, classification_complete:false,
    limitations:['Existing classifier recognizes selected wallet legs only.',
      'AMM swaps, routed payments and unique economic fills are not fully reconciled.',
      'Hash list is corroborated against the same provider, not independently reconstructed from the transaction root.']};
}
function stateKey(start,end) { return PREFIX+'ranges/'+start+'-'+end+'.json'; }
function validateState(s,start,end) {
  if (s.schema !== SCHEMA || s.start !== start || s.end !== end || !Array.isArray(s.receipts) ||
      s.receipts.length > end-start+1 || !hashOK(s.anchor_parent) || !hashOK(s.target_hash) ||
      s.next !== start+s.receipts.length || s.assets_identity !== JSON.stringify(F.ASSETS) ||
      s.read_only !== true || s.automatic_admission !== false || s.interval_complete !== (s.next === end+1) ||
      s.history_complete !== false || s.continuous !== false || s.classification_complete !== false || s.unique_market_volume !== null) throw Error('PILOT_CHECKPOINT_INVALID');
  let parent = s.anchor_parent;
  for (let i=0;i<s.receipts.length;i++) {
    const r=s.receipts[i];
    if (r.index !== start+i || r.parent !== parent || !hashOK(r.hash) ||
        !/^[a-f0-9]{64}$/.test(r.sha256) || r.key !== PREFIX+'objects/'+r.sha256+'.json.gz' ||
        !Number.isSafeInteger(r.bytes) || r.bytes <= 0 || r.bytes > LIMITS.object)
      throw Error('PILOT_CHECKPOINT_INVALID');
    parent=r.hash;
  }
  if (s.next === end+1 && parent !== s.target_hash) throw Error('PILOT_TARGET_MISMATCH');
}
async function readBody(body, limit) {
  const parts=[];let size=0;
  for await(const p of body){size+=p.length;if(size>limit)throw Error('PILOT_READ_LIMIT');parts.push(Buffer.from(p));}
  return Buffer.concat(parts);
}
function r2Store(s3) {
  return {
    async load(key) {
      try {
        const r=await s3.send(new GetObjectCommand({Bucket:R.BUCKET,Key:key}));
        if(!r.ETag)throw Error('PILOT_ETAG_MISSING');
        return {state:JSON.parse((await readBody(r.Body,LIMITS.object)).toString()),version:r.ETag};
      } catch(e) { if(e.name==='NoSuchKey')return null;throw e; }
    },
    async verify(r) {return R.download(s3,r.key,r.bytes,r.sha256);},
    async put(key,body) {
      try {await s3.send(new PutObjectCommand({Bucket:R.BUCKET,Key:key,Body:body,IfNoneMatch:'*',ContentType:'application/gzip'}));}
      catch(e){if(e.name!=='PreconditionFailed'&&e.$metadata?.httpStatusCode!==412)throw e;}
      await R.download(s3,key,body.length,sha(body));
    },
    async save(key,state,version) {
      const body=encode(state);
      if(body.length>LIMITS.object)throw Error('PILOT_STATE_SIZE_STOP');
      await s3.send(new PutObjectCommand({Bucket:R.BUCKET,Key:key,Body:body,
        ...(version?{IfMatch:version}:{IfNoneMatch:'*'}),ContentType:'application/json'}));
      const read=await this.load(key);
      if(!read || sha(encode(read.state))!==sha(body))throw Error('PILOT_CHECKPOINT_CONFLICT');
      return read.version;
    },
    async usage(day) {
      const inv=await R.inventory(s3);
      let dayBytes=0;
      // Admission reservations include orphan uploads and checkpoints. No deletion.
      for(const [key] of inv.objects)if(key.startsWith(PREFIX+'budgets/'+day+'/')) {
        const m=key.match(/\/([0-9]+)-[a-f0-9-]+\.json$/);
        if(!m || !Number.isSafeInteger(Number(m[1])))throw Error('PILOT_BUDGET_INVALID');
        dayBytes+=Number(m[1]);
      }
      return {total:inv.total,dayBytes};
    },
    async reserve(day,id,bytes) {
      // Shared R2 Actions concurrency lane serializes this check/reservation.
      // Fixed-size reservations remain after failures, so retries cannot evade the daily cap.
      const body=encode({reserved_bytes:bytes});
      await s3.send(new PutObjectCommand({Bucket:R.BUCKET,Key:PREFIX+'budgets/'+day+'/'+bytes+'-'+id+'.json',Body:body,IfNoneMatch:'*'}));
    }
  };
}
async function collect({start,end,store,rpc=M.rpc,clock=Date.now,id=require('crypto').randomUUID(),expectedParent}={}) {
  bounds(start,end);
  const begun=clock(), key=stateKey(start,end), day=new Date(begun).toISOString().slice(0,10);
  const metrics={rpc_requests:0,processed_ledgers:0,reused_ledgers:0,raw_bytes:0,compressed_bytes:0,elapsed_ms:0};
  const loaded=await store.load(key);let s=loaded?.state,version=loaded?.version;
  async function read(params) {
    if(clock()-begun>=LIMITS.milliseconds||metrics.rpc_requests>=LIMITS.requests)throw Error('PILOT_RUN_BUDGET_STOP');
    metrics.rpc_requests++;
    return rpc('ledger',params);
  }
  if(s) {
    validateState(s,start,end);
    // Restore must verify bytes and their binding to the checkpoint before continuing.
    for(const r of s.receipts) {
      const body=await store.verify(r);
      const record=JSON.parse(zlib.gunzipSync(body,{maxOutputLength:LIMITS.response*2}).toString());
      if(record.schema!==SCHEMA || record.header.index!==r.index || record.header.hash!==r.hash ||
          record.header.parent!==r.parent)throw Error('PILOT_RESTORE_MISMATCH');
      metrics.reused_ledgers++;
    }
  } else {
    const target=header(await read({ledger_index:end,transactions:false}),end);
    const previous=header(await read({ledger_index:start-1,transactions:false}),start-1);
    s={schema:SCHEMA,start,end,next:start,anchor_parent:previous.hash,target_hash:target.hash,
      assets_identity:JSON.stringify(F.ASSETS),read_only:true,automatic_admission:false,
      receipts:[],scope:'BOUNDED_VALIDATED_LEDGER_INTERVAL',history_complete:false,continuous:false,
      interval_complete:false,unique_market_volume:null,classification_complete:false};
  }
  // The supervisor binds adjacent ranges before any reservation or evidence write.
  if(expectedParent!==undefined&&(!hashOK(expectedParent)||s.anchor_parent!==expectedParent))throw Error('PILOT_SUPERVISOR_CHAIN_MISMATCH');
  if(s.next===end+1)return {...metrics,elapsed_ms:clock()-begun,interval_complete:true,next:s.next,remaining_ledgers:0,unique_market_volume:null,classification_complete:false};
  // Reserve worst-case storage BEFORE any new data/checkpoint writes. Reservations
  // include checkpoint/control overhead. Shared writer lane is mandatory.
  const remaining=Math.min(end-s.next+1,Math.floor(LIMITS.run/LIMITS.object));
  const reservation=remaining*LIMITS.object+128*1024;
  const usage=await store.usage(day);
  if(usage.dayBytes+reservation>LIMITS.day || usage.total+reservation>R.LIMIT)throw Error('PILOT_CAPACITY_STOP');
  await store.reserve(day,id,reservation);
  if(!loaded)version=await store.save(key,s,null);
  let reason=null;
  for(let index=s.next;index<=end;index++) {
    if(metrics.processed_ledgers>=remaining){reason='PILOT_RUN_BUDGET_STOP';break;}
    let record,body;
    try {
      const expanded=await read({ledger_index:index,transactions:true,expand:true});
      const h=header(expanded,index);
      const hashes=await read({ledger_hash:h.hash,transactions:true,expand:false});
      const parent=s.receipts.length?s.receipts.at(-1).hash:s.anchor_parent;
      const facts=reconcile(expanded,hashes,index,parent);
      if(index===end&&h.hash!==s.target_hash)throw Error('PILOT_TARGET_MISMATCH');
      const raw=encode({expanded,hashes});
      if(raw.length>LIMITS.response*2)throw Error('PILOT_RESPONSE_SIZE_STOP');
      record={schema:SCHEMA,...facts,raw:{expanded,hashes},source:'https://s1.ripple.com:51234/'};
      const encoded=encode(record);
      if(encoded.length>LIMITS.response*2)throw Error('PILOT_RESPONSE_SIZE_STOP');
      body=zlib.gzipSync(encoded);
      if(body.length>LIMITS.object)throw Error('PILOT_OBJECT_SIZE_STOP');
      if(metrics.compressed_bytes+body.length>LIMITS.run)throw Error('PILOT_RUN_BUDGET_STOP');
      metrics.raw_bytes+=raw.length;
    } catch(e) {
      // Do not log upstream text or write it into public logs. Never skip a gap.
      reason=/^PILOT_[A-Z_]+$/.test(e.message)?e.message:'PILOT_LEDGER_READ_FAILED';break;
    }
    const digest=sha(body), objectKey=PREFIX+'objects/'+digest+'.json.gz';
    await store.put(objectKey,body); // immutable write and independent readback
    const receipt={...record.header,key:objectKey,bytes:body.length,sha256:digest,
      transaction_count:record.transaction_count,recognized_exchange_transactions:record.recognized_exchange_transactions,
      recognized_wallet_legs:record.recognized_wallet_legs};
    const next={...s,next:index+1,receipts:[...s.receipts,receipt],gap:null,
      interval_complete:index===end,updated_at:new Date(clock()).toISOString()};
    version=await store.save(key,next,version); // conditional, non-regressing checkpoint
    s=next;metrics.processed_ledgers++;metrics.compressed_bytes+=body.length;
  }
  if(reason) {
    const next={...s,gap:{from:s.next,through:end,reason,recoverable:'UNKNOWN_RETRY_SAME_LEDGER'},interval_complete:false,
      updated_at:new Date(clock()).toISOString()};
    version=await store.save(key,next,version);s=next;
  }
  metrics.elapsed_ms=clock()-begun;
  return {...metrics,interval_complete:s.interval_complete,next:s.next,remaining_ledgers:end-s.next+1,
    stop_reason:reason,unique_market_volume:null,classification_complete:false};
}
async function main() {
  // Only run the private writer in the repository's serialized, reviewed manual lane.
  if(process.env.GITHUB_ACTIONS!=='true'||process.env.GITHUB_REPOSITORY!=='REDCANDLEKILLER1/XRPShadowwatch'||
      process.env.GITHUB_WORKFLOW!=='Private forensic evidence'||process.env.GITHUB_EVENT_NAME!=='workflow_dispatch'||process.env.GITHUB_REF!=='refs/heads/main'||
      process.env.SHADOWWATCH_AUTOROSTER_ENABLED!=='false')throw Error('PILOT_OPERATOR_LANE_REQUIRED');
  const result=await collect({start:Number(process.env.MARKET_PILOT_START),end:Number(process.env.MARKET_PILOT_END),store:r2Store(R.client())});
  // Aggregate metrics only. No raw transactions, participants, credentials or private object keys.
  console.log(JSON.stringify(result));
  if(!result.interval_complete)process.exitCode=2;
}
if(require.main===module)main().catch(()=>{console.error('Private market pilot stopped; checkpoint was not advanced past unverified evidence.');process.exitCode=1;});
module.exports={collect,reconcile,header,bounds,r2Store,stateKey,validateState,SCHEMA,PREFIX,LIMITS};
