// XRPMAN Shadow Watch — coverage decisions. Pure: facts in, decision out.
//
// Loaded BOTH in Node (the server/evidence path) and in the browser (the
// scanner, via src/brief/41-run-anchor-20260906.js). That is deliberate and it
// is the point: the rule that decides whether history was proven must be ONE
// implementation. A browser copy and a server copy of "is this range
// contiguous from 32570 through the anchor" would drift, and the drift would
// show up as the browser claiming coverage the server would have refused —
// which is the exact failure class this file exists to prevent.
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
  FULLY_SERVABLE:    'FULLY_SERVABLE',     // a catch-up already passed our anchor
  // The window lies entirely after the anchor, so it survived the cap
  // inverted. Refused rather than narrowed — see windowServability.
  WINDOW_AFTER_ANCHOR:'WINDOW_AFTER_ANCHOR'
};

const PROOF_STATUS = {
  COMPLETE:  'COMPLETE',
  TRUNCATED: 'TRUNCATED',
  FAILED:    'FAILED',
  // The walk finished without error and still did not EARN a coverage claim:
  // no run anchor, a request that was never bounded to it, a transport that
  // changed mid-walk, or a terminal condition the server's retention cannot
  // license. Distinct from FAILED (the walk broke) and from TRUNCATED (a
  // safety ceiling stopped it) because the diagnosis differs and the log line
  // is the only place anyone will read it.
  UNPROVEN:  'UNPROVEN'
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
  const close = (name) => {
    if (r[name + '_ms'] !== undefined) return _int(r[name + '_ms']);
    const value = r[name];
    if (value === null || value === undefined || value === '') return null;
    const ms = value instanceof Date ? value.getTime() : Date.parse(value);
    return Number.isFinite(ms) ? ms : null;
  };
  return {
    address:                       r.address || '',
    scan_coverage_from:            _int(r.scan_coverage_from),
    scan_coverage_through:         _int(r.scan_coverage_through),
    scan_coverage_from_close_ms:   close('scan_coverage_from_close'),
    scan_coverage_through_close_ms:close('scan_coverage_through_close'),
    evidence_retained_from:        _int(r.evidence_retained_from),
    evidence_retained_through:     _int(r.evidence_retained_through),
    evidence_retained_from_close_ms:close('evidence_retained_from_close'),
    last_observed_tx_ledger:       _int(r.last_observed_tx_ledger),
    roster_version:                r.roster_version || null
  };
}

function hasProof(c) {
  return c.scan_coverage_from !== null &&
         c.scan_coverage_through !== null &&
         c.scan_coverage_through >= c.scan_coverage_from;
}

// ── Decision 0: the window may not outrun the anchor ──────────────────────
//
// Every Report owns one immutable validated-ledger anchor. The window,
// however, is computed in the browser and frozen at page load
// (02-core.js:877-890), so its end can easily sit AFTER the last ledger the
// run actually read. Those final seconds were never inside any ledger this run
// validated, and a Report that claims them is asserting a period it did not
// observe — on a surface read aloud on air.
//
// The migration enforces `window_end <= anchor_close_time`, but a CHECK only
// fires at INSERT. By then the narrative has already been built from the
// uncapped window. So the cap happens here, in the decision layer, before any
// number is derived from it.
//
// anchorCloseMs is required, not optional: a ledger index with no close time
// cannot be compared against a window at all. Half an anchor is not an anchor.
function capWindowToAnchor(input) {
  const endMs = _int(input && input.windowEndMs);
  const anchorCloseMs = _int(input && input.anchorCloseMs);
  if (endMs === null) {
    throw new Error('capWindowToAnchor: a numeric windowEndMs is required');
  }
  if (anchorCloseMs === null) {
    throw new Error('capWindowToAnchor: a numeric anchorCloseMs is required — half an anchor is not an anchor');
  }
  if (endMs <= anchorCloseMs) {
    return { window_end_ms: endMs, capped: false, claimed_beyond_ms: 0 };
  }
  return {
    window_end_ms: anchorCloseMs,
    capped: true,
    // Surfaced rather than swallowed: a Report routinely capping by minutes is
    // a clock or an ordering problem worth seeing.
    claimed_beyond_ms: endMs - anchorCloseMs
  };
}

