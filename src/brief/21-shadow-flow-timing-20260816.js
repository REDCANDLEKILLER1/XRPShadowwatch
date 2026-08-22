/* Shadow Volume context + internal run timing — 2026-08-16.
   Report/diagnostic-only. No XRPL calls, pagination, concurrency, lookback,
   evidence scoring, wallet mutation, signing, submit, or trading changes.

   Goals:
   1) Keep Shadow Volume historically stable as individual XRP moves >=1M.
   2) Quantify the established 100K-<1M "mid-size" band separately.
   3) Surface repeated-route, fan-out, and fan-in mid-size clusters without claiming intent.
   4) Record exact run + phase timings in TOTAL DEBUG only.
*/
(function () {
  'use strict';

  var VERSION = '2026.08.16.2';
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

    function ensure(map, key, seed) {
      if (!map.has(key)) map.set(key, Object.assign({ count: 0, total_xrp: 0, keys: [], counterparties: new Set() }, seed || {}));
      return map.get(key);
    }

    var routes = new Map();
    var senders = new Map();
    var receivers = new Map();
    mid.forEach(function (t) {
      var r = ensure(routes, t.from + '>' + t.to, { type: 'REPEATED_ROUTE', from: t.from, to: t.to });
      r.count += 1; r.total_xrp += t.amount; r.keys.push(t.key);

      var so = ensure(senders, t.from, { type: 'FAN_OUT', wallet: t.from });
      so.count += 1; so.total_xrp += t.amount; so.keys.push(t.key); so.counterparties.add(t.to);

      var si = ensure(receivers, t.to, { type: 'FAN_IN', wallet: t.to });
      si.count += 1; si.total_xrp += t.amount; si.keys.push(t.key); si.counterparties.add(t.from);
    });

    var patterns = [];
    var clusteredKeys = new Set();
    function qualify(v, requireMultipleCounterparties) {
      if (v.count < ROUTE_MIN_TX || v.total_xrp < ROUTE_MIN_XRP) return false;
      if (requireMultipleCounterparties && v.counterparties.size < 2) return false;
      return true;
    }
    routes.forEach(function (r) {
      if (!qualify(r, false)) return;
      patterns.push({ type: r.type, from: r.from, to: r.to, count: r.count, total_xrp: r.total_xrp, counterparties: 1 });
      r.keys.forEach(function (k) { clusteredKeys.add(k); });
    });
    senders.forEach(function (r) {
      if (!qualify(r, true)) return;
      patterns.push({ type: r.type, wallet: r.wallet, count: r.count, total_xrp: r.total_xrp, counterparties: r.counterparties.size });
      r.keys.forEach(function (k) { clusteredKeys.add(k); });
    });
    receivers.forEach(function (r) {
      if (!qualify(r, true)) return;
      patterns.push({ type: r.type, wallet: r.wallet, count: r.count, total_xrp: r.total_xrp, counterparties: r.counterparties.size });
      r.keys.forEach(function (k) { clusteredKeys.add(k); });
    });

    patterns.sort(function (a, b) { return b.total_xrp - a.total_xrp; });
    var midTotal = mid.reduce(function (sum, t) { return sum + t.amount; }, 0);
    var clusteredTotal = mid.reduce(function (sum, t) {
      return sum + (clusteredKeys.has(t.key) ? t.amount : 0);
    }, 0);

    return {
      band_min_xrp: MID_MIN_XRP,
      band_max_exclusive_xrp: MID_MAX_XRP,
      transfer_count: mid.length,
      total_xrp: midTotal,
      cluster_pattern_count: patterns.length,
      clustered_transfer_count: clusteredKeys.size,
      clustered_flow_xrp: clusteredTotal,
      repeated_route_count: patterns.filter(function (p) { return p.type === 'REPEATED_ROUTE'; }).length,
      fan_out_count: patterns.filter(function (p) { return p.type === 'FAN_OUT'; }).length,
      fan_in_count: patterns.filter(function (p) { return p.type === 'FAN_IN'; }).length,
      cluster_rule: ROUTE_MIN_TX + '+ mid-size transfers totaling >= ' + ROUTE_MIN_XRP + ' XRP via repeat-route, fan-out, or fan-in behavior',
      top_patterns: patterns.slice(0, 12),
      hash_deduped: true,
      intent_claimed: false
    };
  }

  function uniqueShadowMetrics() {
    var st = stateRef();
    var rows = st && Array.isArray(st.large) ? st.large : [];
    var seen = new Set();
    var unique = [];
    var rawXrp = 0;
    rows.forEach(function (t, idx) {
      var amount = num(t && t.amount);
      if (!(amount >= MID_MAX_XRP)) return;
      rawXrp += amount;
      var key = String((t && t.hash) || '').trim();
      if (!key) key = [t && t.date || '', t && t.from || '', t && t.to || '', amount, idx].join('|');
      if (seen.has(key)) return;
      seen.add(key);
      unique.push({ key: key, amount: amount });
    });
    return {
      raw_record_count: rows.length,
      raw_xrp: rawXrp,
      unique_transfer_count: unique.length,
      unique_xrp: unique.reduce(function (sum, t) { return sum + t.amount; }, 0),
      duplicate_observation_count: Math.max(0, rows.length - unique.length),
      hash_deduped: true,
      public_definition_changed: false
    };
  }

  function attachMetrics(pack) {
    var m = midSizeMetrics();
    if (pack && typeof pack === 'object') {
      pack.mid_size_flow_xrp = m.total_xrp;
      pack.mid_size_transfer_count = m.transfer_count;
      pack.sub_1m_clustered_flow_xrp = m.clustered_flow_xrp;
      pack.sub_1m_cluster_pattern_count = m.cluster_pattern_count;
      pack.sub_1m_clustered_transfer_count = m.clustered_transfer_count;
      pack.mid_size_flow_diagnostic = m;
      pack.shadow_volume_unique_diagnostic = uniqueShadowMetrics();
    }
    return m;
  }

  function augmentMorning(text, pack) {
    var out = String(text == null ? '' : text);
    var m = attachMetrics(pack);

    // Make the long-standing metric self-defining without changing its value.
    out = out.replace(
      /• Shadow volume \(whale moves ≥1M\):/g,
      '• Shadow volume (≥1M XRP move spotlight):'
    );

    if (!m.transfer_count) return out;
    var midLine = '• Mid-size flow (100K–<1M): ' + fmtXrp(m.total_xrp) + ' XRP · ' + m.transfer_count + ' transfers';
    var clusterLine = m.cluster_pattern_count
      ? '• Sub-1M clustered flow: ' + fmtXrp(m.clustered_flow_xrp) + ' XRP · ' + m.clustered_transfer_count + ' transfers matched repeat/fan-in/fan-out patterns (signal only)'
      : '• Sub-1M clustered flow: none met the 3+ transfer / ≥1M aggregate pattern rule';

    if (/• Mid-size flow \(100K–<1M\):/.test(out)) return out;
    var shadowLine = /(• Shadow volume \(≥1M XRP move spotlight\):[^\n]*\n?)/;
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
      morningWrapped._original = originalMorning._original || originalMorning;
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
      shadowSayWrapped._original = originalShadowSay._original || originalShadowSay;
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
      runWrapped._original = originalRun._original || originalRun;
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
    var sh = uniqueShadowMetrics();
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
    lines.push('SHADOW VOLUME AUDIT');
    lines.push('public metric unchanged: observed >=1M XRP transfer records');
    lines.push('legacy/raw shadow: ' + fmtXrp(sh.raw_xrp) + ' XRP across ' + sh.raw_record_count + ' records');
    lines.push('unique-hash shadow check: ' + fmtXrp(sh.unique_xrp) + ' XRP across ' + sh.unique_transfer_count + ' unique transfers · duplicate observations=' + sh.duplicate_observation_count);
    lines.push('note: this audit does not silently rewrite the historical Shadow Volume series.');
    lines.push('');
    lines.push('MID-SIZE / SUB-1M FLOW');
    lines.push('mid-size band: 100K–<1M XRP per unique Payment');
    lines.push('mid-size total: ' + fmtXrp(m.total_xrp) + ' XRP across ' + m.transfer_count + ' hash-deduped transfers');
    lines.push('cluster rule: 3+ mid-size transfers totaling >=1M XRP via repeated route, sender fan-out, or receiver fan-in');
    lines.push('clustered flow: ' + fmtXrp(m.clustered_flow_xrp) + ' XRP across ' + m.clustered_transfer_count + ' unique transfers · patterns=' + m.cluster_pattern_count + ' (route=' + m.repeated_route_count + ', fan-out=' + m.fan_out_count + ', fan-in=' + m.fan_in_count + ')');
    if (m.top_patterns && m.top_patterns.length) {
      lines.push('top qualifying patterns:');
      m.top_patterns.slice(0, 6).forEach(function (r, i) {
        var who = r.type === 'REPEATED_ROUTE' ? (r.from + ' -> ' + r.to) : (r.wallet + ' · counterparties=' + r.counterparties);
        lines.push('  ' + (i + 1) + '. ' + r.type + ' · ' + who + ' · ' + r.count + ' tx · ' + fmtXrp(r.total_xrp) + ' XRP');
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
      debugWrapped._original = originalDebug._original || originalDebug;
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
    cluster_min_tx: ROUTE_MIN_TX,
    cluster_min_xrp: ROUTE_MIN_XRP,
    cluster_modes: ['REPEATED_ROUTE', 'FAN_OUT', 'FAN_IN'],
    metrics: midSizeMetrics,
    uniqueShadowMetrics: uniqueShadowMetrics,
    timing: timingState,
    timingBlock: timingBlock
  };
})();
