#!/usr/bin/env node
/* ── ONE RUN, ONE LEDGER STATE ────────────────────────────────────────────────
   Three prerequisites, tested as one sequence because they only mean anything
   together:

     1. every admitted row says WHICH LEDGER it is in
     2. one validated anchor per run, shared by every wallet
     3. the reported window is recomputed at scan start and capped to that
        anchor's close — and the report CONSUMES the capped value

   The harness below is not a mock of the decision layer; it is a mock of the
   XRPL SERVER. Every decision under test is the real code from
   src/brief/41-run-anchor-20260906.js and src/db/coverage.js, driven through
   the same call sequence 02-core.js uses. A test that reimplemented the
   decisions would prove only that the test agrees with itself.

   Run: node scripts/ledger-anchor-prerequisites.test.js
──────────────────────────────────────────────────────────────────────────── */
'use strict';

const path = require('path');
const fs = require('fs');
const RA = require(path.join(__dirname, '..', 'src/brief/41-run-anchor-20260906.js'));
const COV = require(path.join(__dirname, '..', 'src/db/coverage.js'));

let pass = 0, fail = 0;
const check = (name, ok, detail) => {
  if (ok) { pass++; console.log('  PASS  ' + name); }
  else { fail++; console.log('  FAIL  ' + name + (detail !== undefined ? '  -> ' + JSON.stringify(detail) : '')); }
};

const RIPPLE_EPOCH = 946684800;
const toRipple = ms => Math.floor(ms / 1000) - RIPPLE_EPOCH;

// Ledger indices are REAL ones, near the live tip. An earlier draft of this
// file used small numbers (5000, 6000) and every history proof came back
// SERVER_RANGE_UNPARSEABLE — correctly, because '32570-5000' is a reversed
// range: XRPL's earliest surviving ledger is 32570, so no real server can hold
// a range that ends below it. The fixtures were describing a ledger that
// cannot exist. Anchoring them near the live tip is not cosmetic; it is what
// makes the proof path under test the same one production takes.
const LB = 106790000;
const L = n => LB + n;

// ── A fake XRPL server ──────────────────────────────────────────────────────
// Records every account_tx request it is asked, which is what lets test F
// assert anchor consistency against real traffic rather than against intent.
function makeServer(opts) {
  const o = opts || {};
  const state = {
    tip: o.tip,
    closeMs: o.closeMs,
    completeLedgers: o.completeLedgers === undefined ? ('32570-' + o.tip) : o.completeLedgers,
    txByAccount: o.txByAccount || {},
    requests: [],
    pageSize: o.pageSize || 3,
    validated: o.validated !== false
  };
  state.call = function (cmd) {
    if (cmd.command === 'ledger') {
      return {
        validated: state.validated,
        ledger_index: state.tip,
        ledger: { ledger_index: String(state.tip), close_time: toRipple(state.closeMs) }
      };
    }
    if (cmd.command === 'server_info') {
      return { info: { complete_ledgers: state.completeLedgers } };
    }
    if (cmd.command === 'account_tx') {
      state.requests.push({
        account: cmd.account,
        ledger_index_min: cmd.ledger_index_min,
        ledger_index_max: cmd.ledger_index_max
      });
      const all = (state.txByAccount[cmd.account] || [])
        .filter(t => {
          if (cmd.ledger_index_max !== -1 && t.ledger_index > cmd.ledger_index_max) return false;
          if (cmd.ledger_index_min !== -1 && t.ledger_index < cmd.ledger_index_min) return false;
          return true;
        })
        .sort((a, b) => b.ledger_index - a.ledger_index);
      const start = cmd.marker ? cmd.marker.at : 0;
      const page = all.slice(start, start + state.pageSize);
      const next = start + state.pageSize;
      return {
        transactions: page,
        marker: next < all.length ? { at: next } : undefined
      };
    }
    throw new Error('unexpected command ' + cmd.command);
  };
  return state;
}

function mkTx(ledgerIndex, closeMs, extra) {
  return Object.assign({
    ledger_index: ledgerIndex,
    tx_json: { TransactionType: 'Payment', hash: 'H' + ledgerIndex, date: toRipple(closeMs) },
    meta: {}
  }, extra || {});
}

