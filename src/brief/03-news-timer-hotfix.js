/* ═══════════════════════════════════════════════════════════════════
   SHADOW WATCH — DUAL HOTFIX
   v3.32a-patch-news-timer-fix1

   FIX 1: MORNING_NEWS_GOVERNOR._extractArticles wrong property path
          — was looking at pack.newsIntel.headlines, real data is at
            pack.news_intel.items. Governor was getting [] every scan
            and blocking every headline (CLARITY Act, etc.).

   FIX 2: XAI_PROGRESS_NARRATOR._pollWallets clobbers later phases
          — 1200ms poller keeps forcing phase back to WALLET_PROGRESS
            after wallets are done, fighting the SMOOTHER → 69/70
            visual oscillation.
   ═══════════════════════════════════════════════════════════════════ */
(function() {
  'use strict';

  function _applyShadowWatchPatches() {

    // ─── FIX 1 ────────────────────────────────────────────────
    try {
      var gov = window.MORNING_NEWS_GOVERNOR;
      if (gov && typeof gov._extractArticles === 'function'
               && !gov._extractArticles._newsPatchApplied) {

        gov._extractArticles = function(pack) {
          if (!pack) return [];
          if (Array.isArray(pack.news_articles))  return pack.news_articles;
          if (Array.isArray(pack.news_headlines)) return pack.news_headlines;
          if (pack.news_intel) {
            if (Array.isArray(pack.news_intel.items))
              return pack.news_intel.items;
            if (Array.isArray(pack.news_intel.top_headlines))
              return pack.news_intel.top_headlines;
          }
          if (pack.newsIntel && Array.isArray(pack.newsIntel.headlines))
            return pack.newsIntel.headlines;
          if (pack.newsIntel && Array.isArray(pack.newsIntel.articles))
            return pack.newsIntel.articles;
          return [];
        };

        gov._extractArticles._newsPatchApplied = true;
        try { console.log('[SW-PATCH] FIX 1 applied: governor now reads pack.news_intel.items'); } catch (_) {}
      }
    } catch (e) {
      try { console.warn('[SW-PATCH] FIX 1 failed:', e); } catch (_) {}
    }

    // ─── FIX 2 ────────────────────────────────────────────────
    try {
      var narrator = window.XAI_PROGRESS_NARRATOR;
      if (narrator && typeof narrator._pollWallets === 'function'
                   && !narrator._pollWallets._timerPatchApplied) {

        var _origPoll = narrator._pollWallets.bind(narrator);

        narrator._pollWallets = function() {
          try {
            var POST_WALLET = [
              'FLOW','NEWS','NEWS_STRONG','NEWS_WEAK',
              'DISCOVERY','REPORTING','SEALED','DONE'
            ];
            var currentPhase = (typeof XAI_SCAN_PROGRESS !== 'undefined'
                                && XAI_SCAN_PROGRESS.phase) || '';
            if (POST_WALLET.indexOf(currentPhase) >= 0) return;
          } catch (_) {}
          _origPoll.apply(this, arguments);
        };

        narrator._pollWallets._timerPatchApplied = true;
        try { console.log('[SW-PATCH] FIX 2 applied: wallet poller bails after FLOW phase'); } catch (_) {}
      }
    } catch (e) {
      try { console.warn('[SW-PATCH] FIX 2 failed:', e); } catch (_) {}
    }
  }

  /* Wait until helper's own DOMContentLoaded + setTimeout(130) chains
     have defined the targets, then patch with a 400ms cushion. */
  if (typeof document !== 'undefined') {
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', function() {
        setTimeout(_applyShadowWatchPatches, 400);
      });
    } else {
      setTimeout(_applyShadowWatchPatches, 400);
    }
  }

})();

/* Genesis Master capture controller.
   01-bg-video-autoplay.js now takes the true pre-core storage checkpoint.
   This layer adopts that checkpoint, keeps the existing lightweight AFTER
   capture, and repairs Report/Scan IDs from the sealed debug text when the
   runtime state does not expose them directly. No scanner behavior changes. */
