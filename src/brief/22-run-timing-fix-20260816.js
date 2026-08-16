/* Reliable Report run timing — 2026-08-16.
   Diagnostic-only. Uses Shadow Watch's existing event bus; no XRPL requests,
   scanner concurrency, pagination, lookback, evidence, scoring or wallet logic.

   The first timing attempt wrapped run(), but the visible command path can reach
   the scanner through existing DOM/event handlers that captured the original
   function. The event bus is authoritative for actual scan lifecycle events, so
   timing belongs here instead.
*/
(function () {
  'use strict';

  var VERSION = '2026.08.16.2';
  if (window.SW_EVENT_RUN_TIMING_20260816 && window.SW_EVENT_RUN_TIMING_20260816.installed) return;

  function perfNow() {
    try { return performance.now(); } catch (_) { return Date.now(); }
  }
  function st() {
    try { return (typeof state !== 'undefined' && state) ? state : null; } catch (_) { return null; }
  }
  function num(v) {
    var x = Number(v);
    return Number.isFinite(x) ? x : null;
  }
  function txWindow() {
    try { return (typeof getTxWindow === 'function') ? getTxWindow() : null; } catch (_) { return null; }
  }
  function watchCount() {
    try { return (typeof getActiveWatchlist === 'function') ? getActiveWatchlist().length : null; } catch (_) { return null; }
  }
  function visibleLimit() {
    try {
      var el = document.getElementById('inTxLimit');
      return el ? num(el.value) : null;
    } catch (_) { return null; }
  }
  function parallel() {
    try { return (typeof SCAN_PARALLEL !== 'undefined') ? Number(SCAN_PARALLEL) : null; } catch (_) { return null; }
  }

  var clock = {
    version: VERSION,
    installed: true,
    current: null,
    last: null,
    starts_seen: 0,
    finishes_seen: 0
  };

  function begin(partial) {
    if (clock.current) return clock.current;
    var tw = txWindow();
    var s = st();
    clock.starts_seen += 1;
    clock.current = {
      source: 'SHADOW_EVENT_BUS',
      timer_version: VERSION,
      started_at: new Date().toISOString(),
      started_perf: perfNow(),
      finished_at: null,
      total_ms: null,
      status: partial ? 'RUNNING_PARTIAL_START' : 'RUNNING',
      partial_start: !!partial,
      phase_current: null,
      phase_started_perf: null,
      phase_status: '',
      phases: [],
      context: {
        watched_wallets: watchCount(),
        window_hours: tw && tw.hours != null ? Number(tw.hours) : null,
        window_label: tw && tw.label ? String(tw.label) : null,
        custom_window: !!(tw && tw.custom),
        visible_tx_limit: visibleLimit(),
        parallel: parallel(),
        scan_speed_tuning: window.SW_REPORT_SCAN_TUNING_20260816 || null
      },
      scan_id: s && s.scanId ? s.scanId : null,
      ui_lag_events: [],
      ui_long_tasks: []
    };
    return clock.current;
  }

  function phase(name, status) {
    var r = clock.current || begin(true);
    var p = String(name || 'UNKNOWN').toUpperCase();
    var t = perfNow();
    if (r.phase_current === p) {
      if (status) r.phase_status = String(status);
      return;
    }
    if (r.phase_current && r.phase_started_perf != null) {
      r.phases.push({
        phase: r.phase_current,
        duration_ms: Math.max(0, t - r.phase_started_perf),
        status: r.phase_status || ''
      });
    }
    r.phase_current = p;
    r.phase_started_perf = t;
    r.phase_status = String(status || '');
  }

  function copyLagEvents(r) {
    try {
      var s = st();
      var a = s && Array.isArray(s.ui_perf_lag_events) ? s.ui_perf_lag_events : [];
      var b = s && Array.isArray(s.ui_perf_long_tasks) ? s.ui_perf_long_tasks : [];
      r.ui_lag_events = a.slice(-16);
      r.ui_long_tasks = b.slice(-12);

      // The existing Total Debug timing renderer already prints r.phases. Add
      // diagnostic pseudo-phases so browser/webview stalls appear in the export
      // without changing the export format or polluting the ERROR LOG.
      r.ui_lag_events.forEach(function (e) {
        r.phases.push({
          phase: 'UI_STALL',
          duration_ms: Number(e.lag_ms || 0),
          status: 'event-loop lag during ' + String(e.phase || 'UNKNOWN') +
            (e.progress_pct == null ? '' : ' at ~' + Math.round(e.progress_pct) + '%')
        });
      });
      r.ui_long_tasks.forEach(function (e) {
        r.phases.push({
          phase: 'UI_LONGTASK',
          duration_ms: Number(e.duration_ms || 0),
          status: 'Long Tasks API during ' + String(e.phase || 'UNKNOWN') +
            (e.progress_pct == null ? '' : ' at ~' + Math.round(e.progress_pct) + '%')
        });
      });
    } catch (_) {}
  }

  function finish(status) {
    var r = clock.current;
    if (!r) return;
    var t = perfNow();
    if (r.phase_current && r.phase_started_perf != null) {
      r.phases.push({
        phase: r.phase_current,
        duration_ms: Math.max(0, t - r.phase_started_perf),
        status: r.phase_status || ''
      });
    }
    r.finished_at = new Date().toISOString();
    r.total_ms = Math.max(0, t - r.started_perf);
    r.status = status || 'COMPLETE';
    var s = st();
    if (s) {
      r.scan_id = (s.pack && s.pack.scan_id) || s.scanId || r.scan_id || null;
      copyLagEvents(r);
      try { s.internal_run_timing = JSON.parse(JSON.stringify(r)); }
      catch (_) { s.internal_run_timing = r; }
    }
    clock.last = r;
    clock.current = null;
    clock.finishes_seen += 1;
  }

  function on(bus, evt, fn) {
    try { bus.on(evt, fn); } catch (_) {}
  }

  try {
    var bus = window.SHADOW_EVENT_BUS;
    if (bus && typeof bus.on === 'function') {
      on(bus, 'shadow.scan.started', function () { begin(false); phase('INITIALIZING', 'scan started'); });
      on(bus, 'shadow.wallet.scan.started', function () { phase('WALLET_SCAN', 'watched-wallet scan'); });
      on(bus, 'shadow.balance.snapshot.started', function () { phase('BALANCE', 'balance snapshot'); });
      on(bus, 'shadow.wallet.scan.completed', function () { phase('FLOW', 'ledger wallet pass complete'); });
      on(bus, 'shadow.news.lookup.started', function () { phase('NEWS', 'news/context lookup'); });
      on(bus, 'shadow.news.evidence_led', function () { phase('NEWS', 'news evidence-led'); });
      on(bus, 'shadow.news.degraded', function () { phase('NEWS', 'news degraded'); });
      on(bus, 'shadow.candidate.promoted', function () { phase('DISCOVERY', 'candidate review'); });
      on(bus, 'shadow.report.building', function () { phase('REPORTING', 'building report'); });
      on(bus, 'shadow.report.sealed', function () { phase('SEALED', 'report sealed'); finish('COMPLETE'); });
      on(bus, 'shadow.error.scan_failed', function () { finish('FAILED'); });
    }
  } catch (_) {}

  // If this diagnostic layer arrives after a scan has already started, capture
  // the remainder rather than returning another empty timing block. A fresh next
  // run will begin at the actual shadow.scan.started event and be exact.
  try {
    var s0 = st();
    if (s0 && s0.scanning && !clock.current) {
      begin(true);
      var p0 = (window.XAI_SCAN_PROGRESS && window.XAI_SCAN_PROGRESS.phase) || 'SCANNING';
      phase(p0, 'timer attached during active scan');
    }
  } catch (_) {}

  window.SW_EVENT_RUN_TIMING_20260816 = clock;
})();
