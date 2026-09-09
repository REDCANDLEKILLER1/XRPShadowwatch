#!/usr/bin/env node
/* ── REPORT TRUTH: FOUR DEFECTS FROM SW-20260831-4VF0C ────────────────────────
   All four were read off one live run, where the STRUCTURED report was correct
   and the Morning Story was not.

   1  ESCROW CONFLATION. Morning Story: "Last 96h: 0 releases · 0 new locks."
      True for Ripple. But four EscrowCreates totalling 40M XRP happened on a
      non-Ripple owner (rfkXSa…dtVXj, labelled "Flare Core Vault") and were not
      mentioned at all, so a listener hears "nothing was locked".

   2  WINDOW LABEL. The run's window was LAST 72H · MONDAY WEEKEND SWEEP and it
      captured 153,826 rows. The watched-activity line printed no window while
      its neighbours said "(24h)".

   3  DISCOVERY COUNT. Morning Story said 432 flagged candidates — the raw
      cumulative inbox. Canonical for the same run: 25 found this scan, 56
      carried over, 81 in the queue, 14 recommended.

   4  LIFECYCLE. Candidates whose balance was never read were published DORMANT
      ("dormant or closed account") because stillHolding is false for null.

   Run: node scripts/report-truth-4vf0c.test.js
   Env: SW_TEST_PORT to override the port (default 8291).
──────────────────────────────────────────────────────────────────────────── */
'use strict';

