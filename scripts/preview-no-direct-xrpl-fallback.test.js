#!/usr/bin/env node
'use strict';
// Real server handler, evidence client, and FULL scanWallets function.
// Only HTTP, XRPL transport, UI sinks and the layer-17 row adapter are mocks.
const fs = require('fs'), path = require('path'), vm = require('vm'), assert = require('assert');
const root = path.join(__dirname, '..');
const core = fs.readFileSync(path.join(root, 'src/brief/02-core.js'), 'utf8');
const client = fs.readFileSync(path.join(root, 'src/brief/45-delta-evidence-index-20260911.js'), 'utf8');
const ra = require('../src/brief/41-run-anchor-20260906');
function between(a, b) {
  const i = core.indexOf(a), j = core.indexOf(b, i);
  assert(i >= 0 && j > i, 'real source boundaries missing'); return core.slice(i, j);
}
const acquisition = between('async function beginEvidenceIndexResilient(', '// ── WHO SIGNED IT');
const address = 'rEb8TK3gBgk5auZkwc6sHnwrGVJH8DuaLh';
const anchor = 107158879, close = '2026-09-22T12:25:41.000Z';
const range = { startMs: Date.parse('2026-09-21T12:25:41Z'), endMs: Date.parse('2026-09-22T13:25:41Z') };
const snapshot = () => ({
  scan_id: 'preview-' + anchor, anchor_ledger: anchor, anchor_close: close,
  target_wallets: 1, complete_wallets: 1, wallets: [{ address, status: 'COMPLETE', proven: true, proven_through: anchor }],
  events: [], transactions: 0, xrpl_requests: 0, committed: false, checkpoint_advanced: false,
  reason: 'PREVIEW_READ_ONLY_SNAPSHOT', preview_read_only: true, live_acquisition_disabled: true,
  window: { from: new Date(range.startMs).toISOString(), to: close, in_window: 0, from_stored: 0, from_this_run: 0, days_without_shards: [] }
});
const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
const ndjson = body => new Response(JSON.stringify(body) + '\n', { headers: { 'Content-Type': 'application/x-ndjson' } });
let passed = 0;
async function test(name, fn) { await fn(); passed++; console.log('PASS ' + name); }
async function browserCase(kind, environment = 'preview') {
  let attempts = 0, policyCalls = 0;
  const xrplCalls = [], logs = [], writes = [], data = new Map();
  const s = {
    Response, TextDecoder, AbortController, Blob, Uint8Array, DecompressionStream, atob, console,
    // Accelerate only the existing retry delay, not idle/abort timers.
    setTimeout: (fn, ms) => setTimeout(fn, ms === 2000 ? 0 : ms), clearTimeout,
    document: { visibilityState: 'visible', hidden: false, addEventListener() {}, removeEventListener() {} },
    state: {}, STORE: 'balance-snapshot', SCAN_PARALLEL: 8, BASE58_RE: /^r/,
    localStorage: { getItem: k => data.get(k) || null, setItem: (k, v) => { writes.push(k); data.set(k, v); } },
    today: () => '2026-09-23', n: v => Number(v) || 0, drops: v => Number(v) / 1e6,
    getTxWindow: () => range, getActiveWatchlist: () => [{ address, label: 'TEST' }],
    $: () => ({ value: '200' }), log: x => logs.push(x), elog: (k, e) => logs.push(k + ':' + e.message),
    logTick: (k, x) => logs.push(x), shadowSay() {}, shadowProgress() {}, renderWallets() {}, setBar() {}, setText() {},
    _quotaHold: async () => false, _noteQuota() {}, pageDepthFor: () => 1, getWalletGroup: () => 'whale',
    SW_RUN_ANCHOR: ra,
    xrpl: async (ws, req) => {
      xrplCalls.push(req.command);
      if (req.command === 'account_info') return { account_data: { Balance: '1000000' } };
      if (req.command === 'ledger') return { validated: true, ledger_index: anchor, ledger: { ledger_index: String(anchor), close_time: Date.parse(close) / 1000 - 946684800 } };
      if (req.command === 'server_info') return { info: { complete_ledgers: '32570-' + anchor } };
      return { transactions: [] };
    },
    fetch: async (url, init) => {
      if (url === '/api/delta?action=policy') {
        policyCalls++;
        if (kind === 'policy-network') throw new TypeError('Failed to fetch');
        return json({ environment, direct_fallback_allowed: environment === 'production',
          preview_read_only: environment !== 'production', live_acquisition_disabled: environment !== 'production' });
      }
      assert.equal(url, '/api/delta');
      assert.equal(JSON.parse(init.body).action, 'run'); attempts++;
      if (kind === 'network') throw new TypeError('Failed to fetch');
      if (kind === 'interrupted') return ndjson({ t: 'start', preview_read_only: true });
      if (kind === 'stream-error') return ndjson({ t: 'error', error: 'arbitrary storage failure', code: 'STORE_BROKEN', preview_read_only: true, live_acquisition_disabled: true });
      if (kind === 'missing') return json({ error: 'PREVIEW_READ_ONLY_SNAPSHOT_UNAVAILABLE', preview_read_only: true, live_acquisition_disabled: true }, 503);
      if (kind === 'typed-503') return json({ error: 'arbitrary storage failure', code: 'STORE_BROKEN', preview_read_only: true, live_acquisition_disabled: true }, 503);
      if (kind === 'plain-503') return json({ error: 'generic failure' }, 503);
      if (kind === 'html-502') return new Response('<html>Bad gateway</html>', { status: 502 });
      if (kind === 'fake-done') return ndjson({ t: 'done', target_wallets: 0, complete_wallets: 0, wallets: [], events: [] });
      const result = snapshot();
      if (kind === 'window-missing') result.window.days_without_shards = ['2026-09-21'];
      return ndjson({ t: 'done', ...result });
    }
  };
  s.window = s;
  // The existing row adapter delegates to proveWallet once an index was
  // accepted. The direct branch calls transport, so the spy can see a leak.
  s.accountTxWindowDepth = async (ws, a) => {
    if (s.state.indexRun) { await s.SW_EVIDENCE_INDEX.proveWallet(s.state.indexRun, a); return []; }
    return (await s.xrpl(ws, { command: 'account_tx', account: a })).transactions;
  };
  vm.createContext(s); vm.runInContext(acquisition, s); vm.runInContext(client, s);
  let error = null;
  try { await s.scanWallets(null); } catch (e) { error = e; }
  return { s, error, attempts, policyCalls, xrplCalls, logs, writes };
}
// Server imports use the real store modules; only the reader is replaced with
// a fail-fast spy, so preview tests need neither ws nor external credentials.
const readerPath = require.resolve('../src/db/xrpl-reader');
const previousReader = require.cache[readerPath];
let readerCalls = 0, storeWrites = 0;
require.cache[readerPath] = { id: readerPath, filename: readerPath, loaded: true, exports: {
  acquireReader() { readerCalls++; throw new Error('TEST: XRPL reader forbidden'); }, releaseReader() {}
} };
const delta = require('../api/delta');
const Store = require('../src/db/github-store'), D = require('../src/db/delta-acquisition');
const roster = require('../src/db/roster'), Archive = require('../src/db/github-archive');
const originals = new Map();
function replace(obj, key, fn) { originals.set([obj, key], obj[key]); obj[key] = fn; }
for (const key of ['commitRun', 'seedGenesis', 'uploadBlob', 'appendJournal', 'clearJournal']) {
  replace(Store, key, () => { storeWrites++; throw new Error('TEST: store write forbidden'); });
}
replace(Archive, 'commitFiles', () => { storeWrites++; throw new Error('TEST: commit forbidden'); });
function response() {
  return { statusCode: 200, body: null, headers: {}, chunks: [],
    setHeader(k, v) { this.headers[k] = v; }, status(c) { this.statusCode = c; return this; },
    json(x) { this.body = x; return this; }, write(x) { this.chunks.push(x); return true; },
    end() { this.body = this.chunks.join(''); return this; } };
}
(async () => {
  for (const kind of ['missing', 'typed-503', 'plain-503', 'html-502', 'network', 'interrupted', 'stream-error', 'fake-done', 'window-missing', 'policy-network']) {
    await test('full acquisition stops preview: ' + kind, async () => {
      const r = await browserCase(kind);
      assert(r.error && r.error.scanIncomplete, kind + ': must stop incomplete');
      assert.equal(r.error.liveAcquisitionDisabled, true);
      assert.deepEqual(r.xrplCalls, [], 'no direct anchor, balance or transaction read after failure');
      assert.equal(r.s.state.indexRun, null); assert.equal(r.s.state.runAnchor, null);
      assert.equal(r.s.state.txScanCoverage, null); assert.equal(r.s.state.pack, null);
      assert.deepEqual(r.writes, []);
      assert(!r.logs.some(x => x.includes('anchor undefined') || x.includes('0/0 proved')));
      if (kind === 'network' || kind === 'interrupted') assert.equal(r.attempts, 3);
      if (kind === 'policy-network') assert.equal(r.attempts, 0);
      if (kind === 'typed-503' || kind === 'stream-error') {
        assert.equal(r.error.cause.previewReadOnly, true);
        assert.equal(r.error.cause.code, 'STORE_BROKEN');
      }
    });
  }
  await test('valid stored snapshot completes real scan without direct account_tx', async () => {
    const r = await browserCase('valid');
    assert.equal(r.error, null); assert.equal(r.attempts, 1); assert.equal(r.policyCalls, 1);
    assert.equal(r.s.state.indexRun.anchor_ledger, anchor);
    assert(!r.xrplCalls.includes('account_tx'));
    assert.equal(r.s.SW_EVIDENCE_INDEX.metrics().checkpoint_advanced, false);
    const proof = await r.s.SW_EVIDENCE_INDEX.proveWallet(r.s.state.indexRun, address);
    assert.equal(proof.proof.through_ledger, anchor);
  });
  await test('confirmed production retains ordinary fallback', async () => {
    const r = await browserCase('plain-503', 'production');
    assert.equal(r.error, null);
    assert(r.xrplCalls.includes('account_tx'));
  });
  await test('typed preview refusal is terminal even under production policy', async () => {
    const r = await browserCase('typed-503', 'production');
    assert(r.error && r.error.scanIncomplete); assert.deepEqual(r.xrplCalls, []);
  });
  const savedEnv = process.env.VERCEL_ENV;
  try {
    process.env.VERCEL_ENV = 'preview';
    const state = { anchor_ledger: anchor, anchor_close: close, wallets: [{ address, last_proven_ledger: anchor }] };
    let mode = 'valid';
    replace(Store, 'readState', async () => {
      if (mode === 'missing') return { missing: true };
      if (mode === 'store-error') throw new Error('arbitrary store failure');
      return { state, missing: false };
    });
    replace(roster, 'select', () => ({ accounts: [address] }));
    replace(D, 'readReportWindow', async input => {
      assert.equal(input.rows.length, 0); assert.equal(input.window_end_ms, Date.parse(close));
      return { events: [], days: ['2026-09-21', '2026-09-22'], in_window: 0, from_stored: 0,
        days_without_shards: mode === 'shards-missing' ? ['2026-09-21'] : [], provenance: 'OBSERVED' };
    });
    const call = async (input, method = 'POST') => {
      const res = response(); await delta({ method, headers: {}, body: input, query: input }, res); return res;
    };
    await test('policy returns explicit preview mode without acquiring reader/store', async () => {
      mode = 'store-error'; const r = await call({ action: 'policy' }, 'GET');
      assert.equal(r.statusCode, 200); assert.equal(r.body.preview_read_only, true);
      assert.equal(r.body.direct_fallback_allowed, false);
    });
    for (const testMode of ['missing', 'store-error', 'shards-missing']) {
      await test('real API returns typed failure, never done: ' + testMode, async () => {
        mode = testMode;
        const r = await call({ action: 'run', stream: true, window_start_ms: range.startMs, window_end_ms: range.endMs });
        assert.equal(r.statusCode, 503); assert.equal(r.body.preview_read_only, true);
        assert.equal(r.body.live_acquisition_disabled, true);
        assert.equal(r.body.code, 'PREVIEW_READ_ONLY_SNAPSHOT_UNAVAILABLE');
        assert.equal(r.chunks.length, 0);
      });
    }
    await test('missing wallet proof cannot produce success or false coverage', async () => {
      mode = 'valid'; state.wallets[0].last_proven_ledger = anchor - 1;
      const r = await call({ action: 'run', window_start_ms: range.startMs, window_end_ms: range.endMs });
      assert.equal(r.statusCode, 503); state.wallets[0].last_proven_ledger = anchor;
    });
    await test('API serves real stored window and caps it without writing', async () => {
      const r = await call({ action: 'run', stream: true, window_start_ms: range.startMs, window_end_ms: range.endMs });
      assert.equal(r.statusCode, 200);
      const done = JSON.parse(r.chunks[r.chunks.length - 1]);
      assert.equal(done.t, 'done'); assert.equal(done.window.to, close);
      assert.equal(done.xrpl_requests, 0); assert.equal(done.committed, false);
      assert.equal(done.complete_wallets, 1);
    });
    await test('production request validation unaffected', async () => {
      process.env.VERCEL_ENV = 'production';
      const r = await call({ action: 'run', report_id: 'BAD-ID' });
      assert.equal(r.statusCode, 400); assert.equal(r.body.error, 'INVALID_REPORT_ID');
    });
  } finally {
    if (savedEnv === undefined) delete process.env.VERCEL_ENV; else process.env.VERCEL_ENV = savedEnv;
  }
  assert.equal(readerCalls, 0); assert.equal(storeWrites, 0);
  console.log('ALL ' + passed + ' PREVIEW ACQUISITION CHECKS PASS; reader calls=0, store writes=0');
})().catch(e => { console.error(e.stack || e); process.exitCode = 1; }).finally(() => {
  for (const [[obj, key], value] of originals) obj[key] = value;
  if (previousReader) require.cache[readerPath] = previousReader; else delete require.cache[readerPath];
});
