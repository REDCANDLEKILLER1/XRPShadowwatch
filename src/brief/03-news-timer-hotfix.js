/* ═══════════════════════════════════════════════════════════════════
   SHADOW WATCH — EARLY REPORT INTEGRITY / LEGACY HOTFIX LAYER
   2026-08-17

   Runs immediately after 02-core. Critical read-only/presentation layers are
   parser-loaded synchronously here so a fast auto-scan cannot outrun Ripple
   escrow installation, report presentation wrappers, TX diagnostics, or the
   visible-progress guard.
   ═══════════════════════════════════════════════════════════════════ */
(function () {
  'use strict';

  // Parser-time blocking load is deliberate here: this external file itself is
  // parser-inserted directly after 02-core. It guarantees the overrides exist
  // before later startup scripts can trigger the Report scan.
  var CRITICAL = [
    '/src/shared/ripple-escrow-registry.js?v=20260816.2',
    '/src/brief/24-genesis-master-capture-20260816.js?v=20260816.4',
    '/src/brief/25-ripple-escrow-position-20260816.js?v=20260816.2',
    '/src/brief/23-public-report-layers-20260816.js?v=20260816.2',
    '/src/brief/26-public-escrow-story-20260816.js?v=20260816.2',
    '/src/brief/33-escrow-terminology-20260819.js?v=20260819.1',
    '/src/brief/27-tx-count-integrity-20260816.js?v=20260817.1',
    '/src/brief/28-runtime-integrity-and-genesis-debug-20260816.js?v=20260817.1',
    '/src/brief/14-report-background-scan-survival.js?v=20260824.1'
  ];

  function fallbackSequential() {
    var i = 0;
    function next() {
      if (i >= CRITICAL.length) return;
      var src = CRITICAL[i++];
      var s = document.createElement('script');
      s.src = src;
      s.async = false;
      s.onload = next;
      s.onerror = function () { try { console.warn('[SW] critical layer failed:', src); } catch (_) {} next(); };
      (document.head || document.documentElement).appendChild(s);
    }
    next();
  }

  try {
    if (document.readyState === 'loading') {
      for (var i = 0; i < CRITICAL.length; i++) {
        document.write('<script src="' + CRITICAL[i] + '"><\/script>');
      }
    } else {
      fallbackSequential();
    }
  } catch (e) {
    try { console.warn('[SW] parser-time critical loader failed; using fallback', e); } catch (_) {}
    fallbackSequential();
  }
})();

/* Legacy news governor + progress narrator repairs. */
(function() {
  'use strict';

  function applyPatches() {
    // FIX 1: governor reads the canonical pack.news_intel.items path.
    try {
      var gov = window.MORNING_NEWS_GOVERNOR;
      if (gov && typeof gov._extractArticles === 'function' && !gov._extractArticles._newsPatchApplied) {
        gov._extractArticles = function(pack) {
          if (!pack) return [];
          if (Array.isArray(pack.news_articles)) return pack.news_articles;
          if (Array.isArray(pack.news_headlines)) return pack.news_headlines;
          if (pack.news_intel) {
            if (Array.isArray(pack.news_intel.items)) return pack.news_intel.items;
            if (Array.isArray(pack.news_intel.top_headlines)) return pack.news_intel.top_headlines;
          }
          if (pack.newsIntel && Array.isArray(pack.newsIntel.headlines)) return pack.newsIntel.headlines;
          if (pack.newsIntel && Array.isArray(pack.newsIntel.articles)) return pack.newsIntel.articles;
          return [];
        };
        gov._extractArticles._newsPatchApplied = true;
      }
    } catch (e) { try { console.warn('[SW-PATCH] governor patch failed:', e); } catch (_) {} }

    // FIX 2: old wallet poller cannot clobber post-wallet phases.
    try {
      var narrator = window.XAI_PROGRESS_NARRATOR;
      if (narrator && typeof narrator._pollWallets === 'function' && !narrator._pollWallets._timerPatchApplied) {
        var originalPoll = narrator._pollWallets.bind(narrator);
        narrator._pollWallets = function() {
          try {
            var postWallet = ['FLOW','NEWS','NEWS_STRONG','NEWS_WEAK','DISCOVERY','REPORTING','SEALED','DONE'];
            var currentPhase = (typeof XAI_SCAN_PROGRESS !== 'undefined' && XAI_SCAN_PROGRESS.phase) || '';
            if (postWallet.indexOf(currentPhase) >= 0) return;
          } catch (_) {}
          originalPoll.apply(this, arguments);
        };
        narrator._pollWallets._timerPatchApplied = true;
      }
    } catch (e) { try { console.warn('[SW-PATCH] wallet-poller patch failed:', e); } catch (_) {} }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', function() { setTimeout(applyPatches, 400); });
  } else setTimeout(applyPatches, 400);
})();

