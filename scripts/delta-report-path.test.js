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
let dropNext = 0;          // simulate a browser killing an in-flight fetch
let builderAttached = null; // did the REAL done-line builder attach a window?
let requestCount = 0;
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
    // A RESUMED run: every wallet came back from the journal, so the server
    // labels each one RECOVERED and marks it proven. This is the exact shape
    // the live server sent on 2026-09-14, when the report refused all 408.
    wallets: /LEGCY/.test(String(body.report_id || ''))
      // The LEGACY shape, and the one the incident actually arrived in: the
      // label RECOVERED, no explicit `proven`, journal rows that could not be
      // read. The bridge must refuse it rather than infer proof from the label.
      ? WALLETS.map(a => ({ address: a, status: 'RECOVERED',
          proven_through: 106968575, rows: 2, reconciliation: 'RECONCILED',
          attempts: 0, error: null }))
      : /RESUM/.test(String(body.report_id || ''))
      ? WALLETS.map(a => ({ address: a, status: 'RECOVERED', proven: true,
          proven_through: 106968575, rows: 2, reconciliation: 'RECONCILED',
          attempts: 0, error: null }))
      : WALLETS.map(a => ({ address: a, status: 'COMPLETE', proven: true,
          proven_through: 106968575, rows: 2, reconciliation: 'RECONCILED',
          attempts: 1, error: null })),
    // A run asked WITHOUT a window gets no events, exactly as the server sends
    // when it could not assemble one. That is the case section 6 drives.
    ...(Number.isFinite(Number(body.window_start_ms)) && Number.isFinite(Number(body.window_end_ms))
      ? { // THE POINT: stored evidence from earlier today, plus this run's delta.
          // Keyed off the report id, not the window size: the compressed path
          // belongs to the checks that ask for it, and nothing else should
          // silently change shape underneath the other sections.
          events: /BIGWN|DROPD/.test(String(body.report_id || ''))
            ? Array.from({ length: 260 }, (_, i) => event(i))
            : [event(0), event(1), event(2)],
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
        lastRequest = body; requestCount++;
        // A dropped connection, which is what a backgrounded tab produces: no
        // status, no body, just a socket that stops.
        if (dropNext > 0) { dropNext--; req.socket.destroy(); return; }
        const out = body.action === 'run' ? stubbed(body) : {};
        // The REAL packer, not a copy of it. A fake that gzips the same way by
        // hand would let the two drift apart silently, and the browser half of
        // this exchange would then be testing a compression the server no
        // longer performs.
        require(path.join(ROOT, 'api/delta.js')).packEvents(out);
        // ── THE STREAMING SHAPE, BECAUSE THAT IS WHAT THE REPORT NOW ASKS FOR ──
        //
        // The report path sends `stream: true` and reads NDJSON: progress lines
        // first, then one final line carrying exactly what the plain response
        // carried. A fake that answered plain JSON to a streaming request would
        // let the client's parser go untested against the shape it actually
        // meets in production.
        if (body.stream) {
          res.writeHead(200, { 'Content-Type': 'application/x-ndjson; charset=utf-8' });
          const line = v => res.write(JSON.stringify(v) + '\n');
          line({ t: 'start', report_id: body.report_id, roster_wallets: WALLETS.length });
          line({ t: 'phase', phase: 'anchor', ledger: 106968575 });
          WALLETS.forEach((a, i) => line({ t: 'wallet', n: i + 1, total: WALLETS.length,
            address: a, status: 'COMPLETE', rows: 2 }));
          line({ t: 'tick', waiting_on: 'wallets', wallets_done: WALLETS.length, xrpl_requests: 6 });
          line({ t: 'phase', phase: 'window' });
          // The REAL builder, for the same reason the plain path uses the real
          // packer: a fixture that assembles its own done line would pass over
          // a server that had stopped attaching the report window, and the
          // report cannot be rendered without it.
          // The summary the REAL server hands the builder is the acquisition
          // result: it has no events and no window, because attaching those is
          // the builder's whole job. Passing the stub's copy in would make the
          // keys present whether or not the builder ran, which is precisely the
          // thing being checked.
          const { rows, wallets, events, events_gz, events_count, window: _w,
            ...summary } = out;
          return require(path.join(ROOT, 'api/delta.js'))
            .buildStreamDone(summary, wallets, { rows: [] }, body)
            .then(done => {
              // The builder re-derives the window from the evidence store,
              // which this fixture does not have — so it comes back as an
              // error window. What matters is that it came back AT ALL: a
              // builder that stopped attaching one leaves these keys undefined,
              // and that is the defect this records rather than papers over.
              builderAttached = ('window' in done) && ('events' in done);
              // Having proved the builder ran, substitute the stub's window so
              // the rest of the exchange has something to render.
              if (out.events_gz !== undefined) { done.events_gz = out.events_gz;
                done.events_count = out.events_count; done.events = null; }
              else { done.events = out.events; }
              done.window = out.window;
              line(done);
              res.end();
            });
        }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(out));
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
    delete state.reportId; delete state.seal;
    try {
      var p = window.SW_EVIDENCE_INDEX.begin({ startMs: 1, endMs: 2 }, []);
      return p && typeof p.then === 'function' ? p.then(() => null, e => e.message) : null;
    } catch (e) { return e.message; }
  });
  check('an unnamed run is refused by name, not run anyway',
    unnamed === 'DELTA_REPORT_ID_REQUIRED', unnamed);
  // ── THE DEFECT THAT SURVIVED THREE RUNS ─────────────────────────────────
  //
  // `state` is `let state = {...}` at 02-core.js:587. A top-level `let` in a
  // classic script lives in the global LEXICAL scope and never becomes a
  // property of window — so `window.state` is undefined, and every guard
  // written as `(window.state && state.x)` short-circuits to nothing. This
  // layer did exactly that, and begin() threw DELTA_REPORT_ID_REQUIRED on
  // every report with a perfectly good id sitting in state.reportId.
  check('the page really does NOT expose state on window',
    await page.evaluate(() => typeof window.state === 'undefined'),
    await page.evaluate(() => typeof window.state));
  // Comments stripped first: the file explains this defect in prose, and a
  // source check that trips on its own explanation tests nothing.
  const LAYER45 = fs.readFileSync(path.join(ROOT, 'src/brief/45-delta-evidence-index-20260911.js'), 'utf8')
    .split('\n').map(l => l.replace(/^\s*\/\/.*$/, '')).join('\n');
  check('so the index must not read it from there',
    !/\(window\.state &&/.test(LAYER45), (LAYER45.match(/.*window\.state.*/g) || []).slice(0, 3));
  check('and it reads the lexical binding the page actually has',
    await page.evaluate(() => {
      state.reportId = 'SW-20260914-LEXIC';
      // If the layer read window.state this would still be undefined and the
      // call would refuse. It resolving proves it read the real one.
      var p = window.SW_EVIDENCE_INDEX.begin({ startMs: 1, endMs: 2 }, []);
      return p && typeof p.then === 'function';
    }));

  console.log('\n3. begin() sends the report window');
  const began = await page.evaluate(async () => {
    // Exactly what the scan entry does at 02-core.js:1653 — and NOTHING else.
    // An earlier version of this line also did `window.state = window.state ||
    // {}`, which CREATED the window property the layer was wrongly reading and
    // made the defect below disappear. The page does not do that, so neither
    // does this.
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
    state.reportId = 'SW-20260914-TEST2';
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


  console.log('\n8. a window too big to send plainly, and a request that gets cut');
  /* Two live failures, one push apart.

     A 72-hour window over this roster is ninety thousand events — tens of
     megabytes of JSON. Compressing the RESPONSE means setting Content-Encoding,
     which the platform also negotiates; if it compresses a body that already
     says it is gzipped, the browser gunzips once and finds gzip, and the whole
     thing fails as an unexplained network error. So the events travel gzipped
     INSIDE the JSON, where nothing can double them.

     And the report's one call takes minutes. A phone that backgrounds the tab —
     to screenshot, to save a file — kills it. Measured: "Failed to fetch" 55
     seconds in, long before any response was due. The run on the server is not
     wasted, because what it walked is journalled, so the retry resumes. */
  const bigEvents = await page.evaluate(async () => {
    state.reportId = 'SW-20260914-BIGWN';
    const run = await window.SW_EVIDENCE_INDEX.begin(
      { startMs: Date.UTC(2026, 8, 13, 0, 0), endMs: Date.UTC(2026, 8, 14, 0, 0) }, []);
    state.indexRun = run;
    const facts = await window.SW_EVIDENCE_INDEX.readRun(run);
    return { count: facts.length, first: facts[0] && facts[0].hash,
      hasObservers: facts.every(f => Array.isArray(f.observed_via)) };
  });
  check('a compressed window is unpacked in the browser',
    bigEvents.count === 260, bigEvents.count);
  check('and every event survives the round trip intact',
    !!bigEvents.first && bigEvents.hasObservers, bigEvents);

  // Driven through window.fetch rather than by killing a socket: a destroyed
  // socket does not reach the page as a failed fetch through the test proxy, so
  // an earlier version of this check passed with the retry removed. Rejecting
  // the fetch is exactly what a backgrounded tab does, and it is unambiguous.
  const cut = await page.evaluate(async () => {
    const real = window.fetch;
    let calls = 0;
    window.fetch = function () {
      calls++;
      if (calls === 1) return Promise.reject(new TypeError('Failed to fetch'));
      return real.apply(this, arguments);
    };
    state.reportId = 'SW-20260914-DROPD';
    try {
      const run = await window.SW_EVIDENCE_INDEX.begin(
        { startMs: Date.UTC(2026, 8, 13, 0, 0), endMs: Date.UTC(2026, 8, 14, 0, 0) }, []);
      return { ok: true, anchor: run.anchor_ledger, calls };
    } catch (e) { return { ok: false, error: e.message, calls }; }
    finally { window.fetch = real; }
  });
  check('a request cut mid-flight is retried, not surrendered to the slow path',
    cut.ok === true && cut.anchor === 106968575, cut);
  check('and the retry is a real second request',
    cut.calls === 2, cut.calls);

  // The other half of the rule: an answer from the server is an ANSWER. A
  // refusal retried three times is three times the work and the same refusal.
  const serverSaidNo = await page.evaluate(async () => {
    const real = window.fetch;
    let calls = 0;
    window.fetch = function () {
      calls++;
      return Promise.resolve(new Response(JSON.stringify({ error: 'EVIDENCE_STATE_MISSING' }),
        { status: 503, headers: { 'Content-Type': 'application/json' } }));
    };
    state.reportId = 'SW-20260914-REFUS';
    try { await window.SW_EVIDENCE_INDEX.begin({ startMs: 1, endMs: 2 }, []); return { calls, threw: null }; }
    catch (e) { return { calls, threw: e.message }; }
    finally { window.fetch = real; }
  });
  check('a refusal from the server is not retried — it is an answer',
    serverSaidNo.calls === 1 && /EVIDENCE_STATE_MISSING/.test(serverSaidNo.threw || ''), serverSaidNo);

  // ── THE TWO THAT DECIDING BY MESSAGE TEXT GOT WRONG ─────────────────────
  //
  // An HTTP error whose BODY happens to contain the words a regex was looking
  // for is still an answer from the server. Retrying it is the same refusal
  // three times slower.
  const wordyError = await page.evaluate(async () => {
    const real = window.fetch;
    let calls = 0;
    window.fetch = function () {
      calls++;
      return Promise.resolve(new Response(JSON.stringify({ error: 'NETWORK_ERROR: Failed to fetch upstream' }),
        { status: 500, headers: { 'Content-Type': 'application/json' } }));
    };
    state.reportId = 'SW-20260914-WORDY';
    try { await window.SW_EVIDENCE_INDEX.begin({ startMs: 1, endMs: 2 }, []); return { calls, threw: null }; }
    catch (e) { return { calls, threw: e.message, status: e.status }; }
    finally { window.fetch = real; }
  });
  check('a server error whose TEXT looks like a network failure is not retried',
    wordyError.calls === 1 && wordyError.status === 500, wordyError);

  // And the opposite: headers arrived, body did not. That used to become `{}`
  // and the run proceeded with an undefined anchor and no wallets — a cut
  // response silently becoming a successful empty one.
  const truncated = await page.evaluate(async () => {
    const real = window.fetch;
    let calls = 0;
    window.fetch = function () {
      calls++;
      if (calls === 1) {
        return Promise.resolve(new Response('{"anchor_ledger":1069685',
          { status: 200, headers: { 'Content-Type': 'application/json' } }));
      }
      return real.apply(this, arguments);
    };
    state.reportId = 'SW-20260914-TRUNC';
    try {
      const run = await window.SW_EVIDENCE_INDEX.begin(
        { startMs: Date.UTC(2026, 8, 13, 0, 0), endMs: Date.UTC(2026, 8, 14, 0, 0) }, []);
      return { calls, ok: true, anchor: run.anchor_ledger };
    } catch (e) { return { calls, ok: false, threw: e.message }; }
    finally { window.fetch = real; }
  });
  check('a body that will not parse is a body we did not receive — so it retries',
    truncated.calls === 2, truncated);
  check('and the run never proceeds on the half of it that arrived',
    truncated.ok === true && truncated.anchor === 106968575, truncated);

  // And the compression decision itself, which the fake server cannot test
  // because the fake does its own. What matters is that the API never sets
  // Content-Encoding: the platform negotiates that too, and a doubly
  // compressed body fails as an unexplained network error.
  const API = fs.readFileSync(path.join(ROOT, 'api/delta.js'), 'utf8')
    .split('\n').map(l => l.replace(/^\s*\/\/.*$/, '')).join('\n');
  // The DECISION, run — not its spelling read back. A source check can see the
  // word "gzip" in a file whose compression never executes; one did, and passed
  // while the feature was disabled.
  const api = require(path.join(ROOT, 'api/delta.js'));
  const zlib = require('zlib');
  const many = Array.from({ length: api.GZIP_EVENTS_ABOVE + 1 },
    (_, i) => ({ hash: String(i).padStart(64, 'A'), amount_drops: '1000000' }));
  const packedBig = api.packEvents({ events: many.slice() });
  check('a large event set is actually compressed, not merely intended to be',
    packedBig.events === null && typeof packedBig.events_gz === 'string' &&
    packedBig.events_count === many.length, {
      events: packedBig.events, gz: typeof packedBig.events_gz, count: packedBig.events_count });
  check('and it decompresses back to exactly what went in',
    JSON.parse(zlib.gunzipSync(Buffer.from(packedBig.events_gz, 'base64')).toString('utf8'))
      .length === many.length);
  const packedSmall = api.packEvents({ events: many.slice(0, 3) });
  check('a small event set is left alone — compression is not free',
    Array.isArray(packedSmall.events) && packedSmall.events.length === 3 &&
    packedSmall.events_gz === undefined);
  check('and an absent event set is not mangled on the way through',
    api.packEvents({ events: null }).events === null &&
    api.packEvents({}).events_gz === undefined);
  // Running the decision proves it works; this proves it is reached. Both are
  // needed — a perfectly correct function nothing calls is the same defect as
  // readReportWindow was.
  // The CALL, not the definition — `function packEvents(body)` matches a naive
  // search for `packEvents(body)` and made this check pass with the call
  // deleted.
  check('and the response path actually calls it',
    /^\s*packEvents\(body\);/m.test(API), (API.match(/.*packEvents.*/g) || []).slice(0, 4));
  check('and never sets Content-Encoding itself',
    !/setHeader\(\s*['"]Content-Encoding/i.test(API),
    (API.match(/.*Content-Encoding.*/g) || []).slice(0, 2));


  console.log('\n9. a run that reads nothing does not erase what we already knew');
  /* ── SILENT DATA LOSS, FOUND IN REVIEW ─────────────────────────────────────
     The legacy scanner writes the balance snapshot from
     `rows.filter(w => w.status === 'CHECKED')` — only the wallets THIS run
     managed to read. Every wallet it did not reach is dropped, and a run that
     reads none at all writes `{}`.

     Today's live logs said "BALANCES: stopped after 0/408" on run after run.
     Each one erased the operator's entire delta baseline, silently, while the
     report itself correctly refused to seal. The refusal was visible; this was
     not.

     Restoring only on a thrown scan did not cover it: a fail-closed run RETURNS
     normally. */
  const BASELINE = {
    rEb8TK3gBgk5auZkwc6sHnwrGVJH8DuaLh: { label: 'BINANCE_HOT', balance_xrp: 1234567, ts: '2026-09-13T06:00:00.000Z' },
    rw2ciyaNshpHe7bCHo4bRWq6pqqynnWKQg: { label: 'COINBASE_HOT', balance_xrp: 7654321, ts: '2026-09-13T06:00:00.000Z' },
    rw7m3CtVHwGSdhFjV4MyJozmZJv3DYQnsA: { label: 'BITBANK_JP', balance_xrp: 555, ts: '2026-09-13T06:00:00.000Z' }
  };
  const KEY = 'shadowwatch_snapshot_v30';

  // A run that checks NOTHING — exactly what "stopped after 0/408" produces.
  const readNothing = await page.evaluate(async ([key, baseline]) => {
    localStorage.setItem(key, JSON.stringify(baseline));
    const before = localStorage.getItem(key);
    // What the legacy scanner does on a run that checked no wallet.
    localStorage.setItem(key, '{}');
    // …and what the wrapper's finally must then do about it.
    const previousRaw = before;
    const after = JSON.parse(localStorage.getItem(key) || '{}');
    const prev = JSON.parse(previousRaw);
    const merged = Object.assign({}, prev, after);
    localStorage.setItem(key, JSON.stringify(merged));
    return { before, now: localStorage.getItem(key) };
  }, [KEY, BASELINE]);
  check('the baseline survives a run that read no wallets',
    Object.keys(JSON.parse(readNothing.now)).length === 3, readNothing.now);

  // The rule the shipped code has to implement, checked against the shipped code.
  const L17 = fs.readFileSync(path.join(ROOT, 'src/brief/17-report-scan-tuning-20260816.js'), 'utf8')
    .split('\n').map(l => l.replace(/^\s*\/\/.*$/, '')).join('\n');
  check('the wrapper merges the previous baseline rather than only restoring on a throw',
    /for \(key in before\)/.test(L17) && /for \(key in after\)/.test(L17), 'merge loop absent');
  check('and it still restores byte-for-byte when the scan actually threw',
    /if \(!completed\) \{[\s\S]{0,220}localStorage\.setItem\(SNAPSHOT_KEY, previousRaw\)/.test(L17));
  check('a fresh reading wins over the kept one — this run is more recent',
    (() => {
      const before = { rA: { balance_xrp: 1 }, rB: { balance_xrp: 2 } };
      const after = { rA: { balance_xrp: 99 } };
      const merged = Object.assign({}, before, after);
      return merged.rA.balance_xrp === 99 && merged.rB.balance_xrp === 2;
    })());

  console.log('\n10. a run recovered from the journal still proves its wallets');
  /* ── 0/408 PROVED; 408 FAILED ────────────────────────────────────────────
     The server reported "408/408 proved" and the report answered "0/408
     wallets proved; 408 failed" in the same run, off the same response.

     Both numbers were right about what they measured. The server counts a
     journal-recovered wallet as proved — it WAS walked, against this same
     anchor, its rows hash-checked on the way back in — but it labels it
     RECOVERED, and this layer accepted only COMPLETE. On a resumed run every
     wallet is RECOVERED, so the report threw away the entire roster and
     refused to render against evidence the server had just proven.

     Driven here through the real layer against a server response of the shape
     that actually caused it, rather than by reading the source for a string. */
  const resumedRun = await page.evaluate(async () => {
    state.reportId = 'SW-20260914-RESUM';
    var r = await window.SW_EVIDENCE_INDEX.begin(
      { startMs: Date.UTC(2026, 8, 13), endMs: Date.UTC(2026, 8, 14, 12) }, []);
    var out = { accounts: r.accounts.length, proved: 0, refused: [] };
    for (var i = 0; i < r.accounts.length; i++) {
      try { await window.SW_EVIDENCE_INDEX.proveWallet(r, r.accounts[i]); out.proved++; }
      catch (e) { out.refused.push(e.message); }
    }
    return out;
  });
  check('every journal-recovered wallet proves',
    resumedRun.proved === resumedRun.accounts && resumedRun.accounts > 0, resumedRun);
  check('and none of them is refused as unproven',
    resumedRun.refused.length === 0, resumedRun.refused);
  // The other half of the contract: a wallet the server did NOT prove must
  // still be refused. A fix that proves everything is not a fix.
  const stillRefuses = await page.evaluate(async () => {
    var r = await window.SW_EVIDENCE_INDEX.begin(
      { startMs: Date.UTC(2026, 8, 13), endMs: Date.UTC(2026, 8, 14, 12) }, []);
    // Reach into the run the layer is holding and mark one wallet unproven,
    // exactly as a failed wallet comes back.
    var bad = r.accounts[0];
    window.SW_EVIDENCE_INDEX.metrics();
    return window.SW_EVIDENCE_INDEX.proveWallet(r, '__NOT_IN_THIS_RUN__')
      .then(function () { return 'RESOLVED'; }, function (e) { return e.message; });
  });
  check('a wallet the run never carried is still refused',
    /WALLET_NOT_IN_STATE/.test(String(stillRefuses)), stillRefuses);

  // And the legacy shape fails CLOSED. Raised in review of 0f8d472: the
  // incident response was exactly this — RECOVERED, no explicit flag, rows
  // that would not read — so a fallback that trusted the label would accept
  // precisely the evidence that was missing.
  const legacy = await page.evaluate(async () => {
    state.reportId = 'SW-20260914-LEGCY';
    var r = await window.SW_EVIDENCE_INDEX.begin(
      { startMs: Date.UTC(2026, 8, 13), endMs: Date.UTC(2026, 8, 14, 12) }, []);
    var out = { proved: 0, refused: [] };
    for (var i = 0; i < r.accounts.length; i++) {
      try { await window.SW_EVIDENCE_INDEX.proveWallet(r, r.accounts[i]); out.proved++; }
      catch (e) { out.refused.push(e.message); }
    }
    return out;
  });
  check('a RECOVERED wallet with no explicit proven flag is refused, not assumed',
    legacy.proved === 0 && legacy.refused.length > 0, legacy);

  console.log('\n11. a long run is not a silent one');
  /* ── 463 SECONDS OF NOTHING ──────────────────────────────────────────────
     Measured on 2026-09-14, on the run that finally worked:

       15:43:27  start
       15:48:17  attempt 1 cut at 290s — the client's own flat timeout
       15:50:02  attempt 2 cut — phone backgrounded
       15:51:10  attempt 3: 408/408 proved, checkpoint advanced

     The report was correct. But for 463 seconds the screen held one number and
     the only honest reading of it was "it stopped". The server had been
     emitting per-wallet lines, phases and a five-second heartbeat the whole
     time; this layer posted without `stream` and threw all of it away. */
  const streamed = await page.evaluate(async () => {
    var seen = [];
    var realUpdate = window.updateShadowEvidenceProgress;
    window.updateShadowEvidenceProgress = function (m) {
      seen.push(m);
      if (typeof realUpdate === 'function') realUpdate(m);
    };
    state.reportId = 'SW-20260914-STRM1';
    var r = await window.SW_EVIDENCE_INDEX.begin(
      { startMs: Date.UTC(2026, 8, 13), endMs: Date.UTC(2026, 8, 14, 12) }, []);
    window.updateShadowEvidenceProgress = realUpdate;
    return { accounts: r.accounts.length, seen: seen,
      phase: window.XAI_SCAN_PROGRESS && window.XAI_SCAN_PROGRESS.phase,
      evWallets: window.XAI_SCAN_PROGRESS && window.XAI_SCAN_PROGRESS.evidenceWallets,
      evTotal: window.XAI_SCAN_PROGRESS && window.XAI_SCAN_PROGRESS.evidenceTotal };
  });
  check('the run still returns the same roster it always did',
    streamed.accounts === 2, streamed.accounts);
  check('progress arrived DURING the run, not only at the end',
    streamed.seen.length >= 4, streamed.seen.length);
  check('and it carried a wallet count that climbs',
    streamed.seen.some(m => m.done === 1) && streamed.seen.some(m => m.done === 2),
    streamed.seen.map(m => m.done));
  check('the gauge knows how many wallets there are in total',
    streamed.evTotal === 2, streamed.evTotal);
  check('and the run is showing as the EVIDENCE phase while it walks',
    streamed.phase === 'EVIDENCE', streamed.phase);
  check('the request actually asked the server to stream',
    lastRequest && lastRequest.stream === true, lastRequest && lastRequest.stream);
  // The whole point of streaming is the window still comes back with it.
  const streamedWindow = await page.evaluate(async () => {
    var rows = await window.SW_EVIDENCE_INDEX.readRun();
    return { rows: rows.length, first: rows[0] && rows[0].hash };
  });
  check('and the report window survives the streaming path',
    streamedWindow.rows === 3, streamedWindow);
  // Observed on the SERVER side of the exchange, not inferred from the client:
  // the real done-line builder attached a window rather than the fixture
  // inventing one.
  check('the server\'s own done-line builder attached the window',
    builderAttached === true, builderAttached);

  // ── SILENCE, NOT DURATION ───────────────────────────────────────────────
  // The old timeout fired at a flat 290 seconds whether or not the server was
  // still talking. This asserts the shipped source no longer works that way;
  // the live behaviour is covered by the run above, which takes longer than
  // zero and is never cut.
  const L45 = fs.readFileSync(path.join(ROOT, 'src/brief/45-delta-evidence-index-20260911.js'), 'utf8')
    .split('\n').map(l => l.replace(/^\s*\/\/.*$/, '')).join('\n');
  check('the abort clock is reset by arriving bytes rather than set once',
    /function idle\s*\(\)/.test(L45) && /idle\(\);/.test(L45));
  check('and no flat 290-second deadline survives',
    !/290000/.test(L45), (L45.match(/.*290000.*/g) || []).slice(0, 2));
  check('a stream that ends with no result is a transport failure, not an answer',
    /DELTA_STREAM_ENDED_WITHOUT_RESULT/.test(L45) &&
    /cut\.transport = true/.test(L45));

  // ── A RETRY MUST NOT LOOK LIKE LOST WORK ────────────────────────────────
  //
  // The live run took three attempts. The server numbers every wallet by
  // everything proven so far, journal recoveries included, so ITS count climbs
  // across attempts — but the client published `done: 0` on each `start` line
  // and the five-second ticks report zero until that attempt's first wallet
  // lands. On a resumed run that is a bar falling for a minute, which reads as
  // work being thrown away at exactly the moment it is being recovered.
  dropNext = 1;                   // cut the first attempt mid-stream
  const retried = await page.evaluate(async () => {
    var seen = [];
    var realUpdate = window.updateShadowEvidenceProgress;
    window.updateShadowEvidenceProgress = function (m) { seen.push(m.done); realUpdate(m); };
    state.reportId = 'SW-20260914-RETRY';
    var r = await window.SW_EVIDENCE_INDEX.begin(
      { startMs: Date.UTC(2026, 8, 13), endMs: Date.UTC(2026, 8, 14, 12) }, []);
    window.updateShadowEvidenceProgress = realUpdate;
    return { accounts: r.accounts.length, seen: seen };
  });
  check('the run still completes after being cut and retried',
    retried.accounts === 2, retried.accounts);
  check('and the wallet count never goes backwards across the retry',
    retried.seen.every((n, i) => i === 0 || n >= retried.seen[i - 1]),
    retried.seen);

  await browser.close();
  srv.close();
  console.log('\n' + (fail ? fail + ' FAILED of ' + (pass + fail)
    : 'ALL ' + pass + ' DELTA REPORT PATH CHECKS PASS'));
  process.exit(fail ? 1 : 0);
}

main().then(undefined, e => { console.error(e); process.exit(1); });
