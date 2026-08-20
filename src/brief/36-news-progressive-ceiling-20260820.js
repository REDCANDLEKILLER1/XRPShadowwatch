/* ═══════════════════════════════════════════════════════════════════════════
   NEWS PROGRESSIVE CEILING REPAIR — 2026-08-20

   Issue #23: verified headlines must survive a slow RSS route. News work is
   progressive and cancellable; XRPL scanner/evidence/discovery are untouched.
   ═══════════════════════════════════════════════════════════════════════════ */
(function (root, factory) {
  var api = factory(root || {});
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.SW_NEWS_PROGRESSIVE_20260820 = api;
})(typeof window !== 'undefined' ? window : (typeof globalThis !== 'undefined' ? globalThis : this), function (root) {
  'use strict';

  var VERSION = '2026.08.20.1';
  var SESSION_BUDGET_MS = 16500; // finish before the engine's existing 18s outer ceiling
  var QUIESCE_MS = 600;
  var RSS_WORKERS = 3; // + Google + GDELT keeps fallback relay concurrency bounded
  var activeSession = null;

  function abortError(reason) {
    var e = reason instanceof Error ? reason : new Error(reason || 'aborted');
    if (!e.name || e.name === 'Error') e.name = 'AbortError';
    return e;
  }

  function isAbort(e) {
    return !!(e && (e.name === 'AbortError' || /abort|ceiling/i.test(e.message || '')));
  }

  function delay(ms) {
    return new Promise(function (resolve) { setTimeout(resolve, ms); });
  }

  async function runDeadlineTasks(taskFns, budgetMs, quiesceMs, onEmit) {
    var ctrl = new AbortController();
    var items = [];
    var labels = [];
    var active = 0;
    var deadlineHit = false;
    var startedAt = Date.now();
    var timer = null;

    function emit(rows, meta) {
      if (!Array.isArray(rows) || !rows.length) return;
      items.push.apply(items, rows);
      if (meta && meta.label) labels.push(meta.label);
      if (typeof onEmit === 'function') onEmit(rows, meta || {}, items.slice());
    }

    var wrapped = (taskFns || []).map(function (fn) {
      return (async function () {
        active++;
        try { return await fn(ctrl.signal, emit); }
        finally { active--; }
      })();
    });
    var allSettled = Promise.allSettled(wrapped);
    var deadline = new Promise(function (resolve) {
      timer = setTimeout(function () { resolve('deadline'); }, Math.max(1, budgetMs || SESSION_BUDGET_MS));
    });

    var winner = await Promise.race([allSettled.then(function () { return 'done'; }), deadline]);
    if (winner === 'deadline') {
      deadlineHit = true;
      try { ctrl.abort(abortError('news session ceiling reached')); } catch (_) { try { ctrl.abort(); } catch (_) {} }
      await Promise.race([allSettled, delay(Math.max(1, quiesceMs || QUIESCE_MS))]);
    }
    if (timer) clearTimeout(timer);

    return {
      items: items,
      labels: labels,
      deadline_hit: deadlineHit,
      active_after_abort: active,
      elapsed_ms: Date.now() - startedAt,
      aborted: !!ctrl.signal.aborted
    };
  }

  async function fetchWithSessionSignal(url, timeoutMs, signal, session) {
    if (signal && signal.aborted) throw abortError(signal.reason);
    var ctrl = new AbortController();
    var timedOut = false;
    var onAbort = function () { try { ctrl.abort(signal && signal.reason); } catch (_) { ctrl.abort(); } };
    if (signal) signal.addEventListener('abort', onAbort, { once: true });
    var timer = setTimeout(function () {
      timedOut = true;
      try { ctrl.abort(abortError('route timeout')); } catch (_) { ctrl.abort(); }
    }, timeoutMs);
    if (session) session.active_requests++;
    try {
      return await fetch(url, { signal: ctrl.signal, cache: 'no-store' });
    } catch (e) {
      if (signal && signal.aborted) throw abortError(signal.reason);
      if (timedOut) throw new Error('route timeout after ' + timeoutMs + 'ms');
      throw e;
    } finally {
      clearTimeout(timer);
      if (signal) signal.removeEventListener('abort', onAbort);
      if (session) session.active_requests--;
    }
  }

  async function proxyFetchProgressive(targetUrl, timeoutMs, signal, session) {
    var lastErr = null;
    var proxies = (typeof CORS_PROXIES !== 'undefined' && Array.isArray(CORS_PROXIES)) ? CORS_PROXIES : [];
    for (var i = 0; i < proxies.length; i++) {
      if (signal && signal.aborted) throw abortError(signal.reason);
      var proxy = proxies[i];
      try {
        var r = await fetchWithSessionSignal(proxy.build(targetUrl), timeoutMs, signal, session);
        if (r && r.ok) return { response: r, proxy: proxy.name };
        lastErr = new Error(proxy.name + ' HTTP ' + (r ? r.status : 'NO_RESPONSE'));
      } catch (e) {
        if (isAbort(e) && signal && signal.aborted) throw e;
        lastErr = new Error(proxy.name + ' ' + ((e && e.message) || 'failed'));
      }
    }
    throw lastErr || new Error('all news proxies failed');
  }

  function publishSnapshot(allItems, tierStatus, settings, meta) {
    var intel = _buildNewsIntelSnapshot(allItems, tierStatus, settings);
    intel.progressive_news = {
      version: VERSION,
      deadline_hit: !!(meta && meta.deadline_hit),
      active_requests: (meta && meta.active_requests) || 0,
      published_incrementally: true
    };
    state.newsIntel = intel;
    try {
      var box = document.getElementById('newsIntelBox');
      if (box) box.textContent = JSON.stringify(intel, null, 2);
    } catch (_) {}
    return intel;
  }

  function recordAttempt(name, ok) {
    try { if (typeof recordNewsDoctorAttempt === 'function') recordNewsDoctorAttempt(name, !!ok); } catch (_) {}
  }

  function newsLog(msg) {
    try { if (typeof log === 'function') log(msg); } catch (_) {}
  }

  function newsError(prefix, err) {
    if (isAbort(err) && activeSession && activeSession.deadline_hit) return;
    try { if (typeof elog === 'function') elog(prefix, err); } catch (_) {}
  }

  async function fetchRssFeedProgressive(feed, signal, emit, session) {
    try {
      var got = await proxyFetchProgressive(feed.url, NEWS_ROUTE_TIMEOUT_MS, signal, session);
      var xml = await got.response.text();
      if (!xml || xml.length < 50) throw new Error(feed.name + ' empty (' + got.proxy + ')');
      var rows = parseRssXml(xml, feed.name);
      rows.forEach(function (it) { it.source += '@' + got.proxy; });
      if (rows.length) {
        recordAttempt(feed.name, true);
        emit(rows, { label: 'rss:' + feed.name, provider: feed.name });
        return rows;
      }
      throw new Error(feed.name + ' empty (' + got.proxy + ')');
    } catch (e) {
      if (!(isAbort(e) && signal.aborted)) {
        newsError('RSS ' + feed.name + ' failed', e);
        recordAttempt(feed.name, false);
      }
      return [];
    }
  }

  function buildRssWorkerTasks(signalAwareFeeds, session, tierStatus, onRssSuccess) {
    var next = 0;
    var successCount = 0;
    var attempted = 0;
    var workerCount = Math.min(RSS_WORKERS, signalAwareFeeds.length || 0);
    var tasks = [];
    for (var w = 0; w < workerCount; w++) {
      tasks.push(async function (signal, emit) {
        while (!signal.aborted) {
          var idx = next++;
          if (idx >= signalAwareFeeds.length) break;
          attempted++;
          var rows = await fetchRssFeedProgressive(signalAwareFeeds[idx], signal, emit, session);
          if (rows.length) { successCount++; onRssSuccess(); }
        }
        return [];
      });
    }
    tasks._rssState = function () { return { success: successCount, attempted: attempted }; };
    return tasks;
  }

  async function fetchCryptoProgressive(signal, emit, session) {
    var key = '';
    try { key = ((document.getElementById('inCpKey') || {}).value || '').trim(); } catch (_) {}
    if (!key) return [];
    var urls = [
      'https://min-api.cryptocompare.com/data/v2/news/?lang=EN&categories=XRP,Regulation,Trading,Exchange,Blockchain&excludeCategories=Sponsored&api_key=' + encodeURIComponent(key),
      'https://min-api.cryptocompare.com/data/v2/news/?lang=EN&excludeCategories=Sponsored&api_key=' + encodeURIComponent(key)
    ];
    var all = [];
    for (var i = 0; i < urls.length && !signal.aborted; i++) {
      try {
        var r = await fetchWithSessionSignal(urls[i], NEWS_ROUTE_TIMEOUT_MS, signal, session);
        if (!r.ok) throw new Error('HTTP ' + r.status);
        var j = await r.json();
        var data = j.Data || j.data || j.Articles || j.articles || j;
        if (!Array.isArray(data)) throw new Error('unexpected response shape');
        var rows = data.filter(function (x) { return x && x.title; }).map(function (x) {
          return normalizeItem({
            source: 'cryptocompare:' + ((x.source_info && x.source_info.name) || x.source || 'cc'),
            title: x.title,
            url: x.url || x.guid || '',
            published_at: x.published_on ? new Date(x.published_on * 1000).toISOString() : '',
            domain: (x.source_info && x.source_info.name) || ''
          });
        });
        if (rows.length) { all.push.apply(all, rows); emit(rows, { label: 'cryptocompare', provider: 'CryptoCompare' }); }
        if (all.length >= 20) break;
      } catch (e) {
        if (!(isAbort(e) && signal.aborted)) newsError('CryptoCompare failed', e);
      }
    }
    return all;
  }

  async function fetchGoogleProgressive(signal, emit, session) {
    if (typeof isProviderSessionDisabled === 'function' && isProviderSessionDisabled('Google News')) return [];
    var q = '(XRP OR Ripple OR XRPL OR RLUSD) (ETF OR Clarity OR Japan OR SBI OR banking OR custody OR partnership OR ruling)';
    var rssUrl = 'https://news.google.com/rss/search?' + new URLSearchParams({ q: q, hl: 'en-US', gl: 'US', ceid: 'US:en' });
    try {
      var got = await proxyFetchProgressive(rssUrl, NEWS_ROUTE_TIMEOUT_MS, signal, session);
      var xml = await got.response.text();
      var doc = new DOMParser().parseFromString(xml, 'text/xml');
      var rows = Array.from(doc.querySelectorAll('item')).map(function (it) {
        return normalizeItem({
          source: 'google_news@' + got.proxy,
          title: (it.querySelector('title') && it.querySelector('title').textContent || '').replace(/\s+-\s+[^-]+$/, ''),
          url: (it.querySelector('link') && it.querySelector('link').textContent) || '',
          published_at: (it.querySelector('pubDate') && it.querySelector('pubDate').textContent) || '',
          domain: (it.querySelector('source') && it.querySelector('source').textContent) || ''
        });
      }).filter(function (x) { return x.title; });
      recordAttempt('Google News', rows.length > 0);
      if (rows.length) emit(rows, { label: 'google_news', provider: 'Google News' });
      return rows;
    } catch (e) {
      if (!(isAbort(e) && signal.aborted)) {
        newsError('Google News failed', e);
        recordAttempt('Google News', false);
      }
      return [];
    }
  }

  async function fetchGdeltProgressive(settings, signal, emit, session) {
    var sup = (typeof newsSuppression === 'function') ? newsSuppression('GDELT') : { suppressed: false };
    try { state.newsSuppression = { GDELT: sup }; } catch (_) {}
    if (sup && sup.suppressed) return { rows: [], suppressed: true };
    if (typeof isProviderSessionDisabled === 'function' && isProviderSessionDisabled('GDELT')) return { rows: [], suppressed: true };
    var queries = (typeof GDELT_QUERIES !== 'undefined' ? GDELT_QUERIES : []).slice(0, 4);
    var rowsAll = [];
    var anySuccess = false;
    for (var i = 0; i < queries.length && !signal.aborted; i++) {
      try {
        var got = await proxyFetchProgressive(gdeltUrl(queries[i], settings).toString(), 5000, signal, session);
        var j = await got.response.json();
        var raw = j.articles || [];
        var rows = raw.filter(function (x) { return x && x.title; }).map(function (x) {
          return normalizeItem({ source: 'gdelt@' + got.proxy, title: x.title, url: x.url || '', published_at: x.seendate || '', domain: x.domain || '' });
        });
        if (rows.length) {
          anySuccess = true;
          rowsAll.push.apply(rowsAll, rows);
          emit(rows, { label: 'gdelt', provider: 'GDELT' });
        }
      } catch (e) {
        if (!(isAbort(e) && signal.aborted)) newsError('GDELT failed: ' + String(queries[i]).slice(0, 40), e);
        break;
      }
    }
    if (!signal.aborted) recordAttempt('GDELT', anySuccess);
    return { rows: rowsAll, suppressed: false };
  }

  function updateHud(intel) {
    try {
      var cnt = (intel.top_headlines || []).length;
      if (typeof setText === 'function') setText('hudNewsCount', cnt);
      var nb = document.getElementById('hudNewsBadge');
      if (nb) {
        var groups = Object.keys(intel.source_breakdown || {}).length;
        nb.textContent = cnt ? groups + ' SRCS' : 'NO FEED';
        nb.className = 'panel-badge ' + (cnt ? 'ok' : 'warn');
      }
    } catch (_) {}
  }

  async function progressiveFetchNewsIntel(forceRefresh) {
    var settings = loadIntelSettings(false);
    var cacheMin = Number(settings.intelCacheMinutes) || 30;
    if (!forceRefresh) {
      try {
        var c = JSON.parse(localStorage.getItem(NEWS_CACHE_STORE) || 'null');
        if (c && c.top_headlines && c.top_headlines.length && (Date.now() - new Date(c.generated_at).getTime()) < cacheMin * 60000) {
          state.newsIntel = c;
          updateHud(c);
          return c;
        }
      } catch (_) {}
    }

    if (activeSession && activeSession.controller && !activeSession.controller.signal.aborted) {
      try { activeSession.controller.abort(abortError('superseded news session')); } catch (_) {}
    }

    var tierStatus = { cryptocompare: 'PENDING', rss_feeds: 'PENDING', gdelt: 'PENDING', google_news: 'PENDING' };
    var allItems = [];
    var session = { started_at: new Date().toISOString(), active_requests: 0, deadline_hit: false, progressive_publishes: 0 };
    activeSession = session;

    function publish(rows, meta, total) {
      allItems = total.slice();
      session.progressive_publishes++;
      publishSnapshot(allItems, tierStatus, settings, session);
      if (meta && meta.provider) newsLog('News source landed: ' + meta.provider + ' (' + rows.length + ' items).');
    }

    var feeds = RSS_FEEDS.filter(function (f) {
      if (f.disabled_by_default) return false;
      if (typeof isProviderSessionDisabled === 'function' && isProviderSessionDisabled(f.name)) return false;
      return true;
    });
    var rssSucceeded = 0;
    var rssTasks = buildRssWorkerTasks(feeds, session, tierStatus, function () { rssSucceeded++; tierStatus.rss_feeds = 'OK'; });

    var cryptoTask = async function (signal, emit) {
      var rows = await fetchCryptoProgressive(signal, emit, session);
      tierStatus.cryptocompare = rows.length ? 'OK' : 'EMPTY';
      return rows;
    };
    var googleTask = async function (signal, emit) {
      var rows = await fetchGoogleProgressive(signal, emit, session);
      tierStatus.google_news = rows.length ? 'OK' : (signal.aborted ? 'CEILING_ABORTED' : 'FAILED');
      return rows;
    };
    var gdeltTask = async function (signal, emit) {
      var result = await fetchGdeltProgressive(settings, signal, emit, session);
      tierStatus.gdelt = result.suppressed ? 'SUPPRESSED' : (result.rows.length ? 'OK' : (signal.aborted ? 'CEILING_ABORTED' : 'FAILED'));
      return result.rows;
    };

    // Google News is started independently of RSS; slow RSS can no longer gate it.
    var taskFns = [cryptoTask, googleTask, gdeltTask].concat(rssTasks);
    var run = await runDeadlineTasks(taskFns, SESSION_BUDGET_MS, QUIESCE_MS, publish);
    session.deadline_hit = run.deadline_hit;
    session.active_after_abort = run.active_after_abort;
    session.elapsed_ms = run.elapsed_ms;
    allItems = run.items.slice();

    if (rssSucceeded === 0) tierStatus.rss_feeds = run.deadline_hit ? 'CEILING_ABORTED' : 'FAILED';
    if (run.deadline_hit) {
      Object.keys(tierStatus).forEach(function (k) { if (tierStatus[k] === 'PENDING') tierStatus[k] = 'CEILING_ABORTED'; });
      newsLog('News progressive ceiling reached — preserving ' + allItems.length + ' verified items and cancelling outstanding news routes.');
    }

    var intel = publishSnapshot(allItems, tierStatus, settings, session);
    intel.progressive_news.active_after_abort = run.active_after_abort;
    intel.progressive_news.elapsed_ms = run.elapsed_ms;
    intel.progressive_news.quiesced = run.active_after_abort === 0;
    intel.progressive_news.labels = run.labels.slice();

    if (!intel.items.length) {
      intel.summary = 'NEWS/MACRO CONTEXT — No live headlines from any verified source. Ledger-only report mode active.';
    }

    try {
      if (intel.top_headlines && intel.top_headlines.length) localStorage.setItem(NEWS_CACHE_STORE, JSON.stringify(intel));
    } catch (_) {}
    updateHud(intel);
    state.newsIntel = intel;
    activeSession = null;
    return intel;
  }

  function sanitizeNewsIntelForDiagnostics(newsIntel) {
    var ni = newsIntel || {};
    if (!ni.source_status || !Object.prototype.hasOwnProperty.call(ni.source_status, 'all')) return ni;
    var clone = Object.assign({}, ni, { source_status: Object.assign({}, ni.source_status) });
    delete clone.source_status.all;
    return clone;
  }

  function installDiagnosticsGuard() {
    var original = null;
    try { original = buildNewsRouteDiagnostics; } catch (_) {}
    if (typeof original !== 'function' || original._swNewsProviderGuard20260820) return false;
    var wrapped = function (errorLogText, newsDebug, newsIntel) {
      var ni = newsIntel || ((typeof state !== 'undefined' && state && state.newsIntel) ? state.newsIntel : {});
      return original(errorLogText, newsDebug, sanitizeNewsIntelForDiagnostics(ni));
    };
    wrapped._swNewsProviderGuard20260820 = true;
    wrapped._original = original;
    try { buildNewsRouteDiagnostics = wrapped; } catch (_) {}
    try { root.buildNewsRouteDiagnostics = wrapped; } catch (_) {}
    return true;
  }

  function install() {
    var old = null;
    try { old = fetchNewsIntel; } catch (_) {}
    if (old && old._swProgressiveNews20260820) return true;
    progressiveFetchNewsIntel._swProgressiveNews20260820 = true;
    progressiveFetchNewsIntel._original = old || null;
    try { fetchNewsIntel = progressiveFetchNewsIntel; } catch (_) {}
    try { root.fetchNewsIntel = progressiveFetchNewsIntel; } catch (_) {}
    installDiagnosticsGuard();
    return true;
  }

  if (root && root.document) install();

  return {
    version: VERSION,
    read_only: true,
    news_only: true,
    session_budget_ms: SESSION_BUDGET_MS,
    quiesce_ms: QUIESCE_MS,
    runDeadlineTasks: runDeadlineTasks,
    sanitizeNewsIntelForDiagnostics: sanitizeNewsIntelForDiagnostics,
    build: progressiveFetchNewsIntel,
    install: install,
    scanner_changed: false,
    tx_window_changed: false,
    evidence_grading_changed: false,
    discovery_changed: false
  };
});
