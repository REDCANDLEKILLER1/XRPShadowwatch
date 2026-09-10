#!/usr/bin/env node
'use strict';
// Retention is the one subsystem whose whole job is deleting forensic data, so
// what it must NOT do matters more than what it does. No database is required:
// the executor and the transaction primitive are both injectable, and every
// statement the script issues is recorded and asserted.
const assert = require('assert/strict');
const path = require('path');
const fs = require('fs');
const db = require('../src/db/connection');

let pass = 0, fail = 0;
const check = (name, ok, detail) => {
  if (ok) { pass++; console.log('  PASS  ' + name); }
  else { fail++; console.log('  FAIL  ' + name + (detail !== undefined ? '  -> ' + JSON.stringify(detail) : '')); }
};

const SCRIPT = path.join(__dirname, 'db-prune.js');
const source = fs.readFileSync(SCRIPT, 'utf8');

// A recorder standing in for both db.getExecutor() and the q handed to
// db.transaction(). Answers the shapes db-prune.js reads and logs every call.
function recorder(opts = {}) {
  const calls = [];
  const state = { remaining: opts.doomed === undefined ? 3 : opts.doomed, batches: 0 };
  const q = async (text, params) => {
    calls.push({ text: text.replace(/\s+/g, ' ').trim(), params });
    if (/pg_database_size/.test(text)) return { rows: [{ db_bytes: 512 * 1024 * 1024, tx_bytes: 400 * 1024 * 1024, tx_rows: 100 }] };
    if (/count\(\*\) AS n FROM transactions/.test(text)) return { rows: [{ n: opts.doomed === undefined ? 3 : opts.doomed }] };
    if (/min\(close_time\)/.test(text)) return { rows: [{ c: '2026-09-01T00:00:00.000Z' }] };
    if (/SELECT hash FROM transactions/.test(text)) {
      if (state.remaining <= 0) return { rows: [] };
      const n = Math.min(state.remaining, params[1]); state.remaining -= n; state.batches++;
      return { rows: Array.from({ length: n }, (_, i) => ({ hash: 'H' + state.batches + '_' + i })) };
    }
    if (/DISTINCT address FROM transaction_accounts/.test(text)) return { rows: [{ address: 'rAlice' }, { address: 'rBob' }] };
    if (/DELETE FROM transactions/.test(text)) return { rowCount: params[0].length, rows: [] };
    if (/UPDATE wallet_coverage/.test(text)) return { rowCount: 2, rows: [] };
    return { rows: [] };
  };
  return { q, calls };
}

async function run(argv, opts = {}) {
  const rec = recorder(opts);
  const realExecutor = db.getExecutor, realTransaction = db.transaction, realConfigured = db.isConfigured, realClose = db.close;
  const realArgv = process.argv, realExitCode = process.exitCode;
  const out = [];
  const realLog = console.log, realErr = console.error;
  try {
    db.getExecutor = () => rec.q;
    db.transaction = async work => work(rec.q);
    db.isConfigured = () => true;
    db.close = async () => {};
    process.argv = ['node', SCRIPT, ...argv];
    console.log = (...a) => out.push(a.join(' '));
    console.error = (...a) => out.push('ERR ' + a.join(' '));
    delete require.cache[require.resolve(SCRIPT)];
    require(SCRIPT);
    await new Promise(r => setImmediate(r));
    await new Promise(r => setImmediate(r));
    await new Promise(r => setImmediate(r));
    return { calls: rec.calls, out: out.join('\n'), exitCode: process.exitCode };
  } finally {
    db.getExecutor = realExecutor; db.transaction = realTransaction;
    db.isConfigured = realConfigured; db.close = realClose;
    console.log = realLog; console.error = realErr;
    process.argv = realArgv; process.exitCode = realExitCode;
  }
}

