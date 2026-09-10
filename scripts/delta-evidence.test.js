#!/usr/bin/env node
'use strict';
/* ── DELTA ACQUISITION, AND THE CROSS-CHECK THAT KEEPS IT HONEST ────────────
   The evidence store keeps a slim event permanently (for the retention
   window), a complete ledger payload for 48 hours, and a compact route rollup
   forever. Acquisition asks XRPL only for [last_proven_ledger+1 .. anchor].

   The saving is real but it is NOT where it first appears to be: a day of
   ledger activity is a day of ledger activity either way, so delta
   acquisition removes RE-FETCHING, not rows. The bytes come from the payload
   split. Both facts are load-bearing and both are asserted here.

   The danger the delta model introduces is subtler. Once a wallet has a
   balance and a checkpoint, it is tempting to skip the walk when the balance
   has not moved. That would build a hiding place for the only wallet this
   project genuinely cares about: a routing bot that receives five million XRP
   and forwards five million XRP inside a day is net-zero at both ends.

   So the rule is inverted here. The walk is unconditional; the BALANCE is the
   cross-check on the walk. Between two balances pinned to two known ledgers
   the XRP delta is an exact identity against the AccountRoot deltas of the
   transactions in between, and a mismatch means evidence is MISSING from a
   range this run claims to have proven.

   No database, no browser, no network.

   Run: node scripts/delta-evidence.test.js
──────────────────────────────────────────────────────────────────────────── */
const fs = require('fs');
const path = require('path');
const ROOT = path.join(__dirname, '..');
const B = require(path.join(ROOT, 'src/db/balance.js'));
const C = require(path.join(ROOT, 'src/db/coverage.js'));
const db = require(path.join(ROOT, 'src/db/connection.js'));
const E = require(path.join(ROOT, 'src/db/evidence.js'));

let pass = 0, fail = 0;
const check = (name, ok, detail) => {
  if (ok) { pass++; console.log('  PASS  ' + name); }
  else { fail++; console.log('  FAIL  ' + name + (detail !== undefined ? '  -> ' + JSON.stringify(detail) : '')); }
};

const EVIDENCE_SRC = fs.readFileSync(path.join(ROOT, 'src/db/evidence.js'), 'utf8');
const READER_SRC   = fs.readFileSync(path.join(ROOT, 'src/db/xrpl-reader.js'), 'utf8');
const ADDR = 'rXRPMANTESTWALLET00000000000000000';
const hash = n => String(n).padStart(64, 'A');

// One acquired row, carrying the AccountRoot projection that survives payload
// expiry because it lives in `evidence`, not in raw_meta.
function row(n, ledger, deltas) {
  return { hash: hash(n), ledger_index: ledger, validated: true, tx_result: 'tesSUCCESS',
    close_time_ms: 1757462400000 + ledger, close_time_iso: '2026-09-10T00:00:00.000Z',
    tx_type: 'Payment', from_account: ADDR, to_account: 'rDest', currency: 'XRP',
    amount_drops: '1000000', amount_value: null, escrow_destination: null,
    evidence: { balance_deltas: deltas } };
}
const moves = (account, prev, final) => [{ account, prev: String(prev), final: String(final) }];

// ════════════════════════════════════════════════════════════════════════════
console.log('\n1. balance is a cross-check, and the arithmetic is exact');

const base = { address: ADDR, edge: { from_ledger: 101, through_ledger: 110 },
  previous: { drops: '20000000000000', ledger: 100 }, current: { drops: '18000000000000', ledger: 110 } };

const explained = B.reconcile({ ...base, rows: [row(1, 105, moves(ADDR, '20000000000000', '18000000000000'))] });
check('a balance change fully explained by the walked evidence reconciles',
  explained.status === B.STATUS.RECONCILED && explained.observed_delta_drops === '-2000000000000' &&
  explained.explained_delta_drops === '-2000000000000', explained);

// THE CASE THE WHOLE DESIGN EXISTS FOR. 5,000,000 XRP in and 5,000,000 XRP out
// inside one day: the balance is identical at both ends, and the transactions
// are still there because the walk never asked the balance for permission.
const passthrough = B.reconcile({ address: ADDR, edge: { from_ledger: 101, through_ledger: 110 },
  previous: { drops: '20000000000000', ledger: 100 }, current: { drops: '20000000000000', ledger: 110 },
  rows: [row(1, 104, moves(ADDR, '20000000000000', '25000000000000')),
         row(2, 108, moves(ADDR, '25000000000000', '20000000000000'))] });
