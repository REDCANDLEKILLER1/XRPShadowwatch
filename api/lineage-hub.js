// ShadowWatch Genesis Lineage Hub — Vercel serverless API.
//
// Canonical hub data lives on a dedicated GitHub branch, not in browser storage.
// Public clients can READ it and can TRIGGER deterministic XRPL sync work, but
// they cannot submit canonical ledger evidence. The server re-reads XRPL and
// computes the evidence itself before writing an append-only delta to the hub.
//
// Required Vercel env for access to the private repository:
//   SHADOWWATCH_HUB_GITHUB_TOKEN (preferred) or GITHUB_TOKEN
// Fine-grained token permission: Contents — Read and write, Metadata — Read.
// Never expose that token to client JavaScript.

'use strict';

const OWNER = 'REDCANDLEKILLER1';
const REPO = 'XRPShadowwatch';
const DATA_BRANCH = 'hub/genesis-lineage-data';
const DATA_ROOT = 'data/genesis-lineage';
const MANIFEST_PATH = DATA_ROOT + '/manifest.json';
const XRPL_HTTP = 'https://s1.ripple.com:51234/';
const MAX_ACCOUNTS = 8;
const MAX_LEDGER_SPAN = 250000;
const MAX_PAGES_PER_ACCOUNT = 200;
const GITHUB_API = 'https://api.github.com';

function token() {
  return process.env.SHADOWWATCH_HUB_GITHUB_TOKEN || process.env.GITHUB_TOKEN || '';
}

function cors(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Cache-Control', 'no-store');
}

function jsonBody(req) {
  if (!req.body) return {};
  if (typeof req.body === 'object') return req.body;
  try { return JSON.parse(req.body); } catch (_) { return {}; }
}

function ghHeaders(extra) {
  const t = token();
  return Object.assign({
    'Accept': 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
    'User-Agent': 'ShadowWatch-Lineage-Hub/1.0'
  }, t ? { 'Authorization': 'Bearer ' + t } : {}, extra || {});
}

async function gh(path, options) {
  options = options || {};
  const r = await fetch(GITHUB_API + path, {
    method: options.method || 'GET',
    headers: ghHeaders(options.headers),
    body: options.body == null ? undefined : JSON.stringify(options.body)
  });
  if (!r.ok) {
    let detail = '';
    try { detail = (await r.text()).slice(0, 700); } catch (_) {}
    const e = new Error('GitHub ' + r.status + ' ' + r.statusText + (detail ? ': ' + detail : ''));
    e.status = r.status;
    throw e;
  }
  if (r.status === 204) return null;
  return r.json();
}

async function ghRaw(path) {
  const url = GITHUB_API + '/repos/' + OWNER + '/' + REPO + '/contents/' + path + '?ref=' + encodeURIComponent(DATA_BRANCH);
  const r = await fetch(url, {
    headers: ghHeaders({ 'Accept': 'application/vnd.github.raw' })
  });
  if (!r.ok) {
    const e = new Error('GitHub raw ' + r.status + ' for ' + path);
    e.status = r.status;
    throw e;
  }
  return r;
}

async function readBaseAsset(spec) {
  if (!spec) return null;
  if (spec.path) {
    const r = await ghRaw(spec.path);
    return { buffer: Buffer.from(await r.arrayBuffer()), contentType: r.headers.get('content-type') || null };
  }
  if (Array.isArray(spec.parts) && spec.parts.length && spec.encoding === 'gzip+base64-parts') {
    const chunks = [];
    for (const path of spec.parts) {
      const r = await ghRaw(path);
      chunks.push((await r.text()).trim());
    }
    return { buffer: Buffer.from(chunks.join(''), 'base64'), contentType: 'application/gzip' };
  }
  return null;
}

function canonicalTargetLedger(requested, validated) {
  const v = Number(validated);
  if (!Number.isInteger(v) || v <= 0) throw new Error('validated target ledger unavailable');
  if (requested == null || requested === '') return v;
  const r = Number(requested);
  if (!Number.isInteger(r) || r <= 0) {
    const e = new Error('invalid target ledger'); e.status = 400; throw e;
  }
  return Math.min(r, v);
}

