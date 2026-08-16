/* Report UI responsiveness guard — 2026-08-16.
   Presentation-only. The ledger scanner, XRPL calls, concurrency, pagination,
   weekend lookback, evidence, scoring, and wallet status logic are untouched.

   Why: Phase 1 currently calls renderWallets() after every x8 wallet batch.
   At 240 watched wallets that can rebuild the full 240-row table ~30 times,
   while progress ticks also request live dashboard renders. On mobile/webview
   browsers that repeated DOM churn can temporarily monopolize the main thread.
*/
(function () {
  'use strict';

  var VERSION = '2026.08.16.1';
  var WALLET_MIN_MS = 450;
  var DASH_MIN_MS = 140;

  function nowMs() {
    try { return performance.now(); } catch (_) { return Date.now(); }
  }

  function scanningNow() {
    try { return typeof state !== 'undefined' && state && state.scanning === true; }
    catch (_) { return false; }
  }

  function makeThrottle(original, minMs) {
    var last = 0;
    var timer = null;
    var raf = null;
    var pendingThis = null;
    var pendingArgs = null;

    function invoke() {
      timer = null;
      raf = null;
      last = nowMs();
      var ctx = pendingThis;
      var args = pendingArgs;
      pendingThis = null;
      pendingArgs = null;
      try { return original.apply(ctx, args || []); } catch (_) { return undefined; }
    }

    function frame() {
      if (typeof requestAnimationFrame === 'function') raf = requestAnimationFrame(invoke);
      else timer = setTimeout(invoke, 0);
    }

    function throttled() {
      pendingThis = this;
      pendingArgs = arguments;

      // Outside an active scan, preserve normal immediate UI behavior.
      if (!scanningNow()) {
        if (timer) { clearTimeout(timer); timer = null; }
        if (raf && typeof cancelAnimationFrame === 'function') { cancelAnimationFrame(raf); raf = null; }
        return invoke();
      }

      // Coalesce repeated scan-time redraw requests. Always keep the latest args
      // and schedule a trailing render, so the final wallet table still appears.
      if (timer || raf) return;
      var wait = Math.max(0, minMs - (nowMs() - last));
      if (wait <= 0) frame();
      else timer = setTimeout(frame, wait);
    }

    throttled._swUiOriginal = original;
    throttled._swUiMinMs = minMs;
    return throttled;
  }

  var walletWrapped = false;
  var dashWrapped = false;

  try {
    var originalWallets = window.renderWallets;
    if (typeof originalWallets === 'function' && !originalWallets._swUiResponsive) {
      var walletThrottle = makeThrottle(originalWallets, WALLET_MIN_MS);
      walletThrottle._swUiResponsive = true;
      window.renderWallets = walletThrottle;
      // Top-level classic-script function bindings mirror window properties, but
      // assign explicitly too so unqualified renderWallets() calls use the guard.
      try { renderWallets = walletThrottle; } catch (_) {}
      walletWrapped = true;
    }
  } catch (_) {}

  try {
    var originalDash = window.renderDashboardV1Live;
    if (typeof originalDash === 'function' && !originalDash._swUiResponsive) {
      var dashThrottle = makeThrottle(originalDash, DASH_MIN_MS);
      dashThrottle._swUiResponsive = true;
      window.renderDashboardV1Live = dashThrottle;
      try { renderDashboardV1Live = dashThrottle; } catch (_) {}
      dashWrapped = true;
    }
  } catch (_) {}

  // Diagnostic only: if Chromium reports a genuinely long main-thread task on a
  // future run, put a small breadcrumb in the normal scan log. Never enters the
  // application ERROR LOG and is rate-limited to avoid creating more UI work.
  var longTaskCount = 0;
  var lastLongTaskAt = 0;
  try {
    if (typeof PerformanceObserver === 'function' && PerformanceObserver.supportedEntryTypes &&
        PerformanceObserver.supportedEntryTypes.indexOf('longtask') >= 0) {
      var po = new PerformanceObserver(function (list) {
        list.getEntries().forEach(function (entry) {
          if (!scanningNow() || Number(entry.duration || 0) < 350) return;
          var t = Date.now();
          if (t - lastLongTaskAt < 1500 || longTaskCount >= 8) return;
          lastLongTaskAt = t;
          longTaskCount++;
          try {
            var phase = (window.XAI_SCAN_PROGRESS && window.XAI_SCAN_PROGRESS.phase) || 'UNKNOWN';
            if (typeof log === 'function') log('UI PERF: main-thread long task ' + Math.round(entry.duration) + 'ms during ' + phase + '.');
          } catch (_) {}
        });
      });
      po.observe({ entryTypes: ['longtask'] });
    }
  } catch (_) {}

  window.SW_UI_RESPONSIVENESS_20260816 = {
    version: VERSION,
    presentation_only: true,
    wallet_render_min_ms: WALLET_MIN_MS,
    dashboard_render_min_ms: DASH_MIN_MS,
    wallet_render_wrapped: walletWrapped,
    dashboard_render_wrapped: dashWrapped,
    long_task_logging: true,
    scanner_untouched: true,
    concurrency_untouched: true,
    lookback_untouched: true
  };
})();
