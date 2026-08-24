'use strict';

// One-time deterministic Generation-0 rebuild for ShadowWatch Genesis Lineage.
// Read-only XRPL only. Produces a gzip evidence archive + index at the fixed
// baseline ledger used by the browser research run. The workflow writes those
// artifacts to hub/genesis-lineage-data with the repository GITHUB_TOKEN.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const zlib = require('zlib');

const SNAPSHOT_LEDGER = 32570;
const FIXED_TIP = 106477810;
const CONCURRENCY = Math.max(1, Math.min(24, Number(process.env.GENESIS_SCAN_CONCURRENCY || 16)));
const ENDPOINTS = [
  'https://s1.ripple.com:51234/',
  'https://s2.ripple.com:51234/'
];
const ANCHORS = [
  32570, 165990, 437981, 1179153, 4181980, 10852618,
  18006991, 26648974, 35470456, 44091944, 52431070,
  60596732, 68710263, 76811784, 84974492, 93153309,
  101257403, 106477810
];
const KNOWN_HEAVY = new Set([
  'r9hEDb4xBGRfBCcX3E4FirDWQBAYtpxC8K|4181980|10852617',
  'rnziParaNb8nsU4aruQdwYE3j5jUcqjzFm|4181980|10852617'
]);

function sha256(buf) { return crypto.createHash('sha256').update(buf).digest('hex'); }
function isDrops(v) { return typeof v === 'string' && /^\d+$/.test(v); }
function bi(v) { try { return BigInt(v || '0'); } catch { return 0n; } }
function txObj(item) { return item && (item.tx || item.tx_json || item.transaction || item) || {}; }
function txMeta(item) { return item && (item.meta || item.metaData || item.metadata) || {}; }
function successful(item) {
  const m = txMeta(item);
  const r = m.TransactionResult || m.transaction_result || (item && item.engine_result);
  return !r || r === 'tesSUCCESS';
}
function rippleYear(sec) {
  if (sec == null || !Number.isFinite(Number(sec))) return null;
  return new Date((Number(sec) + 946684800) * 1000).getUTCFullYear();
}
function accountBalanceDeltaDrops(meta, address) {
  let delta = 0n, found = false;
  for (const wrap of (meta && meta.AffectedNodes || [])) {
    const n = wrap.ModifiedNode || wrap.CreatedNode || wrap.DeletedNode;
    if (!n || n.LedgerEntryType !== 'AccountRoot') continue;
    const f = n.FinalFields || {}, p = n.PreviousFields || {}, nw = n.NewFields || {};
    const acct = f.Account || nw.Account;
    if (acct !== address) continue;
    if (wrap.ModifiedNode && isDrops(f.Balance) && isDrops(p.Balance)) {
      delta += bi(f.Balance) - bi(p.Balance); found = true;
    } else if (wrap.CreatedNode && isDrops(nw.Balance)) {
      delta += bi(nw.Balance); found = true;
    } else if (wrap.DeletedNode && isDrops(f.Balance)) {
      delta -= bi(f.Balance); found = true;
    }
  }
  return found ? delta : null;
}
function normalizeEffect(address, item) {
  if (!successful(item)) return null;
  const tx = txObj(item), meta = txMeta(item);
  const delta = accountBalanceDeltaDrops(meta, address);
  if (delta === null || delta === 0n) return null;
  const fee = tx.Account === address && isDrops(tx.Fee) ? bi(tx.Fee) : 0n;
  let out = delta < 0n ? (-delta - fee) : 0n;
  if (out < 0n) out = 0n;
  return {
    address,
    hash: tx.hash || item.hash || '',
    ledger: Number(item.ledger_index || tx.ledger_index || 0),
    date: tx.date == null ? null : Number(tx.date),
    year: rippleYear(tx.date),
    type: tx.TransactionType || 'UNKNOWN',
    txAccount: tx.Account || null,
    destination: tx.Destination || null,
    balanceDeltaDrops: delta.toString(),
    feeDrops: fee.toString(),
    outflowDrops: out.toString(),
    inflowDrops: (delta > 0n ? delta : 0n).toString()
  };
}
function nativeDeliveredDrops(tx, item) {
  const m = txMeta(item);
  const d = m.delivered_amount != null ? m.delivered_amount : m.DeliveredAmount;
  if (isDrops(d)) return d;
  if (isDrops(tx.Amount)) return tx.Amount;
  return null;
}
function directFlow(source, item) {
  if (!successful(item)) return null;
  const tx = txObj(item), meta = txMeta(item), type = tx.TransactionType || '';
  if (tx.Account !== source) return null;
  let dest = null, drops = null, classification = null;
  if (type === 'Payment') {
    dest = tx.Destination; drops = nativeDeliveredDrops(tx, item);
    if (!drops) return null; classification = 'NATIVE_PAYMENT';
  } else if (type === 'EscrowCreate') {
    dest = tx.Destination; if (!isDrops(tx.Amount)) return null;
    drops = tx.Amount; classification = 'ESCROW_LOCK';
  } else if (type === 'PaymentChannelCreate') {
    dest = tx.Destination; if (!isDrops(tx.Amount)) return null;
    drops = tx.Amount; classification = 'PAYCHAN_LOCK';
  } else if (type === 'AccountDelete') {
    dest = tx.Destination;
    const d = dest ? accountBalanceDeltaDrops(meta, dest) : null;
    if (d === null || d <= 0n) return null;
    drops = d.toString(); classification = 'ACCOUNT_DELETE_TRANSFER';
  } else return null;
  if (!dest || dest === source || bi(drops) <= 0n) return null;
  return {
    source, dest, type, classification, drops,
    ledger: Number(item.ledger_index || tx.ledger_index || 0),
    hash: tx.hash || item.hash || '',
    date: tx.date == null ? null : Number(tx.date),
    year: rippleYear(tx.date)
  };
}
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function rpcAt(url, method, params) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 35000);
  try {
    const r = await fetch(url, {
      method: 'POST',
      headers: {'content-type':'application/json','user-agent':'ShadowWatch-Genesis-Seal/1.0'},
      body: JSON.stringify({method, params:[params || {}]}),
      signal: controller.signal
    });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const j = await r.json();
    const x = j && j.result;
    if (!x || x.status === 'error' || x.error) throw new Error((x && (x.error_message || x.error)) || 'invalid XRPL response');
    return x;
  } finally { clearTimeout(timer); }
}
async function xrpl(method, params) {
  let last;
  for (let attempt = 0; attempt < 8; attempt++) {
    for (const url of ENDPOINTS) {
      try { return await rpcAt(url, method, params); }
      catch (e) { last = e; }
    }
    await sleep(Math.min(12000, 500 * 2 ** attempt) + Math.floor(Math.random() * 250));
  }
  throw last || new Error('XRPL request failed');
}
function intervals() {
  return ANCHORS.map((from, i) => ({from, to: i + 1 < ANCHORS.length ? ANCHORS[i+1] - 1 : FIXED_TIP}));
}
function splitRange(from, to, count) {
  count = Math.max(1, Math.min(count, to - from + 1));
  const span = to - from + 1, base = Math.floor(span / count), rem = span % count;
  const out = []; let cur = from;
  for (let i=0;i<count;i++) {
    const size = base + (i < rem ? 1 : 0), end = cur + size - 1;
    out.push({from:cur,to:end}); cur=end+1;
  }
  return out;
}
async function scanRange(address, from, to) {
  let marker = null, pages = 0, txCount = 0;
  const effects = [], flows = [], seenMarkers = new Set();
  do {
    const req = {account:address,ledger_index_min:from,ledger_index_max:to,binary:false,forward:true,limit:400};
    if (marker) req.marker = marker;
    const r = await xrpl('account_tx', req);
    pages++;
    for (const item of (r.transactions || [])) {
      txCount++;
      const e = normalizeEffect(address, item); if (e) effects.push(e);
      const f = directFlow(address, item); if (f) flows.push(f);
    }
    marker = r.marker || null;
    if (marker) {
      const mk = JSON.stringify(marker);
      if (seenMarkers.has(mk)) throw new Error(`marker cycle ${address} L${from}-${to}`);
      seenMarkers.add(mk);
      if (pages > 10000) throw new Error(`safety ceiling before marker exhaustion ${address} L${from}-${to}`);
    }
  } while (marker);
  return {from,to,pages,txCount,effects,flows};
}
function dedupe(items, keyFn) {
  const seen = new Set(), out = [];
  for (const x of items) { const k = keyFn(x); if (seen.has(k)) continue; seen.add(k); out.push(x); }
  return out;
}
async function scanParent(address, seg) {
  const parentKey = `${address}|${seg.from}|${seg.to}`;
  let shardCount = KNOWN_HEAVY.has(parentKey) ? 16 : 1;
  // The 2014 interval is historically the densest. Four independent shards
  // prevent one serial marker chain from becoming the whole-job tail.
  if (seg.from === 4181980 && shardCount === 1) shardCount = 4;
  const pieces = splitRange(seg.from, seg.to, shardCount);
  const results = await Promise.all(pieces.map(p => scanRange(address,p.from,p.to)));
  let effects = dedupe(results.flatMap(r=>r.effects), e => `${e.hash}|${e.ledger}|${e.balanceDeltaDrops}|${e.type}`);
  let flows = dedupe(results.flatMap(r=>r.flows), f => `${f.hash}|${f.ledger}|${f.dest}|${f.classification}|${f.drops}`);
  effects.sort((a,b)=>a.ledger-b.ledger||(a.hash||'').localeCompare(b.hash||''));
  flows.sort((a,b)=>a.ledger-b.ledger||(a.hash||'').localeCompare(b.hash||''));
  return {
    key: parentKey,
    value: {
      schema:'shadowwatch.genesis-drop-evidence.segment.v2', evidenceMode:'EVERY_DROP_V2_SERVER_SEAL',
      collectorMode:'GITHUB_ACTION_HTTP_SHARDED_V1', address, from:seg.from, to:seg.to,
      resolvedTo:seg.to, server:ENDPOINTS, finishedAt:new Date().toISOString(),
      shards:shardCount,
      shardRanges:results.map(r=>({from:r.from,to:r.to,pages:r.pages,txCount:r.txCount})),
      pages:results.reduce((n,r)=>n+r.pages,0), txCount:results.reduce((n,r)=>n+r.txCount,0),
      effectCount:effects.length, flowCount:flows.length, effects, flows, complete:true, truncated:false
    }
  };
}
function validateIntervals() {
  const ints = intervals();
  if (ints[0].from !== SNAPSHOT_LEDGER || ints[ints.length-1].to !== FIXED_TIP) throw new Error('coverage endpoints invalid');
  for (let i=1;i<ints.length;i++) if (ints[i].from !== ints[i-1].to + 1) throw new Error('coverage gap/overlap');
  if (ints.length !== 18) throw new Error('expected 18 canonical intervals');
  return ints;
}

