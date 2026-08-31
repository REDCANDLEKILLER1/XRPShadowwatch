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
  await page.waitForTimeout(9000);

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
    // Ripple's own 0/0 must still be stated, and attributed to Ripple.
    out.escRippleAttributed = /Ripple, last \d+h: 0 release/.test(esc);
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

    return out;
  });

  console.log('1. escrow categories are separate');
  console.log(String(r.escrow || '(none)').split('\n').map(l => '     ' + l).join('\n'));
  check('escrow section was produced', !!r.escrow, r.escErr);
  check('Ripple 0/0 is stated AND attributed to Ripple', r.escRippleAttributed);
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

  console.log('\n4. an unread balance is UNKNOWN, never DORMANT');
  check('the lifecycle classifier is reachable', r.lcReachable, r.lcErr);
  check('null balance yields UNKNOWN, not DORMANT', r.lcUnreadIsUnknown,
        { phase: r.lcUnreadPhase, why: r.lcUnreadRationale });

  check('no page errors', errs.length === 0, errs.slice(0, 3));

  await browser.close(); srv.close();
  console.log('\n' + (fail ? fail + ' FAILED of ' + (pass + fail) : 'ALL ' + pass + ' CHECKS PASS'));
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
