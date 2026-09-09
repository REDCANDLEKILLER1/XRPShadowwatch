#!/usr/bin/env node
/* ── A FIRST READING IS NOT A GAIN ────────────────────────────────────────────
   SW-20260907-2GAKH, a real operator run. The SAME structured report said:

     "the tracked wallet board has no prior balances on this device yet, so net
      flow is not measurable on this run"

   and, in its Shadow Watch, Anomaly and Holder Dominance sections:

     "Ripple gained +1.33B XRP."
     "Bithumb gained +1.84B XRP."
     "Cluster net +316.34M XRP — investigate as ONE entity, not three."
     "Founder Wallets ... HISTORICALLY RARE — investigate."
     "Dormant Whales ... HIGH-SIGNIFICANCE awakening."
     "Highest active accumulator: Bithumb (+1.84B XRP this window)"

   Both from one scan. Only the first was true.

   THE MECHANISM, in the merged source:

       const n = v => Number(v) || 0;
       delta = n(w.balance_xrp) - n(w.prev_balance_xrp)

   n() maps null to 0, so with no stored prior reading the expression became
   `balance - 0` and every wallet's ENTIRE HOLDING was rendered as this
   window's movement. The aggregate escaped only by accident: totalDeltaXRP
   sums w.delta_xrp, which balanceOne correctly leaves null, so NET DELTA read
   0 XRP while the per-wallet lines read in the billions.

   These tests drive the REAL report builders against packs whose wallets have
   no prior balance, mixed baselines, and genuine measured zeroes.

   Run: node scripts/first-scan-baseline-truth.test.js
   Env: SW_TEST_PORT to override the port (default 8219).
──────────────────────────────────────────────────────────────────────────── */
'use strict';

