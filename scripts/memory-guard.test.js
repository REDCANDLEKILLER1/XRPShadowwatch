#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const assert = require('assert');
const vm = require('vm');

const ROOT = path.resolve(__dirname, '..');
const SRC = fs.readFileSync(path.join(ROOT, 'src/brief/46-memory-guard-20260923.js'), 'utf8');

function makeStore(initial) {
  const map = new Map(Object.entries(initial || {}));
  const store = {
    getItem(k) { return map.has(k) ? map.get(k) : null; },
    setItem(k, v) { map.set(k, String(v)); },
    removeItem(k) { map.delete(k); },
    _map: map
  };
  return store;
}

function runGuard(store, extras) {
  const sandbox = {
    window: {},
    localStorage: store,
    Storage: function Storage() {},
    state: extras && extras.state || {},
    log: function () {},
    loadBlackboxHistory: extras && extras.loadBlackboxHistory,
    detectCoordination: extras && extras.detectCoordination,
    saveBlackboxSnapshot: extras && extras.saveBlackboxSnapshot,
    console: console
  };
  sandbox.window = sandbox;
  sandbox.Storage.prototype = {};
  sandbox.Storage.prototype.setItem = function (k, v) { store.setItem(k, v); };
  sandbox.Storage.prototype.getItem = function (k) { return store.getItem(k); };
  vm.createContext(sandbox);
  vm.runInContext(SRC, sandbox);
  return sandbox;
}

let passed = 0;
function test(name, fn) {
  fn();
  passed++;
  console.log('ok  ' + name);
}

const briefSnap = [{ ts: 1, date: '2026-09-22', large_transfers: [{ from: 'rA', to: 'rB' }], wallets: [] }];

test('empty in-memory history falls back to v34 store', () => {
  const store = makeStore({
    shadowwatch_blackbox_v34: JSON.stringify(briefSnap)
  });
  const sb = runGuard(store, {
    loadBlackboxHistory: function () { return []; },
    detectCoordination: function (h) {
      return { snapshots_analyzed: (h || []).length, pairs: [] };
    }
  });
  const out = sb.detectCoordination([]);
  assert.strictEqual(out.snapshots_analyzed, 1);
});

test('refuses empty array overwrite of v34', () => {
  const store = makeStore({
    shadowwatch_blackbox_v34: JSON.stringify(briefSnap)
  });
  const sb = runGuard(store, {
    loadBlackboxHistory: function () { return briefSnap.slice(); }
  });
  sb.localStorage.setItem('shadowwatch_blackbox_v34', JSON.stringify([]));
  const kept = JSON.parse(store.getItem('shadowwatch_blackbox_v34'));
  assert.strictEqual(kept.length, 1);
});

test('probe reports both black box keys separately', () => {
  const store = makeStore({
    shadowwatch_blackbox_v34: JSON.stringify(briefSnap),
    XRPMAN_BLACKBOX_V2: JSON.stringify([{ ts: 9 }, { ts: 8 }, { ts: 7 }])
  });
  const sb = runGuard(store, { loadBlackboxHistory: function () { return []; } });
  const p = sb.SW_MEMORY_GUARD.probe();
  assert.strictEqual(p.brief_blackbox_v34, 1);
  assert.strictEqual(p.outer_blackbox_v2, 3);
});

test('after save, coordination is recomputed from store', () => {
  const store = makeStore({
    shadowwatch_blackbox_v34: JSON.stringify(briefSnap)
  });
  const state = {};
  const sb = runGuard(store, {
    state: state,
    loadBlackboxHistory: function () {
      const raw = store.getItem('shadowwatch_blackbox_v34');
      return raw ? JSON.parse(raw) : [];
    },
    detectCoordination: function (h) {
      return { snapshots_analyzed: (h || []).length, pairs: [] };
    },
    saveBlackboxSnapshot: function () {
      const cur = JSON.parse(store.getItem('shadowwatch_blackbox_v34'));
      cur.push({ ts: 2, date: '2026-09-23', large_transfers: [], wallets: [] });
      store.setItem('shadowwatch_blackbox_v34', JSON.stringify(cur));
    }
  });
  const pack = { ts: 2, date: '2026-09-23', large_transfers: [], wallets: [] };
  sb.saveBlackboxSnapshot(pack);
  assert.strictEqual(pack.coordination.snapshots_analyzed, 2);
  assert.strictEqual(state.coordination.snapshots_analyzed, 2);
});


