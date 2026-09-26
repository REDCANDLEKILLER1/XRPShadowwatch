#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const assert = require('assert');
const vm = require('vm');

const ROOT = path.resolve(__dirname, '..');
const MEMORY_SRC = fs.readFileSync(path.join(ROOT, 'src/brief/46-memory-guard-20260923.js'), 'utf8');
const SRC = fs.readFileSync(path.join(ROOT, 'src/brief/48-coordination-render-20260923.js'), 'utf8');
const CORE = fs.readFileSync(path.join(ROOT, 'src/brief/02-core.js'), 'utf8');

function makeStore(initial) {
  const map = new Map(Object.entries(initial || {}));
  return {
    getItem(k) { return map.has(k) ? map.get(k) : null; },
    setItem(k, v) { map.set(k, String(v)); },
    removeItem(k) { map.delete(k); },
    _map: map
  };
}

function runPatch(store, opts) {
  const state = (opts && opts.state) || { offers: [], txs: [] };
  const seen = [];
  const sandbox = {
    window: {},
    localStorage: store,
    Storage: function Storage() {},
    state,
    log() {},
    Date,
    console
  };
  sandbox.window = sandbox;
  sandbox.Storage.prototype = {};
  sandbox.Storage.prototype.setItem = function (k, v) { store.setItem(k, v); };
  sandbox.Storage.prototype.getItem = function (k) { return store.getItem(k); };
  sandbox.loadBlackboxHistory = function () {
    const raw = store.getItem('shadowwatch_blackbox_v34');
    return raw ? JSON.parse(raw) : [];
  };
  sandbox.detectCoordination = function (history) {
    seen.push(history);
    if (opts && opts.throwCoordination) throw new RangeError('Maximum call stack size exceeded');
    if (history.length < 5) {
      return { pairs: [], summary: 'Need 5+ snapshots — current: ' + history.length };
    }
    return {
      pairs: [{ label_a: 'A', label_b: 'B', score: 2 }],
      snapshots_analyzed: history.length,
      summary: 'ready'
    };
  };
  sandbox.saveBlackboxSnapshot = function () {
    throw new Error('legacy saver must be bypassed');
  };
  sandbox.summarizePatternMemory = function () {
    if (opts && opts.throwPattern) throw new RangeError('Maximum call stack size exceeded');
    return { lines: ['pattern ok'], snapCount: 1 };
  };
  sandbox.renderCoordinationMemory = function (coord) {
    if (!coord) return { lines: [], gating: 'Need 5+ snapshots. Current: 0.' };
    const n = Number(coord.snapshots_analyzed || 0);
    if (n < 5) return { lines: [], gating: 'Need 5+ snapshots. Current: ' + n + '.' };
    return { lines: ['• ' + n + ' snapshots analyzed.'], gating: null };
  };
  sandbox.buildXRPMainReport = function (p) {
    const out = sandbox.renderCoordinationMemory((state && state.coordination) || (p && p.coordination));
    const line = out.lines && out.lines.length ? out.lines.join('\n') : ('• ' + out.gating);
    return '11. COORDINATION MEMORY\n' + line;
  };

  vm.createContext(sandbox);
  vm.runInContext(MEMORY_SRC, sandbox);
  vm.runInContext(SRC, sandbox);
  return { sandbox, state, seen };
}

let passed = 0;
function testCase(name, fn) {
  fn();
  passed++;
  console.log('ok  ' + name);
}

testCase('core renders structured report before persisting this scan', () => {
  const render = CORE.indexOf('const mainReport = finalizeReportPresentation(buildXRPMainReport(p), p, true);');
  const save = CORE.indexOf('saveBlackboxSnapshot(p);');
  assert(render >= 0, 'structured report render call not found');
  assert(save >= 0, 'black box save call not found');
  assert(render < save, 'test premise changed: save no longer follows report render');
  assert(CORE.includes('renderCoordinationMemory(state.coordination || p.coordination)'),
    'section 11 coordination render boundary not found');
});

