#!/usr/bin/env node
/* ── A HIDDEN PAGE DOES NOT GET TO LOSE ──────────────────────────────────────
   SW-20260918-56PSL never sealed. The fast path was working — journal flushes
   at 12:53:47, 12:54:10, 12:54:30, 12:54:45, steady — and then the screen went
   away:

       12:55:44  request was cut (DELTA_RUN_SILENT) — retrying 1/2
       12:55:56  request was cut (Failed to fetch)  — retrying 2/2
       12:58:05  Screen returned with the XRPL link down
       12:58:05  Evidence index unavailable — direct XRPL acquisition

   Three attempts, spent in TWELVE SECONDS, inside a window where the page was
   not executing and no attempt could have succeeded. A backgrounded tab has its
   fetch killed and its timers throttled; the retry budget was consumed by the
   browser suspending us, not by the server refusing us. By the time the screen
   came back the budget was gone and the run had committed to the fallback.

   The fallback is the path this whole migration replaced: 408 wallets walked
   direct from the browser, into 60-second quota walls, five socket retirements,
   and "transport changed — restarting this wallet" discarding 24 completed
   pages. Thirteen minutes and no seal.

   The defect is that the retry budget is a COUNT, not a CONDITION. Three tries
   is generous against a link that blips. It is worth nothing against a screen
   that is off, because all three burn instantly against something that cannot
   answer.

   Two rules here:
     1. A failure that happened while the page was hidden is not a strike, and
        silence from a hidden page is not silence — we cannot tell a dead
        request from a throttled one, so we do not guess. Wait for the screen.
     2. Giving up is revocable. If the screen comes back and the index answers,
        take the fast path rather than grinding out the slow one.

   Run: node scripts/hidden-page-retry.test.js
   Env: SW_TEST_PORT to override the port (default 8232).
──────────────────────────────────────────────────────────────────────────── */
'use strict';