async function readManifest() {
  const r = await ghRaw(MANIFEST_PATH);
  const m = await r.json();
  if (!m || m.schema !== 'shadowwatch.genesis-lineage-hub.v1') {
    throw new Error('hub manifest schema mismatch');
  }
  return m;
}

function isDrops(v) { return typeof v === 'string' && /^\d+$/.test(v); }
function bi(v) { try { return BigInt(v || '0'); } catch (_) { return 0n; } }

function txObj(item) { return item && (item.tx || item.tx_json || item.transaction || item) || {}; }
function txMeta(item) { return item && (item.meta || item.metaData || item.metadata) || {}; }
function successful(item) {
  const m = txMeta(item);
  const r = m.TransactionResult || m.transaction_result || item && item.engine_result;
  return !r || r === 'tesSUCCESS';
}

function accountBalanceDeltaDrops(meta, address) {
  let delta = 0n, found = false;
  const nodes = meta && meta.AffectedNodes || [];
  for (const wrap of nodes) {
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

function rippleYear(sec) {
  if (sec == null || !Number.isFinite(Number(sec))) return null;
  return new Date((Number(sec) + 946684800) * 1000).getUTCFullYear();
}

function normalizeEffect(address, item) {
  if (!successful(item)) return null;
  const tx = txObj(item), meta = txMeta(item);
  const delta = accountBalanceDeltaDrops(meta, address);
  if (delta === null || delta === 0n) return null;
  const fee = tx.Account === address && isDrops(tx.Fee) ? bi(tx.Fee) : 0n;
  let outflow = delta < 0n ? (-delta - fee) : 0n;
  if (outflow < 0n) outflow = 0n;
  const inflow = delta > 0n ? delta : 0n;
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
    outflowDrops: outflow.toString(),
    inflowDrops: inflow.toString()
  };
}

function nativeDeliveredDrops(tx, item) {
  const meta = txMeta(item);
  const d = meta.delivered_amount != null ? meta.delivered_amount : meta.DeliveredAmount;
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
    dest = tx.Destination;
    drops = nativeDeliveredDrops(tx, item);
    if (!drops) return null;
    classification = 'NATIVE_PAYMENT';
  } else if (type === 'EscrowCreate') {
    dest = tx.Destination;
    if (!isDrops(tx.Amount)) return null;
    drops = tx.Amount; classification = 'ESCROW_LOCK';
  } else if (type === 'PaymentChannelCreate') {
    dest = tx.Destination;
    if (!isDrops(tx.Amount)) return null;
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

async function xrpl(method, params, timeoutMs) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs || 20000);
  try {
    const r = await fetch(XRPL_HTTP, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'User-Agent': 'ShadowWatch-Lineage-Hub/1.0' },
      body: JSON.stringify({ method, params: [params || {}] }),
      signal: ctrl.signal
    });
    if (!r.ok) throw new Error('XRPL HTTP ' + r.status);
    const j = await r.json();
    const result = j && j.result;
    if (!result || result.status === 'error' || result.error) {
      throw new Error('XRPL ' + ((result && (result.error_message || result.error)) || 'invalid response'));
    }
    return result;
  } finally { clearTimeout(timer); }
}

async function validatedTip() {
  const r = await xrpl('ledger', { ledger_index: 'validated', transactions: false, expand: false }, 15000);
  const n = Number(r.ledger_index != null ? r.ledger_index : r.ledger && r.ledger.ledger_index);
  if (!Number.isFinite(n) || n <= 0) throw new Error('validated ledger index unavailable');
  return n;
}

async function scanAccount(address, from, to) {
  let marker = null, pages = 0, txCount = 0;
  const effects = [], flows = [];
  do {
    if (++pages > MAX_PAGES_PER_ACCOUNT) throw new Error('page cap exceeded for ' + address);
    const req = {
      account: address,
      ledger_index_min: from,
      ledger_index_max: to,
      binary: false,
      forward: true,
      limit: 400
    };
    if (marker) req.marker = marker;
    const r = await xrpl('account_tx', req, 25000);
    for (const item of (r.transactions || [])) {
      txCount++;
      const e = normalizeEffect(address, item); if (e) effects.push(e);
      const f = directFlow(address, item); if (f) flows.push(f);
    }
    marker = r.marker || null;
  } while (marker);
  effects.sort((a,b) => a.ledger - b.ledger || a.hash.localeCompare(b.hash));
  flows.sort((a,b) => a.ledger - b.ledger || a.hash.localeCompare(b.hash));
  return { address, from, to, pages, txCount, effectCount: effects.length, flowCount: flows.length, effects, flows };
}

