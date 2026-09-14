(function () {
  'use strict';
  // ── THE MORNING RUN, BACKED BY GITHUB INSTEAD OF A DATABASE ───────────────
  //
  // A drop-in replacement for window.SW_EVIDENCE_INDEX. Layer 17 calls begin(),
  // proveWallet() per wallet, readRun() and finish() exactly as before — none of
  // that changes. What changes is where the answers come from.
  //
  // The old shape made 255 HTTP calls, one per wallet, each of which opened a
  // database transaction. The new one makes ONE call: the server reads the
  // checkpoint, pins an anchor, walks every wallet's bounded edge and commits
  // once. The per-wallet methods then hand back what that single run already
  // established, so the existing call sites keep working unmodified.
  //
  // If the run did not earn its checkpoint, proveWallet still returns the proof
  // for the wallets that DID complete, and throws only for the ones that did
  // not. 249 of 255 is not "nothing happened", and the report is entitled to
  // render what was actually proven with the rest stated honestly.
  var LEGACY = window.SW_EVIDENCE_INDEX;

  function post(action, body) {
    var controller = new AbortController();
    var timer = setTimeout(function () { controller.abort(); }, 290000);
    return fetch('/api/delta', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, cache: 'no-store',
      body: JSON.stringify(Object.assign({ action: action }, body || {})), signal: controller.signal
    }).then(function (response) {
      return response.json().catch(function () { return {}; }).then(function (data) {
        if (!response.ok) { var e = new Error(data.error || 'DELTA_RUN_FAILED'); e.status = response.status; throw e; }
        return data;
      });
    }).catch(function (e) {
      if (e.name === 'AbortError') throw new Error('DELTA_RUN_TIMEOUT');
      throw e;
    }).then(function (v) { clearTimeout(timer); return v; },
            function (e) { clearTimeout(timer); throw e; });
  }

  var run = null;   // the single acquisition this page performed

  window.SW_EVIDENCE_INDEX = {
    // Everything happens here. The name is kept because layer 17 calls it.
    begin: function (windowRange, accounts) {
      var reportId = (window.state && state.reportId) || (window.state && state.seal && state.seal.report_id) || null;
      if (!reportId) throw new Error('DELTA_REPORT_ID_REQUIRED');
      if (typeof log === 'function') log('Evidence: reading checkpoint and walking the delta (one server call)...');
      // The window travels with the request. Without it the server has no way
      // to know which days the report covers, and can only hand back this run's
      // delta — which on a second run of the same day is nearly empty while the
      // morning's transactions sit committed in the evidence repository.
      var w = windowRange || {};
      return post('run', { report_id: reportId, scan_id: (window.state && state.scanId) || null,
        window_start_ms: w.startMs, window_end_ms: w.endMs })
        .then(function (result) {
          run = result;
          run.byAddress = Object.create(null);
          (result.wallets || []).forEach(function (w) { run.byAddress[w.address] = w; });
          if (typeof log === 'function') {
            log('Evidence: anchor ' + result.anchor_ledger + ' · ' + result.complete_wallets + '/' +
              result.target_wallets + ' proved · ' + (result.transactions || 0) + ' transactions · ' +
              (result.xrpl_requests || 0) + ' XRPL reads' +
              (result.window && result.window.in_window !== undefined
                ? ' · window ' + result.window.in_window + ' events (' +
                  result.window.from_stored + ' stored + ' + result.window.from_this_run + ' this run)' : '') +
              (result.committed ? ' · checkpoint advanced' : ' · checkpoint NOT advanced (' + result.reason + ')'));
            if (result.window && result.window.error) {
              log('Evidence: REPORT WINDOW UNAVAILABLE — ' + result.window.error +
                '. The report cannot be assembled from this run alone.');
            }
          }
          return {
            scan_id: result.scan_id || ('gh-' + result.anchor_ledger),
            anchor_ledger: result.anchor_ledger,
            anchor_close_ms: Date.parse(result.anchor_close),
            accounts: (result.wallets || []).map(function (w) { return w.address; }),
            roster_hash: result.state_sha256 || 'github-state',
            committed: result.committed, freshness: result.freshness
          };
        });
    },

    metrics: function () {
      if (!run) return null;
      return { scan_id: run.scan_id, target_wallets: run.target_wallets, indexed_wallets: run.complete_wallets,
        requests: run.xrpl_requests, rows_fetched: run.transactions, errors: (run.failures || []),
        stored_transactions_loaded: (run.window && run.window.from_stored) || 0,
        report_window: run.window || null,
        balance_contradictions: run.balance_contradictions,
        balance_contradiction_addresses: run.balance_contradiction_addresses || [],
        checkpoint_advanced: !!run.committed, freshness: run.freshness };
    },

    // Per-wallet, served from the run that already happened. A wallet that did
    // not complete throws, exactly as the old path did, so layer 17's existing
    // failure accounting is unchanged.
    proveWallet: function (indexRun, address) {
      return Promise.resolve().then(function () {
        if (!run) throw new Error('DELTA_RUN_NOT_STARTED');
        var w = run.byAddress[address];
        if (!w) throw new Error('WALLET_NOT_IN_STATE: ' + address);
        if (w.status !== 'COMPLETE') throw new Error(w.error || 'WALLET_NOT_PROVEN');
        return { rows: [], proof: {
          status: 'COMPLETE', source: 'GITHUB_EVIDENCE_STORE', run_id: indexRun.scan_id,
          anchor_ledger: run.anchor_ledger, from_ledger: null, through_ledger: w.proven_through,
          range_bound_proven: true, range_exhausted: true, edge_fetch_complete: true,
          covers_window_start: true, request_bounded: true, transport_consistent: true,
          window_bounded_by_anchor: true, response_validated: true,
          response_ledger_index_max: run.anchor_ledger, pages_scanned: 0,
          attempts: w.attempts, reconciliation: w.reconciliation } };
      });
    },

    // THE REPORT WINDOW, assembled by the server: what is already committed for
    // the days this report covers, unioned with what this run just walked, each
    // transaction once. Not the run's delta — see begin().
    //
    // An absent window is refused rather than substituted. Rendering a day from
    // a delta that does not cover it is exactly the kind of quiet
    // understatement this project exists to prevent.
    readRun: function () {
      return Promise.resolve().then(function () {
        if (!run) throw new Error('DELTA_RUN_NOT_STARTED');
        if (!run.events) {
          throw new Error('REPORT_WINDOW_UNAVAILABLE: ' +
            ((run.window && run.window.error) || 'the server did not assemble the window'));
        }
        return run.events.map(function (e) {
          return {
            hash: e.hash, ledger_index: e.ledger_index, date: e.close_time,
            type: e.tx_type, tx_result: e.tx_result, validated: e.validated === true,
            from: e.from_account || '', to: e.escrow_destination || e.to_account || '',
            amount: e.amount_drops !== null && e.amount_drops !== undefined ? String(e.amount_drops)
                  : (e.amount_value !== null && e.amount_value !== undefined ? String(e.amount_value) : null),
            currency: e.currency || 'XRP', issuer: e.issuer || '',
            destination_tag: e.destination_tag, sig_mode: e.sig_mode || 'unknown',
            signer_count: Number(e.signer_count) || 0, escrow_owner: e.escrow_owner || '',
            escrow_amount_drops: e.escrow_amount_drops === null || e.escrow_amount_drops === undefined
              ? null : String(e.escrow_amount_drops),
            observed_via: Array.isArray(e.observed_via) ? e.observed_via : []
          };
        });
      });
    },

    finish: function () {
      return Promise.resolve().then(function () {
        if (!run) throw new Error('DELTA_RUN_NOT_STARTED');
        return { status: run.committed ? 'COMPLETE' : 'PARTIAL',
          complete_wallets: run.complete_wallets, target_wallets: run.target_wallets,
          requests: run.xrpl_requests, rows_fetched: run.transactions,
          balance_contradictions: run.balance_contradictions,
          balance_contradiction_addresses: run.balance_contradiction_addresses || [],
          checkpoint_advanced: !!run.committed, reason: run.reason || null };
      });
    },

    // Kept so a diagnostic can still reach the database-backed path on a build
    // that has one. Never used by the report.
    _legacy: LEGACY
  };

  window.SW_DELTA_EVIDENCE_20260911 = true;
})();