const http = require('http');
const fs   = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const PORT = Number(process.env.SW_TEST_PORT || 8232);
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

  console.log('A HIDDEN PAGE DOES NOT GET TO LOSE\n');

  // The whole harness lives in the page: a fake /api/delta whose behaviour the
  // test drives, and a settable document.hidden. Everything below calls the
  // REAL SW_EVIDENCE_INDEX.begin().
  const r = await page.evaluate(async () => {
    const o = { errs: [] };
    const IDX = window.SW_EVIDENCE_INDEX;
    o.hasIndex = !!(IDX && typeof IDX.begin === 'function');
    if (!o.hasIndex) return o;

    // ── controllable visibility ────────────────────────────────────────────
    let hidden = false;
    try {
      Object.defineProperty(document, 'hidden', { configurable: true, get: () => hidden });
      Object.defineProperty(document, 'visibilityState',
        { configurable: true, get: () => (hidden ? 'hidden' : 'visible') });
    } catch (e) { o.errs.push('defineProperty: ' + e.message); }
    const setHidden = v => { hidden = v; document.dispatchEvent(new Event('visibilitychange')); };

    // ── controllable /api/delta ────────────────────────────────────────────
    const realFetch = window.fetch;
    let calls = 0, mode = 'transport-fail';
    const GOOD = {
      scan_id: 'idx-test', anchor_ledger: 107069739,
      anchor_close: '2026-09-18T12:58:01.000Z',
      wallets: [{ address: 'rTEST' }], target_wallets: 1, complete_wallets: 1,
      transactions: 0, xrpl_requests: 0, committed: true, freshness: 'FRESH',
      state_sha256: 'deadbeef'
    };
    let inflight = null;     // { signal, reject } of the currently hanging request
    const fakeFetch = function (url, init) {
      if (String(url).indexOf('/api/delta') === -1) return realFetch.apply(this, arguments);
      calls++;
      if (mode === 'hang') {
        // A request that is ALIVE and silent — which is what a backgrounded tab
        // actually produces, and what the instant-reject fake above can never
        // reproduce. The test holds the signal so it can see whether the client
        // aborted it, and holds reject() so it can fail it on cue.
        return new Promise(function (_res, rej) {
          inflight = { signal: init && init.signal, reject: rej };
        });
      }
      if (mode === 'ok') {
        // begin() asks for the STREAM, so the answer has to be NDJSON ending in
        // a `t:'done'` line. A plain JSON body is a stream that ended without a
        // result, which the client correctly treats as a cut connection — an
        // earlier version of this fake sent one and made the fix look broken.
        const body = JSON.stringify(Object.assign({ t: 'done' }, GOOD)) + '\n';
        return Promise.resolve(new Response(body,
          { status: 200, headers: { 'Content-Type': 'application/x-ndjson' } }));
      }
      // What a killed request actually looks like to fetch().
      return Promise.reject(new TypeError('Failed to fetch'));
    };
    window.fetch = fakeFetch;

    const S = (typeof state !== 'undefined' && state) ? state : (window.state = {});
    S.reportId = 'SW-20260918-56PSL';
    const WIN = { startMs: Date.parse('2026-09-17T13:00:00Z'), endMs: Date.parse('2026-09-18T13:00:00Z') };

    const settle = ms => new Promise(res => setTimeout(res, ms));

    // ══ 1. HIDDEN: the budget must not be spent ════════════════════════════
    try {
      calls = 0; mode = 'transport-fail'; setHidden(true);
      let done = null;
      const p = IDX.begin(WIN, ['rTEST']).then(
        v => { done = { ok: true, v: v }; return done; },
        e => { done = { ok: false, e: String(e && e.message) }; return done; });
      await settle(6000);
      o.hiddenCallsWhileAway = calls;
      o.hiddenGaveUp = done !== null;          // must still be pending
      o.hiddenOutcome = done;

      // Screen comes back and the server answers.
      mode = 'ok'; setHidden(false);
      const res = await Promise.race([p, settle(15000).then(() => ({ ok: false, e: 'TIMED_OUT' }))]);
      o.resumedOk = !!(res && res.ok);
      o.resumedAnchor = res && res.v && res.v.anchor_ledger;
      o.callsAfterReturn = calls;
    } catch (e) { o.errs.push('hidden: ' + e.message); }

    // ══ 2. VISIBLE: a real refusal must still end the run ══════════════════
    // If it never gives up, a genuinely dead server hangs the report forever —
    // so the fix must not turn every failure into an infinite wait.
    try {
      calls = 0; mode = 'transport-fail'; setHidden(false);
      const started = Date.now();
      const res = await Promise.race([
        IDX.begin(WIN, ['rTEST']).then(v => ({ ok: true, v: v }), e => ({ ok: false, e: String(e && e.message) })),
        settle(25000).then(() => ({ ok: false, e: 'TIMED_OUT' }))
      ]);
      o.visibleGaveUp = res.ok === false && res.e !== 'TIMED_OUT';
      o.visibleError = res.e;
      o.visibleCalls = calls;
      o.visibleMs = Date.now() - started;
    } catch (e) { o.errs.push('visible: ' + e.message); }

    // ══ 3. A SERVER WITH AN OPINION IS AN ANSWER, NOT A BLIP ═══════════════
    // An HTTP 400 must not be retried at all, hidden or not — retrying an
    // answer is the same answer more slowly.
    try {
      calls = 0; setHidden(true);
      window.fetch = function (url) {
        if (String(url).indexOf('/api/delta') === -1) return realFetch.apply(this, arguments);
        calls++;
        return Promise.resolve(new Response(JSON.stringify({ error: 'ROSTER_MISMATCH' }),
          { status: 400, headers: { 'Content-Type': 'application/json' } }));
      };
      const res = await Promise.race([
        IDX.begin(WIN, ['rTEST']).then(v => ({ ok: true }), e => ({ ok: false, e: String(e && e.message) })),
        settle(12000).then(() => ({ ok: false, e: 'TIMED_OUT' }))
      ]);
      o.refusalStops = res.ok === false && res.e !== 'TIMED_OUT';
      o.refusalError = res.e;
      o.refusalCalls = calls;
    } catch (e) { o.errs.push('refusal: ' + e.message); }

    // ══ 3b. A LIVE REQUEST IS NOT ABORTED WHILE THE SCREEN IS OFF ══════════
    // This is the DELTA_RUN_SILENT at 12:55:44. The request had not failed —
    // the browser had throttled our timers, and we shot it ourselves. The
    // silence clock must not run while we are not running, so the request has
    // to survive well past the 45-second idle limit with the page hidden.
    try {
      window.fetch = realFetch; // restore, then re-stub cleanly
      calls = 0; mode = 'hang'; inflight = null; setHidden(true);
      window.fetch = fakeFetch;
      let ended = null;
      const p = IDX.begin(WIN, ['rTEST']).then(v => (ended = { ok: true }), e => (ended = { ok: false, e: String(e && e.message) }));
      await settle(55000);                       // past IDLE_LIMIT_MS (45s)
      o.hangAborted = !!(inflight && inflight.signal && inflight.signal.aborted);
      o.hangEnded = ended;
      o.hangCalls = calls;

      // Screen returns, the server answers: the SAME request's run completes.
      mode = 'ok'; setHidden(false);
      if (inflight && inflight.reject) inflight.reject(new TypeError('Failed to fetch'));
      const res = await Promise.race([p, settle(15000).then(() => 'TIMED_OUT')]);
      o.hangRecovered = ended !== null && ended.ok === true;
    } catch (e) { o.errs.push('hang: ' + e.message); }

    // ══ 3c. A FAILURE THAT SURFACES AFTER THE SCREEN RETURNS ═══════════════
    // The 12:58:05 "Failed to fetch". By the time the rejection arrives the
    // page is visible again, so checking hiddenness only at failure time reads
    // false and spends a strike on the browser's suspension.
    try {
      calls = 0; mode = 'hang'; inflight = null; setHidden(true);
      let ended = null;
      const p = IDX.begin(WIN, ['rTEST']).then(v => (ended = { ok: true }), e => (ended = { ok: false, e: String(e && e.message) }));
      await settle(1500);
      setHidden(false);                          // screen comes back FIRST
      await settle(300);
      mode = 'ok';
      if (inflight && inflight.reject) inflight.reject(new TypeError('Failed to fetch'));
      const res = await Promise.race([p, settle(15000).then(() => 'TIMED_OUT')]);
      o.lateFailRecovered = ended !== null && ended.ok === true;
      o.lateFailOutcome = ended;
      o.lateFailCalls = calls;
    } catch (e) { o.errs.push('lateFail: ' + e.message); }

    // ══ 4. THE WAIT ITSELF ═════════════════════════════════════════════════
    // Everything above rests on whenVisible(). It has to resolve true when the
    // screen comes back AND give up on its own cap — an unattended phone must
    // not hold a report open forever.
    try {
      setHidden(true);
      const t0 = Date.now();
      const waiting = IDX.whenVisible(30000);
      setTimeout(() => setHidden(false), 500);
      o.waitReturnedTrue = await waiting;
      o.waitTookMs = Date.now() - t0;

      setHidden(true);
      o.waitCapReturnedFalse = await IDX.whenVisible(1000) === false;
      setHidden(false);
      o.waitWhenVisibleIsInstant = await IDX.whenVisible(30000) === true;
    } catch (e) { o.errs.push('whenVisible: ' + e.message); }

    try { window.fetch = realFetch; setHidden(false); } catch (_) {}

    // ══ 5. THE SCAN ASKS AGAIN BEFORE IT COMMITS ═══════════════════════════
    // Read from the BYTES THE BROWSER LOADED, not from String(scanWallets):
    // layer 17 reassigns scanWallets, so the live binding is a wrapper and
    // stringifying it inspects the wrong function entirely.
    //
    // Order is the whole defect. The old code logged the fallback and entered
    // it in the same breath, with no wait in between.
    try {
      const src = await realFetch('/src/brief/02-core.js', { cache: 'no-store' }).then(r => r.text());
      const at = src.indexOf('async function scanWallets');
      const region = at > -1 ? src.slice(at, at + 20000) : '';
      const wait   = region.indexOf('whenVisible');
      const commit = region.indexOf('Evidence index unavailable');
      o.foundScanWallets = at > -1;
      o.scanWaitsBeforeCommitting = wait > -1 && commit > -1 && wait < commit;
      o.scanRetriesBegin = /SERVER_VERIFIED_INDEX_RETRY/.test(region);
    } catch (e) { o.errs.push('scanWallets: ' + e.message); }

    return o;
  });

  (r.errs || []).forEach(e => console.log('  (page error) ' + e));

  check('the evidence index layer is loaded', r.hasIndex === true);

  // ── 1. HIDDEN ──────────────────────────────────────────────────────────────
  check('a hidden page does not give up while it is hidden',
    r.hiddenGaveUp === false, r.hiddenOutcome);
  check('and it stops hammering a transport that cannot answer',
    typeof r.hiddenCallsWhileAway === 'number' && r.hiddenCallsWhileAway <= 2,
    r.hiddenCallsWhileAway);
  check('when the screen returns the run completes on the fast path',
    r.resumedOk === true, r);
  check('and it is the real answer, not a placeholder',
    r.resumedAnchor === 107069739, r.resumedAnchor);
  check('the retry that succeeded happened AFTER the screen came back',
    typeof r.callsAfterReturn === 'number' && r.callsAfterReturn > r.hiddenCallsWhileAway,
    { away: r.hiddenCallsWhileAway, after: r.callsAfterReturn });

  // ── 2. VISIBLE ─────────────────────────────────────────────────────────────
  check('a visible page still gives up on a dead transport',
    r.visibleGaveUp === true, r.visibleError);
  check('and it spent its real attempts doing so',
    typeof r.visibleCalls === 'number' && r.visibleCalls >= 3, r.visibleCalls);

  // ── 3. AN ANSWER IS NOT A BLIP ─────────────────────────────────────────────
  check('a server refusal ends the run even while hidden',
    r.refusalStops === true, r.refusalError);
  check('and is not retried',
    r.refusalCalls === 1, r.refusalCalls);

  // ── 4. THE WAIT ────────────────────────────────────────────────────────────
  check('whenVisible resolves when the screen comes back',
    r.waitReturnedTrue === true, r.waitTookMs);
  check('and it waited rather than returning immediately',
    typeof r.waitTookMs === 'number' && r.waitTookMs >= 400, r.waitTookMs);
  check('an unattended page still gives up on the cap',
    r.waitCapReturnedFalse === true);
  check('a visible page never waits at all',
    r.waitWhenVisibleIsInstant === true);
  check('both predicates are exported for the scan to use',
    typeof r.waitReturnedTrue === 'boolean' && r.scanWaitsBeforeCommitting !== undefined);

  // ── 5. ORDER ───────────────────────────────────────────────────────────────
  check('the scan function was located in the loaded source', r.foundScanWallets === true);
  check('the scan waits for the screen BEFORE committing to the slow path',
    r.scanWaitsBeforeCommitting === true);
  check('and asks the evidence index a second time',
    r.scanRetriesBegin === true);

  // ── 3b/3c. THE TWO CASES THAT ACTUALLY HAPPENED ────────────────────────────
  check('a live request is NOT aborted while the screen is off',
    r.hangAborted === false, r.hangAborted);
  check('and the run is still open after the idle limit passes',
    r.hangEnded === null, r.hangEnded);
  check('it completes once the screen returns',
    r.hangRecovered === true, r.hangEnded);
  check('a failure surfacing AFTER the screen returns is still forgiven',
    r.lateFailRecovered === true, r.lateFailOutcome);
  check('and it did not burn the budget doing so',
    typeof r.lateFailCalls === 'number' && r.lateFailCalls <= 3, r.lateFailCalls);

  check('no page errors', errs.length === 0, errs.slice(0, 3));

  console.log('\n' + (fail === 0 ? 'ALL ' + pass + ' CHECKS PASS' : pass + ' pass, ' + fail + ' FAIL'));
  await browser.close();
  srv.close();
  process.exit(fail === 0 ? 0 : 1);
})().catch(e => { console.error(e); process.exit(1); });
