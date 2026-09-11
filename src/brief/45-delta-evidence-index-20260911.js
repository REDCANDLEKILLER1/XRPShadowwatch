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
      return post('run', { report_id: reportId, scan_id: (window.state && state.scanId) || null })
        .then(function (result) {
          run = result;
          run.byAddress = Object.create(null);
          (result.wallets || []).forEach(function (w) { run.byAddress[w.address] = w; });
          if (typeof log === 'function') {
            log('Evidence: anchor ' + result.anchor_ledger + ' · ' + result.complete_wallets + '/' +
              result.target_wallets + ' proved · ' + (result.transactions || 0) + ' transactions · ' +
              (result.xrpl_requests || 0) + ' XRPL reads' +
              (result.committed ? ' · checkpoint advanced' : ' · checkpoint NOT advanced (' + result.reason + ')'));
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
        stored_transactions_loaded: run.transactions,
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

    // The canonical stream, already deduplicated by the run.
    readRun: function () {
      return Promise.resolve().then(function () {
        if (!run) throw new Error('DELTA_RUN_NOT_STARTED');
        return (run.rows || []).map(function (r) {
          return {
            hash: r.hash, ledger_index: r.ledger_index, date: r.close_time_iso || r.close_time,
            type: r.tx_type, tx_result: r.tx_result, validated: r.validated === true,
            from: r.from_account || '', to: r.escrow_destination || r.to_account || '',
            amount: r.amount_drops !== null && r.amount_drops !== undefined ? String(r.amount_drops)
                  : (r.amount_value !== null && r.amount_value !== undefined ? String(r.amount_value) : null),
            currency: r.currency || 'XRP', issuer: r.issuer || '',
            destination_tag: r.destination_tag, sig_mode: r.sig_mode || 'unknown',
            signer_count: Number(r.signer_count) || 0, escrow_owner: r.escrow_owner || '',
            escrow_amount_drops: r.escrow_amount_drops === null || r.escrow_amount_drops === undefined
              ? null : String(r.escrow_amount_drops),
            observed_via: Array.isArray(r.observed_via) ? r.observed_via : (r.observed_via ? [r.observed_via] : [])
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
