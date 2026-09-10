#!/usr/bin/env node
'use strict';
// Retention for the evidence store, in two phases with two different clocks.
//
// SW-20260910 filled a 512 MB Neon project in two days and every run then died
// at its first INSERT — reads still answered, so the health check stayed green
// while begin() could not write a single row.
//
// The cause was never row COUNT. A day of ledger activity is a day of ledger
// activity whether it is fetched cold or as a delta: ~47,500 transactions
// either way. It was BYTES PER ROW. raw_tx + raw_meta are kilobytes each; the
// normalized event is a couple hundred bytes. So migration 005 split them, and
// this script prunes each on its own schedule.
//
// ── PHASE 1: PAYLOADS, 48 HOURS ────────────────────────────────────────────
//
// Deletes rows from `transaction_raw`. It touches NOTHING else, and that is
// the entire point of the split: invalidate_pruned_evidence() is a trigger on
// `transactions`, so expiring a payload does not fire it, does not NULL a
// single wallet's retained range, and cannot send anything cold. After it
// runs, the event, its participants, its balance deltas and its coverage proof
// are all exactly where they were.
//
// ── PHASE 2: SLIM EVENTS, 7 DAYS ───────────────────────────────────────────
//
// Deletes rows from `transactions`, which DOES fire the trigger:
//
//   UPDATE wallet_coverage SET evidence_retained_from=NULL,
//     evidence_retained_through=NULL, evidence_retained_from_close=NULL
//     WHERE address IN (SELECT address FROM transaction_accounts
//                       WHERE tx_hash=OLD.hash AND role='observed_via');
//
// That is correct and fail-closed — it refuses to claim retention it cannot
// prove — but it is all-or-nothing. Deleting one week-old event for a wallet
// discards its claim on yesterday's rows too, so the next run re-fetches the
// whole window. Prune all 255 naively and every wallet is cold again, against
// the same throttled public endpoint the index exists to avoid.
//
// So each batch repairs what survives, inside the same transaction as the
// delete: retained bounds are recomputed from the rows still there. Fail-
// closed stays the default — a wallet whose surviving evidence falls outside
// its proven range keeps NULL bounds and re-fetches, rather than carrying a
// claim this script cannot substantiate.
//
// ── WHAT IS NEVER DELETED ──────────────────────────────────────────────────
//
// scan_coverage_from / scan_coverage_through, which this script never writes
// at all. Proof that a wallet's window was examined is not storage, it is the
// forensic record, and it survives pruning by design.
//
// wallet_routes, the compact per-pair-per-day rollup. Bot and routing patterns
// need a long memory and almost none of the payload to express one, so they
// outlive both phases.
//
// Usage:
//   node scripts/db-prune.js                        # dry run, 48h raw / 7d slim
//   node scripts/db-prune.js --apply                # both phases
//   node scripts/db-prune.js --raw-only --apply     # fastest reclaim, no wallet goes cold
//   node scripts/db-prune.js --days 14 --apply      # keep slim events longer
//   node scripts/db-prune.js --raw-hours 24 --apply # aggressive reclaim at the ceiling

const db = require('../src/db/connection');
// The payload floor is imported, never restated. evidence.js stamps
// expires_at from the same module, and a writer and a pruner disagreeing about
// this number fails silently in both directions.
const R = require('../src/db/retention');

const MIN_RETENTION_DAYS = 2;
const DEFAULT_RETENTION_DAYS = 7;
const MIN_RAW_HOURS = R.MIN_RAW_RETENTION_HOURS;
const DEFAULT_RAW_HOURS = R.DEFAULT_RAW_RETENTION_HOURS;
const DEFAULT_BATCH = 2000;

function args(argv) {
  const out = { days: DEFAULT_RETENTION_DAYS, rawHours: DEFAULT_RAW_HOURS,
    apply: false, batch: DEFAULT_BATCH, rawOnly: false, slimOnly: false };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--apply') out.apply = true;
    else if (argv[i] === '--raw-only') out.rawOnly = true;
    else if (argv[i] === '--slim-only') out.slimOnly = true;
    else if (argv[i] === '--days') out.days = Number(argv[++i]);
    else if (argv[i] === '--raw-hours') out.rawHours = Number(argv[++i]);
    else if (argv[i] === '--batch') out.batch = Number(argv[++i]);
  }
  return out;
}

// Two floors, for two different reasons. Pruning slim events inside the live
// report window guarantees the very next run re-fetches it, which is the cost
// this whole subsystem exists to avoid. Pruning payloads inside it makes the
// window unservable outright.
function assertRetention(opts) {
  if (!Number.isFinite(opts.days) || opts.days < MIN_RETENTION_DAYS) {
    throw new Error('RETENTION_TOO_SHORT: --days must be at least ' + MIN_RETENTION_DAYS +
      ' so a prune can never delete inside the live report window (got ' + opts.days + ')');
  }
  if (!Number.isFinite(opts.rawHours) || opts.rawHours < MIN_RAW_HOURS) {
    throw new Error('RAW_RETENTION_TOO_SHORT: --raw-hours must be at least ' + MIN_RAW_HOURS +
      ' so a payload can never expire inside the live report window (got ' + opts.rawHours + ')');
  }
  if (opts.rawOnly && opts.slimOnly) throw new Error('CONTRADICTORY_PHASES: --raw-only and --slim-only');
}

