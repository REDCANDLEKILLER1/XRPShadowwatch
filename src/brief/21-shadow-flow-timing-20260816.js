/* Shadow Volume context + internal run timing — 2026-08-16.
   Report/diagnostic-only. No XRPL calls, pagination, concurrency, lookback,
   evidence scoring, wallet mutation, signing, submit, or trading changes.

   Goals:
   1) Keep Shadow Volume historically stable as individual XRP moves >=1M.
   2) Quantify the established 100K-<1M "mid-size" band separately.
   3) Surface repeated same-route mid-size clusters without claiming intent.
   4) Record exact run + phase timings in TOTAL DEBUG only.
*/
(function () {
  'use strict';

  var VERSION = '2026.08.16.1';
  var MID_MIN_XRP = 100000;
  var MID_MAX_XRP = 1000000;
  var ROUTE_MIN_TX = 3;
  var ROUTE_MIN_XRP = 1000000;

  function nowPerf() {
    try { return performance.now(); } catch (_) { return Date.now(); }
  }
  function num(v) {
    var x = Number(v);
    return Number.isFinite(x) ? x : 0;
  }
  function stateRef() {
    try {
      if (typeof state !== 'undefined' && state) return state;
    } catch (_) {}
    try { return window.state || null; } catch (_) { return null; }
  }
  function fmtXrp(v) {
    var x = num(v);
    if (x >= 1e9) return (x / 1e9).toFixed(2) + 'B';
    if (x >= 1e6) return (x / 1e6).toFixed(2) + 'M';
    if (x >= 1e3) return (x / 1e3).toFixed(2) + 'K';
    return x.toLocaleString('en-US', { maximumFractionDigits: 2 });
  }
  function fmtMs(ms) {
    ms = Math.max(0, num(ms));
    var total = Math.round(ms);
    var h = Math.floor(total / 3600000); total -= h * 3600000;
    var m = Math.floor(total / 60000); total -= m * 60000;
    var s = Math.floor(total / 1000); var rem = total - s * 1000;
    var ss = String(s).padStart(2, '0') + '.' + String(rem).padStart(3, '0');
    if (h) return String(h).padStart(2, '0') + ':' + String(m).padStart(2, '0') + ':' + ss;
    return String(m).padStart(2, '0') + ':' + ss;
  }

  // Build a unique native-XRP Payment set. account_tx can surface the same hash
  // from both watched sides of a watched-to-watched payment, so hash-dedupe first.
  function midSizeMetrics() {
    var st = stateRef();
    var rows = st && Array.isArray(st.txs) ? st.txs : [];
    var seen = new Set();
    var mid = [];

    rows.forEach(function (t, idx) {
      if (!t || t.currency !== 'XRP') return;
      if (String(t.type || '') !== 'Payment') return;
      var amount = num(t.amount);
      if (!(amount >= MID_MIN_XRP && amount < MID_MAX_XRP)) return;
      if (!t.from || !t.to) return;

      var key = String(t.hash || '').trim();
      if (!key) key = [t.date || '', t.from, t.to, amount, t.destination_tag || '', idx].join('|');
      if (seen.has(key)) return;
      seen.add(key);
      mid.push({ key: key, from: String(t.from), to: String(t.to), amount: amount, date: t.date || '' });
    });

    var routes = new Map();
    mid.forEach(function (t) {
      var k = t.from + '>' + t.to;
      if (!routes.has(k)) routes.set(k, { from: t.from, to: t.to, count: 0, total_xrp: 0, keys: [] });
      var r = routes.get(k);
      r.count += 1;
      r.total_xrp += t.amount;
      r.keys.push(t.key);
    });

    var clusteredRoutes = [];
    var clusteredKeys = new Set();
    routes.forEach(function (r) {
      if (r.count >= ROUTE_MIN_TX && r.total_xrp >= ROUTE_MIN_XRP) {
        clusteredRoutes.push(r);
        r.keys.forEach(function (k) { clusteredKeys.add(k); });
      }
    });

    var midTotal = mid.reduce(function (sum, t) { return sum + t.amount; }, 0);
    var clusteredTotal = mid.reduce(function (sum, t) {
      return sum + (clusteredKeys.has(t.key) ? t.amount : 0);
    }, 0);
    clusteredRoutes.sort(function (a, b) { return b.total_xrp - a.total_xrp; });

    return {
      band_min_xrp: MID_MIN_XRP,
      band_max_exclusive_xrp: MID_MAX_XRP,
      transfer_count: mid.length,
      total_xrp: midTotal,
      repeated_route_count: clusteredRoutes.length,
      repeated_route_transfer_count: clusteredKeys.size,
      repeated_route_xrp: clusteredTotal,
      route_rule: ROUTE_MIN_TX + '+ same-route transfers totaling >= ' + ROUTE_MIN_XRP + ' XRP',
      top_routes: clusteredRoutes.slice(0, 10).map(function (r) {
        return { from: r.from, to: r.to, count: r.count, total_xrp: r.total_xrp };
      }),
      hash_deduped: true,
      intent_claimed: false
    };
  }

  function attachMetrics(pack) {
    var m = midSizeMetrics();
    if (pack && typeof pack === 'object') {
      pack.mid_size_flow_xrp = m.total_xrp;
      pack.mid_size_transfer_count = m.transfer_count;
      pack.sub_1m_clustered_flow_xrp = m.repeated_route_xrp;
      pack.sub_1m_clustered_route_count = m.repeated_route_count;
      pack.sub_1m_clustered_transfer_count = m.repeated_route_transfer_count;
      pack.mid_size_flow_diagnostic = m;
    }
    return m;
  }

  function augmentMorning(text, pack) {
    var out = String(text == null ? '' : text);
    var m = attachMetrics(pack);

    // Make the long-standing metric self-defining without changing its value.
    out = out.replace(
      /• Shadow volume \(whale moves ≥1M\):/g,
      '• Shadow volume (individual observed XRP moves ≥1M):'
    );

    if (!m.transfer_count) return out;
    var midLine = '• Mid-size flow (100K–<1M): ' + fmtXrp(m.total_xrp) + ' XRP · ' + m.transfer_count + ' transfers';
    var clusterLine = m.repeated_route_count
      ? '• Sub-1M clustered flow: ' + fmtXrp(m.repeated_route_xrp) + ' XRP · ' + m.repeated_route_count + ' repeated route' + (m.repeated_route_count === 1 ? '' : 's') + ' (pattern signal, not proof of intent)'
      : '• Sub-1M clustered flow: none met the 3+ same-route / ≥1M aggregate rule';

    if (/• Mid-size flow \(100K–<1M\):/.test(out)) return out;
    var shadowLine = /(• Shadow volume \(individual observed XRP moves ≥1M\):[^\n]*\n?)/;
    if (shadowLine.test(out)) return out.replace(shadowLine, '$1' + midLine + '\n' + clusterLine + '\n');

    var activityLine = /(• Watched activity \(all sizes\):[^\n]*\n?)/;
    if (activityLine.test(out)) return out.replace(activityLine, '$1' + midLine + '\n' + clusterLine + '\n');
    return out;
  }

  // Install after the existing tone guard, preserving its output and the sealed
  // 4K report hash because this wrapper participates before the report is sealed.
  try {
    if (typeof buildMorningStoryText === 'function' && !buildMorningStoryText._swShadowFlowContext) {
      var originalMorning = buildMorningStoryText;
      var morningWrapped = function (pack) {
        return augmentMorning(originalMorning.apply(this, arguments), pack);
      };
      morningWrapped._swShadowFlowContext = true;
      morningWrapped._swShadowFlowOriginal = originalMorning;
      buildMorningStoryText = morningWrapped;
      window.buildMorningStoryText = morningWrapped;
    }
  } catch (_) {}

  // ── Internal timing ───────────────────────────────────────────
  var timingState = {
    version: VERSION,
    current: null,
    last: null
  };

  function beginRun() {
    var st = stateRef();
    var tw = null;
    try { if (typeof getTxWindow === 'function') tw = getTxWindow(); } catch (_) {}
    var watched = null;
    try { if (typeof getActiveWatchlist === 'function') watched = getActiveWatchlist().length; } catch (_) {}
    var limit = null;
    try {
      var el = document.getElementById('inTxLimit');
      limit = el ? num(el.value) : null;
    } catch (_) {}
    var parallel = null;
    try { if (typeof SCAN_PARALLEL !== 'undefined') parallel = Number(SCAN_PARALLEL); } catch (_) {}

    timingState.current = {
      started_at: new Date().toISOString(),
      started_perf: nowPerf(),
      finished_at: null,
      total_ms: null,
      status: 'RUNNING',
      phase_current: null,
      phase_started_perf: null,
      phases: [],
      context: {
        watched_wallets: watched,
        window_hours: tw && tw.hours != null ? num(tw.hours) : null,
        window_label: tw && tw.label ? String(tw.label) : null,
        custom_window: !!(tw && tw.custom),
        visible_tx_limit: limit,
        parallel: parallel,
        scan_speed_tuning: window.SW_REPORT_SCAN_TUNING_20260816 || null
      },
      scan_id: st && st.scanId ? st.scanId : null
    };
  }

  function phaseTransition(phase, statusText) {
    var r = timingState.current;
    if (!r) return;
    var p = String(phase || 'SCANNING').toUpperCase();
    var t = nowPerf();
    if (r.phase_current === p) return;
    if (r.phase_current && r.phase_started_perf != null) {
      r.phases.push({ phase: r.phase_current, duration_ms: t - r.phase_started_perf, status: r.phase_status || '' });
    }
    r.phase_current = p;
    r.phase_started_perf = t;
    r.phase_status = String(statusText || '');
  }

  function finishRun() {
    var r = timingState.current;
    if (!r) return;
    var t = nowPerf();
    if (r.phase_current && r.phase_started_perf != null) {
      r.phases.push({ phase: r.phase_current, duration_ms: t - r.phase_started_perf, status: r.phase_status || '' });
    }
    r.finished_at = new Date().toISOString();
    r.total_ms = t - r.started_perf;
    try { r.status = document.body.classList.contains('error') ? 'ERROR' : 'COMPLETE'; }
    catch (_) { r.status = 'COMPLETE'; }
    var st = stateRef();
    if (st) {
      r.scan_id = (st.pack && st.pack.scan_id) || st.scanId || r.scan_id || null;
      try { st.internal_run_timing = JSON.parse(JSON.stringify(r)); } catch (_) { st.internal_run_timing = r; }
    }
    timingState.last = r;
    timingState.current = null;
  }

  try {
    if (typeof shadowSay === 'function' && !shadowSay._swRunTimer) {
      var originalShadowSay = shadowSay;
      var shadowSayWrapped = function (status, phase) {
        phaseTransition(phase, status);
        return originalShadowSay.apply(this, arguments);
      };
      shadowSayWrapped._swRunTimer = true;
      shadowSayWrapped._swRunTimerOriginal = originalShadowSay;
      shadowSay = shadowSayWrapped;
      window.shadowSay = shadowSayWrapped;
    }
  } catch (_) {}

  try {
    if (typeof run === 'function' && !run._swRunTimer) {
      var originalRun = run;
      var runWrapped = async function () {
        var st = stateRef();
        if (st && st.scanning) return originalRun.apply(this, arguments);
        beginRun();
        try { return await originalRun.apply(this, arguments); }
        finally { finishRun(); }
      };
      runWrapped._swRunTimer = true;
      runWrapped._swRunTimerOriginal = originalRun;
      run = runWrapped;
      window.run = runWrapped;
      var btn = document.getElementById('scanBtn');
      if (btn) btn.onclick = runWrapped;
    }
  } catch (_) {}

  function timingBlock() {
    var r = timingState.last;
    var st = stateRef();
    if (!r && st && st.internal_run_timing) r = st.internal_run_timing;
    var m = attachMetrics(st && st.pack ? st.pack : null);
    var lines = [];
    lines.push('INTERNAL RUN TIMING / FLOW DIAGNOSTICS');
    lines.push('version: ' + VERSION);
    if (!r) {
      lines.push('timing: no completed instrumented run in this page session');
    } else {
      lines.push('scan_id: ' + (r.scan_id || '—'));
      lines.push('status: ' + (r.status || '—'));
      lines.push('started: ' + (r.started_at || '—'));
      lines.push('finished: ' + (r.finished_at || '—'));
      lines.push('TOTAL RUN: ' + fmtMs(r.total_ms));
      var c = r.context || {};
      lines.push('context: watched=' + (c.watched_wallets == null ? '—' : c.watched_wallets) +
        ' · window=' + (c.window_hours == null ? '—' : c.window_hours + 'h') +
        ' · custom=' + (c.custom_window ? 'yes' : 'no') +
        ' · visible account_tx limit=' + (c.visible_tx_limit == null ? '—' : c.visible_tx_limit) +
        ' · parallel=' + (c.parallel == null ? '—' : 'x' + c.parallel));
      if (c.window_label) lines.push('window label: ' + c.window_label);
      lines.push('PHASES:');
      (r.phases || []).forEach(function (p) {
        lines.push('  ' + String(p.phase || 'UNKNOWN').padEnd(12, ' ') + ' ' + fmtMs(p.duration_ms) + (p.status ? '  · ' + p.status : ''));
      });
    }
    lines.push('');
    lines.push('MID-SIZE / SUB-1M FLOW');
    lines.push('mid-size band: 100K–<1M XRP per unique Payment');
    lines.push('mid-size total: ' + fmtXrp(m.total_xrp) + ' XRP across ' + m.transfer_count + ' hash-deduped transfers');
    lines.push('cluster rule: 3+ same-route mid-size transfers totaling >=1M XRP');
    lines.push('clustered flow: ' + fmtXrp(m.repeated_route_xrp) + ' XRP across ' + m.repeated_route_count + ' repeated routes / ' + m.repeated_route_transfer_count + ' transfers');
    if (m.top_routes && m.top_routes.length) {
      lines.push('top repeated routes:');
      m.top_routes.slice(0, 5).forEach(function (r, i) {
        lines.push('  ' + (i + 1) + '. ' + r.from + ' -> ' + r.to + ' · ' + r.count + ' tx · ' + fmtXrp(r.total_xrp) + ' XRP');
      });
    }
    lines.push('interpretation: clustered flow is a routing/fragmentation signal only; it does not prove concealment, ownership, or intent.');
    return lines.join('\n');
  }

  // TOTAL DEBUG only. The public Morning Report gets only the compact explanatory
  // lines above; exact performance timings remain internal for optimization runs.
  try {
    if (typeof buildShadowWatchDebugFile === 'function' && !buildShadowWatchDebugFile._swRunTimer) {
      var originalDebug = buildShadowWatchDebugFile;
      var debugWrapped = function () {
        var text = String(originalDebug.apply(this, arguments) || '');
        var block = '\n\n============================================================\n' + timingBlock() + '\n============================================================\n';
        var marker = '\n============================================================\nEND OF TOTAL DEBUG FILE';
        if (text.indexOf(marker) >= 0) return text.replace(marker, block + marker);
        return text + block;
      };
      debugWrapped._swRunTimer = true;
      debugWrapped._swRunTimerOriginal = originalDebug;
      buildShadowWatchDebugFile = debugWrapped;
      window.buildShadowWatchDebugFile = debugWrapped;
    }
  } catch (_) {}

  window.SW_SHADOW_FLOW_TIMING_20260816 = {
    version: VERSION,
    report_only: true,
    debug_timing_only: true,
    scanner_network_calls_changed: false,
    concurrency_changed: false,
    lookback_changed: false,
    pagination_changed: false,
    shadow_volume_definition_changed: false,
    mid_size_min_xrp: MID_MIN_XRP,
    mid_size_max_exclusive_xrp: MID_MAX_XRP,
    repeated_route_min_tx: ROUTE_MIN_TX,
    repeated_route_min_xrp: ROUTE_MIN_XRP,
    metrics: midSizeMetrics,
    timing: timingState,
    timingBlock: timingBlock
  };
})();
