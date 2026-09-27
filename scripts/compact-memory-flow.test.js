#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const assert = require('assert');
const vm = require('vm');

const ROOT = path.resolve(__dirname, '..');
const SRC = fs.readFileSync(path.join(ROOT, 'src/brief/15-flow-analysis.js'), 'utf8');

const history = Array.from({ length: 7 }, (_, i) => ({
  schema: 'shadowwatch-brief-snapshot/1',
  ts: i + 1,
  date: '2026-09-' + String(20 + i).padStart(2, '0'),
  xrp_price: 1.50 + i * 0.01,
  xrp_delta_24h_pct: i,
  flow_summary: {
    flows: {
      exchange: (i + 1) * 1000,
      whale: -(i + 1) * 500
    },
    exchange_in: (i + 1) * 1500,
    exchange_out: -(i + 1) * 500,
    wallets_seen: 423
  },
  counts: { wallets: 423, transactions: 150000, large_transfers: 262 },
  large_transfers: []
}));

const sandbox = {
  window: {},
  console,
  loadBlackboxHistory() { return history; },
  KNOWN: {},
  getWalletGroup() { return 'whale'; }
};
sandbox.window = sandbox;
vm.createContext(sandbox);
vm.runInContext(SRC, sandbox);

const series = sandbox.buildFlowSeries(history);
assert.strictEqual(series.length, 7);
assert.strictEqual(series[0].wallets_seen, 423);
assert.strictEqual(series[0].exchange_in, 1500);
assert.strictEqual(series[0].exchange_out, -500);
assert.strictEqual(series[0].net_exchange_flow, 1000);
assert.strictEqual(series[0].flows.whale, -500);

const analysis = sandbox.analyzeFlow(series);
assert.strictEqual(analysis.points, 7);
assert.strictEqual(analysis.usable, true);
assert.strictEqual(analysis.exchange_in_total, 42000);
assert.strictEqual(analysis.exchange_out_total, -14000);

console.log('ok  compact v34 flow summaries preserve Section 9b inputs');
