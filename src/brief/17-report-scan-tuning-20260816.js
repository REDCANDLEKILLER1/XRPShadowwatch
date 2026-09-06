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
    var full = c.full_window_complete === true && target > 0 && complete === target && failed === 0 && truncated === 0;
    return {
      target_wallets: target,
      complete_wallets: complete,
      failed_wallets: failed,
      truncated_wallets: truncated,
      full_window_complete: full,
      line: full
        ? 'COMPLETE — ' + complete + '/' + target + ' checked wallets proved the requested transaction window.'
        : 'INCOMPLETE — ' + complete + '/' + target + ' complete; ' + failed + ' failed; ' + truncated + ' truncated. Zero-result claims are not definitive.'
    };
  }

  function proofList() {
    var rows = [];
    try { rows = (typeof state !== 'undefined' && Array.isArray(state.wallets)) ? state.wallets : []; } catch (_) {}
    return rows.filter(function (w) { return w && w.status === 'CHECKED'; }).map(function (w) {
      var p = w.tx_scan || {};
      return {
        address: w.address,
        label: w.label,
        status: p.status || 'FAILED',
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
    var c = {
      target_wallets: list.length,
      complete_wallets: list.filter(function (p) { return p.status === 'COMPLETE'; }).length,
      failed_wallets: list.filter(function (p) { return p.status === 'FAILED'; }).length,
      truncated_wallets: list.filter(function (p) { return p.status === 'TRUNCATED'; }).length,
      full_window_complete: list.length > 0 && list.every(function (p) { return p.status === 'COMPLETE'; })
    };
    try { if (typeof state !== 'undefined') state.txScanCoverage = c; } catch (_) {}
    return c;
  }

  function installCompleteAccountTxPagination() {
    try {
      if (typeof accountTxWindowDepth !== 'function' || accountTxWindowDepth._swTxCompleteness20260819) return;
      var proofByAccount = Object.create(null);

      accountTxWindowDepth = async function (ws, account, startMs, endMs, limit) {
        var rows = [], marker = null, pages = 0;
        var boundaryReached = false, historyExhausted = false;
        var status = 'COMPLETE', error = '';
        // Every page of every wallet in this run asks for the SAME ledger tip.
        // This is the walker that actually runs — layer 17 replaces the core
        // one — so bounding only the core version would have left the real
        // scan drifting across ledger states while the code looked fixed.
        var RA = (typeof window !== 'undefined') && window.SW_RUN_ANCHOR;
        var runAnchor = null;
        try { runAnchor = (typeof state !== 'undefined') ? state.runAnchor : null; } catch (_) {}
        var oldestLedger = null, newestLedger = null, rowsWithoutLedger = 0;

        while (pages < TX_SAFETY_MAX_PAGES) {
          try {
            var req = { command: 'account_tx', account: account, ledger_index_min: -1, ledger_index_max: -1, limit: limit, forward: false };
            if (RA) { try { req = RA.boundRequest(req, runAnchor); } catch (_) {} }
            if (marker) req.marker = marker;
            var res = await xrpl(ws, req);
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

        if (status !== 'FAILED' && !boundaryReached && !historyExhausted) status = 'TRUNCATED';
        var proof = {
          status: status,
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
                w.tx_scan = proofs[w.address] || {
                  status: 'FAILED', pages_scanned: 0, boundary_reached: false,
                  history_exhausted: false, error: 'missing tx scan proof'
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