const http = require('http');
const fs   = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const PORT = Number(process.env.SW_TEST_PORT || 8291);
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
  // READINESS GATE, not a sleep. Layer 17 is injected asynchronously by
  // 14-identity-lookup.js:280, and it is 17 that wraps buildPublicReport /
  // buildMasterPaste with the coverage logic these checks exercise. On a slow
  // load an unconditional sleep would test the UNWRAPPED core functions and
  // every coverage assertion below would pass vacuously — the exact failure
  // mode this suite exists to catch. Wait for the install marker instead.
  //
  // NOT keyed on buildPublicReport._swTxCompleteness20260819. That marker is
  // real but does not survive: 15-report-hotfix-20260814.js:237 re-wraps
  // buildPublicReport AFTER 17 installs, and its wrapper does not copy the
  // property — so the marker is absent even though 17's logic is still in the
  // chain and running. Gate on both layers' install globals, which do survive,
  // and prove the chain FUNCTIONALLY in check 5 instead.
  await page.waitForFunction(() =>
    typeof window.buildPublicReport === 'function' &&
    typeof window.buildMasterPaste === 'function' &&
    !!window.SW_REPORT_SCAN_TUNING_20260816 &&
    !!window.SW_REPORT_HOTFIX_20260814,
    null, { timeout: 60000 });
  await page.waitForTimeout(2000);

  console.log('REPORT TRUTH — SW-20260831-4VF0C\n');

  const r = await page.evaluate(() => {
    const out = {};
    const FLARE = 'rfkXSaCZKTg1EZzec2rLDyrWHxRVJdtVXj';
    const now = Date.now();

    // ── 1. ESCROW ───────────────────────────────────────────────────────
    // Ripple genuinely quiet; four 10M locks on a non-Ripple owner.
    try {
      state.escrow = [
        { owner: FLARE, type: 'LOCK', xrp: 10000000, ts: now - 1 * 3600000 },
        { owner: FLARE, type: 'LOCK', xrp: 10000000, ts: now - 2 * 3600000 },
        { owner: FLARE, type: 'LOCK', xrp: 10000000, ts: now - 3 * 3600000 },
        { owner: FLARE, type: 'LOCK', xrp: 10000000, ts: now - 4 * 3600000 }
      ];
      state.rippleEscrowPosition = {
        complete: true, locked_xrp: 32000000000, active_objects: 101,
        answered_owners: 20, expected_owners: 20, ledger_index: 106666936
      };
    } catch (_) {}

    const api = window.SW_PUBLIC_ESCROW_STORY_20260816 || null;
    out.escrowApi = !!api;
    let esc = '';
    try {
      if (api && typeof api.section === 'function') esc = api.section();
    } catch (e) { out.escErr = String(e && e.message); }
    out.escrow = esc;
    // No acquired Ripple events must remain separate from non-Ripple activity;
    // zero observations alone cannot prove an event-free window.
    out.escRippleAttributed = /No Ripple escrow events are present in the acquired record for the last \d+h; this alone does not prove an event-free window\./.test(esc);
    // The 40M must appear.
    out.escOtherReported = /Other XRPL escrow/i.test(esc) && /40\.00M XRP/.test(esc);
    // Owner wallets counted as owners, objects as objects.
    out.escOwnerCount = /1 owner wallet\b/.test(esc);
    out.escObjectsNotOwners = /ledger objects, not owner wallets/i.test(esc);
    // Scope stated truthfully.
    out.escScopeTruthful = /not every escrow on the XRPL/i.test(esc);
    // The bare "Last 96h: 0 releases · 0 new locks." form must be gone.
    out.escNoBareZero = !/^Last \d+h: 0 release/m.test(esc);

    // re-injecting must refresh, never duplicate
    let once = '';
    try {
      if (api && typeof api.inject === 'function') {
        once = api.inject(api.inject('X\n\nVerdict\n───────\nY\n'));
      }
    } catch (e) { out.dupErr = String(e && e.message); }
    out.injectRan = !!once;
    out.escNoDuplicate = !!once && ((once.match(/\nEscrow Watch\n/g) || []).length === 1);

    // ── 2. WINDOW LABEL ─────────────────────────────────────────────────
    const PACK = {
      date: '2026-08-31',
      watchlist_total: 251, wallets_checked: 251,
      tx_24h_count: 153826, total_tx_xrp: 1060000000, active_wallets: 190,
      shadow_volume_xrp: 610490000, large_transfers_count: 171,
      tx_window: { label: 'LAST 72H · MONDAY WEEKEND SWEEP' },
      xrp_price: 1.3697
    };
    let diag = '';
    try {
      const P = window.PUBLIC_REPORT_PIPELINE_V1;
      const h = P && P.helpers;
      // diagnostics builder is not in helpers; drive it through the story
      diag = (typeof canonicalMorningStory === 'function')
        ? canonicalMorningStory(PACK, { rebuild: true }) : '';
    } catch (e) { out.diagErr = String(e && e.message); }
    out.story = (diag || '').slice(0, 0);   // not printed; asserted below
    out.winLabelled = /Watched activity \(all sizes, LAST 72H/.test(diag);
    out.shadowLabelled = /Shadow volume \(whale moves ≥1M, LAST 72H/.test(diag);
    // the 72h count must never be presented as 24h
    out.no24hOnWatched = !/Watched activity \(all sizes, 24h\)/.test(diag) &&
                         !/Watched activity \(all sizes\): 153826 transactions[^\n]*24h/.test(diag);
    // genuinely-24h market lines keep their label
    out.marketStill24h = /\(24h/.test(diag) || /24h/.test(diag);
    out.diagSample = (diag.match(/• Watched activity[^\n]*/) || [''])[0];
    out.shadowSample = (diag.match(/• Shadow volume[^\n]*/) || [''])[0];

    // ── 3. DISCOVERY COUNTS ─────────────────────────────────────────────
    // A raw inbox far larger than the canonical queue, exactly as the live run
    // had it: the Morning Story published 432 while canonical said 81/25/14.
    try {
      const stamp = new Date().toISOString();
      const rows = [];
      for (let i = 0; i < 120; i++) {
        rows.push({ address: 'rInboxRow' + String(i).padStart(25, '0'),
                    classification: 'LARGE_TRANSFER_RECEIVER', score: 40,
                    seen_count: 1, last_seen: stamp, first_seen: stamp,
                    reasons: ['x'], sources: ['large_transfer'],
                    related_watched_wallets: [], review_status: 'NEW' });
      }
      state.discoveryInbox = rows;
    } catch (_) {}
    let story3 = '';
    try { story3 = canonicalMorningStory(PACK, { rebuild: true }) || ''; } catch (_) {}
    const discLine = (story3.match(/[^.]*flagged candidate[^.]*\./) || [''])[0];
    out.discLine = discLine.trim().slice(0, 200);
    let canonQueue = -1, canonFresh = -1, canonRec = -1;
    try {
      const AWF = window.AUTO_WALLET_FINDER;
      const list = AWF.buildSuggestedWatchlistAdditions(PACK) || [];
      const sp = (typeof _discoverySplit === 'function') ? _discoverySplit(list) : null;
      const pool = (sp && sp.known) ? sp.fresh : list;
      canonQueue = list.length;
      canonFresh = (sp && sp.known) ? sp.fresh.length : list.length;
      canonRec = pool.filter(c => c && (c.action_tier === 'CRITICAL_ADD_REVIEW' ||
                                        c.action_tier === 'RECOMMEND_FOR_WATCH')).length;
    } catch (e) { out.discErr = String(e && e.message); }
    out.canon = { queue: canonQueue, fresh: canonFresh, recommended: canonRec };
    out.rawInbox = 120;
    out.discHasLine = !!discLine;
    // The finder legitimately rejects below-threshold rows, so a 120-row inbox
    // of weak candidates can canonically be an EMPTY queue — in which case the
    // correct output is no discovery line at all. Both outcomes are asserted
    // explicitly rather than assuming a line exists.
    out.discCountsDiffer = canonQueue !== out.rawInbox;
    // Whatever happens, the raw inbox size must never reach the reader.
    out.discNoRawAnywhere = story3.indexOf(String(out.rawInbox) + ' flagged') < 0;
    out.discAgrees = (canonQueue === 0)
      ? !discLine                                                   // nothing publishable → say nothing
      : (!!discLine && discLine.indexOf(String(canonQueue) + ' flagged') > -1);
    out.discMode = (canonQueue === 0) ? 'empty-queue: no line expected' : 'queue: line must match canonical';

    // ── ESCROW TRANSACTIONS ARE CLASSIFIED AS ESCROW ────────────────────
    // classify() judged only sender/receiver. On an EscrowFinish `from` is the
    // account that submitted the finish — anyone may finish a matured escrow —
    // so Ripple's scheduled 500M unlock became "unidentified wallet → Ripple ·
    // unclassified flow" (SW-20260901-Y7BFX), three times.
    let cRel = null, cLock = null, cPay = null;
    try {
      cRel  = classify({ type: 'EscrowFinish', from: 'rPw6JAfinisher00000000000000000000',
                         to: 'r9NpyVfLfUG8hatuCCHKzosyDtKnBdsEN3', amount: 500000000,
                         currency: 'XRP', hash: 'E'.repeat(64) });
      cLock = classify({ type: 'EscrowCreate', from: 'rfkXSaCZKTg1EZzec2rLDyrWHxRVJdtVXj',
                         to: 'rMLNvZR9dascY5jtCfCv3whAp8HdUSZAQ', amount: 10000000,
                         currency: 'XRP', hash: 'F'.repeat(64) });
      // an ordinary payment must be unaffected
      cPay  = classify({ type: 'Payment', from: 'rSomeSender000000000000000000000',
                         to: 'rSomeReceiver0000000000000000000', amount: 5000000,
                         currency: 'XRP', hash: '7'.repeat(64) });
    } catch (e) { out.clsErr = String(e && e.message); }
    out.clsReachable = !!cRel;
    out.clsRelease = cRel && cRel.classification;
    out.clsReleaseSender = cRel && cRel.sender_label;
    out.clsLock = cLock && cLock.classification;
    out.clsPay = cPay && cPay.classification;
    out.clsReleaseIsEscrow = !!cRel && cRel.classification === 'ESCROW_RELEASE';
    // the finisher must NOT be presented as the source of the funds
    out.clsNoFinisherAsSender = !!cRel && cRel.sender_label === 'escrow' &&
                                String(cRel.sender_label).indexOf('rPw6JA') < 0;
    out.clsLockIsEscrow = !!cLock && cLock.classification === 'ESCROW_LOCK';
    // and a normal payment is still classified the old way
    out.clsPaymentUntouched = !!cPay && cPay.classification !== 'ESCROW_RELEASE' &&
                                        cPay.classification !== 'ESCROW_LOCK';

    // ── 4. LIFECYCLE ────────────────────────────────────────────────────
    let lc = null, lcZero = null;
    try {
      const SI = window.SIGNAL_INTELLIGENCE;
      const fn = SI && SI.classifyReceiverLifecycle;
      if (typeof fn === 'function') {
        lc     = fn({ address: 'rNoBalanceRead0000000000000000000', seen_count: 1, sources: [] }, {}, []);
        lcZero = fn({ address: 'rZeroBalance00000000000000000000', seen_count: 1, sources: [] },
                    { receiver_followthrough: [{ address: 'rZeroBalance00000000000000000000', balance_xrp: 0, source_amount_xrp: 1000 }] }, []);
      }
    } catch (e) { out.lcErr = String(e && e.message); }
    out.lcReachable = !!lc;
    // Must be reachable AND yield UNKNOWN — "!lc ||" would pass on an
    // unreachable classifier, proving nothing.
    out.lcUnreadIsUnknown = !!lc && lc.lifecycle_phase === 'UNKNOWN';
    out.lcZeroPhase = lcZero && lcZero.lifecycle_phase;
    out.lcUnreadPhase = lc && lc.lifecycle_phase;
    out.lcUnreadRationale = lc && lc.rationale;

    // ── 5. WINDOW TRUTH ────────────────────────────────────────────────
    // A 72h Monday window whose count must not be called "24h".
    const WIN = 'LAST 72H \u00b7 MONDAY WEEKEND SWEEP';
    const basePack = {
      date: '2026-08-31', data_as_of_utc: '2026-08-31T12:00:00Z',
      scan_target: 'WATCHLIST (3)',
      tx_window: { label: WIN, hours: 72, custom: false },
      wallets_checked: 3, watchlist_total: 3, tx_24h_count: 153826,
      shadow_volume_xrp: 0, total_balance_delta_xrp: 0,
      large_transfers: [], receiver_followthrough: [], top_signals: [],
      xrp_price: 1.0, xrp_delta_24h_pct: 0, xrp_volume_24h: 1e9,
      support: 0.9, resistance: 1.1,
      evidence_quality: { grade: 'B', score: 78 },
      risk_score: { score: 10, label: 'GREEN / QUIET', drivers: [] },
      // anchor_ok and unproven_wallets are REQUIRED for a complete claim now.
      // coverageFrom gates on the PRESENCE of unproven_wallets, not on num(),
      // so an object that never carried the key can no longer satisfy the term
      // by silence — and a run with no validated anchor certifies nothing.
      tx_scan_coverage: { full_window_complete: true, target_wallets: 3,
                          complete_wallets: 3, failed_wallets: 0, truncated_wallets: 0,
                          unproven_wallets: 0, unknown_status_wallets: 0, anchor_ok: true }
    };
    const incompletePack = Object.assign({}, basePack, {
      tx_scan_coverage: { full_window_complete: false, target_wallets: 3,
                          complete_wallets: 1, failed_wallets: 1, truncated_wallets: 1,
                          unproven_wallets: 0, unknown_status_wallets: 0, anchor_ok: true }
    });
    const txLine = t => (String(t).split('\n')
      .find(l => /^Transactions in scan window/.test(l) || /24h transactions/i.test(l)) || '');

    out.win17Loaded = !!window.SW_REPORT_SCAN_TUNING_20260816;
    try {
      const complete = String(window.buildPublicReport(basePack) || '');
      const partial  = String(window.buildPublicReport(incompletePack) || '');
      out.winHasCoverageLine = /Transaction Window Coverage:/.test(complete);
      out.winCompleteLine = txLine(complete);
      out.winPartialLine  = txLine(partial);
      out.winNamesWindow  = out.winCompleteLine ===
        'Transactions in scan window (' + WIN + '): 153826';
      out.winNo24hAnywhere = !/24h transactions/i.test(complete) &&
                             !/24h transactions/i.test(partial);
      out.winCaveatOnLine = out.winPartialLine ===
        'Transactions in scan window (' + WIN + '): 153826 observed (partial transaction coverage)';
      // control: proves qualifyIncompleteText ran at all, so a caveat failure
      // above means the regex desynced rather than the wrapper never firing.
      out.winWrapperRan = /NONE OBSERVED IN PARTIAL COVERAGE/.test(partial) ||
                          /partial transaction scan/.test(partial);
      // control: proves the caveat is NOT applied unconditionally.
      out.winCompleteHasNoCaveat = !/partial transaction coverage/.test(complete);
      out.winHeaderLabel = (String(complete).split('\n')
        .find(l => /^Scan Target:/.test(l)) || '');
    } catch (e) { out.winErr = String(e && e.message); }

    // Unresolvable window: assert NOTHING rather than a false 24H.
    try {
      const noWin = Object.assign({}, basePack); delete noWin.tx_window;
      const realGTW = window.getTxWindow;
      window.getTxWindow = function () { return {}; };
      let bare;
      try { bare = String(window.buildPublicReport(noWin) || ''); }
      finally { window.getTxWindow = realGTW; }
      out.winBareLine = txLine(bare);
      out.winBareAssertsNothing =
        out.winBareLine === 'Transactions in scan window: 153826' &&
        !/24\s*H/i.test(out.winBareLine);
      out.winBareHeader = (String(bare).split('\n')
        .find(l => /^Scan Target:/.test(l)) || '');
      out.winBareHeaderNo24h = !/LAST 24H/i.test(out.winBareHeader);
    } catch (e) { out.winBareErr = String(e && e.message); }

    // A CUSTOM window label is toLocaleString() + ' \u2192 ' + toLocaleString()
    // (02-core.js:853) and therefore CONTAINS COLONS. The layer-17 rewrite uses
    // a lazy [^\n]*? that does not exclude ':' precisely so it can backtrack
    // past them to the final ": <digits>". A colon-excluding class would pass
    // every test above and silently fail on operator-chosen windows only — so
    // the colon case is asserted here rather than left to a code comment.
    try {
      const CUSTOM = '8/31/2026, 3:04:05 PM \u2192 9/1/2026, 3:04:05 PM';
      const cp = Object.assign({}, incompletePack, {
        tx_window: { label: CUSTOM, hours: 24, custom: true } });
      const ct = String(window.buildPublicReport(cp) || '');
      out.winCustomLine = txLine(ct);
      out.winCustomCaveat = out.winCustomLine ===
        'Transactions in scan window (' + CUSTOM + '): 153826 observed (partial transaction coverage)';
    } catch (e) { out.winCustomErr = String(e && e.message); }

    // ── 6. TX_WINDOW ON THE LLM INSTRUCTION SURFACE ────────────────────
    // buildMasterPaste tells a model "Treat ledger data as scanned evidence",
    // so a false TX_WINDOW there is laundered into the on-air report.
    try {
      const mpLine = t => (String(t).split('\n')
        .find(l => /^TX_WINDOW=/.test(l)) || '');
      out.mpReal = mpLine(window.buildMasterPaste(basePack));
      const noWin2 = Object.assign({}, basePack); delete noWin2.tx_window;
      out.mpBare = mpLine(window.buildMasterPaste(noWin2));
      out.mpPreservesReal = out.mpReal === 'TX_WINDOW=' + WIN;
      out.mpBareUnrecorded = out.mpBare === 'TX_WINDOW=UNRECORDED';
      out.mpNever24h = !/^TX_WINDOW=LAST 24H$/.test(out.mpBare);
    } catch (e) { out.mpErr = String(e && e.message); }

    return out;
  });

  console.log('1. escrow categories are separate');
  console.log(String(r.escrow || '(none)').split('\n').map(l => '     ' + l).join('\n'));
  check('escrow section was produced', !!r.escrow, r.escErr);
  check('no acquired Ripple events are stated without claiming a proved empty window', r.escRippleAttributed);
  check('non-Ripple 40M locks are reported', r.escOtherReported);
  check('owner wallets are counted as owners', r.escOwnerCount);
  check('objects are not presented as owner wallets', r.escObjectsNotOwners);
  check('scope is stated truthfully, not "all XRPL"', r.escScopeTruthful);
  check('the bare "Last 96h: 0 …" form is gone', r.escNoBareZero);
  check('inject() actually ran (dedupe check is not vacuous)', r.injectRan, r.dupErr);
  check('re-injecting refreshes rather than duplicating', r.escNoDuplicate);

  console.log('\n2. the window label matches the scan');
  console.log('     ' + JSON.stringify(r.diagSample));
  console.log('     ' + JSON.stringify(r.shadowSample));
  check('watched activity states LAST 72H', r.winLabelled, r.diagSample);
  check('shadow volume states LAST 72H', r.shadowLabelled, r.shadowSample);
  check('the 72h count is never labelled 24h', r.no24hOnWatched);

  console.log('\n3. discovery counts come from the canonical finder');
  console.log('     published: ' + JSON.stringify(r.discLine));
  console.log('     canonical: ' + JSON.stringify(r.canon) + '  raw inbox: ' + r.rawInbox);
  console.log('     mode: ' + r.discMode);
  check('canonical and raw differ (the check is not vacuous)', r.discCountsDiffer, r.canon);
  check('the raw inbox size never reaches the reader', r.discNoRawAnywhere, r.rawInbox);
  check('output agrees with the canonical finder', r.discAgrees,
        { line: r.discLine, canon: r.canon });

  console.log('\n3b. escrow transactions are classified as escrow');
  console.log('     release: ' + r.clsRelease + '  sender: ' + JSON.stringify(r.clsReleaseSender));
  console.log('     lock:    ' + r.clsLock + '   payment: ' + r.clsPay);
  check('classify() is reachable', r.clsReachable, r.clsErr);
  check('an EscrowFinish is ESCROW_RELEASE, not UNKNOWN_FLOW', r.clsReleaseIsEscrow, r.clsRelease);
  check('the finisher is not named as the source of funds', r.clsNoFinisherAsSender, r.clsReleaseSender);
  check('an EscrowCreate is ESCROW_LOCK', r.clsLockIsEscrow, r.clsLock);
  check('an ordinary payment is unaffected', r.clsPaymentUntouched, r.clsPay);

  console.log('\n4. an unread balance is UNKNOWN, never DORMANT');
  check('the lifecycle classifier is reachable', r.lcReachable, r.lcErr);
  check('null balance yields UNKNOWN, not DORMANT', r.lcUnreadIsUnknown,
        { phase: r.lcUnreadPhase, why: r.lcUnreadRationale });

  console.log('\n5. the transactions count names the window it was taken over');
  console.log('     complete: ' + JSON.stringify(r.winCompleteLine));
  console.log('     partial : ' + JSON.stringify(r.winPartialLine));
  console.log('     header  : ' + JSON.stringify(r.winHeaderLabel));
  check('layer 17 is loaded', r.win17Loaded, r.winErr);
  check("17's coverage wrapper is IN the chain (Transaction Window Coverage line present)",
        r.winHasCoverageLine, r.winErr);
  check('the transactions line names the real window', r.winNamesWindow, r.winCompleteLine);
  check('no "24h transactions" claim survives, complete or partial',
        r.winNo24hAnywhere, [r.winCompleteLine, r.winPartialLine]);
  check('the header names the real window, not a hardcoded 24H',
        /LAST 72H/.test(r.winHeaderLabel), r.winHeaderLabel);
  check('CONTROL: qualifyIncompleteText ran on the incomplete pack',
        r.winWrapperRan, r.winPartialLine);
  check('the partial-coverage caveat reaches the transactions line',
        r.winCaveatOnLine, r.winPartialLine);
  check('CONTROL: a complete run carries no partial-coverage caveat',
        r.winCompleteHasNoCaveat, r.winCompleteLine);
  console.log('     unresolvable: ' + JSON.stringify(r.winBareLine));
  check('an unresolvable window asserts no duration at all',
        r.winBareAssertsNothing, r.winBareLine || r.winBareErr);
  check('the header does not fall back to a false LAST 24H',
        r.winBareHeaderNo24h, r.winBareHeader);

  console.log('     custom (colons): ' + JSON.stringify(r.winCustomLine));
  check('a colon-bearing custom window label still gets the caveat',
        r.winCustomCaveat, r.winCustomLine || r.winCustomErr);

  console.log('\n6. TX_WINDOW on the ChatGPT instruction surface');
  console.log('     real: ' + JSON.stringify(r.mpReal) + '   bare: ' + JSON.stringify(r.mpBare));
  check('a real 72h window is preserved verbatim', r.mpPreservesReal, r.mpReal || r.mpErr);
  check('a missing window produces TX_WINDOW=UNRECORDED', r.mpBareUnrecorded, r.mpBare);
  check('TX_WINDOW never claims LAST 24H unless 24h was recorded',
        r.mpNever24h, r.mpBare);

  // ══════════════════════════════════════════════════════════════════════════
  console.log('\n7. the coverage gate, through the REAL report path');
  // These drive window.buildPublicReport in a browser with the whole layer
  // stack loaded — not a node re-implementation of the walk. A test mirror
  // would stay green with the gate deleted from layer 17 entirely, which is
  // how the previous suite passed at 86 while every one of these defects
  // was live.
  const g = await page.evaluate(`(()=>{
    const mk = (cov) => ({ tx_scan_coverage: cov,
      tx_window:{label:'LAST 24H',startMs:Date.now()-86400000,endMs:Date.now()},
      large_transfers:[],escrow_transfers:[],txs:[],wallets:[],news_articles:[],
      news_intel:{top_headlines:[]},tx_24h_count:0,shadow_volume_xrp:0,
      xrp_price:1.42,wallets_checked:251,watchlist_total:251 });
    const R = (p) => { try { return String(window.buildPublicReport(p)||''); } catch(e){ return 'ERR '+e.message; } };
    const line = (t) => (String(t).split('\\n').find(l=>/TRANSACTION WINDOW COVERAGE/i.test(l))||'');
    const full = {target_wallets:251,complete_wallets:251,failed_wallets:0,truncated_wallets:0,
                  unproven_wallets:0,unknown_status_wallets:0,anchor_ok:true,full_window_complete:true};
    const drop = (k) => { const c = Object.assign({}, full); delete c[k]; return c; };
    return {
      good:      line(R(mk(full))),
      noAnchor:  line(R(mk(Object.assign({}, full, {anchor_ok:false})))),
      unproven:  line(R(mk(Object.assign({}, full, {unproven_wallets:2})))),
      absentKey: line(R(mk(drop('unproven_wallets'))))
    };
  })()`);

  console.log('     good      : ' + g.good);
  console.log('     no anchor : ' + g.noAnchor);
  console.log('     unproven  : ' + g.unproven);
  console.log('     absent key: ' + g.absentKey);

  check('CONTROL: a genuinely complete run still reads COMPLETE',
        /COMPLETE — 251\/251/.test(g.good) && !/INCOMPLETE/.test(g.good), g.good);

  // REQUIREMENT A. Every other term is satisfied, so only the anchor term can
  // produce this — the fixture cannot pass for an unrelated reason.
  check('no validated run anchor => the report cannot certify, and SAYS WHY',
        /INCOMPLETE/.test(g.noAnchor) && /No validated run anchor/i.test(g.noAnchor), g.noAnchor);

  // ISOLATING. complete_wallets === target_wallets, zero failed, zero
  // truncated — the pre-existing terms are all satisfied, so a green here
  // would mean the unproven term does nothing. (The obvious fixture,
  // complete_wallets:249, is decided by the older `complete === target` term
  // and would prove nothing about the new one.)
  check('unproven wallets alone block the claim, and are NAMED in the line',
        /INCOMPLETE/.test(g.unproven) && /2 unproven/.test(g.unproven), g.unproven);

  // ABSENT KEY. num(undefined) is 0, so gating on num() would let a coverage
  // object that never carried the key satisfy the term by silence.
  check('an absent unproven count reads NOT MEASURED, never COMPLETE and never 0/0',
        /NOT MEASURED/.test(g.absentKey) && !/COMPLETE/.test(g.absentKey) && !/0\/0/.test(g.absentKey), g.absentKey);

  // ══════════════════════════════════════════════════════════════════════════
  console.log('\n8. transport proof, driving the REAL layer-17 walker');
  // These call window.accountTxWindowDepth — the function layer 17 installs and
  // the scan actually runs — with a stubbed transport. Not the node mirror:
  // the mirror re-implements the walk, so it would stay green with both of
  // these defects present.
  await page.waitForFunction(() =>
    typeof window.accountTxWindowDepth === 'function' &&
    window.accountTxWindowDepth._swTxCompleteness20260819 === true &&
    !!window.SW_COVERAGE, null, { timeout: 30000 });

  const tp = await page.evaluate(async () => {
    const A = 106799000, now = Date.now();
    const full = { proven:true, reason:'SERVER_HAS_FULL_HISTORY',
                   covers_from:32570, covers_through:A, anchor_ledger:A };
    const reset = () => {
      window.state = window.state || {};
      state.runId = 'probe-run'; state.anchorOk = true;
      state.effectiveWindow = { bounded_by_anchor:true, start_ms: now-86400000, end_ms: now };
      state._transportEpoch = 1;
      state.runAnchor = { ok:true, anchor_ledger:A, anchor_close_ms:now,
                          history_exhaustion_proof: full, transport_epoch:1 };
    };
    const proofOf = a => window.accountTxWindowDepth._proofByAccount[a] || {};
    const out = {};

    // CLAMPED. rippled answers `success` and silently lowers the ceiling, so
    // the request carrying the anchor proves nothing.
    reset();
    window.xrpl = async () => ({ transactions: [], ledger_index_max: A - 500,
                                 ledger_index_min: 32570, validated: true });
    await window.accountTxWindowDepth(null, 'rCLAMP', now-86400000, now, 200);
    out.clamped = proofOf('rCLAMP');

    // CONTROL: identical except the server answers over the anchor it was asked for.
    reset();
    window.xrpl = async () => ({ transactions: [], ledger_index_max: A,
                                 ledger_index_min: 32570, validated: true });
    await window.accountTxWindowDepth(null, 'rOK', now-86400000, now, 200);
    out.honest = proofOf('rOK');

    // ABSENT ceiling — a server that does not echo the field at all.
    reset();
    window.xrpl = async () => ({ transactions: [], ledger_index_min: 32570, validated: true });
    await window.accountTxWindowDepth(null, 'rNOECHO', now-86400000, now, 200);
    out.noEcho = proofOf('rNOECHO');

    // UNVALIDATED answer.
    reset();
    window.xrpl = async () => ({ transactions: [], ledger_index_max: A,
                                 ledger_index_min: 32570, validated: false });
    await window.accountTxWindowDepth(null, 'rUNVAL', now-86400000, now, 200);
    out.unvalidated = proofOf('rUNVAL');

    // TWO WALLETS ACROSS A RECONNECT. Wallet A reconnects mid-walk onto a
    // partial-history server; wallet B then starts ALREADY on the new socket,
    // so no transport-change event fires for it.
    reset();
    let n = 0;
    window.xrpl = async (ws, req) => {
      n++;
      if (req.command === 'server_info') return { info: { complete_ledgers: '90000000-' + A } };
      if (n === 1) state._transportEpoch = 2;
      return { transactions: [], ledger_index_max: A, ledger_index_min: 32570, validated: true };
    };
    await window.accountTxWindowDepth(null, 'rA', now-86400000, now, 200);
    out.walletA = proofOf('rA');
    out.runProofAfterA = {
      proven: !!(state.runAnchor.history_exhaustion_proof||{}).proven,
      reason: (state.runAnchor.history_exhaustion_proof||{}).reason,
      epoch: state.runAnchor.transport_epoch
    };
    await window.accountTxWindowDepth(null, 'rB', now-86400000, now, 200);
    out.walletB = proofOf('rB');

    // RECONNECT BETWEEN WALLETS. Distinct from the case above: here the socket
    // changes while NO walk is in flight — during Phase 1, between two wallets,
    // or inside scanReceivers' sleep — so the mid-walk transport check never
    // fires for anybody. The run anchor still holds the OLD socket's proof and
    // the next wallet starts already on the new one. Only a check at walk START
    // catches this.
    reset();
    state._transportEpoch = 2;          // reconnected since the anchor was taken
    let m = 0;
    window.xrpl = async (ws, req) => {
      m++;
      if (req.command === 'server_info') return { info: { complete_ledgers: '90000000-' + A } };
      return { transactions: [], ledger_index_max: A, ledger_index_min: 32570, validated: true };
    };
    await window.accountTxWindowDepth(null, 'rBETWEEN', now-86400000, now, 200);
    out.between = proofOf('rBETWEEN');
    out.reprovedAtStart = m > 0 && !!(state.runAnchor.history_exhaustion_proof||{}).reason;
    out.runProofAfterBetween = (state.runAnchor.history_exhaustion_proof||{}).reason;
    return out;
  });

  console.log('     clamped   : ' + tp.clamped.status + ' / ' + tp.clamped.unproven_reason);
  console.log('     honest    : ' + tp.honest.status + ' / ' + tp.honest.proven_reason);
  console.log('     wallet B  : ' + tp.walletB.status + ' / ' + tp.walletB.unproven_reason);
  console.log('     run proof after reconnect: ' + JSON.stringify(tp.runProofAfterA));

  check('CONTROL: a server answering over the anchor it was asked for certifies',
        tp.honest.status === 'COMPLETE' &&
        tp.honest.proven_reason === 'HISTORY_EXHAUSTED_FULL_RETENTION', tp.honest);

  // BLOCKER 1. Verified live: asked 107304561, echoed 106804564, status success.
  check('a CLAMPED response cannot certify, even though the request carried the anchor',
        tp.clamped.status === 'UNPROVEN' &&
        tp.clamped.unproven_reason === 'RESPONSE_NOT_BOUND_TO_ANCHOR', tp.clamped);
  check('and an unvalidated answer cannot either',
        tp.unvalidated.status === 'UNPROVEN' &&
        tp.unvalidated.unproven_reason === 'RESPONSE_NOT_VALIDATED', tp.unvalidated);
  // Distinct reason, because "every wallet UNPROVEN" caused by a server that
  // does not echo the ceiling is a different emergency from one caused by a
  // server that clamps, and the log has to say which.
  check('a server that omits the ceiling fails closed with its OWN reason',
        tp.noEcho.status === 'UNPROVEN' &&
        tp.noEcho.unproven_reason === 'RESPONSE_CEILING_ABSENT', tp.noEcho);

  // BLOCKER 2. The re-proof must be a RUN fact, not a local copy.
  check('a mid-walk reconnect re-proves onto the RUN anchor, not a local copy',
        tp.runProofAfterA.proven === false &&
        tp.runProofAfterA.reason === 'SERVER_HISTORY_PARTIAL' &&
        tp.runProofAfterA.epoch === 2, tp.runProofAfterA);
  check('THE REGRESSION — the NEXT wallet does not inherit the old server\'s proof',
        tp.walletB.status === 'UNPROVEN' &&
        tp.walletB.unproven_reason === 'HISTORY_EXHAUSTION_UNPROVEN', tp.walletB);

  console.log('     between   : ' + tp.between.status + ' / ' + tp.between.unproven_reason +
              '   run proof: ' + tp.runProofAfterBetween);
  check('a reconnect BETWEEN wallets is caught at walk start, not silently inherited',
        tp.between.status === 'UNPROVEN' &&
        tp.between.unproven_reason === 'HISTORY_EXHAUSTION_UNPROVEN' &&
        tp.runProofAfterBetween === 'SERVER_HISTORY_PARTIAL',
        { proof: tp.between, run: tp.runProofAfterBetween });

  check('no page errors', errs.length === 0, errs.slice(0, 3));

  await browser.close(); srv.close();
  console.log('\n' + (fail ? fail + ' FAILED of ' + (pass + fail) : 'ALL ' + pass + ' CHECKS PASS'));
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