// Both phases assume migration 005. Without it the size query below fails on a
// table that does not exist, and the operator gets a Postgres error instead of
// the one instruction that helps.
async function assertMigrated(q) {
  const present = (await q(`SELECT to_regclass('public.transaction_raw') IS NOT NULL AS ok`)).rows[0].ok;
  if (!present) {
    throw new Error('MIGRATION_005_NOT_APPLIED: transaction_raw does not exist. Run ' +
      '`node scripts/db-migrate.js` first — it needs no headroom, because 005 copies no ' +
      'payloads unless SHADOWWATCH_RAW_BACKFILL_HOURS asks it to.');
  }
}

async function sizes(q) {
  const row = (await q(`SELECT pg_database_size(current_database()) AS db_bytes,
    pg_total_relation_size('transactions') AS tx_bytes,
    pg_total_relation_size('transaction_raw') AS raw_bytes,
    (SELECT count(*) FROM transactions) AS tx_rows,
    (SELECT count(*) FROM transaction_raw) AS raw_rows`)).rows[0];
  return { db_bytes: Number(row.db_bytes), tx_bytes: Number(row.tx_bytes), raw_bytes: Number(row.raw_bytes),
    tx_rows: Number(row.tx_rows), raw_rows: Number(row.raw_rows) };
}

const mb = bytes => (bytes / (1024 * 1024)).toFixed(1) + ' MB';

// Recompute retained bounds for wallets the slim delete just cleared, from the
// rows that survived. Clamped inside the proven range: a retained claim wider
// than the proof would violate retained_through_within_proof and would be a
// lie besides. Wallets with no surviving evidence keep NULL and re-fetch.
const REPAIR_RETAINED = `
  UPDATE wallet_coverage wc
     SET evidence_retained_from       = s.min_ledger,
         evidence_retained_through    = s.max_ledger,
         evidence_retained_from_close = s.min_close
    FROM (SELECT ta.address,
                 MIN(t.ledger_index) AS min_ledger,
                 MAX(t.ledger_index) AS max_ledger,
                 MIN(t.close_time)   AS min_close
            FROM transactions t
            JOIN transaction_accounts ta
              ON ta.tx_hash = t.hash AND ta.role = 'observed_via'
           WHERE ta.address = ANY($1::text[])
           GROUP BY ta.address) s
   WHERE wc.address = s.address
     AND wc.scan_coverage_from    IS NOT NULL
     AND wc.scan_coverage_through IS NOT NULL
     AND s.min_ledger >= wc.scan_coverage_from
     AND s.max_ledger <= wc.scan_coverage_through
     AND s.max_ledger >= s.min_ledger`;

// A payload is eligible when its own stamped expiry has passed, or when the
// operator asks for a shorter window than the one it was written with. The
// stamped expiry is the policy; --raw-hours is the reclaim lever.
const DOOMED_RAW = `SELECT hash FROM transaction_raw
   WHERE expires_at < now() OR stored_at < $1 ORDER BY stored_at LIMIT $2`;

async function pruneRaw(opts, q) {
  const cutoff = new Date(Date.now() - opts.rawHours * 3600 * 1000).toISOString();
  const doomed = Number((await q(
    `SELECT count(*) AS n FROM transaction_raw WHERE expires_at < now() OR stored_at < $1`, [cutoff])).rows[0].n);
  console.log('\nPHASE 1 — LEDGER PAYLOADS');
  console.log('  retention         ' + opts.rawHours + ' hours · cutoff ' + cutoff);
  console.log('  eligible          ' + doomed.toLocaleString() + ' payloads');
  if (!doomed) { console.log('  nothing to expire'); return { deleted: 0, batches: 0 }; }
  if (!opts.apply) { console.log('  DRY RUN — no payload deleted'); return { deleted: 0, batches: 0 }; }

  let deleted = 0, batches = 0;
  for (;;) {
    const done = await db.transaction(async tq => {
      const hashes = (await tq(DOOMED_RAW, [cutoff, opts.batch])).rows.map(r => r.hash);
      if (!hashes.length) return true;
      // No repair, and none needed: invalidate_pruned_evidence() is a trigger
      // on `transactions`, not on this table. Nothing about coverage moves.
      const gone = await tq('DELETE FROM transaction_raw WHERE hash = ANY($1::text[])', [hashes]);
      deleted += gone.rowCount == null ? hashes.length : gone.rowCount;
      batches++;
      return false;
    });
    if (done) break;
    process.stdout.write('  expired ' + deleted.toLocaleString() + ' payloads…\r');
  }
  console.log('  expired           ' + deleted.toLocaleString() + ' payloads in ' + batches + ' batch(es)');
  console.log('  coverage proof and retained ranges untouched — no wallet goes cold');
  return { deleted, batches };
}

