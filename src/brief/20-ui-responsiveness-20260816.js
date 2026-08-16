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

  var VERSION = '2026.08.16.2';
  var WALLET_MIN_MS = 450;
  var DASH_MIN_MS = 140;
  var EVENT_LOOP_SAMPLE_MS = 500;
  var EVENT_LOOP_LAG_MIN_MS = 700;

  function nowMs() {
    try { return performance.now(); } catch (_) { return Date.now(); }
  }

  function scanningNow() {
    try { return typeof state !== 'undefined' && state && state.scanning === true; }
    catch (_) { return false; }
  }

  function currentPhase() {
    try { return (window.XAI_SCAN_PROGRESS && window.XAI_SCAN_PROGRESS.phase) || 'UNKNOWN'; }
    catch (_) { return 'UNKNOWN'; }
  }

  function currentPct() {
    try {
      var el = document.getElementById('xaiMissionFill');
      var n = el ? parseFloat(String(el.style.width || '0').replace('%', '')) : NaN;
      return Number.isFinite(n) ? n : null;
    } catch (_) { return null; }
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

  // The existing Report has two percentage maps. Older events can therefore
  // ask the smoother to move from a newer/higher value back to an older/lower
  // one (for example ~81% back to 66%). Keep the current single-bar UI monotonic
  // until the per-procedure progress redesign is intentionally built later.
  var progressFloor = 0;
  var progressGuarded = false;
  function resetProgressFloor() { progressFloor = 0; }
  function clampVisibleProgress() {
    try {
      if (!scanningNow()) return;
      var fill = document.getElementById('xaiMissionFill');
      var pct = document.getElementById('xaiMissionPct');
      var shown = fill ? parseFloat(String(fill.style.width || '0').replace('%', '')) : NaN;
      if (Number.isFinite(shown)) progressFloor = Math.max(progressFloor, shown);
      if (fill && Number.isFinite(progressFloor)) fill.style.width = progressFloor + '%';
      if (pct && Number.isFinite(progressFloor)) pct.textContent = Math.round(progressFloor) + '%';
    } catch (_) {}
  }

  try {
    var sm = window.XAI_PROGRESS_SMOOTHER;
    if (sm && typeof sm.setTarget === 'function' && !sm.setTarget._swMonotonic) {
      var originalSetTarget = sm.setTarget.bind(sm);
      var guardedSetTarget = function (pct) {
        var p = Number(pct);
        if (!Number.isFinite(p)) return originalSetTarget(pct);
        if (scanningNow()) {
          progressFloor = Math.max(progressFloor, p);
          p = progressFloor;
        } else {
          progressFloor = Math.max(0, p);
        }
        return originalSetTarget(p);
      };
      guardedSetTarget._swMonotonic = true;
      guardedSetTarget._swOriginal = originalSetTarget;
      sm.setTarget = guardedSetTarget;
      progressGuarded = true;
    }
  } catch (_) {}

  try {
    var narr = window.XAI_PROGRESS_NARRATOR;
    if (narr && typeof narr.updateProgress === 'function' && !narr.updateProgress._swMonotonic) {
      var originalUpdateProgress = narr.updateProgress.bind(narr);
      var guardedUpdateProgress = function (payload) {
        var ret = originalUpdateProgress(payload);
        clampVisibleProgress();
        try {
          var sm2 = window.XAI_PROGRESS_SMOOTHER;
          if (sm2 && typeof sm2.setTarget === 'function' && scanningNow()) sm2.setTarget(progressFloor);
        } catch (_) {}
        return ret;
      };
      guardedUpdateProgress._swMonotonic = true;
      guardedUpdateProgress._swOriginal = originalUpdateProgress;
      narr.updateProgress = guardedUpdateProgress;
      progressGuarded = true;
    }
  } catch (_) {}

  try {
    if (window.SHADOW_EVENT_BUS && typeof window.SHADOW_EVENT_BUS.on === 'function') {
      window.SHADOW_EVENT_BUS.on('shadow.scan.started', resetProgressFloor);
      window.SHADOW_EVENT_BUS.on('shadow.report.sealed', function () { progressFloor = 100; clampVisibleProgress(); });
    }
  } catch (_) {}

  // Diagnostic lane 1: Chromium Long Tasks API where available.
  var longTaskCount = 0;
  var lastLongTaskAt = 0;
  try {
    if (typeof PerformanceObserver === 'function' && PerformanceObserver.supportedEntryTypes &&
        PerformanceObserver.supportedEntryTypes.indexOf('longtask') >= 0) {
      var po = new PerformanceObserver(function (list) {
        list.getEntries().forEach(function (entry) {
          if (!scanningNow() || Number(entry.duration || 0) < 350) return;
          var t = Date.now();
          if (t - lastLongTaskAt < 1500 || longTaskCount >= 12) return;
          lastLongTaskAt = t;
          longTaskCount++;
          try {
            var st = (typeof state !== 'undefined' && state) ? state : null;
            if (st) {
              st.ui_perf_long_tasks = st.ui_perf_long_tasks || [];
              st.ui_perf_long_tasks.push({
                at: new Date().toISOString(),
                duration_ms: Math.round(entry.duration),
                phase: currentPhase(),
                progress_pct: currentPct()
              });
              if (st.ui_perf_long_tasks.length > 12) st.ui_perf_long_tasks = st.ui_perf_long_tasks.slice(-12);
            }
          } catch (_) {}
        });
      });
      po.observe({ entryTypes: ['longtask'] });
    }
  } catch (_) {}

  // Diagnostic lane 2: broad browser/webview event-loop lag detector. This also
  // works where the Long Tasks API is unavailable (common in embedded Android
  // webviews). It stores breadcrumbs only; it does not render or add log spam.
  var lagEvents = [];
  try {
    var expected = nowMs() + EVENT_LOOP_SAMPLE_MS;
    setInterval(function () {
      var now = nowMs();
      var lag = now - expected;
      expected = now + EVENT_LOOP_SAMPLE_MS;
      if (!scanningNow() || lag < EVENT_LOOP_LAG_MIN_MS) return;
      var evt = {
        at: new Date().toISOString(),
        lag_ms: Math.round(lag),
        phase: currentPhase(),
        progress_pct: currentPct()
      };
      lagEvents.push(evt);
      if (lagEvents.length > 16) lagEvents = lagEvents.slice(-16);
      try {
        var st = (typeof state !== 'undefined' && state) ? state : null;
        if (st) st.ui_perf_lag_events = lagEvents.slice();
      } catch (_) {}
    }, EVENT_LOOP_SAMPLE_MS);
  } catch (_) {}

  window.SW_UI_RESPONSIVENESS_20260816 = {
    version: VERSION,
    presentation_only: true,
    wallet_render_min_ms: WALLET_MIN_MS,
    dashboard_render_min_ms: DASH_MIN_MS,
    wallet_render_wrapped: walletWrapped,
    dashboard_render_wrapped: dashWrapped,
    progress_monotonic_guard: progressGuarded,
    event_loop_sample_ms: EVENT_LOOP_SAMPLE_MS,
    event_loop_lag_threshold_ms: EVENT_LOOP_LAG_MIN_MS,
    event_loop_lag_events: lagEvents,
    long_task_logging: true,
    scanner_untouched: true,
    concurrency_untouched: true,
    lookback_untouched: true
  };
})();

// Internal timing + mid-size/sub-1M flow context. This layer consumes the
// transactions already fetched by the Report; it does not add XRPL requests.
(function () {
  try {
    var s = document.createElement('script');
    s.src = '/src/brief/21-shadow-flow-timing-20260816.js';
    s.async = false;
    s.setAttribute('data-sw-shadow-flow-timing', '2026-08-16.2');
    document.body.appendChild(s);

    // Reliable event-bus timing patch. Kept separate from the first timer so it
    // can be removed independently after field verification.
    var t = document.createElement('script');
    t.src = '/src/brief/22-run-timing-fix-20260816.js';
    t.async = false;
    t.setAttribute('data-sw-run-timing-fix', '2026-08-16.1');
    document.body.appendChild(t);
  } catch (_) {}
})();
