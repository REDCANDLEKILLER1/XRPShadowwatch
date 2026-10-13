#!/usr/bin/env node
'use strict';
// Offline fixtures only. These tests validate byte/graph checks and fail-closed
// behavior, never a live provider, production cutover, or legacy Git backup.
const assert = require('assert/strict');
const zlib = require('zlib');
const Backup = require('../src/db/bounded-backup');
const Store = require('../src/db/bounded-store');
const State = require('../src/db/evidence-state');
const Journal = require('../src/db/run-journal');
const Provider = require('../src/db/bounded-object-provider');

const START = '2026-09-01T00:00:00.000Z';
const DAY = '2026-09-01';
const HASH = '1'.repeat(64);
const LEGACY = 'a'.repeat(40);
const clone = value => JSON.parse(JSON.stringify(value));
const bytes = value => Buffer.from(JSON.stringify(value));
const genesis = State.genesis(['rAlice', 'rBob'].map(address => ({
  address, scan_coverage_through:100, balance_drops:'1000000', balance_ledger:100
})), {anchor_ledger:100, anchor_close:START});
const legacy = {
  readPinnedState:async deps => ({ref:deps.ref, state:genesis}),
  resolveDayManifests:async (days, deps) => ({ref:deps.ref, state:deps.loaded_state,
    byDay:Object.fromEntries(days.map(day => [day, {shards:{}}]))}),
  readDays:async () => ({events:[]})
};
function memory(account = 'source-fixture', bucket = 'bounded-source-fixture', now = START) {
  return Provider.createMemoryProvider({identity:{account, bucket}, now:() => Date.parse(now)});
}
async function fresh(provider = memory()) {
  const store = await Store.bootstrap(provider, genesis, {legacy, legacyRef:LEGACY, cutoverDay:DAY});
  return {provider, store};
}
function data(hash = HASH, day = DAY) {
  return {
    events:[{hash, ledger_index:110, close_time:day + 'T12:00:00.000Z', tx_type:'Payment', amount_drops:'100'}],
    participants:[{tx_hash:hash, address:'rAlice', role:'sender'}, {tx_hash:hash, address:'rBob', role:'receiver'}],
    payloads:[{hash, raw_tx:{TransactionType:'Payment', ParentBatchID:'b'.repeat(64)}, raw_meta:{TransactionResult:'tesSUCCESS'}}]
  };
}
async function run(store, hours, records = {}, extra = {}) {
  const prior = (await store.readState()).state, anchor = 100 + hours;
  const files = {}, evidence_shards = [];
  for (const [day, kinds] of Object.entries(records)) for (const [kind, rows] of Object.entries(kinds)) {
    const packed = zlib.gzipSync(Buffer.from(rows.map(JSON.stringify).join('\n') + '\n'));
    const sha256 = Store.sha(packed), path = 'evidence/' + day.replaceAll('-', '/') + '/' + kind + '.' + sha256 + '.ndjson.gz';
    files[path] = packed; evidence_shards.push({path, sha256, rows:rows.length});
  }
  return {report_id:'SW-20260901-' + String(hours).padStart(5, '0'),
    anchor_ledger:anchor, anchor_close:new Date(Date.parse(START) + hours * 3600000).toISOString(),
    target_wallets:2, complete_wallets:2, balance_contradictions:0,
    wallets:prior.wallets.map(wallet => ({...wallet, last_proven_ledger:anchor,
      balance_drops:'1000000', balance_ledger:anchor, reconciliation:'RECONCILED'})),
    files, evidence_shards, ...extra};
}
async function populated() {
  const fixture = await fresh();
  await fixture.store.commitRun(await run(fixture.store, 13, {[DAY]:data()}, {flagged_hashes:[{hash:HASH, reason:'fixture'}]}));
  return fixture;
}
// The test setup copies actual bytes into a separately allocated memory Map.
// The verifier receives only read methods and cannot perform this copy itself.
async function independentCopy(source, target = memory('recovery-fixture', 'bounded-recovery-fixture', '2026-10-01T00:00:00.000Z')) {
  for (const entry of await source.list()) {
    const value = await source.get(entry.key);
    if (entry.key === Backup.ROOT) await target.compareAndSwap(entry.key, null, value);
    else await target.putImmutable(entry.key, value);
  }
  return target;
}
function readOnly(provider, overrides = {}) {
  const calls = {get:0, getVersioned:0, list:0, writes:0};
  const watched = {...provider,
    get:async key => { calls.get++; return provider.get(key); },
    getVersioned:async key => { calls.getVersioned++; return provider.getVersioned(key); },
    list:async prefix => { calls.list++; assert.equal(prefix, Backup.PREFIX); return provider.list(prefix); },
    putImmutable:async () => { calls.writes++; throw Error('verification attempted a write'); },
    compareAndSwap:async () => { calls.writes++; throw Error('verification attempted CAS'); },
    ...overrides};
  return {provider:watched, calls};
}
async function reject(promise, code) {
  await assert.rejects(promise, error => error.code === code || error.message === code, code);
}
function invalid(result, code) {
  assert.equal(result.ok, false); assert.deepEqual(result.problems, [code]);
  assert.equal(result.qualification, 'unverified');
}
function reseal(value, field) {
  const result = clone(value); delete result[field];
  return {...result, [field]:Backup.digest(result)};
}
// Make a content-addressed root/snapshot pair without mutating the fixture.
// Extra objects allow graph errors to be tested after the byte hashes pass.
async function rootView(provider, change, extras = []) {
  const original = await provider.getVersioned(Backup.ROOT), root = JSON.parse(original.bytes);
  change(root);
  const packed = bytes(root), hash = Backup.sha256(packed), replacements = new Map(extras);
  replacements.set(Backup.ROOT, packed);
  replacements.set(Backup.PREFIX + 'snapshots/' + hash + '.json', packed);
  return {...provider,
    get:async key => replacements.has(key) ? Buffer.from(replacements.get(key)) : provider.get(key),
    getVersioned:async key => replacements.has(key) ? {bytes:Buffer.from(replacements.get(key)), etag:'"' + Backup.sha256(replacements.get(key)) + '"'} : provider.getVersioned(key),
    list:async () => {
      const listed = (await provider.list()).filter(entry => !replacements.has(entry.key));
      for (const [key, value] of replacements) listed.push({key, size:value.length, etag:'"' + Backup.sha256(value) + '"'});
      return listed;
    }};
}

