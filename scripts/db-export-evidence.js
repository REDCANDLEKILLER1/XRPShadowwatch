#!/usr/bin/env node
'use strict';
// Export the forensic record out of Neon, into files that can be verified byte
// for byte and read without a database.
//
// THIS SCRIPT ONLY READS. It issues no INSERT, UPDATE, DELETE or DDL, which is
// also why it works on a project that is already over its storage quota: Neon
// blocks WRITES at the ceiling, not reads. So the export can run first, on the
// full database, and nothing has to be deleted to make room for it. That order
// matters — the export is what makes pruning safe, so it must not itself
// depend on having pruned.
//
// WHAT IT WRITES
//
//   manifest.json                              every file, its row count and its hashes
//   state/coverage.json                        the proof, one entry per wallet
//   state/runs.ndjson.gz                       the run audit
//   evidence/YYYY/MM/DD/events.ndjson.gz       slim events, by the day the LEDGER closed
//   evidence/YYYY/MM/DD/participants.ndjson.gz provenance, including observed_via
//
// WHAT IT DOES NOT WRITE
//
//   raw_tx / raw_meta. The payload is a 48-hour cache and a git repository is
//   permanent: ~300 MB of ledger payload would sit in every clone forever and
//   could not be removed without rewriting history for everyone. The manifest
//   records the omission explicitly so it reads as a decision.
//
// Memory: rows are streamed by keyset pagination and flushed one day at a
// time, so peak memory is one day of evidence rather than the whole store.
//
// Usage:
//   node scripts/db-export-evidence.js                 # dry run: counts and sizes only
//   node scripts/db-export-evidence.js --out export    # write the archive
//   node scripts/db-export-evidence.js --out export --batch 5000

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const { randomUUID } = require('crypto');
const db = require('../src/db/connection');
const X = require('../src/db/evidence-export');

const DEFAULT_BATCH = 5000;

function args(argv) {
  const out = { out: null, batch: DEFAULT_BATCH };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--out') out.out = argv[++i];
    else if (argv[i] === '--batch') out.batch = Number(argv[++i]);
  }
  if (!Number.isFinite(out.batch) || out.batch < 100) throw new Error('INVALID_BATCH: --batch must be at least 100');
  return out;
}

const mb = bytes => (bytes / (1024 * 1024)).toFixed(1) + ' MB';

// gzip at a fixed level. The plaintext hash in the manifest is the authority,
// so verification decompresses and compares that — it never depends on the
// compressor producing identical framing across versions.
function gz(text) { return zlib.gzipSync(Buffer.from(text, 'utf8'), { level: 9 }); }

function writeFile(root, relative, buffer) {
  const full = path.join(root, relative);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, buffer);
}

// Keyset pagination, ordered by the same total order the archive uses. OFFSET
// would re-scan the whole table for every page and, worse, can skip or repeat
// rows if anything writes concurrently.
async function* streamEvents(q, batch) {
  let afterTime = null, afterHash = null;
  for (;;) {
    const rows = (await q(
      `SELECT hash,ledger_index,close_time,tx_type,tx_result,validated,from_account,to_account,
              amount_drops,amount_value,currency,issuer,destination_tag,source_tag,sig_mode,signer_count,
              escrow_owner,escrow_destination,escrow_amount_drops,fee_drops,sequence,tx_flags,
              transaction_index,roster_version,first_seen_scan_id,ingested_at,evidence
         FROM transactions
        WHERE ($1::timestamptz IS NULL OR (close_time,hash) > ($1::timestamptz,$2::text))
        ORDER BY close_time,hash LIMIT $3`, [afterTime, afterHash, batch])).rows;
    if (!rows.length) return;
    for (const row of rows) yield row;
    afterTime = rows[rows.length - 1].close_time;
    afterHash = rows[rows.length - 1].hash;
  }
}

