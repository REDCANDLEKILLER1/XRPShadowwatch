#!/usr/bin/env node
/* ── MORNING NEWS SOURCE HANDOFF ─────────────────────────────────────────────
   SW-20260925-P1WS5 routed 30 headlines and matched 19 articles, but the
   Morning Story printed "[No external sources for today’s scan.]".

   Cause: 10-pipeline treated the existence of clearedMorningNewsSources() as
   authoritative even when it returned an empty array, so it never fell back to
   the usable news pool already consumed by the structured report.

   This suite proves three things:
   1) an empty cleared helper falls back to getNewsSources();
   2) the relevance governor still removes unrelated fallback headlines;
   3) a non-empty cleared list remains authoritative.
──────────────────────────────────────────────────────────────────────────── */
'use strict';

const http = require('http');
const fs   = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const PORT = Number(process.env.SW_TEST_PORT || 8233);
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
  const b = await chromium().launch(
    fs.existsSync(exe) ? { executablePath: exe, args: ['--no-sandbox'] } : { args: ['--no-sandbox'] });
  const p = await b.newPage();
  const errs = [];
  p.on('pageerror', e => errs.push(e.message));
  await p.route('**/*', r =>
    r.request().url().startsWith('http://127.0.0.1:' + PORT) ? r.continue() : r.abort());
  await p.goto('http://127.0.0.1:' + PORT + '/brief-console.html', { waitUntil:'domcontentloaded' });
  await p.waitForTimeout(9000);

  console.log('MORNING NEWS SOURCE HANDOFF\n');

  const out = await p.evaluate(() => {
    const P = window.PUBLIC_REPORT_PIPELINE_V1;
    const result = { hasPipeline: !!(P && typeof P.assemble === 'function') };
    if (!result.hasPipeline) return result;

    const originalClear = window.clearedMorningNewsSources;
    const originalGet   = window.getNewsSources;
    const base = {
      date:'2026-09-25',
      wallets_checked:423,
      watchlist_total:423,
      xrp_price:1.61,
      xrp_delta_24h_pct:0,
      shadow_volume_xrp:440380000,
      large_transfers_count:110,
      large_transfers:[],
      receiver_followthrough:[],
      top_signals:[],
      total_balance_delta_xrp:-126780000,
      risk_score:{score:69,label:'ORANGE',drivers:[]}
    };

    const GOOD = {
      source:'coinpedia',
      title:'XRP ETF inflows hit record as institutional custody expands',
      url:'https://example.test/xrp-ledger-accounts'
    };
    const JUNK = {
      source:'coingape',
      title:'Dogecoin Price Prediction: Analyst Maps Path to $3 as Whales Load Up',
      url:'https://example.test/doge'
    };
    const CLEARED = {
      source:'coinpedia',
      title:'Franklin Templeton XRP ETF Overtakes Rival in Cumulative Inflows',
      url:'https://example.test/xrp-etf'
    };
    const OTHER_XRP = {
      source:'u.today',
      title:'XRP Wallet Activity Accelerates Across the Ledger',
      url:'https://example.test/other-xrp'
    };

    try {
      // Reproduces P1WS5: canonical helper exists, but its lane is empty while
      // the report news pool contains usable articles.
      window.clearedMorningNewsSources = () => [];
      window.getNewsSources = () => [GOOD, JUNK];
      const fallback = String((P.assemble(base) || {}).text || '');
      result.fallbackHasGood = fallback.includes(GOOD.title) && fallback.includes(GOOD.url);
      result.fallbackNoPlaceholder = !fallback.includes('[No external sources for today');
      result.fallbackDropsJunk = !fallback.includes(JUNK.title) && !fallback.includes(JUNK.url);
      result.fallbackSourceOnce = fallback.split(GOOD.url).length - 1 === 1;

      // A genuinely empty run should still say there are no sources.
      window.getNewsSources = () => [];
      const empty = String((P.assemble(base) || {}).text || '');
      result.emptyKeepsPlaceholder = empty.includes('[No external sources for today');

      // If the canonical cleared list has content, it still wins; fallback is
      // only for the empty-list case.
      window.clearedMorningNewsSources = () => [CLEARED];
      window.getNewsSources = () => [OTHER_XRP];
      const authoritative = String((P.assemble(base) || {}).text || '');
      result.clearedWins = authoritative.includes(CLEARED.title) &&
        authoritative.includes(CLEARED.url) &&
        !authoritative.includes(OTHER_XRP.title) &&
        !authoritative.includes(OTHER_XRP.url);
    } finally {
      window.clearedMorningNewsSources = originalClear;
      window.getNewsSources = originalGet;
    }
    return result;
  });

  check('public report pipeline is available', out.hasPipeline);
  check('empty cleared list falls back to usable report news', out.fallbackHasGood, out);
  check('fallback prevents the false no-sources footer', out.fallbackNoPlaceholder, out);
  check('fallback still passes through relevance filtering', out.fallbackDropsJunk, out);
  check('the recovered source is emitted once, without duplicate citation blocks', out.fallbackSourceOnce, out);
  check('a truly empty news pool still prints the no-sources footer', out.emptyKeepsPlaceholder, out);
  check('a non-empty cleared list remains authoritative', out.clearedWins, out);
  check('no page errors', errs.length === 0, errs.slice(0,3));

  await b.close(); srv.close();
  console.log('\n' + (fail ? fail + ' FAILED of ' + (pass + fail) : 'ALL ' + pass + ' CHECKS PASS'));
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
