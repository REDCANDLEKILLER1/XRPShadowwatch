/* ═══════════════════════════════════════════════════════════════════════════
   REPORT SCAN TUNING — 2026-08-16

   Deliberately small changes:
   1) Promote only wallets the exported Report explicitly marks ADD.
   2) On 48h+ automatic/default scans, request 400 account_tx rows per page
      instead of the default 200. Concurrency remains unchanged at x8 and the
      existing marker pagination / weekend lookback remain authoritative.

   Read-only. No signing, submit, trading, or XRPL mutation.
   ═══════════════════════════════════════════════════════════════════════════ */
(function () {
  'use strict';

  var VERSION = '2026.08.16.3';
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

  function installLongWindowPageTuning() {
    try {
      if (typeof scanWallets !== 'function' || scanWallets._sw20260816Tuned) return;
      var original = scanWallets;

      scanWallets = async function () {
        var input = null;
        var oldValue = null;
        var boosted = false;
        var tw = null;
        var hours = 0;

        try {
          tw = (typeof getTxWindow === 'function') ? getTxWindow() : null;
          hours = tw ? Number(tw.hours || 0) : 0;
          input = document.getElementById('inTxLimit');
          oldValue = input ? input.value : null;

          // Only lift the stock/default 200-row setting on the scanner's own
          // automatic window. A manually selected date/time range or a custom
          // page-size value is never overridden. Concurrency stays at x8.
          if (input && tw && !tw.custom && hours >= 48 && Number(input.value || 0) === 200) {
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

  promoteReportWallets();
  installLongWindowPageTuning();

  window.SW_REPORT_SCAN_TUNING_20260816 = {
    version: VERSION,
    read_only: true,
    promoted_addresses: PROMOTIONS.map(function (p) { return p.address; }),
    promoted_from_reports: PROMOTIONS.map(function (p) { return p.source_report; }),
    long_window_min_hours: 48,
    default_page_size: 200,
    tuned_page_size: 400,
    automatic_windows_only: true,
    concurrency_changed: false,
    lookback_changed: false
  };
})();