async function pruneSlim(opts, q) {
  const cutoff = new Date(Date.now() - opts.days * 24 * 3600 * 1000).toISOString();
  const doomed = Number((await q(
    'SELECT count(*) AS n FROM transactions WHERE close_time < $1', [cutoff])).rows[0].n);
  console.log('\nPHASE 2 — SLIM EVENTS');
  console.log('  retention         ' + opts.days + ' days · cutoff ' + cutoff);
  console.log('  eligible          ' + doomed.toLocaleString() + ' rows');
  if (!doomed) { console.log('  nothing to prune'); return { deleted: 0, repaired: 0, batches: 0 }; }
  if (!opts.apply) { console.log('  DRY RUN — no event deleted'); return { deleted: 0, repaired: 0, batches: 0 }; }

  let deleted = 0, repaired = 0, batches = 0;
  for (;;) {
    const done = await db.transaction(async tq => {
      const hashes = (await tq(
        'SELECT hash FROM transactions WHERE close_time < $1 ORDER BY close_time LIMIT $2',
        [cutoff, opts.batch])).rows.map(r => r.hash);
      if (!hashes.length) return true;

      // Collect the wallets this delete will strip BEFORE the trigger fires;
      // afterwards the cascade has removed the rows that name them.
      const affected = (await tq(
        `SELECT DISTINCT address FROM transaction_accounts
          WHERE tx_hash = ANY($1::text[]) AND role = 'observed_via'`, [hashes])).rows.map(r => r.address);

      // transaction_accounts and transaction_raw both follow by ON DELETE
      // CASCADE, so a slim prune takes any surviving payload with it. A
      // payload can never outlive the event it describes.
      const gone = await tq('DELETE FROM transactions WHERE hash = ANY($1::text[])', [hashes]);
      deleted += gone.rowCount == null ? hashes.length : gone.rowCount;

      if (affected.length) {
        const fixed = await tq(REPAIR_RETAINED, [affected]);
        repaired += fixed.rowCount == null ? 0 : fixed.rowCount;
      }
      batches++;
      return false;
    });
    if (done) break;
    process.stdout.write('  pruned ' + deleted.toLocaleString() + ' rows…\r');
  }
  console.log('  rows deleted      ' + deleted.toLocaleString() + ' in ' + batches + ' batch(es)');
  console.log('  retained repaired ' + repaired.toLocaleString() + ' wallets');
  return { deleted, repaired, batches };
}

async function main() {
  const opts = args(process.argv.slice(2));
  assertRetention(opts);
  if (!db.isConfigured()) throw new Error('EVIDENCE_STORE_UNAVAILABLE: no database connection string configured');

  const q = db.getExecutor();
  await assertMigrated(q);
  const before = await sizes(q);
  const oldest = (await q('SELECT min(close_time) AS c FROM transactions')).rows[0].c;

  console.log('EVIDENCE RETENTION');
  console.log('  database          ' + mb(before.db_bytes));
  console.log('  slim events       ' + mb(before.tx_bytes) + ' · ' + before.tx_rows.toLocaleString() + ' rows');
  console.log('  ledger payloads   ' + mb(before.raw_bytes) + ' · ' + before.raw_rows.toLocaleString() + ' rows');
  console.log('  oldest evidence   ' + (oldest ? new Date(oldest).toISOString() : '(none)'));
  console.log('  mode              ' + (opts.apply ? 'APPLY' : 'DRY RUN (pass --apply to delete)'));

  const raw = opts.slimOnly ? { deleted: 0, batches: 0 } : await pruneRaw(opts, q);
  const slim = opts.rawOnly ? { deleted: 0, repaired: 0, batches: 0 } : await pruneSlim(opts, q);

  if (!opts.apply) {
    console.log('\nDry run only. Proof (scan_coverage_*) is never touched by this script, and');
    console.log('wallet_routes is never touched by either phase.');
    return finish(0);
  }

  const after = await sizes(q);
  console.log('\nRECLAIMED');
  console.log('  payloads expired  ' + raw.deleted.toLocaleString());
  console.log('  events pruned     ' + slim.deleted.toLocaleString());
  console.log('  slim events       ' + mb(before.tx_bytes) + ' -> ' + mb(after.tx_bytes));
  console.log('  ledger payloads   ' + mb(before.raw_bytes) + ' -> ' + mb(after.raw_bytes));
  console.log('  database          ' + mb(before.db_bytes) + ' -> ' + mb(after.db_bytes));
  console.log('\nProof was not modified, and neither was wallet_routes. Wallets whose surviving');
  console.log('evidence no longer sits inside their proven range keep NULL retained bounds and');
  console.log('will re-fetch that window once.');
  console.log('Neon reclaims space asynchronously; run VACUUM if the figure lags.');
  return finish(0);
}

async function finish(code) { try { await db.close(); } catch (_) {} process.exitCode = code; }

main().catch(e => { console.error(String(e && e.message || e)); finish(1); });