let passed = 0, failed = 0;
async function check(name, test) {
  try { await test(); passed++; console.log('PASS bounded-backup: ' + name); }
  catch (error) { failed++; console.error('FAIL bounded-backup: ' + name); console.error(error); }
}

(async () => {
  await check('capture and independent restore cover all bytes without writes', async () => {
    const {provider, store} = await populated();
    await store.commitRun(await run(store, 241, {'2026-09-11':data('2'.repeat(64), '2026-09-11')}));
    const root = await store.inspect();
    assert(root.frozen[DAY], 'fixture includes a frozen day manifest');
    assert(root.flags[HASH], 'fixture includes a permanent flag');
    assert(Object.keys(root.state_snapshots).length >= 2, 'fixture includes historical roots');
    const unreferenced = Buffer.from('unpublished staged object');
    const orphanKey = Backup.PREFIX + 'objects/' + Backup.sha256(unreferenced);
    await provider.putImmutable(orphanKey, unreferenced);
    const source = readOnly(provider), manifest = await Backup.capture(source.provider, {sourceIdentity:provider.identity});
    assert.equal(manifest.source_type, 'bounded-object-store');
    assert.equal(manifest.schema, Backup.MANIFEST_SCHEMA);
    assert.deepEqual(manifest.source, provider.identity);
    assert.equal(manifest.root.state_sha256, root.state.state_sha256);
    assert.equal(manifest.root.revision, root.revision);
    assert.equal(manifest.coverage.first_bounded_state_version, 1);
    assert.equal(manifest.coverage.last_bounded_state_version, 3);
    assert.equal(manifest.coverage.legacy_git_history, 'excluded-requires-separate-backup');
    assert.equal(manifest.coverage.historical_object_versions, 'excluded');
    assert.equal(manifest.qualification.production_qualified, false);
    assert(manifest.inventory.objects.some(entry => entry.key === orphanKey));
    assert.equal(manifest.inventory.object_count, (await provider.list()).length);
    assert.equal(manifest.inventory.total_bytes, (await provider.list()).reduce((sum, entry) => sum + entry.size, 0));
    assert.equal(source.calls.list, 2); assert.equal(source.calls.getVersioned, 2); assert.equal(source.calls.writes, 0);
    assert(source.calls.get >= manifest.inventory.object_count);
    const copied = await independentCopy(provider), recovery = readOnly(copied);
    const receipt = await Backup.verifyRestore(manifest, recovery.provider, {recoveryIdentity:copied.identity});
    assert.equal(receipt.schema, Backup.RESTORE_SCHEMA);
    assert.equal(receipt.manifest_sha256, manifest.manifest_sha256);
    assert.equal(receipt.root_sha256, manifest.root.sha256);
    assert.equal(receipt.independent_copy_verified, true);
    assert.equal(receipt.independent_provider_verified, true);
    assert.equal(receipt.qualification.production_qualified, false);
    assert.equal(receipt.qualification.source_kind, 'memory');
    assert.equal(receipt.qualification.recovery_kind, 'memory');
    assert.equal(receipt.total_bytes, manifest.inventory.total_bytes);
    assert.equal(recovery.calls.list, 2); assert.equal(recovery.calls.writes, 0);
    const originalBytes = await provider.get(orphanKey), returnedBytes = await copied.get(orphanKey);
    returnedBytes.fill(0);
    assert.deepEqual(await provider.get(orphanKey), originalBytes);
    assert.deepEqual(await copied.get(orphanKey), originalBytes);
    assert.notEqual((await copied.list())[0].last_modified, (await provider.list())[0].last_modified);
  });

  await check('provider ETags and copy timestamps are not portable content identities', async () => {
    const {provider} = await populated(), manifest = await Backup.capture(provider), copied = await independentCopy(provider);
    const portable = {...copied,
      getVersioned:async key => { const value = await copied.getVersioned(key); return value && {...value, etag:'"recovery-etag"'}; },
      list:async () => (await copied.list()).map(entry => ({...entry, etag:'"recovery-etag"'}))};
    const receipt = await Backup.verifyRestore(manifest, portable, {recoveryIdentity:copied.identity});
    assert.equal(receipt.restore_verified, true);
  });

  await check('source typing rejects legacy Git records and qualification escalation', async () => {
    const {provider} = await populated(), manifest = await Backup.capture(provider), copied = await independentCopy(provider);
    const receipt = await Backup.verifyRestore(manifest, copied, {recoveryIdentity:copied.identity});
    invalid(Backup.verifyManifest({schema:'shadowwatch-master-backup/1', source_type:'github'}), 'BOUNDED_BACKUP_MANIFEST_INVALID');
    for (const source_type of ['github', 'git', 'r2', undefined]) {
      const badManifest = {...manifest, source_type};
      invalid(Backup.verifyManifest(badManifest), 'BOUNDED_BACKUP_SOURCE_TYPE_INVALID');
      await reject(Backup.verifyRestore(badManifest, copied, {recoveryIdentity:copied.identity}), 'BOUNDED_BACKUP_SOURCE_TYPE_INVALID');
      invalid(Backup.verifyReceipt({...receipt, source_type}, manifest), 'BOUNDED_BACKUP_SOURCE_TYPE_INVALID');
    }
    const qualified = clone(manifest); qualified.qualification.production_qualified = true;
    invalid(Backup.verifyManifest(reseal(qualified, 'manifest_sha256')), 'BOUNDED_BACKUP_MANIFEST_QUALIFICATION_INVALID');
    const fullHistory = clone(manifest); fullHistory.coverage.legacy_git_history = 'verified';
    invalid(Backup.verifyManifest(reseal(fullHistory, 'manifest_sha256')), 'BOUNDED_BACKUP_MANIFEST_COVERAGE_INVALID');
    const qualifiedReceipt = clone(receipt); qualifiedReceipt.qualification.production_qualified = true;
    invalid(Backup.verifyReceipt(reseal(qualifiedReceipt, 'receipt_sha256')), 'BOUNDED_BACKUP_RECEIPT_QUALIFICATION_INVALID');
    assert.equal(await (await Store.createStore(provider).readPinnedState()).gh('GET', '/contents/evidence/backup/latest.json'), null);
  });

  await check('record validation never treats stale or resealed JSON as live provider proof', async () => {
    const {provider, store} = await populated(), manifest = await Backup.capture(provider), oldCopy = await independentCopy(provider);
    const receipt = await Backup.verifyRestore(manifest, oldCopy, {recoveryIdentity:oldCopy.identity});
    assert.deepEqual(Backup.verifyManifest(manifest), {ok:true, problems:[], qualification:'recorded-manifest-only', provider_inventory_verified:false});
    assert.deepEqual(Backup.verifyReceipt(receipt, manifest), {ok:true, problems:[], qualification:'recorded-receipt-only', provider_reads_verified:false});
    const altered = clone(manifest); altered.source.account = 'invented-account';
    invalid(Backup.verifyManifest(altered), 'BOUNDED_BACKUP_MANIFEST_SEAL_INVALID');
    const fabricated = reseal(altered, 'manifest_sha256');
    assert.equal(Backup.verifyManifest(fabricated).ok, true, 'a checksum is deliberately not an authentication signature');
    assert.equal(Backup.verifyManifest(fabricated).provider_inventory_verified, false);
    const forgedReceipt = clone(receipt); forgedReceipt.recovery.account = 'invented-recovery';
    invalid(Backup.verifyReceipt(forgedReceipt, manifest), 'BOUNDED_BACKUP_RECEIPT_SEAL_INVALID');
    assert.deepEqual(Backup.verifyReceipt(reseal(forgedReceipt, 'receipt_sha256'), manifest),
      {ok:true, problems:[], qualification:'recorded-receipt-only', provider_reads_verified:false});
    await store.commitRun(await run(store, 14));
    const currentManifest = await Backup.capture(provider), currentCopy = await independentCopy(provider);
    assert.equal(Backup.verifyManifest(manifest).provider_inventory_verified, false);
    invalid(Backup.verifyReceipt(receipt, currentManifest), 'BOUNDED_BACKUP_RECEIPT_MANIFEST_MISMATCH');
    await reject(Backup.verifyRestore(manifest, currentCopy, {recoveryIdentity:currentCopy.identity}), 'BOUNDED_BACKUP_RESTORE_MISMATCH');
    await reject(Backup.verifyRestore(currentManifest, oldCopy, {recoveryIdentity:oldCopy.identity}), 'BOUNDED_BACKUP_RESTORE_MISMATCH');
    // A historical independent copy remains evidence of precisely its named
    // checkpoint; no age-independent record validator can make it current.
    assert.equal((await Backup.verifyRestore(manifest, oldCopy, {recoveryIdentity:oldCopy.identity})).state_version, 2);
  });

  await check('identity must match expected namespace, backend, account and independent failure domain', async () => {
    const {provider} = await populated(), manifest = await Backup.capture(provider), copied = await independentCopy(provider);
    await reject(Backup.capture(provider, {sourceIdentity:{...provider.identity, account:'wrong-source'}}), 'BOUNDED_BACKUP_IDENTITY_MISMATCH');
    await reject(Backup.capture(provider, {unexpected:true}), 'BOUNDED_BACKUP_OPTIONS_INVALID');
    for (const change of [{prefix:'elsewhere/'}, {backend:'github'}, {bucket:'Bad_Bucket'}, {account:''}, {extra:true}]) {
      await reject(Backup.capture({...provider, identity:{...provider.identity, ...change}}), 'BOUNDED_BACKUP_IDENTITY_INVALID');
    }
    for (const change of [{prefix:'bounded/v1/nested/'}, {rootKey:'bounded/v1/other.json'}, {kind:'r2'}, {get:null}, {getVersioned:null}, {list:null}]) {
      await reject(Backup.capture({...provider, ...change}), 'BOUNDED_BACKUP_PROVIDER_INVALID');
    }
    await reject(Backup.verifyRestore(manifest, copied), 'BOUNDED_BACKUP_RECOVERY_IDENTITY_REQUIRED');
    await reject(Backup.verifyRestore(manifest, copied, {recoveryIdentity:{...copied.identity, bucket:'wrong-bucket'}}), 'BOUNDED_BACKUP_IDENTITY_MISMATCH');
    await reject(Backup.verifyRestore(manifest, provider, {recoveryIdentity:provider.identity}), 'BOUNDED_BACKUP_INDEPENDENT_DESTINATION_REQUIRED');
    const sameAccount = await independentCopy(provider, memory(provider.identity.account, 'different-bucket'));
    await reject(Backup.verifyRestore(manifest, sameAccount, {recoveryIdentity:sameAccount.identity}), 'BOUNDED_BACKUP_INDEPENDENT_FAILURE_DOMAIN_REQUIRED');
    let lists = 0;
    const drifting = {...provider, identity:clone(provider.identity), list:async () => {
      if (++lists === 2) drifting.identity.account = 'changed-mid-scan';
      return provider.list();
    }};
    await reject(Backup.capture(drifting), 'BOUNDED_BACKUP_IDENTITY_MISMATCH');
  });

  await check('namespace inventory rejects unknown, missing, duplicate and malformed entries', async () => {
    const {provider} = await populated(), listed = await provider.list();
    const withList = list => ({...provider, list:async () => list});
    await reject(Backup.capture(withList([])), 'BOUNDED_BACKUP_INVENTORY_REQUIRED');
    await reject(Backup.capture(withList({objects:listed})), 'BOUNDED_BACKUP_INVENTORY_REQUIRED');
    await reject(Backup.capture(withList(listed.filter(entry => entry.key !== Backup.ROOT))), 'BOUNDED_BACKUP_ROOT_NOT_LISTED');
    await reject(Backup.capture(withList([...listed, listed[0]])), 'BOUNDED_BACKUP_INVENTORY_INVALID');
    for (const key of ['outside/root.json', 'bounded/v1/unknown/file', 'bounded/v1/objects/' + 'A'.repeat(64), 'bounded/v1/objects/../root.json']) {
      await reject(Backup.capture(withList([...listed, {key, size:1, etag:'"bad"'}])), 'BOUNDED_BACKUP_KEY_INVALID');
    }
    for (const size of [-1, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
      await reject(Backup.capture(withList([{...listed[0], size}, ...listed.slice(1)])), 'BOUNDED_BACKUP_INVENTORY_INVALID');
    }
    await reject(Backup.capture(withList([{...listed[0], etag:'*'}, ...listed.slice(1)])), 'BOUNDED_BACKUP_ETAG_INVALID');
    await reject(Backup.capture(withList([{...listed[0], last_modified:'2026-09-01'}, ...listed.slice(1)])), 'BOUNDED_BACKUP_TIMESTAMP_INVALID');
    await reject(Backup.capture(withList([{...listed[0], unexpected:true}, ...listed.slice(1)])), 'BOUNDED_BACKUP_LIST_ENTRY_INVALID');
    const rootBytes = await provider.get(Backup.ROOT), snapshot = Backup.PREFIX + 'snapshots/' + Backup.sha256(rootBytes) + '.json';
    await reject(Backup.capture(withList(listed.filter(entry => entry.key !== snapshot))), 'BOUNDED_BACKUP_CURRENT_SNAPSHOT_MISSING');
    const root = JSON.parse(rootBytes), history = Object.entries(root.files).find(([path]) => path.startsWith('evidence/state/history/'))[1];
    await reject(Backup.capture(withList(listed.filter(entry => entry.key !== history.key))), 'BOUNDED_BACKUP_REFERENCE_MISMATCH');
  });

  await check('missing, malformed and changed roots fail closed', async () => {
    const {provider} = await populated();
    await reject(Backup.capture({...provider, getVersioned:async () => null}), 'BOUNDED_BACKUP_ROOT_MISSING');
    await reject(Backup.capture({...provider, getVersioned:async () => ({bytes:'not a Buffer', etag:'"a"'})}), 'BOUNDED_BACKUP_ROOT_MISSING');
    await reject(Backup.capture({...provider, getVersioned:async () => ({bytes:Buffer.from('{'), etag:'"a"'})}), 'BOUNDED_BACKUP_JSON_INVALID');
    await reject(Backup.capture({...provider, getVersioned:async () => ({bytes:Buffer.from('[]'), etag:'"a"'})}), 'BOUNDED_BACKUP_JSON_INVALID');
    await reject(Backup.capture(await rootView(provider, root => { root.revision = 1; })), 'BOUNDED_BACKUP_ROOT_INVALID');
    await reject(Backup.capture(await rootView(provider, root => { root.state.state_sha256 = '0'.repeat(64); })), 'BOUNDED_BACKUP_STATE_INVALID');
    await reject(Backup.capture({...provider, list:async () => (await provider.list()).map(entry => entry.key === Backup.ROOT ? {...entry, etag:'"changed"'} : entry)}), 'BOUNDED_BACKUP_ROOT_CHANGED');
    let reads = 0;
    await reject(Backup.capture({...provider, getVersioned:async key => {
      const result = await provider.getVersioned(key); return ++reads === 2 ? {...result, etag:'"changed-after-scan"'} : result;
    }}), 'BOUNDED_BACKUP_ROOT_CHANGED');
  });

  await check('listed object absence, truncation and same-length corruption are fatal', async () => {
    const {provider} = await populated(), target = (await provider.list()).find(entry => entry.key.startsWith(Backup.PREFIX + 'objects/'));
    const original = await provider.get(target.key), damaged = Buffer.from(original); damaged[0] ^= 1;
    for (const value of [null, original.subarray(1), original.toString('utf8')]) {
      await reject(Backup.capture({...provider, get:async key => key === target.key ? value : provider.get(key)}), 'BOUNDED_BACKUP_OBJECT_MISSING_OR_LENGTH');
    }
    await reject(Backup.capture({...provider, get:async key => key === target.key ? damaged : provider.get(key)}), 'BOUNDED_BACKUP_OBJECT_HASH_MISMATCH');
    const extra = Buffer.from('orphan'), orphanKey = Backup.PREFIX + 'objects/' + Backup.sha256(extra);
    await provider.putImmutable(orphanKey, extra);
    await reject(Backup.capture({...provider, get:async key => key === orphanKey ? Buffer.from('broken') : provider.get(key)}), 'BOUNDED_BACKUP_OBJECT_HASH_MISMATCH');
  });

  await check('recursive graph validation checks references, history, shards and legacy boundary', async () => {
    const {provider} = await populated();
    const cases = [
      [root => { root.files['unexpected/path'] = Object.values(root.files)[0]; }, 'BOUNDED_BACKUP_LOGICAL_PATH_INVALID'],
      [root => { for (const path of Object.keys(root.files)) if (path.startsWith('evidence/state/history/')) delete root.files[path]; }, 'BOUNDED_BACKUP_STATE_HISTORY_MISSING'],
      [root => { Object.values(root.files)[0].size++; }, 'BOUNDED_BACKUP_REFERENCE_MISMATCH'],
      [root => { root.days[DAY].shards[0].rows++; }, 'BOUNDED_BACKUP_ROWS_MISMATCH'],
      [root => { root.days[DAY].shards[0].path = 'evidence/2026/09/01/wrong.ndjson.gz'; }, 'BOUNDED_BACKUP_SHARD_REFERENCE_INVALID'],
      [root => { root.legacy_ref = 'b'.repeat(40); }, 'BOUNDED_BACKUP_LEGACY_BOUNDARY_MISMATCH'],
      [root => { root.state = clone(genesis); }, 'BOUNDED_BACKUP_CURRENT_STATE_MISMATCH'],
      [root => { root.coverage_cutoff.anchor_ledger++; }, 'BOUNDED_BACKUP_BOOTSTRAP_STATE_MISMATCH']
    ];
    for (const [change, code] of cases) await reject(Backup.capture(await rootView(provider, change)), code);
    for (const packed of [Buffer.from('not gzip'), zlib.gzipSync(Buffer.from('not JSON\n'))]) {
      const sha256 = Backup.sha256(packed), key = Backup.PREFIX + 'objects/' + sha256;
      const broken = await rootView(provider, root => {
        const shard = root.days[DAY].shards[0];
        shard.sha256 = sha256; shard.path = 'evidence/2026/09/01/' + shard.kind + '.' + sha256 + '.ndjson.gz';
        shard.object = {key, size:packed.length, sha256};
      }, [[key, packed]]);
      await reject(Backup.capture(broken), 'BOUNDED_BACKUP_SHARD_INVALID');
    }
    // Even unreferenced snapshots must describe a valid graph.
    const badSnapshot = Buffer.from('{"schema":"not-a-bounded-root"}');
    await provider.putImmutable(Backup.PREFIX + 'snapshots/' + Backup.sha256(badSnapshot) + '.json', badSnapshot);
    await reject(Backup.capture(provider), 'BOUNDED_BACKUP_ROOT_INVALID');
  });

  await check('incomplete listing and unstable inventories cannot yield a manifest', async () => {
    const {provider} = await populated();
    const incomplete = Object.assign(Error('BOUNDED_INVENTORY_INCOMPLETE'), {code:'BOUNDED_INVENTORY_INCOMPLETE'});
    await reject(Backup.capture({...provider, list:async () => { throw incomplete; }}), 'BOUNDED_INVENTORY_INCOMPLETE');
    let lists = 0;
    await reject(Backup.capture({...provider, list:async () => {
      const entries = await provider.list();
      return ++lists === 1 ? entries : entries.map((entry, index) => index ? entry : {...entry, etag:'"changed"'});
    }}), 'BOUNDED_BACKUP_INVENTORY_CHANGED');
    // Drive the real R2 pagination guard through capture using injected commands;
    // no SDK/client creation or network request is possible in this fixture.
    const commands = {
      GetObjectCommand:class GetObjectCommand { constructor(input) { this.input = input; } },
      PutObjectCommand:class PutObjectCommand { constructor(input) { this.input = input; } },
      ListObjectsV2Command:class ListObjectsV2Command { constructor(input) { this.input = input; } }
    };
    let puts = 0, pages = 0;
    const r2 = Provider.createR2Provider({commands, env:{SHADOWWATCH_BOUNDED_STORAGE_MODE:'r2',
      SHADOWWATCH_BOUNDED_R2_BUCKET:'bounded-offline-fixture',
      SHADOWWATCH_BOUNDED_R2_ENDPOINT:'https://' + 'a'.repeat(32) + '.r2.cloudflarestorage.com'}, client:{send:async command => {
      if (command instanceof commands.PutObjectCommand) { puts++; throw Error('unexpected write'); }
      if (command instanceof commands.ListObjectsV2Command) { pages++; return {IsTruncated:true, Contents:[]}; }
      assert(command instanceof commands.GetObjectCommand);
      const result = await provider.getVersioned(command.input.Key);
      return {Body:result.bytes, ETag:result.etag, ContentLength:result.bytes.length, Metadata:{sha256:Backup.sha256(result.bytes)}};
    }}});
    await reject(Backup.capture(r2), 'BOUNDED_INVENTORY_INCOMPLETE');
    assert.equal(pages, 1); assert.equal(puts, 0);
  });

  await check('independent restore rereads recovery bytes and rejects missing or extra content', async () => {
    const {provider} = await populated(), manifest = await Backup.capture(provider), copied = await independentCopy(provider);
    const entry = manifest.inventory.objects.find(object => object.key.startsWith(Backup.PREFIX + 'objects/'));
    const missing = {...copied, get:async key => key === entry.key ? null : copied.get(key)};
    await reject(Backup.verifyRestore(manifest, missing, {recoveryIdentity:copied.identity}), 'BOUNDED_BACKUP_OBJECT_MISSING_OR_LENGTH');
    const broken = Buffer.from(await copied.get(entry.key)); broken[0] ^= 1;
    await reject(Backup.verifyRestore(manifest, {...copied, get:async key => key === entry.key ? broken : copied.get(key)}, {recoveryIdentity:copied.identity}), 'BOUNDED_BACKUP_OBJECT_HASH_MISMATCH');
    const extra = Buffer.from('additional staged object');
    await copied.putImmutable(Backup.PREFIX + 'objects/' + Backup.sha256(extra), extra);
    await reject(Backup.verifyRestore(manifest, copied, {recoveryIdentity:copied.identity}), 'BOUNDED_BACKUP_RESTORE_MISMATCH');
  });

  await check('manifest and receipt schemas bind inventory, root, state and exact record shape', async () => {
    const {provider} = await populated(), manifest = await Backup.capture(provider), copied = await independentCopy(provider);
    const receipt = await Backup.verifyRestore(manifest, copied, {recoveryIdentity:copied.identity});
    const changes = [
      [value => { value.extra = true; }, 'BOUNDED_BACKUP_MANIFEST_INVALID'],
      [value => { value.root.key = 'bounded/v1/not-root.json'; }, 'BOUNDED_BACKUP_MANIFEST_ROOT_INVALID'],
      [value => { value.inventory.object_count++; }, 'BOUNDED_BACKUP_MANIFEST_INVENTORY_INVALID'],
      [value => { value.inventory.total_bytes++; }, 'BOUNDED_BACKUP_MANIFEST_INVENTORY_INVALID'],
      [value => { value.inventory.objects.reverse(); }, 'BOUNDED_BACKUP_MANIFEST_OBJECT_INVALID'],
      [value => { value.inventory.objects[0].sha256 = '0'.repeat(64); }, 'BOUNDED_BACKUP_MANIFEST_OBJECT_INVALID'],
      [value => { value.coverage.recursive_references_verified = false; }, 'BOUNDED_BACKUP_MANIFEST_COVERAGE_INVALID']
    ];
    for (const [change, code] of changes) { const value = clone(manifest); change(value); invalid(Backup.verifyManifest(reseal(value, 'manifest_sha256')), code); }
    invalid(Backup.verifyReceipt({...receipt, restore_verified:false}), 'BOUNDED_BACKUP_RECEIPT_INVALID');
    invalid(Backup.verifyReceipt({...receipt, extra:true}), 'BOUNDED_BACKUP_RECEIPT_INVALID');
    const wrongRoot = {...receipt, root_sha256:'0'.repeat(64)};
    invalid(Backup.verifyReceipt(reseal(wrongRoot, 'receipt_sha256'), manifest), 'BOUNDED_BACKUP_RECEIPT_MANIFEST_MISMATCH');
  });

  await check('incomplete journal rows are backed up without releasing their retention hold', async () => {
    const {provider, store} = await fresh();
    const journal = Journal.begin({report_id:'SW-20260901-HOLD1', from_state_version:1,
      from_state_sha256:genesis.state_sha256, anchor_ledger:1000, anchor_close:'2026-10-01T00:00:00.000Z'});
    await store.appendJournal(journal, {wallets:[], rows:[{hash:HASH, raw_tx:{ParentBatchID:'b'.repeat(64)}}]});
    await store.commitRun(await run(store, 241, {[DAY]:data()}));
    const before = await store.inspect(), rootBytes = await provider.get(Backup.ROOT);
    assert(before.journal); assert(Object.keys(before.days).length > 8, 'journal holds old active days');
    const manifest = await Backup.capture(readOnly(provider).provider);
    const shard = before.journal.row_shards[0];
    assert(manifest.inventory.objects.some(entry => entry.key === before.files[shard.path].key));
    const copied = await independentCopy(provider);
    await Backup.verifyRestore(manifest, readOnly(copied).provider, {recoveryIdentity:copied.identity});
    assert.deepEqual(await provider.get(Backup.ROOT), rootBytes);
    assert.deepEqual(await store.inspect(), before, 'verification cannot clear journal or change retention');
    await reject(Backup.capture(await rootView(provider, root => { delete root.files[shard.path]; })), 'BOUNDED_BACKUP_JOURNAL_REFERENCE_INVALID');
  });

  await check('durable reservation blocks capture and restore until exact recovery publishes', async () => {
    const {provider} = await fresh(); let calls = 0, failFinal = true;
    const faulted = {...provider, compareAndSwap:async (...args) => {
      if (++calls === 2 && failFinal) throw Error('final CAS failed');
      return provider.compareAndSwap(...args);
    }};
    const writer = Store.createStore(faulted), oldManifest = await Backup.capture(provider);
    const operation = await run(writer, 13, {[DAY]:data()});
    await assert.rejects(writer.commitRun(operation), /final CAS failed/);
    const held = await writer.inspect(), heldBytes = await provider.get(Backup.ROOT);
    assert(held.pending); assert(held.allocated_bytes > 0);
    await reject(Backup.capture(readOnly(provider).provider), 'BOUNDED_BACKUP_PENDING_ROOT_BLOCKED');
    const copied = await independentCopy(provider);
    await reject(Backup.verifyRestore(oldManifest, copied, {recoveryIdentity:copied.identity}), 'BOUNDED_BACKUP_PENDING_ROOT_BLOCKED');
    assert.deepEqual(await provider.get(Backup.ROOT), heldBytes, 'verification cannot resolve or discard a reservation');
    failFinal = false; await writer.commitRun(operation);
    assert.equal((await Backup.capture(provider)).root.state_version, 2);
    assert.equal((await writer.inspect()).pending, undefined);
  });

  await check('lost CAS responses preserve reservation holds and recognize published success', async () => {
    for (const lostAt of [1, 2]) {
      const {provider} = await fresh(); let calls = 0;
      const loss = {...provider, compareAndSwap:async (...args) => {
        const tag = await provider.compareAndSwap(...args);
        if (++calls === lostAt) throw Error('response lost');
        return tag;
      }};
      const writer = Store.createStore(loss), operation = await run(writer, 13, {[DAY]:data()});
      await assert.rejects(writer.commitRun(operation), /response lost/);
      const held = await writer.inspect();
      if (lostAt === 1) {
        assert(held.pending);
        await reject(Backup.capture(provider), 'BOUNDED_BACKUP_PENDING_ROOT_BLOCKED');
      } else {
        assert.equal(held.pending, undefined);
        assert.equal((await Backup.capture(provider)).root.state_version, 2);
      }
      await Store.createStore(loss).commitRun(operation);
      const recovered = await writer.inspect(), manifest = await Backup.capture(provider);
      assert.equal(recovered.allocated_bytes, held.allocated_bytes, 'exact recovery never spends the reservation twice');
      assert.equal(manifest.root.state_version, 2);
      const copied = await independentCopy(provider);
      assert.equal((await Backup.verifyRestore(manifest, copied, {recoveryIdentity:copied.identity})).restore_verified, true);
    }
  });

  console.log('bounded-backup: ' + passed + ' passed, ' + failed + ' failed; offline fixtures only, no live/provider qualification');
  if (failed) process.exitCode = 1;
})().catch(error => { console.error(error); process.exitCode = 1; });