async function main() {
  const manifestPath = process.argv[2];
  const outDir = process.argv[3];
  if (!manifestPath || !outDir) throw new Error('usage: node seal-genesis-generation0.js <manifest.json> <out-dir>');
  const manifest = JSON.parse(fs.readFileSync(manifestPath,'utf8'));
  const addresses = [...new Set(manifest?.sync?.trackedAddresses || [])].sort();
  if (addresses.length !== 136) throw new Error(`expected 136 tracked addresses; got ${addresses.length}`);
  const ints = validateIntervals();
  fs.mkdirSync(outDir,{recursive:true});

  // Prove the endpoint can serve the fixed baseline before doing the expensive pass.
  const ledger = await xrpl('ledger',{ledger_index:FIXED_TIP,transactions:false,expand:false});
  const got = Number(ledger.ledger_index || ledger.ledger?.ledger_index);
  if (got !== FIXED_TIP) throw new Error(`fixed-tip ledger unavailable: requested ${FIXED_TIP}, got ${got}`);

  const jobs=[];
  for (const address of addresses) for (const seg of ints) jobs.push({address,seg});
  const results = new Array(jobs.length);
  let next=0,done=0;
  console.log(`Generation-0 seal start: addresses=${addresses.length}, parents=${jobs.length}, workers=${CONCURRENCY}, fixedTip=L${FIXED_TIP}`);
  async function worker(id) {
    while (true) {
      const idx=next++; if (idx>=jobs.length) return;
      const j=jobs[idx];
      results[idx]=await scanParent(j.address,j.seg);
      done++;
      if (done % 25 === 0 || done === jobs.length) console.log(`progress ${done}/${jobs.length} (W${id})`);
    }
  }
  await Promise.all(Array.from({length:CONCURRENCY},(_,i)=>worker(i+1)));

  if (results.some(x=>!x?.value?.complete || x.value.truncated)) throw new Error('one or more canonical parents not sealed');
  const keys=new Set(results.map(x=>x.key));
  if (keys.size!==2448) throw new Error(`expected 2448 unique parent segments; got ${keys.size}`);
  let effectCount=0,flowCount=0,txCount=0,pages=0;
  for(const r of results){effectCount+=r.value.effectCount;flowCount+=r.value.flowCount;txCount+=r.value.txCount;pages+=r.value.pages;}

  const archive={
    schema:'shadowwatch.genesis-drop-evidence.v2',
    builtAt:new Date().toISOString(),
    source:{schema:'shadowwatch.xrpl.genesis-history.v1',snapshotLedger:SNAPSHOT_LEDGER,fixedThroughLedger:FIXED_TIP,endpoints:ENDPOINTS},
    coverage:{addresses:136,intervalsPerAddress:18,requiredSegments:2448,completeSegments:2448,truncatedSegments:0,failedSegments:0,ledgerMin:SNAPSHOT_LEDGER,ledgerMax:FIXED_TIP,sealed:true},
    totals:{pages,txCount,effectCount,flowCount},
    segments:results
  };
  const raw=Buffer.from(JSON.stringify(archive));
  const gz=zlib.gzipSync(raw,{level:9});
  const index={
    schema:'shadowwatch.genesis-lineage-hub.generation0-index.v1',
    generatedAt:new Date().toISOString(),
    archivePath:'data/genesis-lineage/base/generation0-evidence.json.gz',
    archiveSchema:archive.schema,
    snapshotLedger:SNAPSHOT_LEDGER,fixedThroughLedger:FIXED_TIP,
    addresses:136,requiredSegments:2448,completeSegments:2448,sealed:true,
    pages,txCount,effectCount,flowCount,
    bytes:raw.length,compressedBytes:gz.length,sha256:sha256(raw),gzipSha256:sha256(gz),
    legacyBrowserArchive:{segments:2446,bytes:7665134,sha256:'5bbcb1d8f4c8531a7b1f09c3297ffe60123affb2700bc5619e4e85fb03383215'}
  };
  fs.writeFileSync(path.join(outDir,'generation0-evidence.json.gz'),gz);
  fs.writeFileSync(path.join(outDir,'generation0-index.json'),JSON.stringify(index,null,2)+'\n');
  console.log('GENERATION0_SEALED '+JSON.stringify(index));
}

main().catch(e=>{console.error('GENERATION0_SEAL_FAILED',e&&e.stack||e);process.exit(1)});