// ── The scan, in production order ───────────────────────────────────────────
// Mirrors 02-core.js scanWallets: anchor first (ledger, then server_info),
// then the effective window, then a bounded walk per wallet.
function runScan(server, params) {
  const p = params || {};
  const ledgerRes = server.call({ command: 'ledger', ledger_index: 'validated' });
  const infoRes = p.skipServerInfo ? null : server.call({ command: 'server_info' });
  const anchor = RA.buildRunAnchor({ ledgerResult: ledgerRes, serverInfoResult: infoRes });

  const win = RA.effectiveWindow({
    requestedStartMs: p.requestedStartMs,
    requestedEndMs: p.requestedEndMs,
    anchor
  });

  const perWallet = {};
  for (const account of p.accounts) {
    const coverage = (p.coverageByAccount || {})[account] || null;
    let marker = null, pages = 0, rows = [];
    let boundaryReached = false, historyExhausted = false;
    let status = 'COMPLETE';
    let oldestLedger = null, newestLedger = null, oldestCloseMs = null, unindexed = 0;

    while (pages < (p.maxPages || 250)) {
      let req = { command: 'account_tx', account, ledger_index_min: -1, ledger_index_max: -1,
                  limit: 3, forward: false };
      req = RA.boundRequest(req, anchor, coverage);
      if (marker) req.marker = marker;

      let res;
      try { res = server.call(req); }
      catch (e) { status = 'FAILED'; break; }
      if (p.failAtPage && pages + 1 === p.failAtPage && account === p.failAccount) {
        status = 'FAILED'; break;
      }
      pages++;

      let oldestMs = Infinity;
      for (const item of res.transactions) {
        const adm = RA.admitRow(item, anchor);
        const ms = (item.tx_json.date + RIPPLE_EPOCH) * 1000;
        oldestMs = Math.min(oldestMs, ms);
        if (adm.ledger_index === null) unindexed++;
        else {
          if (oldestLedger === null || adm.ledger_index < oldestLedger) {
            oldestLedger = adm.ledger_index; oldestCloseMs = ms;
          }
          if (newestLedger === null || adm.ledger_index > newestLedger) newestLedger = adm.ledger_index;
        }
        if (ms >= win.start_ms && ms <= win.end_ms) rows.push(Object.assign({}, item, { ledger_index: adm.ledger_index }));
      }
      marker = res.marker || null;
      if (oldestMs <= win.start_ms) { boundaryReached = true; break; }
      if (!marker) { historyExhausted = true; break; }
    }
    if (status !== 'FAILED' && !boundaryReached && !historyExhausted) status = 'TRUNCATED';

    const bounded = RA.edgeRange(coverage, anchor).from_checkpoint === true;
    perWallet[account] = {
      status, pages_scanned: pages, rows,
      boundary_reached: boundaryReached,
      history_exhausted: historyExhausted,
      history_exhaustion_proof: anchor.ok ? anchor.history_exhaustion_proof : null,
      oldest_observed_ledger: oldestLedger,
      newest_observed_ledger: newestLedger,
      oldest_close_ms: oldestCloseMs,
      rows_without_ledger: unindexed,
      range_bound_proven: bounded
    };
  }
  return { anchor, win, perWallet, requests: server.requests };
}

// Turn a walk result into the checkpointAdvance input, then decide.
function decideCheckpoint(walk, anchor, coverage) {
  return COV.checkpointAdvance({
    coverage: coverage || null,
    anchorLedger: anchor.anchor_ledger,
    proof: {
      status: walk.status,
      range_bound_proven: walk.range_bound_proven,
      from_ledger: walk.range_bound_proven ? (coverage.scan_coverage_through + 1) : null,
      from_close_ms: walk.range_bound_proven ? coverage.scan_coverage_through_close_ms : null,
      through_ledger: anchor.anchor_ledger,
      through_close_ms: anchor.anchor_close_ms,
      boundary_reached: walk.boundary_reached,
      history_exhausted: walk.history_exhausted,
      history_exhaustion_proof: walk.history_exhaustion_proof,
      oldest_ledger_index: walk.oldest_observed_ledger,
      oldest_close_ms: walk.oldest_close_ms,
      rows_stored: walk.rows.length
    }
  });
}

const T0 = Date.parse('2026-09-06T08:00:00.000Z');
const HOUR = 3600000;

