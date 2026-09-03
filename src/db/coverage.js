// XRPMAN Shadow Watch — coverage decisions. Server-side only (Node/Vercel).
//
// ── What this file is for ───────────────────────────────────────────────────
// Today a Report re-walks all 251 wallet histories every morning, because
// 17-report-scan-tuning-20260816.js:332 blanks the balance snapshot so every
// wallet enters Phase 2, and every account_tx goes out with
// `ledger_index_min: -1` (02-core.js:1067) — the window boundary is found by
// reading PAST it. That is what buys the on-air claim "251/251 proved the
// transaction window", and it is also why a cold run takes 15-20 minutes.
//
// The index makes the claim cheap instead of making it weaker. If a wallet was
// already proven through ledger X, this run only has to prove [X+1 .. anchor].
// A quiet wallet costs one page that comes back empty — and an exhausted empty
// range PROVES nothing happened, which is a stronger statement than skipping
// the wallet on the strength of an unchanged XRP balance.
//
// ── Why the decisions live in their own file, with no database in them ──────
// Every function below is pure: facts in, decision out. That is deliberate.
// The failure mode this project keeps hitting is a component asserting
// something it never verified, and the guard against it is a test that can
// actually run. A decision that needs a live Postgres to exercise would be
// tested by nobody; these run in CI in milliseconds with no database, no
// network and no browser.
//
// ── The three facts that must never be conflated ───────────────────────────
//   WHAT HAPPENED           transaction evidence          `transactions`
//   WHAT WE HAVE PROVEN     wallet ledger coverage        `wallet_coverage`
//   WHAT THE REPORT MAY     canonical model + a window
//   CLAIM                   proven end to end
//
// Proof and evidence are separate columns because pruning old rows must never
// make an empty query read as "zero transactions in the window". A window is
// servable from the index only when BOTH the proof range and the retained
// evidence range cover it. Otherwise we fall back to XRPL, or we say the window
// is incomplete. We never render silence as a zero.
'use strict';

// ── Reasons ────────────────────────────────────────────────────────────────
// A decision always carries one of these, so a caller (and a log line, and a
// test) can name WHY a window was or was not served from the index.
const REASON = {
  NO_COVERAGE:       'NO_COVERAGE',        // wallet has never been proven at all
  PROOF_GAP_AT_START:'PROOF_GAP_AT_START', // window starts before proven history
  EVIDENCE_PRUNED:   'EVIDENCE_PRUNED',    // proven, but the rows are gone
  EDGE_ONLY:         'EDGE_ONLY',          // the normal case: fetch the new ledgers
  FULLY_SERVABLE:    'FULLY_SERVABLE'      // a catch-up already passed our anchor
};

const PROOF_STATUS = {
  COMPLETE:  'COMPLETE',
  TRUNCATED: 'TRUNCATED',
  FAILED:    'FAILED'
};

// NULL is not zero. `Number(null)` is 0 and `Number('')` is 0, so a naive
// Number() coercion turns every unset column of a never-scanned wallet into
// ledger 0 — and then hasProof() answers TRUE, proven_start compares
// `0 <= windowStart` and answers TRUE, and windowServability reports
// EDGE_ONLY / served_from_index for a wallet nothing was ever read for. That
// is a coverage claim asserted with no proof behind it, on a surface that is
// read aloud on air. A database returns a ROW OF NULLS for an unscanned
// wallet; nothing but a real number may become one here.
function _int(v) {
  if (v === null || v === undefined) return null;
  if (typeof v === 'string' && v.trim() === '') return null;
  if (typeof v === 'boolean') return null;
  const n = Number(v);
  return Number.isFinite(n) ? Math.trunc(n) : null;
}

