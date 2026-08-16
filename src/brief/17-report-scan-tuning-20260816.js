/* ═══════════════════════════════════════════════════════════════════════════
   REPORT SCAN TUNING — 2026-08-16

   Two deliberately small changes:
   1) Promote the one wallet SW-20260816-FJCJQ explicitly marked ADD.
   2) On 48h+ automatic/default scans, request 400 account_tx rows per page
      instead of the default 200. Concurrency remains unchanged at x8 and the
      existing marker pagination / weekend lookback remain authoritative.

   Read-only. No signing, submit, trading, or XRPL mutation.
   ═══════════════════════════════════════════════════════════════════════════ */
(function () {
  'use strict';

  var VERSION = '2026.08.16.1';
  var PROMOTION = {
    address: 'rJP1s6gaopZxXbpGegkxBspUgm5HjLUjBH',
    label: 'LARGE_RECV_rJP1s6',
    cat: 'discovered_receiver',
    balance_xrp_observed: 14382993,
    source_report: 'SW-20260816-FJCJQ'
  };

  function promoteReportWallet() {
    var a = PROMOTION.address;

    // Use the Report engine's own reviewed-add path when available so the
    // existing local persistence format stays canonical.
    try {
      var already = (typeof WATCHLIST !== 'undefined' && Array.isArray(WATCHLIST))
        ? WATCHLIST.some(function (w) { return w && w.address === a; }) : false;
      if (!already && typeof addDiscoveredWallet === 'function') {
        addDiscoveredWallet(a, PROMOTION.label, PROMOTION.balance_xrp_observed, PROMOTION.cat);
      } else if (!already && typeof WATCHLIST !== 'undefined' && Array.isArray(WATCHLIST)) {
        WATCHLIST.push({ label: PROMOTION.label, address: a, cat: PROMOTION.cat });
      }
      if (typeof KNOWN !== 'undefined' && KNOWN) {
        if (!KNOWN[a]) KNOWN[a] = { label: PROMOTION.label, address: a, cat: PROMOTION.cat };
        else KNOWN[a].cat = PROMOTION.cat;
      }
    } catch (_) {}

    // Keep the shared roster used by this Report page aligned immediately.
    // A later roster regeneration can make this an ordinary generated target.
    try {
      var R = window.SW_HVT_ROSTER;
      if (R && Array.isArray(R.targets) && !R.targets.some(function (t) { return t && t.address === a; })) {
        R.targets.push({
          address: a,
          label: PROMOTION.label,
          handle: PROMOTION.label,
          type: 'HVT',
          cat: PROMOTION.cat,
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

  function installLongWindowPageTuning() {
    try {
      if (typeof scanWallets !== 'function' || scanWallets._sw20260816Tuned) return;
      var original = scanWallets;

      scanWallets = async function () {
        var input = null;
        var oldValue = null;
        var boosted = false;
        var hours = 0;

        try {
          hours = (typeof getTxWindow === 'function' && getTxWindow()) ? Number(getTxWindow().hours || 0) : 0;
          input = document.getElementById('inTxLimit');
          oldValue = input ? input.value : null;

          // Only lift the stock/default 200-row setting. A user-selected custom
          // value is never overridden. The scan's x8 concurrency is untouched.
          if (input && hours >= 48 && Number(input.value || 0) === 200) {
            input.value = '400';
            boosted = true;
            try {
              if (typeof log === 'function') log('SCAN SPEED: long-window page size 400 (parallel remains x8; lookback unchanged).');
            } catch (_) {}
          }

          return await original.apply(this, arguments);
        } finally {
          // Restore the visible control exactly as the operator had it.
          if (boosted && input) input.value = oldValue;
        }
      };
      scanWallets._sw20260816Tuned = true;
    } catch (_) {}
  }

  promoteReportWallet();
  installLongWindowPageTuning();

  window.SW_REPORT_SCAN_TUNING_20260816 = {
    version: VERSION,
    read_only: true,
    promoted_address: PROMOTION.address,
    promoted_from_report: PROMOTION.source_report,
    long_window_min_hours: 48,
    default_page_size: 200,
    tuned_page_size: 400,
    concurrency_changed: false,
    lookback_changed: false
  };
})();