// ════════════════════════════════════════════════════════════════════════════
console.log('\n1. the anchor itself');
{
  const srv = makeServer({ tip: 106796295, closeMs: T0 });
  const a = RA.buildRunAnchor({
    ledgerResult: srv.call({ command: 'ledger' }),
    serverInfoResult: srv.call({ command: 'server_info' })
  });
  check('an anchor carries a sequence AND a close time', a.ok && a.anchor_ledger === 106796295 && a.anchor_close_ms === T0, a);
  check('both halves come from the SAME response, so they cannot disagree',
        a.anchor_close_iso === new Date(T0).toISOString(), a.anchor_close_iso);
  check('and the history proof is built from the server range for THIS anchor',
        a.history_exhaustion_proof.proven === true &&
        a.history_exhaustion_proof.anchor_ledger === 106796295,
        a.history_exhaustion_proof);

  // An unvalidated ledger can still change. It is not an anchor.
  const unval = makeServer({ tip: 500, closeMs: T0, validated: false });
  check('an unvalidated ledger is refused as an anchor',
        RA.buildRunAnchor({ ledgerResult: unval.call({ command: 'ledger' }) }).reason === 'LEDGER_NOT_VALIDATED');
  check('a missing close time is refused rather than guessed from the clock',
        RA.buildRunAnchor({ ledgerResult: { validated: true, ledger_index: 5, ledger: {} } }).reason === 'NO_CLOSE_TIME');
  check('a sequence of zero is not an anchor',
        RA.buildRunAnchor({ ledgerResult: { validated: true, ledger_index: 0, ledger: { close_time: 1 } } }).reason === 'NO_LEDGER_INDEX');
  check('no ledger response at all is refused',
        RA.buildRunAnchor({}).reason === 'NO_LEDGER_RESPONSE');

  // THE PROVENANCE RULE.
  const noInfo = RA.buildRunAnchor({ ledgerResult: srv.call({ command: 'ledger' }) });
  check('PROVENANCE — without server_info there is NO exhaustion proof',
        noInfo.ok === true && noInfo.history_exhaustion_proof === null &&
        noInfo.reason === 'ANCHOR_ESTABLISHED_NO_RANGE', noInfo);
  check('a partial-history server proves nothing even with a valid anchor',
        RA.buildRunAnchor({
          ledgerResult: srv.call({ command: 'ledger' }),
          serverInfoResult: { info: { complete_ledgers: '90000000-106796295' } }
        }).history_exhaustion_proof.proven === false);
  check('and a disjoint range proves nothing either',
        RA.buildRunAnchor({
          ledgerResult: srv.call({ command: 'ledger' }),
          serverInfoResult: { info: { complete_ledgers: '32570-50000,90000000-106796295' } }
        }).history_exhaustion_proof.reason === 'SERVER_HISTORY_DISJOINT');
}

// ════════════════════════════════════════════════════════════════════════════
console.log('\n2. every admitted row says which ledger it is in');
{
  const a = RA.buildRunAnchor({
    ledgerResult: { validated: true, ledger_index: L(1000), ledger: { close_time: toRipple(T0) } },
    serverInfoResult: { info: { complete_ledgers: '32570-' + L(1000) } }
  });
  check('the envelope form is read', RA.ledgerIndexOf({ ledger_index: 900 }) === 900);
  check('the legacy tx form is read', RA.ledgerIndexOf({ tx: { ledger_index: 901 } }) === 901);
  check('the tx_json form is read', RA.ledgerIndexOf({ tx_json: { ledger_index: 902 } }) === 902);
  check('a row with no ledger index yields null, NOT a guess',
        RA.ledgerIndexOf({ tx_json: { hash: 'x' } }) === null);
  check('and null is never coerced to zero — zero is a real ledger claim',
        RA.ledgerIndexOf({ ledger_index: 0 }) === null);

  const noIdx = RA.admitRow({ tx_json: {} }, a);
  check('a row without a ledger index is STILL EVIDENCE — it happened',
        noIdx.admit === true, noIdx);
  check('but it may not participate in a coverage proof',
        noIdx.proves_coverage === false && noIdx.reason === 'NO_LEDGER_INDEX', noIdx);
  check('a row inside the anchor proves coverage',
        RA.admitRow({ ledger_index: L(999) }, a).proves_coverage === true);
  check('a row the server answered PAST the anchor is kept but proves nothing',
        RA.admitRow({ ledger_index: L(1001) }, a).reason === 'BEYOND_ANCHOR' &&
        RA.admitRow({ ledger_index: L(1001) }, a).proves_coverage === false);

  const obs = RA.observedLedgerRange([{ ledger_index: 5 }, { ledger_index: 9 }, { ledger_index: null }]);
  check('the observed range reports both bounds and counts the unindexed',
        obs.oldest_ledger === 5 && obs.newest_ledger === 9 &&
        obs.rows_with_ledger === 2 && obs.rows_without_ledger === 1, obs);
  check('an empty set has NO observed floor — not a floor of zero',
        RA.observedLedgerRange([]).oldest_ledger === null);
}