check('a net-zero pass-through wallet reconciles WITH its two transactions intact',
  passthrough.status === B.STATUS.RECONCILED && passthrough.observed_delta_drops === '0' &&
  passthrough.transactions_considered === 2 && passthrough.transactions_moving_balance === 2, passthrough);

const unexplained = B.reconcile({ ...base, rows: [] });
check('a balance that moved with no evidence at all is a contradiction',
  unexplained.status === B.STATUS.CONTRADICTION &&
  unexplained.reason === 'BALANCE_MOVED_WITH_NO_EVIDENCE' &&
  unexplained.unexplained_drops === '-2000000000000', unexplained);

const partial = B.reconcile({ ...base, rows: [row(1, 105, moves(ADDR, '20000000000000', '19000000000000'))] });
check('a balance only partly explained is a contradiction too, with the exact shortfall',
  partial.status === B.STATUS.CONTRADICTION &&
  partial.reason === 'BALANCE_PARTIALLY_UNEXPLAINED' &&
  partial.unexplained_drops === '-1000000000000', partial);

// 1e17 drops is the XRP supply and is past Number.MAX_SAFE_INTEGER. A Number()
// anywhere on this path would round evidence into agreement.
const huge = B.reconcile({ address: ADDR, edge: { from_ledger: 101, through_ledger: 110 },
  previous: { drops: '100000000000000001', ledger: 100 }, current: { drops: '100000000000000000', ledger: 110 },
  rows: [row(1, 105, moves(ADDR, '100000000000000001', '100000000000000000'))] });
check('one drop of difference is visible at 1e17 drops — no float rounds it away',
  huge.status === B.STATUS.RECONCILED && huge.observed_delta_drops === '-1', huge);
const hugeOff = B.reconcile({ address: ADDR, edge: { from_ledger: 101, through_ledger: 110 },
  previous: { drops: '100000000000000002', ledger: 100 }, current: { drops: '100000000000000000', ledger: 110 },
  rows: [row(1, 105, moves(ADDR, '100000000000000001', '100000000000000000'))] });
check('and a one-drop shortfall at that magnitude is still caught',
  hugeOff.status === B.STATUS.CONTRADICTION && hugeOff.unexplained_drops === '-1', hugeOff);

const feeOnly = B.reconcile({ address: ADDR, edge: { from_ledger: 101, through_ledger: 110 },
  previous: { drops: '20000000000000', ledger: 100 }, current: { drops: '19999999999988', ledger: 110 },
  rows: [row(1, 103, moves(ADDR, '20000000000000', '19999999999988'))] });
check('a fee-only movement reconciles — fees are AccountRoot debits like any other',
  feeOnly.status === B.STATUS.RECONCILED, feeOnly);

const signerOnly = B.reconcile({ address: ADDR, edge: { from_ledger: 101, through_ledger: 110 },
  previous: { drops: '20000000000000', ledger: 100 }, current: { drops: '20000000000000', ledger: 110 },
  rows: [row(1, 104, moves('rSomebodyElse', '5', '4'))] });
check('a transaction this wallet only signed moves none of its XRP and is not "missing"',
  signerOnly.status === B.STATUS.RECONCILED && signerOnly.transactions_considered === 1 &&
  signerOnly.transactions_moving_balance === 0, signerOnly);

const outside = B.reconcile({ ...base,
  rows: [row(1, 105, moves(ADDR, '20000000000000', '18000000000000')),
         row(2, 99, moves(ADDR, '1', '999999'))] });
check('a row older than the previous balance observation is not counted twice',
  outside.status === B.STATUS.RECONCILED && outside.transactions_considered === 1, outside);

const dupe = B.reconcile({ ...base,
  rows: [row(1, 105, moves(ADDR, '20000000000000', '18000000000000')),
         row(1, 105, moves(ADDR, '20000000000000', '18000000000000'))] });
check('the same hash sighted twice contributes once',
  dupe.status === B.STATUS.RECONCILED && dupe.transactions_considered === 1, dupe);

console.log('\n2. an inability to check is never a finding');
// This report is read aloud live. A cross-check that cried wolf on its first
// cold wallet would be switched off inside a week and then catch nothing.
const noPrev = B.reconcile({ ...base, previous: {}, rows: [] });
check('a wallet with no previous observation stands down (the cold bootstrap)',
  noPrev.status === B.STATUS.NOT_APPLICABLE && noPrev.reason === 'NO_PREVIOUS_BALANCE', noPrev);
const noCurrent = B.reconcile({ ...base, current: {}, rows: [] });
check('a balance read that failed stands down rather than accusing',
  noCurrent.status === B.STATUS.NOT_APPLICABLE && noCurrent.reason === 'NO_CURRENT_BALANCE', noCurrent);