// Participants for one day's hashes. Joined through `transactions` so the day
// boundary is the LEDGER's, identical to the events shard beside it.
async function participantsForDay(q, day) {
  return (await q(
    `SELECT a.tx_hash,a.address,a.role
       FROM transaction_accounts a JOIN transactions t ON t.hash=a.tx_hash
      WHERE t.close_time >= $1::timestamptz AND t.close_time < ($1::timestamptz + interval '1 day')
      ORDER BY a.tx_hash,a.address,a.role`, [day])).rows;
}

async function main() {
  const opts = args(process.argv.slice(2));
  if (!db.isConfigured()) throw new Error('EVIDENCE_STORE_UNAVAILABLE: no database connection string configured');
  const q = db.getExecutor();

  const shape = (await q(`SELECT
    (SELECT count(*) FROM transactions)::bigint AS transactions,
    (SELECT count(*) FROM transaction_accounts)::bigint AS participants,
    (SELECT count(*) FROM wallet_coverage)::bigint AS wallets,
    (SELECT count(*) FROM scan_runs)::bigint AS runs,
    (SELECT min(close_time) FROM transactions) AS close_min,
    (SELECT max(close_time) FROM transactions) AS close_max,
    pg_total_relation_size('transactions') AS tx_bytes,
    pg_total_relation_size('transaction_accounts') AS pa_bytes,
    pg_database_size(current_database()) AS db_bytes,
    EXISTS(SELECT 1 FROM information_schema.columns
            WHERE table_name='transactions' AND column_name='raw_tx') AS has_raw`)).rows[0];

  console.log('EVIDENCE EXPORT');
  console.log('  database          ' + mb(Number(shape.db_bytes)));
  console.log('  transactions      ' + Number(shape.transactions).toLocaleString() + ' rows · ' + mb(Number(shape.tx_bytes)));
  console.log('  participants      ' + Number(shape.participants).toLocaleString() + ' rows · ' + mb(Number(shape.pa_bytes)));
  console.log('  wallets proven    ' + Number(shape.wallets).toLocaleString());
  console.log('  runs              ' + Number(shape.runs).toLocaleString());
  console.log('  window            ' + (shape.close_min ? new Date(shape.close_min).toISOString() : '(none)') +
    ' -> ' + (shape.close_max ? new Date(shape.close_max).toISOString() : '(none)'));
  console.log('  ledger payloads   ' + (shape.has_raw ? 'present, NOT exported (48h cache; git is permanent)' : 'already in transaction_raw, not exported'));
  console.log('  mode              ' + (opts.out ? 'WRITE -> ' + opts.out : 'DRY RUN (pass --out <dir> to write)'));

  const migrations = (await q('SELECT version FROM schema_migrations ORDER BY version')).rows.map(r => r.version);
  const files = [];
  let events = 0, participants = 0;

  // One day at a time. A day's events are ordered by the stream itself, so the
  // buffer only ever holds the day being flushed.
  let day = null, buffer = [];
  const flushDay = async () => {
    if (!day) return;
    const base = 'evidence/' + X.dayPath(day);
    for (const piece of X.shard(buffer, base + '/events.ndjson', X.MAX_SHARD_BYTES)) {
      const packed = gz(piece.text);
      const entry = X.fileEntry(piece.path + '.gz', piece.text, packed.length, X.sha256(packed));
      if (opts.out) writeFile(opts.out, entry.path, packed);
      files.push(entry); events += entry.rows;
    }
    const rows = (await participantsForDay(q, day)).map(X.participantOf).sort(X.orderParticipants);
    for (const piece of X.shard(rows, base + '/participants.ndjson', X.MAX_SHARD_BYTES)) {
      const packed = gz(piece.text);
      const entry = X.fileEntry(piece.path + '.gz', piece.text, packed.length, X.sha256(packed));
      if (opts.out) writeFile(opts.out, entry.path, packed);
      files.push(entry); participants += entry.rows;
    }
    process.stdout.write('  ' + day + '  ' + buffer.length.toLocaleString() + ' events, ' +
      rows.length.toLocaleString() + ' participants\n');
    buffer = [];
  };

  console.log('');
  for await (const row of streamEvents(q, opts.batch)) {
    const event = X.eventOf(row);
    const rowDay = X.dayOf(event.close_time);
    if (rowDay !== day) { await flushDay(); day = rowDay; }
    buffer.push(event);
  }
  await flushDay();

  // The proof, whole and in one file: it is small, it is read as a unit, and
  // splitting it by day would be meaningless — coverage is a per-wallet
  // high-water mark, not an event.
  const coverage = (await q('SELECT * FROM wallet_coverage ORDER BY address')).rows.map(X.coverageOf);
  const coverageText = JSON.stringify(coverage, null, 2) + '\n';
  const coverageEntry = X.fileEntry('state/coverage.json', coverageText, null, null);
  if (opts.out) writeFile(opts.out, 'state/coverage.json', Buffer.from(coverageText, 'utf8'));
  files.push(coverageEntry);

  const runs = (await q(`SELECT scan_id,anchor_ledger,anchor_close_time,window_start,window_end,target_wallets,
    complete_wallets,failed_wallets,status,roster_hash,floor_ledger,floor_close_time,created_at,finished_at
    FROM scan_runs ORDER BY created_at,scan_id`)).rows
    .map(r => JSON.parse(JSON.stringify(r)));
  const runsText = X.ndjson(runs);
  const runsPacked = gz(runsText);
  const runsEntry = X.fileEntry('state/runs.ndjson.gz', runsText, runsPacked.length, X.sha256(runsPacked));
  if (opts.out) writeFile(opts.out, 'state/runs.ndjson.gz', runsPacked);
  files.push(runsEntry);

  const manifest = X.sealManifest({
    schema: X.SCHEMA,
    export_id: 'exp-' + randomUUID(),
    generated_at: new Date().toISOString(),
    source: {
      schema_migrations: migrations,
      payloads_exported: false,
      payloads_omitted_because: 'raw_tx/raw_meta are a 48-hour cache governed by a retention policy; ' +
        'a git repository cannot delete, so the payload is deliberately not committed',
      database_bytes: Number(shape.db_bytes)
    },
    totals: {
      events, participants,
      wallets: coverage.length,
      runs: runs.length,
      source_transactions: Number(shape.transactions),
      source_participants: Number(shape.participants),
      close_min: shape.close_min ? new Date(shape.close_min).toISOString() : null,
      close_max: shape.close_max ? new Date(shape.close_max).toISOString() : null,
      bytes: files.reduce((n, f) => n + f.bytes, 0),
      gz_bytes: files.reduce((n, f) => n + (f.gz_bytes || 0), 0)
    },
    files: files.slice().sort((a, b) => a.path < b.path ? -1 : (a.path > b.path ? 1 : 0))
  });
  if (opts.out) writeFile(opts.out, 'manifest.json', Buffer.from(JSON.stringify(manifest, null, 2) + '\n', 'utf8'));

  console.log('\nEXPORTED');
  console.log('  files             ' + files.length);
  console.log('  events            ' + events.toLocaleString() + ' of ' + Number(shape.transactions).toLocaleString() + ' rows');
  console.log('  participants      ' + participants.toLocaleString() + ' of ' + Number(shape.participants).toLocaleString() + ' rows');
  console.log('  wallets proven    ' + coverage.length.toLocaleString());
  console.log('  uncompressed      ' + mb(manifest.totals.bytes));
  console.log('  on disk           ' + mb(manifest.totals.gz_bytes));
  console.log('  manifest sha256   ' + manifest.manifest_sha256);
  if (events !== Number(shape.transactions) || participants !== Number(shape.participants)) {
    console.log('\nROW COUNTS DO NOT MATCH THE SOURCE. This export is not usable — do not prune.');
    return finish(1);
  }
  if (!opts.out) { console.log('\nDry run. Nothing was written. Re-run with --out <dir>.'); return finish(0); }
  console.log('\nNothing was written to the database. Next: node scripts/verify-evidence-export.js --in ' + opts.out);
  return finish(0);
}

async function finish(code) { try { await db.close(); } catch (_) {} process.exitCode = code; }

main().catch(e => { console.error(String(e && e.message || e)); finish(1); });