// ════════════════════════════════════════════════════════════════════════════
console.log('\nA. fresh wallet, no checkpoint  ->  date bootstrap, checkpoint earned');
{
  const tip = L(5000);
  const srv = makeServer({
    tip, closeMs: T0,
    txByAccount: { rFRESH: [
      mkTx(L(4990), T0 - 1 * HOUR), mkTx(L(4980), T0 - 3 * HOUR),
      mkTx(L(4970), T0 - 10 * HOUR), mkTx(L(4960), T0 - 30 * HOUR)   // older than the window
    ] }
  });
  const r = runScan(srv, { accounts: ['rFRESH'], requestedStartMs: T0 - 24 * HOUR, requestedEndMs: T0 });
  const w = r.perWallet.rFRESH;

  check('A. with no checkpoint the walk is date-bounded, not ledger-bounded',
        w.range_bound_proven === false && r.requests[0].ledger_index_min === -1, r.requests[0]);
  check('A. it reads past the window start and says so',
        w.boundary_reached === true, w);
  check('A. status COMPLETE', w.status === 'COMPLETE');
  const d = decideCheckpoint(w, r.anchor, null);
  check('A. a checkpoint IS established from a date walk',
        d.advance === true && d.reason === 'BOOTSTRAP_BOUNDARY_REACHED', d);
  check('A. and it is anchored at the run anchor, not at the newest transaction',
        d.next_through === tip, d);
  check('A. its floor is a ledger that was actually READ',
        d.next_from === w.oldest_observed_ledger && d.next_from === L(4960), d);
  check('A. expected_prior is NULL for a first checkpoint (IS NULL, not = NULL)',
        d.expected_prior === null, d);
}

// ════════════════════════════════════════════════════════════════════════════
console.log('\nB. immediate second run  ->  numeric edge range, no re-walk of history');
{
  const tip1 = L(5000);
  const txs = [mkTx(L(4990), T0 - 1 * HOUR), mkTx(L(4980), T0 - 3 * HOUR),
               mkTx(L(4970), T0 - 10 * HOUR), mkTx(L(4960), T0 - 30 * HOUR)];
  const srv1 = makeServer({ tip: tip1, closeMs: T0, txByAccount: { rW: txs.slice() } });
  const r1 = runScan(srv1, { accounts: ['rW'], requestedStartMs: T0 - 24 * HOUR, requestedEndMs: T0 });
  const d1 = decideCheckpoint(r1.perWallet.rW, r1.anchor, null);
  const coverage = {
    scan_coverage_from: d1.next_from, scan_coverage_through: d1.next_through,
    scan_coverage_from_close_ms: d1.next_from_close_ms,
    scan_coverage_through_close_ms: d1.next_through_close_ms
  };
  const run1Pages = r1.perWallet.rW.pages_scanned;

  // Second run, moments later: three new ledgers, one new transaction.
  const tip2 = L(5003);
  const srv2 = makeServer({
    tip: tip2, closeMs: T0 + 12000,
    txByAccount: { rW: txs.concat([mkTx(L(5002), T0 + 10000)]) }
  });
  const r2 = runScan(srv2, {
    accounts: ['rW'], requestedStartMs: T0 - 24 * HOUR, requestedEndMs: T0 + 12000,
    coverageByAccount: { rW: coverage }
  });
  const w2 = r2.perWallet.rW;
  const req2 = r2.requests[0];

  check('B. the second run asks for a NUMERIC edge range, not -1',
        req2.ledger_index_min === tip1 + 1, req2);
  check('B. bounded above by the NEW anchor', req2.ledger_index_max === tip2, req2);
  check('B. the walk is ledger-bounded, not a date bootstrap',
        w2.range_bound_proven === true);
  check('B. THE MILESTONE — it does not re-read proven history',
        w2.pages_scanned === 1 && run1Pages > 1, { run1: run1Pages, run2: w2.pages_scanned });
  check('B. and it still returns the new transaction',
        w2.rows.length === 1 && w2.rows[0].ledger_index === L(5002), w2.rows.map(r => r.ledger_index));
  check('B. none of the already-proven ledgers were requested again',
        !w2.rows.some(r => r.ledger_index <= tip1), w2.rows.map(r => r.ledger_index));
  const d2 = decideCheckpoint(w2, r2.anchor, coverage);
  check('B. the checkpoint advances to the new anchor',
        d2.advance === true && d2.next_through === tip2, d2);
  check('B. under a compare-and-set against the value it expected to replace',
        d2.expected_prior === tip1, d2);

  // A coverage row is only a floor if it is a WHOLE one. These two shapes both
  // carry a plausible-looking scan_coverage_through, and narrowing a request
  // on either would ask confidently for a range whose own record is broken —
  // the wallet would then skip everything below a floor nothing established.
  const anchorB = r2.anchor;
  const halfWritten = { scan_coverage_from: null, scan_coverage_through: tip1,
                        scan_coverage_from_close_ms: null, scan_coverage_through_close_ms: T0 };
  check('B. a HALF-WRITTEN coverage row is not a floor',
        RA.edgeRange(halfWritten, anchorB).from_checkpoint === false &&
        RA.edgeRange(halfWritten, anchorB).ledger_index_min === -1,
        RA.edgeRange(halfWritten, anchorB));
  const inverted = { scan_coverage_from: tip1, scan_coverage_through: tip1 - 500,
                     scan_coverage_from_close_ms: T0, scan_coverage_through_close_ms: T0 };
  check('B. nor is an INVERTED one, however numeric it looks',
        RA.edgeRange(inverted, anchorB).from_checkpoint === false,
        RA.edgeRange(inverted, anchorB));
  check('B. and a wallet already proven THROUGH the anchor has no edge to read',
        RA.edgeRange({ scan_coverage_from: 1, scan_coverage_through: anchorB.anchor_ledger,
                       scan_coverage_from_close_ms: 0, scan_coverage_through_close_ms: T0 },
                     anchorB).reason === 'ALREADY_AT_ANCHOR');
}