async function createBlob(content, encoding) {
  return gh('/repos/' + OWNER + '/' + REPO + '/git/blobs', {
    method: 'POST', body: { content, encoding: encoding || 'utf-8' }
  });
}

async function atomicCommit(files, message) {
  const refPath = '/repos/' + OWNER + '/' + REPO + '/git/ref/heads/' + DATA_BRANCH.split('/').map(encodeURIComponent).join('/');
  const ref = await gh(refPath);
  const parentSha = ref.object.sha;
  const parentCommit = await gh('/repos/' + OWNER + '/' + REPO + '/git/commits/' + parentSha);
  const entries = [];
  for (const f of files) {
    const blob = await createBlob(f.content, 'utf-8');
    entries.push({ path: f.path, mode: '100644', type: 'blob', sha: blob.sha });
  }
  const tree = await gh('/repos/' + OWNER + '/' + REPO + '/git/trees', {
    method: 'POST', body: { base_tree: parentCommit.tree.sha, tree: entries }
  });
  const commit = await gh('/repos/' + OWNER + '/' + REPO + '/git/commits', {
    method: 'POST', body: { message, tree: tree.sha, parents: [parentSha] }
  });
  await gh('/repos/' + OWNER + '/' + REPO + '/git/refs/heads/' + DATA_BRANCH.split('/').map(encodeURIComponent).join('/'), {
    method: 'PATCH', body: { sha: commit.sha, force: false }
  });
  return commit.sha;
}

function sanitizeDeltaPath(path) {
  if (typeof path !== 'string') return null;
  if (!path.startsWith(DATA_ROOT + '/deltas/')) return null;
  if (path.includes('..') || path.includes('\\')) return null;
  if (!/\.json$/.test(path)) return null;
  return path;
}

function compactAddress(a) { return a.slice(0,6) + '-' + a.slice(-5); }

async function doSync(body) {
  if (!token()) {
    const e = new Error('hub repository token is not configured'); e.status = 503; throw e;
  }
  const manifest = await readManifest();
  if (!manifest.sync || !manifest.sync.ready) {
    const e = new Error('hub sync is not ready'); e.status = 409; throw e;
  }
  let accounts = Array.isArray(body.accounts) ? body.accounts : [];
  accounts = [...new Set(accounts.filter(a => typeof a === 'string'))];
  if (!accounts.length || accounts.length > MAX_ACCOUNTS) {
    const e = new Error('accounts must contain 1-' + MAX_ACCOUNTS + ' addresses'); e.status = 400; throw e;
  }
  const tracked = new Set(manifest.sync.trackedAddresses || []);
  if (accounts.some(a => !tracked.has(a))) {
    const e = new Error('sync may only target tracked genesis addresses'); e.status = 403; throw e;
  }
  const validated = await validatedTip();
  const tip = canonicalTargetLedger(body.to, validated);
  const tipBy = Object.assign({}, manifest.sync.tipByAccount || {});
  const work = [];
  for (const address of accounts) {
    const current = Number(tipBy[address] || manifest.sync.fixedThroughLedger || 0);
    if (tip <= current) continue;
    const from = current + 1;
    if ((tip - from + 1) > MAX_LEDGER_SPAN) {
      const e = new Error('incremental range too large; max ' + MAX_LEDGER_SPAN + ' ledgers'); e.status = 409; throw e;
    }
    work.push({ address, from, to: tip });
  }
  if (!work.length) return { ok: true, skipped: true, targetLedger: tip, manifest };

  const records = await Promise.all(work.map(w => scanAccount(w.address, w.from, w.to)));
  for (const r of records) tipBy[r.address] = tip;

  const allTracked = manifest.sync.trackedAddresses || [];
  let fixedThrough = Infinity;
  for (const a of allTracked) fixedThrough = Math.min(fixedThrough, Number(tipBy[a] || manifest.sync.fixedThroughLedger || 0));
  if (!Number.isFinite(fixedThrough)) fixedThrough = Number(manifest.sync.fixedThroughLedger || 0);

  const now = new Date().toISOString();
  const id = 'L' + Math.min(...records.map(r => r.from)) + '-L' + tip + '-' + Date.now().toString(36);
  const deltaPath = DATA_ROOT + '/deltas/' + now.slice(0,7) + '/' + id + '.json';
  const delta = {
    schema: 'shadowwatch.genesis-lineage-hub.delta.v1',
    id, createdAt: now, targetLedger: tip,
    server: XRPL_HTTP,
    records
  };
  const deltaSummary = {
    id, path: deltaPath, createdAt: now, targetLedger: tip,
    accounts: records.length,
    txCount: records.reduce((n,r)=>n+r.txCount,0),
    effectCount: records.reduce((n,r)=>n+r.effectCount,0),
    flowCount: records.reduce((n,r)=>n+r.flowCount,0)
  };
  manifest.updatedAt = now;
  manifest.sync.tipByAccount = tipBy;
  manifest.sync.fixedThroughLedger = fixedThrough;
  manifest.sync.deltas = (manifest.sync.deltas || []).concat([deltaSummary]);
  manifest.coverage.validatedTip = Math.max(Number(manifest.coverage.validatedTip || 0), fixedThrough);

  const commitSha = await atomicCommit([
    { path: deltaPath, content: JSON.stringify(delta) + '\n' },
    { path: MANIFEST_PATH, content: JSON.stringify(manifest, null, 2) + '\n' }
  ], 'lineage hub: sync ' + records.length + ' account(s) through L' + tip);

  return { ok: true, targetLedger: tip, fixedThroughLedger: fixedThrough, delta, deltaSummary, commitSha };
}

