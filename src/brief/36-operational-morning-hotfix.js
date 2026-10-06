/* ═══════════════════════════════════════════════════════════════════════════
   OPERATIONAL MORNING HOTFIX — 2026-09-13

   Goal: make the daily ShadowWatch report depend only on a bounded, recent,
   read-only XRPL scan. No Neon/runtime history warehouse is required.

   Cold start: prove up to the last 72h of the watched roster.
   Later runs: cover at least the normal report window, widened to the gap since
   the last FULLY PROVEN operational run. An incomplete run never advances the
   operational checkpoint.

   READ-ONLY XRPL ONLY: ledger + the existing account_info/account_tx callers.
   No signing, submit, trading, payout, or ledger mutation.
   ═══════════════════════════════════════════════════════════════════════════ */
(function () {
  'use strict';

  var VERSION = '2026.09.13.1';
  var STORE = 'SW_OPERATIONAL_MORNING_V1';
  var COLD_LOOKBACK_H = 72;
  var MAX_GAP_H = 24 * 7;
  var ACCOUNT_TX_LIMIT = 400;
  var MAX_PAGES = 64; // 25,600 tx/wallet hard ceiling; truncation is explicit.

  function num(v) {
    var x = Number(v);
    return Number.isFinite(x) ? x : 0;
  }

  function loadState() {
    try {
      var x = JSON.parse(localStorage.getItem(STORE) || '{}');
      return x && typeof x === 'object' ? x : {};
    } catch (_) { return {}; }
  }

  function saveState(x) {
    try { localStorage.setItem(STORE, JSON.stringify(x || {})); } catch (_) {}
  }

  function logOp(msg) {
    try { if (typeof log === 'function') log('[operational] ' + msg); } catch (_) {}
  }

  function txLedger(item) {
    var t = item && (item.tx_json || item.tx) || {};
    var v = item && (item.ledger_index != null ? item.ledger_index :
      (item.ledger != null ? item.ledger :
      (t.ledger_index != null ? t.ledger_index : t.ledger)));
    var n = Number(v);
    return Number.isFinite(n) ? n : null;
  }

  function runId() {
    return 'SW-OP-' + new Date().toISOString().replace(/[-:.TZ]/g, '').slice(0, 14) + '-' +
      Math.random().toString(36).slice(2, 7).toUpperCase();
  }

  // Replace the legacy "last balance snapshot = last good scan" assumption.
  // Balance snapshots can be written by an incomplete tx scan, so they are not
  // allowed to close a reporting gap. Only a full operational proof may do it.
  function installWindowGovernor() {
    try {
      if (typeof getTxWindow !== 'function' || getTxWindow._swOperational20260913) return;
      var legacy = getTxWindow;
      getTxWindow = function () {
        var tw = legacy.apply(this, arguments) || {};
        if (tw.custom) return tw;

        var now = Date.now();
        var saved = loadState();
        var lastGoodMs = saved.last_good_at ? Date.parse(saved.last_good_at) : 0;
        var requiredH;
        if (!lastGoodMs || !Number.isFinite(lastGoodMs)) {
          requiredH = Math.max(COLD_LOOKBACK_H, num(tw.hours) || 24);
        } else {
          var gapH = Math.max(1, (now - lastGoodMs) / 3600000 + 1);
          requiredH = Math.max(num(tw.hours) || 24, Math.min(MAX_GAP_H, gapH));
        }

        if (requiredH <= (num(tw.hours) || 0) + 0.01) return tw;
        return Object.assign({}, tw, {
          startMs: now - requiredH * 3600000,
          endMs: now,
          hours: requiredH,
          autoHours: requiredH,
          label: 'LAST ' + Math.ceil(requiredH) + 'H · OPERATIONAL GAP COVERAGE'
        });
      };
      getTxWindow._swOperational20260913 = true;
      getTxWindow._legacyOperational = legacy;

      // Make the cold-start window visible in the inputs too, not just in the
      // internal governor. This is presentation only; getTxWindow remains the
      // authority above.
      var st = loadState();
      if (!st.last_good_at && typeof setTxWindowHours === 'function') {
        try { setTxWindowHours(COLD_LOOKBACK_H, true); } catch (_) {}
      }
    } catch (_) {}
  }

  function installDirectAccountTx() {
    try {
      if (typeof accountTxWindowDepth !== 'function' || accountTxWindowDepth._swOperational20260913) return;
      var proofs = Object.create(null);

      accountTxWindowDepth = async function (ws, account, startMs, endMs) {
        var rows = [], marker = null, pages = 0;
        var boundaryReached = false, historyExhausted = false;
        var status = 'UNPROVEN', error = null;
        var anchor = null, rid = null, epoch = 0;
        var oldestLedger = null, newestLedger = null;
        try {
          anchor = state && state.runAnchor && state.runAnchor.ok ? num(state.runAnchor.anchor_ledger) : null;
          rid = state && state.runId ? state.runId : null;
          epoch = state ? num(state._transportEpoch) : 0;
        } catch (_) {}

        if (!anchor || !rid) {
          status = 'FAILED';
          error = 'operational run anchor missing';
        }

        while (!error && pages < MAX_PAGES) {
          try {
            var beforeEpoch = 0;
            try { beforeEpoch = state ? num(state._transportEpoch) : 0; } catch (_) {}
            if (beforeEpoch !== epoch) throw new Error('transport changed during wallet walk');

            var req = {
              command: 'account_tx',
              account: account,
              ledger_index_min: -1,
              ledger_index_max: anchor,
              limit: ACCOUNT_TX_LIMIT,
              forward: false
            };
            if (marker) req.marker = marker;
            var res = await xrpl(ws, req);

            var afterEpoch = 0;
            try { afterEpoch = state ? num(state._transportEpoch) : 0; } catch (_) {}
            if (afterEpoch !== epoch) throw new Error('transport changed during wallet walk');

            // If the transport echoes a ceiling, it must match the run anchor.
            // Some rippled transports omit the field, so absence alone is not a
            // failure; a conflicting value is.
            if (res && res.ledger_index_max != null && num(res.ledger_index_max) !== anchor)
              throw new Error('response ceiling did not match pinned anchor');
            if (res && res.validated === false)
              throw new Error('account_tx response was not validated');

            pages++;
            var txs = (res && res.transactions) || [];
            var oldestMs = Infinity;
            for (var i = 0; i < txs.length; i++) {
              var item = txs[i] || {};
              var t = item.tx_json || item.tx || {};
              var iso = t.date ? rip(t.date) : '';
              if (!iso) continue;
              var ms = new Date(iso).getTime();
              if (!Number.isFinite(ms)) continue;
              oldestMs = Math.min(oldestMs, ms);
              var li = txLedger(item);
              if (li !== null) {
                if (oldestLedger === null || li < oldestLedger) oldestLedger = li;
                if (newestLedger === null || li > newestLedger) newestLedger = li;
                if (li > anchor) throw new Error('transaction exceeded pinned anchor');
              }
              if (ms >= startMs && ms <= endMs) rows.push(item);
            }

            marker = res && res.marker ? res.marker : null;
            if (oldestMs <= startMs) { boundaryReached = true; break; }
            if (!marker) { historyExhausted = true; break; }
          } catch (e) {
            error = e && e.message ? e.message : String(e || 'account_tx failed');
            break;
          }
        }

        if (error) status = 'FAILED';
        else if (boundaryReached || historyExhausted) status = 'COMPLETE';
        else status = 'TRUNCATED';

        proofs[account] = {
          status: status,
          proven_reason: status === 'COMPLETE' ? (boundaryReached ? 'TIME_BOUNDARY_REACHED' : 'HISTORY_EXHAUSTED') : null,
          unproven_reason: status === 'TRUNCATED' ? 'OPERATIONAL_PAGE_CEILING' : (status === 'FAILED' ? error : null),
          request_bounded: !!anchor,
          transport_consistent: !error || !/transport changed/i.test(error),
          source: 'XRPL_DIRECT_OPERATIONAL',
          actual_endpoint: null,
          transport_epoch: epoch,
          run_id: rid,
          pages_scanned: pages,
          boundary_reached: boundaryReached,
          history_exhausted: historyExhausted,
          anchor_ledger: anchor,
          oldest_observed_ledger: oldestLedger,
          newest_observed_ledger: newestLedger,
          error: error,
          operational_limit: ACCOUNT_TX_LIMIT,
          operational_max_pages: MAX_PAGES
        };

        if (status === 'FAILED') throw new Error(error || 'operational account_tx failed');
        return rows;
      };

      accountTxWindowDepth._proofByAccount = proofs;
      accountTxWindowDepth._swOperational20260913 = true;
      // Prevent a later duplicate load of layer 17 from overwriting this helper.
      accountTxWindowDepth._swTxCompleteness20260819 = true;
      try { pageDepthFor = function () { return MAX_PAGES; }; } catch (_) {}
    } catch (_) {}
  }

  function installScanWrapper() {
    try {
      if (typeof scanWallets !== 'function' || scanWallets._swOperational20260913) return;
      var wrapped17 = scanWallets;

      scanWallets = async function (ws) {
        try {
          var proofTable = accountTxWindowDepth && accountTxWindowDepth._proofByAccount;
          if (proofTable) for (var pk in proofTable) delete proofTable[pk];
        } catch (_) {}
        var rid = runId();
        var tw = (typeof getTxWindow === 'function') ? getTxWindow() : {
          startMs: Date.now() - COLD_LOOKBACK_H * 3600000,
          endMs: Date.now(), hours: COLD_LOOKBACK_H
        };

        // This runtime intentionally does not consult Neon/indexed history.
        try { state.indexRun = null; } catch (_) {}

        // Pin exactly one validated ledger for the whole report run.
        var anchorRes = await xrpl(ws, {
          command: 'ledger', ledger_index: 'validated', transactions: false, expand: false
        });
        var led = anchorRes && (anchorRes.ledger || anchorRes);
        var anchor = num(led && (led.ledger_index != null ? led.ledger_index : anchorRes.ledger_index));
        if (!anchor) throw new Error('operational anchor could not be pinned');

        try {
          state.runId = rid;
          state.runAnchor = {
            ok: true,
            anchor_ledger: anchor,
            anchor_hash: (led && led.ledger_hash) || (anchorRes && anchorRes.ledger_hash) || null,
            transport_epoch: num(state._transportEpoch),
            source: 'XRPL_DIRECT_OPERATIONAL'
          };
          state.anchorOk = true;
          state.effectiveWindow = {
            start_ms: tw.startMs,
            end_ms: tw.endMs,
            hours: tw.hours,
            bounded_by_anchor: true,
            source: 'OPERATIONAL_RECENT_WINDOW'
          };
        } catch (_) {}

        logOp('run ' + rid + ' pinned ledger ' + anchor + '; recent window ' + Math.ceil(num(tw.hours)) + 'h; direct XRPL only');
        var result = await wrapped17.apply(this, arguments);

        // Advance the operational checkpoint only when every watched wallet
        // proved the requested window. An incomplete run cannot hide the gap.
        try {
          var c = state && state.txScanCoverage;
          if (c && c.full_window_complete === true && num(c.complete_wallets) === num(c.target_wallets) && num(c.target_wallets) > 0) {
            saveState({
              version: VERSION,
              last_good_at: new Date().toISOString(),
              last_good_anchor: anchor,
              last_good_run_id: rid,
              target_wallets: num(c.target_wallets),
              complete_wallets: num(c.complete_wallets)
            });
            logOp('checkpoint advanced: ' + c.complete_wallets + '/' + c.target_wallets + ' wallets proved');
          } else {
            logOp('checkpoint NOT advanced: transaction-window proof incomplete');
          }
        } catch (_) {}

        return result;
      };

      scanWallets._swOperational20260913 = true;
      // Keep the existing layer-17 wrapper identity so duplicate historical
      // loader passes do not wrap it again.
      scanWallets._swTxCompleteness20260819 = true;
    } catch (_) {}
  }

  function install() {
    installWindowGovernor();
    installDirectAccountTx();
    installScanWrapper();
    if (typeof scanWallets !== 'function' || !scanWallets._swOperational20260913) {
      setTimeout(install, 100);
      return;
    }
    window.SW_OPERATIONAL_MORNING = {
      version: VERSION,
      read_only: true,
      runtime_source: 'XRPL_DIRECT',
      cold_lookback_hours: COLD_LOOKBACK_H,
      account_tx_limit: ACCOUNT_TX_LIMIT,
      max_pages_per_wallet: MAX_PAGES,
      last_good: function () { return loadState(); },
      reset_checkpoint: function () { try { localStorage.removeItem(STORE); } catch (_) {} }
    };
    logOp('morning reliability hotfix active — direct bounded XRPL runtime');
  }

  install();
})();
