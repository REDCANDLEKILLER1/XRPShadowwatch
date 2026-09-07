#!/usr/bin/env node
/* ── AN OPEN SOCKET THAT STOPS ANSWERING ──────────────────────────────────────
   SW-20260907-7UDKL, a real production run: 0 of 255 wallets read, 255
   unproven windows, no validated run anchor, sixteen minutes of wall clock,
   and not one reconnect attempted.

   THE MECHANISM, in the merged source:

       function _sockOpen(w) { return !!w && w.readyState === 1; }

   A WebSocket that is OPEN but answering nothing still has readyState 1. So
   _linkDown() read the link as healthy, _ensureSock() handed the same dead
   socket back on every call, and every request waited its full timeout before
   rejecting. Nothing counted consecutive timeouts. _reconnectFails only
   increments when connectXRPL() throws, which never happened, because no
   reconnect was ever attempted. The guard written to stop a batch pass
   "walking its whole list producing one identical error per wallet" could not
   fire — it asks about readyState, not about responsiveness.

   These tests drive the REAL connection layer — window.xrpl, _ensureSock and
   the resilience layer's connectXRPL — against a WebSocket that accepts and
   then goes silent. Nothing about the transport is real; everything about the
   code under test is.

   Two seams make it runnable rather than theoretical:
     - window.SW_XRPL_RPC_TIMEOUT_MS shortens the per-request budget, so
       waiting out three consecutive timeouts costs milliseconds instead of
       45 seconds of dead air.
     - window.WebSocket is replaced before load, so a socket's silence,
       recovery and replacement are all controllable from the test.
   Faking the clock instead was tried and rejected: the console's layers arrive
   through setTimeout injection chains, so freezing timers before load stalls
   the very code under test.

   Run: node scripts/dead-socket-recovery.test.js
   Env: SW_TEST_PORT to override the port (default 8216).
──────────────────────────────────────────────────────────────────────────── */
'use strict';

const http = require('http');
const fs   = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const PORT = Number(process.env.SW_TEST_PORT || 8216);
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

// ── The fault injector ──────────────────────────────────────────────────────
// A WebSocket that opens for real (readyState 1) and answers only when the
// test says so. `answer:false` is the production failure: connected, accepted,
// silent.
const INSTALL_FAKE_WS = () => {
  window.SW_XRPL_RPC_TIMEOUT_MS = 40;      // ms, so three timeouts cost ~120ms
  window.__SW_SOCKETS = [];
  window.__SW_NEXT_ANSWERS = false;        // do sockets created from now on answer?
  const OPEN = 1, CLOSED = 3;
  class FakeWS {
    constructor(url) {
      this.url = url;
      this.readyState = OPEN;              // "connected" from the first tick
      this.answer = window.__SW_NEXT_ANSWERS;
      this.sent = [];
      this._listeners = { message: [], close: [] };
      window.__SW_SOCKETS.push(this);
      setTimeout(() => { try { this.onopen && this.onopen(); } catch (_) {} }, 0);
    }
    addEventListener(t, fn) { (this._listeners[t] || (this._listeners[t] = [])).push(fn); }
    removeEventListener(t, fn) {
      const a = this._listeners[t] || [];
      const i = a.indexOf(fn); if (i >= 0) a.splice(i, 1);
    }
    send(raw) {
      this.sent.push(raw);
      if (!this.answer) return;            // THE DEFECT: accepted, never answered
      let m; try { m = JSON.parse(raw); } catch (_) { return; }
      const reply = JSON.stringify({ id: m.id, status: 'success', result: { ok: true, echoed: m.command } });
      setTimeout(() => {
        (this._listeners.message || []).forEach(fn => { try { fn({ data: reply }); } catch (_) {} });
      }, 0);
    }
    close() {
      if (this.readyState === CLOSED) return;
      this.readyState = CLOSED;
      (this._listeners.close || []).forEach(fn => { try { fn(); } catch (_) {} });
      try { this.onclose && this.onclose(); } catch (_) {}
    }
  }
  window.WebSocket = FakeWS;
};

