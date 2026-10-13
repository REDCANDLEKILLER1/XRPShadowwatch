#!/usr/bin/env node
'use strict';
// Offline adapter tests. No real GitHub/object-store client is used.
const assert = require('assert/strict');
const zlib = require('zlib');
const Store = require('../src/db/github-store');
const D = require('../src/db/delta-acquisition');
const State = require('../src/db/evidence-state');
const T = require('../src/db/transactions');
const X = require('../src/db/evidence-export');

let passed = 0;
function check(name, fn) {
  return Promise.resolve().then(fn).then(() => { passed++; console.log('  PASS  ' + name); });
}
const day = '2026-10-13';
const close = day + 'T12:00:00.000Z';
const hash = n => String(n).padStart(64, 'a');
function row(n, opts = {}) {
  return {
    hash: hash(n), ledger_index: 100 + n, close_time_ms: Date.parse(close), close_time_iso: close,
    tx_type: 'Payment', tx_result: 'tesSUCCESS', validated: true,
    from_account: 'rSender', to_account: 'rReceiver', amount_drops: String(n), currency: 'XRP',
    evidence: {}, observed_via: opts.via || ['rWatched'],
    raw_tx: { hash: hash(n), Account: 'rSender', Destination: 'rReceiver', TransactionType: 'Payment' },
    raw_meta: { TransactionResult: 'tesSUCCESS', AffectedNodes: [] }, ...opts
  };
}
function stage(rows) { const s = new D.Stage({ chunkBytes: 100 }); for (const r of rows) s.ingest(r); return s; }
function decode(bytes) { return zlib.gunzipSync(bytes).toString('utf8').split('\n').filter(Boolean).map(JSON.parse); }
function records(built, kind) {
  return Object.entries(built.files).filter(([p]) => p.includes('/' + kind + '.')).flatMap(([, b]) => decode(b));
}
function noNetwork() { throw new Error('UNEXPECTED_LEGACY_OR_NETWORK_CALL'); }

