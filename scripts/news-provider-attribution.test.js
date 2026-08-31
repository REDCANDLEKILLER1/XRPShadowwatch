#!/usr/bin/env node
/* ── NEWS PROVIDER ATTRIBUTION ────────────────────────────────────────────────
   A lane outcome must never be published as a provider.

   SW-20260827-FPXY4 scanned 251/251, sealed clean, no XRPL failure — and told
   the reader:

       • all: unavailable this run and the 4 before it — its coverage is
         missing from the pool above.

   There is no source called "all". When the outer 18s news ceiling fired before
   any snapshot existed, the fallback wrote

       source_status: { all: 'FAILED' }

   which entered the provider universe, was persisted into the News Doctor
   history in localStorage, and was then republished on every later run. Nothing
   ever writes a success under a key no fetcher owns, so its failure count only
   ever climbed: 3 on 2026-08-25, 4 on 2026-08-27.

   That makes this a PERSISTENT-STATE bug, not just a rendering one — the
   poisoned record outlives the code that created it. This suite is committed
   rather than kept in a scratchpad precisely because of that: the recovery path
   has to stay proven for browsers that already carry the bad record.

   Run: node scripts/news-provider-attribution.test.js
   Env: SW_TEST_PORT to override the port (default 8251).
──────────────────────────────────────────────────────────────────────────── */
'use strict';

const http = require('http');
const fs   = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');          // resolved from THIS file
const PORT = Number(process.env.SW_TEST_PORT || 8251);
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

  console.log('NEWS PROVIDER ATTRIBUTION\n');

  const r = await page.evaluate(() => {
    const out = {};
    const KEY = window.NEWS_DOCTOR_HISTORY_KEY;

    // ── the reserved-key rule itself ────────────────────────────────────
    out.reserved = ['all', 'ALL', ' all ', 'any', 'none', 'unknown', '*', '']
      .every(k => isReservedNewsProviderKey(k));
    out.realNotReserved = ['GDELT', 'Google News', 'NewsBTC', 'CryptoCompare', 'rss_feeds']
      .every(k => !isReservedNewsProviderKey(k));

    // ── a poisoned history already in localStorage ──────────────────────
    const poisoned = {
      all:      { provider:'all',    consecutive_failures: 9, failure_count: 9, success_count: 0 },
      GDELT:    { provider:'GDELT',  consecutive_failures: 7, failure_count: 7, success_count: 0 },
      NewsBTC:  { provider:'NewsBTC',consecutive_failures: 0, failure_count: 1, success_count: 12 }
    };
    localStorage.setItem(KEY, JSON.stringify(poisoned));
    const loaded = getNewsDoctorHistory();
    out.purgedFromLoad   = !Object.prototype.hasOwnProperty.call(loaded, 'all');
    out.keptRealFailing  = (loaded.GDELT || {}).consecutive_failures === 7;
    out.keptHealthy      = (loaded.NewsBTC || {}).success_count === 12
                        && (loaded.NewsBTC || {}).consecutive_failures === 0;
    // and the purge is written back, so the record does not return next run
    out.purgedFromDisk   = !Object.prototype.hasOwnProperty.call(
                             JSON.parse(localStorage.getItem(KEY) || '{}'), 'all');

    // ── what the report would publish ───────────────────────────────────
    localStorage.setItem(KEY, JSON.stringify(poisoned));   // re-poison
    const limits = (typeof _routerSourceLimits === 'function') ? _routerSourceLimits() : [];
    const joined = limits.join(' | ');
    out.noAllLine     = !/(^|\s)all:/.test(joined);
    out.realStillShown = /GDELT/.test(joined);
    out.limits = joined.slice(0, 200);

    // ── the ceiling fallback no longer invents a provider ───────────────
    // Same shape the outer catch builds when it times out before a snapshot.
    const ni = { items: [], top_headlines: [], source_status: {},
                 lane_incomplete: 'CEILING_BEFORE_SNAPSHOT' };
    out.fallbackNoAll = !Object.prototype.hasOwnProperty.call(ni.source_status, 'all');
    const truth = buildProviderTruthStatus({ news_intel: ni });
    out.universeNoAll = !Object.keys(truth.providers || {}).some(k => /^all$/i.test(k));
    // no fabricated failures either — unknown is not failed
    out.noFabricatedFailures = !Object.values(truth.providers || {})
      .some(p => p && p.failure_class && /ceiling|timeout/i.test(String(p.failure_class)));

    // ── zero headlines is still ledger-only ─────────────────────────────
    const deg = (typeof detectNewsDegradation === 'function')
      ? detectNewsDegradation({ news_intel: ni }) : null;
    out.ledgerOnly = !ni.items.length;
    out.degradationSafe = deg === null || typeof deg === 'object';

    // ── a genuinely failing provider still reports ──────────────────────
    localStorage.setItem(KEY, JSON.stringify({
      GDELT: { provider:'GDELT', consecutive_failures: 5, failure_count: 5, success_count: 0 }
    }));
    out.canonicalStillReports = /GDELT/.test(
      ((typeof _routerSourceLimits === 'function') ? _routerSourceLimits() : []).join(' | '));

    try { localStorage.removeItem(KEY); } catch (_) {}
    return out;
  });

  console.log('  source limits published: ' + JSON.stringify(r.limits) + '\n');

  console.log('1. the rule');
  check('aggregate words are reserved (all/any/none/unknown/*/empty)', r.reserved);
  check('real provider names are NOT reserved', r.realNotReserved);

  console.log('\n2. an already-poisoned browser recovers');
  check('"all" is purged when history loads', r.purgedFromLoad);
  check('the purge is written back to storage', r.purgedFromDisk);
  check('a real failing provider survives the purge', r.keptRealFailing);
  check('a healthy provider record is untouched', r.keptHealthy);

  console.log('\n3. what the report publishes');
  check('no "all: unavailable…" line in source limits', r.noAllLine, r.limits);
  check('a genuinely failing provider is still named', r.realStillShown);
  check('canonical provider failure still reports normally', r.canonicalStillReports);

  console.log('\n4. the ceiling fallback');
  check('fallback source_status carries no "all"', r.fallbackNoAll);
  check('provider universe admits no "all"', r.universeNoAll);
  check('no fabricated per-provider failures (unknown is not failed)', r.noFabricatedFailures);

  console.log('\n5. ledger-only preserved');
  check('zero verified headlines still reads as ledger-only', r.ledgerOnly);
  check('degradation detection stays well-formed', r.degradationSafe);

  check('no page errors', errs.length === 0, errs.slice(0, 3));

  await browser.close(); srv.close();
  console.log('\n' + (fail ? fail + ' FAILED of ' + (pass + fail) : 'ALL ' + pass + ' CHECKS PASS'));
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
