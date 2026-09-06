// XRPMAN Shadow Watch — one validated ledger anchor per Report run.
//
// ── The three things a Report was conflating ────────────────────────────────
// Before this layer, a run had no ledger identity at all:
//
//   1. NO LEDGER INDEX ON THE ROW. The row built at 02-core.js txOne carried
//      account/label/type/date/amount and no `ledger_index`. Two consumers
//      already read for it and always got null; escrowFromTxs hardcoded
//      `ledger: null` while parseEscrowItem had the real value one call away,
//      so the same escrow event had a ledger index or not depending on path.
//      Coverage cannot be proven over rows that do not say WHICH LEDGER they
//      are in, so this is the prerequisite everything else rests on.
//
//   2. NO ANCHOR. Every account_tx went out with `ledger_index_max: -1`,
//      resolved by the server per request. Wallet 1 could be answered against
//      ledger N and wallet 251 against ledger N+400 — the server catches up
//      mid-run — so "251/251 proved the window" described 251 different ledger
//      states, not one. `-1` also means no request can ever say "I read up to
//      HERE", which is what a checkpoint has to record.
//
//   3. A WINDOW FROZEN AT PAGE LOAD. applyAutoTxWindow() writes txStart/txEnd
//      into the DOM at boot; getTxWindow() then reads those frozen inputs. A
//      console left open overnight scanned yesterday's window and labelled it
//      "LAST 24H".
//
// ── What an anchor is, and why it is fetched the way it is ──────────────────
// The anchor is ONE validated ledger, read once at scan start, carrying both
// its sequence AND its close time FROM THE SAME RESPONSE.
//
// `server_info.validated_ledger` carries `seq` but NO `close_time` — only an
// `age`. Deriving a close time as `now - age` would be synthesizing a ledger
// fact from the local clock, which is exactly what must not happen: the local
// clock is the thing the anchor exists to stop trusting. The `ledger` command
// with `ledger_index: 'validated'` returns `ledger_index` and
// `ledger.close_time` together, so both halves of the anchor come from one
// server answer and cannot disagree.
//
// ORDER MATTERS, and it is not arbitrary:
//
//     1. ledger(validated)  -> defines the anchor  (seq + close_time)
//     2. server_info        -> proves the range covers it
//
// The ledger only advances, so a complete_ledgers read AFTER the anchor can
// only have grown past it. Reading server_info first and the anchor second
// would routinely produce a range whose top is one below the anchor, and
// proveHistoryExhaustion would refuse a healthy server. Same two calls, one
// ordering works and the other fails closed for no reason.
//
// ── The provenance rule ─────────────────────────────────────────────────────
// history_exhaustion_proof is built HERE, from the actual complete_ledgers
// string returned for THIS run, against THIS run's anchor. No repository
// cursor, no localStorage value, no previously stored client assertion and no
// bare boolean can produce one. buildRunAnchor is the only constructor, and it
// only ever passes the server's own response to the shared proof rule.
//
// The proof rules themselves are NOT reimplemented here. capWindowToAnchor,
// proveHistoryExhaustion and parseCompleteLedgers come from src/db/coverage.js
// — the same code the server evidence path uses. A browser copy would drift,
// and the drift would read as the browser claiming coverage the server would
// have refused.
//
// Read-only. This layer issues no requests of its own; it decides what the
// scanner's requests mean.
(function () {
  'use strict';

  var RIPPLE_EPOCH = 946684800;   // 2000-01-01T00:00:00Z, in unix seconds

  // Resolved at CALL time, not load time. Layer order in the console is
  // established by injection chains; a load-time capture would make this layer
  // silently ruleless if it happened to run first.
  function COV() {
    if (typeof window !== 'undefined' && window.SW_COVERAGE) return window.SW_COVERAGE;
    if (typeof module !== 'undefined' && module.exports) {
      try { return require('../db/coverage.js'); } catch (_) { return null; }
    }
    return null;
  }

  function _int(v) {
    if (v === null || v === undefined || v === '' || typeof v === 'boolean') return null;
    var n = Number(v);
    return Number.isFinite(n) ? Math.trunc(n) : null;
  }

  function rippleToMs(secs) {
    var s = _int(secs);
    if (s === null) return null;
    return (s + RIPPLE_EPOCH) * 1000;
  }

  // ── The anchor ─────────────────────────────────────────────────────────────
  //
  // Takes the two RAW responses and returns either a usable anchor or a named
  // refusal. Never a partial anchor: a sequence without a close time cannot cap
  // a window, and a close time without a sequence cannot bound a request, so
  // "half an anchor" is refused rather than returned for a caller to trip over.
  function buildRunAnchor(input) {
    var i = input || {};
    var ledgerRes = i.ledgerResult || null;
    var infoRes = i.serverInfoResult || null;

    var fail = function (reason, detail) {
      return {
        ok: false, reason: reason, detail: detail || null,
        anchor_ledger: null, anchor_close_ms: null, anchor_close_iso: null,
        complete_ledgers: null, history_exhaustion_proof: null
      };
    };

    if (!ledgerRes || typeof ledgerRes !== 'object') return fail('NO_LEDGER_RESPONSE');

    // A ledger that is not validated is not an anchor. `validated: false` means
    // the server offered its current in-progress ledger, which can still change.
    if (ledgerRes.validated !== true) return fail('LEDGER_NOT_VALIDATED');

    var body = ledgerRes.ledger || {};
    // The top-level ledger_index is a number; the one inside `ledger` is a
    // string. Prefer the top level and fall back, rather than assuming either.
    var seq = _int(ledgerRes.ledger_index);
    if (seq === null) seq = _int(body.ledger_index);
    if (seq === null || seq <= 0) return fail('NO_LEDGER_INDEX');

    var closeMs = rippleToMs(body.close_time);
    if (closeMs === null) return fail('NO_CLOSE_TIME');

    var anchor = {
      ok: true,
      reason: 'ANCHOR_ESTABLISHED',
      detail: null,
      anchor_ledger: seq,
      anchor_close_ms: closeMs,
      anchor_close_iso: new Date(closeMs).toISOString(),
      complete_ledgers: null,
      history_exhaustion_proof: null
    };

    // server_info is what turns "no more pages" into a proof. Its absence does
    // not invalidate the anchor — the run can still bound its requests and cap
    // its window — it only means nothing may claim exhausted history this run.
    var info = (infoRes && infoRes.info) || null;
    if (!info) {
      anchor.reason = 'ANCHOR_ESTABLISHED_NO_RANGE';
      anchor.history_exhaustion_proof = null;
      return anchor;
    }

    anchor.complete_ledgers = typeof info.complete_ledgers === 'string'
      ? info.complete_ledgers : null;

    var cov = COV();
    if (!cov || typeof cov.proveHistoryExhaustion !== 'function') {
      anchor.reason = 'ANCHOR_ESTABLISHED_NO_PROOF_RULE';
      return anchor;
    }

    // THE PROVENANCE RULE, in one expression: the server's own range string for
    // this run, against this run's anchor. There is no other path to a proof.
    anchor.history_exhaustion_proof = cov.proveHistoryExhaustion({
      anchorLedger: seq,
      completeLedgers: anchor.complete_ledgers
    });
    return anchor;
  }

  // ── The effective window ───────────────────────────────────────────────────
  //
  // A Report may not claim a window that ends after the last ledger it read.
  // The cap is computed here and — this is the half that was missing — is
  // returned as the value the narrative is expected to CONSUME. Computing a cap
  // and leaving the report rendering the browser's own end time changes nothing
  // except to make the code look correct.
  function effectiveWindow(input) {
    var i = input || {};
    var startMs = _int(i.requestedStartMs);
    var endMs = _int(i.requestedEndMs);
    var anchor = i.anchor || null;

    if (startMs === null || endMs === null) {
      throw new Error('effectiveWindow: numeric requestedStartMs and requestedEndMs are required');
    }
    if (endMs < startMs) { var t = startMs; startMs = endMs; endMs = t; }

    var anchorCloseMs = anchor && anchor.ok ? _int(anchor.anchor_close_ms) : null;
    if (anchorCloseMs === null) {
      // No anchor: nothing to cap against. Say so rather than silently passing
      // the browser's window through as though it had been checked.
      return {
        start_ms: startMs, end_ms: endMs,
        capped: false, claimed_beyond_ms: 0,
        anchor_ledger: null, anchor_close_ms: null,
        bounded_by_anchor: false, reason: 'NO_ANCHOR'
      };
    }

    var cov = COV();
    if (!cov || typeof cov.capWindowToAnchor !== 'function') {
      return {
        start_ms: startMs, end_ms: endMs,
        capped: false, claimed_beyond_ms: 0,
        anchor_ledger: _int(anchor.anchor_ledger), anchor_close_ms: anchorCloseMs,
        bounded_by_anchor: false, reason: 'NO_CAP_RULE'
      };
    }

    var capped = cov.capWindowToAnchor({ windowEndMs: endMs, anchorCloseMs: anchorCloseMs });
    return {
      start_ms: startMs,
      end_ms: capped.window_end_ms,
      capped: capped.capped,
      claimed_beyond_ms: capped.claimed_beyond_ms,
      anchor_ledger: _int(anchor.anchor_ledger),
      anchor_close_ms: anchorCloseMs,
      bounded_by_anchor: true,
      reason: capped.capped ? 'CAPPED_TO_ANCHOR' : 'WITHIN_ANCHOR'
    };
  }

  // ── The request bound ──────────────────────────────────────────────────────
  //
  // Every account_tx in a run carries the SAME numeric ledger_index_max. A
  // concurrent server catch-up may advance the shared tip mid-run; the running
  // Report still asks only for `<= its anchor`, so all 251 wallets describe one
  // ledger state.
  //
  // ── The edge ───────────────────────────────────────────────────────────────
  //
  // The whole point of the index: a wallet proven through ledger X only has to
  // be asked for [X+1 .. anchor]. This is the DECISION half of that, and it is
  // pure so it can be exercised without a database.
  //
  // What it deliberately does NOT do is decide that a coverage record is
  // TRUSTWORTHY. It is handed one. Who may write one, and on whose authority,
  // is the checkpoint writer's question — and the standing rule there is that
  // the server proves and writes, and no repository seed or client assertion
  // may advance a forensic floor. Passing a browser-invented number in here
  // would produce a confident, narrow, unproven request; the caller is what
  // must not do that, and until the writer lands the scanner passes nothing.
  function edgeRange(coverage, anchor) {
    var cov = COV();
    var seq = anchor && anchor.ok ? _int(anchor.anchor_ledger) : null;
    var none = function (reason) {
      return { ledger_index_min: -1, from_checkpoint: false, floor: null, reason: reason };
    };
    if (seq === null) return none('NO_ANCHOR');
    if (!cov || typeof cov.normalizeCoverage !== 'function') return none('NO_COVERAGE_RULE');
    if (!coverage) return none('NO_COVERAGE_RECORD');

    var c = cov.normalizeCoverage(coverage);
    if (!cov.hasProof(c)) return none('NO_PROOF');

    var through = _int(c.scan_coverage_through);
    if (through === null) return none('NO_PROOF');

    // A checkpoint at or past the anchor means there is no edge to read. Asking
    // for [anchor+1 .. anchor] would be an inverted range; say so instead.
    if (through >= seq) {
      return { ledger_index_min: -1, from_checkpoint: false, floor: through,
               reason: 'ALREADY_AT_ANCHOR' };
    }
    return { ledger_index_min: through + 1, from_checkpoint: true, floor: through,
             reason: 'EDGE_FROM_CHECKPOINT' };
  }

  // `coverage` is OPTIONAL and defaults to no floor. A run with no stored proof
  // asks for everything up to the anchor, which is exactly right: it has proven
  // nothing and must not pretend otherwise.
  function boundRequest(req, anchor, coverage) {
    var out = {};
    for (var k in req) if (Object.prototype.hasOwnProperty.call(req, k)) out[k] = req[k];
    var seq = anchor && anchor.ok ? _int(anchor.anchor_ledger) : null;
    // No anchor means no bound. Substituting -1 silently would be the old
    // behaviour wearing this function's name.
    out.ledger_index_max = seq === null ? -1 : seq;
    var edge = edgeRange(coverage, anchor);
    out.ledger_index_min = edge.ledger_index_min;
    return out;
  }

  // Test F's predicate, and a real runtime assertion: one run, one tip.
  function sameAnchorAcross(requests) {
    var list = Array.isArray(requests) ? requests : [];
    if (!list.length) return { consistent: false, reason: 'NO_REQUESTS', values: [] };
    var seen = [];
    for (var i = 0; i < list.length; i++) {
      var v = list[i] ? list[i].ledger_index_max : undefined;
      if (seen.indexOf(v) < 0) seen.push(v);
    }
    if (seen.length > 1) return { consistent: false, reason: 'ANCHOR_DRIFT', values: seen };
    if (seen[0] === -1 || seen[0] === undefined || seen[0] === null) {
      return { consistent: false, reason: 'UNBOUNDED', values: seen };
    }
    return { consistent: true, reason: 'ONE_ANCHOR', values: seen };
  }

  // ── The row's ledger index ─────────────────────────────────────────────────
  //
  // From the actual response, or null. NEVER interpolated from a neighbouring
  // row, a marker, or the anchor: a row whose ledger is unknown must be visible
  // as unknown, because coverage is proven over ledger ranges and a guessed
  // index would prove a range nobody read.
  //
  // account_tx puts ledger_index in different places depending on API version:
  // the modern shape carries it on the envelope, the legacy shape inside `tx`.
  function ledgerIndexOf(item) {
    if (!item || typeof item !== 'object') return null;
    var candidates = [
      item.ledger_index,
      item.tx_json && item.tx_json.ledger_index,
      item.tx && item.tx.ledger_index,
      item.meta && item.meta.ledger_index
    ];
    for (var i = 0; i < candidates.length; i++) {
      var v = _int(candidates[i]);
      if (v !== null && v > 0) return v;
    }
    return null;
  }

  // A row is EVIDENCE either way — it happened, and dropping it would
  // under-report real movement. What a missing ledger index costs it is the
  // right to participate in a COVERAGE PROOF, which is a different claim.
  function admitRow(item, anchor) {
    var li = ledgerIndexOf(item);
    if (li === null) {
      return { admit: true, ledger_index: null, proves_coverage: false, reason: 'NO_LEDGER_INDEX' };
    }
    var seq = anchor && anchor.ok ? _int(anchor.anchor_ledger) : null;
    if (seq !== null && li > seq) {
      // The server answered past our anchor. Keep the row — it is real — but it
      // describes a ledger state this Report is not reporting on.
      return { admit: true, ledger_index: li, proves_coverage: false, reason: 'BEYOND_ANCHOR' };
    }
    return { admit: true, ledger_index: li, proves_coverage: true, reason: 'WITHIN_ANCHOR' };
  }

  // Coverage observed for one wallet in one run, from admitted rows only.
  // Returns nulls rather than zeros when nothing was observed — a wallet with
  // no rows has no observed ledger floor, and 0 would read as "proven to the
  // beginning of time".
  function observedLedgerRange(rows) {
    var list = Array.isArray(rows) ? rows : [];
    var lo = null, hi = null, counted = 0, unindexed = 0;
    for (var i = 0; i < list.length; i++) {
      var li = _int(list[i] && list[i].ledger_index);
      if (li === null || li <= 0) { unindexed++; continue; }
      if (lo === null || li < lo) lo = li;
      if (hi === null || li > hi) hi = li;
      counted++;
    }
    return {
      oldest_ledger: lo, newest_ledger: hi,
      rows_with_ledger: counted, rows_without_ledger: unindexed
    };
  }

  var API = {
    RIPPLE_EPOCH: RIPPLE_EPOCH,
    buildRunAnchor: buildRunAnchor,
    effectiveWindow: effectiveWindow,
    boundRequest: boundRequest,
    edgeRange: edgeRange,
    sameAnchorAcross: sameAnchorAcross,
    ledgerIndexOf: ledgerIndexOf,
    admitRow: admitRow,
    observedLedgerRange: observedLedgerRange,
    _rippleToMs: rippleToMs
  };

  if (typeof window !== 'undefined') window.SW_RUN_ANCHOR = API;
  if (typeof module !== 'undefined' && module.exports) module.exports = API;
})();