const http = require('http');
const fs   = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const PORT = Number(process.env.SW_TEST_PORT || 8219);
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
  await page.waitForFunction(() => typeof window.walletDelta === 'function', null, { timeout: 60000 });

  // ══════════════════════════════════════════════════════════════════════════
  console.log('\n1. the delta primitive refuses to invent a baseline');
  const r1 = await page.evaluate(() => {
    const W = window.walletDelta;
    return {
      noPrev:      W({ balance_xrp: 1330000000, prev_balance_xrp: null }),
      undefPrev:   W({ balance_xrp: 1330000000 }),
      emptyPrev:   W({ balance_xrp: 1330000000, prev_balance_xrp: '' }),
      measured:    W({ balance_xrp: 1000, prev_balance_xrp: 400 }),
      measuredNeg: W({ balance_xrp: 400,  prev_balance_xrp: 1000 }),
      genuineZero: W({ balance_xrp: 1000, prev_balance_xrp: 1000 }),
      zeroPrev:    W({ balance_xrp: 1000, prev_balance_xrp: 0 }),
      nanPrev:     W({ balance_xrp: 1000, prev_balance_xrp: 'abc' })
    };
  });
  console.log('     ' + JSON.stringify(r1));
  check('THE REGRESSION — a missing prior balance yields null, not the whole holding',
        r1.noPrev === null && r1.undefPrev === null && r1.emptyPrev === null, r1);
  check('a real prior balance still measures, in both directions',
        r1.measured === 600 && r1.measuredNeg === -600, r1);
  check('a GENUINE measured zero is 0, and is NOT confused with unmeasurable',
        r1.genuineZero === 0 && r1.genuineZero !== null, r1);
  check('a prior balance of literal zero is a real reading, not a missing one',
        r1.zeroPrev === 1000, r1);
  check('an unparseable prior balance is unmeasurable rather than coerced',
        r1.nanPrev === null, r1);

  // ══════════════════════════════════════════════════════════════════════════
  console.log('\n2. the incident shape: a first scan on a fresh device');
  const r2 = await page.evaluate(() => {
    // The 2GAKH shape: real holdings, no prior reading anywhere.
    const wallets = [
      { address: 'rrrrrrrrrrrrrrrrrrrrrhoLvTp', label: 'RIPPLE ESCROW HUB 1', cat: 'ripple_corp', status: 'CHECKED', balance_xrp: 1330000000, prev_balance_xrp: null, delta_xrp: null },
      { address: 'rrrrrrrrrrrrrrrrrrrrbzbvji',  label: 'BINANCE COLD 1',      cat: 'exchange',    status: 'CHECKED', balance_xrp: 1580000000, prev_balance_xrp: null, delta_xrp: null },
      { address: 'rrrrrrrrrrrrrrrrrNAMEtxvNvQ', label: 'BITHUMB HOT 1',       cat: 'exchange',    status: 'CHECKED', balance_xrp: 1840000000, prev_balance_xrp: null, delta_xrp: null }
    ];
    const pack = { wallet_results: wallets, wallets: wallets, total_balance_delta_xrp: 0 };
    const buckets = {};
    wallets.forEach(w => {
      const grp = window.getWalletGroup ? window.getWalletGroup(w.label || w.address) : w.cat;
      (buckets[grp] = buckets[grp] || []).push(Object.assign({}, w, { delta: window.walletDelta(w) }));
    });
    const sw = window.shadowWatchSection(buckets, pack).join('\n');
    const an = window.anomalySection(buckets, pack, 0).join('\n');
    return {
      baselineNone: window.deltaBaseline(pack).none,
      shadowWatch: sw,
      anomaly: an,
      swClaimsGain: /gained \+|dropped -|lost -/.test(sw),
      // Exclude the unmeasurable notice itself: it contains the words "flat
      // reading can be claimed", which is a DENIAL of a flat reading. Matching
      // it made the assertion fail on correct output.
      swClaimsQuiet: sw.split('\n')
        .filter(l => !/not measurable/i.test(l))
        .some(l => /quiet|flat|still dormant|no local balance shock|cohesive/i.test(l)),
      swNamesUnmeasured: /not measurable/i.test(sw),
      anomalyClaimsEvent: /HISTORICALLY RARE|awakening|anomaly detected/i.test(an),
      anomalyNamesUnmeasured: /did not run|no prior balances/i.test(an),
      anomalyClaimsDrift: /baseline drift/i.test(an)
    };
  });
  console.log('     shadowWatch:\n' + r2.shadowWatch.split('\n').map(l => '        ' + l).join('\n'));
  console.log('     anomaly:\n' + r2.anomaly.split('\n').map(l => '        ' + l).join('\n'));
  check('the pack really is the no-baseline case', r2.baselineNone === true, r2.baselineNone);
  check('THE REGRESSION — no wallet is reported as having gained or lost',
        r2.swClaimsGain === false, r2.shadowWatch);
  check('and no group is reported as quiet, flat or still dormant',
        r2.swClaimsQuiet === false, r2.shadowWatch);
  check('the unmeasured wallets are NAMED, not silently dropped',
        r2.swNamesUnmeasured === true, r2.shadowWatch);
  check('THE REGRESSION — anomaly detection reports that it did not run',
        r2.anomalyClaimsEvent === false && r2.anomalyNamesUnmeasured === true, r2.anomaly);
  check('and does not assert baseline drift over wallets it never compared',
        r2.anomalyClaimsDrift === false, r2.anomaly);

  // ══════════════════════════════════════════════════════════════════════════
  console.log('\n3. CONTROL: a real second scan still reports its real movement');
  const r3 = await page.evaluate(() => {
    const wallets = [
      { address: 'rrrrrrrrrrrrrrrrrrrrrhoLvTp', label: 'RIPPLE ESCROW HUB 1', cat: 'ripple_corp', status: 'CHECKED', balance_xrp: 1330000000, prev_balance_xrp: 1329000000, delta_xrp: 1000000 },
      { address: 'rrrrrrrrrrrrrrrrrrrrbzbvji',  label: 'BINANCE COLD 1',      cat: 'exchange',    status: 'CHECKED', balance_xrp: 1580000000, prev_balance_xrp: 1585000000, delta_xrp: -5000000 },
      { address: 'rrrrrrrrrrrrrrrrrNAMEtxvNvQ', label: 'BITHUMB HOT 1',       cat: 'exchange',    status: 'CHECKED', balance_xrp: 1840000000, prev_balance_xrp: 1838000000, delta_xrp: 2000000 }
    ];
    const pack = { wallet_results: wallets, wallets: wallets, total_balance_delta_xrp: -2000000 };
    const buckets = {};
    wallets.forEach(w => {
      const grp = window.getWalletGroup ? window.getWalletGroup(w.label || w.address) : w.cat;
      (buckets[grp] = buckets[grp] || []).push(Object.assign({}, w, { delta: window.walletDelta(w) }));
    });
    const sw = window.shadowWatchSection(buckets, pack).join('\n');
    const an = window.anomalySection(buckets, pack, -2000000).join('\n');
    return {
      baselineNone: window.deltaBaseline(pack).none,
      shadowWatch: sw,
      anomaly: an,
      swClaimsMovement: /gained \+|dropped -|lost -/.test(sw),
      swNamesUnmeasured: /not measurable/i.test(sw),
      anomalyRan: /did not run/i.test(an),
      // fmt() renders compact: "-5.00M XRP". The balance would be "1.58B".
      mentionsRealFigure: /5\.00M/.test(sw) && !/1\.58B/.test(sw)
    };
  });
  console.log('     shadowWatch:\n' + r3.shadowWatch.split('\n').map(l => '        ' + l).join('\n'));
  check('the control pack is NOT the no-baseline case', r3.baselineNone === false, r3.baselineNone);
  check('CONTROL — real movement is still reported',
        r3.swClaimsMovement === true, r3.shadowWatch);
  check('CONTROL — nothing is called unmeasurable when everything was measured',
        r3.swNamesUnmeasured === false, r3.shadowWatch);
  check('CONTROL — anomaly detection runs', r3.anomalyRan === false, r3.anomaly);
  check('CONTROL — the reported figure is the real delta, not the balance',
        r3.mentionsRealFigure === true, r3.shadowWatch);
  check('CONTROL — no billion-scale holding leaks in as a movement figure',
        !/\dB XRP/.test(r3.shadowWatch), r3.shadowWatch);

  // ══════════════════════════════════════════════════════════════════════════
  console.log('\n4. MIXED: some wallets measured, some new to this device');
  const r4 = await page.evaluate(() => {
    const wallets = [
      { address: 'rrrrrrrrrrrrrrrrrrrrrhoLvTp', label: 'RIPPLE ESCROW HUB 1', cat: 'ripple_corp', status: 'CHECKED', balance_xrp: 1330000000, prev_balance_xrp: 1322000000, delta_xrp: 8000000 },
      { address: 'rrrrrrrrrrrrrrrrrrrrbzbvji',  label: 'BINANCE COLD 1',      cat: 'exchange',    status: 'CHECKED', balance_xrp: 1580000000, prev_balance_xrp: null,       delta_xrp: null },
      { address: 'rrrrrrrrrrrrrrrrrNAMEtxvNvQ', label: 'BITHUMB HOT 1',       cat: 'exchange',    status: 'CHECKED', balance_xrp: 1840000000, prev_balance_xrp: null,       delta_xrp: null }
    ];
    const pack = { wallet_results: wallets, wallets: wallets, total_balance_delta_xrp: 8000000 };
    const buckets = {};
    wallets.forEach(w => {
      const grp = window.getWalletGroup ? window.getWalletGroup(w.label || w.address) : w.cat;
      (buckets[grp] = buckets[grp] || []).push(Object.assign({}, w, { delta: window.walletDelta(w) }));
    });
    const db = window.deltaBaseline(pack);
    const sw = window.shadowWatchSection(buckets, pack).join('\n');
    return {
      partial: db.partial, none: db.none, measured: db.measured, checked: db.checked,
      shadowWatch: sw,
      reportsTheMeasuredOne: /8\.00M/.test(sw) && !/1\.33B/.test(sw),
      // the two unmeasured must not appear as movers at ANY size
      claimsBinance: /BINANCE[^\n]*(gained|dropped|lost|quiet|flat)/i.test(sw),
      claimsBithumb: /BITHUMB[^\n]*(gained|dropped|lost|quiet|flat)/i.test(sw),
      namesUnmeasuredCount: /not measurable for 2 wallets/i.test(sw)
    };
  });
  console.log('     shadowWatch:\n' + r4.shadowWatch.split('\n').map(l => '        ' + l).join('\n'));
  check('the mixed pack is partial, not none', r4.partial === true && r4.none === false, r4);
  check('the measured wallet IS reported', r4.reportsTheMeasuredOne === true, r4.shadowWatch);
  check('THE REGRESSION — the unmeasured wallets are not called movers OR quiet',
        r4.claimsBinance === false && r4.claimsBithumb === false, r4.shadowWatch);
  check('and the count of unmeasured wallets is stated exactly',
        r4.namesUnmeasuredCount === true, r4.shadowWatch);

  // ══════════════════════════════════════════════════════════════════════════
  console.log('\n5. GENUINE MEASURED ZERO is not the same as unmeasurable');
  const r5 = await page.evaluate(() => {
    const wallets = [
      { address: 'rrrrrrrrrrrrrrrrrrrrrhoLvTp', label: 'RIPPLE ESCROW HUB 1', cat: 'ripple_corp', status: 'CHECKED', balance_xrp: 1330000000, prev_balance_xrp: 1330000000, delta_xrp: 0 },
      { address: 'rrrrrrrrrrrrrrrrrrrrbzbvji',  label: 'BINANCE COLD 1',      cat: 'exchange',    status: 'CHECKED', balance_xrp: 1580000000, prev_balance_xrp: 1580000000, delta_xrp: 0 }
    ];
    const pack = { wallet_results: wallets, wallets: wallets, total_balance_delta_xrp: 0 };
    const buckets = {};
    wallets.forEach(w => {
      const grp = window.getWalletGroup ? window.getWalletGroup(w.label || w.address) : w.cat;
      (buckets[grp] = buckets[grp] || []).push(Object.assign({}, w, { delta: window.walletDelta(w) }));
    });
    const sw = window.shadowWatchSection(buckets, pack).join('\n');
    const an = window.anomalySection(buckets, pack, 0).join('\n');
    return {
      none: window.deltaBaseline(pack).none,
      shadowWatch: sw, anomaly: an,
      saysQuiet: /quiet|flat|no local balance shock/i.test(sw),
      saysUnmeasurable: /not measurable/i.test(sw),
      anomalyBelowThreshold: /below the 100k XRP threshold/i.test(an)
    };
  });
  console.log('     shadowWatch:\n' + r5.shadowWatch.split('\n').map(l => '        ' + l).join('\n'));
  check('a board measured at zero is NOT the no-baseline case', r5.none === false, r5.none);
  check('CONTROL — a genuinely flat board may still be called flat',
        r5.saysQuiet === true, r5.shadowWatch);
  check('and is never described as unmeasurable', r5.saysUnmeasurable === false, r5.shadowWatch);
  check('anomaly reports below-threshold, which is a real comparison',
        r5.anomalyBelowThreshold === true, r5.anomaly);

  // ══════════════════════════════════════════════════════════════════════════
  console.log('\n6. the accumulator ranking cannot crown the largest holder');
  const r6 = await page.evaluate(() => {
    const mk = (label, bal, prev) => ({
      address: 'r' + label.replace(/[^A-Za-z0-9]/g, '').padEnd(25, 'x').slice(0, 25),
      label, cat: 'exchange', status: 'CHECKED',
      balance_xrp: bal, prev_balance_xrp: prev,
      delta_xrp: prev === null ? null : bal - prev
    });
    // The whale holds 1.84B but has NO baseline; the small wallet genuinely
    // gained 5M. Ranking on balance-minus-zero would crown the whale.
    const noBase = { wallet_results: [ mk('BITHUMB HOT 1', 1840000000, null), mk('SMALL EXCHANGE', 20000000, 15000000) ] };
    const allNew = { wallet_results: [ mk('BITHUMB HOT 1', 1840000000, null), mk('SMALL EXCHANGE', 20000000, null) ] };
    const pick = (pack) => {
      const acc = window.measuredMovers(pack.wallet_results.filter(w => w.status === 'CHECKED'))
        .filter(w => w.delta > 100000).sort((a, b) => b.delta - a.delta);
      return acc.length ? { label: acc[0].label, delta: acc[0].delta } : null;
    };
    return { mixed: pick(noBase), allNew: pick(allNew) };
  });
  console.log('     ' + JSON.stringify(r6));
  check('THE REGRESSION — the accumulator is the one that actually gained, not the biggest holder',
        !!r6.mixed && r6.mixed.label === 'SMALL EXCHANGE' && r6.mixed.delta === 5000000, r6.mixed);
  check('and with no baselines at all there is no accumulator to name',
        r6.allNew === null, r6.allNew);

  check('no page errors', errs.length === 0, errs.slice(0, 3));

  await browser.close(); srv.close();
  console.log('\n' + (fail ? fail + ' FAILED of ' + (pass + fail) : 'ALL ' + pass + ' CHECKS PASS'));
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
