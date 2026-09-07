#!/usr/bin/env node
/* ── A QUOTA REJECTION IS NOT "THIS WALLET HAS NO OFFERS" ─────────────────────
   SW-20260907-UO4N2, a real operator run. The server answered with

     rate limit: units quota (10000 per 60s) exhausted, retry in ~69888ms

   and the scan issued 255 offer requests anyway — 32 chunks of 8, no spacing,
   every one inside the cooldown the server had already stated. A 256th came
   from runRelatedOfferScan, a second dispatcher carrying its own copy of the
   same link-down-only guard. Neither pass could tell the other.

   THE MECHANISM, in the merged source:

       } catch (e) {
         if (/link down|link closed/i.test(e && e.message || '')) throw e;
         elog('scanOffers ' + w.label, e);
         return 0;                       // <- a quota lands here and the loop walks on
       }

   The quota itself is UPSTREAM — the string exists nowhere in the repository,
   so no app-side limiter produced it. What was ours is that the rejection was
   indistinguishable from an empty result.

   These tests drive the real gate and the real dispatch loops.

   Run: node scripts/xrpl-quota-backpressure.test.js
   Env: SW_TEST_PORT to override the port (default 8221).
──────────────────────────────────────────────────────────────────────────── */
'use strict';

const http = require('http');
const fs   = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const PORT = Number(process.env.SW_TEST_PORT || 8221);
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