/* Genesis capture adoption/ID repair.
   01-bg-video-autoplay.js owns the true pre-core storage checkpoint. Genesis is
   now an internal debug capture; the separate routine download UI is hidden by
   layer 28. */
(function () {
  'use strict';

  function stateRefGenesis() {
    var s = null;
    try { if (typeof state !== 'undefined' && state) s = state; } catch (_) {}
    try { if (!s && window.__SHADOWWATCH_STATE__) s = window.__SHADOWWATCH_STATE__; } catch (_) {}
    try { if (!s && window.state) s = window.state; } catch (_) {}
    return s;
  }

  function adoptPreCore(api) {
    if (!api || api._precore_adopted) return false;
    var pre = window.SW_GENESIS_PRECORE_20260816;
    if (!pre || !Array.isArray(pre.local_storage)) return false;

    function compactRows(rows) {
      return (rows || []).map(function (r) {
        return { key:r.key, bytes_utf16_approx:r.bytes_utf16_approx, fingerprint:r.fingerprint };
      });
    }

    api.before_page = {
      kind:'BEFORE_PAGE_PRE_CORE',
      captured_at:pre.captured_at,
      page_visibility:(function(){ try { return document.visibilityState || 'unknown'; } catch (_) { return 'unknown'; } })(),
      scanning:false,
      state_meta:{ report_id:null, scan_id:null, app_version:null, tx_count:null, large_count:null, discovery_count:null },
      state_inventory:[],
      persistent_state_inventory:[],
      custom_global_inventory:[],
      local_storage:compactRows(pre.local_storage),
      session_storage:compactRows(pre.session_storage),
      precore_storage_full:{ capture_point:pre.capture_point, read_only:pre.read_only === true, local_storage:pre.local_storage, session_storage:pre.session_storage }
    };
    api.before_quality = 'CLEAN_PRE_SCAN';
    api.arm_reason = '01_pre_core_storage_checkpoint';
    api._precore_adopted = true;
    api.precapture_adopted_at = new Date().toISOString();
    return true;
  }

  function repairGenesisIds(api, s) {
    if (!api) return false;
    var reportId = null, scanId = null, debug = '';
    try { if (typeof window.buildShadowWatchDebugFile === 'function') debug = String(window.buildShadowWatchDebugFile() || ''); } catch (_) {}
    if (debug) {
      var rm = debug.match(/Report ID:\s*(SW-[A-Z0-9-]+)/i) || debug.match(/"report_id"\s*:\s*"(SW-[A-Z0-9-]+)"/i);
      var sm = debug.match(/"scan_id"\s*:\s*"(SC-[A-Z0-9-]+)"/i) || debug.match(/Scan:\s*(SC-[A-Z0-9-]+)/i);
      if (rm) reportId = rm[1];
      if (sm) scanId = sm[1];
    }
    try {
      if (!reportId && s) reportId = s.reportId || s.report_id || (s.pack && s.pack.report_id) || null;
      if (!scanId && s) scanId = s.scanId || s.scan_id || (s.pack && s.pack.scan_id) || null;
    } catch (_) {}
    if (!reportId && !scanId) return false;

    try {
      if (s) { if (reportId) s.reportId = reportId; if (scanId) s.scanId = scanId; }
      if (api.after_seal && api.after_seal.state_meta) {
        if (reportId) api.after_seal.state_meta.report_id = reportId;
        if (scanId) api.after_seal.state_meta.scan_id = scanId;
      }
      if (api.before_scan && api.before_scan.state_meta && scanId) api.before_scan.state_meta.scan_id = scanId;
      api.repaired_report_id = reportId || null;
      api.repaired_scan_id = scanId || null;
      api.ids_repaired_at = new Date().toISOString();
    } catch (_) {}
    return true;
  }

  var sawScan = false;
  var ticks = 0;
  var timer = setInterval(function () {
    ticks++;
    var api = window.SW_GENESIS_MASTER_20260816;
    var s = stateRefGenesis();
    if (api) adoptPreCore(api);
    if (s && s.scanning === true) sawScan = true;

    if (api && sawScan && s && s.scanning !== true) {
      repairGenesisIds(api, s);
      if (!api.after_seal && typeof api.captureAfter === 'function') {
        try { api.captureAfter('scan_end_poll_fallback'); } catch (_) {}
      }
      repairGenesisIds(api, s);
      if (api.after_seal && (api.repaired_report_id || api.repaired_scan_id)) { clearInterval(timer); return; }
    }
    if (api && api.after_seal && s && s.scanning !== true) {
      repairGenesisIds(api, s);
      if (api.repaired_report_id || api.repaired_scan_id) { clearInterval(timer); return; }
    }
    if (ticks > 3600) clearInterval(timer);
  }, 500);
})();
