#!/usr/bin/env node
/* ── X SUMMARY EXPORT: ONE FACT, ONE APPEARANCE ───────────────────────────────
   The X post is capped at 4,000 characters and is the version most people
   actually read. On the 2026-08-31 run (SW-20260831-3B2UV) it spent that budget
   like this:

     • The Verdict paragraph printed THREE times — under "Watched Wallets /
       Shadow Volume", under "Verdict / Risk", and again cut in half under
       "Disclaimer". Each section scraped the report text independently, and
       stats() matched the words "shadow volume" inside the verdict prose while
       disclaimer() matched "not financial advice" inside the same sentence.
     • The Kraken transfer printed three times, the 20M transfer twice.
     • "Verdict / Risk" opened with the orphan fragment "63/100)" — a regex
       catching a score out of the middle of a sentence.
     • News appeared ONLY as three bare URLs. In the source report, Google News
       tracking links ran 1,373 characters — 34% of the whole Morning Story —
       and told the reader nothing.

   The operator reads this aloud on air and posts it daily. "It doubles up
   things and says it too many times" was the report, and it was accurate.

   This suite drives the REAL module inside brief-console.html, so the ranking
   it shares with the report's SOURCES block (filterSourcesForReport) is the
   real one rather than a stub.

   Run: node scripts/x-summary-export.test.js
   Env: SW_TEST_PORT to override the port (default 8271).
──────────────────────────────────────────────────────────────────────────── */
'use strict';

