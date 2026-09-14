#!/usr/bin/env node
'use strict';
// Retention is the one subsystem whose whole job is deleting forensic data, so
// what it must NOT do matters more than what it does. No database is required:
// the executor and the transaction primitive are both injectable, and every
// statement the script issues is recorded and asserted.
//
// Since migration 005 there are two phases with two clocks, and the split is
// the safety property. Expiring a 48-hour PAYLOAD must touch nothing but
// transaction_raw — no coverage, no retained range, no wallet sent cold.
// Pruning a 7-day SLIM EVENT does fire invalidate_pruned_evidence(), and must
// repair what survives inside the same transaction.
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
  const slimDoomed = opts.doomed === undefined ? 3 : opts.doomed;
  const rawDoomed = opts.rawDoomed === undefined ? 3 : opts.rawDoomed;
  const state = { slim: slimDoomed, raw: rawDoomed, batch: 0 };
  const q = async (text, params) => {
    calls.push({ text: text.replace(/\s+/g, ' ').trim(), params });
    if (/to_regclass/.test(text)) return { rows: [{ ok: opts.migrated === false ? false : true }] };
    if (/pg_database_size/.test(text)) return { rows: [{ db_bytes: 512 * 1024 * 1024,
      tx_bytes: 80 * 1024 * 1024, raw_bytes: 400 * 1024 * 1024, tx_rows: 100, raw_rows: 100 }] };
    if (/count\(\*\) AS n FROM transaction_raw/.test(text)) return { rows: [{ n: rawDoomed }] };
    if (/count\(\*\) AS n FROM transactions/.test(text)) return { rows: [{ n: slimDoomed }] };
    if (/min\(close_time\)/.test(text)) return { rows: [{ c: '2026-09-01T00:00:00.000Z' }] };
    if (/SELECT hash FROM transaction_raw/.test(text)) {
      if (state.raw <= 0) return { rows: [] };
      const n = Math.min(state.raw, params[1]); state.raw -= n; state.batch++;
      return { rows: Array.from({ length: n }, (_, i) => ({ hash: 'R' + state.batch + '_' + i })) };
    }
    if (/SELECT hash FROM transactions/.test(text)) {
      if (state.slim <= 0) return { rows: [] };
      const n = Math.min(state.slim, params[1]); state.slim -= n; state.batch++;
      return { rows: Array.from({ length: n }, (_, i) => ({ hash: 'H' + state.batch + '_' + i })) };
    }
    if (/DISTINCT address FROM transaction_accounts/.test(text)) return { rows: [{ address: 'rAlice' }, { address: 'rBob' }] };
    if (/DELETE FROM transaction_raw/.test(text)) return { rowCount: params[0].length, rows: [] };
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
    for (let i = 0; i < 5; i++) await new Promise(r => setImmediate(r));
    return { calls: rec.calls, out: out.join('\n'), exitCode: process.exitCode };
  } finally {
    db.getExecutor = realExecutor; db.transaction = realTransaction;
    db.isConfigured = realConfigured; db.close = realClose;
    console.log = realLog; console.error = realErr;
    process.argv = realArgv; process.exitCode = realExitCode;
  }
}

const idx = (calls, re) => calls.findIndex(c => re.test(c.text));
const all = (calls, re) => calls.filter(c => re.test(c.text));

