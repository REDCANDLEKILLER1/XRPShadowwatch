/* ═══════════════════════════════════════════════════════════════════
   SHADOW WATCH — TX COUNT INTEGRITY PROBE
   2026-08-16

   Diagnostics only. Watches the canonical in-memory transaction array while
   a Report scan is active and records any same-run decrease. This does not
   modify scanner state, dedupe rules, transaction arrays, progress, or XRPL
   requests. It exists to distinguish a true state.txs regression from a
   display/projection counter regression on the next reproduction.
   ═══════════════════════════════════════════════════════════════════ */
(function () {
  'use strict';

  var VERSION = '2026.08.16.1';
  var lastScanning = false;
  var active = null;
  var completed = null;
  var seq = 0;

  function stateRef() {
    try { if (typeof state !== 'undefined' && state) return state; } catch (_) {}
    try { if (window.__SHADOWWATCH_STATE__) return window.__SHADOWWATCH_STATE__; } catch (_) {}
    try { if (window.state) return window.state; } catch (_) {}
    return null;
  }

  function txCount(s) {
    try { return s && Array.isArray(s.txs) ? s.txs.length : 0; } catch (_) { return 0; }
  }

  function scanId(s) {
    try { return s && (s.scanId || s.scan_id || (s.pack && s.pack.scan_id)) || null; } catch (_) { return null; }
  }

  function phase() {
    try {
      if (window.XAI_SCAN_PROGRESS && window.XAI_SCAN_PROGRESS.phase) return String(window.XAI_SCAN_PROGRESS.phase);
    } catch (_) {}
    return null;
  }

  function progressNumbers() {
    var out = {};
    try {
      var p = window.XAI_SCAN_PROGRESS;
      if (!p || typeof p !== 'object') return out;
      Object.keys(p).forEach(function (k) {
        if (!/tx|trans|count|scan|wallet/i.test(k)) return;
        var v = p[k];
        if (typeof v === 'number' && isFinite(v)) out[k] = v;
      });
    } catch (_) {}
    return out;
  }

  function begin(s, n) {
    active = {
      version: VERSION,
      probe_id: 'TXI-' + Date.now().toString(36).toUpperCase() + '-' + (++seq),
      scan_id: scanId(s),
      started_at: new Date().toISOString(),
      completed_at: null,
      initial_count: n,
      current_count: n,
      peak_count: n,
      final_count: null,
      decrease_count: 0,
      total_decrease: 0,
      decreases: [],
      progress_numeric_snapshot_at_peak: {},
      read_only: true
    };
    try { s.tx_count_integrity = active; } catch (_) {}
  }

  function sample(s, n) {
    if (!active) begin(s, n);
    if (!active.scan_id) active.scan_id = scanId(s);

    var previous = Number(active.current_count || 0);
    if (n > Number(active.peak_count || 0)) {
      active.peak_count = n;
      active.progress_numeric_snapshot_at_peak = progressNumbers();
    }
    if (n < previous) {
      active.decrease_count++;
      active.total_decrease += (previous - n);
      active.decreases.push({
        at: new Date().toISOString(),
        from: previous,
        to: n,
        delta: n - previous,
        phase: phase(),
        progress_numeric: progressNumbers()
      });
      if (active.decreases.length > 25) active.decreases.shift();
    }
    active.current_count = n;
    try { s.tx_count_integrity = active; } catch (_) {}
  }

  function finish(s, n) {
    if (!active) return;
    sample(s, n);
    active.final_count = n;
    active.completed_at = new Date().toISOString();
    completed = JSON.parse(JSON.stringify(active));
    try { s.tx_count_integrity = completed; } catch (_) {}
    active = null;
  }

  function publicSnapshot() {
    var row = active || completed;
    return row ? JSON.parse(JSON.stringify(row)) : null;
  }

  setInterval(function () {
    var s = stateRef();
    if (!s) return;
    var scanning = s.scanning === true;
    var n = txCount(s);

    if (scanning && !lastScanning) begin(s, n);
    if (scanning) sample(s, n);
    if (!scanning && lastScanning) finish(s, n);
    lastScanning = scanning;
  }, 100);

  function appendDebug(text) {
    var snap = publicSnapshot();
    if (!snap) return String(text || '');
    var out = String(text || '');
    if (out.indexOf('=== TX COUNT INTEGRITY ===') >= 0) return out;
    var lines = [
      '',
      '=== TX COUNT INTEGRITY ===',
      'Probe: ' + snap.version + ' · read-only',
      'Scan: ' + (snap.scan_id || '—'),
      'Initial state.txs: ' + snap.initial_count,
      'Peak state.txs: ' + snap.peak_count,
      'Final state.txs: ' + (snap.final_count == null ? snap.current_count : snap.final_count),
      'Same-run decreases: ' + snap.decrease_count,
      'Total downward delta: ' + snap.total_decrease
    ];
    if (snap.decreases && snap.decreases.length) {
      snap.decreases.forEach(function (d, i) {
        lines.push('  [' + (i + 1) + '] ' + d.from + ' → ' + d.to + ' (' + d.delta + ') · phase=' + (d.phase || '—') + ' · ' + d.at);
      });
    } else {
      lines.push('  None observed in canonical state.txs during the sampled scan.');
    }
    return out + '\n' + lines.join('\n') + '\n';
  }

  function wrapDebug() {
    var fn = null;
    try { fn = window.buildShadowWatchDebugFile || (typeof buildShadowWatchDebugFile === 'function' ? buildShadowWatchDebugFile : null); } catch (_) {}
    if (typeof fn !== 'function' || fn._swTxCountIntegrity20260816) return typeof fn === 'function';
    var wrapped = function () {
      var text = fn.apply(this, arguments);
      try { return appendDebug(text); } catch (_) { return text; }
    };
    wrapped._swTxCountIntegrity20260816 = true;
    wrapped._swOriginal = fn;
    try { window.buildShadowWatchDebugFile = wrapped; } catch (_) {}
    try { buildShadowWatchDebugFile = wrapped; } catch (_) {}
    return true;
  }

  if (!wrapDebug()) {
    var tries = 0;
    var debugTimer = setInterval(function () {
      tries++;
      if (wrapDebug() || tries > 300) clearInterval(debugTimer);
    }, 100);
  }

  window.SW_TX_COUNT_INTEGRITY_20260816 = {
    installed: true,
    version: VERSION,
    read_only: true,
    get: publicSnapshot,
    appendDebug: appendDebug
  };
})();