// ════════════════════════════════════════════════════════════════════════════
console.log('\nC. many runs in one day  ->  fresh anchor each time, only the edge fetched');
{
  // Five transactions against a three-row page, with the oldest outside the
  // window: the first run genuinely pages twice before it reads past the
  // window start. A three-row fixture fit in a single page and made run 1 look
  // as cheap as run 5 — which would have "passed" the milestone check by
  // having no history to re-walk in the first place.
  const txs = [mkTx(L(4990), T0 - 1 * HOUR), mkTx(L(4985), T0 - 3 * HOUR),
               mkTx(L(4980), T0 - 6 * HOUR), mkTx(L(4970), T0 - 10 * HOUR),
               mkTx(L(4960), T0 - 30 * HOUR)];
  let coverage = null, tip = L(5000), closeMs = T0;
  const anchors = [], mins = [], pageCounts = [];

  for (let run = 0; run < 5; run++) {
    const srv = makeServer({ tip, closeMs, txByAccount: { rW: txs.slice() } });
    const r = runScan(srv, {
      accounts: ['rW'], requestedStartMs: T0 - 24 * HOUR, requestedEndMs: closeMs,
      coverageByAccount: coverage ? { rW: coverage } : {}
    });
    anchors.push(r.anchor.anchor_ledger);
    mins.push(r.requests[0].ledger_index_min);
    pageCounts.push(r.perWallet.rW.pages_scanned);
    const d = decideCheckpoint(r.perWallet.rW, r.anchor, coverage);
    if (d.advance) {
      coverage = {
        scan_coverage_from: d.next_from, scan_coverage_through: d.next_through,
        scan_coverage_from_close_ms: d.next_from_close_ms,
        scan_coverage_through_close_ms: d.next_through_close_ms
      };
    }
    tip += 20; closeMs += 60000;   // the ledger advances between runs
  }

  check('C. every run gets its OWN fresh validated anchor',
        new Set(anchors).size === 5, anchors);
  check('C. the anchors advance rather than repeating a stale one',
        anchors.every((v, i) => i === 0 || v > anchors[i - 1]), anchors);
  check('C. only the FIRST run walks by date',
        mins[0] === -1 && mins.slice(1).every(m => m > 0), mins);
  check('C. every later run asks from exactly the previous anchor + 1',
        mins.slice(1).every((m, i) => m === anchors[i] + 1), { mins, anchors });
  check('C. previously proven evidence is never re-walked',
        pageCounts.slice(1).every(p => p <= 1), pageCounts);
  check('C. the twentieth run of a day is as cheap as the second — the 24h window is not an execution limit',
        pageCounts[4] <= 1 && pageCounts[0] > 1, pageCounts);
}

