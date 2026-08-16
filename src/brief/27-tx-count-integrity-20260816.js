/* ═══════════════════════════════════════════════════════════════════
   SHADOW WATCH — TX COUNT INTEGRITY PROBE
   2026-08-16

   Diagnostics only. Watches canonical state.txs and records any same-run
   decrease. V2 also fingerprints the peak transaction set incrementally so a
   decrease can report WHICH rows disappeared, without changing scanner state,
   dedupe rules, progress, or XRPL requests.
   ═══════════════════════════════════════════════════════════════════ */
(function () {
  'use strict';

  var VERSION = '2026.08.16.2';
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
  function txRows(s) { try { return s && Array.isArray(s.txs) ? s.txs : []; } catch (_) { return []; } }
  function txCount(s) { return txRows(s).length; }
  function scanId(s) { try { return s && (s.scanId || s.scan_id || (s.pack && s.pack.scan_id)) || null; } catch (_) { return null; } }
  function phase() { try { return window.XAI_SCAN_PROGRESS && window.XAI_SCAN_PROGRESS.phase ? String(window.XAI_SCAN_PROGRESS.phase) : null; } catch (_) { return null; } }

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

  function txHash(t) {
    return String(t && (t.hash || t.tx_hash || t.txid || (t.tx && t.tx.hash)) || '').trim();
  }
  function txKey(t, i) {
    var h = txHash(t);
    if (h) return 'H:' + h;
    var parts = [
      t && (t.date || t.ts || t.timestamp || ''),
      t && (t.type || t.TransactionType || (t.tx && t.tx.TransactionType) || ''),
      t && (t.from || t.Account || (t.tx && t.tx.Account) || ''),
      t && (t.to || t.Destination || (t.tx && t.tx.Destination) || ''),
      t && (t.amount || t.Amount || (t.tx && t.tx.Amount) || ''),
      t && (t.ledger_index || t.ledgerIndex || ''),
      i
    ];
    return 'F:' + parts.join('|');
  }
  function descriptor(t, i) {
    return {
      key: txKey(t, i),
      hash: txHash(t) || null,
      type: String(t && (t.type || t.TransactionType || (t.tx && t.tx.TransactionType)) || 'UNKNOWN'),
      from: String(t && (t.from || t.Account || (t.tx && t.tx.Account)) || ''),
      to: String(t && (t.to || t.Destination || (t.tx && t.tx.Destination)) || ''),
      date: t && (t.date || t.ts || t.timestamp || null),
      ledger_index: t && (t.ledger_index || t.ledgerIndex || null)
    };
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
      peak_count: 0,
      final_count: null,
      decrease_count: 0,
      total_decrease: 0,
      decreases: [],
      progress_numeric_snapshot_at_peak: {},
      removed_analysis: [],
      read_only: true,
      _peakMap: new Map(),
      _peakIndexedTo: 0
    };
    captureGrowth(s, txRows(s));
    try { s.tx_count_integrity = active; } catch (_) {}
  }

  // While the array is growing, index only the newly appended tail. This avoids
  // cloning 40K+ rows every 100ms and therefore avoids creating another UI stall.
  function captureGrowth(s, rows) {
    if (!active) return;
    var n = rows.length;
    if (n <= active.peak_count) return;
    var start = Math.min(active._peakIndexedTo || 0, n);
    for (var i = start; i < n; i++) {
      var d = descriptor(rows[i], i);
      active._peakMap.set(d.key, d);
    }
    active._peakIndexedTo = n;
    active.peak_count = n;
    active.progress_numeric_snapshot_at_peak = progressNumbers();
  }

  function analyzeDecrease(rows, from, to) {
    if (!active || !(active._peakMap instanceof Map)) return null;
    var current = new Set();
    for (var i = 0; i < rows.length; i++) current.add(txKey(rows[i], i));

    var removed = [];
    var byType = {};
    var hashes = 0, withoutHash = 0;
    active._peakMap.forEach(function (d, key) {
      if (current.has(key)) return;
      removed.push(d);
      if (d.hash) hashes++; else withoutHash++;
      byType[d.type] = (byType[d.type] || 0) + 1;
    });

    removed.sort(function (a, b) { return String(a.type).localeCompare(String(b.type)); });
    return {
      from: from,
      to: to,
      expected_delta: from - to,
      removed_fingerprints: removed.length,
      removed_with_hash: hashes,
      removed_without_hash: withoutHash,
      removed_by_type: byType,
      sample: removed.slice(0, 25)
    };
  }

  function sample(s, n) {
    if (!active) begin(s, n);
    if (!active.scan_id) active.scan_id = scanId(s);
    var rows = txRows(s);
    var previous = Number(active.current_count || 0);
    if (n > Number(active.peak_count || 0)) captureGrowth(s, rows);

    if (n < previous) {
      var analysis = analyzeDecrease(rows, previous, n);
      active.decrease_count++;
      active.total_decrease += (previous - n);
      active.decreases.push({
        at: new Date().toISOString(),
        from: previous,
        to: n,
        delta: n - previous,
        phase: phase(),
        progress_numeric: progressNumbers(),
        removed_analysis_index: active.removed_analysis.length
      });
      if (analysis) active.removed_analysis.push(analysis);
      if (active.decreases.length > 25) active.decreases.shift();
      if (active.removed_analysis.length > 10) active.removed_analysis.shift();
    }
    active.current_count = n;
    try { s.tx_count_integrity = active; } catch (_) {}
  }

  function serializable(row) {
    if (!row) return null;
    var out = {};
    Object.keys(row).forEach(function (k) { if (k.charAt(0) !== '_') out[k] = row[k]; });
    return out;
  }

  function finish(s, n) {
    if (!active) return;
    sample(s, n);
    active.final_count = n;
    active.completed_at = new Date().toISOString();
    completed = JSON.parse(JSON.stringify(serializable(active)));
    try { s.tx_count_integrity = completed; } catch (_) {}
    active = null;
  }
  function publicSnapshot() {
    var row = active ? serializable(active) : completed;
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
    (snap.decreases || []).forEach(function (d, i) {
      lines.push('  [' + (i + 1) + '] ' + d.from + ' → ' + d.to + ' (' + d.delta + ') · phase=' + (d.phase || '—') + ' · ' + d.at);
    });
    if (!(snap.decreases || []).length) lines.push('  None observed in canonical state.txs during the sampled scan.');

    (snap.removed_analysis || []).forEach(function (a, i) {
      lines.push('');
      lines.push('REMOVED-ROW ANALYSIS #' + (i + 1));
      lines.push('  Count fingerprinted as removed: ' + a.removed_fingerprints + ' · expected delta: ' + a.expected_delta);
      lines.push('  Removed with tx hash: ' + a.removed_with_hash + ' · without hash/fallback-key: ' + a.removed_without_hash);
      lines.push('  By transaction type: ' + Object.keys(a.removed_by_type || {}).sort().map(function (k) { return k + '=' + a.removed_by_type[k]; }).join(' · '));
      lines.push('  Sample removed rows:');
      (a.sample || []).forEach(function (d) {
        lines.push('    ' + (d.type || 'UNKNOWN') + ' · ' + (d.hash || d.key || '—') + ' · ' + (d.from || '—') + ' → ' + (d.to || '—') + ' · ledger=' + (d.ledger_index || '—') + ' · date=' + (d.date || '—'));
      });
    });
    return out + '\n' + lines.join('\n') + '\n';
  }

  function wrapDebug() {
    var fn = null;
    try { fn = window.buildShadowWatchDebugFile || (typeof buildShadowWatchDebugFile === 'function' ? buildShadowWatchDebugFile : null); } catch (_) {}
    if (typeof fn !== 'function') return false;
    if (fn._swTxCountIntegrity20260816) return true;
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

  var tries = 0;
  var debugTimer = setInterval(function () {
    tries++;
    if (wrapDebug() && tries > 20) clearInterval(debugTimer);
    if (tries > 300) clearInterval(debugTimer);
  }, 100);

  window.SW_TX_COUNT_INTEGRITY_20260816 = {
    installed: true,
    version: VERSION,
    read_only: true,
    get: publicSnapshot,
    appendDebug: appendDebug
  };
})();