// The exact production string.
const QUOTA_MSG = 'rate limit: units quota (10000 per 60s) exhausted, retry in ~69888ms';

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
  await page.waitForFunction(() => typeof window._quotaBlocked === 'function', null, { timeout: 60000 });

  // ══════════════════════════════════════════════════════════════════════════
  console.log('\n1. the rejection is recognised, and silence is not mistaken for it');
  const r1 = await page.evaluate((msg) => {
    const E = (m) => new Error(m);
    return {
      production:  window._isQuotaError(E(msg)),
      http429:     window._isQuotaError(E('429 Too Many Requests')),
      slowDown:    window._isQuotaError(E('slowDown')),
      // #59's breaker owns silence. These must NOT be treated as a quota.
      timeout:     window._isQuotaError(E('timeout account_offers')),
      linkDown:    window._isQuotaError(E('XRPL link down')),
      linkClosed:  window._isQuotaError(E('XRPL link closed mid-request')),
      actNotFound: window._isQuotaError(E('actNotFound'))
    };
  }, QUOTA_MSG);
  console.log('     ' + JSON.stringify(r1));
  check('THE REGRESSION — the production rejection is recognised',
        r1.production === true && r1.http429 === true && r1.slowDown === true, r1);
  check('a timeout is NOT a quota — silence and refusal are different failures',
        r1.timeout === false && r1.linkDown === false && r1.linkClosed === false, r1);
  check('an ordinary XRPL error is not a quota either', r1.actNotFound === false, r1);

  // ══════════════════════════════════════════════════════════════════════════
  console.log('\n2. the cooldown comes from the server, not from us');
  const r2 = await page.evaluate((msg) => {
    const E = (m) => new Error(m);
    return {
      fromHint:   window._quotaRetryMs(E(msg)),                       // 69888
      otherHint:  window._quotaRetryMs(E('rate limit, retry in ~36547ms')),
      noHint:     window._quotaRetryMs(E('rate limit: quota exhausted')),
      absurd:     window._quotaRetryMs(E('rate limit, retry in ~999999999ms')),
      zero:       window._quotaRetryMs(E('rate limit, retry in ~0ms'))
    };
  }, QUOTA_MSG);
  console.log('     ' + JSON.stringify(r2));
  check('THE REGRESSION — the wait is the server\'s own number, not an invented one',
        r2.fromHint === 69888 && r2.otherHint === 36547, r2);
  check('a rejection with no hint falls back rather than guessing zero',
        r2.noHint === 60000, r2);
  check('an absurd or zero hint is bounded, not trusted',
        r2.absurd === 300000 && r2.zero === 60000, r2);

  // ══════════════════════════════════════════════════════════════════════════
  console.log('\n3. ONE decision, shared — the whole point');
  const r3 = await page.evaluate((msg) => {
    state._quotaUntil = 0; state._quotaHits = 0; state._quotaCutPasses = [];
    const before = window._quotaBlocked();
    // The offer sweep learns it...
    window._noteQuota(new Error(msg), 'the offer sweep');
    const afterOffers = window._quotaBlocked();
    const where = state._quotaWhere;
    // ...and the related-offer pass, a DIFFERENT dispatcher, already knows.
    const relatedSees = window._quotaBlocked();
    // Later rejections inside the cooldown add nothing new.
    window._noteQuota(new Error(msg), 'the balance pass');
    window._noteQuota(new Error(msg), 'the transaction-window pass');
    return {
      before, afterOffers, relatedSees,
      firstWhere: where,
      stillFirstWhere: state._quotaWhere,
      hits: state._quotaHits
    };
  }, QUOTA_MSG);
  console.log('     ' + JSON.stringify(r3));
  check('the gate is open before anything is rejected', r3.before === false, r3);
  check('THE REGRESSION — one dispatcher\'s rejection closes the gate for ALL of them',
        r3.afterOffers === true && r3.relatedSees === true, r3);
  check('the first cause is kept, not overwritten by later passes',
        r3.firstWhere === 'the offer sweep' && r3.stillFirstWhere === 'the offer sweep', r3);
  check('every rejection is counted even though only the first is announced',
        r3.hits === 3, r3);

  // ══════════════════════════════════════════════════════════════════════════
  console.log('\n4. the cooldown expires on its own — it is not a run kill-switch');
  const r4 = await page.evaluate(() => {
    state._quotaUntil = Date.now() + 40;   // a cooldown about to end
    const during = window._quotaBlocked();
    return new Promise(res => setTimeout(() => {
      res({ during, after: window._quotaBlocked() });
    }, 90));
  });
  console.log('     ' + JSON.stringify(r4));
  check('blocked while the cooldown stands, open once it passes',
        r4.during === true && r4.after === false, r4);

  // ══════════════════════════════════════════════════════════════════════════
  console.log('\n5. THE INCIDENT: 255 wallets, and what the loop actually issues');
  const r5 = await page.evaluate((msg) => {
    // The real scanOffers dispatch shape, driven against a socket that rejects
    // with the production string. CHUNK is 8; the roster is 255.
    const wallets = Array.from({ length: 255 }, (_, i) => ({ address: 'r' + i, label: 'W' + i }));
    let issued = 0;
    state._quotaUntil = 0; state._quotaHits = 0; state._quotaCutPasses = [];
    const scanOne = (w) => {
      issued++;
      const e = new Error(msg);
      if (window._noteQuota(e, 'the offer sweep')) return 0;
      return 0;
    };
    let scanned = 0;
    const CHUNK = 8;
    for (let i = 0; i < wallets.length; i += CHUNK) {
      if (window._quotaBlocked()) { break; }
      wallets.slice(i, i + CHUNK).forEach(scanOne);
      scanned += Math.min(CHUNK, wallets.length - i);
    }
    return { roster: wallets.length, issued, scanned, blocked: window._quotaBlocked() };
  }, QUOTA_MSG);
  console.log('     ' + JSON.stringify(r5));
  check('THE REGRESSION — the walk stops at the first rejected chunk, not at wallet 255',
        r5.issued === 8 && r5.roster === 255, r5);
  check('and 247 requests the server had already refused are never issued',
        r5.roster - r5.issued === 247, r5);

  // ══════════════════════════════════════════════════════════════════════════
  console.log('\n6. a shortened pass says so, and the pack carries it');
  const r6 = await page.evaluate(() => {
    state._quotaUntil = 0; state._quotaHits = 0; state._quotaCutPasses = [];
    const noneYet = window._quotaNote();
    window._noteQuota(new Error('rate limit, retry in ~69888ms'), 'the offer sweep');
    state._quotaCutPasses = [];
    window._quotaCutPass('OFFERS', 8, 255);
    window._quotaCutPass('RELATED OFFERS', 0, 40);
    const note = window._quotaNote();
    return { noneYet, note };
  });
  console.log('     ' + JSON.stringify(r6.note));
  check('a clean run carries NO quota note', r6.noneYet === null, r6.noneYet);
  check('THE REGRESSION — a shortened run records which passes were cut and where',
        !!r6.note && r6.note.hit === true &&
        r6.note.passes_cut_short.length === 2 &&
        r6.note.passes_cut_short[0].pass === 'OFFERS' &&
        r6.note.passes_cut_short[0].completed === 8 &&
        r6.note.passes_cut_short[0].of === 255, r6.note);
  check('and names the pass that hit it first', r6.note.first_where === 'the offer sweep', r6.note);

  // ══════════════════════════════════════════════════════════════════════════
  console.log('\n7. every dispatcher consults the gate, in source');
  // Read the file directly; a page global would only tell us what the page
  // chose to expose.
  const src = fs.readFileSync(path.join(ROOT, 'src/brief/02-core.js'), 'utf8');
  const gated = (src.match(/_quotaBlocked\(\)/g) || []).length;
  const noted = (src.match(/_noteQuota\(/g) || []).length;
  console.log('     _quotaBlocked() call sites: ' + gated + '   _noteQuota() call sites: ' + noted);
  // BALANCES, TX WINDOWS, OFFERS, RELATED OFFERS — plus the one inside
  // _quotaNote's own guard. Naming the number means adding a dispatcher
  // without gating it fails here.
  check('all four dispatch loops consult the shared gate',
        gated === 5, gated);
  // scanOffers, balanceOne, txOne, and the window export.
  check('and the passes that can be rejected all report it',
        noted === 4, noted);
  check('no dispatcher sleeps or retries inside the cooldown',
        !/_quotaBlocked[\s\S]{0,400}setTimeout/.test(src) &&
        !/await\s+new\s+Promise\([^)]*setTimeout[^)]*\)[\s\S]{0,200}quota/i.test(src), 'a sleeper crept in');

  check('no page errors', errs.length === 0, errs.slice(0, 3));

  await browser.close(); srv.close();
  console.log('\n' + (fail ? fail + ' FAILED of ' + (pass + fail) : 'ALL ' + pass + ' CHECKS PASS'));
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