(function () {
  try {
    if (!window.SW_GENESIS_MASTER_20260816) {
      var g = document.createElement('script');
      g.src = '/src/brief/24-genesis-master-capture-20260816.js?v=20260816.3';
      g.async = false;
      g.setAttribute('data-sw-genesis-master', '2026-08-16.3');
      (document.head || document.documentElement).appendChild(g);
    }

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
          return {
            key: r.key,
            bytes_utf16_approx: r.bytes_utf16_approx,
            fingerprint: r.fingerprint
          };
        });
      }

      api.before_page = {
        kind: 'BEFORE_PAGE_PRE_CORE',
        captured_at: pre.captured_at,
        page_visibility: (function(){ try { return document.visibilityState || 'unknown'; } catch (_) { return 'unknown'; } })(),
        scanning: false,
        state_meta: { report_id:null, scan_id:null, app_version:null, tx_count:null, large_count:null, discovery_count:null },
        state_inventory: [],
        persistent_state_inventory: [],
        custom_global_inventory: [],
        local_storage: compactRows(pre.local_storage),
        session_storage: compactRows(pre.session_storage),
        precore_storage_full: {
          capture_point: pre.capture_point,
          read_only: pre.read_only === true,
          local_storage: pre.local_storage,
          session_storage: pre.session_storage
        }
      };
      api.before_quality = 'CLEAN_PRE_SCAN';
      api.arm_reason = '01_pre_core_storage_checkpoint';
      api._precore_adopted = true;
      try { if (typeof api.snapshotNow === 'function') api.precapture_adopted_at = new Date().toISOString(); } catch (_) {}
      return true;
    }

    function repairGenesisIds(api, s) {
      if (!api) return false;
      var reportId = null, scanId = null, debug = '';
      try {
        if (typeof window.buildShadowWatchDebugFile === 'function') {
          debug = String(window.buildShadowWatchDebugFile() || '');
        }
      } catch (_) {}
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
        if (s) {
          if (reportId) s.reportId = reportId;
          if (scanId) s.scanId = scanId;
        }
      } catch (_) {}
      try {
        if (api.after_seal && api.after_seal.state_meta) {
          if (reportId) api.after_seal.state_meta.report_id = reportId;
          if (scanId) api.after_seal.state_meta.scan_id = scanId;
        }
        if (api.before_scan && api.before_scan.state_meta) {
          if (scanId) api.before_scan.state_meta.scan_id = scanId;
        }
        api.repaired_report_id = reportId || null;
        api.repaired_scan_id = scanId || null;
        api.ids_repaired_at = new Date().toISOString();
      } catch (_) {}
      return true;
    }

    // Lifecycle fallback: adopt the true pre-core storage snapshot, then if a
    // fast run finishes before Genesis hears shadow.report.sealed, capture the
    // same lightweight AFTER checkpoint. Once sealed, repair export IDs.
    var sawGenesisScan = false;
    var genesisFallbackTicks = 0;
    var genesisFallback = setInterval(function () {
      genesisFallbackTicks++;
      var api = window.SW_GENESIS_MASTER_20260816;
      var s = stateRefGenesis();
      if (api) adoptPreCore(api);
      if (s && s.scanning === true) sawGenesisScan = true;

      if (api && sawGenesisScan && s && s.scanning !== true) {
        repairGenesisIds(api, s);
        if (!api.after_seal && typeof api.captureAfter === 'function') {
          try { api.captureAfter('scan_end_poll_fallback'); } catch (_) {}
        }
        repairGenesisIds(api, s);
        if (api.after_seal && (api.repaired_report_id || api.repaired_scan_id)) {
          clearInterval(genesisFallback);
          return;
        }
      }

      // Also repair IDs if the normal sealed event won the race before polling.
      if (api && api.after_seal && s && s.scanning !== true) {
        repairGenesisIds(api, s);
        if (api.repaired_report_id || api.repaired_scan_id) {
          clearInterval(genesisFallback);
          return;
        }
      }

      if (genesisFallbackTicks > 3600) clearInterval(genesisFallback);
    }, 500);
  } catch (_) {}
})();

/* Early report-integrity loader.
   03 runs immediately after 02-core and before the numbered Report pipeline.
   Start the current-position/public-story/probe layers here instead of waiting
   for the much later dynamic hotfix chain. Later duplicate loaders are safe
   because each layer has its own installation guard. */
(function () {
  'use strict';
  try {
    var queue = [
      { src:'/src/shared/ripple-escrow-registry.js?v=20260816.2', key:'data-sw-early-ripple-registry' },
      { src:'/src/brief/25-ripple-escrow-position-20260816.js?v=20260816.2', key:'data-sw-early-ripple-position' },
      { src:'/src/brief/23-public-report-layers-20260816.js?v=20260816.2', key:'data-sw-early-public-layers' },
      { src:'/src/brief/26-public-escrow-story-20260816.js?v=20260816.1', key:'data-sw-early-public-escrow' },
      { src:'/src/brief/27-tx-count-integrity-20260816.js?v=20260816.1', key:'data-sw-early-tx-integrity' }
    ];
    var i = 0;
    function next() {
      if (i >= queue.length) return;
      var item = queue[i++];
      if (document.querySelector('script[' + item.key + ']')) { next(); return; }
      var s = document.createElement('script');
      s.src = item.src;
      s.async = false;
      s.setAttribute(item.key, '1');
      s.onload = next;
      s.onerror = function () { try { console.warn('[SW] early integrity layer failed:', item.src); } catch (_) {} next(); };
      (document.head || document.documentElement).appendChild(s);
    }
    next();
  } catch (e) {
    try { console.warn('[SW] early report-integrity loader failed:', e); } catch (_) {}
  }
})();
