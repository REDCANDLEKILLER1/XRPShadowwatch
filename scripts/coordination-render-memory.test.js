#!/usr/bin/env node
'use strict';
// Actual production detector + renderer + saver; no replacement detector.
const fs = require('fs'), path = require('path'), vm = require('vm'), assert = require('assert');
const root = path.join(__dirname, '..');
const core = fs.readFileSync(path.join(root, 'src/brief/02-core.js'), 'utf8');
const guard = fs.readFileSync(path.join(root, 'src/brief/46-memory-guard-20260923.js'), 'utf8');
function segment(a, b) {
  const i = core.indexOf(a), j = core.indexOf(b, i);
  assert(i >= 0 && j > i, 'actual source boundaries changed: ' + a);
  return core.slice(i, j);
}
const functions = segment('function saveBlackboxSnapshot(p)', 'function clearBlackbox()') +
  segment('function detectCoordination(history)', '// ── F. TOP WALLET DISCOVERY') +
  segment('function renderCoordinationMemory(coord)', '// Normalize risk label');
const key = 'shadowwatch_blackbox_v34';
function context(rows, outer) {
  class Storage {
    constructor(initial) { this.data = new Map(Object.entries(initial || {})); }
    getItem(k) { return this.data.get(String(k)) ?? null; }
    setItem(k, v) { this.data.set(String(k), String(v)); }
    removeItem(k) { this.data.delete(String(k)); }
  }
  const storage = new Storage({ [key]: JSON.stringify(rows), XRPMAN_BLACKBOX_V2: JSON.stringify(outer || []) });
  const logs = [];
  const s = { Storage, localStorage: storage, sessionStorage: new Storage(), state: { offers: [] },
    log: x => logs.push(x), elog: (k, e) => logs.push(k + ':' + e.message), console };
  s.window = s;
  vm.createContext(s);
  vm.runInContext("const BLACKBOX_STORE='shadowwatch_blackbox_v34'; const BLACKBOX_MAX_SNAPSHOTS=30;" +
    'const COORD_MIN_SNAPSHOTS=5, COORD_MIN_COOCCURRENCES=3, PRICE_BUCKET_SIZE=0.05; const n=v=>Number(v)||0;' + functions, s);
  vm.runInContext(guard, s);
  return { s, storage, logs };
}
const snaps = n => Array.from({ length: n }, (_, i) => ({ ts: i + 1, wallets: [], large_transfers: [], offers: [] }));
let passed = 0;
function test(name, fn) { fn(); console.log('PASS ' + name); passed++; }
for (let n = 0; n <= 5; n++) test('real detector/renderer counts ' + n, () => {
  const { s } = context(snaps(n));
  const coord = s.detectCoordination(s.loadBlackboxHistory());
  assert.equal(coord.snapshots_analyzed, n);
  const rendered = s.renderCoordinationMemory(coord);
  if (n < 5) assert.equal(rendered.gating, 'Need 5+ snapshots. Current: ' + n + '.');
  else assert(rendered.lines.join(' ').includes('5 snapshots'));
});
test('non-array detector input returns explicit zero', () => {
  const { s } = context([]);
  assert.equal(s.detectCoordination(null).snapshots_analyzed, 0);
});
for (const outer of [[{ ts: 1 }], [snaps(1)[0], { ts: 2 }], snaps(4)]) {
  test('Outer records are never adopted or overwritten', () => {
    const { s, storage } = context([], outer), before = storage.getItem('XRPMAN_BLACKBOX_V2');
    assert.equal(s.SW_MEMORY_GUARD.readBriefHistory().length, 0);
    s.saveBlackboxSnapshot({ date: '2026-09-23' });
    assert.equal(JSON.parse(storage.getItem(key)).length, 1);
    assert.equal(storage.getItem('XRPMAN_BLACKBOX_V2'), before);
  });
}
test('mixed-shape Brief history is refused and preserved', () => {
  const { s, storage, logs } = context([snaps(1)[0], { ts: 2 }]);
  const before = storage.getItem(key);
  assert.equal(s.loadBlackboxHistory().length, 0);
  s.saveBlackboxSnapshot({});
  assert.equal(storage.getItem(key), before);
  assert(logs.some(x => x.includes('BRIEF_HISTORY_INVALID')));
});
test('empty overwrite guarded; session storage and operator clear unaffected', () => {
  const { s, storage } = context(snaps(3));
  storage.setItem(key, '[]'); assert.equal(JSON.parse(storage.getItem(key)).length, 3);
  s.sessionStorage.setItem(key, '[]'); assert.equal(s.sessionStorage.getItem(key), '[]');
  storage.removeItem(key); assert.equal(storage.getItem(key), null);
});
test('actual pre-render block persists one compact snapshot; rerender is read-only', () => {
  const { s, storage } = context(snaps(29));
  s.p = { date: '2026-09-23', wallet_results: [], large_transfers: [], heavy_unused_field: 'must not be persisted' };
  const prepare = segment('    // Resolve from the actually persisted compact snapshot', '    // v3.26-hotfix3: After all intelligence stages');
  vm.runInContext(prepare, s);
  assert.equal(s.p.coordination.snapshots_analyzed, 30);
  const before = storage.getItem(key), sealed = JSON.stringify(s.p);
  assert(!before.includes('heavy_unused_field'));
  Object.freeze(s.p.coordination); Object.freeze(s.p);
  for (let i = 0; i < 3; i++) s.renderCoordinationMemory(s.p.coordination);
  assert.equal(storage.getItem(key), before); assert.equal(JSON.stringify(s.p), sealed);
  s.saveBlackboxSnapshot({ date: '2026-09-24' });
  const saved = JSON.parse(storage.getItem(key));
  assert.equal(saved.length, 30); assert(saved.every(x => Array.isArray(x.wallets)));
  assert.equal(JSON.stringify(s.p), sealed, 'save must not mutate finalized pack');
});
test('ordering: coverage gate then persist then render then seal then archive; no late save', () => {
  const gate = core.indexOf('    scanSucceeded = !!(p.tx_scan_coverage');
  const save = core.indexOf('    saveBlackboxSnapshot(p);', gate);
  const render = core.indexOf('    report = buildPublicReport(p);', gate);
  const seal = core.indexOf('    seal = await buildEvidenceSeal(p, report, bundle);', render);
  const archive = core.indexOf('    await archiveSealedReport(p, seal);', seal);
  assert(gate < save && save < render && render < seal && seal < archive);
  assert.equal(core.indexOf('    saveBlackboxSnapshot(p);', archive), -1);
  assert(core.includes('renderCoordinationMemory(state.coordination || p.coordination)'));
  assert(!guard.includes('buildXRPMainReport ='));
  assert(!guard.includes('saveBlackboxSnapshot ='));
});
console.log('ALL ' + passed + ' REAL COORDINATION/MEMORY CHECKS PASS');