const noWalk = B.reconcile({ ...base, rows: null });
check('an edge that was not walked stands down — and is never read as a pass',
  noWalk.status === B.STATUS.NOT_APPLICABLE && noWalk.reason === 'EDGE_NOT_WALKED', noWalk);
const gap = B.reconcile({ ...base, edge: { from_ledger: 106, through_ledger: 110 }, rows: [] });
check('a walk that began after the previous observation leaves a gap, not a contradiction',
  gap.status === B.STATUS.NOT_APPLICABLE && gap.reason === 'EDGE_LEAVES_GAP' &&
  gap.gap_from === 101 && gap.gap_through === 105, gap);
const shortEdge = B.reconcile({ ...base, edge: { from_ledger: 101, through_ledger: 108 }, rows: [] });
check('a partial prefix is not reconciled against a balance read at the anchor',
  shortEdge.status === B.STATUS.NOT_APPLICABLE && shortEdge.reason === 'EDGE_DOES_NOT_REACH_BALANCE', shortEdge);
const noDeltas = B.reconcile({ ...base, rows: [{ hash: hash(9), ledger_index: 105, evidence: {} }] });
check('a row with no AccountRoot projection stands the check down instead of counting it as zero',
  noDeltas.status === B.STATUS.NOT_APPLICABLE && noDeltas.reason === 'BALANCE_DELTAS_UNAVAILABLE', noDeltas);
check('B.contradicted() is true for exactly one of these',
  B.contradicted(unexplained) && B.contradicted(partial) &&
  !B.contradicted(noDeltas) && !B.contradicted(noPrev) && !B.contradicted(passthrough) && !B.contradicted(null));

console.log('\n3. an unexplained balance may not be rendered as "nothing happened"');
// Zero rows plus a moved balance is the exact shape a pass-through wallet
// takes when its transactions were MISSED, so it is the most dangerous
// possible reading of an empty result.
const servable = { served_from_index: true, edge_fetch_complete: true };
check('a proven, retained, genuinely empty window is still quiet',
  C.mayReportQuiet(servable, 0).quiet === true && C.mayReportQuiet(servable, 0).reason === 'PROVEN_QUIET');
const refused = C.mayReportQuiet(servable, 0, unexplained);
check('the same window with an unexplained balance change is NOT quiet',
  refused.quiet === false && refused.reason === 'BALANCE_MOVED_WITH_NO_EVIDENCE', refused);
check('and the refusal carries the amount nobody can account for',
  refused.unexplained_drops === '-2000000000000', refused);
check('a reconciled cross-check does not disturb an honest quiet claim',
  C.mayReportQuiet(servable, 0, passthrough).quiet === true);
check('nor does one that stood down',
  C.mayReportQuiet(servable, 0, noPrev).quiet === true);

console.log('\n4. the walk is unconditional — balance may not gate acquisition');
// The structural version of the rule. windowServability is THE decision about
// whether and how far to fetch, and it is a pure function of proof, retention
// and the anchor. If a balance ever reached it, a net-zero day would become a
// reason not to look.
const COVERAGE_SRC = fs.readFileSync(path.join(ROOT, 'src/db/coverage.js'), 'utf8');
const servability = COVERAGE_SRC.split('function windowServability')[1].split('\nfunction ')[0];
check('the fetch decision never mentions a balance',
  !/balance/i.test(servability.replace(/^\s*\/\/.*$/gm, '')));
check('and it never mentions wallet_state', !/wallet_state/i.test(servability));
// In evidence.js the balance is read AFTER the walk, from the same anchor the
// walk was bounded by. Reading it first would be the first step toward
// branching on it.
const readsBalance = EVIDENCE_SRC.indexOf('reader.balance(');
const walks = EVIDENCE_SRC.indexOf("command:'account_tx'");
check('the balance is read after the walk, not before it', readsBalance > walks && walks > 0,
  { readsBalance, walks });
check('the balance is pinned to the run anchor, never to "latest"',
  /reader\.balance\(address,\s*anchor\)/.test(EVIDENCE_SRC));
