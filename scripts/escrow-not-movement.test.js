#!/usr/bin/env node
/* ── ESCROW IS NOT ORDINARY MOVEMENT ──────────────────────────────────────────
   From the live run SW-20260902-76DY2, not a fixture invented for the test.

   That board carried 59 rows in `large_transfers` totalling 1,861,898,167 XRP.
   Two of them were EscrowCreates — 200,000,000 and 10,000,000 — classified
   WATCHLIST_INTERNAL. The risk engine reads `pack.large_transfers.length` and
   `pack.shadow_volume_xrp` directly and names both as scoring drivers, so a
   scheduled lock was being scored as whale activity.

   THE FIX IS A SPLIT, NOT A DELETE. Escrow leaves the risk input and stays
   available to discovery and the live surfaces, because the destination of an
   EscrowCreate is a real, investigable address — often the most interesting one
   on the board.

   The three things this suite exists to stop:
     1. escrow inflating movement counts, shadow volume, and therefore risk;
     2. the fix silently costing discovery its reach (the naive version);
     3. the fix using the WRONG predicate and deleting real payments
        (ESCROW_FLOW is an ordinary Payment from an escrow-category wallet).

   Run: node scripts/escrow-not-movement.test.js
   Env: SW_TEST_PORT to override the port (default 8321).
──────────────────────────────────────────────────────────────────────────── */
'use strict';

