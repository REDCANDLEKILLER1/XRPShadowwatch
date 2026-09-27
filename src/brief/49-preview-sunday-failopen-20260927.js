/* 49-preview-sunday-failopen-20260927.js
 * Preview-only long-window fail-open.
 *
 * ULDLY proved the server-owned transaction window first, then lost live XRPL
 * during balance reads. Core correctly refuses to seal an ordinary report when
 * current balances are incomplete. Preview needs a different outcome: keep the
 * stored transaction evidence authoritative and seal a visibly PARTIAL,
 * LEDGER-ONLY report instead of publishing nothing.
 *
 * Read-only: no XRPL writes, no checkpoint writes, no watchlist mutation, and
 * partial reports are deliberately NOT persisted into Brief v34.
 */
(function installPreviewSundayFailOpen() {
  'use strict';

  if (typeof window === 'undefined' || window.SW_PREVIEW_SUNDAY_FAILOPEN_20260927) return;

  function sref() {
    try { if (typeof state === 'object' && state) return state; } catch (_) {}
    try { return window.state || window.__SHADOWWATCH_STATE__ || null; } catch (_) { return null; }
  }

  function evidenceApi() {
    try { return window.SW_EVIDENCE_INDEX || null; } catch (_) { return null; }
  }

  function evidenceMetrics() {
    try {
      var api = evidenceApi();
      return api && typeof api.metrics === 'function' ? api.metrics() : null;
    } catch (_) { return null; }
  }

  function txHours() {
    try {
      if (typeof getTxWindow === 'function') return Number(getTxWindow().hours) || 0;
    } catch (_) {}
    return 0;
  }

  function isPreviewStored() {
    var m = evidenceMetrics();
    return !!(m && m.preview_read_only === true && m.live_acquisition_disabled === true &&
      m.report_window && !m.report_window.error && Number(m.target_wallets || 0) > 0);
  }

  function partialReason() {
    var m = evidenceMetrics() || {};
    var w = m.report_window || {};
    if (m.reason === 'WINDOW_BEYOND_SNAPSHOT' || w.partial_reason === 'WINDOW_BEYOND_SNAPSHOT' ||
        (Array.isArray(w.days_without_shards) && w.days_without_shards.length)) {
      return 'WINDOW_BEYOND_SNAPSHOT';
    }
    return 'PREVIEW_BALANCE_COVERAGE_PARTIAL';
  }

  function balanceCoverage(pack) {
    var rows = pack && Array.isArray(pack.wallet_results) ? pack.wallet_results : [];
    var checked = rows.filter(function (w) { return w && w.status === 'CHECKED'; }).length;
    var failed = rows.filter(function (w) { return w && w.status === 'FAILED'; }).length;
    var invalid = rows.filter(function (w) { return w && w.status === 'INVALID_ADDR'; }).length;
    var pending = Math.max(0, rows.length - checked - failed - invalid);
    return {
      target_wallets: rows.length || Number(pack && pack.watchlist_total || 0),
      current_balance_wallets: checked,
      failed_wallets: failed,
      invalid_wallets: invalid,
      not_read_wallets: pending,
      full_current_balance_coverage: rows.length > 0 && checked === rows.length && failed === 0 && invalid === 0
    };
  }

  function scrubBalanceClaims(text, cov) {
    var out = String(text == null ? '' : text);
    var note = 'Full-board net balance flow WITHHELD — current balance coverage ' +
      cov.current_balance_wallets + '/' + cov.target_wallets + '.';
    out = out.replace(/• Net watched flow:[^\n]*/gi, '• Net watched flow: WITHHELD — partial current-balance coverage.');
    out = out.replace(/while the tracked wallet board (?:gained|lost)[^.]*\./gi,
      'while full-board net balance flow was withheld because current-balance coverage was partial.');
    out = out.replace(/Watchlist flow came in at [^.]*\./gi,
      'Full-board watchlist balance flow was not measured this run.');
    out = out.replace(/Watched wallets are net [^.]*\./gi, note);
    out = out.replace(/Net (?:inflow|outflow) of [^\n]*across \d+ watched wallets[^\n]*/gi,
      'Net watched flow: WITHHELD — partial current-balance coverage.');
    return out;
  }

  function banner(pack, reason, cov) {
    var m = evidenceMetrics() || {};
    var w = m.report_window || {};
    var tx = Number(m.indexed_wallets || 0) + '/' + Number(m.target_wallets || 0);
    var lines = [
      'PARTIAL LEDGER-ONLY REPORT',
      'Reason: ' + reason,
      'Stored transaction evidence: ' + tx + ' wallet proofs from the preview checkpoint.',
      'Current balance coverage: ' + cov.current_balance_wallets + '/' + cov.target_wallets + '. Full-board net balance flow is withheld.',
      'Preview live transaction acquisition remained disabled.'
    ];
    if (reason === 'WINDOW_BEYOND_SNAPSHOT') {
      lines.push('Requested window exceeded available stored snapshot coverage; only the stored ledger window below is claimed.');
      if (Array.isArray(w.days_without_shards) && w.days_without_shards.length) {
        lines.push('Missing stored day shard(s): ' + w.days_without_shards.join(', ') + '.');
      }
    }
    return lines.join('\n');
  }

  async function sealPartialFromFailedPack() {
    var s = sref();
    if (!s || s.seal || !s.failedPack || !isPreviewStored()) return false;

    var p = s.failedPack;
    var cov = balanceCoverage(p);
    if (cov.full_current_balance_coverage && partialReason() !== 'WINDOW_BEYOND_SNAPSHOT') return false;

    var reason = partialReason();
    p.partial_report = {
      sealed: true,
      ledger_only: true,
      reason: reason,
      persist_brief_memory: false,
      generated_at: new Date().toISOString()
    };
    p.balance_scan_coverage = cov;
    p.balance_metrics_usable = false;

    // The ordinary run never reached the post-ledger news stage. Do not reuse a
    // previous run's headlines in a partial recovery.
    s.newsIntel = {
      items: [], top_headlines: [],
      summary: 'NEWS/MACRO CONTEXT — skipped because this preview sealed ledger-only after partial acquisition.',
      sentiment_score: 0, macro_risk_score: 0, regulatory_score: 0,
      banking_stress_score: 0, war_oil_score: 0,
      source_status: {}, lane_incomplete: 'PARTIAL_LEDGER_ONLY'
    };
    p.news_intel = s.newsIntel;
    s.pack = p;

    try {
      if (typeof buildIntelBrief === 'function') {
        s.intelBrief = scrubBalanceClaims(buildIntelBrief(p), cov);
        p.intel_brief = s.intelBrief;
      }
    } catch (_) {}

    var head = banner(p, reason, cov);
    var publicText = '';
    var structured = '';
    var morning = '';
    try { publicText = scrubBalanceClaims(buildPublicReport(p), cov); } catch (_) {}
    try {
      var main = typeof buildXRPMainReport === 'function' ? buildXRPMainReport(p) : '';
      if (typeof finalizeReportPresentation === 'function') main = finalizeReportPresentation(main, p, true);
      structured = scrubBalanceClaims(main, cov);
    } catch (_) {}
    try {
      if (typeof canonicalMorningStory === 'function') {
        morning = scrubBalanceClaims(canonicalMorningStory(p, { rebuild: true }), cov);
      }
    } catch (_) {}

    publicText = head + '\n\n' + publicText;
    structured = head + '\n\n' + structured;
    morning = head + '\n\n' + morning;
    s.morningStoryReport = morning;
    s.structuredReport = structured;

    var bundle = '';
    var seal = null;
    try {
      bundle = typeof buildBundle === 'function' ? buildBundle(p, null) : JSON.stringify(p);
      if (typeof buildEvidenceSeal !== 'function') throw new Error('PARTIAL_SEAL_BUILDER_UNAVAILABLE');
      seal = await buildEvidenceSeal(p, publicText, bundle);
      bundle = typeof buildBundle === 'function' ? buildBundle(p, seal) : bundle;
    } catch (e) {
      try { if (typeof elog === 'function') elog('preview partial seal', e); } catch (_) {}
      return false;
    }

    var master = '';
    try { if (typeof buildMasterPaste === 'function') master = buildMasterPaste(p, publicText, bundle, seal); } catch (_) {}

    function put(id, value) {
      try { var el = document.getElementById(id); if (el) el.textContent = value; } catch (_) {}
    }
    put('report4k', publicText);
    put('mainReport', structured);
    put('agentBox', master);
    put('masterPaste', master);
    put('bundleBox', bundle);
    put('briefBox', s.intelBrief || '');

    // Deliberately no saveBlackboxSnapshot(p): a partial balance run is not a
    // Brief-memory observation. It may be exported and audited, but it does not
    // advance v34 or coordination memory.
    try {
      document.body.classList.remove('scanning', 'building', 'error');
      document.body.classList.add('sealed');
    } catch (_) {}
    try {
      if (typeof shadowSay === 'function') shadowSay('Partial ledger-only report sealed.', 'READY', 100);
      if (typeof log === 'function') log('PARTIAL_SEAL: ' + reason + ' · stored transaction evidence retained · balance flow withheld.');
    } catch (_) {}
    return true;
  }

  // When a long preview window has already received its server-owned evidence,
  // do not spend minutes trying to obtain a second, live full-roster balance
  // snapshot. The ledger report can be sealed without those balance deltas.
  try {
    var api = evidenceApi();
    if (api && typeof api.begin === 'function' && !api.begin.__swSundayFailOpen) {
      var originalBegin = api.begin;
      api.begin = function () {
        var args = arguments;
        return Promise.resolve(originalBegin.apply(this, args)).then(function (ir) {
          var s = sref();
          if (s && isPreviewStored() && txHours() > 48) s._previewLongWindowBalancePhase = true;
          return ir;
        });
      };
      api.begin.__swSundayFailOpen = true;
      api.begin.__swOriginal = originalBegin;
    }
  } catch (_) {}

  try {
    if (typeof xrpl === 'function' && !xrpl.__swSundayFailOpen) {
      var originalXrpl = xrpl;
      xrpl = function (ws, req) {
        var s = sref();
        if (s && s._previewLongWindowBalancePhase === true && req && req.command === 'account_info') {
          return Promise.reject(new Error('PREVIEW_LEDGER_ONLY_BALANCE_SKIPPED'));
        }
        return originalXrpl.apply(this, arguments);
      };
      xrpl.__swSundayFailOpen = true;
      xrpl.__swOriginal = originalXrpl;
    }
  } catch (_) {}

  try {
    if (typeof scanWallets === 'function' && !scanWallets.__swSundayFailOpen) {
      var originalScanWallets = scanWallets;
      scanWallets = async function () {
        try { return await originalScanWallets.apply(this, arguments); }
        finally {
          var s = sref();
          if (s) s._previewLongWindowBalancePhase = false;
        }
      };
      scanWallets.__swSundayFailOpen = true;
      scanWallets.__swOriginal = originalScanWallets;
    }
  } catch (_) {}

  try {
    if (typeof run === 'function' && !run.__swSundayFailOpen) {
      var originalRun = run;
      run = async function () {
        var result = await originalRun.apply(this, arguments);
        try { await sealPartialFromFailedPack(); } catch (_) {}
        return result;
      };
      run.__swSundayFailOpen = true;
      run.__swOriginal = originalRun;
      try { window.run = run; } catch (_) {}
    }
  } catch (_) {}

  window.SW_PREVIEW_SUNDAY_FAILOPEN_20260927 = {
    version: '2026.09.27.1',
    read_only: true,
    partialReason: partialReason,
    balanceCoverage: balanceCoverage,
    scrubBalanceClaims: scrubBalanceClaims,
    sealPartialFromFailedPack: sealPartialFromFailedPack
  };

  try { if (typeof log === 'function') log('[preview-sunday-failopen] installed'); } catch (_) {}
})();