// ════════════════════════════════════════════════════════════════════════════
console.log('\nD. partial-history server  ->  no marker is NOT proof, checkpoint holds');
{
  const tip = L(5000);
  // The account's whole visible history is inside the window, so the walk runs
  // out of pages without ever reading past the window start: history_exhausted,
  // boundary NOT reached. On a full-history server that is a real proof.
  const txs = [mkTx(L(4990), T0 - 1 * HOUR), mkTx(L(4980), T0 - 2 * HOUR)];

  const full = makeServer({ tip, closeMs: T0, completeLedgers: '32570-' + L(5000), txByAccount: { rP: txs.slice() } });
  const rFull = runScan(full, { accounts: ['rP'], requestedStartMs: T0 - 24 * HOUR, requestedEndMs: T0 });
  check('D. control — on a FULL-history server exhaustion is a real proof',
        rFull.perWallet.rP.history_exhausted === true &&
        decideCheckpoint(rFull.perWallet.rP, rFull.anchor, null).advance === true,
        decideCheckpoint(rFull.perWallet.rP, rFull.anchor, null));

  const partial = makeServer({ tip, closeMs: T0, completeLedgers: (L(4900)) + '-' + L(5000), txByAccount: { rP: txs.slice() } });
  const rPart = runScan(partial, { accounts: ['rP'], requestedStartMs: T0 - 24 * HOUR, requestedEndMs: T0 });
  const wPart = rPart.perWallet.rP;
  check('D. the walk looks identical — same no-marker ending',
        wPart.history_exhausted === true && wPart.boundary_reached === false, wPart);
  check('D. but the server range refuses the proof',
        rPart.anchor.history_exhaustion_proof.proven === false &&
        rPart.anchor.history_exhaustion_proof.reason === 'SERVER_HISTORY_PARTIAL',
        rPart.anchor.history_exhaustion_proof);
  const dPart = decideCheckpoint(wPart, rPart.anchor, null);
  check('D. THE REGRESSION — the checkpoint DOES NOT advance',
        dPart.advance === false && dPart.reason === 'HISTORY_EXHAUSTION_UNPROVEN', dPart);

  // No server_info at all must be treated the same as a partial one.
  const noInfo = makeServer({ tip, closeMs: T0, txByAccount: { rP: txs.slice() } });
  const rNo = runScan(noInfo, { accounts: ['rP'], requestedStartMs: T0 - 24 * HOUR, requestedEndMs: T0, skipServerInfo: true });
  check('D. an unavailable server_info also proves nothing',
        decideCheckpoint(rNo.perWallet.rP, rNo.anchor, null).advance === false,
        decideCheckpoint(rNo.perWallet.rP, rNo.anchor, null));
}

// ════════════════════════════════════════════════════════════════════════════
console.log('\nE. partial / truncated / failed  ->  prior checkpoint preserved');
{
  const tip = L(6000);
  const prior = {
    scan_coverage_from: L(4000), scan_coverage_through: L(5000),
    scan_coverage_from_close_ms: T0 - 40 * HOUR, scan_coverage_through_close_ms: T0 - HOUR
  };
  const many = [];
  for (let i = 0; i < 40; i++) many.push(mkTx(L(5900 - i), T0 - (i * 6) * 60000));

  // TRUNCATED: the safety ceiling stopped the walk.
  const srvT = makeServer({ tip, closeMs: T0, txByAccount: { rT: many.slice() } });
  const rT = runScan(srvT, { accounts: ['rT'], requestedStartMs: T0 - 24 * HOUR, requestedEndMs: T0, maxPages: 2 });
  check('E. a safety ceiling yields TRUNCATED, not COMPLETE',
        rT.perWallet.rT.status === 'TRUNCATED', rT.perWallet.rT.status);
  const dT = COV.checkpointAdvance({
    coverage: prior, anchorLedger: tip,
    proof: { status: rT.perWallet.rT.status, through_ledger: tip, through_close_ms: T0 }
  });
  check('E. TRUNCATED does not advance the checkpoint',
        dT.advance === false && dT.reason === 'PROOF_NOT_COMPLETE', dT);
  check('E. and the prior checkpoint is reported back unchanged',
        dT.next_through === L(5000), dT);

  // FAILED mid-walk.
  const srvF = makeServer({ tip, closeMs: T0, txByAccount: { rF: many.slice() } });
  const rF = runScan(srvF, { accounts: ['rF'], requestedStartMs: T0 - 24 * HOUR, requestedEndMs: T0,
                             failAtPage: 2, failAccount: 'rF' });
  check('E. a mid-walk failure yields FAILED', rF.perWallet.rF.status === 'FAILED');
  const dF = COV.checkpointAdvance({
    coverage: prior, anchorLedger: tip,
    proof: { status: 'FAILED', through_ledger: tip, through_close_ms: T0 }
  });
  check('E. FAILED does not advance either', dF.advance === false && dF.next_through === L(5000), dF);

  // An aborted RUN must not roll back wallets already proven.
  const srvM = makeServer({
    tip, closeMs: T0,
    txByAccount: { rOK: [mkTx(L(5990), T0 - HOUR), mkTx(L(5000), T0 - 30 * HOUR)], rBAD: many.slice() }
  });
  const rM = runScan(srvM, { accounts: ['rOK', 'rBAD'], requestedStartMs: T0 - 24 * HOUR, requestedEndMs: T0,
                             failAtPage: 1, failAccount: 'rBAD' });
  check('E. in a run that dies partway, the completed wallet still proves',
        decideCheckpoint(rM.perWallet.rOK, rM.anchor, null).advance === true);
  check('E. and the failed one does not — independently, in the same run',
        rM.perWallet.rBAD.status === 'FAILED');
  check('E. so the run as a whole is not sealable',
        COV.sealable([{ status: 'COMPLETE', covers_window_start: true },
                       { status: 'FAILED' }]).full_window_complete === false);
}