// ── Is "no more marker" actually the end of the account's history? ────────
//
// It usually is not. `account_tx` returning no marker means the SERVER has no
// more pages of what IT retains. A partial-history server exhausts its own
// retention and looks identical to an account that genuinely has no older
// transactions. Believing the second when it is the first claims coverage over
// history nobody read — which is the whole failure class this file exists to
// prevent, and it is worse here than elsewhere because the bootstrap uses it
// to claim coverage back to the beginning of time.
//
// The only thing that settles it is the server's own complete-ledger range. A
// server holding history from the genesis ledger down has nothing older to
// give; one that starts at ledger 90,000,000 has plenty it simply does not
// keep. `server_info.complete_ledgers` is where that comes from.
//
// XRPL's first surviving ledger is 32570 — ledgers 1-32569 were lost early in
// the network's life, so a full-history server's range starts there.
const XRPL_EARLIEST_AVAILABLE_LEDGER = 32570;

// `complete_ledgers` is a RANGE EXPRESSION, and XRPL's own documentation says
// it may be DISJOINT:
//
//     24900901-24900984,24901116-24901158
//
// Reducing it to its minimum loses exactly the fact it was telling us. A
// server reporting
//
//     32570-50000,90000000-98800000
//
// has a minimum of 32570 and a hole of roughly ninety million ledgers. The
// previous version read that as SERVER_HAS_FULL_HISTORY and let a wallet claim
// coverage across the gap.
//
// So parse the expression, merge what it actually holds, and require
// CONTIGUOUS coverage from the earliest surviving mainnet ledger through the
// run's anchor. Anything else — empty, unknown, malformed, partial, disjoint —
// fails closed.
function parseCompleteLedgers(expr) {
  if (typeof expr !== 'string') return null;
  const raw = expr.trim();
  if (!raw || /^empty$/i.test(raw)) return [];
  const out = [];
  for (const part of raw.split(',')) {
    const seg = part.trim();
    if (!seg) return null;                       // trailing/double comma: malformed
    const m = seg.match(/^(\d+)(?:-(\d+))?$/);   // "a-b" or a bare "a"
    if (!m) return null;
    const lo = _int(m[1]);
    const hi = m[2] === undefined ? lo : _int(m[2]);
    if (lo === null || hi === null || hi < lo) return null;
    out.push([lo, hi]);
  }
  out.sort((a, b) => a[0] - b[0]);
  // Merge touching or overlapping spans: 32570-50000 and 50001-98800000 are
  // contiguous coverage written in two pieces, and refusing that would be as
  // wrong as accepting a real gap.
  const merged = [];
  for (const r of out) {
    const last = merged[merged.length - 1];
    if (last && r[0] <= last[1] + 1) { last[1] = Math.max(last[1], r[1]); }
    else merged.push([r[0], r[1]]);
  }
  return merged;
}

