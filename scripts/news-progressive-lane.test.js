#!/usr/bin/env node
/* ── PROGRESSIVE, DEADLINE-BOUNDED NEWS LANE ──────────────────────────────────
   A + B + D from the old PR #24, rebuilt. Every source starts at once, each
   publishes as it lands, and one session deadline below the outer 18s ceiling
   ends the wait.

   The three faults being closed, each proven against the live engine before the
   change:

     A  fetchAllRss awaited Promise.allSettled per batch of 4, so one hanging
        feed held three that had already answered, and every later batch too.
     B  Google News could not start until the FAST tier had fully settled.
     D  The outer 18s Promise.race rejected, but nothing told the work to stop,
        and a late resolution could still write state.newsIntel afterwards.

   HOW THE FIRST VERSION OF THIS SUITE WAS WRONG

   Its A case did `if (window.RSS_FEEDS) { ...install fake feeds... }`. RSS_FEEDS
   is a top-level const — a lexical global, never a window property — so the
   guard was false and the fake feeds were never installed. The case ran seven
   REAL feed names through a 30ms fake and reported [30,31,31,31,62,62,62]ms with
   no hanging peer present at all. It proved nothing.

   Its A case also only checked fetchAllRss's RETURN value, so it could not see
   that a "progressive publish" was building snapshots the landed rows had not
   reached yet. Every case here now asserts against state.newsIntel mid-flight,
   which is the surface the report actually reads.

   WHAT THIS SUITE CAN AND CANNOT PROVE

   It drives the real fetchNewsIntel with the fetchers replaced by controlled
   fakes, so the ORCHESTRATION is measured: real elapsed milliseconds, real
   outstanding-request counts, real publish ordering.

   It cannot prove behaviour against a genuinely slow remote feed — XRPL and the
   news hosts are unreachable from the build sandbox. So "no post-deadline state
   mutation" is proven here against a fake that resolves late by construction,
   which is the property that matters, but the socket-level behaviour of a real
   hung proxy is not exercised. Each request already carries its own
   AbortController and NEWS_ROUTE_TIMEOUT_MS via proxyFetch -> fetchWithTimeout;
   this change does not alter that and does not claim to.

   Run: node scripts/news-progressive-lane.test.js
   Env: SW_TEST_PORT to override the port (default 8261).
──────────────────────────────────────────────────────────────────────────── */
'use strict';

const http = require('http');
const fs   = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const PORT = Number(process.env.SW_TEST_PORT || 8261);
const MIME = { '.html':'text/html', '.js':'text/javascript', '.css':'text/css',
               '.json':'application/json', '.svg':'image/svg+xml', '.png':'image/png' };

function serve() {
  return http.createServer((q, r) => {
    let u = decodeURIComponent(q.url.split('?')[0]);
    if (u === '/') u = '/index.html';
    const f = path.join(ROOT, u);
    if (!f.startsWith(ROOT) || !fs.existsSync(f) || fs.statSync(f).isDirectory()) {
      r.writeHead(404); r.end('not found'); return;
    }
    r.writeHead(200, { 'Content-Type': MIME[path.extname(f)] || 'application/octet-stream' });
    fs.createReadStream(f).pipe(r);
  }).listen(PORT);
}
function chromium() {
  try { return require('playwright').chromium; }
  catch (_) { return require('/opt/node22/lib/node_modules/playwright').chromium; }
}

let pass = 0, fail = 0;
const check = (name, ok, detail) => {
  if (ok) { pass++; console.log('  PASS  ' + name); }
  else { fail++; console.log('  FAIL  ' + name + (detail !== undefined ? '  -> ' + JSON.stringify(detail) : '')); }
};

