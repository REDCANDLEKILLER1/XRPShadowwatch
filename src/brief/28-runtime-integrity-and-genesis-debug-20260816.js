/* ═══════════════════════════════════════════════════════════════════
   SHADOW WATCH — RUNTIME INTEGRITY + GENESIS DEBUG HANDOFF
   2026-08-17

   Presentation/diagnostics only:
   1) Treat shadow.scan.started as an explicit fresh-run UI boundary. A rerun
      immediately returns the cockpit to 0% / fresh counters instead of leaving
      the prior run's 100%, 240/240, risk and transaction values on screen.
   2) Enforce one-way visible progress inside that run and log any attempted
      rollback. Scanner state is untouched.
   3) Keep Genesis capture internal and append only its compact summary to Total
      Debug. No separate routine Genesis download is required.
   ═══════════════════════════════════════════════════════════════════ */
(function () {
  'use strict';

  var VERSION = '2026.08.17.1';
  var lastScanning = false;
  var maxPct = 0;
  var regressions = [];
  var correcting = false;
  var observer = null;
  var resetGraceUntil = 0;
  var runSequence = 0;
  var lastExplicitResetAt = 0;

  function stateRef() {
    try { if (typeof state !== 'undefined' && state) return state; } catch (_) {}
    try { if (window.__SHADOWWATCH_STATE__) return window.__SHADOWWATCH_STATE__; } catch (_) {}
    try { if (window.state) return window.state; } catch (_) { return null; }
    return null;
  }
  function phase() {
    try { return window.XAI_SCAN_PROGRESS && window.XAI_SCAN_PROGRESS.phase ? String(window.XAI_SCAN_PROGRESS.phase) : '—'; } catch (_) { return '—'; }
  }
  function watchTarget() {
    try { if (typeof getActiveWatchlist === 'function') return getActiveWatchlist().length; } catch (_) {}
    return 240;
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
      if (f) {
        f.style.transition = pct === 0 ? 'none' : '';
        f.style.width = pct + '%';
        if (pct === 0) setTimeout(function () { try { f.style.transition = ''; } catch (_) {} }, 60);
      }
    } catch (_) {}
    setTimeout(function () { correcting = false; }, 0);
  }

  function setText(el, text) { try { if (el) el.textContent = text; } catch (_) {} }
  function resetGauge(card, target) {
    if (!card) return;
    var cap = card.querySelector('.sw-gauge-cap');
    var val = card.querySelector('.sw-gauge-val');
    var label = String(cap && cap.textContent || card.textContent || '').toUpperCase();
    if (label.indexOf('WALLET COVERAGE') >= 0) setText(val, '0 / ' + target);
    else if (label.indexOf('WHALE ACTIVITY') >= 0) setText(val, '00');
    else if (label.indexOf('ACTIVITY RISK') >= 0) setText(val, '— / 100');
    try {
      var arc = card.querySelector('.sw-gauge-arc');
      if (arc) arc.style.strokeDasharray = '0 100';
    } catch (_) {}
  }
  function resetTile(card) {
    if (!card) return;
    var lbl = card.querySelector('.sw-tile-lbl');
    var val = card.querySelector('.sw-tile-val');
    var label = String(lbl && lbl.textContent || '').trim().toUpperCase();
    if (!val) return;
    if (label === 'SHADOW VOLUME') setText(val, '0');
    else if (label === 'NEW TARGETS') setText(val, '0');
    else if (label === 'EVIDENCE') setText(val, '0');
    else if (label === 'LEDGER TX') setText(val, '0');
  }
  function resetStatusCell(cell, target) {
    if (!cell) return;
    var label = String(cell.textContent || '').toUpperCase();
    var val = cell.querySelector('b');
    if (!val) return;
    if (label.indexOf('WALLETS') >= 0) setText(val, '0');
    else if (label.indexOf('QUEUE') >= 0) setText(val, '0');
    else if (label.indexOf('FLAGGED MOVES') >= 0) setText(val, '0');
    else if (label.indexOf('ERRORS') >= 0) setText(val, '0');
    else if (label.indexOf('RISK SCORE') >= 0) setText(val, '— / 100');
    else if (label.indexOf('COVERAGE') >= 0) setText(val, '0 / ' + target);
  }

  function resetCockpitPresentation() {
    var target = watchTarget();
    setVisiblePct(0);
    try {
      var mission = document.querySelector('.xai-mission-progress');
      if (mission) mission.setAttribute('data-mission-state', 'INITIALIZING');
      setText(document.getElementById('xaiMissionStep'), 'INITIALIZING');
      var next = document.querySelector('.xai-mission-next');
      if (next) setText(next, 'NEXT: CONNECTING XRPL');
    } catch (_) {}
    try {
      document.querySelectorAll('.sw-reactor-gauges .sw-gauge').forEach(function (g) { resetGauge(g, target); });
      document.querySelectorAll('#swTiles .sw-tile').forEach(resetTile);
      document.querySelectorAll('#swStatusStrip .sw-scell, .sw-statusstrip .sw-scell').forEach(function (c) { resetStatusCell(c, target); });
      var nf = document.querySelector('.sw-netflow .sw-nf-val');
      if (nf) setText(nf, '—');
    } catch (_) {}
    try {
      var txi = window.SW_TX_COUNT_INTEGRITY_20260816;
      if (txi && typeof txi.repairLedgerTile === 'function') txi.repairLedgerTile(true);
    } catch (_) {}
  }

  function resetForNewRun(source) {
    runSequence++;
    lastExplicitResetAt = Date.now();
    maxPct = 0;
    regressions = [];
    resetGraceUntil = Date.now() + 700;
    var s = stateRef();
    try {
      if (s) {
        s.ui_progress_regressions = [];
        s.ui_run_boundary = { sequence:runSequence, at:new Date().toISOString(), source:source || 'unknown', presentation_reset:true };
      }
    } catch (_) {}

    // 20-ui-responsiveness resets its own monotonic floor on the same event.
    // Ask the existing smoother for zero as well, then hard-set the DOM so its
    // stale 100% cannot remain visible while the new scan initializes.
    try {
      var sm = window.XAI_PROGRESS_SMOOTHER;
      if (sm && typeof sm.setTarget === 'function') sm.setTarget(0);
    } catch (_) {}
    resetCockpitPresentation();

    try {
      var txi = window.SW_TX_COUNT_INTEGRITY_20260816;
      if (txi && typeof txi.resetForNewRun === 'function') txi.resetForNewRun('runtime_integrity:' + (source || 'scan_start'));
    } catch (_) {}
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

    // During the short start boundary, the only acceptable visual is the new
    // run's zero state. This prevents a smoother that still holds the old 100%
    // from immediately repainting the completed run over the fresh scan.
    if (Date.now() < resetGraceUntil) {
      if (visiblePct() !== 0) setVisiblePct(0);
      return;
    }

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
      // Event bus is preferred. This fallback covers a missed/late listener but
      // avoids double-resetting if shadow.scan.started fired moments ago.
      if (Date.now() - lastExplicitResetAt > 500) resetForNewRun('polling_fallback');
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
    return [
      'Capture: ' + (g.version || '—') + ' · read-only · standalone download hidden',
      'Before quality: ' + (g.before_quality || '—') + ' · arm=' + (g.arm_reason || '—') + ' · after=' + (g.after_reason || (after ? 'captured' : 'pending')),
      'Report ID repair: ' + (g.repaired_report_id || '—') + ' · Scan ID repair: ' + (g.repaired_scan_id || '—'),
      'Persistent localStorage keys changed: ' + lsd.length + (lsd.length ? ' · ' + lsd.join(', ') : ''),
      'Persistent sessionStorage keys changed: ' + ssd.length + (ssd.length ? ' · ' + ssd.join(', ') : ''),
      'Workflow: Genesis is captured internally and summarized here; no separate routine Genesis file is required.'
    ];
  }

  function appendDebug(text) {
    var out = String(text || '');
    if (out.indexOf('=== VISIBLE PROGRESS INTEGRITY ===') < 0) {
      var rows = regressions.slice();
      var s = stateRef();
      var boundary = null;
      try { boundary = s && s.ui_run_boundary || null; } catch (_) {}
      out += '\n\n=== VISIBLE PROGRESS INTEGRITY ===\n';
      out += 'Guard: ' + VERSION + ' · presentation only · scanner untouched\n';
      out += 'Run boundary: ' + (boundary ? ('#' + boundary.sequence + ' · ' + boundary.source + ' · reset=' + boundary.presentation_reset) : 'not recorded') + '\n';
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
    if (fn._swRuntimeIntegrityGenesisDebug20260817) return true;
    var wrapped = function () {
      var text = fn.apply(this, arguments);
      try { return appendDebug(text); } catch (_) { return text; }
    };
    wrapped._swRuntimeIntegrityGenesisDebug20260817 = true;
    wrapped._swOriginal = fn;
    wrapped._original = fn._original || fn;
    try { window.buildShadowWatchDebugFile = wrapped; } catch (_) {}
    try { buildShadowWatchDebugFile = wrapped; } catch (_) {}
    return true;
  }

  try {
    var bus = window.SHADOW_EVENT_BUS;
    if (bus && typeof bus.on === 'function') {
      bus.on('shadow.scan.started', function () { resetForNewRun('shadow.scan.started'); });
    }
  } catch (_) {}

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
    resetForNewRun:resetForNewRun,
    appendDebug:appendDebug,
    genesisSummary:genesisSummaryLines
  };
})();