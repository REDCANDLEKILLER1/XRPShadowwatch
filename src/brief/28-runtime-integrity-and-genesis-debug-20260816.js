/* ═══════════════════════════════════════════════════════════════════
   SHADOW WATCH — RUNTIME INTEGRITY + GENESIS DEBUG HANDOFF
   2026-08-16

   Presentation/diagnostics only:
   1) Enforce one-way visible Report progress during an active scan and log any
      attempted rollback (for example 88% -> 66%). Scanner state is untouched.
   2) Remove the standalone Genesis operator control from the normal workflow.
      Genesis capture stays active internally; a compact capture summary is
      appended to TOTAL DEBUG instead of requiring a separate routine download.
   ═══════════════════════════════════════════════════════════════════ */
(function () {
  'use strict';

  var VERSION = '2026.08.16.1';
  var lastScanning = false;
  var maxPct = 0;
  var regressions = [];
  var correcting = false;
  var observer = null;

  function stateRef() {
    try { if (typeof state !== 'undefined' && state) return state; } catch (_) {}
    try { if (window.__SHADOWWATCH_STATE__) return window.__SHADOWWATCH_STATE__; } catch (_) {}
    try { if (window.state) return window.state; } catch (_) { return null; }
    return null;
  }
  function phase() {
    try { return window.XAI_SCAN_PROGRESS && window.XAI_SCAN_PROGRESS.phase ? String(window.XAI_SCAN_PROGRESS.phase) : '—'; } catch (_) { return '—'; }
  }
  function pctNode() { return document.getElementById('xaiMissionPct'); }
  function fillNode() { return document.getElementById('xaiMissionFill'); }
  function parsePctText() {
    var el = pctNode();
    if (!el) return null;
    var m = String(el.textContent || '').match(/(\d+(?:\.\d+)?)\s*%?/);
    if (!m) return null;
    var n = Number(m[1]);
    return isFinite(n) ? Math.max(0, Math.min(100, n)) : null;
  }
  function parseFillPct() {
    var el = fillNode();
    if (!el) return null;
    var raw = String(el.style.width || '');
    var m = raw.match(/(\d+(?:\.\d+)?)%/);
    if (!m) return null;
    var n = Number(m[1]);
    return isFinite(n) ? Math.max(0, Math.min(100, n)) : null;
  }
  function visiblePct() {
    var t = parsePctText();
    var f = parseFillPct();
    if (t == null) return f;
    if (f == null) return t;
    return Math.min(t, f);
  }
  function setVisiblePct(pct) {
    correcting = true;
    try {
      var p = pctNode();
      var f = fillNode();
      if (p) p.textContent = Math.round(pct) + '%';
      if (f) f.style.width = pct + '%';
    } catch (_) {}
    setTimeout(function () { correcting = false; }, 0);
  }
  function recordRegression(from, to) {
    var row = { at:new Date().toISOString(), from:Number(from), to:Number(to), delta:Number(to)-Number(from), phase:phase() };
    regressions.push(row);
    if (regressions.length > 40) regressions.shift();
    var s = stateRef();
    try { if (s) s.ui_progress_regressions = regressions.slice(); } catch (_) {}
  }
  function guardVisibleProgress() {
    if (correcting) return;
    var s = stateRef();
    if (!s || s.scanning !== true) return;
    var now = visiblePct();
    if (now == null) return;
    if (now + 0.01 < maxPct) {
      recordRegression(maxPct, now);
      setVisiblePct(maxPct);
      return;
    }
    if (now > maxPct) maxPct = now;
  }
  function lifecycleTick() {
    var s = stateRef();
    var scanning = !!(s && s.scanning === true);
    if (scanning && !lastScanning) {
      maxPct = 0;
      regressions = [];
      try { s.ui_progress_regressions = []; } catch (_) {}
    }
    if (scanning) guardVisibleProgress();
    if (!scanning && lastScanning && maxPct > 0) {
      try { if (visiblePct() != null && visiblePct() < 99) setVisiblePct(100); } catch (_) {}
    }
    lastScanning = scanning;
  }

  function mountObserver() {
    if (observer || typeof MutationObserver === 'undefined' || !document.documentElement) return;
    observer = new MutationObserver(function () { guardVisibleProgress(); });
    observer.observe(document.documentElement, { subtree:true, childList:true, characterData:true, attributes:true, attributeFilter:['style','class'] });
  }

  function hideGenesisUI() {
    try {
      var el = document.getElementById('swGenesisMasterCapture');
      if (el) el.remove();
    } catch (_) {}
    if (!document.getElementById('sw-hide-genesis-ui-20260816')) {
      var st = document.createElement('style');
      st.id = 'sw-hide-genesis-ui-20260816';
      st.textContent = '#swGenesisMasterCapture{display:none!important;visibility:hidden!important;pointer-events:none!important}';
      (document.head || document.documentElement).appendChild(st);
    }
  }

  function storageDiffKeys(aRows, bRows) {
    var a = {}, b = {}, keys = {};
    (aRows || []).forEach(function (r) { if (r && r.key) a[r.key] = r.fingerprint; });
    (bRows || []).forEach(function (r) { if (r && r.key) b[r.key] = r.fingerprint; });
    Object.keys(a).forEach(function (k) { keys[k] = 1; });
    Object.keys(b).forEach(function (k) { keys[k] = 1; });
    return Object.keys(keys).sort().filter(function (k) { return a[k] !== b[k]; });
  }
  function genesisSummaryLines() {
    var g = null;
    try { g = window.SW_GENESIS_MASTER_20260816 || null; } catch (_) {}
    if (!g) return ['Capture controller: not available'];
    var before = g.before_scan || g.before_page || null;
    var after = g.after_seal || null;
    var preLS = before && before.local_storage || [];
    var postLS = after && after.local_storage || [];
    var preSS = before && before.session_storage || [];
    var postSS = after && after.session_storage || [];
    var lsd = storageDiffKeys(preLS, postLS);
    var ssd = storageDiffKeys(preSS, postSS);
    var lines = [
      'Capture: ' + (g.version || '—') + ' · read-only · standalone download hidden',
      'Before quality: ' + (g.before_quality || '—') + ' · arm=' + (g.arm_reason || '—') + ' · after=' + (g.after_reason || (after ? 'captured' : 'pending')),
      'Report ID repair: ' + (g.repaired_report_id || '—') + ' · Scan ID repair: ' + (g.repaired_scan_id || '—'),
      'Persistent localStorage keys changed: ' + lsd.length + (lsd.length ? ' · ' + lsd.join(', ') : ''),
      'Persistent sessionStorage keys changed: ' + ssd.length + (ssd.length ? ' · ' + ssd.join(', ') : ''),
      'Workflow: Genesis is captured internally and summarized here; no separate routine Genesis file is required.'
    ];
    return lines;
  }

  function appendDebug(text) {
    var out = String(text || '');
    if (out.indexOf('=== VISIBLE PROGRESS INTEGRITY ===') < 0) {
      var rows = regressions.slice();
      out += '\n\n=== VISIBLE PROGRESS INTEGRITY ===\n';
      out += 'Guard: ' + VERSION + ' · presentation only · scanner untouched\n';
      out += 'Highest visible progress observed this scan: ' + Math.round(maxPct) + '%\n';
      out += 'Attempted backwards jumps: ' + rows.length + '\n';
      if (!rows.length) out += '  None observed.\n';
      rows.forEach(function (r, i) {
        out += '  [' + (i + 1) + '] ' + r.from + '% → ' + r.to + '% (' + r.delta + ') · phase=' + r.phase + ' · ' + r.at + '\n';
      });
    }
    if (out.indexOf('=== GENESIS / SHADOW MEMORY CAPTURE ===') < 0) {
      out += '\n=== GENESIS / SHADOW MEMORY CAPTURE ===\n';
      out += genesisSummaryLines().join('\n') + '\n';
    }
    return out;
  }

  function wrapDebug() {
    var fn = null;
    try { fn = window.buildShadowWatchDebugFile || (typeof buildShadowWatchDebugFile === 'function' ? buildShadowWatchDebugFile : null); } catch (_) {}
    if (typeof fn !== 'function') return false;
    if (fn._swRuntimeIntegrityGenesisDebug20260816) return true;
    var wrapped = function () {
      var text = fn.apply(this, arguments);
      try { return appendDebug(text); } catch (_) { return text; }
    };
    wrapped._swRuntimeIntegrityGenesisDebug20260816 = true;
    wrapped._swOriginal = fn;
    try { window.buildShadowWatchDebugFile = wrapped; } catch (_) {}
    try { buildShadowWatchDebugFile = wrapped; } catch (_) {}
    return true;
  }

  mountObserver();
  hideGenesisUI();
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', function () { mountObserver(); hideGenesisUI(); });
  setInterval(function () {
    lifecycleTick();
    hideGenesisUI();
    wrapDebug();
  }, 100);

  window.SW_RUNTIME_INTEGRITY_20260816 = {
    installed:true,
    version:VERSION,
    presentation_only:true,
    scanner_untouched:true,
    getProgressRegressions:function(){ return regressions.slice(); },
    appendDebug:appendDebug,
    genesisSummary:genesisSummaryLines
  };
})();
