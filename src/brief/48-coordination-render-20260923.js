/* 48-coordination-render-20260923.js
 * Patch 2 — coordination report render truth.
 *
 * The structured report is built before saveBlackboxSnapshot(p). Therefore the
 * coordination object captured earlier describes only the previously persisted
 * Brief history. Under five snapshots, core detectCoordination() also omits
 * snapshots_analyzed entirely, which renders as Current: 0.
 *
 * This patch changes the REPORT boundary only:
 *   - read Brief history from shadowwatch_blackbox_v34 only;
 *   - add the current pack as a transient (not persisted) snapshot;
 *   - recompute coordination for the report/panel from that projected history;
 *   - leave persistence and Outer XRPMAN_BLACKBOX_V2 untouched.
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

  function compactCurrentSnapshot(p) {
    var s = currentState() || {};
    p = p || {};
    return {
      ts: Date.now(),
      date: p.date,
      data_as_of_utc: p.data_as_of_utc,
      xrp_price: p.xrp_price,
      xrp_delta_24h_pct: p.xrp_delta_24h_pct,
      wallets: (p.wallet_results || p.wallets || []).map(function (w) {
        return {
          label: w && w.label,
          address: w && w.address,
          balance_xrp: w && w.balance_xrp,
          delta_xrp: w && w.delta_xrp
        };
      }),
      large_transfers: (p.large_transfers || []).map(function (t) {
        return {
          from: t && t.from,
          to: t && t.to,
          sender_label: t && t.sender_label,
          receiver_label: t && t.receiver_label,
          amount: t && t.amount,
          classification: t && t.classification,
          hash: t && t.hash,
          date: t && t.date
        };
      }),
      offers: (s.offers || []).map(function (o) {
        return {
          owner: o && o.owner,
          label: o && o.label,
          side: o && o.side,
          direction: o && o.direction,
          xrp_amount: o && o.xrp_amount,
          xrp_price_usd: o && o.xrp_price_usd,
          is_stable_pair: o && o.is_stable_pair
        };
      })
    };
  }

  function projectedHistory(p) {
    var rows = readBriefHistory().slice();
    // The report is rendered before core persists this run. Include this run
    // transiently so "Current" describes the report being rendered.
    rows.push(compactCurrentSnapshot(p));
    if (rows.length > MAX_SNAPSHOTS) rows = rows.slice(rows.length - MAX_SNAPSHOTS);
    return rows;
  }

  function refreshCoordinationForRender(p) {
    if (typeof detectCoordination !== 'function') return null;
    var rows = projectedHistory(p);
    var coord = detectCoordination(rows);
    if (!coord || typeof coord !== 'object') coord = { pairs: [] };
    // Core's <5 branch omits this field. The report contract requires it.
    coord.snapshots_analyzed = rows.length;

    var s = currentState();
    if (s) {
      s.coordination = coord;
      // Transient only: do not replace s.blackbox with the projected row.
    }
    if (p && typeof p === 'object') p.coordination = coord;
    return coord;
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
    version: '2026.09.23.1',
    key: BRIEF_BLACKBOX,
    readBriefHistory: readBriefHistory,
    projectedHistory: projectedHistory,
    refreshCoordinationForRender: refreshCoordinationForRender
  };

  try {
    if (typeof log === 'function') log('[coordination-render] installed');
  } catch (_) {}
})();