testCase('one persisted Brief snapshot is saved before Section 11 and renders Current: 2', () => {
  const persisted = [{ ts: 1, date: '2026-09-23', large_transfers: [], offers: [] }];
  const store = makeStore({
    shadowwatch_blackbox_v34: JSON.stringify(persisted),
    XRPMAN_BLACKBOX_V2: JSON.stringify(new Array(12).fill({ ts: 99 }))
  });
  const { sandbox, seen } = runPatch(store, { state: { offers: [] } });
  const pack = {
    date: '2026-09-23',
    large_transfers: [],
    wallet_results: []
  };
  const out = sandbox.buildXRPMainReport(pack);
  assert(out.includes('Current: 2.'), out);
  assert.strictEqual(pack.coordination.snapshots_analyzed, 2);
  assert.strictEqual(seen[0].length, 2);
});

testCase('render persists only Brief memory and never counts Outer memory', () => {
  const store = makeStore({
    shadowwatch_blackbox_v34: JSON.stringify([{ ts: 1, large_transfers: [], offers: [] }]),
    XRPMAN_BLACKBOX_V2: JSON.stringify(new Array(20).fill({ ts: 9 })),
    shadowwatch_snapshot_v30: JSON.stringify(new Array(7).fill({ ts: 8 }))
  });
  const { sandbox } = runPatch(store, { state: { offers: [], txs: [] } });
  sandbox.buildXRPMainReport({ report_id: 'SW-20260926-ABCDE', date: '2026-09-26', large_transfers: [], wallet_results: [] });
  const v34 = JSON.parse(store.getItem('shadowwatch_blackbox_v34'));
  assert.strictEqual(v34.length, 2, 'current Brief snapshot must be persisted before render');
  assert.strictEqual(sandbox.state.coordination.snapshots_analyzed, 2,
    'Outer/legacy memory must not contribute to Brief coordination count');
});

testCase('the fifth scan reaches the coordination detector as five snapshots', () => {
  const persisted = [1,2,3,4].map(ts => ({ ts, large_transfers: [], offers: [] }));
  const store = makeStore({ shadowwatch_blackbox_v34: JSON.stringify(persisted) });
  const { sandbox, seen } = runPatch(store, { state: { offers: [] } });
  const pack = { date: '2026-09-23', large_transfers: [], wallet_results: [] };
  sandbox.buildXRPMainReport(pack);
  assert.strictEqual(seen[0].length, 5);
  assert.strictEqual(pack.coordination.snapshots_analyzed, 5);
  assert.strictEqual(pack.coordination.pairs.length, 1);
});

testCase('rolling cap stays 30 at render time', () => {
  const persisted = Array.from({ length: 30 }, (_, i) => ({ ts: i + 1, large_transfers: [], offers: [] }));
  const store = makeStore({ shadowwatch_blackbox_v34: JSON.stringify(persisted) });
  const { sandbox, seen } = runPatch(store, { state: { offers: [] } });
  sandbox.buildXRPMainReport({ date: '2026-09-23', large_transfers: [], wallet_results: [] });
  assert.strictEqual(seen[0].length, 30);
  assert.strictEqual(sandbox.state.coordination.snapshots_analyzed, 30);
});


testCase('coordination stack overflow fails open and preserves transaction evidence', () => {
  const persisted = [1,2,3,4].map(ts => ({ ts, date: '2026-09-25', large_transfers: [] }));
  const store = makeStore({ shadowwatch_blackbox_v34: JSON.stringify(persisted) });
  const txs = Array.from({ length: 150000 }, (_, i) => ({ hash: 'T' + i }));
  const { sandbox, state } = runPatch(store, { state: { offers: [], txs }, throwCoordination: true });
  const before = state.txs;
  const out = sandbox.buildXRPMainReport({
    report_id: 'SW-20260926-STACK',
    date: '2026-09-26',
    txs,
    tx_24h_count: txs.length,
    wallets_checked: 423,
    large_transfers: []
  });
  assert(out.includes('COORDINATION_UNAVAILABLE'), out);
  assert.strictEqual(state.txs, before, 'state.txs reference changed');
  assert.strictEqual(state.txs.length, 150000, 'transaction evidence was wiped');
  assert.strictEqual(JSON.parse(store.getItem('shadowwatch_blackbox_v34')).length, 5);
});

testCase('pattern-memory stack overflow is converted to a public-safe unavailable line', () => {
  const store = makeStore();
  const { sandbox } = runPatch(store, { state: { offers: [], txs: [] }, throwPattern: true });
  const out = sandbox.summarizePatternMemory({});
  assert(out.lines.join(' ').includes('PATTERN_MEMORY_UNAVAILABLE'));
});

console.log('\n' + passed + ' coordination-render tests passed');
