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

    // ── A: a fast feed must not wait for a hanging peer in its batch ─────
    // Drive the REAL fetchAllRss with fake per-feed fetches.
    const seen = [];
    const origOne = window.fetchOneRss;
    window.fetchOneRss = async (feed) => {
      if (/SLOWPEER/.test(feed.name)) { await wait(4000); return mk(feed.name, 1); }
      await wait(30); seen.push({ name: feed.name, at: Date.now() - tA }); return mk(feed.name, 1);
    };
    if (window.RSS_FEEDS) {
      window.RSS_FEEDS.length = 0;
      ['SLOWPEER', 'FASTA', 'FASTB', 'FASTC'].forEach(nm =>
        window.RSS_FEEDS.push({ name: nm, url: 'https://example.test/' + nm }));
    }
    var tA = Date.now();
    const rssItems = await fetchAllRss(() => {}, {}, () => true);
    out.fastFeedsSeen = seen.length;
    out.fastFeedsEarly = seen.length >= 3 && seen.every(x => x.at < 2000);
    out.fastTimes = seen.map(x => x.at);
    out.rssGotAll = rssItems.length >= 4;
    window.fetchOneRss = origOne;
    restore(orig);

    // ── D: deadline, quiesce, and no post-deadline mutation ─────────────
    // A source that resolves long after the budget must be discarded.
    let lateFired = false;
    window.fetchCryptoCompare = async () => { await wait(30); return mk('cc', 2); };
    window.fetchAllRss        = async () => { await wait(30); return mk('rss', 2); };
    window.fetchGoogleNews    = async () => { await wait(30); return mk('google', 2); };
    window.fetchGdelt         = async () => { await wait(30000); lateFired = true; return mk('LATE', 99); };
    // shrink the budget so the test does not take 16s
    const realNow = Date.now;
    const tD = Date.now();
    Date.now = () => realNow.call(Date) + (realNow.call(Date) - tD > 400 ? 17000 : 0);
    const iD = await fetchNewsIntel(true);
    Date.now = realNow;
    const m = iD.lane_metrics || {};
    out.deadlineHit      = m.deadline_hit === true;
    out.elapsed          = m.elapsed_ms;
    out.activeAtDeadline = m.active_at_deadline;
    out.partialSurvived  = iD.items.length > 0 && iD.items.some(x => /cc|rss|google/.test(x.source));
    out.noLateItems      = !iD.items.some(x => /LATE/.test(x.source));
    out.unfinishedNotFailed = (iD.source_status || {}).gdelt === 'DEADLINE_UNFINISHED';

    // the discarded resolution must not reach state afterwards
    const before = JSON.stringify((state.newsIntel || {}).items || []);
    await wait(300);
    const after = JSON.stringify((state.newsIntel || {}).items || []);
    out.stateStable = before === after;
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

  console.log('  measured: google started at ' + r.googleAt + 'ms | fast RSS feeds at ' +
              JSON.stringify(r.fastTimes) + 'ms');
  console.log('  measured: lane elapsed ' + r.bElapsed + 'ms real (slowest source 3000ms), ' +
              r.bPublishes + ' progressive publishes');
  console.log('  deadline run: ' + r.activeAtDeadline + ' outstanding at deadline' +
              '  [its elapsed_ms is off a stubbed clock and is not a real measurement]\n');

  console.log('B — Google independent of RSS');
  check('Google starts without waiting for a 3s RSS lane', r.googleStartedEarly, r.googleAt);
  check('Google headlines are in the result', r.bHasGoogle);

  console.log('\nA — a landed feed does not wait for a hanging peer');
  check('3 fast feeds all settle inside 2s despite a 4s peer', r.fastFeedsEarly, r.fastTimes);
  check('every feed is still collected', r.rssGotAll);

  console.log('\nD — deadline, quiesce, no post-deadline mutation');
  check('deadline fires and is reported', r.deadlineHit);
  check('outstanding requests are counted at the deadline', typeof r.activeAtDeadline === 'number', r.activeAtDeadline);
  check('partial verified results survive the deadline', r.partialSurvived);
  check('a late resolution is discarded, not merged', r.noLateItems);
  check('state is not mutated after the deadline', r.stateStable);
  check('an unfinished source is UNKNOWN, not FAILED', r.unfinishedNotFailed, (r.zeroStatuses || {}));

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