test('save one Brief snapshot persists v34 and detectCoordination reports one', () => {
  const store = makeStore({
    XRPMAN_BLACKBOX_V2: JSON.stringify([{ ts: 99 }]),
    shadowwatch_snapshot_v30: JSON.stringify([{ ts: 88 }])
  });
  const state = {};
  const sb = runGuard(store, {
    state: state,
    loadBlackboxHistory: function () { return []; },
    detectCoordination: function (h) {
      return { snapshots_analyzed: (h || []).length, pairs: [] };
    },
    // Reproduce the live defect: the underlying save advances Outer/legacy,
    // but does not write Brief v34.
    saveBlackboxSnapshot: function () {
      store.setItem('XRPMAN_BLACKBOX_V2', JSON.stringify([{ ts: 99 }, { ts: 100 }]));
      store.setItem('shadowwatch_snapshot_v30', JSON.stringify([{ ts: 88 }, { ts: 100 }]));
    }
  });
  const pack = { ts: 100, date: '2026-09-23', large_transfers: [], wallets: [] };
  sb.saveBlackboxSnapshot(pack);
  const v34 = JSON.parse(store.getItem('shadowwatch_blackbox_v34'));
  assert.strictEqual(v34.length, 1);
  assert.strictEqual(state.coordination.snapshots_analyzed, 1);
  assert.strictEqual(pack.coordination.snapshots_analyzed, 1);
});

test('Outer and legacy boxes are never counted as Brief coordination', () => {
  const store = makeStore({
    XRPMAN_BLACKBOX_V2: JSON.stringify([{ ts: 9 }, { ts: 8 }, { ts: 7 }]),
    shadowwatch_snapshot_v30: JSON.stringify([{ ts: 6 }, { ts: 5 }])
  });
  const sb = runGuard(store, {
    loadBlackboxHistory: function () { return []; },
    detectCoordination: function (h) {
      return { snapshots_analyzed: (h || []).length, pairs: [] };
    }
  });
  assert.strictEqual(sb.detectCoordination([]).snapshots_analyzed, 0);
});


test('ten 150k-tx saves stay compact and preserve ten snapshot counts', () => {
  const store = makeStore();
  const state = {};
  let legacyCalls = 0;
  const sb = runGuard(store, {
    state,
    loadBlackboxHistory: function () { return []; },
    detectCoordination: function (h) {
      return { snapshots_analyzed: (h || []).length, pairs: [] };
    },
    saveBlackboxSnapshot: function () { legacyCalls++; }
  });

  const hugeTxs = Array.from({ length: 150000 }, (_, i) => ({ hash: 'H' + i, amount: i }));
  const large = Array.from({ length: 80 }, (_, i) => ({
    from: 'rFROM' + i, to: 'rTO' + i, sender_label: 'S' + i, receiver_label: 'R' + i,
    amount: 100000000 - i, classification: 'TEST', hash: 'L' + i,
    date: '2026-09-26T12:' + String(i % 60).padStart(2, '0') + ':00.000Z'
  }));

  for (let i = 0; i < 10; i++) {
    const pack = {
      report_id: 'SW-20260926-T' + String(i).padStart(4, '0'),
      scan_id: 'SC-' + i,
      date: '2026-09-26',
      data_as_of_utc: '15:' + String(i).padStart(2, '0') + ':00 UTC',
      txs: hugeTxs,
      tx_24h_count: hugeTxs.length,
      wallets_checked: 423,
      large_transfers: large
    };
    sb.saveBlackboxSnapshot(pack);
  }

  const raw = store.getItem('shadowwatch_blackbox_v34');
  assert(raw, 'v34 was not persisted');
  assert(raw.length < 200 * 1024, 'v34 exceeded 200KB: ' + raw.length);
  assert.doesNotThrow(() => JSON.stringify(JSON.parse(raw)));
  const v34 = JSON.parse(raw);
  assert.strictEqual(v34.length, 10);
  assert.strictEqual(state.coordination.snapshots_analyzed, 10);
  assert.strictEqual(legacyCalls, 0, 'legacy/core saver must be bypassed');
  assert(v34.every(s => !Object.prototype.hasOwnProperty.call(s, 'txs')), 'full tx arrays leaked into v34');
  assert(v34.every(s => !Object.prototype.hasOwnProperty.call(s, 'wallets')), 'full wallet arrays leaked into v34');
  assert(v34.every(s => (s.large_transfers || []).length <= 24), 'large-transfer cap was not enforced');
  assert(v34.every(s => s.counts && s.counts.transactions === 150000), 'transaction count was not retained');
  assert(v34.every(s => s.flow_summary && typeof s.flow_summary === 'object'), 'compact flow summary missing');
});

console.log('\n' + passed + ' memory-guard tests passed');
