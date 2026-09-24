(function installNewsContextSourceVisibility20260923(){
  'use strict';

  function normalizeSourceName(name) {
    try {
      if (typeof window.normalizeNewsProviderName === 'function') {
        return window.normalizeNewsProviderName(name || '') || name || 'source';
      }
    } catch (_) {}
    return String(name || 'source')
      .replace(/^rss:/i, '')
      .replace(/@self$/i, '')
      .replace(/_/g, ' ')
      .trim() || 'source';
  }

  function contextSources(pack) {
    try {
      var current = window.buildMorningStorySources;
      var base = current && current._original ? current._original : current;
      var srcs = [];
      if (typeof base === 'function') srcs = base(pack) || [];
      else if (typeof window.getNewsSources === 'function') srcs = window.getNewsSources(pack) || [];

      if (typeof window.filterSourcesForReport === 'function') {
        srcs = window.filterSourcesForReport(srcs, { cap: 8 }) || [];
      } else if (typeof window.rankNewsItems === 'function') {
        srcs = window.rankNewsItems(srcs).slice(0, 8);
      }

      var seen = {};
      var cleaned = [];
      (Array.isArray(srcs) ? srcs : []).forEach(function (s) {
        if (!s) return;
        var url = String(s.url || s.link || '').trim();
        var title = String(s.title || s.headline || '').trim();
        var key = (url || '') + '|' + title.toLowerCase();
        if (!url && !title) return;
        if (seen[key]) return;
        seen[key] = true;
        cleaned.push(Object.assign({}, s, { source: normalizeSourceName(s.source || s.name || s.outlet) }));
      });

      var G = window.MORNING_NEWS_GOVERNOR;
      var cleared = !!(G && typeof G.publicSourcesCleared === 'function' && G.publicSourcesCleared(pack));
      if (cleared && G && typeof G.filterClearedSources === 'function') {
        var strict = G.filterClearedSources(cleaned, pack) || [];
        if (strict.length) {
          if (typeof G.dedupeSources === 'function') strict = G.dedupeSources(strict);
          return strict.slice(0, 3);
        }
      }

      return cleaned.slice(0, 8).map(function (s) {
        return Object.assign({}, s, { _context_only: true });
      });
    } catch (_) {
      return [];
    }
  }

  function installSourceBuilder() {
    if (typeof window.buildMorningStorySources !== 'function') return false;
    if (window.buildMorningStorySources._contextVisibility20260923) return true;
    var previous = window.buildMorningStorySources;
    var base = previous._original || previous;
    var wrapped = function (pack) { return contextSources(pack); };
    wrapped._contextVisibility20260923 = true;
    wrapped._original = base;
    wrapped._previous = previous;
    window.buildMorningStorySources = wrapped;
    return true;
  }

  function installDrawerLabel() {
    var MRF = window.MORNING_REPORT_FLOAT;
    if (!MRF || typeof MRF.show !== 'function') return false;
    if (MRF.show._contextVisibility20260923) return true;
    var original = MRF.show;
    var wrapped = function (reportText, sources, pack) {
      var result = original.apply(this, arguments);
      try {
        var list = Array.isArray(sources) ? sources : [];
        var contextOnly = list.some(function (s) { return s && s._context_only === true; });
        if (contextOnly) {
          var root = document.getElementById('morningReportFloat');
          var src = root && root.querySelector('#mrfSources');
          if (src) {
            var title = src.querySelector('.mrf-sources-title');
            if (title) title.textContent = 'CONTEXT SOURCES — NOT USED TO DRIVE THE REPORT';
            if (!src.querySelector('.mrf-context-note')) {
              var note = document.createElement('div');
              note.className = 'mrf-context-note muted';
              note.textContent = 'Fetched successfully. None cleared the Morning News Governor for narrative use.';
              var listEl = src.querySelector('.mrf-sources-list');
              if (listEl) src.insertBefore(note, listEl);
              else src.appendChild(note);
            }
          }
        }
      } catch (_) {}
      return result;
    };
    wrapped._contextVisibility20260923 = true;
    wrapped._original = original;
    MRF.show = wrapped;
    return true;
  }

  function boot() {
    installSourceBuilder();
    installDrawerLabel();
  }

  boot();
  setTimeout(boot, 250);
  setTimeout(boot, 1500);

  window.SW_NEWS_CONTEXT_SOURCE_VISIBILITY_20260923 = {
    version: '2026-09-23',
    contextSources: contextSources,
    reinstall: boot
  };
})();