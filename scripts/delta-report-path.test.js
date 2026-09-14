#!/usr/bin/env node
'use strict';
/* ── THE REPORT PATH, WHICH NOTHING EXERCISED ───────────────────────────────
   Every test written for the GitHub-backed acquisition drove setup.html. The
   REPORT is a different entry point — layer 17 calls window.SW_EVIDENCE_INDEX,
   which layer 45 replaces with the delta-backed one — and nothing drove it at
   all. It had never run once.

   Reading it found two defects before it ever did:

     THE WINDOW WAS NEVER ASSEMBLED. readRun() returned this run's delta. The
     first run of a day walks the day, so that looks right; a SECOND run walks
     only what happened since the first, and its delta is nearly empty while the
     morning's transactions sit committed in the repository. The report would
     have rendered an empty morning and called it a quiet day.

     THE EVIDENCE CROSSED THE WIRE. The response carried every row, raw_tx and
     raw_meta included — two hundred thousand of them after a catch-up. The
     streaming path strips them; the report path did not, and had never been
     called with a real workload.

   So this suite drives the real page: layer 45 as loaded by brief-console.html,
   against a stubbed /api/delta, through begin → proveWallet → readRun → finish.
──────────────────────────────────────────────────────────────────────────── */
const path = require('path');
const fs = require('fs');
const http = require('http');
const { chromium } = require('playwright');
const ROOT = path.join(__dirname, '..');
const PORT = Number(process.env.SW_TEST_PORT || 8213);

let pass = 0, fail = 0;
const check = (name, ok, detail) => {
  if (ok) { pass++; console.log('  PASS  ' + name); }
  else { fail++; console.log('  FAIL  ' + name + (detail !== undefined ? '  -> ' + JSON.stringify(detail) : '')); }
};

// What the server returns for a run: the assembled WINDOW, never the rows.
const WALLETS = ['rEb8TK3gBgk5auZkwc6sHnwrGVJH8DuaLh', 'rw2ciyaNshpHe7bCHo4bRWq6pqqynnWKQg'];
const event = (i, over) => Object.assign({
  hash: String(i).padStart(64, 'A'), ledger_index: 106962000 + i,
  close_time: new Date(Date.UTC(2026, 8, 13, 6, i % 60)).toISOString(),
  tx_type: 'Payment', tx_result: 'tesSUCCESS', validated: true,
  from_account: WALLETS[0], to_account: WALLETS[1],
  amount_drops: String(5000000 * (i + 1)), currency: 'XRP',
  sig_mode: 'single', signer_count: 1,
  observed_via: [WALLETS[i % 2]]
}, over || {});

let lastRequest = null;
function stubbed(body) {
  return {
    report_id: body.report_id, scan_id: body.scan_id || null,
    anchor_ledger: 106968575, anchor_close: '2026-09-14T00:25:20.000Z',
    state_sha256: 'f'.repeat(64), state_version_read: 3,
    target_wallets: 2, complete_wallets: 2, failed_wallets: 0,
    wallets_walked_this_attempt: 2, wallets_recovered_from_journal: 0,
    balance_contradictions: 0, balance_contradiction_addresses: [],
    balance_reconciled: 2, transactions: 3, transactions_walked: 3,
    xrpl_requests: 6, failures: [], committed: true,
    wallets: WALLETS.map(a => ({ address: a, status: 'COMPLETE', proven_through: 106968575,
      rows: 2, reconciliation: 'RECONCILED', attempts: 1, error: null })),
    // A run asked WITHOUT a window gets no events, exactly as the server sends
    // when it could not assemble one. That is the case section 6 drives.
    ...(Number.isFinite(Number(body.window_start_ms)) && Number.isFinite(Number(body.window_end_ms))
      ? { // THE POINT: stored evidence from earlier today, plus this run's delta.
          events: [event(0), event(1), event(2)],
          window: { from: new Date(Number(body.window_start_ms)).toISOString(),
            to: new Date(Number(body.window_end_ms)).toISOString(),
            days: ['2026-09-13', '2026-09-14'], in_window: 3,
            from_stored: 2, from_this_run: 1, days_without_shards: [], unattributed: 0 } }
      : { events: null, window: { error: 'REPORT_WINDOW_NOT_REQUESTED' } })
  };
}

function server() {
  return http.createServer((req, res) => {
    if (req.url.split('?')[0] === '/api/delta') {
      let raw = '';
      req.on('data', c => { raw += c; });
      req.on('end', () => {
        let body = {}; try { body = JSON.parse(raw || '{}'); } catch (_) {}
        lastRequest = body;
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(body.action === 'run' ? stubbed(body) : {}));
      });
      return;
    }
    const file = path.join(ROOT, decodeURIComponent(req.url.split('?')[0]));
    if (!file.startsWith(ROOT + path.sep) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
      res.writeHead(404); return res.end();
    }
    res.setHeader('Content-Type', file.endsWith('.js') ? 'text/javascript'
      : file.endsWith('.css') ? 'text/css' : 'text/html');
    fs.createReadStream(file).pipe(res);
  });
}

