#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const assert = require('assert');
const vm = require('vm');

const ROOT = path.resolve(__dirname, '..');
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
  const state = (opts && opts.state) || { offers: [] };
  const seen = [];
  const sandbox = {
    window: {},
    localStorage: store,
    state,
    log() {},
    Date,
    console,
    detectCoordination(history) {
      seen.push(history);
      if (history.length < 5) {
        // Mirror core's current sub-threshold shape: no snapshots_analyzed.
        return { pairs: [], summary: 'Need 5+ snapshots — current: ' + history.length };
      }
      return {
        pairs: [{ label_a: 'A', label_b: 'B', score: 2 }],
        snapshots_analyzed: history.length,
        summary: 'ready'
      };
    },
    buildXRPMainReport(p) {
      const n = p && p.coordination && p.coordination.snapshots_analyzed;
      return '11. COORDINATION MEMORY\n• Need 5+ snapshots. Current: ' + Number(n || 0) + '.';
    }
  };
  sandbox.window = sandbox;
  vm.createContext(sandbox);
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

testCase('one persisted Brief snapshot plus current report renders Current: 2', () => {
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

testCase('render projection does not persist or count Outer memory', () => {
  const store = makeStore({
    shadowwatch_blackbox_v34: JSON.stringify([{ ts: 1, large_transfers: [], offers: [] }]),
    XRPMAN_BLACKBOX_V2: JSON.stringify(new Array(20).fill({ ts: 9 })),
    shadowwatch_snapshot_v30: JSON.stringify(new Array(7).fill({ ts: 8 }))
  });
  const before = store.getItem('shadowwatch_blackbox_v34');
  const { sandbox } = runPatch(store, { state: { offers: [] } });
  sandbox.buildXRPMainReport({ date: '2026-09-23', large_transfers: [], wallet_results: [] });
  assert.strictEqual(store.getItem('shadowwatch_blackbox_v34'), before,
    'render patch must not write the Brief store');
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

console.log('\n' + passed + ' coordination-render tests passed');
