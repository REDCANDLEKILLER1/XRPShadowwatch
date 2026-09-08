#!/usr/bin/env node
/* ── ONE RUN, ONE MORNING STORY ───────────────────────────────────────────────
   SW-20260831-4VF0C published two materially different Morning Stories from a
   single scan.

   The standalone downloaded MorningReport carried "Under the Surface", "How to
   Read It", "Mid-size flow (100K–<1M)" and "Sub-1M clustered flow". The copy
   embedded in the TOTAL REPORT had none of them, and worded the same escrow
   fact differently:

       embedded:   "coverage 20/20 public owners"
       standalone: "registry check 20/20 known Ripple-labeled addresses"

   Cause: buildMorningStoryText(pack) was called independently three times per
   run — during the scan (which then also piped its result through
   SW_DAILY_GATE), from the UI path, and on shadow.report.sealed — against a
   wrapper chain four modules are still installing. Two of those results were
   stored, and different exports preferred different ones:

       state.morningStoryReport  → TOTAL REPORT / TOTAL DEBUG
       MRF._copyLastReport       → standalone download

   There is now one renderer. This suite proves the exports agree, and that the
   agreement is not vacuous.

   Run: node scripts/morning-story-canonical.test.js
   Env: SW_TEST_PORT to override the port (default 8281).
──────────────────────────────────────────────────────────────────────────── */
'use strict';