(async () => {
  await check('disabled routing keeps the legacy state read and positional readers', async () => {
    const state = State.genesis([{ address: 'rWatched', scan_coverage_through: 100 }], { anchor_ledger: 100 });
    const calls = [];
    const gh = async (method, path) => {
      calls.push({ method, path });
      return { content: Buffer.from(State.serialize(state)).toString('base64') };
    };
    const deps = { env: { SHADOWWATCH_EVIDENCE_TOKEN: 'offline-fixture' }, gh };
    assert.equal(Store.isBounded(deps), false);
    assert.deepEqual((await Store.readState(deps)).state, state);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].method, 'GET');
    assert.match(calls[0].path, /^\/contents\/evidence\/state\/latest\.json\?ref=/);
    assert.equal(await Store.readFile(gh, 'main', Store.STATE_PATH), State.serialize(state));
    assert.deepEqual(await Store.readBytes(gh, 'main', Store.STATE_PATH), Buffer.from(State.serialize(state)));
  });

  const signatures = {
    readState: [], readPinnedState: [], readJournal: [],
    readDays: [[day]], resolveDayManifests: [[day]], resolveStateAtOrBefore: [Date.parse(close)],
    commitRun: [{}], uploadBlob: [Buffer.from('batch')], seedGenesis: [{}], clearJournal: [{}],
    missingJournalShards: [{}], readJournalRows: [{}], readJournalRowsEach: [{}], appendJournal: [{}, {}]
  };
  for (const [name, leading] of Object.entries(signatures)) {
    await check(name + ' routes injected backend with its complete original arguments', async () => {
      let actual;
      const expected = { name };
      const boundedStore = { [name]: async function (...args) { actual = args; assert.equal(this, boundedStore); return expected; } };
      const deps = { env: {}, boundedStore, gh: noNetwork, sentinel: 'retained' };
      const args = leading.concat([deps]);
      if (name === 'readDays') args.push('participants', { requireManifest: true });
      if (name === 'readJournalRowsEach') args.push(() => {});
      assert.equal(Store.isBounded(deps), true);
      assert.equal(await Store[name](...args), expected);
      assert.deepEqual(actual, args);
      assert.equal(actual[leading.length], deps);
    });
  }

  await check('enabled backend errors cannot fall through to legacy writes', async () => {
    let calls = 0;
    const deps = { env: {}, gh: async () => { calls++; throw new Error('LEGACY'); },
      boundedStore: { commitRun: async () => { throw new Error('INJECTED_BOUNDED_REFUSAL'); } } };
    await assert.rejects(Store.commitRun({}, deps), /INJECTED_BOUNDED_REFUSAL/);
    assert.equal(calls, 0);
  });

  const fresh = [row(2), row(3), row(2, { via: ['rSecond'] })];
  const priorRows = [row(1), row(2, { via: ['rEarlier'] })];
  const priorBuilt = D.buildShards(T.mergeSightings(priorRows), {});
  const prior = { events: records(priorBuilt, 'events'), participants: records(priorBuilt, 'participants'),
    payloads: records(priorBuilt, 'payloads') };
  await check('default day builder remains byte-identical to legacy merge and paths', async () => {
    const reads = [];
    const store = { readDays: async (days, deps, kind, opts) => {
      const name = kind || 'events'; reads.push(name); assert.deepEqual(days, [day]);
      return name === 'payloads' ? { lines: prior.payloads.map(JSON.stringify) } : { events: prior[name] };
    } };
    const built = await D.buildDays(stage(fresh), { keep_days: [day] }, { store });
    const reference = D.buildShards(T.mergeSightings(fresh), { [day]: prior });
    assert.deepEqual(reads, ['events', 'participants', 'payloads']);
    assert.deepEqual(built.files, reference.files);
    assert.deepEqual(built.shards, reference.shards);
    assert.equal(records(built, 'events').length, 3);
  });

  await check('incremental day builder emits only staged evidence and reads no prior day', async () => {
    const phases = [];
    const built = await D.buildDays(stage(fresh), { keep_days: [day] }, {
      incremental: true, store: { readDays: noNetwork }, onPhase: name => phases.push(name)
    });
    assert.deepEqual(records(built, 'events').map(e => e.hash), [hash(2), hash(3)]);
    assert.equal(records(built, 'payloads').length, 2);
    const participants = records(built, 'participants');
    assert.equal(new Set(participants.map(p => [p.tx_hash, p.address, p.role].join('|'))).size, participants.length);
    assert.deepEqual(participants.filter(p => p.tx_hash === hash(2) && p.role === 'observed_via')
      .map(p => p.address).sort(), ['rSecond', 'rWatched']);
    assert.equal(participants.some(p => p.address === 'rEarlier'), false);
    assert.equal(phases.includes('day-merge-read'), false);
    assert.equal(built.transactions, 2);
    assert.equal(built.rows.length, 2);
    assert.equal(built.rows.some(r => r.raw_tx || r.raw_meta), false);
    for (const shard of built.shards) {
      assert.match(shard.path, /^evidence\/2026\/10\/13\/(events|participants|payloads)\.[a-f0-9]{64}\.ndjson\.gz$/);
      assert.equal(shard.sha256, X.sha256(built.files[shard.path]));
      assert.equal(shard.path.includes('.' + shard.sha256 + '.ndjson.gz'), true);
      assert.equal(shard.rows, decode(built.files[shard.path]).length);
    }
    const repeated = await D.buildDays(stage(fresh), {}, { incremental: true });
    assert.deepEqual(repeated.files, built.files);
    assert.deepEqual(repeated.shards, built.shards);
    const next = await D.buildDays(stage([row(4)]), {}, { incremental: true });
    assert.equal(Object.keys(next.files).some(p => Object.hasOwn(built.files, p)), false);
    assert.equal(Object.keys(built.files).some(p => Object.hasOwn(priorBuilt.files, p)), false);
  });

  await check('every piece uses its own content address and upload retains the manifest', async () => {
    const cap = X.MAX_SHARD_BYTES;
    X.MAX_SHARD_BYTES = 1000;
    try {
      const rows = Array.from({ length: 12 }, (_, n) => row(n + 10));
      const built = await D.buildDays(stage(rows), {}, { incremental: true });
      for (const kind of ['events', 'participants', 'payloads']) {
        assert.ok(Object.keys(built.files).filter(p => p.includes('/' + kind + '.')).length > 1);
      }
      assert.equal(new Set(built.shards.map(s => s.path)).size, built.shards.length);
      const uploads = [];
      const sent = await D.buildDays(stage(rows), {}, { incremental: true,
        upload: async (packed, path) => { uploads.push(path); return { blob_sha: X.sha256(packed) }; } });
      assert.deepEqual(sent.shards, built.shards);
      assert.equal(uploads.length, built.shards.length);
      for (const [path, value] of Object.entries(sent.files)) {
        assert.deepEqual(value, { blob_sha: X.sha256(built.files[path]), size: built.files[path].length });
      }
    } finally { X.MAX_SHARD_BYTES = cap; }
  });

  await check('incremental storage retains opaque Batch payloads without expanding inner transactions', async () => {
    const batch = row(90, { tx_type: 'Batch', raw_tx: { TransactionType: 'Batch',
      RawTransactions: [{ RawTransaction: { hash: hash(91), TransactionType: 'Payment' } }] } });
    const built = await D.buildDays(stage([batch]), {}, { incremental: true });
    assert.deepEqual(records(built, 'events').map(e => e.hash), [hash(90)]);
    assert.deepEqual(records(built, 'payloads').map(e => e.raw_tx), [batch.raw_tx]);
    assert.equal(records(built, 'participants').some(p => p.tx_hash === hash(91)), false);
  });

  await check('journal staging and report reads retain injected backend dependencies', async () => {
    const token = {};
    const boundedStore = {
      async readJournalRowsEach(journal, deps, onRow) { assert.equal(deps.token, token); onRow(row(1)); return 1; },
      async readDays(days, deps, kind) { assert.equal(deps.token, token); return { events: kind === 'participants'
        ? [{ tx_hash: hash(1), address: 'rWatched', role: 'observed_via' }]
        : [X.eventOf({ ...row(1), close_time: close })], files: [], missing: [], verified: [] }; }
    };
    const deps = { env: {}, boundedStore, token, gh: noNetwork };
    const staged = await D.stageJournal({}, deps);
    assert.equal(staged.total, 1);
    const result = await D.readReportWindow({ window_start_ms: Date.parse(day), window_end_ms: Date.parse(close) }, deps);
    assert.equal(result.events.length, 1);
    assert.deepEqual(result.events[0].observed_via, ['rWatched']);
  });

  await check('acquisition keeps bounded injection through uploads and commit and selects incremental writes', async () => {
    const initial = State.genesis([{ address: 'rWatched', scan_coverage_through: 100 }],
      { anchor_ledger: 100, anchor_close: day + 'T10:00:00.000Z' });
    const calls = [];
    const token = {};
    const record = (method, deps) => { assert.equal(deps.token, token); assert.equal(deps.boundedStore, boundedStore); calls.push(method); };
    const boundedStore = {
      async readState(deps) { record('state', deps); return { state: initial, missing: false }; },
      async readJournal(deps) { record('journal', deps); return { journal: null, missing: true }; },
      readDays: noNetwork,
      async uploadBlob(bytes, deps) { record('upload', deps); return { blob_sha: X.sha256(bytes) }; },
      async commitRun(input, deps) {
        record('commit', deps);
        assert.equal(input.evidence_shards.length, 3);
        assert.equal(input.evidence_shards.every(s => /\.[a-f0-9]{64}\.ndjson\.gz$/.test(s.path)), true);
        assert.equal(Object.values(input.files).every(f => typeof f.blob_sha === 'string'), true);
        return { state_version: 2, commit_sha: 'offline-bounded-commit' };
      }
    };
    const reader = {
      epoch: 1, stats: { requests: 0, events: [] },
      async ledger() { return { ledger: 102, close_ms: Date.parse(close) }; },
      async request(command) {
        this.stats.requests++;
        return { validated: true, account: command.account, ledger_index_min: 101, ledger_index_max: 102,
          transactions: [{ validated: true, ledger_index: 101,
            tx: { hash: hash(1), Account: 'rWatched', Destination: 'rReceiver', TransactionType: 'Payment',
              Amount: '10', Fee: '12', date: Math.floor(Date.parse(close) / 1000) - 946684800 },
            meta: { TransactionResult: 'tesSUCCESS', delivered_amount: '10', AffectedNodes: [] } }] };
      },
      async balance() { this.stats.requests++; return { drops: '1000', ledger: 102 }; }
    };
    const result = await D.acquire({ report_id: 'SW-20261013-ROUTE', window_start_ms: Date.parse(day),
      window_end_ms: Date.parse(close) }, { env: {}, boundedStore, token, reader, gh: noNetwork, startReserveMs: 0 });
    assert.equal(result.committed, true);
    assert.equal(result.commit_sha, 'offline-bounded-commit');
    assert.deepEqual(calls, ['state', 'journal', 'upload', 'upload', 'upload', 'commit']);
  });
  await check('24/48/60/72-hour report windows match legacy before and after seven-day rollover', async () => {
    const Bounded = require('../src/db/bounded-store');
    const { createMemoryProvider } = require('../src/db/bounded-object-provider');
    const provider = createMemoryProvider();
    const start = '2026-10-01T00:00:00.000Z';
    const genesis = State.genesis([{ address: 'rWatched', scan_coverage_through: 100 }],
      { anchor_ledger: 100, anchor_close: start });
    const boundedStore = await Bounded.bootstrap(provider, genesis,
      { legacyRef: 'a'.repeat(40), cutoverDay: start.slice(0, 10), legacy: {readPinnedState:async d=>({ref:d.ref,state:genesis}),resolveDayManifests: async(days,d) => ({ref:d.ref,state:d.loaded_state,byDay:Object.fromEntries(days.map(day=>[day,{shards:{}}]))}),readDays:async()=>({events:[]})} });
    const deps = { env: {}, boundedStore, gh: noNetwork };
    const all = [];
    async function commitDay(n) {
      const stamp = '2026-10-' + String(n).padStart(2, '0');
      const anchor = 100 + n * 10;
      const rows = [6, 18].map((hour, j) => {
        const closeTime = stamp + 'T' + String(hour).padStart(2, '0') + ':00:00.000Z';
        return row(n * 10 + j, { ledger_index: anchor - 2 + j, close_time_iso: closeTime,
          close_time_ms: Date.parse(closeTime), observed_via: ['rWatched', 'rObserver' + n] });
      });
      const built = await D.buildDays(stage(rows), {}, { incremental: true });
      const priorState = (await Store.readState(deps)).state;
      const anchorClose = stamp + 'T23:00:00.000Z';
      await Store.commitRun({ report_id: 'SW-202610' + String(n).padStart(2, '0') + '-PARIT',
        anchor_ledger: anchor, anchor_close: anchorClose, sealed_at: anchorClose,
        target_wallets: 1, complete_wallets: 1, balance_contradictions: 0,
        wallets: priorState.wallets.map(w => ({ ...w, last_proven_ledger: anchor, last_proven_close: anchorClose })),
        evidence_shards: built.shards, files: built.files }, deps);
      all.push(...rows);
    }
    for (let n = 1; n <= 9; n++) await commitDay(n);
    const before = await Store.readPinnedState(deps);
    const legacyBuilt = D.buildShards(T.mergeSightings(all), {});
    const gh = async (method, path) => {
      assert.equal(method, 'GET');
      assert.match(path, /^\/contents\//);
      const bytes = legacyBuilt.files[path.slice('/contents/'.length).split('?')[0]];
      return bytes ? { encoding: 'base64', content: bytes.toString('base64'), size: bytes.length } : null;
    };
    const legacyDeps = { env: { SHADOWWATCH_EVIDENCE_TOKEN: 'offline-fixture' }, gh };
    const end = Date.parse('2026-10-09T23:00:00.000Z');
    const expected = new Map();
    async function verifyWindow(hours, pinned) {
      const input = { window_start_ms: end - hours * 3600000, window_end_ms: end };
      if (!expected.has(hours)) expected.set(hours, await D.readReportWindow(input, legacyDeps));
      const days = D.windowDays(input);
      const manifests = await Store.resolveDayManifests(days, { ...deps, ref: pinned && pinned.ref });
      const actual = await D.readReportWindow(input, { ...deps, ref: manifests.ref,
        evidence_ref: manifests.ref, day_manifests: manifests.byDay });
      assert.deepEqual(actual.events, expected.get(hours).events, hours + '-hour evidence parity');
      assert.equal(actual.from_stored, expected.get(hours).from_stored);
      assert.equal(actual.in_window, expected.get(hours).in_window);
      assert.equal(actual.unattributed, 0);
      assert.equal(actual.provenance, 'OBSERVED');
      assert.deepEqual(actual.days_without_shards, []);
      assert.ok(actual.shards_verified.length > 0);
      const reported = await require('../api/delta').storedReport(input, {
        ...deps, ref: manifests.ref, pack: false, now: () => end
      });
      assert.deepEqual(reported.events.map(e => ({ hash: e.hash, observed_via: e.observed_via })),
        expected.get(hours).events.map(e => ({ hash: e.hash, observed_via: e.observed_via })));
      assert.equal(reported.source, 'STORED_VERIFIED_EVIDENCE');
      assert.equal(reported.xrpl_requests, 0);
      assert.equal(reported.complete_wallets, 1);
      assert.equal(reported.failed_wallets, 0);
      assert.equal(reported.window.in_window, actual.in_window);
      assert.equal(reported.window.provenance, 'OBSERVED');
      assert.ok(Date.parse(reported.window.balance_baseline.anchor_close) <= input.window_start_ms);
    }
    for (const hours of [24, 48, 60, 72]) await verifyWindow(hours, before);
    for (let n = 10; n <= 17; n++) await commitDay(n);
    const root = await boundedStore.inspect();
    assert.ok(root.frozen['2026-10-06']);
    assert.ok(root.frozen['2026-10-09']);
    assert.equal(Object.hasOwn(root.days, '2026-10-09'), false);
    for (const hours of [24, 48, 60, 72]) {
      await verifyWindow(hours, null); // archived manifests from the latest root
      await verifyWindow(hours, before); // original report's immutable snapshot
    }
  });
  console.log('\n' + passed + ' bounded store routing tests passed.');
})().catch(error => { console.error(error.stack); process.exitCode = 1; });
