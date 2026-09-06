/* ═══════════════════════════════════════════════════════════════════════════
   REPORT SCAN TUNING + TX WINDOW COMPLETENESS — 2026-08-19

   Deliberately scoped report-only changes:
   1) Preserve the existing report-approved wallet promotions.
   2) Every successfully CHECKED watched wallet enters account_tx Phase 2.
   3) account_tx follows XRPL markers until the requested start boundary is
      reached or account history is genuinely exhausted.
   4) A safety ceiling before proof is TRUNCATED, never COMPLETE.
   5) RPC/error termination is FAILED, never COMPLETE.
   6) Per-wallet scan proof + aggregate tx_scan_coverage are emitted.
   7) Evidence/public/master report completeness wording consumes that state.

   READ-ONLY. No signing, submit, trading, payout, or XRPL mutation.
   ═══════════════════════════════════════════════════════════════════════════ */
(function () {
  'use strict';

  var VERSION = '2026.08.20.1';
  var SNAPSHOT_KEY = 'shadowwatch_snapshot_v30';
  var TX_SAFETY_MAX_PAGES = 250;
  var PROMOTIONS = [
    {
      address: 'rJP1s6gaopZxXbpGegkxBspUgm5HjLUjBH',
      label: 'LARGE_RECV_rJP1s6',
      cat: 'discovered_receiver',
      balance_xrp_observed: 14382993,
      source_report: 'SW-20260816-FJCJQ'
    },
    {
      address: 'rUwXPwnRjXwrxHQ6e49iy9ZxwFumHporQe',
      label: 'LARGE_RECV_rUwXPw',
      cat: 'discovered_receiver',
      balance_xrp_observed: 2000001,
      source_report: 'SW-20260816-EILRG'
    },
    {
      address: 'rF6ZjrrRekxJJ6b9EtD6FTskbGKNHLo4E',
      label: 'LARGE_RECV_rF6Zjr',
      cat: 'discovered_receiver',
      balance_xrp_observed: 2000001,
      source_report: 'SW-20260816-EILRG'
    },
    {
      address: 'rnMf2652PqzCrnweGratdUHpRdyJpgk8KT',
      label: 'LARGE_RECV_rnMf26',
      cat: 'discovered_receiver',
      balance_xrp_observed: 2000001,
      source_report: 'SW-20260816-EILRG'
    },
    {
      address: 'rUh7XnUtaZKgm4MCXtDb9hgoQFopvVS54N',
      label: 'LARGE_RECV_rUh7Xn',
      cat: 'discovered_receiver',
      balance_xrp_observed: 2000001,
      source_report: 'SW-20260816-EILRG'
    },
    {
      address: 'raMu8SXhKgcZua5Dnpjv5vNxPLRDcgB3Ug',
      label: 'LARGE_RECV_raMu8S',
      cat: 'discovered_receiver',
      balance_xrp_observed: 2000001,
      source_report: 'SW-20260816-EILRG'
    },
    {
      address: 'raNQWPpXPKpm9VEKQEeHM6bgdTLMcYWptc',
      label: 'LARGE_RECV_raNQWP',
      cat: 'discovered_receiver',
      balance_xrp_observed: 2000001,
      source_report: 'SW-20260816-EILRG'
    },
    {
      address: 'rDHyd2wTXnoT1MTvCigLGpm8o7WdhE5mGi',
      label: 'LARGE_RECV_rDHyd2',
      cat: 'discovered_receiver',
      balance_xrp_observed: 4225574.019047,
      source_report: 'SW-20260817-P5N3V'
    },
    {
    address: 'rLG9Vpi3xLgfkzAfPkL9AJmD433DY7MoJk',
    label: 'LARGE_RECV_rLG9Vp',
    cat: 'discovered_receiver',
    balance_xrp_observed: 10318146,
    source_report: 'SW-20260820-FP7RI'
  },
    {
    address: 'rhhB3igjitCmsN3PLh5zAgUuYvHJD8mJdd',
    label: 'SPLITTER_rhhB3i',
    cat: 'next_hop_splitter',
    balance_xrp_observed: 11178122,
    source_report: 'SW-20260820-FP7RI'
  },
    {
    address: 'rBpFQot2zM5kpEz8mQ1P76i5EU5ZzDEBC4',
    label: 'SPLITTER_rBpFQo',
    cat: 'next_hop_splitter',
    balance_xrp_observed: null,
    source_report: 'SW-20260820-FP7RI'
  },
    {
    address: 'rML7EMb8QoaN8BraqHHdWZzSU4nReYRR9w',
    label: 'LARGE_RECV_rML7EM',
    cat: 'discovered_receiver',
    balance_xrp_observed: 8700062,
    source_report: 'SW-20260820-FP7RI'
  },
    {
    address: 'r4x919MCsHKknPJMSt87g7tjMdwwo9wk6K',
    label: 'SPLITTER_r4x919',
    cat: 'next_hop_splitter',
    balance_xrp_observed: 4,
    source_report: 'SW-20260820-X5I20'
  },
    {
    address: 'rNAQWcAYTbgC6wvdWLCa6su7VRsepiarTR',
    label: 'SPLITTER_rNAQWc',
    cat: 'next_hop_splitter',
    balance_xrp_observed: 7650,
    source_report: 'SW-20260820-ABSQ7'
  },
    {
    address: 'rnrqyM7kS6wmC5demJm9vrfdN2vLgS8LfY',
    label: 'EXOUT_RECV_rnrqyM',
    cat: 'discovered_receiver',
    balance_xrp_observed: 1149480,
    source_report: 'SW-20260820-BP7EU'
  },
    {
    address: 'rDHYrdu78ZU3qhiKttB7z73GJYpSQFMVHj',
    label: 'WHALE_RECV_rDHYrd',
    cat: 'discovered_whale',
    balance_xrp_observed: 52000000,
    source_report: 'SW-20260820-4OGEM'
  },
    {
    address: 'rUkxsGUE3E7AUngmwRT46uGwRDJ8pa5L7s',
    label: 'WHALE_RECV_rUkxsG',
    cat: 'discovered_whale',
    balance_xrp_observed: 52000000,
    source_report: 'SW-20260820-4OGEM'
  }
  ];

  function promoteOne(p) {
    var a = p.address;
    try {
      var already = (typeof WATCHLIST !== 'undefined' && Array.isArray(WATCHLIST))
        ? WATCHLIST.some(function (w) { return w && w.address === a; }) : false;
      if (!already && typeof addDiscoveredWallet === 'function') {
        addDiscoveredWallet(a, p.label, p.balance_xrp_observed, p.cat);
      } else if (!already && typeof WATCHLIST !== 'undefined' && Array.isArray(WATCHLIST)) {
        WATCHLIST.push({ label: p.label, address: a, cat: p.cat });
      }
      if (typeof KNOWN !== 'undefined' && KNOWN) {
        if (!KNOWN[a]) KNOWN[a] = { label: p.label, address: a, cat: p.cat };
        else KNOWN[a].cat = p.cat;
      }
    } catch (_) {}

    try {
      var R = window.SW_HVT_ROSTER;
      if (R && Array.isArray(R.targets) && !R.targets.some(function (t) { return t && t.address === a; })) {
        R.targets.push({
          address: a,
          label: p.label,
          handle: p.label,
          type: 'HVT',
          cat: p.cat,
          identified: false,
          confidence: null,
          expected_xrp: null,
          expected_source: null,
          sources: ['report']
        });
        if (R.stats) {
          R.stats.total = R.targets.length;
          if (typeof R.stats.from_report_only === 'number') R.stats.from_report_only += 1;
        }
      }
    } catch (_) {}
  }

  function promoteReportWallets() {
    PROMOTIONS.forEach(promoteOne);
  }

  function num(v) {
    var x = Number(v);
    return Number.isFinite(x) ? x : 0;
  }

  function readPreviousSnapshot() {
    try {
      var x = JSON.parse(localStorage.getItem(SNAPSHOT_KEY) || '{}');
      return x && typeof x === 'object' ? x : {};
    } catch (_) { return {}; }
  }

  function coverageFrom(pack) {
    var c = null;
    try { c = pack && pack.tx_scan_coverage; } catch (_) {}
    try { if (!c && typeof state !== 'undefined') c = state.txScanCoverage; } catch (_) {}
    c = c || {};
    var target = num(c.target_wallets);
    var complete = num(c.complete_wallets);
    var failed = num(c.failed_wallets);
    var truncated = num(c.truncated_wallets);
    // PRESENCE, not num(). num(undefined) is 0, so gating on
    // `num(c.unproven_wallets) === 0` would let a coverage object that never
    // carried the key satisfy the term by silence — which is precisely the
    // shape of the object this layer used to emit.
    var hasUnproven = (typeof c.unproven_wallets === 'number');
    var unproven = hasUnproven ? num(c.unproven_wallets) : null;
    var unknown = (typeof c.unknown_status_wallets === 'number') ? num(c.unknown_status_wallets) : 0;
    var anchorOk = c.anchor_ok === true;

    // A coverage object with no target at all is NOT a run in which zero
    // wallets were complete — it is a run whose coverage was never measured.
    // Rendering '0/0 complete' made silence look like a measurement.
    var measured = target > 0 && hasUnproven;

    var full = measured && anchorOk && c.full_window_complete === true &&
               complete === target && failed === 0 && truncated === 0 &&
               unproven === 0 && unknown === 0;

    var line;
    if (!measured) {
      line = 'NOT MEASURED — transaction-window coverage was not established this run. No zero-result claim below is definitive.';
    } else if (full) {
      line = 'COMPLETE — ' + complete + '/' + target + ' watched wallets proved the requested transaction window.';
    } else {
      // Every cause named. Three buckets against a roster denominator meant a
      // listener heard "0 failed; 0 truncated" while wallets went missing from
      // the arithmetic with no account given.
      var causes = [failed + ' failed', truncated + ' truncated', unproven + ' unproven'];
      if (unknown > 0) causes.push(unknown + ' unrecognised');
      line = 'INCOMPLETE — ' + complete + '/' + target + ' proved the window; ' +
             causes.join('; ') + '.' +
             (anchorOk ? '' : ' No validated run anchor, so no wallet could be certified.') +
             ' Zero-result claims are not definitive.';
    }

    return {
      target_wallets: target,
      complete_wallets: complete,
      failed_wallets: failed,
      truncated_wallets: truncated,
      unproven_wallets: unproven,
      unknown_status_wallets: unknown,
      anchor_ok: anchorOk,
      measured: measured,
      full_window_complete: full,
      line: line
    };
  }

  function proofList() {
    var rows = [];
    try { rows = (typeof state !== 'undefined' && Array.isArray(state.wallets)) ? state.wallets : []; } catch (_) {}
    var liveAnchor = null, liveRun = null;
    try {
      liveAnchor = (state.runAnchor && state.runAnchor.ok) ? state.runAnchor.anchor_ledger : null;
      liveRun = state.runId || null;
    } catch (_) {}
    return rows.filter(function (w) { return w && w.status === 'CHECKED'; }).map(function (w) {
      var p = w.tx_scan || {};
      // A proof that does not name THIS run and THIS anchor describes some
      // other run. Demote rather than trust: the alternative is certifying
      // today's window from yesterday's evidence.
      var st = p.status || 'FAILED';
      var stale = (liveAnchor !== null && num(p.anchor_ledger) !== num(liveAnchor)) ||
                  (liveRun !== null && String(p.run_id || '') !== String(liveRun));
      if (stale && st === 'COMPLETE') st = 'UNPROVEN';
      return {
        proven_reason: p.proven_reason || null,
        unproven_reason: stale ? 'PROOF_NOT_THIS_RUN' : (p.unproven_reason || null),
        request_bounded: p.request_bounded === true,
        transport_consistent: p.transport_consistent === true,
        run_id: p.run_id || null,
        address: w.address,
        label: w.label,
        status: st,
        pages_scanned: num(p.pages_scanned),
        boundary_reached: !!p.boundary_reached,
        history_exhausted: !!p.history_exhausted,
        anchor_ledger: p.anchor_ledger === undefined ? null : p.anchor_ledger,
        oldest_observed_ledger: p.oldest_observed_ledger === undefined ? null : p.oldest_observed_ledger,
        newest_observed_ledger: p.newest_observed_ledger === undefined ? null : p.newest_observed_ledger,
        history_exhaustion_proof: p.history_exhaustion_proof || null,
        error: p.error || null
      };
    });
  }

  function aggregateCoverage() {
    var list = proofList();

    // THE DENOMINATOR IS THE ROSTER, not the wallets whose account_info
    // happened to answer. proofList only sees status 'CHECKED', so 200 balance
    // failures used to render "COMPLETE — 51/51": arithmetically tidy and
    // forensically false. Every watched wallet that produced no proof this run
    // is counted, and counted as UNPROVEN.
    var roster = 0;
    try {
      if (typeof getActiveWatchlist === 'function') roster = (getActiveWatchlist() || []).length;
      else if (typeof WATCHLIST !== 'undefined' && WATCHLIST) roster = WATCHLIST.length;
    } catch (_) {}
    var target = Math.max(roster, list.length);

    // No run anchor means no wallet may be certified, whatever its own status
    // string says. Nothing used to ask this question at all.
    var anchorOk = false;
    try { anchorOk = (typeof state !== 'undefined') && state.anchorOk === true; } catch (_) {}

    var complete = 0, failed = 0, truncated = 0, unproven = 0, unknown = 0;
    for (var i = 0; i < list.length; i++) {
      var st = list[i].status;
      if (st === 'COMPLETE') { if (anchorOk) complete++; else unproven++; }
      else if (st === 'FAILED') failed++;
      else if (st === 'TRUNCATED') truncated++;
      else if (st === 'UNPROVEN') unproven++;
      else unknown++;
    }
    // Roster wallets that never produced a proof row this run — a balance
    // failure, an invalid address, or simply never walked. They are part of
    // the claim's denominator and they are not proven.
    var notChecked = Math.max(0, target - list.length);
    unproven += notChecked;

    var c = {
      target_wallets: target,
      complete_wallets: complete,
      failed_wallets: failed,
      truncated_wallets: truncated,
      unproven_wallets: unproven,
      unknown_status_wallets: unknown,
      not_checked_wallets: notChecked,
      anchor_ok: anchorOk,
      // The identity that makes a missing bucket visible instead of silent.
      counts_reconcile: (complete + failed + truncated + unproven + unknown) === target,
      full_window_complete: anchorOk && target > 0 && complete === target &&
                            failed === 0 && truncated === 0 && unproven === 0 && unknown === 0
    };
    try { if (typeof state !== 'undefined') state.txScanCoverage = c; } catch (_) {}
    return c;
  }

  // The socket that served a page, not the URL that named it. A reconnect can
  // land on the same URL and a different node behind a round-robin cluster,
  // with different retention — the case a URL comparison cannot see.
  function transportEpoch() {
    try { return (typeof state !== 'undefined') ? (num(state._transportEpoch) || 0) : 0; }
    catch (_) { return 0; }
  }

  // Re-establish the run's history proof on WHATEVER TRANSPORT IS CURRENT, and
  // write it back to the RUN, not to a local copy.
  //
  // The previous version assigned Object.assign({}, runAnchor, …) inside the
  // walk. That is a copy: state.runAnchor kept the proof from the original
  // socket, so the next wallet started with `runAnchor = state.runAnchor`
  // while epoch0 was already the NEW socket — no transport-change event fired,
  // and server A's exhaustion proof certified a no-marker answered by server B.
  // Transport provenance has to be a fact about the RUN or every wallet after
  // the first reconnect inherits a proof that does not belong to it.
  async function reproveOnCurrentTransport(ws, anchorSeq) {
    var proof = null;
    try {
      var info = await xrpl(ws, { command: 'server_info' });
      var COVR = (typeof window !== 'undefined') && window.SW_COVERAGE;
      if (COVR && typeof COVR.proveHistoryExhaustion === 'function') {
        proof = COVR.proveHistoryExhaustion({
          anchorLedger: anchorSeq,
          completeLedgers: info && info.info && info.info.complete_ledgers
        });
      }
    } catch (_) { proof = null; }
    try {
      if (typeof state !== 'undefined' && state.runAnchor) {
        // Mutate the RUN's anchor in place so every later wallet sees it.
        state.runAnchor.history_exhaustion_proof = proof;
        state.runAnchor.transport_epoch = transportEpoch();
      }
    } catch (_) {}
    try {
      if (typeof log === 'function') log('run anchor: re-proved history on the current transport — ' +
        (proof && proof.proven ? 'PROVEN (' + proof.reason + ')' : 'UNPROVEN (' + ((proof && proof.reason) || 'no server range') + ')'));
    } catch (_) {}
    return proof;
  }

  function installCompleteAccountTxPagination() {
    try {
      if (typeof accountTxWindowDepth !== 'function' || accountTxWindowDepth._swTxCompleteness20260819) return;
      var proofByAccount = Object.create(null);

      accountTxWindowDepth = async function (ws, account, startMs, endMs, limit) {
        var rows = [], marker = null, pages = 0;
        var boundaryReached = false, historyExhausted = false;
        // PESSIMISTIC INITIAL VALUE. This was 'COMPLETE', so every path that
        // fell through without explicitly deciding — a swallowed bound, a
        // transport swap, a no-marker on a partial-history server — landed on
        // the claim rather than on the refusal. A coverage claim must be
        // EARNED by a positive test, never inherited from an initializer.
        var status = 'UNPROVEN', error = '';
        var unprovenReason = 'NOT_DECIDED';
        // Every page of every wallet in this run asks for the SAME ledger tip.
        // This is the walker that actually runs — layer 17 replaces the core
        // one — so bounding only the core version would have left the real
        // scan drifting across ledger states while the code looked fixed.
        var RA = (typeof window !== 'undefined') && window.SW_RUN_ANCHOR;
        var runAnchor = null;
        try { runAnchor = (typeof state !== 'undefined') ? state.runAnchor : null; } catch (_) {}
        var oldestLedger = null, newestLedger = null, rowsWithoutLedger = 0;

        var anchorSeq = (runAnchor && runAnchor.ok) ? runAnchor.anchor_ledger : null;
        var epoch0 = transportEpoch();
        // A previous wallet may have reconnected. The run anchor's proof then
        // belongs to a socket we are no longer on, and nothing would fire a
        // transport-change event for THIS wallet because it starts already on
        // the new one. Re-prove before walking rather than inheriting it.
        if (anchorSeq !== null && runAnchor && num(runAnchor.transport_epoch) !== epoch0) {
          await reproveOnCurrentTransport(ws, anchorSeq);
          try { runAnchor = (typeof state !== 'undefined') ? state.runAnchor : runAnchor; } catch (_) {}
        }
        var transportConsistent = true;
        var requestBounded = anchorSeq !== null;
        var responseMaxSeen = null, responseMinSeen = null, responseValidated = true;
        var restartsLeft = 1;

        while (pages < TX_SAFETY_MAX_PAGES) {
          try {
            var req = { command: 'account_tx', account: account, ledger_index_min: -1, ledger_index_max: -1, limit: limit, forward: false };
            // NOT wrapped in catch-and-ignore. boundRequest has no throw path
            // for the case that matters — handed a null anchor it returns
            // ledger_index_max:-1 and returns NORMALLY — so a catch-derived
            // flag would read "bounded" on every unbounded request. The only
            // thing that settles it is a POST-CONDITION on what came back.
            if (RA) req = RA.boundRequest(req, runAnchor);
            if (req.ledger_index_max !== anchorSeq || anchorSeq === null) {
              requestBounded = false;
              unprovenReason = 'REQUEST_NOT_BOUNDED';
            }
            if (marker) req.marker = marker;
            var askedMax = req.ledger_index_max;
            var res = await xrpl(ws, req);

            // THE POST-CONDITION, on WHAT CAME BACK. Checking the request only
            // proved what we asked for. Verified against the live network:
            // ask rippled for a ledger_index_max it does not have and it
            // answers `status: success` and SILENTLY CLAMPS —
            //
            //   asked  107304561   (tip + 500000)
            //   echoed 106804564
            //
            // no error, no warning. So a request carrying the anchor is not
            // evidence the server answered through the anchor; only the
            // response's own echoed ceiling is. A clamped, absent or
            // unvalidated answer means this page describes a different ledger
            // state, and the wallet cannot certify.
            // Three distinct causes, kept apart. All fail closed, but a run
            // where EVERY wallet goes UNPROVEN is a very different diagnosis
            // depending on which one it is, and an operator reading the log at
            // 5am should not have to work that out.
            //
            // ABSENT matters most: ledger_index_max is a documented field of
            // the account_tx response and xrplcluster returns it (verified),
            // but this app rotates four transports and the other three could
            // not be reached from the build environment to confirm. If one of
            // them omits it, the report reads INCOMPLETE forever — safe, but a
            // catastrophic under-claim — and this reason is what makes that
            // visible in one log line instead of a mystery.
            if (res.ledger_index_max === undefined || res.ledger_index_max === null) {
              requestBounded = false;
              unprovenReason = 'RESPONSE_CEILING_ABSENT';
              responseMaxSeen = null;
            } else if (num(res.ledger_index_max) !== num(askedMax)) {
              requestBounded = false;
              unprovenReason = 'RESPONSE_NOT_BOUND_TO_ANCHOR';
              responseMaxSeen = num(res.ledger_index_max);
            } else if (res.validated !== true) {
              requestBounded = false;
              unprovenReason = 'RESPONSE_NOT_VALIDATED';
              responseMaxSeen = num(res.ledger_index_max);
              responseValidated = false;
            }
            // The server's own retained floor for THIS answer, recorded for
            // diagnosis: it is how a clamped ceiling gets explained.
            if (res.ledger_index_min !== undefined) responseMinSeen = num(res.ledger_index_min);

            // TRANSPORT CHECK, after the answer came back. If the socket
            // changed, this page came from a different server than the one the
            // anchor and the range proof were established on — and `marker` is
            // server-specific state, so the chain we were walking is not
            // resumable, it is meaningless. Restart once against the SAME
            // anchor on the new transport; a second change gives up.
            if (transportEpoch() !== epoch0) {
              if (restartsLeft > 0 && RA && typeof RA.buildRunAnchor === 'function') {
                restartsLeft--;
                await reproveOnCurrentTransport(ws, anchorSeq);
                // Re-read the RUN's anchor, which reproveOnCurrentTransport
                // updated in place, so this wallet and every later one are
                // working from the same transport-consistent proof.
                try { runAnchor = (typeof state !== 'undefined') ? state.runAnchor : runAnchor; } catch (_) {}
                epoch0 = transportEpoch();
                marker = null; rows = []; pages = 0;
                oldestLedger = null; newestLedger = null; rowsWithoutLedger = 0;
                boundaryReached = false; historyExhausted = false;
                try { if (typeof log === 'function') log('tx-scan ' + account + ': transport changed mid-walk — marker discarded, restarting on the new socket'); } catch (_) {}
                continue;
              }
              transportConsistent = false;
              unprovenReason = 'TRANSPORT_CHANGED';
              break;
            }
            pages++;
            var txs = res.transactions || [];
            var oldest = Infinity;

            for (var i = 0; i < txs.length; i++) {
              var item = txs[i] || {};
              var t = item.tx_json || item.tx || {};
              var iso = t.date ? rip(t.date) : '';
              if (!iso) continue;
              var ms = new Date(iso).getTime();
              if (!Number.isFinite(ms)) continue;
              oldest = Math.min(oldest, ms);
              // The ledger span this wallet was actually READ over. A checkpoint
              // records proven COVERAGE, not the last transaction seen, so the
              // writer needs the range the walk covered — including pages whose
              // rows all fell outside the window.
              if (RA) {
                var _li = RA.ledgerIndexOf(item);
                if (_li !== null) {
                  if (oldestLedger === null || _li < oldestLedger) oldestLedger = _li;
                  if (newestLedger === null || _li > newestLedger) newestLedger = _li;
                } else rowsWithoutLedger++;
              }
              if (ms >= startMs && ms <= endMs) rows.push(item);
            }

            marker = res.marker || null;
            if (oldest <= startMs) { boundaryReached = true; break; }
            if (!marker) { historyExhausted = true; break; }
          } catch (e) {
            status = 'FAILED';
            error = e && e.message ? e.message : String(e || 'account_tx failed');
            break;
          }
        }

        if (status !== 'FAILED' && !boundaryReached && !historyExhausted && transportConsistent) {
          status = 'TRUNCATED';
          unprovenReason = 'SAFETY_CEILING_REACHED';
        }

        // THE ONE PREDICATE decides whether this walk earned a claim — the same
        // function checkpointAdvance uses. Layer 17 must not re-derive it: two
        // implementations is how the database came to refuse a wallet the
        // Report was certifying on air.
        var COVR = (typeof window !== 'undefined') && window.SW_COVERAGE;
        var runId = null, winBounded = false, anchorOk = false;
        try {
          runId = (typeof state !== 'undefined') ? (state.runId || null) : null;
          winBounded = !!(typeof state !== 'undefined' && state.effectiveWindow &&
                          state.effectiveWindow.bounded_by_anchor === true);
          anchorOk = !!(runAnchor && runAnchor.ok === true);
        } catch (_) {}

        var candidate = {
          status: status === 'FAILED' ? 'FAILED' : (status === 'TRUNCATED' ? 'TRUNCATED' : 'COMPLETE'),
          request_bounded: requestBounded,
          transport_consistent: transportConsistent,
          anchor_ledger: anchorSeq,
          run_id: runId,
          boundary_reached: boundaryReached,
          history_exhausted: historyExhausted,
          history_exhaustion_proof: (runAnchor && runAnchor.ok) ? (runAnchor.history_exhaustion_proof || null) : null
        };
        var verdict = (COVR && typeof COVR.coverageProven === 'function')
          ? COVR.coverageProven({ anchorOk: anchorOk, anchorLedger: anchorSeq,
                                  windowBoundedByAnchor: winBounded, runId: runId, proof: candidate })
          // No rule loaded means nothing may be certified. Failing OPEN here
          // would make the whole gate optional exactly when the layer that
          // enforces it did not arrive — the /report deep-link case.
          : { proven: false, reason: 'NO_COVERAGE_RULE' };

        if (status !== 'FAILED' && status !== 'TRUNCATED') {
          status = verdict.proven ? 'COMPLETE' : 'UNPROVEN';
          // Keep the SPECIFIC local cause when the walk observed one. The
          // predicate can only answer at the granularity of its inputs — a
          // clamped response and a request that was never bounded both arrive
          // as request_bounded:false and both come back REQUEST_NOT_BOUNDED —
          // and overwriting here threw away the distinction that tells an
          // operator the server silently lowered the ceiling.
          if (!verdict.proven && (!unprovenReason || unprovenReason === 'NOT_DECIDED')) {
            unprovenReason = verdict.reason;
          }
        }

        var proof = {
          status: status,
          proven_reason: verdict.proven ? verdict.reason : null,
          unproven_reason: verdict.proven ? null : (unprovenReason || verdict.reason),
          request_bounded: requestBounded,
          transport_consistent: transportConsistent,
          transport_epoch: epoch0,
          response_ledger_index_max: responseMaxSeen,
          response_ledger_index_min: responseMinSeen,
          response_validated: responseValidated,
          run_id: runId,
          window_bounded_by_anchor: winBounded,
          pages_scanned: pages,
          boundary_reached: boundaryReached,
          history_exhausted: historyExhausted,
          // The anchor this wallet was read against, carried on the proof so a
          // checkpoint can never be written against a different tip than the
          // one the walk actually used.
          anchor_ledger: (runAnchor && runAnchor.ok) ? runAnchor.anchor_ledger : null,
          oldest_observed_ledger: oldestLedger,
          newest_observed_ledger: newestLedger,
          rows_without_ledger: rowsWithoutLedger,
          // history_exhausted alone is "the server had no more pages". Whether
          // that is the END OF HISTORY is decided by the run anchor's proof,
          // built from server_info.complete_ledgers for THIS run. A wallet may
          // not manufacture one.
          history_exhaustion_proof: (runAnchor && runAnchor.ok) ? (runAnchor.history_exhaustion_proof || null) : null,
          error: error || null
        };
        proofByAccount[account] = proof;
        try {
          if (typeof log === 'function') log('tx-scan proof ' + account + ': status=' + status + ' pages=' + pages +
            ' boundary=' + boundaryReached + ' history_exhausted=' + historyExhausted + (error ? ' error=' + error : ''));
        } catch (_) {}

        if (status === 'FAILED') throw new Error(error || 'account_tx failed before coverage was proven');
        return rows;
      };
      accountTxWindowDepth._swTxCompleteness20260819 = true;
      accountTxWindowDepth._proofByAccount = proofByAccount;

      // The legacy caller still passes tier page depths. The authoritative helper
      // above ignores those depths and uses only the explicit safety ceiling.
      try { pageDepthFor = function () { return TX_SAFETY_MAX_PAGES; }; } catch (_) {}
    } catch (_) {}
  }

  function installEveryCheckedWalletPhase2() {
    try {
      if (typeof scanWallets !== 'function' || scanWallets._swTxCompleteness20260819) return;
      var original = scanWallets;

      scanWallets = async function () {
        // A NEW RUN GETS A NEW PROOF TABLE. This was created once at install
        // time and never cleared, so a wallet CHECKED but not walked this run
        // inherited the PREVIOUS run's proof — status COMPLETE, the previous
        // run's anchor — and was counted for today's claim. That is a COMPLETE
        // assertion about a wallet nobody read this morning.
        try { for (var _k in proofByAccount) delete proofByAccount[_k]; } catch (_) {}
        var previous = readPreviousSnapshot();
        var previousRaw = null;
        var completed = false;
        try { previousRaw = localStorage.getItem(SNAPSHOT_KEY); } catch (_) {}

        // The legacy selector treats a wallet with no prior snapshot as a Phase-2
        // target. Temporarily present an empty snapshot so EVERY wallet that
        // successfully clears account_info enters Phase 2. We restore the real
        // prior balances onto state.wallets before any downstream analysis runs.
        try { localStorage.setItem(SNAPSHOT_KEY, '{}'); } catch (_) {}

        try {
          var out = await original.apply(this, arguments);
          completed = true;

          var proofs = (accountTxWindowDepth && accountTxWindowDepth._proofByAccount) || {};
          try {
            if (typeof state !== 'undefined' && Array.isArray(state.wallets)) {
              state.wallets.forEach(function (w) {
                if (!w || w.status !== 'CHECKED') return;
                var prior = previous[w.address];
                if (prior && prior.balance_xrp !== null && prior.balance_xrp !== undefined) {
                  w.prev_balance_xrp = num(prior.balance_xrp);
                  w.delta_xrp = num(w.balance_xrp) - num(prior.balance_xrp);
                } else {
                  w.prev_balance_xrp = null;
                  w.delta_xrp = null;
                }
                // EXPLICIT nulls/falses. Every absent field here would read
                // as `undefined`, and any downstream `x !== false` test takes
                // undefined for consent.
                w.tx_scan = proofs[w.address] || {
                  status: 'FAILED', pages_scanned: 0, boundary_reached: false,
                  history_exhausted: false, request_bounded: false,
                  transport_consistent: false, anchor_ledger: null, run_id: null,
                  history_exhaustion_proof: null, oldest_observed_ledger: null,
                  newest_observed_ledger: null, proven_reason: null,
                  unproven_reason: 'NO_PROOF_ROW', error: 'missing tx scan proof'
                };
              });
            }
          } catch (_) {}

          var cov = aggregateCoverage();
          try { if (typeof log === 'function') log('tx_scan_coverage ' + JSON.stringify(cov)); } catch (_) {}
          return out;
        } finally {
          // On a successful scan the legacy scanner already wrote the new current
          // snapshot; keep it. If the scan aborted before that point, put the old
          // snapshot back so this hotfix cannot destroy the operator's baseline.
          if (!completed) {
            try {
              if (previousRaw == null) localStorage.removeItem(SNAPSHOT_KEY);
              else localStorage.setItem(SNAPSHOT_KEY, previousRaw);
            } catch (_) {}
          }
        }
      };
      scanWallets._swTxCompleteness20260819 = true;
    } catch (_) {}
  }

  function qualifyIncompleteText(text, pack) {
    var out = String(text == null ? '' : text);
    var c = coverageFrom(pack);
    if (c.full_window_complete) return out;

    out = out.replace(/No anomalies flagged\./g,
      'No anomalies observed in the partial transaction scan; the requested window is incomplete.');
    out = out.replace(/NONE FLAGGED/g, 'NONE OBSERVED IN PARTIAL COVERAGE');
    // LITERAL CONTRACT with buildPublicReport (src/brief/02-core.js, the line
    // beginning "Transactions in scan window"). Change one, change both — the
    // guard is scripts/report-truth-4vf0c.test.js, which fails if either side
    // is reverted alone. Anchored ^…$ because the wording is now generic enough
    // that an unanchored match could reach "Transaction Window Coverage:".
    // [^\n]*? is LAZY and does not exclude ':' — a custom window label is
    // toLocaleString() + ' → ' + toLocaleString() and contains colons, so a
    // colon-excluding class would silently fail on operator-chosen windows.
    // [ \t]* not \s*, because \s matches \n and could straddle a line break.
    out = out.replace(/^(Transactions in scan window[^\n]*?):[ \t]*(\d+)$/gm,
                      '$1: $2 observed (partial transaction coverage)');
    out = out.replace(/(Large transfers flagged:\s*0)(?![^\n]*partial)/g, '$1 observed; incomplete transaction window');
    out = out.replace(/\b0 transfers above threshold\b/g, '0 transfers above threshold observed in partial coverage');
    return out;
  }

  function installCoverageConsumers() {
    try {
      if (typeof evidenceQuality === 'function' && !evidenceQuality._swTxCompleteness20260819) {
        var origEvidence = evidenceQuality;
        evidenceQuality = function (pack) {
          var q = origEvidence.apply(this, arguments) || {};
          var c = coverageFrom(pack);
          q.included_evidence_sources = Array.isArray(q.included_evidence_sources) ? q.included_evidence_sources : [];
          q.missing_or_failed_evidence = Array.isArray(q.missing_or_failed_evidence) ? q.missing_or_failed_evidence : [];
          if (c.full_window_complete) {
            if (!q.included_evidence_sources.some(function (x) { return /transaction-window coverage complete/i.test(String(x)); }))
              q.included_evidence_sources.push('transaction-window coverage complete (' + c.complete_wallets + '/' + c.target_wallets + ')');
          } else {
            q.score = Math.min(84, num(q.score));
            q.grade = q.score >= 70 ? 'B' : q.score >= 55 ? 'C' : 'D';
            q.missing_or_failed_evidence.push('transaction-window coverage incomplete: ' + c.complete_wallets + '/' + c.target_wallets +
              ' complete, ' + c.failed_wallets + ' failed, ' + c.truncated_wallets + ' truncated');
          }
          return q;
        };
        evidenceQuality._swTxCompleteness20260819 = true;
      }
    } catch (_) {}

    try {
      if (typeof buildPack === 'function' && !buildPack._swTxCompleteness20260819) {
        var origPack = buildPack;
        buildPack = function () {
          var p = origPack.apply(this, arguments) || {};
          p.tx_scan_coverage = aggregateCoverage();
          p.tx_scan_proof = proofList();
          try { p.evidence_quality = evidenceQuality(p); } catch (_) {}
          return p;
        };
        buildPack._swTxCompleteness20260819 = true;
      }
    } catch (_) {}

    try {
      if (typeof buildPublicReport === 'function' && !buildPublicReport._swTxCompleteness20260819) {
        var origPublic = buildPublicReport;
        buildPublicReport = function (pack) {
          var out = String(origPublic.apply(this, arguments) || '');
          var c = coverageFrom(pack);
          if (!/Transaction Window Coverage:/i.test(out)) {
            out = out.replace(/(Evidence Grade:[^\n]*\n)/, '$1Transaction Window Coverage: ' + c.line + '\n');
          }
          return qualifyIncompleteText(out, pack);
        };
        buildPublicReport._swTxCompleteness20260819 = true;
      }
    } catch (_) {}

    try {
      if (typeof buildXRPMainReport === 'function' && !buildXRPMainReport._swTxCompleteness20260819) {
        var origMain = buildXRPMainReport;
        buildXRPMainReport = function (pack) {
          var out = String(origMain.apply(this, arguments) || '');
          var c = coverageFrom(pack);
          if (!c.full_window_complete && !/TX WINDOW: INCOMPLETE/i.test(out)) {
            out = out.replace(/(1\. EXECUTIVE SUMMARY\n)/, '$1• ⚠️ TX WINDOW: ' + c.line + '\n');
          }
          return qualifyIncompleteText(out, pack);
        };
        buildXRPMainReport._swTxCompleteness20260819 = true;
      }
    } catch (_) {}

    try {
      if (typeof buildMorningStoryText === 'function' && !buildMorningStoryText._swTxCompleteness20260819) {
        var origMorning = buildMorningStoryText;
        buildMorningStoryText = function (pack) {
          var out = String(origMorning.apply(this, arguments) || '');
          var c = coverageFrom(pack);
          if (!c.full_window_complete && !/TRANSACTION WINDOW COVERAGE: INCOMPLETE/i.test(out))
            out = 'TRANSACTION WINDOW COVERAGE: ' + c.line + '\n\n' + out;
          return qualifyIncompleteText(out, pack);
        };
        buildMorningStoryText._swTxCompleteness20260819 = true;
      }
    } catch (_) {}

    try {
      if (typeof buildDynamicDailyReport === 'function' && !buildDynamicDailyReport._swTxCompleteness20260819) {
        var origDaily = buildDynamicDailyReport;
        buildDynamicDailyReport = function (pack) {
          var out = String(origDaily.apply(this, arguments) || '');
          var c = coverageFrom(pack);
          if (!c.full_window_complete && !/TRANSACTION WINDOW COVERAGE: INCOMPLETE/i.test(out))
            out = 'TRANSACTION WINDOW COVERAGE: ' + c.line + '\n\n' + out;
          return qualifyIncompleteText(out, pack);
        };
        buildDynamicDailyReport._swTxCompleteness20260819 = true;
      }
    } catch (_) {}

    try {
      if (typeof buildMasterPaste === 'function' && !buildMasterPaste._swTxCompleteness20260819) {
        var origMaster = buildMasterPaste;
        buildMasterPaste = function (pack) {
          var out = String(origMaster.apply(this, arguments) || '');
          var c = coverageFrom(pack);
          var proof = (pack && pack.tx_scan_proof) || proofList();
          if (!/TX_SCAN_COVERAGE=/i.test(out)) {
            out = out.replace(/(WALLETS_SCORED=[^\n]*\n)/,
              '$1TX_SCAN_COVERAGE=' + JSON.stringify(c) + '\nTX_SCAN_PROOF=' + JSON.stringify(proof) + '\n');
          }
          return qualifyIncompleteText(out, pack);
        };
        buildMasterPaste._swTxCompleteness20260819 = true;
      }
    } catch (_) {}

    try {
      if (typeof _intelLimits === 'function' && !_intelLimits._swTxCompleteness20260819) {
        var origLimits = _intelLimits;
        _intelLimits = function (pack) {
          var out = origLimits.apply(this, arguments) || [];
          var c = coverageFrom(pack);
          if (!c.full_window_complete) out.unshift('Transaction-window coverage incomplete: ' + c.complete_wallets + '/' + c.target_wallets +
            ' complete, ' + c.failed_wallets + ' failed, ' + c.truncated_wallets + ' truncated. Zero observed is not a definitive zero finding.');
          return out;
        };
        _intelLimits._swTxCompleteness20260819 = true;
      }
    } catch (_) {}
  }

  promoteReportWallets();
  installCompleteAccountTxPagination();
  installEveryCheckedWalletPhase2();
  installCoverageConsumers();

  window.SW_REPORT_SCAN_TUNING_20260816 = {
    version: VERSION,
    read_only: true,
    promoted_addresses: PROMOTIONS.map(function (p) { return p.address; }),
    promoted_from_reports: PROMOTIONS.map(function (p) { return p.source_report; }),
    tx_window_completeness: true,
    every_checked_wallet_phase2: true,
    marker_pagination_until_boundary_or_history_end: true,
    safety_max_pages: TX_SAFETY_MAX_PAGES,
    truncated_is_complete: false,
    rpc_failure_is_complete: false,
    emits_per_wallet_proof: true,
    emits_aggregate_coverage: true,
    read_only_scan: true
  };

  // Debug-only cleanup. This script intercepts only the SOURCE PROBE button;
  // it does not participate in the scanner or report evidence path.
  try {
    var d = document.createElement('script');
    d.src = '/src/brief/18-debug-probe-cleanup-20260816.js';
    d.async = false;
    d.setAttribute('data-sw-debug-probe-cleanup', '2026-08-16.1');
    document.body.appendChild(d);
  } catch (_) {}

  // Keep the evidence-led targeted news lane under the same source governor as
  // the normal news lane. This loads independently of the historical hotfix
  // chain so a dead GDELT source cannot add four redundant 8s retries.
  try {
    var n = document.createElement('script');
    n.src = '/src/brief/29-targeted-news-suppression-20260817.js';
    n.async = false;
    n.setAttribute('data-sw-targeted-news-suppression', '2026-08-17.1');
    document.body.appendChild(n);
  } catch (_) {}
})();