async function handler(req, res) {
  cors(res);
  if (req.method === 'OPTIONS') { res.status(204).end(); return; }
  try {
    if (req.method === 'GET') {
      const asset = req.query && req.query.asset;
      const delta = req.query && req.query.delta;
      if (asset || delta) {
        const manifest = await readManifest();
        if (asset) {
          const map = {
            checkpoint: manifest.base && manifest.base.checkpoint,
            evidence: manifest.base && manifest.base.evidence,
            report: manifest.base && manifest.base.report,
            debug: manifest.base && manifest.base.debug
          };
          const spec = map[String(asset)] || null;
          const loaded = await readBaseAsset(spec);
          if (!loaded) { res.status(404).json({ error: 'hub asset not found' }); return; }
          const fallbackType = String(asset) === 'evidence' ? 'application/gzip' : (String(asset) === 'report' || String(asset) === 'debug' ? 'text/plain; charset=utf-8' : 'application/json');
          res.setHeader('Content-Type', loaded.contentType || fallbackType);
          res.status(200).send(loaded.buffer);
          return;
        }
        const path = sanitizeDeltaPath(String(delta));
        const allowed = new Set((manifest.sync && manifest.sync.deltas || []).map(d => d.path));
        if (!path || !allowed.has(path)) { res.status(404).json({ error: 'hub asset not found' }); return; }
        const upstream = await ghRaw(path);
        res.setHeader('Content-Type', upstream.headers.get('content-type') || 'application/json');
        res.status(200).send(Buffer.from(await upstream.arrayBuffer()));
        return;
      }
      const manifest = await readManifest();
      res.status(200).json({
        ok: true,
        accessConfigured: Boolean(token()),
        writeConfigured: Boolean(token()),
        branch: DATA_BRANCH,
        manifest
      });
      return;
    }
    if (req.method === 'POST') {
      const body = jsonBody(req);
      if (body.action !== 'sync') { res.status(400).json({ error: 'unsupported action' }); return; }
      const result = await doSync(body);
      res.status(200).json(result);
      return;
    }
    res.status(405).json({ error: 'method not allowed' });
  } catch (e) {
    const status = Number(e && e.status) || (/abort/i.test(String(e && e.message)) ? 504 : 500);
    res.status(status).json({ error: String(e && e.message || e) });
  }
}

module.exports = handler;
module.exports._test = {
  accountBalanceDeltaDrops, normalizeEffect, directFlow, sanitizeDeltaPath,
  successful, isDrops, bi, compactAddress, canonicalTargetLedger
};
