#!/usr/bin/env node
'use strict';

const http = require('http');
const fs = require('fs');
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
function check(name, ok, detail) {
  if (ok) { pass++; console.log('  PASS  ' + name); }
  else { fail++; console.log('  FAIL  ' + name + (detail !== undefined ? ' -> ' + JSON.stringify(detail) : '')); }
}

(async () => {
  const srv = serve();
  const exe = '/opt/pw-browsers/chromium-1194/chrome-linux/chrome';
  const b = await chromium().launch(fs.existsSync(exe)
    ? { executablePath: exe, args: ['--no-sandbox'] }
    : { args: ['--no-sandbox'] });
  const p = await b.newPage();
  const errs = [];
  p.on('pageerror', e => errs.push(e.message));
  await p.route('**/*', r =>
    r.request().url().startsWith('http://127.0.0.1:' + PORT) ? r.continue() : r.abort());
  await p.goto('http://127.0.0.1:' + PORT + '/brief-console.html', { waitUntil: 'domcontentloaded' });
  await p.waitForTimeout(9000);

  const out = await p.evaluate(() => {
    const contextItems = [
      { source:'rss:u.today@self', title:'XRP Rises 54% From $1 Support Level, Escrow Dynamics Remain Unchanged', url:'https://u.today/context-a' },
      { source:'google_news@self', title:'XRP Futures Volume Hits 9-Month High Amid Price Surge', url:'https://news.google.com/context-b' },
      { source:'rss:cryptoslate@self', title:'Europe central banks debate stablecoin reserve safeguards', url:'https://cryptoslate.com/context-c' },
      { source:'rss:coinpedia@self', title:'Solana Price Prediction 2030', url:'https://coinpedia.org/junk' }
    ];
    const weakPack = {
      date:'2026-09-23', wallets_checked:418, watchlist_total:418,
      xrp_price:1.5652, xrp_delta_24h_pct:1.55, xrp_volume_24h:5400000000,
      shadow_volume_xrp:778560000, large_transfers_count:200, large_transfers:[],
      total_balance_delta_xrp:26980000, risk_score:{score:69,label:'ORANGE',drivers:[]},
      news_articles:[{ title:'XRP price today.' }],
      news_intel:{ items:contextItems, top_headlines:contextItems },
      tx_scan_coverage:{target_wallets:418,complete_wallets:418,failed_wallets:0,truncated_wallets:0,unproven_wallets:0,not_checked_wallets:0,full_window_complete:true}
    };
    const strong = { source:'U.Today', title:'XRP ETF inflows hit record as SEC signals clarity', url:'https://u.today/strong' };
    const strongPack = {
      ...weakPack,
      news_articles:[strong],
      news_intel:{items:[strong],top_headlines:[strong]}
    };

    const G = window.MORNING_NEWS_GOVERNOR;
    const weakSources = window.buildMorningStorySources(weakPack);
    const strictWeak = window.clearedMorningNewsSources(weakPack);
    const weakAssembled = window.PUBLIC_REPORT_PIPELINE_V1.assemble(weakPack).text;
    const weakCanonical = window.canonicalMorningStory(weakPack, { rebuild:true });

    window.MORNING_REPORT_FLOAT.show('BODY', weakSources, weakPack);
    const floatEl = document.getElementById('morningReportFloat');
    const drawer = floatEl && floatEl.querySelector('#mrfSources');
    const drawerText = drawer ? drawer.textContent : '';
    const drawerLinks = drawer ? drawer.querySelectorAll('a.mrf-src-link').length : 0;
    window.MORNING_REPORT_FLOAT.hide();

    const strongSources = window.buildMorningStorySources(strongPack);
    const strictStrong = window.clearedMorningNewsSources(strongPack);

    return {
      patchLoaded: !!window.SW_NEWS_CONTEXT_SOURCE_VISIBILITY_20260923,
      weakGate: G.publicSourcesCleared(weakPack),
      strongGate: G.publicSourcesCleared(strongPack),
      weakCount: weakSources.length,
      weakContextOnly: weakSources.length > 0 && weakSources.every(s => s._context_only === true),
      weakSourceNames: weakSources.map(s => s.source),
      strictWeakCount: strictWeak.length,
      footer: weakAssembled.slice(weakAssembled.lastIndexOf('SOURCES')),
      footerHasContextNote: /Context only/.test(weakAssembled),
      footerHasFetched: /XRP Rises 54%|XRP Futures Volume Hits 9-Month High/.test(weakAssembled),
      footerNoFalseEmpty: !/No external sources for today/.test(weakAssembled),
      footerDropsJunk: !/Solana Price Prediction/.test(weakAssembled),
      canonicalNoNewsUsed: !/\nNEWS USED:/.test(weakCanonical),
      canonicalNoNewsImpactClaim: !/Published news context:|Relevant headline:/.test(weakCanonical),
      drawerText, drawerLinks,
      drawerContextLabel: /CONTEXT SOURCES/.test(drawerText) && /None cleared the Morning News Governor/i.test(drawerText),
      strongCount: strongSources.length,
      strongContextOnly: strongSources.some(s => s._context_only === true),
      strictStrongCount: strictStrong.length
    };
  });

  console.log('NEWS CONTEXT SOURCE VISIBILITY\n');
  check('patch module loaded', out.patchLoaded);
  check('weak pack still fails Governor narrative gate', out.weakGate === false, out.weakGate);
  check('strong pack still clears Governor narrative gate', out.strongGate === true, out.strongGate);
  check('weak pack still has context sources', out.weakCount >= 2, out.weakCount);
  check('weak sources are explicitly context-only', out.weakContextOnly, out.weakSourceNames);
  check('internal rss: labels are normalized instead of deleting the source',
    out.weakSourceNames.every(x => !/^rss:/i.test(String(x))), out.weakSourceNames);
  check('strict NEWS USED source list stays empty for weak pack', out.strictWeakCount === 0, out.strictWeakCount);
  check('public SOURCES footer says context only', out.footerHasContextNote, out.footer);
  check('public SOURCES footer lists fetched XRP context', out.footerHasFetched, out.footer);
  check('public SOURCES footer no longer lies that there were no external sources', out.footerNoFalseEmpty, out.footer);
  check('public SOURCES footer still drops unrelated junk', out.footerDropsJunk, out.footer);
  check('weak pack still produces no NEWS USED block', out.canonicalNoNewsUsed);
  check('weak pack still produces no narrative news-impact claim', out.canonicalNoNewsImpactClaim);
  check('floating drawer labels context sources honestly', out.drawerContextLabel, out.drawerText);
  check('floating drawer keeps clickable context links', out.drawerLinks >= 2, out.drawerLinks);
  check('strong pack still returns strict cleared sources', out.strongCount >= 1 && out.strictStrongCount >= 1,
    {strong:out.strongCount,strict:out.strictStrongCount});
  check('strong sources are not mislabeled context-only', out.strongContextOnly === false, out.strongContextOnly);
  check('no page errors', errs.length === 0, errs.slice(0,3));

  await b.close(); srv.close();
  console.log('\n' + (fail ? fail + ' FAILED of ' + (pass + fail) : 'ALL ' + pass + ' CHECKS PASS'));
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