const http = require('http');
const fs   = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const PORT = Number(process.env.SW_TEST_PORT || 8271);
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
  await page.waitForTimeout(9000);

  console.log('X SUMMARY EXPORT — ONE FACT, ONE APPEARANCE\n');

  const r = await page.evaluate(() => {
    const out = {};

    // A Morning Story shaped exactly like the 2026-08-31 run: the verdict
    // sentence carries both "shadow volume" and "Not financial advice", which is
    // what let three different sections each claim it.
    const STORY = [
      'SECTION 02 — MORNING STORY REPORT',
      '============================================================',
      'SHADOW WATCH',
      'August 31, 2026',
      '',
      'Executive Summary',
      '─────────────────',
      '547.93M XRP moved across 153 large transfers in the window. Crypto.com x3 and Coinbase x3 absorbed 178.84M XRP this scan. The standout individual anomaly was 25.29M XRP moved from a tracked receiving wallet to Kraken. These classifications describe observed movement only; they do not prove intent.',
      '',
      'Evidence',
      '────────',
      'Here are the receipts, straight off the Ledger. 25.29M XRP moved from a tracked receiving wallet to Kraken overnight. A second transfer of 20M XRP reached a large XRP holder. In the discovery queue right now: 50 flagged candidates, separate from the 251 wallets on the permanent watch list. And out in the daylight world, ledger-matched context: Ripple CLO says Clarity Act tied to U.S. jobs and economic growth, September vote in focus.',
      '',
      'Verdict',
      '───────',
      'Bottom line off the Ledger: the Ledger is restless, and I am watching close. (63/100). What tipped me off: large transfer count, shadow volume, dust/tag flags. Watch the hands, not the mouth. Not financial advice. XRP-only forensic watch.',
      '',
      'LEDGER DIAGNOSTICS',
      '──────────────────',
      '• XRP price: ~$1.3475 (24h soft)',
      '• Watched wallets: 251',
      '• Shadow volume (whale moves >=1M): 547.93M XRP · 153 transfers',
      '',
      '🙏 THE DAILY PRAYER',
      '───────────────────',
      'Lord, keep us quiet enough to hear the ledger over the crowd.',
      '',
      '📖 THE DAILY SCRIPTURE',
      '──────────────────────',
      'Ezekiel 33:6 (KJV)',
      '"But if the watchman see the sword come, and blow not the trumpet..."',
      '',
      'Sources',
      '───────',
      '[1] Ripple CLO says Clarity Act tied to U.S. jobs and economic growth, September vot — https://news.google.com/rss/articles/' + 'C'.repeat(300) + '?oc=5',
      '[2] u.today — Ripple Exec: Clarity Act Can Unlock More US Jobs',
      '    https://u.today/ripple-exec-clarity-act-can-unlock-more-us-jobs'
    ].join('\n');

    // The pack as the engine hands it over: newest-first, unranked, with the
    // three shapes that used to break the news block.
    const PACK = { news_intel: { top_headlines: [
      { title: 'Trump Announced the Biggest Oil Deal Ever: Why Did Prices Jump?', source: 'rss:beincrypto@self', url: 'https://beincrypto.com/a' },
      { title: 'Dogecoin Could Reach $5 By 2030, Analyst Says', source: 'rss:coinpedia@self', url: 'https://coinpedia.org/b' },
      { title: 'Ripple CLO says Clarity Act tied to U.S. jobs and economic growth, September vote in focus', source: 'google_news@self', url: 'https://news.google.com/c' },
      { title: 'Ripple CLO: Clarity Act Vote Would Boost U.S. Jobs And Economic Growth', source: 'google_news@self', url: 'https://news.google.com/d' },
      { title: 'Passing the CLARITY Act could create over 230,000 US jobs', source: 'rss:u.today@self', url: 'https://u.today/e' },
      { title: 'Cryptex Allocates 4.88 Percent XRP Weighting in US Digital Asset ETF Filing', source: 'google_news@self', url: 'https://news.google.com/f' }
    ] } };

    const build = window.SW_X_SUMMARY_EXPORT && window.SW_X_SUMMARY_EXPORT.build;
    out.hasBuilder = typeof build === 'function';
    if (!out.hasBuilder) return out;

    const txt = build(STORY, PACK);
    out.text = txt;
    out.len  = txt.length;

    // ── budget ──────────────────────────────────────────────────────────
    out.underLimit   = txt.length <= 4000;
    out.counterHonest = new RegExp('Characters: ' + txt.length + ' / 4000').test(txt);

    // ── news is present, at the top, and readable aloud ──────────────────
    const iNews = txt.indexOf('\nNEWS\n');
    const iExec = txt.indexOf('Executive Summary');
    out.hasNews      = iNews > -1;
    out.newsBeforeExec = iNews > -1 && iExec > -1 && iNews < iExec;
    const newsBlock  = iNews > -1 ? txt.slice(iNews, iExec > iNews ? iExec : txt.length) : '';
    out.newsBlock    = newsBlock.trim();
    out.newsNoUrls   = !/https?:\/\//.test(newsBlock);
    out.newsHasSource = /—\s*(Google News|u\.today|beincrypto|coinpedia)/.test(newsBlock);
    const bullets = newsBlock.split('\n').filter(l => /^•/.test(l));
    out.newsCount = bullets.length;
    out.newsNoTruncation = !bullets.some(b => /\.\.\.\s*$/.test(b) || /,\d\s*$/.test(b));

    // ── editorial policy is the report's, not a looser second one ────────
    out.newsNoMemecoin = !/Dogecoin|Could Reach \$5/i.test(newsBlock);
    out.newsLeadsXrp   = /^•.*(XRP|Ripple|Clarity)/i.test(bullets[0] || '');
    // three publishers, one Clarity Act vote → one line
    out.clarityOnce = (newsBlock.match(/Clarity/gi) || []).length <= 1;

    // ── ONE FACT, ONE APPEARANCE — the core of the fix ───────────────────
    const body = txt.slice(txt.indexOf('\n\n') + 2);
    const sentences = body.split(/\n+|(?<=[a-z0-9)\]][.!?])\s+(?=[A-Z0-9])/)
      .map(s => s.trim())
      .filter(s => s.length > 25 && !/^[•\-*]/.test(s));
    const counts = {};
    sentences.forEach(s => {
      const k = s.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
      counts[k] = (counts[k] || 0) + 1;
    });
    out.repeated = Object.keys(counts).filter(k => counts[k] > 1).map(k => k.slice(0, 60));
    out.noRepeatedSentence = out.repeated.length === 0;

    // the specific facts that used to triple
    out.verdictOnce = (txt.match(/the Ledger is restless/gi) || []).length === 1;
    out.krakenOnce  = (txt.match(/25\.29M XRP moved from a tracked receiving wallet to Kraken/gi) || []).length === 1;

    // ── no orphan score fragment ─────────────────────────────────────────
    out.noOrphanScore = !/^\s*\d{1,3}\/100\)/m.test(txt);
    out.riskLabelled  = /Risk:\s*63\/100/.test(txt);

    // ── stats section holds stats, not prose ─────────────────────────────
    const iStats = txt.indexOf('Watched Wallets / Shadow Volume');
    const statsBlock = iStats > -1 ? txt.slice(iStats, txt.indexOf('\n\n', iStats)) : '';
    out.statsNoVerdictProse = !/restless|Watch the hands/i.test(statsBlock);
    out.statsKeptBullets = (statsBlock.match(/^•/gm) || []).length >= 2;

    // ── no plumbing in the brand block ───────────────────────────────────
    out.noSectionHeader = !/SECTION\s+\d+\s*—/.test(txt);
    out.noRuleLine      = !/^={10,}$/m.test(txt);

    // ── nothing ends mid-sentence ────────────────────────────────────────
    const secBodies = body.split(/\n\n/).map(b => b.split('\n').slice(1).join(' ').trim()).filter(Boolean);
    out.midSentence = secBodies.filter(b => /\b(to|of|the|and|a|in|for|tied to U\.S\.)$/i.test(b)).slice(0, 3);
    out.noMidSentenceCut = out.midSentence.length === 0;

    // ── the movements list keeps its own first item ──────────────────────
    // Letting the Executive Summary claim first left this section opening on
    // "A second transfer of 20M XRP…" — a second with no first.
    const iMov = txt.indexOf('Largest XRP Movements');
    const movBlock = iMov > -1 ? txt.slice(iMov, txt.indexOf('\n\n', iMov)) : '';
    const movLines = movBlock.split('\n').slice(1).filter(Boolean);
    out.movFirstLine = movLines[0] || '';
    out.movNotOrphaned = !/^A second\b/i.test(out.movFirstLine);
    out.movHasKraken = /Kraken/.test(movBlock);
    // and the summary keeps its aggregate rather than being hollowed out
    const iEx = txt.indexOf('Executive Summary');
    out.execKeptAggregate = /547\.93M XRP moved across 153 large transfers/.test(
      txt.slice(iEx, txt.indexOf('\n\n', iEx)));

    // ── the fact key must not eat genuinely distinct movements ──────────
    // Merging on amount alone would collapse three separate 10.00M escrow locks
    // into one. The key requires a named counterparty, so same-amount transfers
    // to DIFFERENT destinations must all survive.
    const MULTI = STORY.replace(
      'Here are the receipts, straight off the Ledger.',
      'Here are the receipts, straight off the Ledger. 10.00M XRP moved to Bitstamp. 10.00M XRP moved to Bitfinex. 10.00M XRP moved to Uphold.');
    const multi = build(MULTI, PACK);
    out.distinctKept = ['Bitstamp', 'Bitfinex', 'Uphold'].filter(d =>
      new RegExp('10\\.00M XRP moved to ' + d).test(multi));
    out.allDistinctSurvive = out.distinctKept.length === 3;

    return out;
  });

  if (!r.hasBuilder) {
    console.log('  FAIL  SW_X_SUMMARY_EXPORT.build not present');
    await browser.close(); srv.close(); process.exit(1);
  }

  console.log('  export length: ' + r.len + ' / 4000');
  console.log('  news block:\n' + r.newsBlock.split('\n').map(l => '    ' + l).join('\n') + '\n');

  console.log('1. budget');
  check('export is within the 4,000 character limit', r.underLimit, r.len);
  check('the printed character count is the real one', r.counterHonest);

  console.log('\n2. news exists, at the top, readable aloud');
  check('there is a NEWS section at all', r.hasNews);
  check('news comes before the Executive Summary', r.newsBeforeExec);
  check('no URLs in the news block', r.newsNoUrls);
  check('each headline carries its publisher', r.newsHasSource, r.newsBlock);
  check('no truncated half-headline', r.newsNoTruncation, r.newsBlock);

  console.log('\n3. same editorial policy as the report SOURCES block');
  check('price-hype/memecoin headline excluded', r.newsNoMemecoin, r.newsBlock);
  check('an XRP-relevant story leads', r.newsLeadsXrp, r.newsBlock);
  check('one story from three publishers appears once', r.clarityOnce, r.newsBlock);

  console.log('\n4. one fact, one appearance');
  check('no sentence appears twice anywhere in the post', r.noRepeatedSentence, r.repeated);
  check('the verdict sentence appears exactly once', r.verdictOnce);
  check('the Kraken transfer appears exactly once', r.krakenOnce);
  check('stats section carries stats, not verdict prose', r.statsNoVerdictProse);
  check('stats bullets survive as separate lines', r.statsKeptBullets);

  console.log('\n5. dedupe reorders claims, not the reader\'s experience');
  check('movements list starts with its own first transfer', r.movNotOrphaned, r.movFirstLine);
  check('the specific transfer lives in the movements section', r.movHasKraken);
  check('executive summary keeps its aggregate', r.execKeptAggregate);

  console.log('\n6. dedupe does not eat real information');
  check('three same-amount transfers to different destinations all survive',
        r.allDistinctSurvive, r.distinctKept);

  console.log('\n7. no broken fragments');
  check('no orphan "63/100)" fragment', r.noOrphanScore);
  check('the risk score is printed as a labelled reading', r.riskLabelled);
  check('no SECTION header leaks into the post', r.noSectionHeader);
  check('no ==== rule line leaks into the post', r.noRuleLine);
  check('no section ends mid-sentence', r.noMidSentenceCut, r.midSentence);

  check('no page errors', errs.length === 0, errs.slice(0, 3));

  await browser.close(); srv.close();
  console.log('\n' + (fail ? fail + ' FAILED of ' + (pass + fail) : 'ALL ' + pass + ' CHECKS PASS'));
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