const http = require('http');
const fs   = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const PORT = Number(process.env.SW_TEST_PORT || 8281);
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

  console.log('CANONICAL MORNING STORY — ONE RUN, ONE STORY\n');

  const r = await page.evaluate(() => {
    const out = {};
    out.hasCanonical = typeof canonicalMorningStory === 'function';
    if (!out.hasCanonical) return out;

    // ══ 0. PROVENANCE AUTHORITY, IN PRODUCTION ORDER ═══════════════════════
    // This section runs FIRST and deliberately does NOT call MRF.show() before
    // rendering, because production does not: run() renders the canonical story
    // at 02-core.js:20305 and the drawer is only shown from the sealed handler
    // (:9507) ~300ms later. An earlier version of this suite called show() first
    // and so asserted a property of the test's own ordering, not the app's — the
    // NEWS USED block was sourced from the drawer and this suite could not see it.
    //
    // MRF._copyLastSources is poisoned with a stale, XRP-shaped headline that
    // WOULD clear the governor if it were consulted — so if the canonical block
    // still reads the drawer, the poison lands in the story and is caught.
    const STALE = 'XRP ETFs Pull in Biggest Inflow Yet';
    const FRESH = 'XRP Ledger Hits Record High Wallet Growth Numbers';
    const newsPack = {
      date: '2026-09-02', wallets_checked: 251, watchlist_total: 251,
      shadow_volume_xrp: 610490000, large_transfers_count: 171,
      total_balance_delta_xrp: -234730, xrp_price: 1.33, xrp_delta_24h_pct: -0.1,
      xrp_volume_24h: 1930000000, support: 1.2, resistance: 1.5,
      large_transfers: [], receiver_followthrough: [], top_signals: [],
      evidence_quality: { grade: 'B', score: 78 },
      risk_score: { score: 40, label: 'AMBER', drivers: [] },
      // publicSourcesCleared reads news_articles (via _extractArticles);
      // getNewsSources reads news_intel.top_headlines. Both must carry the SAME
      // headlines or the gate opens on a list the report never prints.
      news_articles: [{ title: FRESH }, { title: 'XRP Ledger validator set expands again' }],
      news_intel: { top_headlines: [
        {title:'XRP Price Prediction: We Asked Grok Where XRP Ends September',source:'speculation',url:'https://example.test/prediction'},
        { title: FRESH, source: 'coindesk', url: 'https://example.test/fresh' },
        { title: 'XRP Ledger validator set expands again', source: 'u.today',
          url: 'https://example.test/fresh2' }
      ] }
    };
    try {
      const MRF0 = window.MORNING_REPORT_FLOAT;
      out.provDrawerExists = !!MRF0;
      if (MRF0) MRF0._copyLastSources = [
        { title: STALE, source: 'stale-outlet', url: 'https://example.test/stale' }
      ];
      // No MRF.show() here. This is the production sequence.
      const canonNews = String(canonicalMorningStory(newsPack, { rebuild: true }) || '');
      out.provHasBlock   = /\nNEWS USED:/.test(canonNews);
      out.provHasFresh   = canonNews.indexOf(FRESH) > -1;
      out.provNoStale    = canonNews.indexOf(STALE) === -1;
      out.provNoRejected = canonNews.indexOf('We Asked Grok') === -1;
      const nu = (canonNews.split('\nNEWS USED:')[1] || '');
      out.provBlockNoStale = nu.indexOf(STALE) === -1;
      out.provBlockSample  = nu.split('\n').filter(Boolean).slice(0, 3);
    } catch (e) { out.provErr = String(e && e.message); }

    // A pack with enough substance that the wrapper chain actually engages —
    // the REAL NEWS injection and baseline repair both no-op on an empty pack,
    // and an empty pack would make every comparison below trivially equal.
    const PACK = {
      date: '2026-08-31',
      wallets_checked: 251,
      watchlist_total: 251,
      shadow_volume_xrp: 610490000,
      large_transfers_count: 171,
      total_balance_delta_xrp: -234730,
      xrp_price: 1.3697,
      large_transfers: [
        { from: 'rLHzPsX6oXkzU2qL12kHCH8G8cnZv1rBJh', to: 'rnJrjec2vrTJAAQUTMTjj7U6xdXrk9N4mT',
          amount: 25290000, hash: 'A'.repeat(64), sender_label: 'EXOUT_RECV_rLHzPs', receiver_label: 'Kraken' },
        { from: 'rsyDbFqTfyaBBLGBrEqLkTmZKmhArCUDC0', to: 'rw2ciyaNshpHe7bCHo4bRWq6pqqynnWKQg',
          amount: 22770000, hash: 'B'.repeat(64), sender_label: 'WHALE_rsyDbF', receiver_label: 'Coinbase' }
      ],
      news_intel: { items: [], top_headlines: [] }
    };
    try { state.pack = PACK; } catch (_) {}
    // "Under the Surface" only renders when mid-size flow metrics exist
    // (23-public-report-layers reads SW_SHADOW_FLOW_TIMING_20260816.metrics()).
    // Without this the section is absent from BOTH exports and the
    // section-parity check below compares two empty lists — which is how it
    // first passed while proving nothing.
    try {
      window.SW_SHADOW_FLOW_TIMING_20260816 = {
        metrics: function () {
          return { transfer_count: 1180, total_xrp: 281810000,
                   clustered_transfer_count: 1111, clustered_flow_xrp: 267180000,
                   cluster_pattern_count: 113 };
        }
      };
    } catch (_) {}

    // Produce the canonical render once, exactly as a scan does.
    const canonical = canonicalMorningStory(PACK, { rebuild: true });
    out.canonicalLen = (canonical || '').length;
    out.canonicalNonTrivial = out.canonicalLen > 400;   // anti-vacuity

    // ── the two export paths ────────────────────────────────────────────
    // TOTAL REPORT / TOTAL DEBUG both embed via _resolveReportSource.
    let embedded = null;
    try {
      const res = (typeof _resolveReportSource === 'function')
        ? _resolveReportSource('morning-story') : null;
      embedded = res ? String(res.text || '') : null;
    } catch (e) { out.embeddedErr = String(e && e.message); }
    out.embeddedLen = embedded == null ? -1 : embedded.length;

    // The standalone download reads the same accessor.
    const standalone = canonicalMorningStory();
    out.standaloneLen = (standalone || '').length;

    // THE REAL DOWNLOAD BODY, not the accessor it is supposed to use.
    // Comparing canonicalMorningStory() against itself is what let
    // SW-20260902-76DY2 ship a downloaded file carrying a NEWS USED footer the
    // embedded copy did not have: this suite passed while the actual artifacts
    // differed, because it never invoked MRF.download at all. Capture what
    // downloadTextFile would receive and compare THAT.
    try {
      const MRF = window.MORNING_REPORT_FLOAT;
      if (MRF && typeof MRF.download === 'function') {
        let body = null;
        const realDl = window.downloadTextFile;
        window.downloadTextFile = function (fname, b) { body = b; };
        try { MRF.download(); } finally { window.downloadTextFile = realDl; }
        out.downloadCaptured = body != null;
        out.downloadLen = (body || '').length;
        out.downloadEqualsCanonical = body === canonical;
        out.downloadHasNewsUsedIffCanonical =
          /\nNEWS USED:/.test(String(body || '')) === /\nNEWS USED:/.test(String(canonical || ''));
      } else { out.downloadErr = 'MORNING_REPORT_FLOAT.download unavailable'; }
    } catch (e) { out.downloadErr = String(e && e.message); }

    out.embeddedEqualsCanonical   = embedded === canonical;
    out.standaloneEqualsCanonical = standalone === canonical;
    out.allThreeAgree = out.embeddedEqualsCanonical && out.standaloneEqualsCanonical;

    // ── the content that actually went missing ──────────────────────────
    // These are the sections the embedded copy lacked in SW-20260831-4VF0C.
    // Headings are read OUT OF THE TEXT rather than hard-coded. A fixed list
    // ("Under the Surface", "How to Read It") needs a pack rich enough to
    // trigger those specific injectors; when it is not, both sides hold an
    // empty list and "identical" passes on nothing — which is exactly how the
    // first version of this check passed while proving nothing.
    const headings = t => (String(t || '').split('\n')
      .map((ln, i, all) => (/^[─━]{3,}\s*$/.test(all[i + 1] || '') ? ln.trim() : null))
      .filter(Boolean));
    out.headCanonical = headings(canonical);
    out.headEmbedded  = headings(embedded);
    out.sectionsMatch = JSON.stringify(out.headCanonical) === JSON.stringify(out.headEmbedded);
    // Parity is only evidence if there were sections to compare.
    out.sectionsPresent = out.headCanonical.length >= 3;

    // ── repeated reads are stable ───────────────────────────────────────
    // A second read must not re-render through a different wrapper state.
    out.stableAcrossReads = canonicalMorningStory() === canonicalMorningStory();

    // ── and the comparison is not passing on empty strings ──────────────
    out.notEmpty = out.canonicalLen > 0 && out.embeddedLen > 0 && out.standaloneLen > 0;

    // ── one render per run ──────────────────────────────────────────────
    // Reading it many times must not invoke the underlying builder again.
    let builderCalls = 0;
    const realBuilder = window.buildMorningStoryText;
    window.buildMorningStoryText = function () { builderCalls++; return realBuilder.apply(this, arguments); };
    canonicalMorningStory(); canonicalMorningStory(); canonicalMorningStory();
    out.readsDoNotRerender = builderCalls === 0;
    // an explicit rebuild still works
    canonicalMorningStory(PACK, { rebuild: true });
    out.rebuildDoesRender = builderCalls === 1;
    window.buildMorningStoryText = realBuilder;

    return out;
  });

  if (!r.hasCanonical) {
    console.log('  FAIL  canonicalMorningStory is not defined');
    await browser.close(); srv.close(); process.exit(1);
  }

  console.log('  canonical: ' + r.canonicalLen + ' chars');
  console.log('  embedded : ' + r.embeddedLen + ' chars');
  console.log('  standalone: ' + r.standaloneLen + ' chars\n');

  console.log('1. the comparison is not vacuous');
  console.log('0. provenance authority, in production order');
  console.log('     NEWS USED sample: ' + JSON.stringify(r.provBlockSample));
  check('the drawer exists to be poisoned (setup is real)', r.provDrawerExists, r.provErr);
  check('a NEWS USED block is produced with NO prior MRF.show()',
        r.provHasBlock, r.provErr);
  check('it carries the CURRENT pack\u2019s headline', r.provHasFresh, r.provErr);
  check('a rejected speculative headline cannot appear in the spoken body or sources',r.provNoRejected);
  check('the stale drawer headline does not appear anywhere in the story',
        r.provNoStale, r.provBlockSample);
  check('and specifically not inside the NEWS USED block',
        r.provBlockNoStale, r.provBlockSample);

  console.log('');
  check('the canonical story has real content', r.canonicalNonTrivial, r.canonicalLen);
  check('no export path returned an empty string', r.notEmpty,
        { canonical: r.canonicalLen, embedded: r.embeddedLen, standalone: r.standaloneLen });

  console.log('\n2. every export carries the same story, byte for byte');
  check('TOTAL REPORT / TOTAL DEBUG embed == canonical', r.embeddedEqualsCanonical);
  check('standalone download == canonical', r.standaloneEqualsCanonical);
  check('the real download body was captured (not a vacuous pass)',
        r.downloadCaptured, r.downloadErr);
  check('MRF.download() body == canonical, byte for byte',
        r.downloadEqualsCanonical, { canonical: r.canonicalLen, download: r.downloadLen });
  check('NEWS USED appears in the download iff it is in the canonical text',
        r.downloadHasNewsUsedIffCanonical);
  check('all three agree', r.allThreeAgree);

  console.log('\n3. the exports carry the same SECTIONS, not just the same length');
  console.log('     canonical: ' + JSON.stringify(r.headCanonical));
  console.log('     embedded : ' + JSON.stringify(r.headEmbedded));
  check('there were sections to compare (parity is not vacuous)',
        r.sectionsPresent, r.headCanonical);
  check('section sets are identical', r.sectionsMatch,
        { canonical: r.headCanonical, embedded: r.headEmbedded });

  console.log('\n4. one render per run');
  check('repeated reads return the same text', r.stableAcrossReads);
  check('reading does not re-render', r.readsDoNotRerender);
  check('an explicit rebuild still renders', r.rebuildDoesRender);

  check('no page errors', errs.length === 0, errs.slice(0, 3));

  await browser.close(); srv.close();
  console.log('\n' + (fail ? fail + ' FAILED of ' + (pass + fail) : 'ALL ' + pass + ' CHECKS PASS'));
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
