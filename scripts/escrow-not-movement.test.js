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
      // ── PROFILE RISK: AN ESCROW LOCK IS NOT DISTRIBUTION ──────────────
      // buildWalletProfiles counted any >=1M row as largeOut, so a watched
      // wallet whose ONLY activity was locking its own escrow became a
      // WHALE_DISTRIBUTOR — which carries positive profile risk.
      try {
        const SOLO = (typeof WATCHLIST !== 'undefined' && WATCHLIST[1])
          ? WATCHLIST[1].address : 'rSoloOwnerGGGGGGGGGGGGGGGGGGGGGGG';
        state.txs = [{ account: SOLO, label: 'SOLO', type: 'EscrowCreate',
          hash: '3'.repeat(64), date: iso, from: SOLO, to: LOCK_DEST_B,
          amount: 800000000, currency: 'XRP', destination_tag: '' }];
        analyzeFlags();
        const pk2 = { wallet_results: [{ address: SOLO, label: 'SOLO', cat: 'whale',
          balance_xrp: 900000000, delta_xrp: -800000000, status: 'CHECKED' }] };
        const profs = (typeof buildWalletProfiles === 'function')
          ? (buildWalletProfiles(pk2) || []) : [];
        const sp = profs.find(x => x.address === SOLO) || {};
        out.soloArchetype   = sp.archetype;
        out.soloLargeOut    = sp.large_out_count;
        out.soloNotWhaleDist = sp.archetype !== 'WHALE_DISTRIBUTOR';
        out.soloNoLargeOut   = Number(sp.large_out_count) === 0;
      } catch (e) { out.profErr = String(e && e.message); }

      // ── AN ESCROW EVENT BELONGS TO ITS OWNER, NOT ITS SUBMITTER ───────
      // Ripple-vs-other is decided by isRippleOwner(e.owner) at 26-…:69. The
      // scan path set owner = t.from, the SUBMITTER — and anyone may submit an
      // EscrowFinish. So a third party finishing Ripple's escrow was filed under
      // "other", and a Ripple address finishing someone else's was filed under
      // "Ripple escrow". Both directions are tested, against the REAL registry.
      try {
        const reg = window.SW_RIPPLE_ESCROW_REGISTRY;
        const RIPPLE_ADDR = reg && reg.addresses && reg.addresses[0];
        const OUTSIDER = 'rNotRippleOwnerPPPPPPPPPPPPPPPPPPP';
        const FINISHER = 'rThirdPartyFinisherQQQQQQQQQQQQQQQ';
        out.oaRegistryLoaded = !!RIPPLE_ADDR;
        out.oaRippleAddrIsRipple = !!(typeof window.SW_PUBLIC_ESCROW_STORY_20260816 !== 'undefined') || true;

        // (a) a stranger finishes RIPPLE's escrow -> must still be Ripple's
        // (b) a RIPPLE address finishes a stranger's escrow -> must NOT be Ripple's
        state.txs = [
          { account: 'rScan', label: 'S', type: 'EscrowFinish', hash: '7'.repeat(64),
            date: iso, from: FINISHER, to: 'rDestAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
            amount: 500000000, currency: 'XRP', destination_tag: '',
            escrow_owner: RIPPLE_ADDR },
          { account: 'rScan', label: 'S', type: 'EscrowFinish', hash: '8'.repeat(64),
            date: iso, from: RIPPLE_ADDR, to: 'rDestBBBBBBBBBBBBBBBBBBBBBBBBBBBBB',
            amount: 40000000, currency: 'XRP', destination_tag: '',
            escrow_owner: OUTSIDER }
        ];
        const byHash = {};
        escrowFromTxs(byHash);
        const rows = Object.values(byHash);
        const a = rows.find(r => r.hash === '7'.repeat(64)) || {};
        const b = rows.find(r => r.hash === '8'.repeat(64)) || {};
        out.oaRippleOwned   = a.owner === RIPPLE_ADDR;
        out.oaNotFinisher   = a.owner !== FINISHER;
        out.oaOutsiderOwned = b.owner === OUTSIDER;
        out.oaNotRippleFold = b.owner !== RIPPLE_ADDR;
        out.oaAttributed    = a.owner_attributed === true && b.owner_attributed === true;

        // (c) an EscrowFinish whose ledger node could not be read must be marked
        // unattributed rather than credited to whoever submitted it
        state.txs = [{ account: 'rScan', label: 'S', type: 'EscrowFinish',
          hash: '9'.repeat(64), date: iso, from: RIPPLE_ADDR,
          to: 'rDestCCCCCCCCCCCCCCCCCCCCCCCCCCCCC',
          amount: 1000000, currency: 'XRP', destination_tag: '', escrow_owner: '' }];
        const bh2 = {}; escrowFromTxs(bh2);
        const c = Object.values(bh2)[0] || {};
        out.oaUnknownNotGuessed = c.owner == null && c.owner_attributed === false;

        // (c2) THE INGEST EXTRACTION ITSELF.
        // Seeding escrow_owner on a row proves escrowFromTxs, not the code that
        // fills it. Deleting the capture in txOne would leave every real scan
        // with escrow_owner:'' and every release unattributed — and the checks
        // above would not notice. Exercise the extraction directly, on the meta
        // shape account_tx actually returns.
        const META_ITEM = { meta: { AffectedNodes: [
          { ModifiedNode: { LedgerEntryType: 'AccountRoot' } },
          { DeletedNode: { LedgerEntryType: 'Escrow', FinalFields: {
              Account: RIPPLE_ADDR, Destination: 'rDestAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
              Amount: '500000000000000' } } }
        ] } };
        const facts = (typeof escrowFactsFromMeta === 'function')
          ? escrowFactsFromMeta(META_ITEM) : null;
        out.oaFactsOwner = facts && facts.owner;
        out.oaFactsDest  = facts && facts.destination;
        out.oaFactsAmt   = facts && facts.amount;
        out.oaExtractsOwner = !!facts && facts.owner === RIPPLE_ADDR;
        out.oaExtractsAmt   = !!facts && Number(facts.amount) === 500000000;
        // no Escrow node at all -> nothing invented
        const bare = (typeof escrowFactsFromMeta === 'function')
          ? escrowFactsFromMeta({ meta: { AffectedNodes: [
              { ModifiedNode: { LedgerEntryType: 'AccountRoot' } } ] } }) : null;
        out.oaBareInventsNothing = !!bare && bare.owner === '' && bare.amount == null;

        // (d) an EscrowCreate's submitter IS its owner — unchanged
        state.txs = [{ account: 'rScan', label: 'S', type: 'EscrowCreate',
          hash: 'a'.repeat(64), date: iso, from: OUTSIDER,
          to: 'rDestDDDDDDDDDDDDDDDDDDDDDDDDDDDDD',
          amount: 2000000, currency: 'XRP', destination_tag: '', escrow_owner: '' }];
        const bh3 = {}; escrowFromTxs(bh3);
        const d = Object.values(bh3)[0] || {};
        out.oaCreateOwner = d.owner === OUTSIDER && d.owner_attributed === true;
      } catch (e) { out.oaErr = String(e && e.message); }

      // ── SMALL ESCROW MUST NOT CROSS ORDINARY THRESHOLDS ───────────────
      // One big lock does not exercise the count-based rules. These are the
      // thresholds escrow could cross without ever touching largeOut:
      //   dust grouping   >= 5 small rows sharing a destination -> frag flag
      //   DUST_RECEIVER   smallIn >= 5
      //   EXCHANGE_HOT    mine.length >= 10  (vs COLD below it)
      try {
        const DUSTEE = 'rDusteeMMMMMMMMMMMMMMMMMMMMMMMMMMM';
        const EXCH   = 'rExchWalletNNNNNNNNNNNNNNNNNNNNNNN';
        const small = [];
        for (let i = 0; i < 8; i++) {
          small.push({ account: EXCH, label: 'EX', type: 'EscrowCreate',
            hash: ('a' + i).padEnd(64, 'b'), date: iso, from: EXCH, to: DUSTEE,
            amount: 10, currency: 'XRP', destination_tag: '' });
        }
        // four ordinary rows: below the hot-flow threshold on their own
        for (let i = 0; i < 4; i++) {
          small.push({ account: EXCH, label: 'EX', type: 'Payment',
            hash: ('c' + i).padEnd(64, 'd'), date: iso, from: EXCH, to: PLAIN_DEST,
            amount: 2000, currency: 'XRP', destination_tag: '' });
        }
        state.txs = small;
        state.wallets = [];
        analyzeFlags();
        out.thrFragCount = (state.frags || []).length;
        out.thrNoDustFlag = (state.frags || []).length === 0;

        const pk3 = { wallet_results: [
          { address: EXCH,   label: 'EX',  cat: 'exchange', balance_xrp: 1e6, delta_xrp: 0, status: 'CHECKED' },
          { address: DUSTEE, label: 'DST', cat: 'unknown',  balance_xrp: 1e3, delta_xrp: 0, status: 'CHECKED' }
        ] };
        const pr3 = (typeof buildWalletProfiles === 'function') ? (buildWalletProfiles(pk3) || []) : [];
        const ex = pr3.find(x => x.address === EXCH) || {};
        const du = pr3.find(x => x.address === DUSTEE) || {};
        out.thrExchArchetype = ex.archetype;
        out.thrExchEconCount = ex.tx_count_24h;
        out.thrExchRawCount  = ex.tx_count_24h_raw;
        out.thrExchNotHot    = ex.archetype !== 'EXCHANGE_HOT_FLOW';
        out.thrRawWouldHaveCrossed = Number(ex.tx_count_24h_raw) >= 10;  // anti-vacuity
        out.thrDusteeArchetype = du.archetype;
        out.thrDusteeNotDust   = du.archetype !== 'DUST_RECEIVER';
      } catch (e) { out.thrErr = String(e && e.message); }

      // ── END-TO-END RISK ISOLATION ─────────────────────────────────────
      // The real property, stated once: adding ONLY an EscrowCreate to a scan
      // must not move the risk score, its components, or its drivers. Each
      // individual road was patched separately (large_transfers, the treasury
      // cluster, wallet profiles, receiver follow-through); this asserts the
      // sum, so a NEW road opened later fails here even if nobody thinks to
      // test it directly.
      try {
        const WATCHED = (typeof WATCHLIST !== 'undefined' && WATCHLIST[0])
          ? WATCHLIST[0].address : 'rOwner1';
        const baseTx = [{ account: WATCHED, label: 'BASE', type: 'Payment',
          hash: '1'.repeat(64), date: iso, from: WATCHED, to: PLAIN_DEST,
          amount: 4000000, currency: 'XRP', destination_tag: '' }];
        const escrowTx = { account: WATCHED, label: 'BASE', type: 'EscrowCreate',
          hash: '2'.repeat(64), date: iso, from: WATCHED, to: LOCK_DEST_A,
          amount: 900000000, currency: 'XRP', destination_tag: '' };

        // THE BALANCE MUST MOVE THE WAY A REAL LOCK MOVES IT.
        // The earlier version hardcoded total_balance_delta_xrp: 0 in BOTH arms,
        // so it could not have detected escrow reaching risk through the balance
        // snapshot — and net_delta was exactly such a road. The escrow arm now
        // carries the balance drop an EscrowCreate actually causes, and the pack
        // fields are computed by the PRODUCTION helpers rather than written by
        // hand, so the test exercises the real isolation instead of asserting a
        // number I chose.
        const ORDINARY_DELTA = -2000000;
        const measure = (txs, extraDelta) => {
          state.txs = txs.slice();
          state.wallets = [{ address: WATCHED, label: 'BASE', cat: 'whale',
                             balance_xrp: 5000000,
                             delta_xrp: ORDINARY_DELTA + (extraDelta || 0),
                             status: 'CHECKED' }];
          analyzeFlags();
          const pk = { large_transfers: state.large,
                       escrow_transfers: state.escrowLarge,
                       shadow_volume_xrp: state.large.reduce((a,t)=>a+Number(t.amount||0),0),
                       total_balance_delta_xrp: totalDeltaXRP(),
                       ordinary_balance_delta_xrp: ordinaryDeltaXRP(),
                       escrow_balance_adjust_xrp: escrowDeltaAdjustXRP(),
                       wallet_results: state.wallets,
                       receiver_followthrough: [], fragmentation_flags: state.frags || [] };
          if (typeof buildWalletProfiles === 'function') buildWalletProfiles(pk);
          if (typeof buildClusters === 'function') buildClusters(pk);
          const rs = (typeof buildRiskScore === 'function') ? buildRiskScore(pk) : null;
          const prof = (state.walletProfiles || []).find(x => x.address === WATCHED) || {};
          return {
            rawDelta: pk.total_balance_delta_xrp,
            ordDelta: pk.ordinary_balance_delta_xrp,
            fragCount: (state.frags || []).length,
            score: rs && rs.score, drivers: rs && (rs.drivers || []).slice().sort(),
            // adjustments carries suppression/clamping/rounding — the escrow row
            // first showed up ONLY there (components identical, score +2),
            // so comparing components alone would have missed it.
            comp: rs ? JSON.stringify({ c: rs.components, a: rs.adjustments }) : null,
            archetype: prof.archetype, largeOut: prof.large_out_count
          };
        };

        const A = measure(baseTx, 0);
        // a 900M lock really does take 900M out of the spendable balance
        const B = measure(baseTx.concat([escrowTx]), -900000000);
        out.isoRawDeltaMoved = A.rawDelta !== B.rawDelta;   // the input DID change
        out.isoOrdDeltaSame  = A.ordDelta === B.ordDelta;   // the risk input did not
        out.isoRawA = A.rawDelta; out.isoRawB = B.rawDelta;
        out.isoOrdA = A.ordDelta; out.isoOrdB = B.ordDelta;
        out.isoBaselineScore  = A.score;
        out.isoEscrowScore    = B.score;
        out.isoScoreSame      = A.score === B.score;
        out.isoDriversSame    = JSON.stringify(A.drivers) === JSON.stringify(B.drivers);
        out.isoComponentsSame = A.comp === B.comp;
        out.isoArchetypeSame  = A.archetype === B.archetype;
        out.isoLargeOutSame   = A.largeOut === B.largeOut;
        out.isoDrivers        = B.drivers;
        out.isoArchetype      = B.archetype;
        // anti-vacuity: the escrow row really was ingested
        out.isoEscrowIngested = (state.escrowLarge || []).length === 1;
      } catch (e) { out.isoErr = String(e && e.message); }

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

  // ── SECOND PASS: the paths that need async / RPC stubbing ────────────────
  const r2 = await page.evaluate(async () => {
    const out = {};
    // BASE58 EXCLUDES 0, O, I and l. An earlier version of this fixture used
    // rOrdDest… (capital O) and rRelDest… (lowercase l); both were rejected by
    // BASE58_RE before any code under test saw them, so the "lock is not
    // scanned" assertion passed because NOTHING was scanned. The guard below
    // makes that failure loud instead of silent.
    const ORD_DEST  = 'rPrdDestHHHHHHHHHHHHHHHHHHHHHHHHHH';
    const REL_DEST  = 'rRezDestJJJJJJJJJJJJJJJJJJJJJJJJJJ';
    const LOK_DEST  = 'rLokDestKKKKKKKKKKKKKKKKKKKKKKKKKK';
    out.fixturesValid = (typeof BASE58_RE !== 'undefined')
      ? [ORD_DEST, REL_DEST, LOK_DEST].every(a => BASE58_RE.test(a))
      : null;
    const iso = new Date().toISOString();
    const mk = (type, to, amount, hash) => ({
      account: 'rSrc', label: 'SRC', type, hash, date: iso, from: 'rSrc', to,
      amount, currency: 'XRP', destination_tag: '', classification: 'X', sender_label: 'SRC'
    });
    const realLarge = state.large, realEsc = state.escrowLarge, realRx = state.receivers;
    const realXrpl = window.xrpl;
    try {
      state.large      = [mk('Payment', ORD_DEST, 5000000, '4'.repeat(64))];
      state.escrowLarge = [mk('EscrowFinish', REL_DEST, 6000000, '5'.repeat(64)),
                           mk('EscrowCreate', LOK_DEST, 7000000, '6'.repeat(64))];

      // ── scanReceivers must scan DELIVERIES only ──────────────────────
      const asked = [];
      window.xrpl = async function (ws, cmd) {
        asked.push(cmd.account);
        if (cmd.command === 'account_info') return { account_data: { Balance: '1000000000' } };
        return { transactions: [] };
      };
      await scanReceivers(null);
      const scanned = (state.receivers || []).map(r => r.address);
      out.rxScanned        = scanned.slice();
      out.rxHasOrdinary    = scanned.indexOf(ORD_DEST) > -1;
      out.rxHasRelease     = scanned.indexOf(REL_DEST) > -1;
      out.rxExcludesLock   = scanned.indexOf(LOK_DEST) === -1;
      // anti-vacuity: the scan really ran
      out.rxDidWork        = asked.length > 0;
    } catch (e) { out.rxErr = String(e && e.message); }
    finally { window.xrpl = realXrpl; }

    try {
      // ── offer candidates: one truth about what a lock destination is ──
      const m = (typeof collectExplicitOfferCandidates === 'function')
        ? collectExplicitOfferCandidates() : new Map();
      const g = a => { const c = m.get(a); return c
        ? { score: c.score, sources: Array.from(c.sources), reasons: c.reasons } : null; };
      out.offOrdinary = g(ORD_DEST);
      out.offRelease  = g(REL_DEST);
      out.offLock     = g(LOK_DEST);
      out.offLockPresent   = !!out.offLock;
      out.offLockNotLarge  = !!out.offLock && out.offLock.sources.indexOf('large_transfer') === -1;
      out.offLockOwnSource = !!out.offLock && out.offLock.sources.indexOf('escrow_destination') > -1;
      out.offLockNoBonus   = !!out.offLock && out.offLock.score < 35;
      // NOT `=== 35`: add() takes Math.max and this address is also a next_hop
      // candidate from the scanReceivers run above, so it legitimately scores 40.
      // The property is that it carries the ordinary source and its bonus.
      out.offOrdinaryKeeps = !!out.offOrdinary &&
        out.offOrdinary.sources.indexOf('large_transfer') > -1 &&
        out.offOrdinary.score >= 35;
    } catch (e) { out.offErr = String(e && e.message); }
    finally {
      state.large = realLarge; state.escrowLarge = realEsc; state.receivers = realRx;
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

  console.log('\n6b. an escrow lock is not whale distribution');
  console.log('     archetype: ' + r.soloArchetype + '  largeOut: ' + r.soloLargeOut);
  check('a wallet whose only act is an EscrowCreate is NOT a WHALE_DISTRIBUTOR',
        r.soloNotWhaleDist, r.soloArchetype || r.profErr);
  check('and the lock is not counted as a large outflow',
        r.soloNoLargeOut, r.soloLargeOut);

  console.log('\n6a. an escrow event belongs to its OWNER, not its submitter');
  check('the real Ripple registry is loaded (not a vacuous pass)',
        r.oaRegistryLoaded, r.oaErr);
  check('a stranger finishing Ripple\u2019s escrow stays attributed to Ripple',
        r.oaRippleOwned, r.oaErr);
  check('it is not attributed to the finisher', r.oaNotFinisher, r.oaErr);
  check('a Ripple address finishing a stranger\u2019s escrow is NOT folded into Ripple',
        r.oaNotRippleFold, r.oaErr);
  check('it stays attributed to the actual outside owner', r.oaOutsiderOwned, r.oaErr);
  check('both are marked attributed', r.oaAttributed, r.oaErr);
  check('an unreadable escrow node yields UNKNOWN, never the submitter',
        r.oaUnknownNotGuessed, r.oaErr);
  check('an EscrowCreate is still owned by its creator', r.oaCreateOwner, r.oaErr);
  console.log('     extracted owner: ' + r.oaFactsOwner + '  amount: ' + r.oaFactsAmt);
  check('the INGEST extraction reads the owner off the Escrow ledger node',
        r.oaExtractsOwner, r.oaFactsOwner || r.oaErr);
  check('and reads the locked amount from the same node',
        r.oaExtractsAmt, r.oaFactsAmt);
  check('meta with no Escrow node invents nothing',
        r.oaBareInventsNothing, r.oaErr);

  console.log('\n6c. small escrow cannot cross ordinary count thresholds');
  console.log('     exchange archetype: ' + r.thrExchArchetype +
              '   economic tx ' + r.thrExchEconCount + ' / raw ' + r.thrExchRawCount +
              '   frags ' + r.thrFragCount);
  check('raw counts WOULD have crossed the threshold (not a vacuous pass)',
        r.thrRawWouldHaveCrossed, r.thrExchRawCount);
  check('8 small escrow rows to one destination raise NO dust/fragmentation flag',
        r.thrNoDustFlag, r.thrFragCount);
  check('escrow rows do not push an exchange into EXCHANGE_HOT_FLOW',
        r.thrExchNotHot, r.thrExchArchetype);
  check('and do not make a destination a DUST_RECEIVER',
        r.thrDusteeNotDust, r.thrDusteeArchetype);

  console.log('\n7. END-TO-END: an EscrowCreate moves no risk, by any road');
  console.log('     score ' + r.isoBaselineScore + ' -> ' + r.isoEscrowScore +
              '   archetype: ' + r.isoArchetype + '   drivers: ' + JSON.stringify(r.isoDrivers));
  check('the escrow row really was ingested (not a vacuous pass)',
        r.isoEscrowIngested, r.isoErr);
  console.log('     raw delta ' + r.isoRawA + ' -> ' + r.isoRawB +
              '   ordinary ' + r.isoOrdA + ' -> ' + r.isoOrdB);
  check('the MEASURED balance delta really moved (the input changed)',
        r.isoRawDeltaMoved, { a: r.isoRawA, b: r.isoRawB });
  check('but the ORDINARY delta that risk scores is unchanged',
        r.isoOrdDeltaSame, { a: r.isoOrdA, b: r.isoOrdB });
  check('the risk SCORE is unchanged', r.isoScoreSame,
        { base: r.isoBaselineScore, withEscrow: r.isoEscrowScore });
  check('every risk COMPONENT is unchanged', r.isoComponentsSame, r.isoErr);
  check('the DRIVER list is unchanged', r.isoDriversSame, r.isoDrivers);
  check('the wallet ARCHETYPE is unchanged', r.isoArchetypeSame, r.isoArchetype);
  check('its large-outflow count is unchanged', r.isoLargeOutSame);

  console.log('\n8. cumulative wallet memory is stamped honestly');
  check('a pre-split record is stamped with the new basis', r.legacyStamped, r.memErr);
  check('and explicitly flagged: its totals PREDATE the basis',
        r.legacyFlaggedImpure, r.memErr);
  check('it records when the basis began', r.legacyHasSince, r.memErr);
  check('a record CREATED under the basis is not flagged', r.freshCreatedClean, r.memErr);
  check('and carries the same boundary field', r.freshHasSince, r.memErr);
  check('the boundary is set once, not moved by a later scan', r.sinceIsStable, r.memErr);

  console.log('\n9. receiver follow-through scans DELIVERIES only');
  console.log('     scanned: ' + JSON.stringify(r2.rxScanned));
  check('every fixture address is valid base58 (else nothing is under test)',
        r2.fixturesValid === true, r2.fixturesValid);
  check('the receiver scan actually ran (not a vacuous pass)', r2.rxDidWork, r2.rxErr);
  check('an ordinary large-transfer destination IS scanned', r2.rxHasOrdinary, r2.rxScanned);
  check('an escrow RELEASE destination IS scanned (funds arrived)',
        r2.rxHasRelease, r2.rxScanned);
  check('an escrow LOCK destination is NOT scanned as a funded receiver',
        r2.rxExcludesLock, r2.rxScanned);

  console.log('\n10. every discovery surface says the same thing about a lock');
  console.log('     lock: ' + JSON.stringify(r2.offLock));
  check('the lock destination is still an offer candidate', r2.offLockPresent, r2.offErr);
  check('it is NOT sourced as large_transfer', r2.offLockNotLarge, r2.offLock);
  check('it carries the escrow_destination source', r2.offLockOwnSource, r2.offLock);
  check('and gets no ordinary large-transfer score bonus', r2.offLockNoBonus, r2.offLock);
  check('the ordinary destination keeps its 35', r2.offOrdinaryKeeps, r2.offOrdinary);

  check('no page errors', errs.length === 0, errs.slice(0, 3));

  await browser.close(); srv.close();
  console.log('\n' + (fail ? fail + ' FAILED of ' + (pass + fail) : 'ALL ' + pass + ' CHECKS PASS'));
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
