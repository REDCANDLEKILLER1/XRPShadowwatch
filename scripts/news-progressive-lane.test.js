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
   hung proxy is not exercised.

   SECTIONS A-D REPLACE THE FETCHERS; SECTION E DOES NOT

   A-D stub fetchCryptoCompare / fetchGdelt / fetchGoogleNews wholesale, so they
   measure the ORCHESTRATION and nothing else — the signal handling inside those
   functions never ran, and a stubbed fetcher that cooperates proves only that
   the stub cooperates. Section E replaces window.fetch alone and drives the real
   functions down the real proxy cascade, counting the requests each one makes so
   that "no provider was blamed" is evidence rather than an absence.

   Section D's fetchGdelt stub stays deliberately non-cooperative: it ignores the
   signal, and the suite reports quiesced=false honestly rather than hiding a
   caller that breaks the contract.

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

    // fetchOneRss is captured too. Without it, the stub sections A and D install
    // leaked into every later section — including the one below that must run
    // the REAL RSS path — and the "production-shaped" run would have been the
    // fake all over again.
    const snapshot = () => ({
      cc: window.fetchCryptoCompare, rss: window.fetchAllRss,
      gd: window.fetchGdelt, gn: window.fetchGoogleNews,
      one: window.fetchOneRss, fetch: window.fetch,
      feeds: window.RSS_FEEDS ? window.RSS_FEEDS.slice() : null
    });
    const restore = o => {
      window.fetchCryptoCompare = o.cc; window.fetchAllRss = o.rss;
      window.fetchGdelt = o.gd; window.fetchGoogleNews = o.gn;
      window.fetchOneRss = o.one; window.fetch = o.fetch;
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
    // A FAILS every lane and B succeeds on every lane, so the two sessions
    // produce different tier statuses and therefore different #newsDebugBox
    // text. Without that asymmetry both would render the same box and the
    // diagnostic-ownership checks below could not tell whose text survived.
    const dbgBox = () => (document.getElementById('newsDebugBox') || {}).textContent || '';
    // A's CryptoCompare must fail EARLY — before B supersedes it — or the lane
    // catch sees !live(), returns before setting FAILED, and A ends on PENDING.
    // PENDING does not match getProviderHealth's failure regex, so a leak of it
    // would slip past the diagnostics assertion below and that check would be
    // passing by accident rather than because ownership held. A real FAILED in
    // A's box is what makes the check bite.
    window.fetchCryptoCompare = async () => { await wait(30);   throw new Error('A cc down'); };
    window.fetchAllRss        = async () => { await wait(2500); return mk('SESSION_A', 3); };
    window.fetchGoogleNews    = async () => { await wait(2500); return mk('SESSION_A', 3); };
    window.fetchGdelt         = async () => { await wait(2500); return mk('SESSION_A', 3); };
    const runOld = fetchNewsIntel(true);            // session A — fails fast, ends slow
    await wait(150);
    window.fetchCryptoCompare = async () => { await wait(20); return mk('SESSION_B', 4); };
    window.fetchAllRss        = async () => { await wait(20); return mk('SESSION_B', 4); };
    window.fetchGoogleNews    = async () => { await wait(20); return mk('SESSION_B', 4); };
    window.fetchGdelt         = async () => { await wait(20); return mk('SESSION_B', 4); };
    const iNew = await fetchNewsIntel(true);        // session B — fast, wins
    const afterB = JSON.stringify(((state.newsIntel || {}).items || []).map(x => x.source));
    const dbgAfterB = dbgBox();
    const iOld = await runOld;                      // A finishes last
    await wait(60);                                 // let A's terminal writes land
    const afterA = JSON.stringify(((state.newsIntel || {}).items || []).map(x => x.source));
    const dbgAfterA = dbgBox();
    out.bWon        = /SESSION_B/.test(afterB);
    out.aDidNotWin  = !/SESSION_A/.test(afterA) && afterA === afterB;
    out.aSuperseded = (iOld.lane_metrics || {}).superseded === true;

    // ── the DIAGNOSTIC channel obeys the same ownership rule ────────────
    // #newsDebugBox is an INPUT: buildNewsRouteDiagnostics reads it back when
    // called without a newsDebug argument, and getProviderHealth does too.
    // Those verdicts reach state.newsDiagnostics and can be persisted as
    // provider history. A superseded session writing its own tier statuses
    // there leaves telemetry from a run whose data was thrown away.
    out.dbgShowsBWon    = /✓/.test(dbgAfterB) && !/FAILED/.test(dbgAfterB);
    out.dbgStillB       = dbgAfterA === dbgAfterB;
    // Any stale marker, not just FAILED: a superseded run can also leave
    // PENDING behind, and "no FAILED" alone would call that clean.
    out.dbgNoStaleFail  = !/✗|FAILED|PENDING|DEADLINE_UNFINISHED/.test(dbgAfterA);
    // Prove the scenario can actually produce a poisoning value, so the
    // diagnostics check below is not passing on an input that was harmless.
    out.aWouldHaveLeakedFailure = /FAILED/.test(
      ['✗ CryptoCompare: ' + ((iOld.source_status || {}).cryptocompare || '?')].join(''));
    out.aCcStatus = (iOld.source_status || {}).cryptocompare;
    out.dbgAfterA       = dbgAfterA.replace(/\n/g, ' | ').slice(0, 160);

    // and a diagnostic build run AFTER A finished must not derive A's statuses
    const diagAfter = (typeof buildNewsRouteDiagnostics === 'function')
      ? buildNewsRouteDiagnostics() : null;
    const provsAfter = (diagAfter && diagAfter.providers) || {};
    out.diagRan = !!diagAfter;
    out.diagNoStaleFailure = Object.keys(provsAfter).every(k => {
      const st = String((provsAfter[k] || {}).overall_status || '');
      return !/TRANSPORT_FAILED/.test(st);
    });
    out.diagStatuses = Object.keys(provsAfter).slice(0, 6)
      .map(k => k + '=' + ((provsAfter[k] || {}).overall_status || '?'));
    restore(orig);

    // ── E: the REAL source paths honour the session signal ─────────────
    // Nothing here stubs fetchCryptoCompare / fetchGdelt / fetchGoogleNews /
    // fetchAllRss. Only window.fetch is replaced, at the network boundary, so
    // the production chains run for real:
    //
    //   fetchCryptoCompare -> fetchWithTimeout -> fetch
    //   fetchGoogleNews / fetchOneRss / fetchGdelt -> proxyFetch
    //                                    -> fetchWithTimeout -> fetch
    //
    // Every previous section replaced the fetchers wholesale, which meant the
    // signal threading inside them was never once executed. A stubbed fetcher
    // that cooperates proves only that the stub cooperates.
    const origFetch = window.fetch;

    // Models a real fetch faithfully in the one respect under test: an aborted
    // signal rejects the request AND errors an already-open body stream.
    // Anti-vacuity control. "No counter moved" is only evidence if the code that
    // could have moved it actually ran, so every request the real fetchers make
    // is counted and asserted on below.
    let hits = { cryptocompare: 0, gdelt: 0, google: 0, rss: 0 };
    const installFetch = (route) => {
      window.fetch = (url, init) => {
        const u = String(url);
        if (/min-api\.cryptocompare\.com/.test(u)) hits.cryptocompare++;
        else if (/gdeltproject\.org/.test(u))      hits.gdelt++;
        else if (/news\.google\.com/.test(u))      hits.google++;
        else                                        hits.rss++;
        const sig = init && init.signal;
        const mode = route(u);
        return new Promise((resolve, reject) => {
          const abortErr = () => { const e = new Error('The operation was aborted.'); e.name = 'AbortError'; return e; };
          if (sig && sig.aborted) { reject(abortErr()); return; }
          const onAbort = () => reject(abortErr());
          if (sig) { try { sig.addEventListener('abort', onAbort, { once: true }); } catch (_) {} }

          if (mode === 'netfail') {
            setTimeout(() => reject(new TypeError('Failed to fetch')), 15);
            return;
          }
          if (mode === 'headers-then-stall') {
            // The case the old shape could not survive: headers land promptly,
            // the body never completes. Both bounds used to be torn down at the
            // moment these headers arrived.
            setTimeout(() => {
              let ctl = null;
              const body = new ReadableStream({ start(c) { ctl = c; } });
              if (sig) {
                try {
                  sig.addEventListener('abort', () => {
                    try { ctl.error(abortErr()); } catch (_) {}
                  }, { once: true });
                } catch (_) {}
              }
              resolve(new Response(body, { status: 200, headers: { 'content-type': 'text/plain' } }));
            }, 25);
            return;
          }
          // 'hang' — only the abort ever ends this request.
        });
      };
    };
    const routeAll = (u) =>
      /news\.google\.com/.test(u)          ? 'headers-then-stall' :
      /min-api\.cryptocompare\.com/.test(u) ? 'hang' :
      /gdeltproject\.org/.test(u)           ? 'hang' :
                                              'headers-then-stall';   // RSS feeds

    // A clean provider slate, then a seeded counter per provider so an
    // increment is visible rather than inferred from absence.
    // RSS_FEEDS is a top-level const — a lexical global, NOT a window property.
    // `window.RSS_FEEDS` is undefined, so writing it that way silently produced
    // a two-provider list and the seven RSS feeds went unchecked while every
    // assertion still passed. Read the lexical binding.
    const PROVIDERS = ['GDELT', 'Google News'].concat(
      RSS_FEEDS.filter(f => !f.disabled_by_default).map(f => f.name));
    out.eProviderCount = PROVIDERS.length;
    out.eProviders = PROVIDERS.slice();
    const seedCounters = () => {
      const sess = {};
      // 1, not 3: at 3 recordNewsDoctorAttempt sets a 4-minute `disabled_until`
      // cooldown that isProviderSessionDisabled honours, and every fetcher would
      // return [] before making a request — every assertion below would then
      // pass without a single line of the code under test running.
      PROVIDERS.forEach(nm => { sess[nm] = {
        provider: nm, consecutive_fail_count: 1, last_success_at: null,
        last_failure_at: null, disabled_for_session: false,
        disabled_until: 0, preferred_route: null }; });
      sessionStorage.setItem(window.NEWS_DOCTOR_SESSION_KEY, JSON.stringify(sess));
    };
    const readCounters = () => {
      let sess = {};
      try { sess = JSON.parse(sessionStorage.getItem(window.NEWS_DOCTOR_SESSION_KEY) || '{}'); } catch (_) {}
      const o = {};
      PROVIDERS.forEach(nm => { o[nm] = ((sess[nm] || {}).consecutive_fail_count); });
      return o;
    };
    const errorLogText = () => (document.getElementById('errorLog') || {}).textContent || '';

    if ($('inCpKey')) $('inCpKey').value = 'test-key';   // CryptoCompare opts in
    localStorage.removeItem(window.NEWS_DOCTOR_HISTORY_KEY);

    // E1 + E2 — session abort: everything quiesces, nobody is blamed for it.
    installFetch(routeAll);
    hits = { cryptocompare: 0, gdelt: 0, google: 0, rss: 0 };
    seedCounters();
    const beforeE = readCounters();
    const errLenBefore = errorLogText().length;
    window.__SW_NEWS_BUDGET_MS__ = 400;
    const iE = await fetchNewsIntel(true);
    delete window.__SW_NEWS_BUDGET_MS__;
    const mE = iE.lane_metrics || {};
    const afterE = readCounters();
    const newErrLines = errorLogText().slice(errLenBefore).split('\n').filter(Boolean);

    out.eDeadlineHit      = mE.deadline_hit === true;
    out.eActiveAfterAbort = mE.active_after_abort;
    out.eQuiesced         = mE.quiesced === true;
    out.eElapsed          = mE.elapsed_ms;
    out.eBefore           = beforeE;
    out.eAfter            = afterE;
    // Not one provider counter may move. A cancellation is not a failure, and
    // three of these bench a provider for the rest of the session.
    out.eNoCounterMoved   = PROVIDERS.every(nm => afterE[nm] === beforeE[nm]);
    out.eMovedProviders   = PROVIDERS.filter(nm => afterE[nm] !== beforeE[nm]);
    // elog is not an inert log line: getProviderHealth reads #errorLog back and
    // scores any line matching /error|fail|.../ as a failed route, which
    // updateNewsDoctorHistory then persists to localStorage across sessions.
    out.eNoFailureLogged  = !newErrLines.some(l => /fail|error|timeout/i.test(l));
    out.eNewErrLines      = newErrLines.slice(0, 4);
    out.eHits             = Object.assign({}, hits);
    // Each of the four real source paths must actually have reached the network.
    out.eAllPathsRan      = hits.cryptocompare > 0 && hits.gdelt > 0 &&
                            hits.google > 0 && hits.rss > 0;

    // E3 — and the persistent history the log feeds must stay clean too.
    state.newsDiagnostics = (typeof buildNewsRouteDiagnostics === 'function')
      ? buildNewsRouteDiagnostics() : null;
    if (typeof updateNewsDoctorHistory === 'function') updateNewsDoctorHistory();
    let hist = {};
    try { hist = JSON.parse(localStorage.getItem(window.NEWS_DOCTOR_HISTORY_KEY) || '{}'); } catch (_) {}
    out.eHistNoFailures = Object.keys(hist).every(k => !(hist[k] || {}).consecutive_failures);
    out.eHistOffenders  = Object.keys(hist).filter(k => (hist[k] || {}).consecutive_failures);

    // E4 — an ORDINARY failure, with no session abort, must still record.
    // Same real code paths, same fake fetch, only the failure mode differs:
    // the network refuses instead of the session ending. If the abort guards
    // were written too broadly they would swallow this too.
    localStorage.removeItem(window.NEWS_DOCTOR_HISTORY_KEY);
    sessionStorage.removeItem(window.NEWS_DOCTOR_SESSION_KEY);
    installFetch(() => 'netfail');
    hits = { cryptocompare: 0, gdelt: 0, google: 0, rss: 0 };
    const errLenBefore2 = errorLogText().length;
    window.__SW_NEWS_BUDGET_MS__ = 9000;      // generous: no deadline this time
    const iF = await fetchNewsIntel(true);
    delete window.__SW_NEWS_BUDGET_MS__;
    const afterF = readCounters();
    const newErrLines2 = errorLogText().slice(errLenBefore2).split('\n').filter(Boolean);
    out.fDeadlineHit   = (iF.lane_metrics || {}).deadline_hit === true;
    out.fCounters      = afterF;
    out.fRecordedFails = PROVIDERS.some(nm => afterF[nm] > 0);
    out.fLoggedFails   = newErrLines2.some(l => /fail/i.test(l));
    out.fHits          = Object.assign({}, hits);
    out.fAllPathsRan   = hits.cryptocompare > 0 && hits.gdelt > 0 &&
                         hits.google > 0 && hits.rss > 0;
    // Every provider that was asked must be marked down, not merely one of them.
    out.fEveryProviderRecorded = PROVIDERS.every(nm => afterF[nm] > 0);
    out.fMissed = PROVIDERS.filter(nm => !(afterF[nm] > 0));
    out.fErrLines      = newErrLines2.slice(0, 4);

    window.fetch = origFetch;
    localStorage.removeItem(window.NEWS_DOCTOR_HISTORY_KEY);
    sessionStorage.removeItem(window.NEWS_DOCTOR_SESSION_KEY);
    if ($('inCpKey')) $('inCpKey').value = '';
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
  console.log('  debug box after the superseded run finished: ' + JSON.stringify(r.dbgAfterA));
  check('the newer session publishes', r.bWon);
  check('the older session cannot overwrite it', r.aDidNotWin);
  check('the older session reports itself superseded', r.aSuperseded);

  console.log('\nthe diagnostic channel obeys ownership too');
  check('the winning session owns the debug box', r.dbgShowsBWon, r.dbgAfterB);
  check('a superseded session cannot rewrite it', r.dbgStillB, r.dbgAfterA);
  check('no stale status of any kind is left behind', r.dbgNoStaleFail, r.dbgAfterA);
  check('the superseded run really did hold a FAILED status to leak',
        r.aWouldHaveLeakedFailure, r.aCcStatus);
  check('buildNewsRouteDiagnostics ran', r.diagRan);
  check('diagnostics cannot derive the superseded run\'s failures',
        r.diagNoStaleFailure, r.diagStatuses);

  console.log('\nprogressive publication');
  check('more than one publish happened during the run', r.bPublishes > 1, r.bPublishes);

  console.log('\nE — the REAL source fetchers under a session abort');
  console.log('     (nothing stubbed but window.fetch; real CryptoCompare, GDELT,');
  console.log('      Google News and RSS code paths, real proxy cascade)');
  console.log('     elapsed ' + r.eElapsed + 'ms on a 400ms budget, ' +
              r.eActiveAfterAbort + ' request(s) still active after the abort');
  console.log('     ' + r.eProviderCount + ' providers watched: ' + JSON.stringify(r.eProviders));
  console.log('     requests actually made: ' + JSON.stringify(r.eHits));
  console.log('     provider counters before: ' + JSON.stringify(r.eBefore));
  console.log('     provider counters after:  ' + JSON.stringify(r.eAfter));
  check('all four real source paths actually reached the network', r.eAllPathsRan, r.eHits);
  check('all RSS feeds are in the watched set, not just GDELT/Google',
        r.eProviderCount > 2, r.eProviders);
  check('the session deadline fires', r.eDeadlineHit);
  check('every real source path stops: 0 active after abort', r.eActiveAfterAbort === 0, r.eActiveAfterAbort);
  check('the lane reports itself quiesced', r.eQuiesced);
  check('no provider counter moves on a session abort', r.eNoCounterMoved, r.eMovedProviders);
  check('no failure line is logged for a cancellation', r.eNoFailureLogged, r.eNewErrLines);
  check('persistent News Doctor history records no failure', r.eHistNoFailures, r.eHistOffenders);

  console.log('\nE4 — an ordinary failure is still a failure');
  console.log('     requests actually made: ' + JSON.stringify(r.fHits));
  console.log('     provider counters after a refusing network: ' + JSON.stringify(r.fCounters));
  check('all four real source paths ran here too', r.fAllPathsRan, r.fHits);
  check('no deadline was involved in this run', r.fDeadlineHit === false, r.fDeadlineHit);
  check('a real network failure still records against the provider', r.fRecordedFails, r.fCounters);
  check('EVERY asked provider is recorded, not just one', r.fEveryProviderRecorded, r.fMissed);
  check('a real network failure is still logged', r.fLoggedFails, r.fErrLines);

  console.log('\nzero verified results');
  check('no items', r.zeroItems);
  check('summary stays ledger-only', r.zeroLedger);
  check('still no provider named "all"', r.zeroNoAll, r.zeroStatuses);

  check('no page errors', errs.length === 0, errs.slice(0, 3));

  await browser.close(); srv.close();
  console.log('\n' + (fail ? fail + ' FAILED of ' + (pass + fail) : 'ALL ' + pass + ' CHECKS PASS'));
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
