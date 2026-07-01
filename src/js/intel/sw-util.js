/* ════════════════════════════════════════════════════════════════════
   SW shared intelligence utilities (read-only)
   Namespace: window.SW.*  — loaded before app.js so the engine can use it.
   Provides HTML escaping (injection safety for live XRPL-derived strings)
   and shared caches for labels / token identity / wallet scores.
   ════════════════════════════════════════════════════════════════════ */
(function () {
  'use strict';
  var SW = (window.SW = window.SW || {});

  var MAP = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;', '`': '&#96;' };
  // Escape any live-XRPL-derived text (token/currency names, issuer strings,
  // wallet labels, decoded hex, domains) before it is put into innerHTML.
  SW.escapeHtml = function (s) {
    return String(s == null ? '' : s).replace(/[&<>"'`]/g, function (c) { return MAP[c]; });
  };

  // Shared caches (per-session, in-memory). Read-only enrichment only.
  SW.labelCache = SW.labelCache || {};   // address -> human label
  SW.tokenCache = SW.tokenCache || {};   // "CUR:issuer" -> identity object
  SW.walletCache = SW.walletCache || {}; // address -> wallet score object

  // Small helper: shorten an address for display (never for logic).
  SW.shortAddr = function (a) { a = String(a || ''); return a.length > 12 ? a.slice(0, 6) + '…' + a.slice(-4) : a; };
})();
