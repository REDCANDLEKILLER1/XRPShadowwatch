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
    // NOTE: no lowercase 'l', no '0', 'O' or 'I' — BASE58_RE rejects them and
    // _isValidDiscoveryAddress would drop this address before discovery saw it.
    const PLAIN_DEST  = 'rPaidDestCCCCCCCCCCCCCCCCCCCCCCCCC';
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

      // ── ESCROW MUST NOT REACH RISK BY ANY ROAD ────────────────────────
      // Splitting escrow out of large_transfers closed one road into the score.
      // buildClusters (:2746) filters state.txs directly for escrow types and
      // emits TREASURY_ROTATION_CLUSTER, whose weight fed clusterRisk ->
      // comp.cluster -> the score, plus a 'cluster risk' driver. That fires
      // every month on Ripple's schedule. The cluster is still built; it must
      // carry NO weight.
      state.txs = TXS.slice();
      analyzeFlags();
      try {
        const cl = (typeof buildClusters === 'function') ? (buildClusters({}) || []) : [];
        const treasury = cl.filter(c => c && c.type === 'TREASURY_ROTATION_CLUSTER');
        out.treasuryClusterBuilt = treasury.length === 1;
        out.treasuryClusterTotal = treasury.length ? Number(treasury[0].total_xrp) : null;
        // The weight table is the thing under test: read the score's own view.
        const rs = (typeof buildRiskScore === 'function')
          ? buildRiskScore({ large_transfers: state.large,
                             escrow_transfers: state.escrowLarge,
                             shadow_volume_xrp: 0, total_balance_delta_xrp: 0 })
          : null;
        out.riskDrivers = rs && rs.drivers ? rs.drivers.slice() : null;
        out.noClusterRiskDriver = !!(rs && Array.isArray(rs.drivers) &&
          rs.drivers.indexOf('cluster risk') === -1);
      } catch (e) { out.clusterErr = String(e && e.message); }

      // ── DISCOVERY MUST STILL REACH THE ESCROW DESTINATION ─────────────
      state.txs = TXS.slice();
      analyzeFlags();
      const pack = { large_transfers: state.large, escrow_transfers: state.escrowLarge };
      const both = (typeof _movementAndEscrow === 'function') ? _movementAndEscrow(pack) : [];
      out.dualReadCount = both.length;
      out.dualReadHasEscrowDest =
        both.some(t => t.to === LOCK_DEST_A) && both.some(t => t.to === LOCK_DEST_B);
      out.dualReadHasOrdinary = both.some(t => t.to === PLAIN_DEST);

      // ── AN ESCROW LOCK DESTINATION HAS NOT BEEN PAID ──────────────────
      // It must stay discoverable, but crediting it with the locked amount
      // published "this wallet received 200M XRP" about a wallet that received
      // nothing — the funds sit in an escrow object until a finish releases them.
      try {
        state.pack = { large_transfers: state.large, escrow_transfers: state.escrowLarge };
        const cands = (typeof collectDiscoveryCandidates === 'function')
          ? (collectDiscoveryCandidates(state.pack) || []) : [];
        const find = a => cands.find(c => c && c.address === a) || null;
        const lockCand = find(LOCK_DEST_A);
        const plainCand = find(PLAIN_DEST);
        out.lockStillDiscovered = !!lockCand;
        out.lockNotCredited = !!lockCand && Number(lockCand.max_value_xrp) === 0 &&
                                            Number(lockCand.total_value_xrp) === 0;
        out.lockNotCalledReceiver = !!lockCand &&
          String(lockCand.classification || '') !== 'LARGE_TRANSFER_RECEIVER';
        out.lockReason = !!lockCand && (lockCand.reasons || []).join(' | ');
        out.lockSaysNotReleased = !!lockCand &&
          /NOT yet released/i.test((lockCand.reasons || []).join(' '));
        // the ordinary whale receiver is unaffected
        out.plainStillCredited = !!plainCand && Number(plainCand.max_value_xrp) === 1651898167;
      } catch (e) { out.discErr = String(e && e.message); }
      // ── THE STAMP MAY NOT CLAIM WHAT IT CANNOT PROVE ──────────────────
      // updateWalletMemory's store is cumulative with no expiry, so a record
      // that existed before the split still carries escrow inside its
      // total_in_xrp / total_out_xrp / largest_transfer_xrp. Marking such a
      // record "escrow excluded" asserts a cleanliness that is not true. Only a
      // record CREATED under the new basis has provably clean totals.
      try {
        const LEGACY = 'rLegacySenderEEEEEEEEEEEEEEEEEEEEE';
        const FRESHRX = 'rFreshReceiverFFFFFFFFFFFFFFFFFFFF';
        const mem0 = getPatternMemory();
        // a record from before the split: real totals, no basis stamp
        mem0.wallets[LEGACY] = {
          address: LEGACY, label: 'LEGACY', first_seen: iso, last_seen: iso,
          times_seen: 5, total_in_xrp: 900000000, total_out_xrp: 900000000,
          largest_transfer_xrp: 200000000, common_counterparties: {},
          destination_tags: {}, archetype_history: [], source_types: [],
          last_classification: null
        };
        delete mem0.wallets[FRESHRX];
        savePatternMemory(mem0);

        updateWalletMemory({
          wallet_results: [],
          large_transfers: [{ from: LEGACY, to: FRESHRX, amount: 3000000,
            hash: 'E'.repeat(64), date: iso, classification: 'WATCHLIST_INTERNAL',
            receiver_label: '' }]
        });

        const mem1 = getPatternMemory();
        const lg = mem1.wallets[LEGACY] || {};
        const fr = mem1.wallets[FRESHRX] || {};
        out.legacyStamped        = lg.movement_basis === 'ordinary_movement_escrow_excluded';
        out.legacyFlaggedImpure  = lg.totals_predate_basis === true;
        out.legacyHasSince       = !!lg.movement_basis_since;
        out.freshCreatedClean    = fr.totals_predate_basis === false;
        out.freshHasSince        = !!fr.movement_basis_since;
        // The boundary is set ONCE, not moved by a later scan.
        // Comparing two `new Date().toISOString()` values taken milliseconds
        // apart is not a test — they can be the identical string, and the
        // assertion then passes no matter what the code does. Plant a sentinel
        // the running code would never produce and check it survives.
        const SENTINEL = '1999-01-01T00:00:00.000Z';
        const memS = getPatternMemory();
        memS.wallets[LEGACY].movement_basis_since = SENTINEL;
        savePatternMemory(memS);
        updateWalletMemory({ wallet_results: [], large_transfers: [
          { from: LEGACY, to: FRESHRX, amount: 1000000, hash: 'F'.repeat(64),
            date: iso, classification: 'WATCHLIST_INTERNAL', receiver_label: '' }] });
        out.sinceIsStable = (getPatternMemory().wallets[LEGACY] || {}).movement_basis_since === SENTINEL;
      } catch (e) { out.memErr = String(e && e.message); }

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

  console.log('\n5. escrow reaches risk by no road');
  console.log('     drivers: ' + JSON.stringify(r.riskDrivers));
  check('the treasury cluster is still BUILT (information kept)',
        r.treasuryClusterBuilt, r.clusterErr);
  check('it reports the real escrow total', r.treasuryClusterTotal === 210000000,
        r.treasuryClusterTotal);
  check('but it contributes NO cluster-risk driver',
        r.noClusterRiskDriver, r.riskDrivers);

  console.log('\n6. an escrow LOCK destination is discoverable but not paid');
  console.log('     reason: ' + JSON.stringify(r.lockReason));
  check('the lock destination is still discovered', r.lockStillDiscovered, r.discErr);
  check('it is credited ZERO value \u2014 the XRP is locked, not received',
        r.lockNotCredited, { max: r.lockReason });
  check('it is not classified LARGE_TRANSFER_RECEIVER', r.lockNotCalledReceiver);
  check('and the reason says the funds are not yet released', r.lockSaysNotReleased, r.lockReason);
  check('the ordinary whale receiver is still credited in full', r.plainStillCredited);

  console.log('\n7. cumulative wallet memory is stamped honestly');
  check('a pre-split record is stamped with the new basis', r.legacyStamped, r.memErr);
  check('and explicitly flagged: its totals PREDATE the basis',
        r.legacyFlaggedImpure, r.memErr);
  check('it records when the basis began', r.legacyHasSince, r.memErr);
  check('a record CREATED under the basis is not flagged', r.freshCreatedClean, r.memErr);
  check('and carries the same boundary field', r.freshHasSince, r.memErr);
  check('the boundary is set once, not moved by a later scan', r.sinceIsStable, r.memErr);

  check('no page errors', errs.length === 0, errs.slice(0, 3));

  await browser.close(); srv.close();
  console.log('\n' + (fail ? fail + ' FAILED of ' + (pass + fail) : 'ALL ' + pass + ' CHECKS PASS'));
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
