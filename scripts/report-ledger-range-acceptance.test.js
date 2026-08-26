#!/usr/bin/env node
'use strict';

const fs = require('fs');
const vm = require('vm');
const path = require('path');
const ROOT = path.resolve(__dirname, '..');
const SRC = path.join(ROOT, 'src/brief/17-report-scan-tuning-20260816.js');
const code = fs.readFileSync(SRC, 'utf8');
const RIPPLE_EPOCH = 946684800;
const rippleSec = iso => Math.floor(new Date(iso).getTime() / 1000) - RIPPLE_EPOCH;

let mode = 'bounded';
let ledgerCalls = [];
let accountCalls = [];
const logs = [];

const ctx = {
  window: {},
  console,
  WATCHLIST: [],
  KNOWN: {},
  state: { wallets: [] },
  localStorage: {
    _d: Object.create(null),
    getItem(k) { return Object.prototype.hasOwnProperty.call(this._d, k) ? this._d[k] : null; },
    setItem(k, v) { this._d[k] = String(v); },
    removeItem(k) { delete this._d[k]; }
  },
  addDiscoveredWallet() {},
  pageDepthFor() { return 1; },
  accountTxWindowDepth: async () => [],
  scanWallets: async () => null,
  buildPack: () => ({}),
  buildShadowWatchEvidenceBundle: undefined,
  buildMasterPaste: undefined,
  buildXRPMainReport: undefined,
  log(s) { logs.push(String(s)); },
  rip(sec) { return new Date((Number(sec) + RIPPLE_EPOCH) * 1000).toISOString(); },
  xrpl: async (_ws, req) => {
    if (req.command === 'ledger') {
      ledgerCalls.push({ ...req });
      if (mode === 'fallback') throw new Error('probe unavailable');
      if (req.ledger_index === 'validated') {
        return { ledger_index: 100000, ledger: { ledger_index: 100000, close_time: rippleSec('2026-08-26T13:00:00Z') } };
      }
      if (Number(req.ledger_index) === 97900) {
        // Deliberately TOO RECENT: proves the estimator itself is not trusted.
        return { ledger_index: 97900, ledger: { ledger_index: 97900, close_time: rippleSec('2026-08-26T12:10:00Z') } };
      }
      if (Number(req.ledger_index) === 96550) {
        return { ledger_index: 96550, ledger: { ledger_index: 96550, close_time: rippleSec('2026-08-26T11:50:00Z') } };
      }
      throw new Error('unexpected ledger probe ' + req.ledger_index);
    }
    if (req.command === 'account_tx') {
      accountCalls.push({ ...req });
      if (mode === 'fallback') return { transactions: [], marker: null };
      return {
        transactions: [
          { tx_json: { date: rippleSec('2026-08-26T11:55:00Z') }, ledger_index: 96600 },
          { tx_json: { date: rippleSec('2026-08-26T12:30:00Z') }, ledger_index: 99000 }
        ],
        marker: null
      };
    }
    throw new Error('unexpected command ' + req.command);
  }
};
ctx.window = ctx;
vm.createContext(ctx);
vm.runInContext(code, ctx, { filename: SRC });

let pass = 0, fail = 0;
function check(name, cond, detail) {
  if (cond) { pass++; console.log('PASS', name); }
  else { fail++; console.log('FAIL', name, detail === undefined ? '' : detail); }
}

(async () => {
  const start = new Date('2026-08-26T12:00:00Z').getTime();
  const end = new Date('2026-08-26T13:00:00Z').getTime();
  const rows = await ctx.accountTxWindowDepth({}, 'rBounded', start, end, 200);
  const p = ctx.accountTxWindowDepth._proofByAccount.rBounded;

  check('candidate is refined older until close_time proves coverage',
    ledgerCalls.some(r => r.ledger_index === 97900) && ledgerCalls.some(r => r.ledger_index === 96550), ledgerCalls);
  check('account_tx receives real ledger_index_min',
    accountCalls[0] && accountCalls[0].ledger_index_min === 96550 && accountCalls[0].ledger_index_max === -1, accountCalls[0]);
  check('timestamp filter remains authoritative', rows.length === 1 && rows[0].ledger_index === 99000, rows);
  check('bounded marker exhaustion proves requested boundary, not account history exhaustion',
    p.status === 'COMPLETE' && p.boundary_reached === true && p.history_exhausted === false, p);
  check('proof records the server-enforced range',
    p.range_bound_proven === true && p.ledger_index_min === 96550 && /11:50:00/.test(p.range_bound_close_time || ''), p);

  const before = ledgerCalls.length;
  await ctx.accountTxWindowDepth({}, 'rCached', start, end, 200);
  check('range proof is cached once per requested start', ledgerCalls.length === before, ledgerCalls.length - before);

  ctx.state.wallets = [{ status:'CHECKED', address:'rBounded', label:'BOUND', tx_scan:p }];
  const pack = ctx.buildPack();
  const pp = pack.tx_scan_proof && pack.tx_scan_proof[0];
  check('exported tx_scan_proof preserves range fields',
    pp && pp.range_bound_proven === true && pp.ledger_index_min === 96550 && pp.range_bound_close_time === p.range_bound_close_time, pp);

  mode = 'fallback';
  accountCalls = [];
  const start2 = new Date('2026-08-26T10:00:00Z').getTime();
  await ctx.accountTxWindowDepth({}, 'rFallback', start2, end, 200);
  const f = ctx.accountTxWindowDepth._proofByAccount.rFallback;
  check('unprovable range falls back to legacy -1 rather than under-read',
    accountCalls[0] && accountCalls[0].ledger_index_min === -1 && f.range_bound_proven === false, { req: accountCalls[0], proof:f });
  check('legacy fallback keeps history_exhausted semantics',
    f.status === 'COMPLETE' && f.boundary_reached === false && f.history_exhausted === true, f);
  check('range resolution failure is visible in proof/logging',
    /probe unavailable/.test(f.range_bound_reason || '') && logs.some(s => /full retained history/.test(s)), { proof:f, logs });

  console.log('\n' + (fail === 0 ? 'ALL ' + pass + ' LEDGER-RANGE CHECKS PASS' : fail + ' FAILED of ' + (pass + fail)));
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error(e); process.exit(2); });