// A coverage row that has never been written reads the same as one whose
// columns are all NULL. Both mean "nothing proven", and both must take the
// full-window fallback rather than quietly serving an empty result.
function normalizeCoverage(row) {
  const r = row || {};
  return {
    address:                       r.address || '',
    scan_coverage_from:            _int(r.scan_coverage_from),
    scan_coverage_through:         _int(r.scan_coverage_through),
    scan_coverage_from_close_ms:   _int(r.scan_coverage_from_close_ms),
    scan_coverage_through_close_ms:_int(r.scan_coverage_through_close_ms),
    evidence_retained_from:        _int(r.evidence_retained_from),
    evidence_retained_through:     _int(r.evidence_retained_through),
    evidence_retained_from_close_ms:_int(r.evidence_retained_from_close_ms),
    last_observed_tx_ledger:       _int(r.last_observed_tx_ledger),
    roster_version:                r.roster_version || null
  };
}

function hasProof(c) {
  return c.scan_coverage_from !== null &&
         c.scan_coverage_through !== null &&
         c.scan_coverage_through >= c.scan_coverage_from;
}

// ── Decision 1: can this window come out of the index? ─────────────────────
//
// The window arrives in TIME (the Report's window is [startMs, endMs]); the
// fetch has to go out in LEDGERS (an explicit numeric ledger_index_min, which
// is the whole point of the exercise). We bridge the two with the close times
// recorded alongside the coverage bounds, so no time-to-ledger oracle is
// needed — XRPL has no "which ledger closed at this instant" lookup, and
// inventing one by interpolation would be inventing a ledger value.
//
// Two gaps are possible and they are NOT the same gap:
//
//   front gap   the window starts before our proven history begins.
//               First-ever scan, or a coverage reset. We cannot express the
//               fetch as a ledger range, because we do not know which ledger
//               was closing at windowStartMs. So we fall back to exactly what
//               the app does today: walk back by date. Honest, and slow, and
//               only on the first run.
//
//   edge gap    proven coverage ends before this run's anchor. This is the
//               normal morning case and the reason the index exists: fetch
//               [scan_coverage_through + 1 .. anchor] and nothing else.
function windowServability(input) {
  const c = normalizeCoverage(input && input.coverage);
  const startMs = _int(input && input.windowStartMs);
  const endMs   = _int(input && input.windowEndMs);
  const anchor  = _int(input && input.anchorLedger);

  // An anchor is not optional. Without one immutable validated-ledger ceiling
  // per Report, a concurrent catch-up can advance the shared index mid-run and
  // wallet 3 would describe a different ledger state than wallet 200.
  if (anchor === null || anchor <= 0) {
    throw new Error('windowServability: a numeric anchorLedger is required');
  }
  if (startMs === null || endMs === null || endMs < startMs) {
    throw new Error('windowServability: windowStartMs/windowEndMs must bound a real window');
  }

  const base = {
    address: c.address,
    anchor_ledger: anchor,
    window_start_ms: startMs,
    window_end_ms: endMs,
    proven_start: false,
    evidence_covers_start: false,
    evidence_covers_proof_edge: false,
    served_from_index: false,
    // null means "we cannot bound this in ledger space — walk back by date".
    fetch_from_ledger: null,
    fetch_to_ledger: anchor,
    range_bound_proven: false,
    // Whether the index alone already satisfies the window. Never true while a
    // fetch is still outstanding.
    complete_without_fetch: false,
    reason: REASON.NO_COVERAGE
  };

  if (!hasProof(c)) return base;

  // Does the PROOF reach back to the start of the window?
  base.proven_start = c.scan_coverage_from_close_ms !== null &&
                      c.scan_coverage_from_close_ms <= startMs;

  // Does the retained EVIDENCE reach back to the start of the window? Proof
  // without evidence is the pruning trap: the range is proven, the rows are
  // gone, and a naive query returns zero rows that read as "nothing happened".
  //
  // The test is the CLOSE TIME against the window start, and nothing else.
  // An earlier version also required `evidence_retained_from <=
  // scan_coverage_from`, which contradicted the schema's own CHECK
  // (`evidence_retained_from >= scan_coverage_from`, since retained evidence
  // is a subset of proven coverage). Only equality satisfied both, so the day
  // retention first pruned anything, EVERY window fell back to a full XRPL
  // walk and the index stopped helping at all — the exact cost it exists to
  // remove. Retention prunes the old end; whether it has moved past the
  // proof's lower bound is irrelevant. What matters is only whether the rows
  // the window needs are still here.
  base.evidence_covers_start =
    c.evidence_retained_from !== null &&
    c.evidence_retained_from_close_ms !== null &&
    c.evidence_retained_from_close_ms <= startMs;

  // And is there a HOLE between the retained evidence and the proof edge?
  // Time-based retention prunes from the old end, so this should hold; if it
  // ever does not, rows are missing from the middle of a range we call proven,
  // and serving that window would under-report. Refuse rather than trust it.
  base.evidence_covers_proof_edge =
    c.evidence_retained_through !== null &&
    c.evidence_retained_through >= c.scan_coverage_through;

  if (!base.proven_start) {
    base.reason = REASON.PROOF_GAP_AT_START;
    return base;                       // date-bounded fallback, nothing served
  }
  if (!base.evidence_covers_start || !base.evidence_covers_proof_edge) {
    base.reason = REASON.EVIDENCE_PRUNED;
    return base;                       // same fallback, different cause
  }

  // Past this point the index owns the history side of the window. What is
  // left is the edge between the last proof and this run's anchor.
  base.served_from_index = true;
  base.range_bound_proven = true;

  if (c.scan_coverage_through >= anchor) {
    // A server-side catch-up has already proven past our anchor. Nothing to
    // fetch: this is the "second report takes seconds" case.
    base.reason = REASON.FULLY_SERVABLE;
    base.complete_without_fetch = true;
    base.fetch_from_ledger = null;
    base.fetch_to_ledger = anchor;
    return base;
  }

  base.reason = REASON.EDGE_ONLY;
  base.fetch_from_ledger = c.scan_coverage_through + 1;
  base.fetch_to_ledger = anchor;
  return base;
}

