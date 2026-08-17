/* ═══════════════════════════════════════════════════════════════════════════
   TARGETED NEWS SUPPRESSION BRIDGE — 2026-08-17

   The normal news lane already suppresses GDELT after repeated failures when
   enough healthy sources remain. The later evidence-led query helper used a
   separate direct GDELT path and ignored that governor, potentially retrying
   four known-dead queries sequentially (8s each) after the main feed had
   already decided not to contact GDELT.

   This bridge makes the targeted lane respect the same suppression decision.
   Ledger scanning, evidence generation, risk inputs and existing healthy news
   sources are untouched. Read-only.
   ═══════════════════════════════════════════════════════════════════════════ */
(function () {
  'use strict';

  var VERSION = '2026.08.17.1';

  function suppression() {
    try {
      if (typeof newsSuppression === 'function') return newsSuppression('GDELT') || { suppressed:false };
    } catch (_) {}
    return { suppressed:false };
  }

  function noteSkippedIntents(queryIntents, reason) {
    try {
      var p = (typeof state !== 'undefined' && state && state.pack) ? state.pack : null;
      if (!p) return;
      if (!p.news_intelligence_router) {
        p.news_intelligence_router = {
          generated_at: new Date().toISOString(),
          evidence_triggers: [], query_intents: queryIntents || [],
          searched_queries: [], failed_queries: [], google_news_results: [],
          evidence_results: [], ranked_context: [], source_limits: []
        };
      }
      var r = p.news_intelligence_router;
      if (!Array.isArray(r.source_limits)) r.source_limits = [];
      var row = 'Targeted GDELT skipped — shared source governor suppression active' + (reason ? ': ' + reason : '.');
      if (r.source_limits.indexOf(row) < 0) r.source_limits.push(row);
    } catch (_) {}
  }

  function install() {
    var fn = null;
    try { fn = window.fetchEvidenceLedNews || (typeof fetchEvidenceLedNews === 'function' ? fetchEvidenceLedNews : null); } catch (_) {}
    if (typeof fn !== 'function') return false;
    if (fn._swTargetedNewsSuppression20260817) return true;

    var wrapped = async function (queryIntents, options) {
      var s = suppression();
      if (s && s.suppressed) {
        noteSkippedIntents(queryIntents, s.reason || 'provider suppressed');
        try {
          if (typeof log === 'function') {
            log('Evidence-led GDELT skipped — source governor already suppressed it' +
              (s.nextRetryMin != null ? ' · next probe in ' + s.nextRetryMin + ' min.' : '.'));
          }
        } catch (_) {}
        return [];
      }
      return await fn.apply(this, arguments);
    };
    wrapped._swTargetedNewsSuppression20260817 = true;
    wrapped._swOriginal = fn;

    try { window.fetchEvidenceLedNews = wrapped; } catch (_) {}
    try { fetchEvidenceLedNews = wrapped; } catch (_) {}

    window.SW_TARGETED_NEWS_SUPPRESSION_20260817 = {
      version: VERSION,
      read_only: true,
      respects_shared_gdelt_governor: true,
      ledger_scan_changed: false,
      healthy_news_sources_changed: false
    };
    return true;
  }

  if (!install()) {
    var tries = 0;
    var timer = setInterval(function () {
      tries++;
      if (install() || tries >= 40) clearInterval(timer);
    }, 100);
  }
})();

// P5N3V evidence-backed runtime repair. Loaded last from the active report
// chain so it can normalize GO2/debug behavior without changing the scanner.
(function () {
  try {
    var s = document.createElement('script');
    s.src = '/src/brief/30-p5n3v-runtime-fix-20260817.js?v=20260817.2';
    s.async = false;
    s.setAttribute('data-sw-p5n3v-runtime-fix', '2026-08-17.2');
    document.body.appendChild(s);
  } catch (_) {}
})();