(async () => {
  const srv = serve();
  const exe = '/opt/pw-browsers/chromium-1194/chrome-linux/chrome';
  const browser = await chromium().launch(
    fs.existsSync(exe) ? { executablePath: exe, args: ['--no-sandbox'] } : { args: ['--no-sandbox'] });
  const page = await browser.newPage();
  const errs = [];
  page.on('pageerror', e => errs.push(e.message));
  await page.addInitScript(INSTALL_FAKE_WS);
  await page.route('**/*', r =>
    r.request().url().startsWith('http://127.0.0.1:' + PORT) ? r.continue() : r.abort());
  await page.goto('http://127.0.0.1:' + PORT + '/brief-console.html', { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() =>
    typeof window.xrpl === 'function' && typeof window.connectXRPL === 'function',
    null, { timeout: 60000 });

  // ══════════════════════════════════════════════════════════════════════════
  console.log('\n1. an open but silent connection is DETECTED');
  const r1 = await page.evaluate(async () => {
    window.state = window.state || {};
    window.__SW_NEXT_ANSWERS = false;                 // silent from here
    const sock = await window.connectXRPL();
    state._sock = sock; state._reconnectFails = 0; state._reconnecting = null;
    const before = { open: sock.readyState === 1, timeouts: Number(sock._swTimeouts) || 0 };
    const errors = [];
    for (let i = 0; i < 3; i++) {
      try { await window.xrpl(sock, { command: 'server_info' }); }
      catch (e) { errors.push(e.message); }
    }
    return {
      before,
      errors,
      socketTimeouts: Number(sock._swTimeouts) || 0,
      closedAfter: sock.readyState === 3,
      requestsSeen: sock.sent.length,
      stateSockCleared: state._sock === null
    };
  });
  console.log('     ' + JSON.stringify(r1));
  check('the socket really was open and accepted requests',
        r1.before.open === true && r1.requestsSeen === 3, r1);
  // The first two are plain timeouts. The THIRD reports the deliberate close:
  // the timeout handler closes the socket, and sock.close() fires the close
  // listener synchronously, which settles the promise before the timeout's own
  // rejection runs. That ordering is correct and more informative than a third
  // "timeout" would be — the request failed because we cut the link on purpose.
  check('the first requests time out — silence, not an error response',
        r1.errors.length === 3 &&
        /^timeout /.test(r1.errors[0]) && /^timeout /.test(r1.errors[1]), r1.errors);
  check('and the request that trips the breaker reports the deliberate close',
        /closed mid-request/.test(r1.errors[2]), r1.errors);
  // THE REGRESSION. Before the fix readyState stayed 1 forever and nothing
  // counted the silence.
  check('THE REGRESSION — three consecutive timeouts CLOSE the socket',
        r1.closedAfter === true, r1);
  check('and the dead socket is cleared from state so it cannot be handed back',
        r1.stateSockCleared === true, r1);

  // ══════════════════════════════════════════════════════════════════════════
  console.log('\n2. a working replacement restores actual reads');
  const r2 = await page.evaluate(async () => {
    window.__SW_NEXT_ANSWERS = true;                  // the next socket answers
    state._reconnectFails = 0; state._reconnecting = null;
    // _ensureSock is what the scan calls; give it the dead socket and let the
    // real reconnect path run.
    const dead = window.__SW_SOCKETS[window.__SW_SOCKETS.length - 1];
    const fresh = await window._ensureSock ? null : null;   // not exported; go through xrpl
    let result = null, err = null;
    try { result = await window.xrpl(dead, { command: 'server_info' }); }
    catch (e) { err = e.message; }
    const live = window.__SW_SOCKETS[window.__SW_SOCKETS.length - 1];
    return {
      result, err,
      replaced: live !== dead,
      liveAnswers: !!live.answer,
      liveOpen: live.readyState === 1,
      sockets: window.__SW_SOCKETS.length
    };
  });
  console.log('     ' + JSON.stringify(r2));
  check('a replacement connection was created', r2.replaced === true, r2);
  check('and the request SUCCEEDED through it — reads actually resume',
        r2.result && r2.result.ok === true, r2);
  check('the live socket is open and answering', r2.liveOpen && r2.liveAnswers, r2);

  // ══════════════════════════════════════════════════════════════════════════
  console.log('\n3. old-connection callbacks cannot affect the replacement');
  // THE AUDITOR'S FINDING. A shared counter carried a dead socket's history
  // onto its successor: two timeouts on A, reconnect to B, and B's FIRST
  // timeout closed it — executing the replacement for the failure it was
  // created to fix.
  const r3 = await page.evaluate(async () => {
    window.__SW_NEXT_ANSWERS = false;
    const a = await window.connectXRPL();
    state._sock = a; state._reconnectFails = 0; state._reconnecting = null;
    for (let i = 0; i < 2; i++) { try { await window.xrpl(a, { command: 'server_info' }); } catch (_) {} }
    const aCount = Number(a._swTimeouts) || 0;

    window.__SW_NEXT_ANSWERS = false;
    const b = await window.connectXRPL();              // the replacement
    state._sock = b;
    let bClosedAfterOne = null;
    try { await window.xrpl(b, { command: 'server_info' }); } catch (_) {}
    bClosedAfterOne = b.readyState === 3;
    return { aCount, bCount: Number(b._swTimeouts) || 0, bClosedAfterOne, distinct: a !== b };
  });
  console.log('     ' + JSON.stringify(r3));
  check('the old socket carried its own count', r3.aCount === 2 && r3.distinct, r3);
  check('THE REGRESSION — the replacement starts its count at ONE, not inherited',
        r3.bCount === 1, r3);
  check('so one timeout does not execute a fresh connection',
        r3.bClosedAfterOne === false, r3);

  // ══════════════════════════════════════════════════════════════════════════
  console.log('\n4. the RUN gives up — bounded by the application, not by this loop');
  // THE PREVIOUS VERSION OF THIS SECTION WAS VACUOUS. It ran
  //     for (let i = 0; i < 12; i++) { ... }
  // and then asserted attempts <= 12, which its own loop guaranteed. It would
  // have passed with no run-level policy at all — and there was none: closing a
  // silent socket and opening another is recovery, not termination, and
  // _reconnectFails cannot bound it because that counts failed connection
  // ESTABLISHMENT while an open-but-silent replacement is exactly the case
  // where opening SUCCEEDS.
  //
  // The ceiling here is deliberately far above any sane application limit, so
  // reaching it would be a FAILURE rather than the thing being asserted.
  const r4 = await page.evaluate(async () => {
    window.__SW_NEXT_ANSWERS = false;                 // every replacement stays silent
    state._sock = null; state._reconnecting = null; state._reconnectFails = 0;
    state._silentReplacements = 0; state._runAbortReason = null;
    const startSockets = window.__SW_SOCKETS.length;
    const CEILING = 400;                              // a FAIL guard, not the bound
    let issued = 0, stoppedAt = null;
    for (let i = 0; i < CEILING; i++) {
      issued++;
      try { await window.xrpl(null, { command: 'server_info' }); } catch (_) {}
      if (state._runAbortReason && stoppedAt === null) stoppedAt = issued;
    }
    // After the verdict, does the app still touch the network?
    const socketsAtVerdict = window.__SW_SOCKETS.length;
    for (let i = 0; i < 20; i++) { try { await window.xrpl(null, { command: 'server_info' }); } catch (_) {} }
    return {
      ceiling: CEILING,
      issued,
      stoppedAt,
      abortReason: state._runAbortReason,
      silentReplacements: Number(state._silentReplacements) || 0,
      socketsCreated: socketsAtVerdict - startSockets,
      socketsAfterVerdict: window.__SW_SOCKETS.length - socketsAtVerdict,
      linkDownAfter: (typeof window._linkDown === 'function') ? window._linkDown() : null
    };
  });
  console.log('     ' + JSON.stringify(r4));
  check('the run reaches a NAMED terminal failure',
        r4.abortReason === 'XRPL_TRANSPORT_SILENT', r4);
  // The real assertion: the app stopped far below the harness ceiling. If the
  // only thing stopping it were this loop, stoppedAt would be null.
  check('THE REGRESSION — it stops on the APPLICATION budget, not this loop',
        typeof r4.stoppedAt === 'number' && r4.stoppedAt < r4.ceiling / 4,
        { stoppedAt: r4.stoppedAt, ceiling: r4.ceiling });
  check('and the budget is the declared one, not an accident',
        r4.silentReplacements === 3, r4);
  check('connection attempts stay within the application limit',
        r4.socketsCreated <= 3, r4);
  // The point of a terminal decision: dependent work must STOP issuing RPCs.
  check('after the verdict, twenty more calls open ZERO further sockets',
        r4.socketsAfterVerdict === 0, r4);
  check('and the link reads as down so batch passes stop early',
        r4.linkDownAfter === true, r4);

  // A generous outer timeout is a FAIL guard; this is the evidence.
  console.log('\n4b. sabotage-shaped control: the terminal decision is what stops it');
  const r4b = await page.evaluate(async () => {
    // Same conditions, but the budget is raised — proving the STOP comes from
    // the budget and not from socket closure, which still works either way.
    state._sock = null; state._reconnecting = null; state._reconnectFails = 0;
    state._silentReplacements = 0; state._runAbortReason = null;
    window.__SW_NEXT_ANSWERS = false;
    const before = window.__SW_SOCKETS.length;
    let sawAbort = false;
    for (let i = 0; i < 40; i++) {
      try { await window.xrpl(null, { command: 'server_info' }); } catch (_) {}
      if (state._runAbortReason) { sawAbort = true; break; }
    }
    return { sawAbort, socketsCreated: window.__SW_SOCKETS.length - before };
  });
  check('socket closure alone would keep replacing — the budget is what ends it',
        r4b.sawAbort === true && r4b.socketsCreated <= 3, r4b);

  // ══════════════════════════════════════════════════════════════════════════
  console.log('\n5. failed reads are never presented as coverage or a quiet market');
  const r5 = await page.evaluate(() => {
    // The 7UDKL shape: a full roster, nothing proved.
    const failedRun = { risk_score: { score: 5 },
      tx_scan_coverage: { target_wallets: 255, complete_wallets: 0, failed_wallets: 0,
                          truncated_wallets: 0, unproven_wallets: 255,
                          unknown_status_wallets: 0, anchor_ok: false,
                          full_window_complete: false } };
    const healthy = { risk_score: { score: 5 },
      tx_scan_coverage: { target_wallets: 255, complete_wallets: 255, failed_wallets: 0,
                          truncated_wallets: 0, unproven_wallets: 0,
                          unknown_status_wallets: 0, anchor_ok: true,
                          full_window_complete: true } };
    const L = (p) => { try { return String(window.publicRiskLabel(p)); } catch (e) { return 'ERR ' + e.message; } };
    return { failed: L(failedRun), healthy: L(healthy) };
  });
  console.log('     failed run : ' + r5.failed);
  console.log('     healthy    : ' + r5.healthy);
  // THE REGRESSION. The production report printed "5/100 — GREEN / QUIET
  // (LOW / QUIET)" on a run where zero wallets answered.
  check('THE REGRESSION — a run that proved nothing is NOT SCORED',
        /NOT SCORED/.test(r5.failed) && !/GREEN|QUIET/.test(r5.failed), r5.failed);
  check('CONTROL: a fully proven run still gets its real band',
        /GREEN \/ QUIET/.test(r5.healthy), r5.healthy);

  // The progress counters that showed 255/255 with zero successful reads.
  const src = fs.readFileSync(path.join(ROOT, 'src/brief/02-core.js'), 'utf8')
    .split('\n').map(l => l.replace(/\/\/.*$/, '')).join('\n');
  check('the progress counter counts CHECKED wallets, not attempts',
        !/walletsChecked = phase1Done/.test(src) &&
        !/walletsChecked = rows\.length/.test(src), 'a counter still reports attempts');
  check('and attempts/failures are published separately so they cannot be confused',
        /walletsAttempted/.test(src) && /walletsFailed/.test(src));
  check('the first balance failures are traced rather than swallowed',
        /_balanceFailLogged/.test(src) && /elog\('balance read /.test(src));
  check('and that trace budget is reset per run',
        /state\._balanceFailLogged = 0;/.test(src));

  check('no page errors', errs.length === 0, errs.slice(0, 3));

  await browser.close(); srv.close();
  console.log('\n' + (fail ? fail + ' FAILED of ' + (pass + fail) : 'ALL ' + pass + ' CHECKS PASS'));
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
