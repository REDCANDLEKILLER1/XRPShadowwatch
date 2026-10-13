'use strict';
// Read-only, source-typed bounded namespace verification. No upload, restore
// write, deletion, runtime enablement, admission or CAS qualification exists
// here. A seal detects altered records; it is not a signature or proof that a
// supplied JSON record actually came from a provider. Only capture/verifyRestore
// perform provider reads. Legacy Git history needs its own independent backup.
const crypto = require('crypto');
const zlib = require('zlib');
const Store = require('./bounded-store');
const State = require('./evidence-state');
const Journal = require('./run-journal');
const PREFIX = Store.PREFIX, ROOT = Store.ROOT;
const MANIFEST_SCHEMA = 'shadowwatch-bounded-backup-manifest/1';
const RESTORE_SCHEMA = 'shadowwatch-bounded-independent-restore/1';
const SOURCE_TYPE = 'bounded-object-store';
const HEX = /^[a-f0-9]{64}$/;
const sha256 = b => crypto.createHash('sha256').update(b).digest('hex');
function fail(code) { const e = new Error(code); e.code = code; throw e; }
function record(value) { return value !== null && typeof value === 'object' && !Array.isArray(value) && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null); }
function exact(value, keys, code) {
  if (!record(value) || Object.keys(value).sort().join('|') !== keys.slice().sort().join('|')) fail(code);
}
function canonical(value) {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return JSON.stringify(value);
  if (typeof value === 'number' && Number.isFinite(value)) return JSON.stringify(value);
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  if (record(value)) return '{' + Object.keys(value).sort().map(k => JSON.stringify(k) + ':' + canonical(value[k])).join(',') + '}';
  fail('BOUNDED_BACKUP_CANONICAL_VALUE_INVALID');
}
const digest = value => sha256(Buffer.from(canonical(value)));
function identity(value) {
  exact(value, ['backend','account','bucket','prefix'], 'BOUNDED_BACKUP_IDENTITY_INVALID');
  if (!['r2','memory'].includes(value.backend) || value.prefix !== PREFIX ||
      typeof value.account !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/.test(value.account) ||
      typeof value.bucket !== 'string' || !/^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/.test(value.bucket) ||
      value.backend === 'r2' && !/^[a-f0-9]{32}$/.test(value.account)) fail('BOUNDED_BACKUP_IDENTITY_INVALID');
  return { backend:value.backend, account:value.account, bucket:value.bucket, prefix:PREFIX };
}
function assertIdentity(provider, expected) {
  const actual = identity(provider && provider.identity);
  if (!provider || provider.prefix !== PREFIX || provider.rootKey !== ROOT || provider.kind !== actual.backend ||
      typeof provider.get !== 'function' || typeof provider.getVersioned !== 'function' || typeof provider.list !== 'function') fail('BOUNDED_BACKUP_PROVIDER_INVALID');
  if (expected !== undefined && canonical(identity(expected)) !== canonical(actual)) fail('BOUNDED_BACKUP_IDENTITY_MISMATCH');
  return actual;
}
function keyDigest(key) {
  if (key === ROOT) return null;
  const m = /^bounded\/v1\/(?:objects|permanent)\/([a-f0-9]{64})$/.exec(key) || /^bounded\/v1\/snapshots\/([a-f0-9]{64})\.json$/.exec(key);
  if (!m) fail('BOUNDED_BACKUP_KEY_INVALID');
  return m[1];
}
function etag(value) { if (typeof value !== 'string' || !/^"[\x21\x23-\x7e]{1,256}"$/.test(value)) fail('BOUNDED_BACKUP_ETAG_INVALID'); return value; }
function readRoot(value) {
  if (!value || !Buffer.isBuffer(value.bytes)) fail('BOUNDED_BACKUP_ROOT_MISSING');
  etag(value.etag);
  const root = parse(value.bytes);
  if (root.pending) fail('BOUNDED_BACKUP_PENDING_ROOT_BLOCKED');
  return { bytes:Buffer.from(value.bytes), etag:value.etag, root };
}
function parse(bytes) {
  try { const value = JSON.parse(bytes.toString('utf8')); if (!record(value)) fail('BOUNDED_BACKUP_JSON_INVALID'); return value; }
  catch (_) { fail('BOUNDED_BACKUP_JSON_INVALID'); }
}
function inventoryRows(rows) {
  if (!Array.isArray(rows) || !rows.length) fail('BOUNDED_BACKUP_INVENTORY_REQUIRED');
  const seen = new Set();
  const result = rows.map(row => {
    exact(row, ['key','size','etag',...(Object.hasOwn(row,'last_modified')?['last_modified']:[])], 'BOUNDED_BACKUP_LIST_ENTRY_INVALID');
    if (Object.hasOwn(row,'last_modified') && (typeof row.last_modified !== 'string' || !Number.isFinite(Date.parse(row.last_modified)) || new Date(row.last_modified).toISOString() !== row.last_modified)) fail('BOUNDED_BACKUP_TIMESTAMP_INVALID');
    keyDigest(row.key); etag(row.etag);
    if (!Number.isSafeInteger(row.size) || row.size < 0 || seen.has(row.key)) fail('BOUNDED_BACKUP_INVENTORY_INVALID');
    seen.add(row.key); return { key:row.key, size:row.size, etag:row.etag, ...(Object.hasOwn(row,'last_modified')?{last_modified:row.last_modified}:{}) };
  }).sort((a,b) => a.key < b.key ? -1 : a.key > b.key ? 1 : 0);
  if (!seen.has(ROOT)) fail('BOUNDED_BACKUP_ROOT_NOT_LISTED');
  return result;
}
function verifyBytes(bytes, entry) {
  if (!Buffer.isBuffer(bytes) || bytes.length !== entry.size) fail('BOUNDED_BACKUP_OBJECT_MISSING_OR_LENGTH');
  const actual = sha256(bytes), named = keyDigest(entry.key);
  if (named && actual !== named || entry.sha256 && actual !== entry.sha256) fail('BOUNDED_BACKUP_OBJECT_HASH_MISMATCH');
  return actual;
}
function stateValid(state) {
  if (!record(state) || !Number.isSafeInteger(state.state_version) || state.state_version < 1 || !HEX.test(state.state_sha256 || '') ||
      !Array.isArray(state.wallets) || !Array.isArray(state.evidence_shards) || !State.verify(state).ok) fail('BOUNDED_BACKUP_STATE_INVALID');
}
// Proofs carry schema-owned logical shard edges even when no published root
// owns the proof. Only the exact imported checkpoint may name legacy Git
// shards; an unrelated/older orphan proof cannot borrow that exemption.
function proofReferences(value, boundary) {
  if (!record(value)) fail('BOUNDED_BACKUP_PROOF_INVALID');
  const isState = value.schema === State.SCHEMA;
  if (!isState && !Object.hasOwn(value,'evidence_shards') && !Object.hasOwn(value,'input_digest')) return null;
  if (isState) stateValid(value);
  else if (!/^SW-\d{8}-[A-Z0-9]{5}$/.test(value.report_id || '') || !HEX.test(value.input_digest || '') ||
      !HEX.test(value.state_sha256 || '') || !Number.isSafeInteger(value.state_version) || !Array.isArray(value.evidence_shards)) fail('BOUNDED_BACKUP_RUN_PROOF_INVALID');
  if (isState && value.state_version === boundary.state_version && value.state_sha256 === boundary.state_sha256) return [];
  if (value.state_version <= boundary.state_version) fail('BOUNDED_BACKUP_PROOF_LEGACY_BOUNDARY_INVALID');
  const paths = new Set();
  return value.evidence_shards.map(shard => {
    if (!record(shard) || !HEX.test(shard.sha256 || '') || typeof shard.path !== 'string' ||
        !(shard.rows === null || Number.isSafeInteger(shard.rows) && shard.rows >= 0)) fail('BOUNDED_BACKUP_PROOF_SHARD_INVALID');
    const match = /^evidence\/(\d{4})\/(\d{2})\/(\d{2})\/(events|participants|payloads)\.([a-f0-9]{64})\.ndjson\.gz$/.exec(shard.path);
    if (!match || match[5] !== shard.sha256 || paths.has(shard.path)) fail('BOUNDED_BACKUP_PROOF_SHARD_INVALID');
    const day = match.slice(1,4).join('-'); Store.dayMs(day);
    if (day < boundary.cutover_day) fail('BOUNDED_BACKUP_PROOF_LEGACY_BOUNDARY_INVALID');
    paths.add(shard.path);
    return {key:PREFIX+'objects/'+shard.sha256,sha256:shard.sha256,rows:shard.rows};
  });
}
function rootValid(root) {
  if (!record(root) || root.schema !== Store.SCHEMA || root.pending || !Number.isSafeInteger(root.revision) || root.revision < 2 ||
      !/^[a-f0-9]{40}$/.test(root.legacy_ref || '') || !record(root.budgets) ||
      !['days','frozen','files','daily','flags','state_snapshots'].every(k => record(root[k]))) fail('BOUNDED_BACKUP_ROOT_INVALID');
  Store.dayMs(root.cutover_day); stateValid(root.state);
  for (const k of ['active','total','root']) if (!Number.isSafeInteger(root.budgets[k]) || root.budgets[k] < 1) fail('BOUNDED_BACKUP_ROOT_INVALID');
  for (const k of ['active_bytes','allocated_bytes']) if (!Number.isSafeInteger(root[k]) || root[k] < 0) fail('BOUNDED_BACKUP_ROOT_INVALID');
  if (!record(root.coverage_cutoff) || typeof root.coverage_cutoff.anchor_close !== 'string' || root.coverage_cutoff.anchor_close.slice(0,10) !== root.cutover_day) fail('BOUNDED_BACKUP_ROOT_INVALID');
}
// Validate all snapshot graphs, including orphan snapshots; every inventoried
// byte is verified separately. JSON/proof/shard reads are bounded one object at
// a time, rather than buffering the entire (potentially GiB-sized) namespace.
async function verifyGraph(provider, objects, currentRoot) {
  const byKey = new Map(objects.map(o => [o.key,o]));
  const checkedDays = new Set(), checkedPairs = new Set(), checkedRows = new Set();
  async function get(key) {
    const entry = byKey.get(key); if (!entry) fail('BOUNDED_BACKUP_REFERENCE_MISSING');
    const bytes = await provider.get(key); verifyBytes(bytes,entry); return bytes;
  }
  function reference(ref) {
    exact(ref,['key','size','sha256'],'BOUNDED_BACKUP_REFERENCE_INVALID');
    const entry = byKey.get(ref.key);
    if (ref.key === ROOT || !HEX.test(ref.sha256 || '') || !entry || ref.size !== entry.size || ref.sha256 !== entry.sha256 || keyDigest(ref.key) !== ref.sha256) fail('BOUNDED_BACKUP_REFERENCE_MISMATCH');
    return ref.key;
  }
  async function rows(ref, expectedRows, proof = false) {
    const key = reference(ref), token = key + ':' + expectedRows;
    if (!(proof && expectedRows === null) && (!Number.isSafeInteger(expectedRows) || expectedRows < 0)) fail('BOUNDED_BACKUP_ROWS_INVALID');
    if (checkedRows.has(token)) return;
    let lines;
    try { lines = zlib.gunzipSync(await get(key), { maxOutputLength:256*1024*1024 }).toString('utf8').split('\n').filter(Boolean); lines.forEach(line => JSON.parse(line)); }
    catch (_) { fail('BOUNDED_BACKUP_SHARD_INVALID'); }
    if (expectedRows !== null && lines.length !== expectedRows) fail('BOUNDED_BACKUP_ROWS_MISMATCH');
    checkedRows.add(token);
  }
  async function dayManifest(manifest, day) {
    if (!record(manifest) || !Array.isArray(manifest.shards) || !Number.isSafeInteger(manifest.state_version) || !HEX.test(manifest.state_sha256 || '')) fail('BOUNDED_BACKUP_DAY_INVALID');
    const paths = new Set();
    for (const shard of manifest.shards) {
      if (!record(shard) || !['events','participants','payloads'].includes(shard.kind) || !HEX.test(shard.sha256 || '') ||
          shard.path !== 'evidence/' + day.replaceAll('-','/') + '/' + shard.kind + '.' + shard.sha256 + '.ndjson.gz' ||
          paths.has(shard.path) || !Array.isArray(shard.corrections) || shard.object?.sha256 !== shard.sha256) fail('BOUNDED_BACKUP_SHARD_REFERENCE_INVALID');
      paths.add(shard.path); await rows(shard.object,shard.rows);
    }
  }
  const bootstrapPaths = Object.keys(currentRoot.files).filter(path => /^evidence\/state\/history\/\d{8,}\.json$/.test(path))
    .sort((a,b) => Number(a.split('/').at(-1).slice(0,-5))-Number(b.split('/').at(-1).slice(0,-5)));
  if (!bootstrapPaths.length) fail('BOUNDED_BACKUP_STATE_HISTORY_MISSING');
  const bootstrap = parse(await get(reference(currentRoot.files[bootstrapPaths[0]]))); stateValid(bootstrap);
  const boundary = {state_version:bootstrap.state_version,state_sha256:bootstrap.state_sha256,cutover_day:currentRoot.cutover_day};
  async function proof(value) {
    for (const ref of proofReferences(value,boundary) || []) {
      const entry = byKey.get(ref.key);
      if (!entry || entry.sha256 !== ref.sha256) fail('BOUNDED_BACKUP_PROOF_SHARD_MISSING');
      await rows({key:ref.key,sha256:ref.sha256,size:entry.size},ref.rows,true);
    }
  }
  async function rootGraph(root) {
    rootValid(root);
    if (root.legacy_ref !== currentRoot.legacy_ref || root.cutover_day !== currentRoot.cutover_day || canonical(root.coverage_cutoff) !== canonical(currentRoot.coverage_cutoff)) fail('BOUNDED_BACKUP_LEGACY_BOUNDARY_MISMATCH');
    const histories = [];
    for (const [path,ref] of Object.entries(root.files)) {
      const key = reference(ref);
      const m = /^evidence\/state\/history\/(\d{8,})\.json$/.exec(path);
      if (m) histories.push({version:Number(m[1]),key});
      else if (/^evidence\/runs\/SW-\d{8}-[A-Z0-9]{5}\.json$/.test(path)) {
        const run = parse(await get(key));
        if (path !== 'evidence/runs/' + run.report_id + '.json' || !HEX.test(run.input_digest || '') || !HEX.test(run.state_sha256 || '') || !Number.isSafeInteger(run.state_version)) fail('BOUNDED_BACKUP_RUN_PROOF_INVALID');
        await proof(run);
      } else if (!/^evidence\/runs\/resume\/SW-\d{8}-[A-Z0-9]{5}-[a-f0-9]{64}\.ndjson\.gz$/.test(path)) fail('BOUNDED_BACKUP_LOGICAL_PATH_INVALID');
    }
    histories.sort((a,b) => a.version-b.version);
    if (!histories.length) fail('BOUNDED_BACKUP_STATE_HISTORY_MISSING');
    let prior = null;
    for (const h of histories) {
      const state = parse(await get(h.key)); stateValid(state); await proof(state);
      if (state.state_version !== h.version || prior && !checkedPairs.has(prior.state_sha256 + ':' + state.state_sha256) && !State.verify(state,prior).ok) fail('BOUNDED_BACKUP_STATE_CHAIN_INVALID');
      if (prior) checkedPairs.add(prior.state_sha256 + ':' + state.state_sha256);
      prior = state;
    }
    if (prior.state_sha256 !== root.state.state_sha256 || canonical(prior) !== canonical(root.state)) fail('BOUNDED_BACKUP_CURRENT_STATE_MISMATCH');
    const first = parse(await get(histories[0].key));
    if (first.state_sha256 !== bootstrap.state_sha256 || first.anchor_ledger !== root.coverage_cutoff.anchor_ledger || first.anchor_close !== root.coverage_cutoff.anchor_close) fail('BOUNDED_BACKUP_BOOTSTRAP_STATE_MISMATCH');
    for (const [hash,ref] of Object.entries(root.state_snapshots)) {
      if (!HEX.test(hash) || typeof ref !== 'string' || !/^bounded:[a-f0-9]{64}$/.test(ref)) fail('BOUNDED_BACKUP_SNAPSHOT_REFERENCE_INVALID');
      const snapshot = parse(await get(PREFIX + 'snapshots/' + ref.slice(8) + '.json'));
      if (snapshot.state?.state_sha256 !== hash || snapshot.state.state_version >= root.state.state_version) fail('BOUNDED_BACKUP_SNAPSHOT_STATE_MISMATCH');
    }
    for (const [day,manifest] of Object.entries(root.days)) { Store.dayMs(day); if (root.frozen[day] || day < root.cutover_day) fail('BOUNDED_BACKUP_DAY_INVALID'); await dayManifest(manifest,day); }
    for (const [day,ref] of Object.entries(root.frozen)) {
      Store.dayMs(day); const key = reference(ref), token = day + ':' + key;
      if (day < root.cutover_day) fail('BOUNDED_BACKUP_DAY_INVALID');
      if (!checkedDays.has(token)) { await dayManifest(parse(await get(key)),day); checkedDays.add(token); }
    }
    for (const [day,ref] of Object.entries(root.daily)) {
      Store.dayMs(day); const value = parse(await get(reference(ref)));
      if (value.day !== day || !HEX.test(value.state_sha256 || '') || !Number.isSafeInteger(value.observed_transactions) || value.observed_transactions < 0) fail('BOUNDED_BACKUP_ROLLUP_INVALID');
    }
    for (const [hash,ref] of Object.entries(root.flags)) {
      const value = parse(await get(reference(ref)));
      if (!HEX.test(hash) || value.hash !== hash || value.event?.hash !== hash || value.payload?.hash !== hash || !Array.isArray(value.participants) || !HEX.test(value.state_sha256 || '')) fail('BOUNDED_BACKUP_FLAG_INVALID');
    }
    if (root.journal !== null) {
      if (!Journal.usable(root.journal).ok) fail('BOUNDED_BACKUP_JOURNAL_INVALID');
      const paths = new Set();
      for (const shard of root.journal.row_shards) {
        const ref = root.files[shard.path];
        if (!ref || ref.sha256 !== shard.sha256 || paths.has(shard.path)) fail('BOUNDED_BACKUP_JOURNAL_REFERENCE_INVALID');
        paths.add(shard.path); await rows(ref,shard.rows);
      }
    }
    return histories[0].version;
  }
  const firstStateVersion = await rootGraph(currentRoot);
  for (const entry of objects) {
    if (entry.key.startsWith(PREFIX+'snapshots/')) await rootGraph(parse(await get(entry.key)));
    else if (entry.key.startsWith(PREFIX+'permanent/')) {
      const value = parse(await get(entry.key));
      await proof(value);
      // Orphan frozen manifests still own raw shards even when no root does.
      if (Array.isArray(value.shards)) {
        for (const shard of value.shards) {
          if (!shard.object || shard.sha256 !== shard.object.sha256) fail('BOUNDED_BACKUP_SHARD_REFERENCE_INVALID');
          await rows(shard.object,shard.rows);
        }
      }
    }
  }
  return firstStateVersion;
}
function rootSummary(rootRead) {
  const { root,bytes,etag:tag } = rootRead;
  return { key:ROOT,size:bytes.length,sha256:sha256(bytes),etag:tag,revision:root.revision,state_version:root.state.state_version,state_sha256:root.state.state_sha256,legacy_ref:root.legacy_ref };
}
async function scan(provider, expectedIdentity) {
  const source = assertIdentity(provider,expectedIdentity);
  const before = readRoot(await provider.getVersioned(ROOT)); rootValid(before.root);
  const listedBefore = inventoryRows(await provider.list(PREFIX));
  const objects = [];
  for (const entry of listedBefore) {
    const bytes = await provider.get(entry.key), hash = verifyBytes(bytes,entry);
    if (entry.key === ROOT && (!bytes.equals(before.bytes) || entry.etag !== before.etag)) fail('BOUNDED_BACKUP_ROOT_CHANGED');
    objects.push({ key:entry.key,size:entry.size,sha256:hash,...(Object.hasOwn(entry,'last_modified')?{last_modified:entry.last_modified}:{}) });
  }
  const snapshot = byDigest => PREFIX+'snapshots/'+byDigest+'.json';
  if (!objects.some(o => o.key === snapshot(sha256(before.bytes)) && o.size === before.bytes.length)) fail('BOUNDED_BACKUP_CURRENT_SNAPSHOT_MISSING');
  const firstStateVersion = await verifyGraph(provider,objects,before.root);
  const listedAfter = inventoryRows(await provider.list(PREFIX));
  if (canonical(listedBefore) !== canonical(listedAfter)) fail('BOUNDED_BACKUP_INVENTORY_CHANGED');
  const after = readRoot(await provider.getVersioned(ROOT));
  if (before.etag !== after.etag || !before.bytes.equals(after.bytes)) fail('BOUNDED_BACKUP_ROOT_CHANGED');
  assertIdentity(provider,source);
  const total = objects.reduce((n,o) => n+o.size,0);
  if (!Number.isSafeInteger(total)) fail('BOUNDED_BACKUP_TOTAL_INVALID');
  return { source,root:rootSummary(before),objects,total,firstStateVersion };
}
async function capture(provider, options={}) {
  exact(options,Object.hasOwn(options,'sourceIdentity') ? ['sourceIdentity'] : [],'BOUNDED_BACKUP_OPTIONS_INVALID');
  const found = await scan(provider,options.sourceIdentity);
  const body = { schema:MANIFEST_SCHEMA,source_type:SOURCE_TYPE,source:found.source,root:found.root,
    inventory:{method:'provider-list-and-read-twice-stable/1',objects:found.objects,object_count:found.objects.length,total_bytes:found.total,sha256:digest(found.objects)},
    coverage:{namespace:PREFIX,inventory_scope:'all-current-keys',historical_object_versions:'excluded',recursive_references_verified:true,first_bounded_state_version:found.firstStateVersion,last_bounded_state_version:found.root.state_version,legacy_git_history:'excluded-requires-separate-backup'},
    qualification:{scope:'bounded-namespace-only',provider_kind:found.source.backend,production_qualified:false} };
  const manifest = {...body,manifest_sha256:digest(body)};
  assertManifest(manifest); return manifest;
}
function assertManifest(manifest) {
  exact(manifest,['schema','source_type','source','root','inventory','coverage','qualification','manifest_sha256'],'BOUNDED_BACKUP_MANIFEST_INVALID');
  if (manifest.schema !== MANIFEST_SCHEMA || manifest.source_type !== SOURCE_TYPE) fail('BOUNDED_BACKUP_SOURCE_TYPE_INVALID');
  const source = identity(manifest.source), r = manifest.root, inv = manifest.inventory, c = manifest.coverage, q = manifest.qualification;
  exact(r,['key','size','sha256','etag','revision','state_version','state_sha256','legacy_ref'],'BOUNDED_BACKUP_MANIFEST_ROOT_INVALID');
  if (r.key !== ROOT || !Number.isSafeInteger(r.size) || r.size < 1 || !HEX.test(r.sha256 || '') || !HEX.test(r.state_sha256 || '') ||
      !Number.isSafeInteger(r.revision) || r.revision < 2 || !Number.isSafeInteger(r.state_version) || r.state_version < 1 || !/^[a-f0-9]{40}$/.test(r.legacy_ref || '')) fail('BOUNDED_BACKUP_MANIFEST_ROOT_INVALID');
  etag(r.etag);
  exact(inv,['method','objects','object_count','total_bytes','sha256'],'BOUNDED_BACKUP_MANIFEST_INVENTORY_INVALID');
  if (inv.method !== 'provider-list-and-read-twice-stable/1' || !Array.isArray(inv.objects) || !inv.objects.length || inv.object_count !== inv.objects.length) fail('BOUNDED_BACKUP_MANIFEST_INVENTORY_INVALID');
  let previous = '',total = 0;
  for (const o of inv.objects) {
    exact(o,['key','size','sha256',...(Object.hasOwn(o,'last_modified')?['last_modified']:[])],'BOUNDED_BACKUP_MANIFEST_OBJECT_INVALID');
    if (Object.hasOwn(o,'last_modified') && (typeof o.last_modified !== 'string' || !Number.isFinite(Date.parse(o.last_modified)) || new Date(o.last_modified).toISOString() !== o.last_modified)) fail('BOUNDED_BACKUP_TIMESTAMP_INVALID');
    const named = keyDigest(o.key);
    if (typeof o.key !== 'string' || o.key <= previous || !Number.isSafeInteger(o.size) || o.size < 0 || !HEX.test(o.sha256 || '') || named && named !== o.sha256) fail('BOUNDED_BACKUP_MANIFEST_OBJECT_INVALID');
    previous = o.key; total += o.size;
  }
  const root = inv.objects.find(o => o.key === ROOT), snap = inv.objects.find(o => o.key === PREFIX+'snapshots/'+r.sha256+'.json');
  if (!root || root.size !== r.size || root.sha256 !== r.sha256 || !snap || snap.size !== r.size || !Number.isSafeInteger(total) || inv.total_bytes !== total || inv.sha256 !== digest(inv.objects)) fail('BOUNDED_BACKUP_MANIFEST_INVENTORY_INVALID');
  exact(c,['namespace','inventory_scope','historical_object_versions','recursive_references_verified','first_bounded_state_version','last_bounded_state_version','legacy_git_history'],'BOUNDED_BACKUP_MANIFEST_COVERAGE_INVALID');
  if (c.namespace !== PREFIX || c.inventory_scope !== 'all-current-keys' || c.historical_object_versions !== 'excluded' || c.recursive_references_verified !== true || !Number.isSafeInteger(c.first_bounded_state_version) || c.first_bounded_state_version < 1 || c.last_bounded_state_version !== r.state_version || c.first_bounded_state_version > c.last_bounded_state_version || c.legacy_git_history !== 'excluded-requires-separate-backup') fail('BOUNDED_BACKUP_MANIFEST_COVERAGE_INVALID');
  exact(q,['scope','provider_kind','production_qualified'],'BOUNDED_BACKUP_MANIFEST_QUALIFICATION_INVALID');
  if (q.scope !== 'bounded-namespace-only' || q.provider_kind !== source.backend || q.production_qualified !== false) fail('BOUNDED_BACKUP_MANIFEST_QUALIFICATION_INVALID');
  const {manifest_sha256:seal,...body} = manifest;
  if (!HEX.test(seal || '') || seal !== digest(body)) fail('BOUNDED_BACKUP_MANIFEST_SEAL_INVALID');
  return manifest;
}
function verifyManifest(manifest) {
  try { assertManifest(manifest); return {ok:true,problems:[],qualification:'recorded-manifest-only',provider_inventory_verified:false}; }
  catch (error) { return {ok:false,problems:[error.code || 'BOUNDED_BACKUP_MANIFEST_INVALID'],qualification:'unverified',provider_inventory_verified:false}; }
}
async function verifyRestore(manifest, recoveryProvider, options={}) {
  assertManifest(manifest);
  exact(options,['recoveryIdentity'],'BOUNDED_BACKUP_RECOVERY_IDENTITY_REQUIRED');
  const recovery = assertIdentity(recoveryProvider,options.recoveryIdentity);
  if (canonical(recovery) === canonical(manifest.source)) fail('BOUNDED_BACKUP_INDEPENDENT_DESTINATION_REQUIRED');
  if (recovery.backend === manifest.source.backend && recovery.account === manifest.source.account) fail('BOUNDED_BACKUP_INDEPENDENT_FAILURE_DOMAIN_REQUIRED');
  const found = await scan(recoveryProvider,recovery);
  // ETags describe a provider observation, not portable object content.
  const portableRoot = ({etag:_etag,...rest}) => rest;
  if (canonical(portableRoot(found.root)) !== canonical(portableRoot(manifest.root)) ||
      canonical(found.objects.map(({last_modified:_stamp,...o})=>o)) !== canonical(manifest.inventory.objects.map(({last_modified:_stamp,...o})=>o)) || found.firstStateVersion !== manifest.coverage.first_bounded_state_version) fail('BOUNDED_BACKUP_RESTORE_MISMATCH');
  const body = {schema:RESTORE_SCHEMA,source_type:SOURCE_TYPE,source:identity(manifest.source),recovery,
    manifest_sha256:manifest.manifest_sha256,inventory_sha256:manifest.inventory.sha256,root_sha256:manifest.root.sha256,
    root_revision:manifest.root.revision,state_sha256:manifest.root.state_sha256,state_version:manifest.root.state_version,legacy_ref:manifest.root.legacy_ref,
    object_count:found.objects.length,total_bytes:found.total,verification_method:'independent-provider-list-and-byte-read/1',restore_verified:true,independent_copy_verified:true,independent_provider_verified:true,
    qualification:{scope:'bounded-namespace-only',inventory_scope:'all-current-keys',historical_object_versions:'excluded',source_kind:manifest.source.backend,recovery_kind:recovery.backend,legacy_git_history:'excluded-requires-separate-backup',production_qualified:false}};
  const receipt = {...body,receipt_sha256:digest(body)};
  assertReceipt(receipt,manifest); return receipt;
}
function assertReceipt(receipt, manifest) {
  exact(receipt,['schema','source_type','source','recovery','manifest_sha256','inventory_sha256','root_sha256','root_revision','state_sha256','state_version','legacy_ref','object_count','total_bytes','verification_method','restore_verified','independent_copy_verified','independent_provider_verified','qualification','receipt_sha256'],'BOUNDED_BACKUP_RECEIPT_INVALID');
  if (receipt.schema !== RESTORE_SCHEMA || receipt.source_type !== SOURCE_TYPE) fail('BOUNDED_BACKUP_SOURCE_TYPE_INVALID');
  const source = identity(receipt.source), recovery = identity(receipt.recovery), q = receipt.qualification;
  if (source.backend === recovery.backend && source.account === recovery.account) fail('BOUNDED_BACKUP_INDEPENDENT_FAILURE_DOMAIN_REQUIRED');
  for (const key of ['manifest_sha256','inventory_sha256','root_sha256','state_sha256','receipt_sha256']) if (!HEX.test(receipt[key] || '')) fail('BOUNDED_BACKUP_RECEIPT_INVALID');
  for (const key of ['root_revision','state_version','object_count']) if (!Number.isSafeInteger(receipt[key]) || receipt[key] < 1) fail('BOUNDED_BACKUP_RECEIPT_INVALID');
  if (!/^[a-f0-9]{40}$/.test(receipt.legacy_ref || '') || !Number.isSafeInteger(receipt.total_bytes) || receipt.total_bytes < 1 || receipt.root_revision < 2 || receipt.verification_method !== 'independent-provider-list-and-byte-read/1' || receipt.restore_verified !== true || receipt.independent_copy_verified !== true || receipt.independent_provider_verified !== true) fail('BOUNDED_BACKUP_RECEIPT_INVALID');
  exact(q,['scope','inventory_scope','historical_object_versions','source_kind','recovery_kind','legacy_git_history','production_qualified'],'BOUNDED_BACKUP_RECEIPT_QUALIFICATION_INVALID');
  if (q.scope !== 'bounded-namespace-only' || q.inventory_scope !== 'all-current-keys' || q.historical_object_versions !== 'excluded' || q.source_kind !== source.backend || q.recovery_kind !== recovery.backend || q.legacy_git_history !== 'excluded-requires-separate-backup' || q.production_qualified !== false) fail('BOUNDED_BACKUP_RECEIPT_QUALIFICATION_INVALID');
  const {receipt_sha256:seal,...body} = receipt;
  if (seal !== digest(body)) fail('BOUNDED_BACKUP_RECEIPT_SEAL_INVALID');
  if (manifest !== undefined) {
    assertManifest(manifest);
    if (canonical(source) !== canonical(manifest.source) || receipt.manifest_sha256 !== manifest.manifest_sha256 || receipt.inventory_sha256 !== manifest.inventory.sha256 || receipt.root_sha256 !== manifest.root.sha256 || receipt.root_revision !== manifest.root.revision || receipt.state_sha256 !== manifest.root.state_sha256 || receipt.state_version !== manifest.root.state_version || receipt.legacy_ref !== manifest.root.legacy_ref || receipt.object_count !== manifest.inventory.object_count || receipt.total_bytes !== manifest.inventory.total_bytes) fail('BOUNDED_BACKUP_RECEIPT_MANIFEST_MISMATCH');
  }
  return receipt;
}
function verifyReceipt(receipt, manifest) {
  try { assertReceipt(receipt,manifest); return {ok:true,problems:[],qualification:'recorded-receipt-only',provider_reads_verified:false}; }
  catch (error) { return {ok:false,problems:[error.code || 'BOUNDED_BACKUP_RECEIPT_INVALID'],qualification:'unverified',provider_reads_verified:false}; }
}
module.exports = {MANIFEST_SCHEMA,RESTORE_SCHEMA,SOURCE_TYPE,PREFIX,ROOT,canonical,digest,sha256,identity,assertIdentity,proofReferences,capture,verifyManifest,assertManifest,verifyRestore,assertReceipt,verifyReceipt};