check('a balance read that fails returns null instead of failing the wallet',
  /catch \(e\) \{[\s\S]{0,200}?return null;/.test(READER_SRC.split('async balance(')[1] || ''));
check('account_info is on the read-only method allowlist, and nothing else was added',
  /\['ledger', 'server_info', 'account_tx', 'account_info'\]/.test(READER_SRC) &&
  !/'(submit|sign|sign_for|submit_multisigned)'/.test(READER_SRC));

console.log('\n5. the payload is separate, and the slim event does not carry it');
check('the transactions insert column list has no raw_tx or raw_meta',
  !/const columns = \[[^\]]*raw_tx/.test(EVIDENCE_SRC) && !/const columns = \[[^\]]*raw_meta/.test(EVIDENCE_SRC));
check('the payload is written to transaction_raw with an expiry',
  /INSERT INTO transaction_raw\(hash,raw_tx,raw_meta,expires_at\)/.test(EVIDENCE_SRC) &&
  /now\(\)\+\(\$2\|\|' hours'\)::interval/.test(EVIDENCE_SRC));
check('the payload retention window is resolved through the shared policy, not parsed inline',
  /R\.rawRetention\(process\.env\)/.test(EVIDENCE_SRC) &&
  !/Number\(process\.env\.SHADOWWATCH_RAW_RETENTION_HOURS\)/.test(EVIDENCE_SRC));
// Once the payload expires, the conflict guard would have had nothing left to
// compare. The normalized facts are compared instead, for as long as the event
// is stored, and the payload comparison stays for as long as the payload is.
check('a conflicting response is refused on normalized facts, not only on the payload',
  /const factColumns = columns\.filter/.test(EVIDENCE_SRC) &&
  /t\.\$\{c\} IS NOT NULL AND r\.\$\{c\} IS NOT NULL AND t\.\$\{c\}<>r\.\$\{c\}/.test(EVIDENCE_SRC) &&
  /FROM transaction_raw x/.test(EVIDENCE_SRC));
// An absent field is not a disagreement. One sighting of a hash can carry a
// value another could not read, and treating that as a conflict would fail
// every honest resume rather than catching a dishonest server.
check('but a NULL on either side is an absent fact, not a conflicting one',
  !/IS DISTINCT FROM/.test(EVIDENCE_SRC.split('const conflict =')[1].split('LIMIT 1')[0]));
check('the report window is served from normalized facts, so payload expiry cannot silence it',
  !/raw_tx/.test(EVIDENCE_SRC.split('async function readRunWindow')[1].split('\nasync function ')[0]));
check('the legacy payload read refuses rather than inventing a tx_json it no longer has',
  /RAW_EVIDENCE_EXPIRED_INSIDE_WINDOW/.test(EVIDENCE_SRC));
check('a contradiction blocks a run from being archived as complete',
  /coverage_complete:[^;]*contradictions===0/.test(EVIDENCE_SRC));

async function main() {
console.log('\n6. one wallet through persist(), statement by statement');
// The write path with an injected executor: no database, every statement
// recorded. This is where the ordering guarantees live — the payload cannot be
// written before the event it references, and the route rollup may only count
// hashes the insert actually accepted.
const T0 = Date.parse('2026-09-10T12:00:00.000Z');
const RUN = { scan_id: 'idx-test', anchor_ledger: 1000, anchor_close_time: new Date(T0).toISOString(),
  window_start: new Date(T0 - 86400000).toISOString(), window_end: new Date(T0).toISOString(),
  roster_hash: 'roster-hash', roster_accounts: [ADDR], target_wallets: 1 };
const COVERAGE_AFTER = { address: ADDR, scan_coverage_from: 1, scan_coverage_through: 1000,
  scan_coverage_from_close: new Date(T0 - 172800000).toISOString(),
  scan_coverage_through_close: new Date(T0).toISOString(),
  evidence_retained_from: 1, evidence_retained_through: 1000,
  evidence_retained_from_close: new Date(T0 - 172800000).toISOString() };
const PROOF = { status: 'COMPLETE', range_bound_proven: true, from_ledger: 1, through_ledger: 1000,
  from_close_ms: T0 - 172800000, through_close_ms: T0, rows_stored: 2 };

async function persistOnce(rows, opts = {}) {
  const calls = [];
  const realTransaction = db.transaction;
  try {
    db.transaction = async work => work(async (text, params) => {
      const t = text.replace(/\s+/g, ' ').trim();
      calls.push({ text: t, params });
      if (/pg_advisory_xact_lock/.test(t)) return { rows: [] };
      if (/SELECT \* FROM wallet_coverage WHERE address=\$1 FOR UPDATE/.test(t)) return { rows: [] };
      if (/SELECT \* FROM wallet_coverage WHERE address=\$1$/.test(t)) return { rows: [COVERAGE_AFTER] };
      if (/INSERT INTO transaction_accounts/.test(t)) {
        // What the database ACCEPTED, which is what the rollup counts. The
        // table is unique on (tx_hash, address, role), so a triple already
        // stored comes back in no rows at all.
        const offered = JSON.parse(params[0]);
        const accepted = opts.acceptObservations ? opts.acceptObservations(offered) : offered;
        return { rows: accepted, rowCount: accepted.length };
      }
      if (/SELECT metrics FROM scan_wallets/.test(t)) return { rows: [] };
      return { rows: [], rowCount: 0 };
    });
    await E.persist(RUN, opts.observedVia || ADDR, rows, PROOF, { requests: 3, rows_fetched: rows.length, mode: 'EDGE_ONLY' },
      opts.state === undefined ? { balance: { drops: '18000000000000', ledger: 1000 },
        reconciliation: explained } : opts.state);
    return { calls, error: null };
  } catch (e) {
    return { calls, error: e.message };
  } finally { db.transaction = realTransaction; }
}

const ROWS = [
  { ...row(1, 900, moves(ADDR, '20000000000000', '19000000000000')), raw_tx: { TransactionType: 'Payment' }, raw_meta: { TransactionResult: 'tesSUCCESS' }, observed_via: [ADDR] },
  { ...row(2, 950, moves(ADDR, '19000000000000', '18000000000000')), raw_tx: { TransactionType: 'Payment' }, raw_meta: { TransactionResult: 'tesSUCCESS' }, observed_via: [ADDR] }
];

const written = await persistOnce(ROWS);
check('persist completes with no error', written.error === null, written.error);
const at = re => written.calls.findIndex(c => re.test(c.text));
const iEvent = at(/INSERT INTO transactions\(/);
const iRaw = at(/INSERT INTO transaction_raw/);
const iAccounts = at(/INSERT INTO transaction_accounts/);
const iRoutes = at(/INSERT INTO wallet_routes/);
const iState = at(/INSERT INTO wallet_state/);
check('the slim event is inserted', iEvent >= 0);
check('the payload is inserted AFTER it — the foreign key forbids an orphan', iRaw > iEvent, { iEvent, iRaw });
check('participants are recorded', iAccounts > iEvent);
check('the route rollup is written', iRoutes > iEvent);
const eventStatement = written.calls[iEvent].text;
check('the slim insert names no payload column',
  !/raw_tx|raw_meta/.test(eventStatement), eventStatement.slice(0, 160));
check('and it asks the database which OBSERVATIONS it accepted, not which hashes',
  /ON CONFLICT DO NOTHING RETURNING tx_hash,address,role/.test(written.calls[iAccounts].text));
const eventPayload = JSON.parse(written.calls[iEvent].params[0]);
check('no payload is shipped in the slim statement either',
  eventPayload.every(r => r.raw_tx === undefined && r.raw_meta === undefined));
const rawPayload = JSON.parse(written.calls[iRaw].params[0]);
check('the payload statement carries both halves for every row',
  rawPayload.length === 2 && rawPayload.every(r => r.raw_tx && r.raw_meta && r.hash));
check('the payload expiry is a parameter, not a hard-coded literal in the SQL',
  written.calls[iRaw].params[1] === '48');
const routes = JSON.parse(written.calls[iRoutes].params[0]);
check('a route is rolled up for every accepted observation',
  routes.length === 2 && routes.every(r => r.observed_via === ADDR && r.to_account === 'rDest'), routes);
check('a route carries its day, so it stays meaningful after both prunes',
  routes[0].day === '2026-09-10' && routes[0].ledger === 900, routes[0]);
check('wallet_state is written with the pinned balance', iState > 0 &&
  written.calls[iState].params[1] === '18000000000000' && written.calls[iState].params[2] === 1000);
check('and with the reconciliation verdict',
  JSON.parse(written.calls[iState].params[5]).status === 'RECONCILED');
const stateStatement = written.calls[iState].text;
check('previous_balance is shifted by the database, not by the caller',
  /previous_balance_drops=CASE WHEN excluded.balance_ledger>wallet_state.balance_ledger/.test(stateStatement));
check('a run that could not read a balance leaves the stored one alone',
  /balance_drops=COALESCE\(excluded.balance_drops,wallet_state.balance_drops\)/.test(stateStatement));
check('the delta checkpoint only ever moves forward',
  /last_proven_ledger=GREATEST\(/.test(stateStatement));
const iScan = at(/UPDATE scan_wallets SET status=/);
check('the per-run verdict is stored beside the per-run proof',
  iScan > 0 && JSON.parse(written.calls[iScan].params[5]).status === 'RECONCILED');

const partialWrite = await persistOnce(ROWS, { state: null });
check('a partial prefix persists with no wallet_state write at all',
  partialWrite.error === null && partialWrite.calls.findIndex(c => /INSERT INTO wallet_state/.test(c.text)) < 0,
  partialWrite.error);

const none = await persistOnce([], { accepted: [] });
check('a wallet with nothing new still records its state and writes no route',
  none.error === null && none.calls.findIndex(c => /INSERT INTO wallet_state/.test(c.text)) > 0 &&
  none.calls.findIndex(c => /INSERT INTO wallet_routes/.test(c.text)) < 0, none.error);

console.log('\n7. a watched-to-watched transfer keeps BOTH observers');
// The provenance hole this test exists for. One transaction between two
// watched wallets is returned by both wallets' walks. Wallet A persists first
// and inserts the hash; wallet B's persist hits ON CONFLICT and the row is
// already there. Keying the rollup off the transactions insert therefore
// dropped B's observed_via entirely — and the pair disappeared from exactly
// the rollup that exists to show pairs.
//
// transaction_accounts is unique on (tx_hash, address, role), so accepted
// OBSERVATIONS are the right idempotence key: B's is new even though the
// transaction is not.
const WATCHED_B = 'rXRPMANTESTWALLETB0000000000000000';
// B's walk produces the same transactions, stamped with B's own provenance —
// which is what catchUp does: rowFromAccountTx(..., {observedVia: address}).
const ROWS_B = ROWS.map(r => ({ ...r, observed_via: [WATCHED_B] }));
const secondObserver = await persistOnce(ROWS_B, {
  // The transaction and its submitter/destination rows already exist from
  // wallet A's run; only B's own observation is new.
  acceptObservations: parts => parts.filter(p => p.role === 'observed_via' && p.address === WATCHED_B),
  observedVia: WATCHED_B
});
const iRoutesB = secondObserver.calls.findIndex(c => /INSERT INTO wallet_routes/.test(c.text));
check('the second watched wallet still gets its route rows', iRoutesB > 0, secondObserver.error);
const routesB = iRoutesB > 0 ? JSON.parse(secondObserver.calls[iRoutesB].params[0]) : [];
check('and they are attributed to the SECOND observer, not the first',
  routesB.length === 2 && routesB.every(r => r.observed_via === WATCHED_B), routesB);

// The other half of the same property: nothing new accepted, nothing counted.
const replayed = await persistOnce(ROWS, { acceptObservations: () => [] });
check('re-persisting a wallet whose observations are all stored adds no route at all',
  replayed.error === null &&
  replayed.calls.findIndex(c => /INSERT INTO wallet_routes/.test(c.text)) < 0, replayed.error);

console.log('\n8. the retention floor is one number, enforced on both sides');
const R = require(path.join(ROOT, 'src/db/retention.js'));
const PRUNE_SRC = fs.readFileSync(path.join(ROOT, 'scripts/db-prune.js'), 'utf8');
check('a payload window below the 24-hour floor is refused, and refusal means the LONGER default',
  R.rawRetention({ SHADOWWATCH_RAW_RETENTION_HOURS: '12' }).hours === 48 &&
  R.rawRetention({ SHADOWWATCH_RAW_RETENTION_HOURS: '12' }).source === 'ENV_REFUSED');
// `Number(env) || 48` accepted this. -5 would have made every payload INSERT
// fail the expires_at > stored_at CHECK; 12 would have stamped payloads to
// expire half a day inside the window the report reads.
check('a negative window is refused rather than stamped',
  R.rawRetention({ SHADOWWATCH_RAW_RETENTION_HOURS: '-5' }).hours === 48);
check('so is a non-numeric one',
  R.rawRetention({ SHADOWWATCH_RAW_RETENTION_HOURS: 'abc' }).hours === 48 &&
  R.rawRetention({ SHADOWWATCH_RAW_RETENTION_HOURS: '0' }).hours === 48);
check('exactly the floor is accepted — it is inclusive on both sides',
  R.rawRetention({ SHADOWWATCH_RAW_RETENTION_HOURS: '24' }).hours === 24);
check('a longer window is honoured',
  R.rawRetention({ SHADOWWATCH_RAW_RETENTION_HOURS: '96' }).hours === 96);
check('an unset window is the documented default, not a refusal',
  R.rawRetention({}).hours === 48 && R.rawRetention({}).source === 'DEFAULT');
// The floor cannot drift because neither side owns it.
check('the prune imports the floor rather than restating it',
  /R\.MIN_RAW_RETENTION_HOURS/.test(PRUNE_SRC) && !/const MIN_RAW_HOURS = 24/.test(PRUNE_SRC));
check('and so does the write path',
  /require\('\.\/retention'\)/.test(EVIDENCE_SRC));

console.log('\n9. every immutable stored fact is compared, by subtraction');
// An allowlist here would quietly stop covering each new column nobody
// remembered to add — the same defect shape as the `evidence` allowlist this
// project already removed once. So the guard is `columns` MINUS an explicitly
// named provenance set, and a new column is protected by default.
const _decl = src => (src.match(/const columns = \[([\s\S]*?)\];/) || [])[1] || '';
const declaredColumns = _decl(EVIDENCE_SRC).match(/'([a-z_]+)'/g).map(x => x.replace(/'/g, ''));
const provenance = ((EVIDENCE_SRC.match(/const PROVENANCE_COLUMNS = \[([\s\S]*?)\];/) || [])[1] || '')
  .match(/'([a-z_]+)'/g).map(x => x.replace(/'/g, ''));
const compared = declaredColumns.filter(c => provenance.indexOf(c) < 0);
check('every persisted column is either compared or explicitly named as provenance',
  declaredColumns.every(c => compared.indexOf(c) >= 0 || provenance.indexOf(c) >= 0));
// The fields the payload comparison used to cover implicitly and the
// normalized one did not, until this was widened.
for (const field of ['destination_tag','source_tag','sig_mode','signer_count','sequence','tx_flags','evidence'])
  check('  ' + field + ' is compared once the payload has expired', compared.indexOf(field) >= 0, compared);
// And the three that must NOT be, because two honest observations of one
// transaction legitimately disagree about them.
check('provenance is excluded, and it is exactly these three',
  provenance.length === 3 && ['hash','roster_version','first_seen_scan_id'].every(c => provenance.indexOf(c) >= 0),
  provenance);
check('the excluded set is justified in the source, not silently listed',
  /PROVENANCE is the exception/.test(EVIDENCE_SRC));

console.log('\n10. one contradiction fails the canonical gate EVERYWHERE');
// Every wallet answered; one of them cannot account for its own balance.
// "COMPLETE" describes whether each walk RETURNED. The cross-check describes
// whether what it returned is all of what happened. Those are different
// questions, and a run that passes the first and fails the second must not be
// readable, archivable or stored as COMPLETE — the report is built from
// readRunWindow(), so a gate that stops at archiveFacts() stops too late.
const CONTRADICTED = { status: 'CONTRADICTION', reason: 'BALANCE_MOVED_WITH_NO_EVIDENCE',
  unexplained_drops: '-5000000000000' };
const RECONCILED_OK = { status: 'RECONCILED', reason: 'BALANCE_EXPLAINED' };

// scan_wallets for a run where every wallet is COMPLETE and exactly one is
// contradicted — the fixture the gate exists for.
function walletRows(contradictedCount) {
  return Array.from({ length: 3 }, (_, i) => ({
    address: 'rWallet' + i, status: 'COMPLETE', error: null,
    proof: { status: 'COMPLETE' }, metrics: { requests: 1, rows_fetched: 1 },
    reconciliation: i < contradictedCount ? CONTRADICTED : RECONCILED_OK
  }));
}
async function runReads(contradictedCount) {
  const wallets = walletRows(contradictedCount);
  const real = db.getExecutor;
  try {
    db.setExecutor(async (text, params) => {
      const t = text.replace(/\s+/g, ' ').trim();
      if (/FROM scan_runs WHERE scan_id/.test(t)) return { rows: [{ ...RUN, roster_accounts: [ADDR],
        // getRun() re-derives this and refuses a mismatch, so the fixture has
        // to carry a real roster identity rather than a placeholder.
        roster_hash: require(path.join(ROOT, 'src/db/roster.js')).identity([ADDR]),
        created_at: RUN.anchor_close_time }] };
      if (/FROM scan_wallets WHERE scan_id=\$1 ORDER BY address/.test(t)) return { rows: wallets };
      if (/count\(\*\)::integer AS total/.test(t)) {
        const bad = wallets.filter(w => w.reconciliation.status === params[1]);
        return { rows: [{ total: wallets.length, complete: wallets.length, failed: 0,
          contradictions: bad.length, contradiction_addresses: bad.map(w => w.address) }] };
      }
      if (/SELECT address,status,proof,metrics,error,reconciliation/.test(t)) return { rows: wallets };
      if (/SELECT status,proof,metrics,reconciliation/.test(t) || /SELECT address,status,proof,metrics,reconciliation/.test(t)) return { rows: wallets };
      if (/UPDATE scan_runs SET complete_wallets/.test(t)) { runReads.storedStatus = params[3]; return { rows: [] }; }
      if (/count\(DISTINCT t.hash\)/.test(t)) return { rows: [{ count: 12 }] };
      return { rows: [] };
    });
    // target_wallets equals the number of COMPLETE wallets in every case here,
    // so nothing below can pass merely because a wallet went missing.
    RUN.target_wallets = wallets.length;
    const summary = await E.summary('idx-test');
    const window = await E.readRunWindow('idx-test');
    const facts = await E.archiveFacts('idx-test');
    return { summary, window, facts, stored: runReads.storedStatus };
  } finally { db.setExecutor(real === db.getExecutor ? null : null); db.getExecutor = real; }
}

const clean = await runReads(0);
check('with zero contradictions the run is COMPLETE, readable and archivable',
  clean.summary.status === 'COMPLETE' && clean.window.available === true &&
  clean.facts.coverage_complete === true,
  { status: clean.summary.status, available: clean.window.available, complete: clean.facts.coverage_complete });

const dirty = await runReads(1);
check('complete_wallets == target_wallets and ONE contradiction is not status COMPLETE',
  dirty.summary.status === 'PARTIAL', dirty.summary.status);
check('and that non-COMPLETE status is what gets written to scan_runs',
  dirty.stored === 'PARTIAL', dirty.stored);
check('and the canonical window refuses rather than serving it',
  dirty.window.available === false && dirty.window.error === 'RUN_WINDOW_BALANCE_CONTRADICTION',
  { available: dirty.window.available, error: dirty.window.error });
check('and the refusal names how many and which wallets',
  dirty.window.balance_contradictions === 1 &&
  Array.isArray(dirty.window.balance_contradiction_addresses) &&
  dirty.window.balance_contradiction_addresses.length === 1, dirty.window.balance_contradiction_addresses);
check('and it is not archivable as complete either',
  dirty.facts.coverage_complete === false && dirty.facts.balance_contradictions === 1, dirty.facts);
check('the run still reports every wallet as complete — the gate is the cross-check, not a lost wallet',
  dirty.summary.complete_wallets === 3 && dirty.summary.target_wallets === 3, dirty.summary);
// The browser's readRun() throws on result.error, so a refusal here stops the
// report from loading the window at all rather than being advisory.
const BROWSER = fs.readFileSync(path.join(ROOT, 'src/brief/42-evidence-index.js'), 'utf8');
check('the browser turns that refusal into a thrown error, not a warning',
  /throw new Error\(result\.error\|\|'INDEX_RUN_WINDOW_UNPROVEN'\)/.test(BROWSER.replace(/\s+/g, '')) ||
  /throw new Error\(result\.error/.test(BROWSER));

console.log('\n11. the migration refuses at the quota instead of half-applying');
const MIGRATION = fs.readFileSync(path.join(ROOT, 'db/migrations/005_delta_evidence.sql'), 'utf8');
// Every statement after the preflight writes: three CREATE TABLEs, their
// indexes, two ALTER TABLEs and the schema_migrations insert. Neon blocks
// writes above the quota precisely so data can be deleted, so a migration that
// writes cannot be the thing that unblocks a blocked project.
check('the preflight is the first statement in the migration',
  MIGRATION.indexOf('SIZE_QUOTA_BLOCKS_MIGRATION') < MIGRATION.indexOf('CREATE TABLE'),
  { preflight: MIGRATION.indexOf('SIZE_QUOTA_BLOCKS_MIGRATION'), firstWrite: MIGRATION.indexOf('CREATE TABLE') });
check('it refuses rather than warns',
  /RAISE EXCEPTION[\s\S]{0,120}?SIZE_QUOTA_BLOCKS_MIGRATION/.test(MIGRATION));
check('it compares live usage against the ceiling with a margin for its own writes',
  /pg_database_size\(current_database\(\)\)/.test(MIGRATION) &&
  /used_mb > limit_mb - margin_mb/.test(MIGRATION));
check('it is skipped once the migration is applied, so a re-run is not a refusal',
  /IF EXISTS \(SELECT 1 FROM schema_migrations WHERE version = '005_delta_evidence'\) THEN/.test(MIGRATION));
// The claim that had to be retracted: dropping the columns frees nothing, and
// afterwards nothing can free it.
check('the migration says free-space-first rather than claiming to free space',
  /FREE SPACE FIRST/.test(MIGRATION) &&
  /does not reclaim quota/.test(MIGRATION) &&
  /no longer addressable by any DELETE|can no longer be deleted by any prune/.test(MIGRATION));
check('and the prune script points recovery at the pre-005 path, not at itself',
  /pre-005/i.test(fs.readFileSync(path.join(ROOT, 'scripts/db-prune.js'), 'utf8')));

console.log('\n' + (fail ? fail + ' FAILED of ' + (pass + fail) : 'ALL ' + pass + ' DELTA EVIDENCE CHECKS PASS'));
process.exit(fail ? 1 : 0);
}
main().then(undefined, e => { console.error(e); process.exit(1); });