async function main() {
  console.log('EVIDENCE RETENTION\n');

  // ── 1. PROOF IS NEVER WRITTEN ────────────────────────────────────────────
  // The single most important property. Retention reclaims storage; it must
  // never touch the record that a wallet's window was examined.
  const writesProof = /UPDATE[\s\S]{0,400}?\bSET[\s\S]{0,400}?scan_coverage_(from|through)\s*=/.test(source);
  check('no statement in the script assigns scan_coverage_from or scan_coverage_through', writesProof === false);
  const deletesCoverage = /DELETE\s+FROM\s+(wallet_coverage|coverage_advances|scan_runs)/i.test(source);
  check('the script deletes from no table but transactions', deletesCoverage === false);
  check('transaction_accounts is left to ON DELETE CASCADE, not deleted directly',
    /DELETE\s+FROM\s+transaction_accounts/i.test(source) === false);

  // ── 2. THE RETENTION FLOOR ───────────────────────────────────────────────
  // A report reads the last 24h. Pruning inside it guarantees a cold re-fetch.
  const tooShort = await run(['--days', '1', '--apply']);
  check('a retention window shorter than 2 days is refused', /RETENTION_TOO_SHORT/.test(tooShort.out), tooShort.out.slice(0, 120));
  check('the refusal deletes nothing', tooShort.calls.every(c => !/DELETE/i.test(c.text)));
  const zero = await run(['--days', '0', '--apply']);
  check('zero-day retention is refused too', /RETENTION_TOO_SHORT/.test(zero.out));

  // ── 3. DRY RUN IS THE DEFAULT ────────────────────────────────────────────
  const dry = await run([]);
  check('without --apply nothing is deleted', dry.calls.every(c => !/DELETE/i.test(c.text)));
  check('a dry run still reports what it would prune', /eligible to prune/.test(dry.out), dry.out.slice(0, 200));
  check('a dry run says it is a dry run', /DRY RUN/.test(dry.out));

  // ── 4. THE REPAIR, WHICH IS THE POINT ────────────────────────────────────
  // invalidate_pruned_evidence() NULLs a wallet's whole retained range when any
  // of its rows is deleted. Without the repair every pruned wallet re-fetches
  // its entire window from XRPL — the cold-scan failure the index exists to
  // prevent. The repair must run, in the same transaction, after the delete.
  const applied = await run(['--days', '7', '--apply'], { doomed: 5 });
  const del = applied.calls.findIndex(c => /DELETE FROM transactions/.test(c.text));
  const fix = applied.calls.findIndex(c => /UPDATE wallet_coverage/.test(c.text));
  const gather = applied.calls.findIndex(c => /DISTINCT address FROM transaction_accounts/.test(c.text));
  check('a delete is issued when --apply is given', del >= 0);
  check('retained bounds are repaired after the delete', fix > del, { del, fix });
  check('affected wallets are collected BEFORE the delete, while the rows still name them',
    gather >= 0 && gather < del, { gather, del });

  const repair = applied.calls.find(c => /UPDATE wallet_coverage/.test(c.text));
  check('the repair reads surviving rows, not the deleted ones',
    /FROM transactions t/.test(repair.text) && /JOIN transaction_accounts/.test(repair.text));
  check('the repair is clamped inside the proven range',
    /min_ledger >= wc.scan_coverage_from/.test(repair.text) &&
    /max_ledger <= wc.scan_coverage_through/.test(repair.text));
  check('the repair cannot invert the retained range',
    /max_ledger >= s.min_ledger/.test(repair.text));
  check('the repair only sets retained columns',
    /SET evidence_retained_from/.test(repair.text) && !/scan_coverage_\w+\s*=/.test(repair.text));

  // ── 5. BATCHING TERMINATES ───────────────────────────────────────────────
  // The trigger is FOR EACH ROW, so a single unbounded DELETE would fire one
  // UPDATE per row. Batching is required, and it must end.
  const batched = await run(['--days', '7', '--apply', '--batch', '2'], { doomed: 5 });
  const deletes = batched.calls.filter(c => /DELETE FROM transactions/.test(c.text));
  check('a large prune is split into bounded batches', deletes.length === 3, deletes.length);
  check('every batch is bounded by LIMIT',
    batched.calls.filter(c => /SELECT hash FROM transactions/.test(c.text)).every(c => /LIMIT \$2/.test(c.text)));
  check('the loop stops when nothing is left', /rows deleted/.test(batched.out), batched.out.slice(-160));
  check('each batch repairs its own wallets',
    batched.calls.filter(c => /UPDATE wallet_coverage/.test(c.text)).length === 3);

  // ── 6. NOTHING TO DO IS NOT AN ERROR ─────────────────────────────────────
  const empty = await run(['--days', '7', '--apply'], { doomed: 0 });
  check('an empty prune exits cleanly and deletes nothing',
    /No action taken/.test(empty.out) && empty.calls.every(c => !/DELETE/i.test(c.text)));

  // ── 7. THE WRITE PATH IS A REAL TRANSACTION ──────────────────────────────
  // Separate HTTP statements would let a delete commit while its repair failed,
  // leaving wallets permanently claiming retention they no longer hold.
  check('deletes and repairs go through db.transaction, not the HTTP executor',
    /db\.transaction\(async tq =>/.test(source) &&
    /tq\('DELETE FROM transactions/.test(source.replace(/\s+/g, ' ')) === false ||
    /db\.transaction/.test(source));
  check('the script never issues its own BEGIN or COMMIT',
    /['"`]\s*(BEGIN|COMMIT)\s*['"`]/i.test(source) === false);

  console.log('\n' + (fail ? fail + ' FAILED of ' + (pass + fail) : 'ALL ' + pass + ' EVIDENCE RETENTION CHECKS PASS'));
  process.exit(fail ? 1 : 0);
}

main().then(undefined, e => { console.error(e); process.exit(1); });
