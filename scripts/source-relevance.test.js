#!/usr/bin/env node
/* ── SOURCE RELEVANCE — an XRP report cites XRP sources ───────────────────────
   SW-20260813-2EZ7P cited Zcash, Pump.fun, a Solar/SXP 2030 price prediction,
   Circle stock, and a story about Google's AI — in an XRP forensic report. Two
   of the eight citations were about XRP.

   A citation block is a claim that these sources informed the report. Padding
   it with unrelated coins is not neutral: it buries the relevant ones and
   implies a basis the report does not have.

   Committed from a scratchpad harness that had been run by hand on every PR
   without ever being in the repo — CI cannot run what is not committed. The
   single pass/fail boolean it used has been split into named checks so a
   failure says which property broke.

   Run: node scripts/source-relevance.test.js
   Env: SW_TEST_PORT to override the port (default 8305).
──── */
'use strict';

const http = require('http');
const fs   = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const PORT = Number(process.env.SW_TEST_PORT || 8305);
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
  const p = await b.newPage(); const errs = [];
  p.on('pageerror', e => errs.push(e.message));
  await p.route('**/*', r =>
    r.request().url().startsWith('http://127.0.0.1:' + PORT) ? r.continue() : r.abort());
  await p.goto('http://127.0.0.1:' + PORT + '/brief-console.html', { waitUntil: 'domcontentloaded' });
  await p.waitForTimeout(9000);

  console.log('SOURCE RELEVANCE\n');

  const out = await p.evaluate(() => {
    const R = {};
    // the exact eight from the report, in the order they were printed
    const REAL = [
      {source:'coingape',   title:'XRP Price Outlook as Selling Pressure Hits Highest Level Since May Amid $1 Support Retest', url:'https://coingape.com/a'},
      {source:'u.today',    title:'XRP Hits Lowest Level Since November 2024, But Market Activity Is Surging', url:'https://u.today/b'},
      {source:'cryptoslate',title:'Zcash is borrowing crypto’s new institutional playbook as privacy goes mainstream', url:'https://cryptoslate.com/c'},
      {source:'coinpedia',  title:'PUMP Price Rally Picks Momentum—But Can Bulls Push Pump.fun Above $0.003?', url:'https://coinpedia.org/d'},
      {source:'beincrypto', title:'Rare Evo Conference 2026: Awaiting Clarity & The Agentic Economy Arrives', url:'https://beincrypto.com/e'},
      {source:'coinpedia',  title:'New ICODA Data: Google’s AI Cites Crypto News Sites Four Times Less Than ChatGPT and Perplexity', url:'https://coinpedia.org/f'},
      {source:'coingape',   title:'Circle Stock Prediction Ahead of U.S. Initial Jobless Claims Today', url:'https://coingape.com/g'},
      {source:'coinpedia',  title:'Solar Price Prediction 2026, 2027 – 2030: Should You Buy SXP?', url:'https://coinpedia.org/h'}
    ];
    const kept = filterSourcesForReport(REAL);
    R.kept = kept.map(x => ({ p:x._priority, t:x.title.slice(0,52) }));
    R.text = renderPlainTextSources(kept);
    const T = R.text;
    R.dropsJunk = !/Zcash|Pump\.fun|SXP|Circle Stock|Google’s AI/.test(T);
    R.keepsXRP  = /XRP Price Outlook/.test(T) && /XRP Hits Lowest/.test(T);

    // a genuinely XRP-rich day must keep them all, not truncate to the floor
    const RICH = [
      {source:'a',title:'Ripple RLUSD stablecoin custody expands to three banks',url:'https://x/1'},
      {source:'b',title:'XRP ETF inflows hit record as SEC signals clarity',url:'https://x/2'},
      {source:'c',title:'XRPL AMM liquidity doubles after Clarity Act vote',url:'https://x/3'},
      {source:'d',title:'Upbit and Bithumb report XRP volume surge',url:'https://x/4'},
      {source:'e',title:'Zcash privacy coin rally continues',url:'https://x/5'}
    ];
    const rich = filterSourcesForReport(RICH);
    R.richCount = rich.length;
    R.richDropsZcash = !rich.some(x => /Zcash/.test(x.title));

    // an all-junk day yields a SHORT block, not a padded one — and never junk
    const JUNK = [
      {source:'a',title:'Solar Price Prediction 2030: Should You Buy SXP?',url:'https://x/9'},
      {source:'b',title:'PUMP Price Rally Picks Momentum',url:'https://x/10'},
      {source:'c',title:'DOGE memecoin hype returns',url:'https://x/11'}
    ];
    R.junkKept = filterSourcesForReport(JUNK).length;

    // BTC context is allowed to backfill, but only up to the floor
    const THIN = [
      {source:'a',title:'XRP ledger sees record payments',url:'https://x/12'},
      {source:'b',title:'Bitcoin whale moves 4,000 BTC',url:'https://x/13'},
      {source:'c',title:'Ethereum staking hits new high',url:'https://x/14'},
      {source:'d',title:'Solana outage resolved',url:'https://x/15'},
      {source:'e',title:'SHIB burn rate spikes',url:'https://x/16'}
    ];
    const thin = filterSourcesForReport(THIN);
    R.thinCount = thin.length;
    R.thinNoMeme = !thin.some(x => /SHIB/.test(x.title));
    R.empty = filterSourcesForReport([]).length;
    return R;
  });
  console.log('  kept from the real 8:');
  out.kept.forEach(k => console.log('    p' + k.p + '  ' + k.t));
  console.log('\n' + out.text + '\n');

  console.log('1. the 2026-08-13 citation block');
  check('unrelated coins are dropped (Zcash, Pump.fun, SXP, Circle, Google AI)',
        out.dropsJunk, out.text.slice(0, 200));
  check('the two XRP stories are kept', out.keepsXRP);
  check('exactly the 2 XRP-relevant citations survive', out.kept.length === 2, out.kept);

  console.log('\n2. a genuinely XRP-rich day is not truncated to the floor');
  check('all 4 XRP-relevant stories kept', out.richCount === 4, out.richCount);
  check('Zcash still dropped on a rich day', out.richDropsZcash);

  console.log('\n3. a quiet day gets a short block, never a padded one');
  check('an all-junk day cites nothing', out.junkKept === 0, out.junkKept);
  check('an empty pool cites nothing', out.empty === 0, out.empty);

  console.log('\n4. BTC/ETH may backfill to the floor, memecoins never');
  check('backfill reaches the floor of 3', out.thinCount === 3, out.thinCount);
  check('SHIB is not admitted as backfill', out.thinNoMeme);

  check('no page errors', errs.length === 0, errs.slice(0, 3));

  await b.close(); srv.close();
  console.log('\n' + (fail ? fail + ' FAILED of ' + (pass + fail) : 'ALL ' + pass + ' CHECKS PASS'));
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