async function main() {
  console.log('EVIDENCE RETENTION\n');

  // ── 1. PROOF IS NEVER WRITTEN ────────────────────────────────────────────
  // The single most important property. Retention reclaims storage; it must
  // never touch the record that a wallet's window was examined.
  const writesProof = /UPDATE[\s\S]{0,400}?\bSET[\s\S]{0,400}?scan_coverage_(from|through)\s*=/.test(source);
  check('no statement in the script assigns scan_coverage_from or scan_coverage_through', writesProof === false);
  const deletesCoverage = /DELETE\s+FROM\s+(wallet_coverage|coverage_advances|scan_runs|wallet_state)/i.test(source);
  check('the script deletes from no table but transactions and transaction_raw', deletesCoverage === false);
  check('transaction_accounts is left to ON DELETE CASCADE, not deleted directly',
    /DELETE\s+FROM\s+transaction_accounts/i.test(source) === false);
  // Routes are the compact memory that has to outlive both phases: they are
  // what still answers "this pair moved money on 19 of the last 30 days" when
  // neither the payload nor the event is stored any more.
  check('wallet_routes is never deleted by either phase',
    /DELETE\s+FROM\s+wallet_routes/i.test(source) === false);

  // ── 2. THE TWO RETENTION FLOORS ──────────────────────────────────────────
  // A report reads the last 24h. Pruning EVENTS inside it guarantees a cold
  // re-fetch; pruning PAYLOADS inside it makes the window unservable outright.
  const tooShort = await run(['--days', '1', '--apply']);
  check('a slim window shorter than 2 days is refused', /RETENTION_TOO_SHORT/.test(tooShort.out), tooShort.out.slice(0, 120));
  check('the refusal deletes nothing', tooShort.calls.every(c => !/DELETE/i.test(c.text)));
  const zero = await run(['--days', '0', '--apply']);
  check('zero-day slim retention is refused too', /RETENTION_TOO_SHORT/.test(zero.out));
  const shortRaw = await run(['--raw-hours', '12', '--apply']);
  check('a payload window shorter than 24 hours is refused', /RAW_RETENTION_TOO_SHORT/.test(shortRaw.out), shortRaw.out.slice(0, 160));
  check('that refusal deletes nothing either', shortRaw.calls.every(c => !/DELETE/i.test(c.text)));
  const atFloor = await run(['--raw-hours', '24', '--apply'], { rawDoomed: 2, doomed: 0 });
  check('exactly 24 hours is allowed — the floor is inclusive',
    !/RAW_RETENTION_TOO_SHORT/.test(atFloor.out) && idx(atFloor.calls, /DELETE FROM transaction_raw/) >= 0);
  const both = await run(['--raw-only', '--slim-only', '--apply']);
  check('asking for both phases exclusively is refused rather than guessed',
    /CONTRADICTORY_PHASES/.test(both.out));

  // ── 3. DRY RUN IS THE DEFAULT ────────────────────────────────────────────
  const dry = await run([]);
  check('without --apply nothing is deleted', dry.calls.every(c => !/DELETE/i.test(c.text)));
  check('a dry run still reports what each phase would remove',
    /PHASE 1/.test(dry.out) && /PHASE 2/.test(dry.out) && /eligible/.test(dry.out), dry.out.slice(0, 200));
  check('a dry run says it is a dry run', /DRY RUN/.test(dry.out));

  // ── 4. PHASE 1 TOUCHES NOTHING BUT THE PAYLOAD ───────────────────────────
  // This is the whole reason the payload was moved to its own table.
  // invalidate_pruned_evidence() is a BEFORE DELETE trigger on `transactions`,
  // so expiring a payload cannot fire it. If this phase ever produced a
  // coverage write, every wallet would go cold against the same throttled
  // public endpoint the index exists to avoid.
  const rawOnly = await run(['--raw-only', '--apply'], { rawDoomed: 5, doomed: 9 });
  check('a payload prune deletes from transaction_raw', idx(rawOnly.calls, /DELETE FROM transaction_raw/) >= 0);
  check('a payload prune never deletes a slim event', idx(rawOnly.calls, /DELETE FROM transactions/) < 0);
  check('a payload prune never writes wallet_coverage', idx(rawOnly.calls, /UPDATE wallet_coverage/) < 0);
  check('a payload prune never reads the observed_via addresses — it has no repair to do',
    idx(rawOnly.calls, /DISTINCT address FROM transaction_accounts/) < 0);
  check('and it says so, so an operator at the ceiling knows this phase is free',
    /no wallet goes cold/i.test(rawOnly.out), rawOnly.out.slice(-200));
  const rawSelect = rawOnly.calls.find(c => /SELECT hash FROM transaction_raw/.test(c.text));
  check('eligibility is the row\'s own stamped expiry, not only an argument',
    /expires_at < now\(\)/.test(rawSelect.text), rawSelect && rawSelect.text);
  check('the payload select is bounded by LIMIT', /LIMIT \$2/.test(rawSelect.text));

  // ── 5. PHASE 2 REPAIRS WHAT IT INVALIDATES ───────────────────────────────
  // invalidate_pruned_evidence() NULLs a wallet's whole retained range when any
  // of its rows is deleted. Without the repair every pruned wallet re-fetches
  // its entire window from XRPL — the cold-scan failure the index exists to
  // prevent. The repair must run, in the same transaction, after the delete.
  const applied = await run(['--slim-only', '--days', '7', '--apply'], { doomed: 5 });
  const del = idx(applied.calls, /DELETE FROM transactions/);
  const fix = idx(applied.calls, /UPDATE wallet_coverage/);
  const gather = idx(applied.calls, /DISTINCT address FROM transaction_accounts/);
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

  // ── 6. BATCHING TERMINATES, IN BOTH PHASES ───────────────────────────────
  // The trigger is FOR EACH ROW, so a single unbounded DELETE would fire one
  // UPDATE per row. Batching is required, and it must end.
  const batched = await run(['--slim-only', '--days', '7', '--apply', '--batch', '2'], { doomed: 5 });
  check('a large slim prune is split into bounded batches', all(batched.calls, /DELETE FROM transactions/).length === 3,
    all(batched.calls, /DELETE FROM transactions/).length);
  check('every slim batch is bounded by LIMIT',
    all(batched.calls, /SELECT hash FROM transactions/).every(c => /LIMIT \$2/.test(c.text)));
  check('the slim loop stops when nothing is left', /rows deleted/.test(batched.out), batched.out.slice(-160));
  check('each slim batch repairs its own wallets', all(batched.calls, /UPDATE wallet_coverage/).length === 3);
  const rawBatched = await run(['--raw-only', '--apply', '--batch', '2'], { rawDoomed: 5 });
  check('a large payload prune is split into bounded batches too',
    all(rawBatched.calls, /DELETE FROM transaction_raw/).length === 3,
    all(rawBatched.calls, /DELETE FROM transaction_raw/).length);
  check('the payload loop stops when nothing is left', /payloads expired/.test(rawBatched.out), rawBatched.out.slice(-160));

  // ── 7. BOTH PHASES, IN ORDER ─────────────────────────────────────────────
  // Payloads first: it is the phase that reclaims most of the bytes and costs
  // nothing, so a database at its ceiling gets relief before the phase that
  // makes wallets re-fetch is even started.
  const full = await run(['--apply'], { rawDoomed: 2, doomed: 2 });
  check('the default run does both phases', idx(full.calls, /DELETE FROM transaction_raw/) >= 0 &&
    idx(full.calls, /DELETE FROM transactions/) >= 0);
  check('payloads are expired before events are pruned',
    idx(full.calls, /DELETE FROM transaction_raw/) < idx(full.calls, /DELETE FROM transactions/),
    { raw: idx(full.calls, /DELETE FROM transaction_raw/), slim: idx(full.calls, /DELETE FROM transactions/) });
  check('the summary reports both phases separately',
    /payloads expired/.test(full.out) && /events pruned/.test(full.out), full.out.slice(-300));

  // ── 8. NOTHING TO DO IS NOT AN ERROR ─────────────────────────────────────
  const empty = await run(['--apply'], { doomed: 0, rawDoomed: 0 });
  check('an empty prune exits cleanly and deletes nothing',
    /nothing to prune/.test(empty.out) && /nothing to expire/.test(empty.out) &&
    empty.calls.every(c => !/DELETE/i.test(c.text)), empty.out.slice(-200));

  // ── 8b. THE SCRIPT KNOWS WHICH SCHEMA IT IS FOR ──────────────────────────
  // Two-phase retention needs migration 005. Run against the old schema the
  // size query fails on a missing table, and an operator staring at a full
  // database gets a Postgres error instead of the one instruction that helps.
  const unmigrated = await run(['--apply'], { migrated: false });
  check('a run against the pre-005 schema names the migration instead of failing obscurely',
    /MIGRATION_005_NOT_APPLIED/.test(unmigrated.out), unmigrated.out.slice(0, 200));
  check('and it deletes nothing on the way there', unmigrated.calls.every(c => !/DELETE/i.test(c.text)));

  // ── 9. THE WRITE PATH IS A REAL TRANSACTION ──────────────────────────────
  // Separate HTTP statements would let a delete commit while its repair failed,
  // leaving wallets permanently claiming retention they no longer hold.
  check('deletes and repairs go through db.transaction, not the HTTP executor',
    /db\.transaction\(async tq =>/.test(source));
  check('the script never issues its own BEGIN or COMMIT',
    /['"`]\s*(BEGIN|COMMIT)\s*['"`]/i.test(source) === false);

  console.log('\n' + (fail ? fail + ' FAILED of ' + (pass + fail) : 'ALL ' + pass + ' EVIDENCE RETENTION CHECKS PASS'));
  process.exit(fail ? 1 : 0);
}

main().then(undefined, e => { console.error(e); process.exit(1); });