function proveHistoryExhaustion(input) {
  const i = input || {};
  const anchor = _int(i.anchorLedger);
  const ranges = parseCompleteLedgers(i.completeLedgers);

  const fail = (reason, extra) => Object.assign({
    proven: false, reason: reason,
    covers_from: null, covers_through: null, anchor_ledger: anchor
  }, extra || {});

  if (anchor === null || anchor <= 0) return fail('ANCHOR_REQUIRED');
  if (ranges === null) return fail('SERVER_RANGE_UNPARSEABLE');
  if (!ranges.length) return fail('SERVER_RANGE_EMPTY');

  // The span that contains the earliest surviving ledger, if any.
  let span = null;
  for (const r of ranges) {
    if (r[0] <= XRPL_EARLIEST_AVAILABLE_LEDGER && r[1] >= XRPL_EARLIEST_AVAILABLE_LEDGER) { span = r; break; }
  }
  if (!span) {
    return fail('SERVER_HISTORY_PARTIAL', {
      unproven_below: ranges[0][0], server_ranges: ranges.length });
  }
  // It reaches back far enough. Does the SAME unbroken span reach forward to
  // the anchor? A hole anywhere between is a hole in the claim.
  if (span[1] < anchor) {
    return fail('SERVER_HISTORY_DISJOINT', {
      covers_from: span[0], covers_through: span[1],
      gap_above: span[1], server_ranges: ranges.length });
  }
  return {
    proven: true,
    reason: 'SERVER_HAS_FULL_HISTORY',
    covers_from: span[0],
    covers_through: span[1],
    anchor_ledger: anchor,
    server_ranges: ranges.length
  };
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

  // anchorCloseMs is REQUIRED, not optional.
  //
  // This used to read `if (anchorCloseMs !== null) { ...cap... }` — silently
  // skipping the cap whenever the caller omitted it — and a test asserted that
  // path as acceptable. It contradicted the invariant stated eighty lines above
  // and enforced in capWindowToAnchor: half an anchor is not an anchor. A
  // ledger index with no close time cannot be compared against a window at
  // all, so a decision made without one is a decision about a window nobody
  // bounded. Every other fixture in the suite took that path.
  //
  // Refusing here is the whole point: the cap cannot be the thing that makes
  // the database CHECK real if a caller can opt out of it by forgetting an
  // argument.
  const anchorCloseMs = _int(input && input.anchorCloseMs);
  if (anchorCloseMs === null) {
    throw new Error('windowServability: a numeric anchorCloseMs is required — half an anchor is not an anchor');
  }
  const cap = capWindowToAnchor({ windowEndMs: endMs, anchorCloseMs: anchorCloseMs });
  const effEndMs = cap.window_end_ms;
  const windowCapped = cap.capped;
  const claimedBeyondMs = cap.claimed_beyond_ms;

  const base = {
    address: c.address,
    anchor_ledger: anchor,
    window_start_ms: startMs,
    // The EFFECTIVE end: capped to the anchor's close when one was supplied.
    window_end_ms: effEndMs,
    window_capped_to_anchor: windowCapped,
    claimed_beyond_anchor_ms: claimedBeyondMs,
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

  // ── A WINDOW THAT SURVIVED THE CAP INVERTED IS NOT A WINDOW ───────────────
  //
  // capWindowToAnchor lowers the END to the anchor's close. It says nothing
  // about the START, so a window lying entirely AFTER the anchor comes out of
  // it inverted — start greater than end — and every test below then passes
  // vacuously, because a proof covering real history trivially covers an empty
  // interval. Verified by execution against this file:
  //
  //   window [anchorClose+1h .. anchorClose+2h]
  //     -> FULLY_SERVABLE, window_start_ms > window_end_ms
  //     -> mayReportQuiet(d, 0) = { quiet: true, reason: 'PROVEN_QUIET' }
  //
  // "Nothing happened", certified over an interval that cannot contain
  // anything. Reachable from a clock running ahead of the ledger, a stale
  // browser window, or an operator-chosen range — none of them exotic.
  //
  // It is refused, not narrowed: a window whose start is already past the last
  // ledger this run read describes a period nobody observed.
  if (startMs > effEndMs) {
    base.reason = REASON.WINDOW_AFTER_ANCHOR;
    return base;
  }

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

// ── Decision 1b: did this wallet's WALK earn a coverage claim? ─────────────
//
// THE ONE PREDICATE. Layer 17 (the browser report) and checkpointAdvance (the
// evidence database) both call this. They used to answer the question
// separately, and they disagreed: the DB refused a partial-history exhaustion
// while the Report certified the same wallet as COMPLETE and read it on air.
// Two implementations of "was this proven" is the defect, not the symptom, so
// there is exactly one here and both callers are held to it.
//
// ── What licenses a claim over [windowStart .. anchor] ─────────────────────
//
//   BOUNDARY_REACHED_BY_TX     the walk read a transaction at or older than
//                              the window start. The account itself supplied
//                              the floor. Nothing about server retention
//                              needs to be assumed.
//
//   HISTORY_EXHAUSTED + FULL   the server ran out of pages AND its own
//                              complete_ledgers proves contiguous history from
//                              XRPL's first surviving ledger through this
//                              anchor. There is nothing older to miss.
//
// and what does NOT:
//
//   NO MARKER, NO FLOOR        a quiet wallet whose oldest visible transaction
//                              is INSIDE the window. "No more pages" is the
//                              server's statement about what IT retains. On a
//                              partial-history node that is indistinguishable
//                              from a genuinely short history, and believing
//                              it claims coverage over ledgers nobody read.
//
// Licensing that third case needs a trustworthy mapping from the window's
// START TIME to a ledger at or before it, so retention can be checked against
// the actual boundary. That mapping needs an acquisition this layer does not
// have, and inventing one from close-time arithmetic would be exactly the
// "numeric shortcut" that turned the last range check into a tautology. So it
// fails closed: RETENTION_DOES_NOT_PROVE_WINDOW_START, and the wallet is
// UNPROVEN until the mapping exists.
//
// Every term is an EXPLICIT POSITIVE test. The fallback proof minted for a
// wallet with no proof row carries undefined for most of these, and
// `x !== false` would read undefined as consent.
function coverageProven(input) {
  const i = input || {};
  const anchor = _int(i.anchorLedger);
  const p = i.proof || {};

  const no = (reason) => ({ proven: false, reason });

  // ── Run-level preconditions. None of these is about the wallet. ──────────
  if (i.anchorOk !== true) return no('NO_RUN_ANCHOR');
  if (anchor === null || anchor <= 0) return no('NO_RUN_ANCHOR');
  // Every page of this walk asked for `<= anchor` and the server said so.
  if (p.request_bounded !== true) return no('REQUEST_NOT_BOUNDED');
  // The claimed window may not outrun the ledgers that were read.
  if (i.windowBoundedByAnchor !== true) return no('WINDOW_NOT_BOUNDED');
  // One transport for the whole walk: a history proof earned from server A may
  // not certify a no-marker answered by server B, and an account_tx marker is
  // server-specific state that cannot be replayed across a reconnect.
  if (p.transport_consistent !== true) return no('TRANSPORT_CHANGED');
  // The proof must describe THIS run against THIS anchor. A wallet that was
  // not walked this run inherits the previous run's object otherwise.
  if (_int(p.anchor_ledger) !== anchor) return no('PROOF_ANCHOR_MISMATCH');
  if (i.runId && String(p.run_id || '') !== String(i.runId)) return no('PROOF_RUN_MISMATCH');

  // ── The walk's own terminal condition. ──────────────────────────────────
  const status = String(p.status || '');
  if (status === PROOF_STATUS.FAILED)    return no('WALK_FAILED');
  if (status === PROOF_STATUS.TRUNCATED) return no('SAFETY_CEILING_REACHED');

  if (status === PROOF_STATUS.COMPLETE && p.source === 'NEON_VERIFIED_INDEX' &&
      p.range_bound_proven === true && p.range_exhausted === true &&
      p.edge_fetch_complete === true && p.covers_window_start === true &&
      p.response_validated === true && _int(p.response_ledger_index_max) === anchor) {
    return { proven:true, reason:'RETAINED_HISTORY_AND_VERIFIED_EDGE' };
  }

  if (p.boundary_reached === true) {
    return { proven: true, reason: 'BOUNDARY_REACHED_BY_TX' };
  }

  if (p.history_exhausted === true) {
    const ex = p.history_exhaustion_proof || null;
    // Mirrors checkpointAdvance in full: proven, naming THIS anchor, and
    // covering through it. A bare `proven: true` is the flag anyone can set.
    const ok = !!ex && ex.proven === true &&
               _int(ex.anchor_ledger) === anchor &&
               _int(ex.covers_through) !== null &&
               _int(ex.covers_through) >= anchor;
    if (!ok) return no('HISTORY_EXHAUSTION_UNPROVEN');
    return { proven: true, reason: 'HISTORY_EXHAUSTED_FULL_RETENTION' };
  }

  // Neither floor. See the note above: this is the honest gap, not an oversight.
  return no('RETENTION_DOES_NOT_PROVE_WINDOW_START');
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
  // UNPROVEN is a status this system MINTS, so it gets its own reason. Folding
  // it into PROOF_NOT_COMPLETE would short-circuit 54 lines before
  // HISTORY_EXHAUSTION_UNPROVEN and delete the diagnosis from the log exactly
  // when someone is trying to work out why coverage was refused.
  if (status === PROOF_STATUS.UNPROVEN) return refuse('PROOF_UNPROVEN');
  if (status !== PROOF_STATUS.COMPLETE) return refuse('PROOF_NOT_COMPLETE');

  // ── Bootstrap: how a never-scanned wallet ever gets a first checkpoint ────
  //
  // This used to read `if (p.range_bound_proven !== true) refuse(...)`, full
  // stop, and a test asserted that refusal as correct. It made the whole design
  // impossible: a wallet with no checkpoint can only be walked by DATE (there
  // is no ledger floor to bound it with), so a date walk that can never
  // establish a checkpoint means a never-scanned wallet stays never-scanned
  // and pays the full walk every single morning, forever. The suite did not
  // catch that — it encoded it.
  //
  // A date-bounded walk CAN establish a checkpoint, but only on POSITIVE
  // evidence of a ledger floor. Two ways to get one:
  //
  //   boundary_reached    the walk read past the window start and saw a
  //                       transaction older than it. The oldest ledger index
  //                       observed is a floor we actually read.
  //   history_exhausted   the server returned no further marker. Everything
  //                       this account has, up to the anchor, is in hand.
  //
  // Either way the floor is `oldest_ledger_index` — a value that was READ, not
  // one derived by interpolating a close interval.
  const bounded          = p.range_bound_proven === true;
  const boundaryReached  = p.boundary_reached === true;
  // "No marker" is the SERVER running out of pages, not proof the account has
  // nothing older. Only a server whose own complete-ledger range reaches back
  // to the start of available history can settle that — see
  // proveHistoryExhaustion. Marker exhaustion alone is not evidence.
  const exhaustionClaimed = p.history_exhausted === true;
  // The proof is the OBJECT proveHistoryExhaustion returned, not a boolean a
  // caller can set. A bare `history_exhausted_proven: true` is exactly the
  // thing that needs proving, so it is no longer accepted: the proof must
  // carry the range it verified AND name the anchor it verified against, and
  // that anchor must be this run's. A caller wanting to fake it now has to
  // fabricate a specific ledger number that has to match — visible, rather
  // than a flag flipped in passing.
  const exProof = p.history_exhaustion_proof || null;
  const historyExhausted = exhaustionClaimed &&
    !!exProof && exProof.proven === true &&
    _int(exProof.anchor_ledger) === anchor &&
    _int(exProof.covers_through) !== null &&
    _int(exProof.covers_through) >= anchor;
  const oldest = _int(p.oldest_ledger_index);

  if (!bounded) {
    if (!boundaryReached && !exhaustionClaimed) {
      // A walk that stopped for any other reason proves no range at all.
      return refuse('RANGE_NOT_LEDGER_BOUND');
    }
    // Exhaustion claimed but unproven, and the walk never reached the window
    // boundary either: there is nothing here that establishes a floor. On a
    // partial-history server this is the ordinary case, not an exotic one.
    if (!boundaryReached && exhaustionClaimed && !historyExhausted) {
      return refuse('HISTORY_EXHAUSTION_UNPROVEN');
    }
    // Exhausting an account that has NO transactions leaves nothing to read a
    // floor from. Claiming one anyway would be inventing a ledger value, and
    // "the server had no more pages" is also what a partial-history server
    // says. Refusing costs one empty page next run, which is the cheapest
    // thing in the system.
    if (oldest === null) return refuse('NO_LEDGER_FLOOR_OBSERVED');
  }

  // The proven lower bound: read from the proof for a ledger-bounded walk,
  // derived from the oldest observation for a bootstrap.
  const effFrom = bounded ? from : oldest;

  if (effFrom === null || through === null || through < effFrom) {
    return refuse('PROOF_RANGE_MALFORMED');
  }

  // A checkpoint without close times is a checkpoint no window can ever be
  // decided against: windowServability compares the window start against
  // scan_coverage_from_close_ms, and a null there means proven_start is always
  // false. Writing one would record an advance in coverage_advances that reads
  // as progress while the wallet silently falls back to a full walk forever.
  // Refuse it here, where the reason is visible.
  //
  // For a bootstrap the close time comes from the same observation the floor
  // did — EXCEPT when history was exhausted. Exhaustion means there is nothing
  // older than what we just read, so coverage reaches back past any window
  // start, and a recently-created account whose whole history postdates the
  // window is still fully covered. Recording its oldest transaction's close
  // time instead would make proven_start false on the next run and send it
  // back to a full walk — the bug this bootstrap exists to remove, one layer
  // down.
  let derivedFromClose;
  if (bounded) derivedFromClose = _int(p.from_close_ms);
  else if (historyExhausted) derivedFromClose = _int(p.oldest_close_ms);
  else derivedFromClose = _int(p.oldest_close_ms);

  const fromClose = hasProof(c) ? c.scan_coverage_from_close_ms : derivedFromClose;
  if (fromClose === null || _int(p.through_close_ms) === null) {
    return refuse('PROOF_MISSING_CLOSE_TIMES');
  }

  // Never claim coverage of ledgers this run did not read. A gap between the
  // existing checkpoint and the proven range would be exactly that.
  if (hasProof(c) && (effFrom > c.scan_coverage_through + 1 || through < c.scan_coverage_from - 1)) {
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
    reason: !bounded
      ? (historyExhausted ? 'BOOTSTRAP_HISTORY_EXHAUSTED' : 'BOOTSTRAP_BOUNDARY_REACHED')
      : ((_int(p.rows_stored) || 0) === 0 ? 'EMPTY_RANGE_EXHAUSTED' : 'RANGE_PROVEN'),
    // Whether this checkpoint was established by a date walk rather than a
    // ledger-bounded one. Recorded so coverage_advances shows which runs were
    // first-scans, and so a reader can tell the two kinds of proof apart.
    bootstrap: !bounded,
    // The compare-and-set predicate. NULL for a wallet with no prior proof —
    // the SQL side must compare with IS NULL, not `= NULL`.
    expected_prior: hasProof(c) ? c.scan_coverage_through : null,
    next_from: hasProof(c) ? c.scan_coverage_from : effFrom,
    next_from_close_ms: fromClose,
    next_through: through,
    next_through_close_ms: _int(p.through_close_ms)
  };
}

// ── Decision 2b: zero rows came back. What may be said about that? ────────
//
// This is the single most dangerous question in the whole design, because
// every one of these states produces an EMPTY RESULT SET and they do not mean
// the same thing:
//
//   proven, retained, nothing there   ->  "nothing happened"      TRUE
//   never scanned                     ->  "nothing happened"      A LIE
//   proven but pruned                 ->  "nothing happened"      A LIE
//   scan truncated at a page ceiling  ->  "nothing happened"      A LIE
//   index unreachable                 ->  "nothing happened"      A LIE
//
// A caller holding an empty array cannot tell these apart, and the Report is
// read aloud on air. So the decision is made here, from the coverage facts,
// and it is a function rather than a rule in a comment that someone has to
// remember. `rowCount` is passed in only so the honest case can be named; a
// non-zero count is never "quiet" regardless of coverage.
function mayReportQuiet(decision, rowCount) {
  const d = decision || {};
  const n = _int(rowCount);
  if (n === null || n < 0) return { quiet: false, reason: 'ROW_COUNT_UNKNOWN' };
  if (n > 0) return { quiet: false, reason: 'ROWS_PRESENT' };
  // Zero rows. Only a window the index fully owns may be called quiet, and
  // only once the edge has actually been fetched.
  if (!d.served_from_index) {
    return { quiet: false, reason: d.reason || REASON.NO_COVERAGE };
  }
  if (d.complete_without_fetch === true) {
    return { quiet: true, reason: 'PROVEN_QUIET' };
  }
  if (d.edge_fetch_complete === true) {
    return { quiet: true, reason: 'PROVEN_QUIET' };
  }
  // Served from history, but the edge between the last checkpoint and this
  // run's anchor has not been proven yet. The quiet part is quiet; the new
  // part is unknown.
  return { quiet: false, reason: 'EDGE_NOT_YET_PROVEN' };
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
  let complete = 0, failed = 0, truncated = 0, unproven = 0, unproven_start = 0, unknown = 0;

  for (const w of list) {
    const st = String((w && w.status) || PROOF_STATUS.FAILED);
    if (st === PROOF_STATUS.FAILED) { failed++; continue; }
    if (st === PROOF_STATUS.TRUNCATED) { truncated++; continue; }
    // A well-defined refusal. It already failed closed by falling into the
    // unknown bucket, so this is about diagnosis rather than safety: that
    // bucket exists to say "we do not understand this wallet's state", and a
    // status we minted ourselves must not consume that signal.
    if (st === PROOF_STATUS.UNPROVEN) { unproven++; continue; }
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
    // Wallets whose walk finished cleanly but earned no claim.
    unproven_wallets: unproven,
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

const API = {
  REASON,
  PROOF_STATUS,
  normalizeCoverage,
  hasProof,
  capWindowToAnchor,
  coverageProven,
  parseCompleteLedgers,
  proveHistoryExhaustion,
  XRPL_EARLIEST_AVAILABLE_LEDGER,
  windowServability,
  mayReportQuiet,
  checkpointAdvance,
  sealable
};

// Dual export. `module` is undefined in a browser and `window` is undefined in
// Node, so each guard is checked before use rather than assumed.
if (typeof module !== 'undefined' && module.exports) module.exports = API;
if (typeof window !== 'undefined') window.SW_COVERAGE = API;