// ════════════════════════════════════════════════════════════════════════════
console.log('\nF. anchor consistency  ->  one run, one ledger_index_max');
{
  const accounts = [];
  const txByAccount = {};
  for (let i = 0; i < 12; i++) {
    const a = 'rACC' + i;
    accounts.push(a);
    txByAccount[a] = [mkTx(L(5900 - i), T0 - HOUR), mkTx(L(4000 - i), T0 - 40 * HOUR)];
  }
  const srv = makeServer({ tip: L(6000), closeMs: T0, txByAccount });
  const r = runScan(srv, { accounts, requestedStartMs: T0 - 24 * HOUR, requestedEndMs: T0 });

  check('F. every wallet was actually asked', r.requests.length >= accounts.length, r.requests.length);
  const same = RA.sameAnchorAcross(r.requests);
  check('F. THE REGRESSION — every account_tx in the run shares one ledger_index_max',
        same.consistent === true && same.reason === 'ONE_ANCHOR', same);
  check('F. and that value is the run anchor, not -1',
        same.values.length === 1 && same.values[0] === L(6000), same.values);

  // The consistency check must itself be able to fail, or it proves nothing.
  check('F. drift is detected when it exists',
        RA.sameAnchorAcross([{ ledger_index_max: 10 }, { ledger_index_max: 11 }]).reason === 'ANCHOR_DRIFT');
  check('F. and an unbounded request is NOT called consistent',
        RA.sameAnchorAcross([{ ledger_index_max: -1 }, { ledger_index_max: -1 }]).reason === 'UNBOUNDED');
  check('F. no requests at all is not consistency either',
        RA.sameAnchorAcross([]).consistent === false);

  // A server that advances mid-run must not drag the run with it.
  const srv2 = makeServer({ tip: L(6000), closeMs: T0, txByAccount });
  const anchorRes = srv2.call({ command: 'ledger' });
  const infoRes = srv2.call({ command: 'server_info' });
  const anchor = RA.buildRunAnchor({ ledgerResult: anchorRes, serverInfoResult: infoRes });
  srv2.tip = L(6400);                    // catch-up mid-run
  const late = RA.boundRequest({ command: 'account_tx', account: 'rLATE' }, anchor);
  check('F. a mid-run server catch-up does not move the running report\'s ceiling',
        late.ledger_index_max === L(6000), late);
}

// ════════════════════════════════════════════════════════════════════════════
console.log('\nG. window consistency  ->  capped, and CONSUMED');
{
  const anchorCloseMs = T0;
  const srv = makeServer({ tip: L(7000), closeMs: anchorCloseMs, txByAccount: { rW: [mkTx(L(6990), T0 - HOUR)] } });
  // The browser asks for a window ending ten minutes past the last closed
  // ledger — the ordinary case for a clock that is even slightly ahead.
  const r = runScan(srv, { accounts: ['rW'], requestedStartMs: T0 - 24 * HOUR, requestedEndMs: T0 + 10 * 60000 });

  check('G. the requested end beyond the anchor is capped',
        r.win.capped === true && r.win.end_ms === anchorCloseMs, r.win);
  check('G. and the overreach is reported rather than swallowed',
        r.win.claimed_beyond_ms === 10 * 60000, r.win.claimed_beyond_ms);
  check('G. the effective window never extends past the anchor close',
        r.win.end_ms <= r.anchor.anchor_close_ms);
  check('G. a window already inside the anchor is left alone',
        RA.effectiveWindow({ requestedStartMs: T0 - HOUR, requestedEndMs: T0 - 60000,
                             anchor: r.anchor }).capped === false);
  check('G. a reversed window is normalised rather than producing a negative span',
        RA.effectiveWindow({ requestedStartMs: T0, requestedEndMs: T0 - HOUR, anchor: r.anchor }).start_ms === T0 - HOUR);
  check('G. with no anchor the window is passed through but SAID to be unbounded',
        RA.effectiveWindow({ requestedStartMs: T0 - HOUR, requestedEndMs: T0,
                             anchor: { ok: false } }).bounded_by_anchor === false);
  check('G. a non-numeric window is refused, not silently zeroed', (() => {
    try { RA.effectiveWindow({ requestedStartMs: null, requestedEndMs: T0, anchor: r.anchor }); return false; }
    catch (e) { return /numeric/.test(e.message); }
  })());

  // THE HALF THAT WAS MISSING. A cap nothing reads changes nothing.
  const CORE = fs.readFileSync(path.join(__dirname, '..', 'src/brief/02-core.js'), 'utf8');
  const stripComments = t => t.split('\n').map(l => l.replace(/\/\/.*$/, '')).join('\n');
  const CORE_CODE = stripComments(CORE);
  check('G. CONSUMED — buildPack reads the effective window, not getTxWindow()',
        /tx_window:\s*\(typeof state[^,]*state\.txWindowEffective\)\s*\|\|\s*getTxWindow\(\)/.test(CORE_CODE),
        (CORE_CODE.match(/tx_window:[^\n]*/) || ['<absent>'])[0]);
  check('G. and the scan itself walks the capped window',
        /const tw = ew[\s\S]{0,400}?endMs: ew\.end_ms/.test(CORE_CODE));
  check('G. the pack exposes the cap so a surface can say the window moved',
        /window_capped_to_anchor:/.test(CORE_CODE) && /claimed_beyond_anchor_ms:/.test(CORE_CODE));
}

