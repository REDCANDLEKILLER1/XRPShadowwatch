/* 48-coordination-render-20260923.js
 * Patch 2 — coordination report render truth.
 *
 * The structured report is built before saveBlackboxSnapshot(p). Therefore the
 * coordination object captured earlier describes only the previously persisted
 * Brief history. Under five snapshots, core detectCoordination() also omits
 * snapshots_analyzed entirely, which renders as Current: 0.
 *
 * This patch changes the REPORT boundary only:
 *   - persist the current run's compact Brief snapshot before Section 11 renders;
 *   - read Brief history from shadowwatch_blackbox_v34 only;
 *   - recompute coordination from the persisted compact history;
 *   - fail open with COORDINATION_UNAVAILABLE if historical analysis fails;
 *   - leave Outer XRPMAN_BLACKBOX_V2 and transaction evidence untouched.
 */
(function installCoordinationRenderMemory() {
  'use strict';

  var BRIEF_BLACKBOX = 'shadowwatch_blackbox_v34';
  var MAX_SNAPSHOTS = 30;

  function readBriefHistory() {
    try {
      var raw = localStorage.getItem(BRIEF_BLACKBOX);
      if (!raw) return [];
      var rows = JSON.parse(raw);
      return Array.isArray(rows) ? rows : [];
    } catch (_) {
      return [];
    }
  }

  function currentState() {
    try { if (typeof state === 'object' && state) return state; } catch (_) {}
    try { if (window.__SHADOWWATCH_STATE__) return window.__SHADOWWATCH_STATE__; } catch (_) {}
    try { if (window.state) return window.state; } catch (_) {}
    return null;
  }

  function coordinationUnavailable(rows, err) {
    return {
      pairs: [],
      snapshots_analyzed: Array.isArray(rows) ? rows.length : 0,
      unavailable: true,
      reason: 'COORDINATION_UNAVAILABLE',
      summary: 'COORDINATION_UNAVAILABLE' + (err && err.message ? ': ' + err.message : '')
    };
  }

  function saveBeforeRender(p) {
    var guard = window.SW_MEMORY_GUARD;
    if (guard && typeof guard.persistBriefSnapshot === 'function') {
      return guard.persistBriefSnapshot(p);
    }
    if (typeof saveBlackboxSnapshot === 'function') {
      saveBlackboxSnapshot(p);
      return readBriefHistory();
    }
    return readBriefHistory();
  }

  function projectedHistory() {
    // Section 11 must describe what is actually persisted, not a transient
    // "+ current run" projection. The current run is saved before rendering.
    return readBriefHistory();
  }

  function refreshCoordinationForRender(p) {
    var rows = [];
    var coord = null;
    try {
      rows = saveBeforeRender(p);
      var guard = window.SW_MEMORY_GUARD;
      if (guard && typeof guard.refreshCoordination === 'function') {
        coord = guard.refreshCoordination(rows, p);
      } else if (typeof detectCoordination === 'function') {
        coord = detectCoordination(rows);
      }
    } catch (e) {
      coord = coordinationUnavailable(rows, e);
      try { if (typeof log === 'function') log('COORDINATION_UNAVAILABLE: ' + (e && e.message || e)); } catch (_) {}
    }
    if (!coord || typeof coord !== 'object') coord = coordinationUnavailable(rows);
    coord.snapshots_analyzed = rows.length;

    var st = currentState();
    if (st) st.coordination = coord;
    if (p && typeof p === 'object') p.coordination = coord;
    return coord;
  }

  // Public rendering must never turn a memory failure into a failed report.
  if (typeof renderCoordinationMemory === 'function' && !renderCoordinationMemory.__swCoordFailOpen) {
    var originalRenderCoordinationMemory = renderCoordinationMemory;
    renderCoordinationMemory = function (coord) {
      if (coord && coord.unavailable) {
        return {
          lines: ['• COORDINATION_UNAVAILABLE — ' +
            Number(coord.snapshots_analyzed || 0) +
            ' persisted snapshot(s) retained; report sealed without coordination analysis.'],
          gating: null
        };
      }
      try {
        return originalRenderCoordinationMemory(coord);
      } catch (e) {
        return {
          lines: ['• COORDINATION_UNAVAILABLE — coordination analysis could not be rendered.'],
          gating: null
        };
      }
    };
    renderCoordinationMemory.__swCoordFailOpen = true;
    renderCoordinationMemory.__swOriginal = originalRenderCoordinationMemory;
  }

  // Pattern memory is advisory. A bad historical object may withhold that
  // section, but it must not take down the evidence capsule or clear state.txs.
  if (typeof summarizePatternMemory === 'function' && !summarizePatternMemory.__swMemoryFailOpen) {
    var originalSummarizePatternMemory = summarizePatternMemory;
    summarizePatternMemory = function () {
      try {
        return originalSummarizePatternMemory.apply(this, arguments);
      } catch (e) {
        try { if (typeof log === 'function') log('PATTERN_MEMORY_UNAVAILABLE: ' + (e && e.message || e)); } catch (_) {}
        return { lines: ['• PATTERN_MEMORY_UNAVAILABLE — historical comparison skipped for this report.'], snapCount: 0 };
      }
    };
    summarizePatternMemory.__swMemoryFailOpen = true;
    summarizePatternMemory.__swOriginal = originalSummarizePatternMemory;
  }

  if (typeof buildXRPMainReport === 'function' && !buildXRPMainReport.__swCoordRenderTruth) {
    var originalBuildXRPMainReport = buildXRPMainReport;
    var wrapped = function (p) {
      try { refreshCoordinationForRender(p); } catch (_) {}
      return originalBuildXRPMainReport(p);
    };
    wrapped.__swCoordRenderTruth = true;
    wrapped.__swOriginal = originalBuildXRPMainReport;
    buildXRPMainReport = wrapped;
  }

  window.SW_COORDINATION_RENDER_20260923 = {
    version: '2026.09.26.1',
    key: BRIEF_BLACKBOX,
    readBriefHistory: readBriefHistory,
    projectedHistory: projectedHistory,
    refreshCoordinationForRender: refreshCoordinationForRender
  };

  try {
    if (typeof log === 'function') log('[coordination-render] installed');
  } catch (_) {}
})();