// ── Decision 2: may this wallet's checkpoint move? ─────────────────────────
//
// Refusing to advance costs one wallet one extra scan tomorrow. Advancing
// wrongly puts a coverage claim on air that was never proven. The asymmetry
// decides every rule below.
function checkpointAdvance(input) {
  const c = normalizeCoverage(input && input.coverage);
  const p = (input && input.proof) || {};
  const anchor = _int(input && input.anchorLedger);
  if (anchor === null || anchor <= 0) {
    throw new Error('checkpointAdvance: a numeric anchorLedger is required');
  }

  const from    = _int(p.from_ledger);
  const through = _int(p.through_ledger);
  const status  = String(p.status || PROOF_STATUS.FAILED);

  const refuse = (reason) => ({
    advance: false,
    reason,
    expected_prior: c.scan_coverage_through,
    next_through: c.scan_coverage_through,
    next_through_close_ms: c.scan_coverage_through_close_ms
  });

  // A safety ceiling is not a proof. TX_SAFETY_MAX_PAGES stopping the walk
  // (17-report-scan-tuning-20260816.js:21) yields TRUNCATED, and TRUNCATED
  // must read as "we do not know", never as "we looked and it was quiet".
  if (status !== PROOF_STATUS.COMPLETE) return refuse('PROOF_NOT_COMPLETE');

  // The walk must have been bounded in ledger space for its result to move a
  // ledger checkpoint. A date-bounded fallback walk (the `-1` retention retry)
  // still yields usable evidence, but it cannot prove a ledger RANGE.
  if (p.range_bound_proven !== true) return refuse('RANGE_NOT_LEDGER_BOUND');

  if (from === null || through === null || through < from) {
    return refuse('PROOF_RANGE_MALFORMED');
  }

  // A checkpoint without close times is a checkpoint no window can ever be
  // decided against: windowServability compares the window start against
  // scan_coverage_from_close_ms, and a null there means proven_start is always
  // false. Writing one would record an advance in coverage_advances that reads
  // as progress while the wallet silently falls back to a full walk forever.
  // Refuse it here, where the reason is visible.
  const fromClose = hasProof(c) ? c.scan_coverage_from_close_ms : _int(p.from_close_ms);
  if (fromClose === null || _int(p.through_close_ms) === null) {
    return refuse('PROOF_MISSING_CLOSE_TIMES');
  }

  // Never claim coverage of ledgers this run did not read. A gap between the
  // existing checkpoint and the proven range would be exactly that.
  if (hasProof(c) && from > c.scan_coverage_through + 1) {
    return refuse('PROOF_RANGE_NOT_CONTIGUOUS');
  }

  // Never advance past the run's own ceiling. A checkpoint at anchor+N would
  // let tomorrow's run skip ledgers nobody ever read.
  if (through > anchor) return refuse('PROOF_EXCEEDS_ANCHOR');

  // Monotonic. A slower worker finishing late must not drag the shared
  // checkpoint backwards; the compare-and-set below is the second half of
  // that guarantee, and this is the first.
  if (hasProof(c) && through <= c.scan_coverage_through) {
    return refuse('NO_FORWARD_PROGRESS');
  }

  return {
    advance: true,
    // An empty range that was walked to exhaustion is a real proof, and saying
    // so is the difference between "quiet wallets get cheap" and "quiet
    // wallets rescan proven history forever".
    reason: (_int(p.rows_stored) || 0) === 0 ? 'EMPTY_RANGE_EXHAUSTED' : 'RANGE_PROVEN',
    // The compare-and-set predicate. NULL for a wallet with no prior proof —
    // the SQL side must compare with IS NULL, not `= NULL`.
    expected_prior: hasProof(c) ? c.scan_coverage_through : null,
    next_from: hasProof(c) ? c.scan_coverage_from : from,
    next_from_close_ms: fromClose,
    next_through: through,
    next_through_close_ms: _int(p.through_close_ms)
  };
}

