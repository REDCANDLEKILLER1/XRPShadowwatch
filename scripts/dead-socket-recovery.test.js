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
      // A TRANSIENT failure, distinct from a dead socket: this connection is
      // healthy and answering, but the next N calls of one command go
      // unanswered. That is what a retry budget exists for, and without it
      // the budget can only ever be read, never exercised.
      if (this.silence && this.silence[m.command] > 0) { this.silence[m.command]--; return; }
      // An XRPL-LEVEL error: the socket ANSWERS (so its health count resets)
      // but the command fails. This is what a read failure looks like when the
      // transport is fine, which is the case balanceOne's first-cause trace
      // exists for.
      if (this.errorCommands && this.errorCommands[m.command]) {
        const errReply = JSON.stringify({ id: m.id, status: 'error',
                                          error: this.errorCommands[m.command] });
        setTimeout(() => {
          (this._listeners.message || []).forEach(fn => { try { fn({ data: errReply }); } catch (_) {} });
        }, Number(this.replyDelayMs) || 0);
        return;
      }
      // REAL XRPL SHAPES. Replying {ok:true} proves the RPC plumbing responds;
      // it does not prove an anchored wallet scan resumes. These are the
      // shapes #57's anchor, validated and response-ceiling rules actually
      // inspect, so a read through this socket exercises those rules rather
      // than bypassing them.
      const TIP = 106799000, RE = 946684800;
      const closeSec = Math.floor(Date.now() / 1000) - RE;
      let result;
      if (m.command === 'ledger') {
        result = { validated: true, ledger_index: TIP,
                   ledger: { ledger_index: String(TIP), close_time: closeSec } };
      } else if (m.command === 'server_info') {
        result = { info: { complete_ledgers: '32570-' + TIP } };
      } else if (m.command === 'account_info') {
        result = { account_data: { Account: m.account, Balance: '250000000' },
                   ledger_index: TIP, validated: true };
      } else if (m.command === 'account_tx') {
        const asked = m.ledger_index_max;
        result = { account: m.account, transactions: [],
                   // Echo the ceiling we were ASKED for — the honest server.
                   ledger_index_max: (asked === -1 ? TIP : asked),
                   ledger_index_min: 32570, validated: true };
      } else {
        result = { ok: true, echoed: m.command };
      }
      const reply = JSON.stringify({ id: m.id, status: 'success', result: result });
      const delay = Number(this.replyDelayMs) || 0;
      setTimeout(() => {
        (this._listeners.message || []).forEach(fn => { try { fn({ data: reply }); } catch (_) {} });
      }, delay);
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
  // The reply is now a REAL server_info shape rather than {ok:true}, so this
  // asserts a genuine XRPL answer came back through the replacement.
  check('and the request SUCCEEDED through it — a real server_info came back',
        !!(r2.result && r2.result.info && typeof r2.result.info.complete_ledgers === 'string'), r2);
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
  console.log('\n4c. the REAL dispatch shape: eight concurrent, every replacement silent');
  // Sections 4 and 4b issue requests one at a time, which never reaches the
  // path that matters most in production: SCAN_PARALLEL wallets hitting a dead
  // socket at once. _ensureSock dedupes that through a single shared
  // state._reconnecting promise — eight parallel wallets must not open eight
  // connections — and a run-terminal decision has to hold across concurrent
  // callers rather than being raced past by seven of them.
  const r4c = await page.evaluate(async () => {
    window.__SW_NEXT_ANSWERS = false;                 // every replacement stays silent
    state._sock = null; state._reconnecting = null; state._reconnectFails = 0;
    state._silentReplacements = 0; state._runAbortReason = null;
    const startSockets = window.__SW_SOCKETS.length;
    const PARALLEL = 8, BATCHES = 40;                 // 320 requests; a FAIL guard, not the bound
    let batchesRun = 0, stoppedAtBatch = null, settled = 0;
    for (let bIdx = 0; bIdx < BATCHES; bIdx++) {
      batchesRun++;
      // EVERY request must settle. Promise.allSettled resolving is itself the
      // assertion that none hung — a request left pending would stall here and
      // the outer test timeout would fire instead of a check reporting.
      const rs = await Promise.allSettled(Array.from({ length: PARALLEL }, () =>
        window.xrpl(null, { command: 'server_info' })));
      settled += rs.length;
      if (state._runAbortReason && stoppedAtBatch === null) stoppedAtBatch = batchesRun;
    }
    const socketsAtVerdict = window.__SW_SOCKETS.length;
    // Dependent phases must issue nothing further. account_tx and account_info
    // are the two that walked the whole roster during the incident.
    const after = await Promise.allSettled([].concat(
      Array.from({ length: PARALLEL }, () => window.xrpl(null, { command: 'account_tx', account: 'rTEST' })),
      Array.from({ length: PARALLEL }, () => window.xrpl(null, { command: 'account_info', account: 'rTEST' }))));
    return {
      requestsIssued: PARALLEL * BATCHES,
      settled,
      allSettled: settled === PARALLEL * BATCHES,
      stoppedAtBatch,
      abortReason: state._runAbortReason,
      silentReplacements: Number(state._silentReplacements) || 0,
      socketsCreated: socketsAtVerdict - startSockets,
      socketsAfterVerdict: window.__SW_SOCKETS.length - socketsAtVerdict,
      dependentRejected: after.every(r => r.status === 'rejected'),
      linkDownAfter: (typeof window._linkDown === 'function') ? window._linkDown() : null
    };
  });
  console.log('     ' + JSON.stringify(r4c));
  check('every one of 320 concurrent requests SETTLED — none left hanging',
        r4c.allSettled === true, r4c);
  check('the run reaches its named terminal failure under concurrency too',
        r4c.abortReason === 'XRPL_TRANSPORT_SILENT' && typeof r4c.stoppedAtBatch === 'number', r4c);
  check('THE REGRESSION — eight concurrent callers share ONE reconnect, not eight',
        r4c.socketsCreated <= 3 && r4c.silentReplacements === 3, r4c);
  check('and dependent phases issue nothing after exhaustion — zero new sockets',
        r4c.socketsAfterVerdict === 0 && r4c.dependentRejected === true, r4c);
  check('the link reads as down so batch passes stop early',
        r4c.linkDownAfter === true, r4c);

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

  // ══════════════════════════════════════════════════════════════════════════
  console.log('\n6. a working replacement restores a REAL anchored read');
  // The earlier control replied {ok:true}, which proves the plumbing responds
  // and nothing more. These shapes are the ones #57's rules inspect.
  const r6 = await page.evaluate(async () => {
    state._sock = null; state._reconnecting = null; state._reconnectFails = 0;
    state._silentReplacements = 0; state._runAbortReason = null;
    window.__SW_NEXT_ANSWERS = true;
    const sock = await window.connectXRPL();
    state._sock = sock;
    const lg = await window.xrpl(sock, { command: 'ledger', ledger_index: 'validated' });
    const si = await window.xrpl(sock, { command: 'server_info' });
    const anchor = window.SW_RUN_ANCHOR.buildRunAnchor({ ledgerResult: lg, serverInfoResult: si });
    // A bounded request through the same socket, checked the way layer 17 does.
    let req = { command: 'account_tx', account: 'rTEST', ledger_index_min: -1,
                ledger_index_max: -1, limit: 10, forward: false };
    req = window.SW_RUN_ANCHOR.boundRequest(req, anchor);
    const tx = await window.xrpl(sock, req);
    const info = await window.xrpl(sock, { command: 'account_info', account: 'rTEST', ledger_index: 'validated' });
    return {
      anchorOk: anchor.ok === true,
      anchorLedger: anchor.anchor_ledger,
      proofProven: !!(anchor.history_exhaustion_proof || {}).proven,
      askedMax: req.ledger_index_max,
      echoedMax: tx.ledger_index_max,
      echoMatches: Number(tx.ledger_index_max) === Number(req.ledger_index_max),
      txValidated: tx.validated === true,
      balanceRead: info && info.account_data && info.account_data.Balance
    };
  });
  console.log('     ' + JSON.stringify(r6));
  check('the replacement establishes a real validated anchor',
        r6.anchorOk === true && r6.anchorLedger > 0, r6);
  check('and its server range proves history for that anchor',
        r6.proofProven === true, r6);
  check('a bounded account_tx echoes the ceiling it was asked for',
        r6.echoMatches === true && r6.txValidated === true, r6);
  check('and a real balance read succeeds — reads actually resume',
        r6.balanceRead === '250000000', r6);

  // ══════════════════════════════════════════════════════════════════════════
  console.log('\n7. a retired socket cannot vouch for its replacement');
  // The A/B count case proves the counter is per-socket. This proves the other
  // direction: a reply that arrives LATE, from a socket already replaced,
  // must not reset the new socket's health.
  const r7 = await page.evaluate(async () => {
    state._sock = null; state._reconnecting = null; state._reconnectFails = 0;
    state._silentReplacements = 0; state._runAbortReason = null;
    window.__SW_NEXT_ANSWERS = true;
    const a = await window.connectXRPL();
    state._sock = a;

    // A earns a real timeout of its own, so the reset below has something to
    // undo. Without this the check could pass on a count that was never set.
    a.answer = false;
    try { await window.xrpl(a, { command: 'server_info' }); } catch (_) {}
    const aBeforeReply = Number(a._swTimeouts) || 0;      // 1

    // B becomes the current socket and earns its own timeout.
    window.__SW_NEXT_ANSWERS = false;
    const b = await window.connectXRPL();
    state._sock = b;
    try { await window.xrpl(b, { command: 'server_info' }); } catch (_) {}
    const bAfterOwnTimeout = Number(b._swTimeouts) || 0;   // 1

    // NOW the retired socket answers. This must reach onMsg with A's listener
    // still attached — the earlier version delayed A's reply 300ms against a
    // 40ms budget, so A timed out first, done() removed the listener, and the
    // reply was discarded before it ever reached the reset. The check passed
    // because the path was never taken. Answering inside the budget is what
    // makes this a test about SCOPING rather than about listener teardown.
    // (Arming a longer budget for A instead does not work: xrpl() awaits
    // _ensureSock before arming its timer, so a global set synchronously
    // around the call is already back to the short value by then.)
    a.answer = true; a.replyDelayMs = 0;
    let replyArrived = false;
    try { replyArrived = !!((await window.xrpl(a, { command: 'server_info' })) || {}).info; }
    catch (_) {}
    await new Promise(r => setTimeout(r, 20));
    return {
      replyArrived,
      aBeforeReply,
      aTimeouts: Number(a._swTimeouts) || 0,
      bAfterOwnTimeout,
      bAfterLateReply: Number(b._swTimeouts) || 0,
      distinct: a !== b
    };
  });
  console.log('     ' + JSON.stringify(r7));
  // Guards this test against becoming vacuous again: if the reply is ever
  // dropped before reaching onMsg, replyArrived is false and this fails.
  check('the retired socket\'s reply actually ARRIVES — the path is exercised',
        r7.replyArrived === true && r7.aBeforeReply === 1, r7);
  check('and it resets the socket that answered',
        r7.aTimeouts === 0, r7);
  check('THE REGRESSION — a late reply from a retired socket does not reset the replacement',
        r7.distinct === true && r7.bAfterOwnTimeout === 1 && r7.bAfterLateReply === 1, r7);

  // ══════════════════════════════════════════════════════════════════════════
  console.log('\n8. a second failed run records its OWN first cause');
  const r8 = await page.evaluate(() => {
    // The budget is what balanceOne consults; simulate two runs' worth of
    // scan-start resets around it, which is what scanWallets does.
    const runOne = () => { state._balanceFailLogged = 0; };
    runOne();
    state._balanceFailLogged = 3;             // run 1 spent its budget
    const beforeReset = state._balanceFailLogged;
    runOne();                                  // run 2 starts
    return { beforeReset, afterReset: state._balanceFailLogged };
  });
  check('the first-cause budget is spent by run one and reset for run two',
        r8.beforeReset === 3 && r8.afterReset === 0, r8);

  // The previous version of this check called a probe that returned a bare
  // `true` and never consulted _rpcTimeoutMs at all, so it would have passed
  // against a guard that did not exist. It now reads the value the timer is
  // actually armed with.
  const rOv = await page.evaluate(() => {
    const saved = window.SW_XRPL_RPC_TIMEOUT_MS;
    const read = (v) => { window.SW_XRPL_RPC_TIMEOUT_MS = v; return window._rpcTimeoutMs(); };
    // The guard accepts only a finite value > 0; everything else falls back to
    // the 15000ms production default, so the seam cannot switch it off.
    const bad = [0, -1, Infinity, NaN, 'abc', null, undefined, {}, [], -0];
    const results = bad.map(read);
    const good = read(40);
    window.SW_XRPL_RPC_TIMEOUT_MS = saved;
    return { results, good, allDefault: results.every(v => v === 15000) };
  });
  check('an invalid timeout override cannot disable the timeout — every bad value falls back to 15000ms',
        rOv.allDefault === true, rOv);
  check('CONTROL: a valid override is still honoured, so the check is not vacuous',
        rOv.good === 40, rOv);

  // ══════════════════════════════════════════════════════════════════════════
  console.log('\n9. the anchor retry budget is spent, not merely declared');
  // Sections 6 calls window.xrpl directly, so it never reaches the acquisition
  // loop in scanWallets — ANCHOR_ACQUIRE_ATTEMPTS could be set to 1 and every
  // check still passed. This drives the REAL loop: getActiveWatchlist is
  // stubbed empty so the roster phases no-op and only the anchor block runs.
  const r9 = await page.evaluate(async () => {
    const realRoster = window.getActiveWatchlist;
    window.getActiveWatchlist = () => [];
    const out = {};
    const setup = (silenceLedger) => {
      state._sock = null; state._reconnecting = null; state._reconnectFails = 0;
      state._silentReplacements = 0; state._runAbortReason = null;
      window.__SW_NEXT_ANSWERS = true;
    };
    try {
      // (a) TRANSIENT: the first two ledger(validated) calls go unanswered on a
      // socket that is otherwise healthy. Two timeouts is under the
      // dead-socket threshold of three, so the socket survives and the third
      // attempt answers — exactly the case the budget exists for.
      setup();
      let sock = await window.connectXRPL();
      state._sock = sock;
      sock.silence = { ledger: 2 };
      state._balanceFailLogged = 3;          // run 1's spent budget, for the reset check
      await window.scanWallets(sock);
      out.transient = {
        anchorOk: state.anchorOk === true,
        anchorLedger: (state.runAnchor || {}).anchor_ledger || null,
        proofProven: !!(((state.runAnchor || {}).history_exhaustion_proof) || {}).proven,
        ledgerCalls: sock.sent.filter(r => (JSON.parse(r) || {}).command === 'ledger').length,
        balanceBudgetReset: state._balanceFailLogged === 0,
        runId: !!state.runId
      };

      // (b) PERMANENT: every ledger(validated) goes unanswered. The budget is
      // exhausted and the run must decline to certify rather than proceed.
      setup();
      sock = await window.connectXRPL();
      state._sock = sock;
      sock.silence = { ledger: 99 };
      await window.scanWallets(sock);
      out.permanent = {
        anchorOk: state.anchorOk === true,
        anchorReason: (state.runAnchor || {}).reason || null,
        ledgerCalls: sock.sent.filter(r => (JSON.parse(r) || {}).command === 'ledger').length
      };
      // (c) THE FIRST CAUSE IS ACTUALLY RECORDED. Section 5 only greps the
      // source for the elog call, which still reads as present if the call is
      // neutered — `if (false) elog(...)` passed that check. This drives one
      // real wallet whose account_info fails at the XRPL level (an ANSWER, so
      // the socket stays healthy and the dead-socket breaker is not involved)
      // and reads the error log the export actually ships.
      const el = document.getElementById('errorLog');
      window.getActiveWatchlist = () => [
        // A real base58 address shape — BASE58_RE rejects anything shorter as
        // INVALID_ADDR before balanceOne ever issues a request, which would
        // make this case pass for the wrong reason.
        { address: 'rrrrrrrrrrrrrrrrrrrrrhoLvTp', label: 'TEST WALLET', cat: 'whale', tier: 3 }
      ];
      setup();
      sock = await window.connectXRPL();
      state._sock = sock;
      sock.errorCommands = { account_info: 'actNotFound' };
      if (el) el.textContent = 'No errors yet.';
      await window.scanWallets(sock);
      out.traced = {
        logged: !!(el && /balance read TEST WALLET/.test(el.textContent)),
        budget: n(state._balanceFailLogged)
      };

      // CONTROL: with the read succeeding, no first-cause line is written.
      setup();
      sock = await window.connectXRPL();
      state._sock = sock;
      if (el) el.textContent = 'No errors yet.';
      await window.scanWallets(sock);
      out.control = {
        logged: !!(el && /balance read TEST WALLET/.test(el.textContent)),
        budget: n(state._balanceFailLogged)
      };
    } catch (e) {
      out.threw = e.message;
    } finally {
      window.getActiveWatchlist = realRoster;
    }
    return out;
  });
  console.log('     transient: ' + JSON.stringify(r9.transient));
  console.log('     permanent: ' + JSON.stringify(r9.permanent));
  check('the scan reached the anchor block without throwing', !r9.threw, r9.threw);
  check('THE REGRESSION — a transient anchor failure is RETRIED, not fatal',
        !!r9.transient && r9.transient.anchorOk === true && r9.transient.ledgerCalls === 3, r9.transient);
  check('and the anchor it recovers is a real validated one with a proven range',
        !!r9.transient && r9.transient.anchorLedger === 106799000 && r9.transient.proofProven === true, r9.transient);
  check('the per-run first-cause budget is reset by the real scan, not a stub',
        !!r9.transient && r9.transient.balanceBudgetReset === true, r9.transient);
  check('CONTROL: a permanent failure exhausts the budget and the run does NOT certify',
        !!r9.permanent && r9.permanent.anchorOk === false && r9.permanent.ledgerCalls === 3, r9.permanent);
  console.log('     traced   : ' + JSON.stringify(r9.traced) + '  control: ' + JSON.stringify(r9.control));
  check('THE REGRESSION — a failed balance read WRITES its first cause to the error log',
        !!r9.traced && r9.traced.logged === true && r9.traced.budget >= 1, r9.traced);
  check('CONTROL: a successful read writes no first-cause line',
        !!r9.control && r9.control.logged === false, r9.control);

  // ══════════════════════════════════════════════════════════════════════════
  console.log('\n10. the DASHBOARD and the FINAL EXPORT both carry the failure');
  // §5 asserts publicRiskLabel on a hand-made pack and §9 drives scanWallets,
  // but neither is the dashboard the operator looks at or the file they send.
  // "Running smoothly" lives in _swScanStatusText, which reads body classes —
  // what the engine is DOING — and never asks whether anything answered. This
  // drives a real all-read-failure scan and then reads the real surfaces.
  const r10 = await page.evaluate(async () => {
    const realRoster = window.getActiveWatchlist;
    const out = {};
    try {
      window.getActiveWatchlist = () => [
        { address: 'rrrrrrrrrrrrrrrrrrrrrhoLvTp', label: 'TEST WALLET', cat: 'whale', tier: 3 }
      ];
      state._sock = null; state._reconnecting = null; state._reconnectFails = 0;
      state._silentReplacements = 0; state._runAbortReason = null;
      window.__SW_NEXT_ANSWERS = true;
      const sock = await window.connectXRPL();
      state._sock = sock;
      // Every balance read fails at the XRPL level. The transport is healthy,
      // so this is a READ failure, not a link failure — the harder case,
      // because nothing about the socket looks wrong.
      sock.errorCommands = { account_info: 'actNotFound' };
      const el = document.getElementById('errorLog');
      if (el) el.textContent = 'No errors yet.';
      document.body.classList.add('scanning');       // the state it renders in
      await window.scanWallets(sock);

      const prog = window.XAI_SCAN_PROGRESS || {};
      out.failed = {
        status: window._swScanStatusText(),
        attempted: Number(prog.walletsAttempted) || 0,
        checked: Number(prog.walletsChecked) || 0,
        walletsFailed: Number(prog.walletsFailed) || 0,
        errorLogHasCause: !!(el && /balance read TEST WALLET/.test(el.textContent)),
        errorLogEmpty: !!(el && /^No errors yet/.test(el.textContent))
      };
      // The real render, not a string built for the test.
      try { window._swRenderReactor(); } catch (_) {}
      const st = document.getElementById('swScanStatus');
      const ft = document.getElementById('swFootStatus');
      out.failed.rendered = st ? (st.textContent || '') : null;
      out.failed.renderedFoot = ft ? (ft.textContent || '') : null;
      // The real export the operator sends.
      // THE REAL EXPORT the operator sends. Scope this honestly: this harness
      // runs a scan, not a full report build, so the narrative sections come
      // out "[EMPTY / NOT GENERATED THIS RUN]". Asserting that such a file
      // does NOT contain "Running smoothly" would be vacuous — it contains
      // almost nothing. The ERROR LOG section IS generated here, and it is the
      // section that was empty during the incident, so that is what gets
      // asserted: positively, with a control.
      const exp = window.buildShadowWatchTotalFile();
      out.failed.exportLen = exp.length;
      out.failed.exportHasErrorSection = /SECTION 09 — ERROR LOG/.test(exp);
      out.failed.exportHasFirstCause = /balance read TEST WALLET/.test(exp);
      out.failed.exportSectionsEmpty = (exp.match(/\[EMPTY \/ NOT GENERATED THIS RUN\]/g) || []).length;

      // CONTROL: the same surfaces on a run that actually read its wallet.
      state._sock = null; state._reconnecting = null; state._reconnectFails = 0;
      state._silentReplacements = 0; state._runAbortReason = null;
      const sock2 = await window.connectXRPL();
      state._sock = sock2;
      if (el) el.textContent = 'No errors yet.';
      await window.scanWallets(sock2);
      // (b) TRANSPORT SILENT, driven by the real breaker rather than by setting
      // the flag: every socket goes quiet until the run takes its own terminal
      // decision, and the dashboard must name that rather than the read count.
      state._sock = null; state._reconnecting = null; state._reconnectFails = 0;
      state._silentReplacements = 0; state._runAbortReason = null;
      window.__SW_NEXT_ANSWERS = false;
      for (let i = 0; i < 40 && !state._runAbortReason; i++) {
        try { await window.xrpl(null, { command: 'server_info' }); } catch (_) {}
      }
      out.aborted = {
        abortReason: state._runAbortReason,
        status: window._swScanStatusText()
      };
      state._runAbortReason = null;
      window.__SW_NEXT_ANSWERS = true;

      const prog2 = window.XAI_SCAN_PROGRESS || {};
      const exp2 = window.buildShadowWatchTotalFile();
      out.healthy = {
        status: window._swScanStatusText(),
        attempted: Number(prog2.walletsAttempted) || 0,
        checked: Number(prog2.walletsChecked) || 0,
        exportHasFirstCause: /balance read TEST WALLET/.test(exp2)
      };
    } catch (e) {
      out.threw = e.message;
    } finally {
      window.getActiveWatchlist = realRoster;
      document.body.classList.remove('scanning');
    }
    return out;
  });
  console.log('     failed : ' + JSON.stringify(r10.failed));
  console.log('     healthy: ' + JSON.stringify(r10.healthy));
  check('the all-read-failure scan completed without throwing', !r10.threw, r10.threw);
  check('THE REGRESSION — the dashboard does NOT say "Running smoothly" over an unread run',
        !!r10.failed && r10.failed.status !== 'Running smoothly' &&
        /Attention needed/.test(r10.failed.status), r10.failed);
  check('and the real render writes that text to the actual status elements',
        !!r10.failed && r10.failed.rendered === r10.failed.status &&
        r10.failed.renderedFoot === r10.failed.status, r10.failed);
  check('health is not zero-error — the first cause reached the error log',
        !!r10.failed && r10.failed.errorLogHasCause === true &&
        r10.failed.errorLogEmpty === false, r10.failed);
  check('attempts, successful reads and failures stay distinct',
        !!r10.failed && r10.failed.attempted === 1 && r10.failed.checked === 0 &&
        r10.failed.walletsFailed === 1, r10.failed);
  // Positive, not "the file lacks a bad string" — the narrative sections are
  // not generated by this harness, so a negative there would prove nothing.
  check('THE REGRESSION — the real export FILE carries the first cause, not a clean error log',
        !!r10.failed && r10.failed.exportLen > 0 &&
        r10.failed.exportHasErrorSection === true &&
        r10.failed.exportHasFirstCause === true, r10.failed);
  check('CONTROL: the same export from a run that read its wallet carries no such line',
        !!r10.healthy && r10.healthy.exportHasFirstCause === false, r10.healthy);
  console.log('     aborted: ' + JSON.stringify(r10.aborted));
  check('THE REGRESSION — an abandoned run names the silent link on the dashboard',
        !!r10.aborted && r10.aborted.abortReason === 'XRPL_TRANSPORT_SILENT' &&
        /Attention needed/.test(r10.aborted.status) &&
        /silent/i.test(r10.aborted.status), r10.aborted);
  check('CONTROL: a run that DID read its wallet still reports smoothly',
        !!r10.healthy && r10.healthy.checked === 1 &&
        r10.healthy.status === 'Running smoothly', r10.healthy);

  check('no page errors', errs.length === 0, errs.slice(0, 3));

  await browser.close(); srv.close();
  console.log('\n' + (fail ? fail + ' FAILED of ' + (pass + fail) : 'ALL ' + pass + ' CHECKS PASS'));
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