// ════════════════════════════════════════════════════════════════════════════
console.log('\n3. the wiring is real, not just the decision layer');
{
  const CORE = fs.readFileSync(path.join(__dirname, '..', 'src/brief/02-core.js'), 'utf8');
  const L17 = fs.readFileSync(path.join(__dirname, '..', 'src/brief/17-report-scan-tuning-20260816.js'), 'utf8');
  const L29 = fs.readFileSync(path.join(__dirname, '..', 'src/brief/29-targeted-news-suppression-20260817.js'), 'utf8');
  const stripComments = t => t.split('\n').map(l => l.replace(/\/\/.*$/, '')).join('\n');
  const C = stripComments(CORE), S17 = stripComments(L17), S29 = stripComments(L29);

  check('the anchor is fetched at scan start, before any wallet is read',
        /state\.runAnchor = null[\s\S]{0,900}?command: 'ledger', ledger_index: 'validated'/.test(C));
  check('and server_info is fetched AFTER the anchor, not before',
        C.indexOf("command: 'ledger', ledger_index: 'validated'") <
        C.indexOf("command: 'server_info'"), {
          ledger: C.indexOf("command: 'ledger', ledger_index: 'validated'"),
          info: C.indexOf("command: 'server_info'")
        });
  check('the window is recomputed at scan start for an AUTO window',
        /state\._txWindowAuto && typeof applyAutoTxWindow === 'function'\) applyAutoTxWindow\(\)/.test(C));
  check('the row carries a ledger_index', /ledger_index: _adm\.ledger_index/.test(C));
  check('the escrow path no longer hardcodes ledger: null',
        !/ledger: null \}/.test(C) && /ledger: \(t\.ledger_index === undefined \? null : t\.ledger_index\)/.test(C));

  // Layer 17 REPLACES the core walker, so bounding only the core one would be
  // a fix that never runs.
  check('layer 17 — the walker that actually runs — is bounded too',
        /req = RA\.boundRequest\(req, runAnchor\)/.test(S17), 'boundRequest missing from layer 17');
  check('layer 17 records the ledger span it actually read',
        /oldest_observed_ledger:/.test(S17) && /newest_observed_ledger:/.test(S17));
  check('layer 17 carries the run proof rather than minting its own',
        /history_exhaustion_proof: \(runAnchor && runAnchor\.ok\)/.test(S17));
  check('both new layers are injected into the console',
        /41-run-anchor-20260906\.js/.test(S29) && /src\/db\/coverage\.js/.test(S29));
}

// ════════════════════════════════════════════════════════════════════════════
console.log('\n4. read-only, still');
{
  const files = ['src/brief/41-run-anchor-20260906.js'];
  let bad = [];
  for (const f of files) {
    const src = fs.readFileSync(path.join(__dirname, '..', f), 'utf8');
    if (/\bsubmit\b|\bsign\b|\bseed\b|secret_key|master_seed/i.test(src.replace(/\/\/.*$/gm, ''))) bad.push(f);
  }
  check('the anchor layer contains no signing, submit or seed path', bad.length === 0, bad);
  check('and issues no requests of its own — it only shapes them',
        !/fetch\(|XMLHttpRequest|WebSocket/.test(
          fs.readFileSync(path.join(__dirname, '..', 'src/brief/41-run-anchor-20260906.js'), 'utf8')));
}

console.log('\n' + (fail ? fail + ' FAILED of ' + (pass + fail) : 'ALL ' + pass + ' CHECKS PASS'));
process.exit(fail ? 1 : 0);