// ── Decision 3: may the Report seal this window as complete? ───────────────
//
// coverageFrom (17-report-scan-tuning-20260816.js:199) already computes the
// rendered claim from target/complete/failed/truncated. This is the same gate
// expressed over index decisions, so a run served from the index cannot claim
// more than a run served from XRPL. `full_window_complete` requires every
// watched wallet to have proof spanning the whole window — not merely to have
// answered.
function sealable(perWallet) {
  const list = Array.isArray(perWallet) ? perWallet : [];
  const target = list.length;
  let complete = 0, failed = 0, truncated = 0, unproven_start = 0, unknown = 0;

  for (const w of list) {
    const st = String((w && w.status) || PROOF_STATUS.FAILED);
    if (st === PROOF_STATUS.FAILED) { failed++; continue; }
    if (st === PROOF_STATUS.TRUNCATED) { truncated++; continue; }
    // Fail CLOSED on anything that is not literally COMPLETE. An earlier
    // version tested only for FAILED and TRUNCATED and let everything else
    // fall through to be counted complete, so a status of 'RUNNING', or a
    // typo, or a future fourth state would have been certified as proven.
    // "Never claim what was not proven this run" has to survive an
    // unrecognised input, not just the three we thought of.
    if (st !== PROOF_STATUS.COMPLETE) { unknown++; continue; }
    if (w && w.covers_window_start !== true) { unproven_start++; continue; }
    complete++;
  }

  return {
    target_wallets: target,
    complete_wallets: complete,
    failed_wallets: failed,
    truncated_wallets: truncated,
    // Wallets that answered without proving the start of the window. Without
    // this the COMPLETE claim is a tautology: with a numeric lower bound the
    // `oldest <= startMs` break can never fire, so every wallet would report
    // COMPLETE for a run that read one hour of twenty-four.
    unproven_start_wallets: unproven_start,
    // Wallets whose proof status was not one of the three known values. Kept
    // as its own count rather than folded into failed: a diagnostic that says
    // "we do not understand this wallet's state" is different from "the scan
    // failed", and the difference is what gets the bug found.
    unknown_status_wallets: unknown,
    full_window_complete: target > 0 && complete === target &&
                          failed === 0 && truncated === 0 &&
                          unproven_start === 0 && unknown === 0
  };
}

module.exports = {
  REASON,
  PROOF_STATUS,
  normalizeCoverage,
  hasProof,
  windowServability,
  checkpointAdvance,
  sealable
};