const http = require('http');
const fs   = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const PORT = Number(process.env.SW_TEST_PORT || 8321);
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
  await page.waitForFunction(() =>
    typeof window.analyzeFlags === 'function' &&
    typeof window.classify === 'function' &&
    typeof window.buildPack === 'function', null, { timeout: 60000 });

  console.log('ESCROW IS NOT ORDINARY MOVEMENT — SW-20260902-76DY2\n');

  const r = await page.evaluate(() => {
    const out = {};
    const LOCK_DEST_A = 'rEscrowDestAAAAAAAAAAAAAAAAAAAAAAA';
    const LOCK_DEST_B = 'rEscrowDestBBBBBBBBBBBBBBBBBBBBBBB';
    const PLAIN_DEST  = 'rPlainDestCCCCCCCCCCCCCCCCCCCCCCCC';
    const ESC_CAT_SND = 'rEscrowCatSenderDDDDDDDDDDDDDDDDDD';
    const iso = new Date().toISOString();

    // The real board, reduced to what analyzeFlags reads: two escrow locks
    // (the actual 200M and 10M) plus one ordinary whale move.
    const TXS = [
      { account: 'rOwner1', label: 'SPLITTER_rNASJd', type: 'EscrowCreate',
        hash: 'A'.repeat(64), date: iso, from: 'rOwner1', to: LOCK_DEST_A,
        amount: 200000000, currency: 'XRP', destination_tag: '' },
      { account: 'rOwner2', label: 'Flare Core Vault', type: 'EscrowCreate',
        hash: 'B'.repeat(64), date: iso, from: 'rOwner2', to: LOCK_DEST_B,
        amount: 10000000, currency: 'XRP', destination_tag: '' },
      { account: 'rWhale', label: 'WHALE_TEST', type: 'Payment',
        hash: 'C'.repeat(64), date: iso, from: 'rWhale', to: PLAIN_DEST,
        amount: 1651898167, currency: 'XRP', destination_tag: '' }
    ];

    const realTxs = state.txs, realLarge = state.large, realEscrow = state.escrowLarge;
    try {
      state.txs = TXS.slice();
      analyzeFlags();
      const large = state.large || [];
      const esc   = state.escrowLarge || [];

      out.largeCount  = large.length;
      out.escrowCount = esc.length;
      out.largeTotal  = large.reduce((a, t) => a + Number(t.amount || 0), 0);
      out.escrowTotal = esc.reduce((a, t) => a + Number(t.amount || 0), 0);
      out.largeHasNoEscrowType = !large.some(t =>
        t.type === 'EscrowCreate' || t.type === 'EscrowFinish' || t.type === 'EscrowCancel');
      out.escrowRowsKept = esc.length === 2 &&
        esc.some(t => Number(t.amount) === 200000000) &&
        esc.some(t => Number(t.amount) === 10000000);

      // ── THE PREDICATE TRAP ────────────────────────────────────────────
      // ESCROW_FLOW is what classify() assigns to an ORDINARY Payment sent
      // from a wallet whose watchlist category is `escrow`. It is a real
      // payment. 10-pipeline's _isEscrowMove matches it; using that predicate
      // here would delete it from movement, volume and discovery.
      state.txs = [{ account: ESC_CAT_SND, label: 'RIPPLE_ESCROW_CAT', type: 'Payment',
        hash: 'D'.repeat(64), date: iso, from: ESC_CAT_SND, to: PLAIN_DEST,
        amount: 5000000, currency: 'XRP', destination_tag: '' }];
      // KNOWN is `const KNOWN = ...` at 02-core.js:377 — a LEXICAL global, NOT a
      // window property. Guarding on window.KNOWN silently skipped this setup and
      // made the "stays in movement" assertion pass on a row that was never
      // escrow-category at all. Use the bare binding.
      const hasKnown = (typeof KNOWN !== 'undefined');
      const prevKnown = hasKnown ? KNOWN[ESC_CAT_SND] : undefined;
      try {
        if (hasKnown) KNOWN[ESC_CAT_SND] = { label: 'RIPPLE_ESCROW_CAT', cat: 'escrow' };
        analyzeFlags();
        const l2 = state.large || [], e2 = state.escrowLarge || [];
        out.flowClassification = (l2[0] || e2[0] || {}).classification;
        out.escrowFlowStaysInMovement = l2.length === 1 && (e2.length === 0);
        out.escrowFlowAmount = l2.length ? Number(l2[0].amount) : null;
      } finally {
        if (hasKnown) {
          if (prevKnown) KNOWN[ESC_CAT_SND] = prevKnown; else delete KNOWN[ESC_CAT_SND];
        }
      }

      // ── DISCOVERY MUST STILL REACH THE ESCROW DESTINATION ─────────────
      state.txs = TXS.slice();
      analyzeFlags();
      const pack = { large_transfers: state.large, escrow_transfers: state.escrowLarge };
      const both = (typeof _movementAndEscrow === 'function') ? _movementAndEscrow(pack) : [];
      out.dualReadCount = both.length;
      out.dualReadHasEscrowDest =
        both.some(t => t.to === LOCK_DEST_A) && both.some(t => t.to === LOCK_DEST_B);
      out.dualReadHasOrdinary = both.some(t => t.to === PLAIN_DEST);
    } catch (e) {
      out.err = String(e && e.message);
    } finally {
      state.txs = realTxs; state.large = realLarge; state.escrowLarge = realEscrow;
    }
    return out;
  });

  console.log('1. the split itself');
  console.log('     ordinary: ' + r.largeCount + ' rows / ' + r.largeTotal + ' XRP');
  console.log('     escrow  : ' + r.escrowCount + ' rows / ' + r.escrowTotal + ' XRP');
  check('analyzeFlags ran', !r.err, r.err);
  check('ordinary movement holds 1 row, not 3', r.largeCount === 1, r.largeCount);
  check('ordinary total is 1,651,898,167 — the escrow 210M is gone',
        r.largeTotal === 1651898167, r.largeTotal);
  check('no escrow-typed row survives in ordinary movement',
        r.largeHasNoEscrowType, r.largeCount);

  console.log('\n2. escrow is SPLIT OUT, not deleted');
  check('both escrow rows are kept', r.escrowRowsKept, r.escrowCount);
  check('escrow total is exactly 210,000,000', r.escrowTotal === 210000000, r.escrowTotal);

  console.log('\n3. the predicate trap — ESCROW_FLOW is a real payment');
  console.log('     classification: ' + r.flowClassification);
  check('an ordinary Payment from an escrow-category wallet classifies ESCROW_FLOW',
        r.flowClassification === 'ESCROW_FLOW', r.flowClassification);
  check('and it STAYS in ordinary movement', r.escrowFlowStaysInMovement,
        { classification: r.flowClassification });
  check('with its amount intact', r.escrowFlowAmount === 5000000, r.escrowFlowAmount);

  console.log('\n4. discovery keeps its reach');
  check('the dual read returns every row', r.dualReadCount === 3, r.dualReadCount);
  check('BOTH escrow destinations remain discoverable', r.dualReadHasEscrowDest);
  check('the ordinary destination is still there', r.dualReadHasOrdinary);

  check('no page errors', errs.length === 0, errs.slice(0, 3));

  await browser.close(); srv.close();
  console.log('\n' + (fail ? fail + ' FAILED of ' + (pass + fail) : 'ALL ' + pass + ' CHECKS PASS'));
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
