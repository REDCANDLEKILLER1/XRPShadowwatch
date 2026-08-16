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

/* Genesis Master capture is loaded here, deliberately early in the numbered
   Report chain. It snapshots local/persistent state before the normal auto-run
   begins, then waits for SHADOW_EVENT_BUS to capture the sealed AFTER state. */
(function () {
  try {
    if (window.SW_GENESIS_MASTER_20260816) return;
    var g = document.createElement('script');
    g.src = '/src/brief/24-genesis-master-capture-20260816.js?v=20260816.1';
    g.async = false;
    g.setAttribute('data-sw-genesis-master', '2026-08-16.1');
    (document.head || document.documentElement).appendChild(g);
  } catch (_) {}
})();