(async () => {
  const srv = serve();
  const exe = '/opt/pw-browsers/chromium-1194/chrome-linux/chrome';
  const browser = await chromium().launch(
    fs.existsSync(exe) ? { executablePath: exe, args: ['--no-sandbox'] } : { args: ['--no-sandbox'] });
  const page = await browser.newPage();
  const errs = [];
  page.on('pageerror', e => errs.push(e.message));
  await page.route('**/*', r =>
    r.request().url().startsWith('http://127.0.0.1:' + PORT) ? r.continue() : r.abort());
  await page.goto('http://127.0.0.1:' + PORT + '/brief-console.html', { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(10000);

  console.log('PROGRESSIVE NEWS LANE\n');

  const r = await page.evaluate(async () => {
    const out = {};
    // Built through normalizeItem, exactly as the real fetchers do — the
    // snapshot builder consumes normalized items and reads x.categories
    // directly. A hand-rolled literal would not be the shape under test.
    const mk = (src, n) => Array.from({ length: n }, (_, i) => normalizeItem({
      source: src, title: 'XRP Ledger headline ' + src + ' ' + i,
      url: 'https://example.test/' + src + '/' + i,
      published_at: new Date().toISOString()
    }));
    const wait = ms => new Promise(res => setTimeout(res, ms));

    // Neutralise cache and settings so every run actually fetches.
    localStorage.removeItem(NEWS_CACHE_STORE);
    const origSettings = window.loadIntelSettings;
    window.loadIntelSettings = () => ({ intelCacheMinutes: 0, useGdelt: true, timeout: 500 });

    const snapshot = () => ({
      cc: window.fetchCryptoCompare, rss: window.fetchAllRss,
      gd: window.fetchGdelt, gn: window.fetchGoogleNews,
      feeds: window.RSS_FEEDS ? window.RSS_FEEDS.slice() : null
    });
    const restore = o => {
      window.fetchCryptoCompare = o.cc; window.fetchAllRss = o.rss;
      window.fetchGdelt = o.gd; window.fetchGoogleNews = o.gn;
      if (o.feeds && window.RSS_FEEDS) { window.RSS_FEEDS.length = 0; o.feeds.forEach(f => window.RSS_FEEDS.push(f)); }
    };
    const orig = snapshot();

    // ── B: Google must not wait for a hanging RSS lane ───────────────────
    let gnAt = null, t0 = Date.now();
    window.fetchCryptoCompare = async () => { await wait(3000); return mk('cc', 1); };
    window.fetchAllRss        = async () => { await wait(3000); return mk('rss', 1); };
    window.fetchGdelt         = async () => { await wait(3000); return mk('gdelt', 1); };
    window.fetchGoogleNews    = async () => { await wait(40); gnAt = Date.now() - t0; return mk('google', 2); };
    const iB = await fetchNewsIntel(true);
    out.googleStartedEarly = gnAt !== null && gnAt < 1500;
    out.googleAt = gnAt;
    out.bItems = iB.items.length;
    out.bHasGoogle = iB.items.some(x => /google/.test(x.source));
    out.bPublishes = (iB.lane_metrics || {}).progressive_publishes;
    // Real wall clock — this scenario does not stub Date.now.
    out.bElapsed = (iB.lane_metrics || {}).elapsed_ms;
    restore(orig);

    // ── A: a landed feed must reach state.newsIntel while a peer hangs ──
    // Real fetchAllRss, real per-feed callback path, real RSS_FEEDS list.
    // RSS_FEEDS cannot be replaced from here (top-level const), so a REAL feed
    // name is made the slow peer.
    window.fetchOneRss = async (feed) => {
      if (/Bitcoinist/i.test(feed.name)) { await wait(5000); return mk('SLOWPEER', 1); }
      await wait(20); return mk('FASTFEED_' + feed.name, 1);
    };
    window.fetchCryptoCompare = async () => { await wait(5000); return mk('cc', 1); };
    window.fetchGoogleNews    = async () => { await wait(5000); return mk('gn', 1); };
    window.fetchGdelt         = async () => { await wait(5000); return mk('gd', 1); };
    const runA = fetchNewsIntel(true);
    await wait(1200);                       // fast feeds landed; Bitcoinist hanging
    const midA = ((state.newsIntel || {}).items) || [];
    out.rssVisibleMidFlight = midA.some(x => /FASTFEED_/.test(x.source));
    out.midSources = midA.map(x => x.source).slice(0, 6);
    out.slowNotYetIn = !midA.some(x => /SLOWPEER/.test(x.source));
    const iA = await runA;
    out.aFinalHasFast = iA.items.some(x => /FASTFEED_/.test(x.source));
    restore(orig);

    // ── D: deadline, quiesce, no post-deadline mutation ────────────────
    // Drives the REAL fetchAllRss callback path — the previous version stubbed
    // fetchAllRss entirely, so the one route that could write late was the one
    // route it never exercised.
    let lateRssResolved = false;
    // Signal-aware, exactly as the real fetchOneRss -> proxyFetch ->
    // fetchWithTimeout chain now is: it stops when the session aborts.
    let rssSawAbort = 0;
    window.fetchOneRss = async (feed, outerSignal) => {
      if (/Bitcoinist/i.test(feed.name)) {
        for (let i = 0; i < 140; i++) {
          await wait(10);
          if (outerSignal && outerSignal.aborted) { rssSawAbort++; throw new Error('aborted'); }
        }
        lateRssResolved = true; return mk('LATE_RSS', 5);
      }
      await wait(20); return mk('EARLY_' + feed.name, 1);
    };
    window.fetchCryptoCompare = async () => { await wait(20); return mk('cc', 2); };
    window.fetchGoogleNews    = async () => { await wait(20); return mk('gn', 2); };
    window.fetchGdelt         = async () => { await wait(9000); return mk('LATE_GDELT', 9); };
    // Real 600ms budget rather than a stubbed clock, so elapsed_ms below is a
    // genuine measurement and the deadline timer actually fires.
    window.__SW_NEWS_BUDGET_MS__ = 600;
    const iD = await fetchNewsIntel(true);
    delete window.__SW_NEWS_BUDGET_MS__;
    const m = iD.lane_metrics || {};
    out.deadlineHit        = m.deadline_hit === true;
    out.activeAtDeadline   = m.active_at_deadline;
    out.activeAfterAbort   = m.active_after_abort;
    out.quiesced           = m.quiesced === true;
    out.partialSurvived    = iD.items.some(x => /cc|gn|EARLY_/.test(x.source));
    out.noLateItems        = !iD.items.some(x => /LATE_/.test(x.source));
    out.unfinishedNotFailed = (iD.source_status || {}).gdelt === 'DEADLINE_UNFINISHED';
    out.dElapsed = m.elapsed_ms;
    out.dStatuses = iD.source_status;
    out.rssHonouredAbort = rssSawAbort > 0;

    // the real late RSS feed resolves AFTER the lane returned — nothing may move
    const beforeItems = JSON.stringify(((state.newsIntel || {}).items || []).map(x => x.source));
    const beforeCache = localStorage.getItem(NEWS_CACHE_STORE) || '';
    await wait(1600);                       // Bitcoinist resolves in here
    const afterItems = JSON.stringify(((state.newsIntel || {}).items || []).map(x => x.source));
    const afterCache = localStorage.getItem(NEWS_CACHE_STORE) || '';
    out.lateRssSuppressed = !lateRssResolved;   // aborted before it could resolve
    out.stateStable = beforeItems === afterItems;
    out.cacheStable = beforeCache === afterCache;
    out.noLateRssInState = !/LATE_RSS/.test(afterItems);
    restore(orig);

    // ── overlapping sessions: an older run must not overwrite a newer ──
    window.fetchCryptoCompare = async () => { await wait(2500); return mk('SESSION_A', 3); };
    window.fetchAllRss        = async () => { await wait(2500); return mk('SESSION_A', 3); };
    window.fetchGoogleNews    = async () => { await wait(2500); return mk('SESSION_A', 3); };
    window.fetchGdelt         = async () => { await wait(2500); return mk('SESSION_A', 3); };
    const runOld = fetchNewsIntel(true);            // session A — slow
    await wait(150);
    window.fetchCryptoCompare = async () => { await wait(20); return mk('SESSION_B', 4); };
    window.fetchAllRss        = async () => { await wait(20); return mk('SESSION_B', 4); };
    window.fetchGoogleNews    = async () => { await wait(20); return mk('SESSION_B', 4); };
    window.fetchGdelt         = async () => { await wait(20); return mk('SESSION_B', 4); };
    const iNew = await fetchNewsIntel(true);        // session B — fast, wins
    const afterB = JSON.stringify(((state.newsIntel || {}).items || []).map(x => x.source));
    const iOld = await runOld;                      // A finishes last
    const afterA = JSON.stringify(((state.newsIntel || {}).items || []).map(x => x.source));
    out.bWon        = /SESSION_B/.test(afterB);
    out.aDidNotWin  = !/SESSION_A/.test(afterA) && afterA === afterB;
    out.aSuperseded = (iOld.lane_metrics || {}).superseded === true;
    restore(orig);

    // ── zero verified results stay ledger-only ──────────────────────────
    window.fetchCryptoCompare = async () => { throw new Error('down'); };
    window.fetchAllRss        = async () => { throw new Error('down'); };
    window.fetchGdelt         = async () => { throw new Error('down'); };
    window.fetchGoogleNews    = async () => { throw new Error('down'); };
    const iZ = await fetchNewsIntel(true);
    out.zeroItems  = iZ.items.length === 0;
    out.zeroLedger = /Ledger-only|No live headlines/i.test(iZ.summary || '');
    out.zeroNoAll  = !Object.keys(iZ.source_status || {}).some(k => /^all$/i.test(k));
    out.zeroStatuses = iZ.source_status;
    restore(orig);
    window.loadIntelSettings = origSettings;
    return out;
  });

  console.log('  measured: google started at ' + r.googleAt + 'ms while RSS hung 3000ms');
  console.log('  measured: lane elapsed ' + r.bElapsed + 'ms real (slowest source 3000ms), ' +
              r.bPublishes + ' progressive publishes');
  console.log('  mid-flight state.newsIntel while a peer hangs: ' + JSON.stringify(r.midSources));
  console.log('  deadline run (real 600ms budget): elapsed ' + r.dElapsed + 'ms, ' +
              r.activeAtDeadline + ' active at deadline -> ' + r.activeAfterAbort + ' after abort\n');

  console.log('B — Google independent of RSS');
  check('Google starts without waiting for a 3s RSS lane', r.googleStartedEarly, r.googleAt);
  check('Google headlines are in the result', r.bHasGoogle);

  console.log('\nA — a landed feed reaches state.newsIntel while a peer hangs');
  check('fast RSS headline is in state.newsIntel mid-flight', r.rssVisibleMidFlight, r.midSources);
  check('the hanging peer is NOT in it yet', r.slowNotYetIn);
  check('fast RSS headlines survive to the final snapshot', r.aFinalHasFast);

  console.log('\nD — deadline, abort, quiescence, no post-deadline mutation');
  check('deadline fires and is reported', r.deadlineHit);
  check('outstanding requests are counted after the abort, honestly',
        typeof r.activeAfterAbort === 'number' && r.quiesced === (r.activeAfterAbort === 0),
        { atDeadline: r.activeAtDeadline, after: r.activeAfterAbort, quiesced: r.quiesced });
  check('a signal-aware source stops when the session aborts', r.rssHonouredAbort);
  check('partial verified results survive the deadline', r.partialSurvived);
  check('a late result is discarded, not merged', r.noLateItems);
  check('the hanging RSS feed was aborted, not left to resolve', r.lateRssSuppressed);
  check('late RSS does not reach state.newsIntel', r.noLateRssInState);
  check('state is not mutated after the deadline', r.stateStable);
  check('cache is not mutated after the deadline', r.cacheStable);
  check('an unfinished source is UNKNOWN, not FAILED', r.unfinishedNotFailed, r.dStatuses);

  console.log('\noverlapping sessions');
  check('the newer session publishes', r.bWon);
  check('the older session cannot overwrite it', r.aDidNotWin);
  check('the older session reports itself superseded', r.aSuperseded);

  console.log('\nprogressive publication');
  check('more than one publish happened during the run', r.bPublishes > 1, r.bPublishes);

  console.log('\nzero verified results');
  check('no items', r.zeroItems);
  check('summary stays ledger-only', r.zeroLedger);
  check('still no provider named "all"', r.zeroNoAll, r.zeroStatuses);

  check('no page errors', errs.length === 0, errs.slice(0, 3));

  await browser.close(); srv.close();
  console.log('\n' + (fail ? fail + ' FAILED of ' + (pass + fail) : 'ALL ' + pass + ' CHECKS PASS'));
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
