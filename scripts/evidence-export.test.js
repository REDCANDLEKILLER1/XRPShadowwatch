#!/usr/bin/env node
'use strict';
/* ── THE EXPORT IS THE THING THAT MAKES DELETION SAFE ───────────────────────
   "Do not delete Neon until the exported history is verified" is only a real
   instruction if verification is something a command can decide. So the
   properties under test are the ones that decision rests on:

     the same rows always produce the same bytes
     a tampered file is detectable
     a tampered MANIFEST is detectable, so it cannot vouch for tampered files
     nothing is silently dropped, misfiled, or counted twice
     the export never writes to the database it is reading
     the ledger payload is exported in its own shards, never inside an event

   No database, no network, no filesystem beyond a scratch directory.
──────────────────────────────────────────────────────────────────────────── */
const assert = require('assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const zlib = require('zlib');
const ROOT = path.join(__dirname, '..');
const X = require(path.join(ROOT, 'src/db/evidence-export.js'));

let pass = 0, fail = 0;
const check = (name, ok, detail) => {
  if (ok) { pass++; console.log('  PASS  ' + name); }
  else { fail++; console.log('  FAIL  ' + name + (detail !== undefined ? '  -> ' + JSON.stringify(detail) : '')); }
};

const EXPORTER = fs.readFileSync(path.join(ROOT, 'scripts/db-export-evidence.js'), 'utf8');
const VERIFIER = fs.readFileSync(path.join(ROOT, 'scripts/verify-evidence-export.js'), 'utf8');
const PUBLISHER = fs.readFileSync(path.join(ROOT, 'scripts/github-publish-export.js'), 'utf8');

const hash = n => String(n).padStart(64, 'A');
function dbRow(n, iso, extra) {
  return Object.assign({
    hash: hash(n), ledger_index: 100000 + n, close_time: iso, tx_type: 'Payment', tx_result: 'tesSUCCESS',
    validated: true, from_account: 'rFrom', to_account: 'rTo',
    // 1e17 drops is the XRP supply and past the exact range of a double.
    amount_drops: '100000000000000001', amount_value: null, currency: 'XRP', issuer: null,
    destination_tag: null, source_tag: null, sig_mode: 'single', signer_count: 1,
    escrow_owner: null, escrow_destination: null, escrow_amount_drops: null, fee_drops: '12',
    sequence: 5, tx_flags: 0, transaction_index: 3, roster_version: 'rh', first_seen_scan_id: 'idx-1',
    ingested_at: iso, evidence: { balance_deltas: [{ account: 'rFrom', prev: '20000000000000', final: '19999999999988' }] }
  }, extra || {});
}

console.log('\n1. the exported event keeps what evidence needs and nothing it must not');
const event = X.eventOf(dbRow(1, '2026-09-10T04:00:00.000Z'));
check('every declared key is present, in order',
  JSON.stringify(Object.keys(event)) === JSON.stringify(X.EVENT_KEYS), Object.keys(event));
// The payload is exported, but in its own shards — never folded into the
// event. That separation is what lets daily acquisition read events without
// dragging the largest part of the archive along with them.
check('an event carries no payload, however large the archive gets',
  event.raw_tx === undefined && event.raw_meta === undefined && !/raw_tx|raw_meta/.test(JSON.stringify(event)));
// Without the AccountRoot deltas the balance cross-check stops working against
// exported history the moment the payload expires, which is most of the point.
check('the AccountRoot balance deltas survive the export',
  event.evidence.balance_deltas[0].prev === '20000000000000');
check('drops stay decimal strings — an export that rounded evidence would be worse than none',
  event.amount_drops === '100000000000000001' && typeof event.amount_drops === 'string');
check('a ledger index is an integer, not a string', event.ledger_index === 100001);
check('close_time is normalized to ISO so two exports of one row cannot differ',
  event.close_time === '2026-09-10T04:00:00.000Z');
check('an absent tag stays null rather than becoming tag 0',
  X.eventOf(dbRow(2, '2026-09-10T04:00:00.000Z', { destination_tag: null })).destination_tag === null);
check('and a real tag 0 survives as 0',
  X.eventOf(dbRow(3, '2026-09-10T04:00:00.000Z', { destination_tag: 0 })).destination_tag === 0);

console.log('\n2. the same rows always produce the same bytes');
// Determinism is what lets a hash decide whether an archive is intact. If two
// honest exports of one database could differ, no hash could mean anything.
const rowsA = [dbRow(3, '2026-09-10T05:00:00.000Z'), dbRow(1, '2026-09-10T04:00:00.000Z'), dbRow(2, '2026-09-10T04:00:00.000Z')];
const rowsB = [dbRow(2, '2026-09-10T04:00:00.000Z'), dbRow(3, '2026-09-10T05:00:00.000Z'), dbRow(1, '2026-09-10T04:00:00.000Z')];
const textA = X.ndjson(rowsA.map(X.eventOf).sort(X.orderEvents));
const textB = X.ndjson(rowsB.map(X.eventOf).sort(X.orderEvents));
check('two orderings of the same rows serialize identically', textA === textB);
check('and hash identically', X.sha256(Buffer.from(textA)) === X.sha256(Buffer.from(textB)));
// close_time alone is not unique — a ledger closes many transactions at one
// instant — so the order must be total, not merely sorted.
check('rows sharing a close time are ordered by hash, so the order is total',
  textA.split('\n')[0].includes(hash(1)) && textA.split('\n')[1].includes(hash(2)));
check('NDJSON ends with a newline so shards concatenate into valid NDJSON',
  textA.endsWith('\n') && !textA.endsWith('\n\n'));
check('an empty day serializes to nothing rather than to a blank line', X.ndjson([]) === '');

console.log('\n3. days are the ledger\'s, not the exporter\'s');
// Re-running an export tomorrow has to produce the same paths, so the day
// comes from when the LEDGER closed and never from when the export ran.
check('an event is filed by its close time', X.dayOf('2026-09-10T23:59:59.999Z') === '2026-09-10');
check('and the day rolls at UTC midnight, not local', X.dayOf('2026-09-11T00:00:00.000Z') === '2026-09-11');
check('a missing close time yields no day rather than today', X.dayOf(null) === null && X.dayOf('nonsense') === null);
check('the path is the date, not a counter', X.dayPath('2026-09-10') === '2026/09/10');
check('the exporter derives the day from the row, never from the clock',
  /X\.dayOf\(event\.close_time\)/.test(EXPORTER));

console.log('\n4. sharding never loses or duplicates a row');
const many = Array.from({ length: 400 }, (_, i) => X.eventOf(dbRow(i, '2026-09-10T04:00:00.000Z'))).sort(X.orderEvents);
const shards = X.shard(many, 'evidence/2026/09/10/events.ndjson', 4000);
check('a large day is split into several shards', shards.length > 1, shards.length);
check('every row appears exactly once across the shards',
  shards.reduce((n, s) => n + s.records.length, 0) === many.length &&
  new Set(shards.flatMap(s => s.records.map(r => r.hash))).size === many.length);
check('order is preserved across the split',
  shards.flatMap(s => s.records.map(r => r.hash)).join(',') === many.map(r => r.hash).join(','));
check('shard paths are numbered and stable',
  shards[0].path === 'evidence/2026/09/10/events.001.ndjson' &&
  shards[1].path === 'evidence/2026/09/10/events.002.ndjson');
check('a day that fits keeps the unnumbered path',
  X.shard(many.slice(0, 2), 'evidence/2026/09/10/events.ndjson', 4000)[0].path === 'evidence/2026/09/10/events.ndjson');
check('every shard is under the cap', shards.slice(0, -1).every(s => Buffer.byteLength(s.text) <= 4000));
// An oversized single row is a problem to report, not to silently drop.
const huge = [X.eventOf(dbRow(1, '2026-09-10T04:00:00.000Z', { evidence: { pad: 'x'.repeat(9000) } }))];
// A row too big for the cap gets its own shard. Dropping it would be the
// worst outcome available: the manifest would still add up, and the row would
// simply not exist.
const hugeShards = X.shard(huge, 'evidence/2026/09/10/events.ndjson', 4000);
check('a single row larger than the cap is still exported, not dropped',
  hugeShards.length === 1 && hugeShards[0].records.length === 1,
  { shards: hugeShards.length, rows: hugeShards.reduce((n, s) => n + s.records.length, 0) });
check('sharding is deterministic — the same input splits the same way',
  JSON.stringify(X.shard(many, 'p.ndjson', 4000).map(s => s.records.length)) ===
  JSON.stringify(X.shard(many, 'p.ndjson', 4000).map(s => s.records.length)));

console.log('\n5. a tampered archive is detectable, manifest included');
const entry = X.fileEntry('evidence/2026/09/10/events.ndjson.gz', textA, 123, 'gzhash');
check('a file entry records the row count', entry.rows === 3, entry.rows);
check('and the ledger and time bounds it covers',
  entry.ledger_min === 100001 && entry.ledger_max === 100003 &&
  entry.close_min === '2026-09-10T04:00:00.000Z' && entry.close_max === '2026-09-10T05:00:00.000Z');
// Hashing the PLAINTEXT, not the gzip: a re-compression must never look like
// corruption, and corruption must never look like a re-compression.
check('the authoritative hash is over the plaintext, not the compressed bytes',
  entry.sha256 === X.sha256(Buffer.from(textA, 'utf8')) && entry.sha256 !== 'gzhash');
check('the compressed bytes are recorded separately, so corruption is distinguishable from a rewrite',
  entry.gz_sha256 === 'gzhash' && entry.gz_bytes === 123);
const tampered = textA.replace('100000000000000001', '100000000000000002');
check('changing one drop changes the hash', X.sha256(Buffer.from(tampered, 'utf8')) !== entry.sha256);

const manifest = X.sealManifest({ schema: X.SCHEMA, export_id: 'exp-1', totals: { events: 3 }, files: [entry] });
check('the manifest hashes itself', manifest.manifest_sha256 === X.manifestDigest(manifest));
const edited = { ...manifest, totals: { events: 4 } };
check('editing the manifest breaks its own hash — it cannot vouch for tampered files',
  X.manifestDigest(edited) !== edited.manifest_sha256);
const relabelled = { ...manifest, files: [{ ...entry, sha256: X.sha256(Buffer.from(tampered, 'utf8')) }] };
check('and rewriting a file hash inside the manifest breaks it too',
  X.manifestDigest(relabelled) !== relabelled.manifest_sha256);
check('the digest ignores only the digest field itself',
  X.manifestDigest(manifest) === X.manifestDigest({ ...manifest, manifest_sha256: 'anything' }));

console.log('\n6. the export reads, and only reads');
// It has to run on a project already over its storage quota. Neon blocks
// writes at the ceiling, not reads — so an export that wrote anything could
// not run when it is most needed, and pruning could never be made safe.
for (const [name, src] of [['exporter', EXPORTER], ['verifier', VERIFIER]]) {
  const body = src.split(/\n/).filter(l => !/^\s*\/\//.test(l)).join('\n');
  check(name + ' issues no INSERT, UPDATE or DELETE',
    !/\b(INSERT\s+INTO|UPDATE\s+\w+\s+SET|DELETE\s+FROM)\b/i.test(body));
  check(name + ' issues no DDL', !/\b(CREATE|ALTER|DROP|TRUNCATE)\s+(TABLE|INDEX|COLUMN)\b/i.test(body));
  check(name + ' never opens a write transaction', !/db\.transaction\s*\(/.test(body));
}
const EXPORTER_CODE = EXPORTER.split(/\n/).filter(l => !/^\s*\/\//.test(l)).join('\n');
check('the exporter streams by keyset, so a 300 MB store never lands in memory',
  /ORDER BY close_time,hash LIMIT/.test(EXPORTER_CODE) && !/\bOFFSET\b/i.test(EXPORTER_CODE));
check('and it flushes one day at a time rather than buffering the whole store',
  /flushDay/.test(EXPORTER) && /buffer = \[\]/.test(EXPORTER));
console.log('\n7. the payload is exported, in its own shards');
// It is the largest part of the store by a wide margin — 186 MB against ~105 MB
// for everything else. Keeping it in separate files is what lets daily
// acquisition never read it, while it stays in the repository for a classifier
// that does not exist yet.
const EVENT_COLUMN_LIST = (EXPORTER_CODE.match(/const EVENT_COLUMNS = `([\s\S]*?)`/) || ['', ''])[1];
check('the event column list names every exported field and no payload column',
  /\bevidence\b/.test(EVENT_COLUMN_LIST) && !/raw_tx|raw_meta/.test(EVENT_COLUMN_LIST),
  EVENT_COLUMN_LIST.slice(0, 80));
const payload = X.payloadOf({ hash: hash(1), raw_tx: { TransactionType: 'Payment', Amount: '1' },
  raw_meta: { TransactionResult: 'tesSUCCESS' } });
check('a payload record carries both halves and its hash',
  payload.hash === hash(1) && payload.raw_tx.Amount === '1' &&
  payload.raw_meta.TransactionResult === 'tesSUCCESS');
check('the payload is NOT folded into the event record',
  X.EVENT_KEYS.indexOf('raw_tx') < 0 && X.EVENT_KEYS.indexOf('raw_meta') < 0);
check('the exporter writes payloads to their own path', /'\/payloads\.ndjson'/.test(EXPORTER));
// A row whose payload has already expired under the 48h policy is absent, not
// a line of nulls: that is the policy working, and padding the archive with
// empty records would make expiry indistinguishable from a gap.
check('a row with no payload is left out rather than written as nulls',
  X.hasPayload(X.payloadOf({ hash: hash(2) })) === false && X.hasPayload(payload) === true &&
  /\.filter\(X\.hasPayload\)/.test(EXPORTER));
check('payloads are ordered by hash, so the shard is deterministic',
  [{ hash: 'B' }, { hash: 'A' }].sort(X.orderPayloads)[0].hash === 'A');
// Both schemas: before 005 the payload is two columns on `transactions`, after
// it a table with an expiry. Neither is required to be present.
check('the exporter reads the payload from whichever schema is in place',
  /transaction_raw x JOIN transactions t/.test(EXPORTER) &&
  /hasRaw \? ',raw_tx,raw_meta' : ''/.test(EXPORTER));
check('the manifest records that payloads are included, and from where',
  /payloads_exported: true/.test(EXPORTER) && /payloads_source:/.test(EXPORTER));
check('and the verifier requires the archive to declare it either way',
  /typeof manifest\.source\.payloads_exported === 'boolean'/.test(VERIFIER));
// A payload belongs to an event. More payloads than events in a day would mean
// the archive holds a payload for something it does not record happening.
check('the verifier refuses a day holding more payloads than events',
  /no day holds more payloads than events/.test(VERIFIER));
check('and it counts payload shards separately from the other two',
  /isPayloads/.test(VERIFIER) && /payloads === \(manifest\.totals\.payloads \|\| 0\)/.test(VERIFIER));

console.log('\n8. publishing refuses what it cannot verify, and is resumable');
const UPLOAD_AT = PUBLISHER.indexOf('A.commitFiles(');
check('the publisher re-checks the manifest digest before uploading anything',
  /MANIFEST_EDITED/.test(PUBLISHER) && UPLOAD_AT > 0 &&
  PUBLISHER.indexOf('MANIFEST_EDITED') < UPLOAD_AT);
check('it re-checks every file hash before uploading anything',
  /EXPORT_CORRUPT/.test(PUBLISHER) && PUBLISHER.indexOf('EXPORT_CORRUPT') < UPLOAD_AT);
check('it computes git blob ids locally, so a re-run skips what is already there',
  /function blobSha/.test(PUBLISHER) && /existing\.get\(f\.target\) !== f\.sha/.test(PUBLISHER));
check('it refuses a blob GitHub would reject rather than failing mid-upload',
  /BLOB_TOO_LARGE/.test(PUBLISHER) && /MAX_BLOB_BYTES/.test(PUBLISHER));
check('it is a dry run unless --apply is given',
  /if \(!opts\.apply\)/.test(PUBLISHER) && /DRY RUN/.test(PUBLISHER));
check('it publishes under its own prefix and never into reports/',
  /'evidence-export\/' \+ manifest\.export_id/.test(PUBLISHER) && !/'reports\//.test(PUBLISHER));
check('it uses the same pinned target as the sealed-report archive',
  /A\.archiveTarget\(process\.env\)/.test(PUBLISHER) && !/SHADOWWATCH_GITHUB_ARCHIVE_REPOSITORY/.test(PUBLISHER));
const blobShaOf = (buf) => require('crypto').createHash('sha1')
  .update('blob ' + buf.length + '\0', 'utf8').update(buf).digest('hex');
check('the locally computed blob id is git\'s own object id',
  blobShaOf(Buffer.from('hello\n')) === 'ce013625030ba8dba906f756967f9e9ca394464a');

console.log('\n9. the archive round-trips through real files');
// The end-to-end property: write shards the way the exporter does, read them
// the way the verifier does, and get the same rows back.
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'sw-export-'));
try {
  const written = [];
  for (const piece of X.shard(many, 'evidence/2026/09/10/events.ndjson', 20000)) {
    const packed = zlib.gzipSync(Buffer.from(piece.text, 'utf8'), { level: 9 });
    const e = X.fileEntry(piece.path + '.gz', piece.text, packed.length, X.sha256(packed));
    const full = path.join(scratch, e.path);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, packed);
    written.push(e);
  }
  const recovered = [];
  for (const e of written) {
    const raw = fs.readFileSync(path.join(scratch, e.path));
    check('  ' + e.path + ' bytes match the manifest', X.sha256(raw) === e.gz_sha256);
    const text = zlib.gunzipSync(raw).toString('utf8');
    check('  ' + e.path + ' content hashes match after decompression',
      X.sha256(Buffer.from(text, 'utf8')) === e.sha256);
    for (const line of text.split('\n').filter(Boolean)) recovered.push(JSON.parse(line));
  }
  check('every row survives the round trip, in order and unchanged',
    recovered.length === many.length &&
    JSON.stringify(recovered) === JSON.stringify(many), { recovered: recovered.length, original: many.length });
  check('and the drops value is still exact after gzip and JSON',
    recovered[0].amount_drops === '100000000000000001');
  // Flip one byte in a compressed shard: it must not decompress, or must not
  // hash. Either is a detection; silently returning different data is not.
  const victim = path.join(scratch, written[0].path);
  const bytes = fs.readFileSync(victim);
  bytes[bytes.length - 8] ^= 0xff;
  fs.writeFileSync(victim, bytes);
  let detected = false;
  try {
    const text = zlib.gunzipSync(fs.readFileSync(victim)).toString('utf8');
    detected = X.sha256(Buffer.from(text, 'utf8')) !== written[0].sha256;
  } catch (_) { detected = true; }
  check('a single flipped byte in a shard is detected', detected);
} finally { fs.rmSync(scratch, { recursive: true, force: true }); }

console.log('\n10. verification is a decision, not a judgement');
check('the verifier exits non-zero on any failure',
  /if \(fail\) \{[\s\S]{0,200}?return finish\(1\)/.test(VERIFIER));
check('and says plainly that the source must not be deleted',
  /Do not prune or delete the source/.test(VERIFIER));
check('it compares against the live database unless --offline is asked for',
  /--offline/.test(VERIFIER) && /every transaction in the database is in the archive/.test(VERIFIER));
check('it treats a missing database as a failure, not as a pass',
  /a database is configured, or --offline was passed deliberately/.test(VERIFIER));
check('--deep compares the hash sets in both directions',
  /every hash in the database is in the archive/.test(VERIFIER) &&
  /the archive holds no hash the database does not/.test(VERIFIER));
check('it checks the proof field by field, not by count',
  /round-trips field for field/.test(VERIFIER));
check('the exporter refuses to report success if its own counts do not match the source',
  /ROW COUNTS DO NOT MATCH THE SOURCE/.test(EXPORTER));

console.log('\n' + (fail ? fail + ' FAILED of ' + (pass + fail) : 'ALL ' + pass + ' EVIDENCE EXPORT CHECKS PASS'));
process.exit(fail ? 1 : 0);
