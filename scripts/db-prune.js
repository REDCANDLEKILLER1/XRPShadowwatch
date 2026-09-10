#!/usr/bin/env node
'use strict';
// Retention for the evidence store. Raw ledger evidence is the only thing that
// grows without bound: ~47,500 transactions a run, each carrying raw_tx and
// raw_meta, is roughly 100 MB a day. SW-20260910 filled a 512 MB Neon project
// in two days and every run then died at its first INSERT — reads still
// answered, so the health check stayed green while begin() could not write a
// single row.
//
// WHAT IS DELETED AND WHAT IS NOT
//
// Deleted: rows in `transactions` older than the retention window.
// transaction_accounts follows by ON DELETE CASCADE (schema.sql).
//
// NEVER deleted, and never written by this script: scan_coverage_from /
// scan_coverage_through. Proof that a wallet's window was examined is not
// storage, it is the forensic record, and it survives pruning by design. A
// pruned wallet keeps its proof and simply no longer holds the rows.
//
// THE TRAP THIS SCRIPT EXISTS TO AVOID
//
// invalidate_pruned_evidence() (003_retention_and_admission.sql) fires BEFORE
// DELETE and NULLs the ENTIRE retained range of every affected wallet:
//
//   UPDATE wallet_coverage SET evidence_retained_from=NULL,
//     evidence_retained_through=NULL, evidence_retained_from_close=NULL
//     WHERE address IN (SELECT address FROM transaction_accounts
//                       WHERE tx_hash=OLD.hash AND role='observed_via');
//
// That is correct and fail-closed — it refuses to claim retention it cannot
// prove — but it is all-or-nothing. Deleting one week-old transaction for a
// wallet discards its claim on yesterday's rows too, so the next run re-fetches
// the whole window from XRPL. Prune all 255 naively and every wallet is cold
// again, against the same throttled public endpoint the index exists to avoid.
//
// So each batch repairs what survives, inside the same transaction as the
// delete: retained bounds are recomputed from the rows that are actually still
// there. Fail-closed stays the default — a wallet whose surviving evidence
// falls outside its proven range keeps NULL bounds and re-fetches, rather than
// carrying a claim this script cannot substantiate.
//
// Usage:
//   node scripts/db-prune.js                      # dry run, 7-day retention
//   node scripts/db-prune.js --days 14            # dry run, 14-day retention
//   node scripts/db-prune.js --days 7 --apply     # actually delete
//   node scripts/db-prune.js --apply --batch 5000

const db = require('../src/db/connection');

const MIN_RETENTION_DAYS = 2;
const DEFAULT_RETENTION_DAYS = 7;
const DEFAULT_BATCH = 2000;

function args(argv) {
  const out = { days: DEFAULT_RETENTION_DAYS, apply: false, batch: DEFAULT_BATCH };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--apply') out.apply = true;
    else if (argv[i] === '--days') out.days = Number(argv[++i]);
    else if (argv[i] === '--batch') out.batch = Number(argv[++i]);
  }
  return out;
}

// A report reads the last 24h. Pruning inside that window guarantees the very
// next run re-fetches it, which is the cost this whole subsystem exists to
// avoid. Two days is the floor; the default leaves a week.
function assertRetention(days) {
  if (!Number.isFinite(days) || days < MIN_RETENTION_DAYS) {
    throw new Error('RETENTION_TOO_SHORT: --days must be at least ' + MIN_RETENTION_DAYS +
      ' so a prune can never delete inside the live report window (got ' + days + ')');
  }
}

async function sizes(q) {
  const row = (await q(`SELECT pg_database_size(current_database()) AS db_bytes,
    pg_total_relation_size('transactions') AS tx_bytes,
    (SELECT count(*) FROM transactions) AS tx_rows`)).rows[0];
  return { db_bytes: Number(row.db_bytes), tx_bytes: Number(row.tx_bytes), tx_rows: Number(row.tx_rows) };
}

const mb = bytes => (bytes / (1024 * 1024)).toFixed(1) + ' MB';

// Recompute retained bounds for wallets the delete just cleared, from the rows
// that survived. Clamped inside the proven range: a retained claim wider than
// the proof would violate retained_through_within_proof and would be a lie
// besides. Wallets with no surviving evidence keep NULL and re-fetch.
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

async function main() {
  const opts = args(process.argv.slice(2));
  assertRetention(opts.days);
  if (!db.isConfigured()) throw new Error('EVIDENCE_STORE_UNAVAILABLE: no database connection string configured');

  const q = db.getExecutor();
  const before = await sizes(q);
  const cutoff = new Date(Date.now() - opts.days * 24 * 3600 * 1000).toISOString();

  const doomed = Number((await q(
    'SELECT count(*) AS n FROM transactions WHERE close_time < $1', [cutoff])).rows[0].n);
  const oldest = (await q('SELECT min(close_time) AS c FROM transactions')).rows[0].c;

  console.log('EVIDENCE RETENTION');
  console.log('  database          ' + mb(before.db_bytes));
  console.log('  transactions      ' + mb(before.tx_bytes) + ' · ' + before.tx_rows.toLocaleString() + ' rows');
  console.log('  oldest evidence   ' + (oldest ? new Date(oldest).toISOString() : '(none)'));
  console.log('  retention         ' + opts.days + ' days · cutoff ' + cutoff);
  console.log('  eligible to prune ' + doomed.toLocaleString() + ' rows');
  console.log('  mode              ' + (opts.apply ? 'APPLY' : 'DRY RUN (pass --apply to delete)'));

  if (!doomed) { console.log('\nNothing older than the retention window. No action taken.'); return finish(0); }
  if (!opts.apply) {
    console.log('\nDry run only. Proof (scan_coverage_*) is never touched by this script;');
    console.log('retained-evidence bounds are recomputed from surviving rows after each batch.');
    return finish(0);
  }

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

  const after = await sizes(q);
  console.log('\n\nPRUNED');
  console.log('  batches           ' + batches);
  console.log('  rows deleted      ' + deleted.toLocaleString());
  console.log('  retained repaired ' + repaired.toLocaleString() + ' wallets');
  console.log('  transactions      ' + mb(before.tx_bytes) + ' -> ' + mb(after.tx_bytes));
  console.log('  database          ' + mb(before.db_bytes) + ' -> ' + mb(after.db_bytes));
  console.log('\nProof was not modified. Wallets whose surviving evidence no longer sits inside');
  console.log('their proven range keep NULL retained bounds and will re-fetch that window once.');
  console.log('Neon reclaims space asynchronously; run VACUUM if the figure lags.');
  return finish(0);
}

async function finish(code) { try { await db.close(); } catch (_) {} process.exitCode = code; }

main().catch(e => { console.error(String(e && e.message || e)); finish(1); });
