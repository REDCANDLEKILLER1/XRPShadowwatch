#!/usr/bin/env node
'use strict';
// Exercise the production RPC, wallet walker, proof aggregation and report
// builders. Only the external WebSocket peer is controlled by this fixture.
const fs = require('fs');
const path = require('path');
const http = require('http');
const assert = require('assert/strict');
const { chromium } = require('playwright');
const root = path.join(__dirname, '..');
const port = Number(process.env.SW_TEST_PORT || 8222);
const server = http.createServer((req, res) => {
  const file = path.join(root, decodeURIComponent(req.url.split('?')[0]));
  if (!file.startsWith(root + path.sep) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) { res.writeHead(404); return res.end(); }
  res.setHeader('Content-Type', file.endsWith('.js') ? 'text/javascript' : file.endsWith('.css') ? 'text/css' : 'text/html');
  fs.createReadStream(file).pipe(res);
});
let browser;
async function main() {
  await new Promise(resolve => server.listen(port, '127.0.0.1', resolve));
  browser = await chromium.launch({ args: ['--no-sandbox'] });
  const page = await browser.newPage();
  await page.route('**/*', r => r.request().url().startsWith('http://127.0.0.1:' + port) ? r.continue() : r.abort());
  await page.addInitScript(() => {
    const peer = window.testPeer = { sent: [], cooldown: 0, early: 0, txReads: 0, rejected: false, mode: 'roster', sockets: 0,
      close: Math.floor(Date.now() / 1000) - 946684800 - 10 };
    class Socket extends EventTarget {
      constructor(url) { super(); this.url = url; this.readyState = 0; this.number = ++peer.sockets; setTimeout(() => { this.readyState = 1; if (this.onopen) this.onopen({}); this.dispatchEvent(new Event('open')); }, 0); }
      close() { if (this.readyState === 3) return; this.readyState = 3; this.dispatchEvent(new Event('close')); }
      send(raw) {
        const q = JSON.parse(raw), now = Date.now();
        peer.sent.push({ ...q, socket: this.number, at: now });
        if (peer.mode === 'silent') return;
        if (now < peer.cooldown) peer.early++;
        let result = {}, error = null;
        const close = peer.close;
        if (q.command === 'ledger') result = { validated: true, ledger_index: 110000000, ledger: { ledger_index: '110000000', close_time: close } };
        if (q.command === 'server_info') result = { info: { complete_ledgers: '32570-110000000' } };
        if (q.command === 'account_info') result = { account_data: { Balance: '100000000', Sequence: 10, OwnerCount: 0, Flags: 0 } };
        if (q.command === 'account_tx') {
          peer.txReads++;
          if (peer.mode === 'roster' && !peer.rejected && q.marker) {
            peer.rejected = true; peer.cooldown = Date.now() + 80;
            error = { error: 'slowDown', error_message: 'You are placing too much load on the server.', retry_after_ms: 80 };
          } else if (peer.mode === 'rotate' && !peer.rejected && q.marker) {
            peer.rejected = true;
            setTimeout(() => this.close(), 1);
            return;
          } else if (peer.mode === 'invalid') {
            error = { error: 'invalidParams', error_message: 'Invalid account format' };
          } else {
            result = { validated: true, ledger_index_min: 32570, ledger_index_max: q.ledger_index_max,
              transactions: q.marker ? [] : Array.from({ length: 133 }, (_, i) => ({
                ledger_index: 109999999, validated: true,
                tx: { Account: q.account, Destination: q.account, TransactionType: 'Payment', Amount: '1000000',
                  hash: q.account + ':' + i, date: close - 60 - i }, meta: { delivered_amount: '1000000' }
              })), ...(q.marker ? {} : { marker: { socket: this.number, page: 1 } }) };
          }
        }
        setTimeout(() => {
          if (this.readyState !== 1) return;
          const d = error ? { id: q.id, status: 'error', ...error } : { id: q.id, status: 'success', result };
          this.dispatchEvent(new MessageEvent('message', { data: JSON.stringify(d) }));
        }, 2);
      }
    }
    window.WebSocket = Socket;
  });
  await page.goto('http://127.0.0.1:' + port + '/brief-console.html');
  await page.waitForFunction(() => window.SW_RUN_ANCHOR && window.SW_REPORT_SCAN_TUNING_20260816 && window.SW_XRPL_RESILIENCE_20260817 && window.SW_LIVE_WATCHLIST_PROMOTION);
  const roster = await page.evaluate(async () => {
    await SW_LIVE_WATCHLIST_PROMOTION.loadCommittedPromotions();
    const expected = WATCHLIST.length;
    const socket = await connectXRPL(); state._sock = socket; state._transportEpoch = 1;
    await scanWallets(socket);
    const pack = buildPack({}); state.pack = pack;
    const report = buildPublicReport(pack);
    return { expected, coverage: state.txScanCoverage, rows: state.txs.length, unique: new Set(state.txs.map(t => t.account + ':' + t.hash)).size,
      recovery: state.xrplRecovery, early: testPeer.early, report, checked: state.wallets.filter(w => w.status === 'CHECKED').length,
      anchors: [...new Set(testPeer.sent.filter(q => q.command === 'account_tx').map(q => q.ledger_index_max))] };
  });
  console.log('roster result', JSON.stringify({ ...roster, report: undefined, recovery: { ...roster.recovery, events: undefined } }));
  assert.ok(roster.expected >= 255);
  assert.equal(roster.checked, roster.expected);
  assert.equal(roster.coverage.complete_wallets, roster.expected);
  assert.equal(roster.coverage.target_wallets, roster.expected);
  assert.equal(roster.coverage.failed_wallets, 0);
  assert.equal(roster.coverage.full_window_complete, true);
  assert.equal(roster.rows, roster.expected * 133);
  assert.equal(roster.unique, roster.rows);
  assert.equal(roster.early, 0, 'nothing dispatched inside the supplied cooldown');
  assert.deepEqual(roster.anchors, [110000000]);
  assert.ok(roster.recovery.recovered > 0);
  assert.match(roster.report, /COMPLETE/);

  const rotation = await page.evaluate(async () => {
    testPeer.mode = 'rotate'; testPeer.rejected = false; testPeer.sent = [];
    state.xrplRecovery = null;
    const anchor = state.runAnchor.anchor_ledger;
    const rows = await accountTxWindowDepth(state._sock, WATCHLIST[0].address,
      state.txWindowEffective.startMs, state.txWindowEffective.endMs, 200);
    const proof = accountTxWindowDepth._proofByAccount[WATCHLIST[0].address];
    return { rows: rows.length, unique: new Set(rows.map(r => r.tx.hash)).size, proof, anchor,
      badMarkers: testPeer.sent.filter(q => q.marker && q.marker.socket !== q.socket), recovery: state.xrplRecovery };
  });
  console.log('rotation result', JSON.stringify(rotation));
  assert.equal(rotation.rows, 133);
  assert.equal(rotation.unique, 133);
  assert.equal(rotation.proof.status, 'COMPLETE');
  assert.equal(rotation.proof.anchor_ledger, rotation.anchor);
  assert.equal(rotation.badMarkers.length, 0);
  assert.equal(rotation.recovery.rotations, 1);

  const permanent = await page.evaluate(async () => {
    testPeer.mode = 'invalid'; testPeer.sent = [];
    try { await xrpl(state._sock, { command: 'account_tx', account: WATCHLIST[0].address }); }
    catch (e) { return { code: e.code, sent: testPeer.sent.length }; }
  });
  assert.deepEqual(permanent, { code: 'invalidParams', sent: 1 });
  const silence = await page.evaluate(async () => {
    testPeer.mode='silent';testPeer.sent=[];state.xrplRecovery=null;
    state._silentReplacements=0;state._runAbortReason=null;window.SW_XRPL_RPC_TIMEOUT_MS=30;
    const results=await Promise.allSettled(Array.from({length:8},(_,i)=>xrpl(state._sock,{command:'account_info',account:WATCHLIST[i].address})));
    return {rejected:results.filter(r=>r.status==='rejected').length,reason:state._runAbortReason,
      retired:state._silentReplacements,rotations:state.xrplRecovery.rotations,exhausted:state.xrplRecovery.exhausted,
      sent:testPeer.sent.length};
  });
  assert.equal(silence.rejected,8);
  assert.equal(silence.reason,'XRPL_TRANSPORT_SILENT');
  assert.equal(silence.retired,3);
  assert.equal(silence.rotations,3,'concurrent callers retire each silent socket once');
  assert.equal(silence.exhausted,true);
  console.log('silence result',JSON.stringify(silence));
  const budget = await page.evaluate(async () => {
    testPeer.sent = []; state.xrplRecovery = null;
    _noteQuota(new Error('rate limit: retry in ~999999999ms'), 'test');
    try { await xrpl(state._sock, { command: 'account_info', account: WATCHLIST[0].address }); }
    catch (e) { return { message: e.message, sent: testPeer.sent.length, exhausted: state.xrplRecovery.exhausted }; }
  });
  assert.equal(budget.sent, 0);
  assert.equal(budget.exhausted, true);
  assert.match(budget.message, /RECOVERY_EXHAUSTED/);
  console.log('ALL ADAPTIVE RECOVERY CHECKS PASS');
}
main().catch(e => { console.error(e); process.exitCode = 1; }).finally(async () => { if (browser) await browser.close(); server.close(); });