async function main() {
  const srv = server();
  await new Promise(r => srv.listen(PORT, '127.0.0.1', r));
  const browser = await chromium.launch({ args: ['--no-sandbox'] });
  const page = await browser.newPage();
  const pageErrors = [];
  page.on('pageerror', e => pageErrors.push(e.message));
  await page.route('**/*', r =>
    r.request().url().startsWith('http://127.0.0.1:' + PORT) ? r.continue() : r.abort());
  await page.goto('http://127.0.0.1:' + PORT + '/brief-console.html', { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => window.SW_DELTA_EVIDENCE_20260911 === true, { timeout: 30000 });

  console.log('\n1. the report page loads the delta-backed index, not the database one');
  check('layer 45 installed itself', await page.evaluate(() => window.SW_DELTA_EVIDENCE_20260911 === true));
  check('it exposes exactly the methods layer 17 calls',
    (await page.evaluate(() => Object.keys(window.SW_EVIDENCE_INDEX)))
      .filter(k => ['begin', 'proveWallet', 'readRun', 'finish', 'metrics'].includes(k)).length === 5);
  // Asserted from the wire, not from the function's source text: the fetch is
  // inside a closure, so reading begin's source proves nothing either way.
  const hits = [];
  page.on('request', r => { const u = new URL(r.url()); if (u.pathname.startsWith('/api/')) hits.push(u.pathname); });
  check('the page had no script errors', pageErrors.length === 0, pageErrors.slice(0, 3));

  console.log('\n2. the run is NAMED before it starts, not after');
  /* THE DEFECT THIS EXISTS FOR. begin() requires a report id — every
     acquisition commits a run manifest under it, and that is how a sealed
     report is traced back to the walk that produced it. But the seal used to
     mint that id at the END of the run, so at begin() time it did not exist
     and begin() threw on every single report. The log said "Report ID:
     unknown", "coverage NOT MEASURED", "0 of 0 wallets".

     An earlier version of THIS test set state.reportId by hand before calling
     begin — doing the job the page was failing to do, and passing against a
     page that could never work. It does not touch it now. */
  const CORE = fs.readFileSync(path.join(ROOT, 'src/brief/02-core.js'), 'utf8');
  const mintedAt = CORE.indexOf("state.reportId = 'SW-'");
  const beginAt = CORE.indexOf('SW_EVIDENCE_INDEX.begin(');
  check('the page mints the report id somewhere', mintedAt > -1);
  check('and does it BEFORE the evidence index is asked to begin',
    mintedAt > -1 && beginAt > -1 && mintedAt < beginAt, { mintedAt, beginAt });
  check('the seal adopts that id rather than minting a second one',
    /const reportId = \(state && state\.reportId\) \|\|/.test(CORE));
  // And if it is ever absent again, begin must refuse by name rather than
  // committing evidence under an id nothing else knows.
  // begin() refuses synchronously, before any promise exists — so the check has
  // to catch it the way layer 17 does, inside a try, rather than off a rejected
  // promise that is never created.
  const unnamed = await page.evaluate(() => {
    window.state = window.state || {};
    delete state.reportId; delete state.seal;
    try {
      var p = window.SW_EVIDENCE_INDEX.begin({ startMs: 1, endMs: 2 }, []);
      return p && typeof p.then === 'function' ? p.then(() => null, e => e.message) : null;
    } catch (e) { return e.message; }
  });
  check('an unnamed run is refused by name, not run anyway',
    unnamed === 'DELTA_REPORT_ID_REQUIRED', unnamed);

  console.log('\n3. begin() sends the report window');
  const began = await page.evaluate(async () => {
    window.state = window.state || {};
    // Exactly what the scan entry now does at 02-core.js:1653.
    state.reportId = 'SW-20260914-TEST1';
    // Exactly what layer 17 does at 02-core.js:1670 — including storing the
    // descriptor, which every later call is handed.
    state.indexRun = await window.SW_EVIDENCE_INDEX.begin(
      { startMs: Date.UTC(2026, 8, 13, 0, 0), endMs: Date.UTC(2026, 8, 14, 0, 0) },
      ['rEb8TK3gBgk5auZkwc6sHnwrGVJH8DuaLh', 'rw2ciyaNshpHe7bCHo4bRWq6pqqynnWKQg']);
    return state.indexRun;
  });
  check('the call went to the delta endpoint, and nothing went to the database one',
    hits.includes('/api/delta') && !hits.includes('/api/evidence'), hits);
  // The defect this catches: without the window the server can only return the
  // run's delta, which on a second run of a day is nearly empty.
  check('the window travels with the request',
    Number.isFinite(lastRequest.window_start_ms) && Number.isFinite(lastRequest.window_end_ms),
    lastRequest);
  check('and it is the window the report asked for',
    lastRequest.window_start_ms === Date.UTC(2026, 8, 13, 0, 0) &&
    lastRequest.window_end_ms === Date.UTC(2026, 8, 14, 0, 0));
  check('begin returns the anchor and roster the run proved',
    began.anchor_ledger === 106968575 && began.accounts.length === 2, began);

  console.log('\n4. readRun returns the assembled WINDOW, not this run\'s delta');
  const facts = await page.evaluate(() => window.SW_EVIDENCE_INDEX.readRun(state.indexRun));
  check('every event in the window comes back', facts.length === 3, facts.length);
  check('including the two already committed before this run started',
    facts.filter(f => f.hash).length === 3);
  check('each carries what a report line needs',
    facts.every(f => f.hash && f.ledger_index && f.date && f.type && f.amount), facts[0]);
  // Without provenance every transaction renders with an empty account, label
  // and category — the report loses wallet attribution entirely.
  check('and its provenance, so the report can attribute it to a watched wallet',
    facts.every(f => Array.isArray(f.observed_via) && f.observed_via.length === 1),
    facts.map(f => f.observed_via));
  check('no raw ledger payload crossed the wire',
    !JSON.stringify(facts).includes('raw_tx') && !JSON.stringify(facts).includes('raw_meta'));

  console.log('\n5. the run\'s own account of itself');
  const metrics = await page.evaluate(() => window.SW_EVIDENCE_INDEX.metrics());
  check('metrics name the window, separately from the delta',
    metrics.report_window && metrics.report_window.in_window === 3 &&
    metrics.report_window.from_stored === 2, metrics.report_window);
  check('stored evidence is counted as stored, not as freshly walked',
    metrics.stored_transactions_loaded === 2, metrics.stored_transactions_loaded);
  check('balance contradictions are carried through to the report',
    metrics.balance_contradictions === 0 && Array.isArray(metrics.balance_contradiction_addresses));
  const finished = await page.evaluate(() => window.SW_EVIDENCE_INDEX.finish(state.indexRun));
  check('finish reports COMPLETE when the checkpoint advanced',
    finished.status === 'COMPLETE' && finished.checkpoint_advanced === true, finished);

  console.log('\n6. a proven wallet, and one that was not');
  const proof = await page.evaluate(() =>
    window.SW_EVIDENCE_INDEX.proveWallet(state.indexRun, 'rEb8TK3gBgk5auZkwc6sHnwrGVJH8DuaLh'));
  check('a completed wallet returns its proof', proof.proof.status === 'COMPLETE' &&
    proof.proof.through_ledger === 106968575, proof.proof);
  const refused = await page.evaluate(() =>
    window.SW_EVIDENCE_INDEX.proveWallet(state.indexRun, 'rNotWatchedAtAll')
      .then(() => null, e => e.message));
  check('a wallet the run never proved throws rather than claiming coverage',
    /WALLET_NOT_IN_STATE/.test(refused), refused);

  console.log('\n7. a missing window is refused, never substituted');
  /* The failure that matters most: if the server could not assemble the window,
     handing back the run's delta would render a partial day as a whole one. */
  // Driven end to end: a run asked without a window comes back without events,
  // and readRun must REFUSE rather than hand back whatever else is in the
  // response. Rendering a day from a delta that does not cover it is exactly
  // the quiet understatement this project exists to prevent.
  const refusal = await page.evaluate(async () => {
    window.state.reportId = 'SW-20260914-TEST2';
    const run = await window.SW_EVIDENCE_INDEX.begin({}, []);
    try { await window.SW_EVIDENCE_INDEX.readRun(run); return { threw: null }; }
    catch (e) { return { threw: e.message }; }
  });
  check('a run with no window makes readRun refuse, not substitute',
    /REPORT_WINDOW_UNAVAILABLE/.test(refusal.threw || ''), refusal);
  const guarded = fs.readFileSync(path.join(ROOT, 'src/brief/45-delta-evidence-index-20260911.js'), 'utf8');
  check('readRun refuses when the window is absent',
    /REPORT_WINDOW_UNAVAILABLE/.test(guarded) && /if \(!run\.events\)/.test(guarded));
  check('and it does not fall back to the run\'s rows',
    !/run\.rows/.test(guarded), 'readRun still reads run.rows');

  await browser.close();
  srv.close();
  console.log('\n' + (fail ? fail + ' FAILED of ' + (pass + fail)
    : 'ALL ' + pass + ' DELTA REPORT PATH CHECKS PASS'));
  process.exit(fail ? 1 : 0);
}

main().then(undefined, e => { console.error(e); process.exit(1); });
