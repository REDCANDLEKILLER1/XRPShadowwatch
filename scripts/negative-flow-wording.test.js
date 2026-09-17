#!/usr/bin/env node
/* ── A NEGATIVE IS A DIRECTION, NOT A BALANCE ────────────────────────────────
   Lady K read the 16 Sep report on air and stopped on a figure: "it had a
   negative balance on something. I've never seen a negative balance. What is
   that?"

   She was right to stop. An XRPL account cannot hold less than zero — the
   reserve floor makes it impossible — so a minus sign next to the word
   "balance" is either a bug or a lie, and neither belongs in something read
   aloud as fact.

   Driving the real renderers with a real outflow pack settled which surfaces
   say it wrong. The MEASUREMENT was never negative in the sense she feared:
   3.11M XRP left the watched wallets, and every surface agreed on that. What
   differed was the wording.

       Morning Story   • Net watched flow: −3.11M XRP outward      ← correct
       Public report   Net watchlist balance delta: -3.11M XRP     ← "balance"
       Intel brief     Net outflow of -3.11M XRP across 418 …      ← DOUBLE
       Ledger Story    Net flow across 418 watched wallets: -3.11M XRP.

   The intel brief is the worst of them: "outflow of minus 3.11M" states the
   direction twice and negates it once. Read literally it is an INFLOW — the
   exact opposite of the evidence. That is how a correct scan ends up sounding
   like volume went missing.

   The rule this suite enforces is the one the Morning Story already follows and
   the one Lady K reads correctly: MAGNITUDE POSITIVE, DIRECTION IN WORDS. A
   sign and a direction word never carry the same fact, and the word "balance"
   never appears beside a minus.

   Second half: the thing she actually asked about. Can a negative BALANCE (as
   opposed to a negative net flow) reach a report at all? The shared balance
   history is the only store that keeps per-wallet holdings, and this suite
   proves it refuses one — and that the aggregate cannot manufacture one out of
   wallets that were never read.

   Run: node scripts/negative-flow-wording.test.js
   Env: SW_TEST_PORT to override the port (default 8231).
──────────────────────────────────────────────────────────────────────────── */
'use strict';

const http = require('http');
const fs   = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const PORT = Number(process.env.SW_TEST_PORT || 8231);
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

  console.log('A NEGATIVE IS A DIRECTION, NOT A BALANCE\n');

  const r = await page.evaluate(() => {
    const o = { errs: [] };

    // One pack, three signs. Same everything else, so any difference in the
    // rendered text is the sign and nothing but the sign.
    const base = {
      date: '2026-09-16', wallets_checked: 418, watchlist_total: 418,
      shadow_volume_xrp: 610490000, tx_24h_count: 900,
      xrp_price: 1.33, xrp_delta_24h_pct: -0.1, xrp_volume_24h: 1.93e9,
      support: 1.2, resistance: 1.5,
      large_transfers: [{ from: 'rSENDER', to: 'rRECEIVER', amount_xrp: 2000000,
                          hash: 'HASH1', label: 'WATCHED_A' }],
      receiver_followthrough: [], top_signals: ['one signal'],
      evidence_quality: { grade: 'B', score: 78 },
      risk_score: { score: 40, label: 'AMBER', drivers: ['driver'] }
    };
    const OUT  = Object.assign({}, base, { total_balance_delta_xrp: -3110000 });
    const IN   = Object.assign({}, base, { total_balance_delta_xrp:  3110000 });
    const FLAT = Object.assign({}, base, { total_balance_delta_xrp:  0 });

    // Every prose surface that states the net figure, by the name production
    // calls it by. If one of these stops existing the suite fails rather than
    // quietly testing three things instead of four.
    const SURFACES = {
      public_report:  p => buildPublicReport(p),
      intel_brief:    p => buildIntelBrief(p),
      ledger_story:   p => buildLedgerNarrativeParagraph(p),
      morning_story:  p => canonicalMorningStory(p, { rebuild: true })
    };
    o.surfaceNames = Object.keys(SURFACES);
    o.surfacesPresent = {};
    Object.keys(SURFACES).forEach(k => {
      const fnName = { public_report: 'buildPublicReport', intel_brief: 'buildIntelBrief',
                       ledger_story: 'buildLedgerNarrativeParagraph',
                       morning_story: 'canonicalMorningStory' }[k];
      o.surfacesPresent[k] = typeof window[fnName] === 'function' || typeof eval(fnName) === 'function';
    });

    // A minus, in either the ASCII or the typographic form the app uses, sitting
    // in front of a number.
    const SIGNED = '[-\\u2212\\u2013]\\s?[\\d.]';
    // The double negative: a direction word and a signed magnitude close enough
    // together to be one statement.
    const DOUBLE_NEG = new RegExp(
      '(?:out|in)(?:flow|ward|bound)\\b[^.\\n]{0,14}' + SIGNED + '|' +
      SIGNED + '[\\d.,]*\\s?[KMB]?\\s*XRP[^.\\n]{0,18}(?:out|in)(?:flow|ward|bound)\\b', 'i');
    // The word she stopped on, next to a minus.
    const NEG_BALANCE = new RegExp('balance[^.\\n]{0,40}' + SIGNED, 'i');

    function render(fn, p) { return String(fn(p) || ''); }

    o.text = {};
    Object.keys(SURFACES).forEach(k => {
      try {
        o.text[k] = { out: render(SURFACES[k], OUT), in: render(SURFACES[k], IN),
                      flat: render(SURFACES[k], FLAT) };
      } catch (e) { o.errs.push(k + ': ' + e.message); o.text[k] = null; }
    });

    o.verdict = {};
    Object.keys(o.text).forEach(k => {
      const t = o.text[k];
      if (!t) { o.verdict[k] = null; return; }
      // The offending lines, kept so a failure names the sentence and not a flag.
      const offending = s => s.split('\n').filter(l => DOUBLE_NEG.test(l) || NEG_BALANCE.test(l));
      o.verdict[k] = {
        outDouble:      offending(t.out),
        inDouble:       offending(t.in),
        flatDouble:     offending(t.flat),
        // NON-VACUITY. A surface that simply stopped printing the number would
        // pass every rule above, so the magnitude has to be there, the two
        // directions have to read differently, and the flat case has to be flat.
        outHasMagnitude:  /3\.11M/.test(t.out),
        inHasMagnitude:   /3\.11M/.test(t.in),
        outSaysOut:       /\b(outward|outflow|outbound|pushed out|lost)\b/i.test(t.out),
        inSaysIn:         /\b(inward|inflow|inbound|took in|gained)\b/i.test(t.in),
        outIsNotIn:       t.out !== t.in,
        flatHasNoSign:    !new RegExp(SIGNED + '[\\d.,]*\\s?[KMB]?\\s*XRP').test(t.flat),
        length:           t.out.length
      };
    });

    // ── THE THING SHE ASKED ABOUT ─────────────────────────────────────────
    // Not "is the net flow negative" but "can a WALLET hold a negative amount".
    try {
      const H = window.SW_HVT_HISTORY;
      const before = JSON.stringify(H.all());
      o.hvt = {};
      o.hvt.negRefused    = H.record('rNEGATIVE1111111111111111111111111', -5000, 'test') === null;
      o.hvt.negNotStored  = !H.all()['rNEGATIVE1111111111111111111111111'];
      o.hvt.nanRefused    = H.record('rNANTEST11111111111111111111111111', NaN, 'test') === null;
      o.hvt.infRefused    = H.record('rINFTEST11111111111111111111111111', Infinity, 'test') === null;
      // A genuine emptying is NOT a negative — it is a zero, and it must still
      // register, or a drained wallet becomes invisible.
      H.record('rDRAINED111111111111111111111111111', 2000000, 'test');
      const st = H.record('rDRAINED111111111111111111111111111', 0, 'test');
      o.hvt.zeroAccepted  = !!st && st.state === 'DRAINED';
      o.hvt.zeroRatio     = st ? st.ratio : null;
      o.hvt.alertsNoNeg   = H.alerts().every(a => a.balance >= 0 && (a.ratio == null || a.ratio >= 0));
      o.hvt.unchanged     = before === before; // placeholder, replaced below
    } catch (e) { o.errs.push('hvt: ' + e.message); }

    // ── THE AGGREGATE CANNOT INVENT ONE ───────────────────────────────────
    // Every row starts life at balance_xrp: 0 and only becomes CHECKED after a
    // successful read. A row that never got a reading still carries that 0 and a
    // real previous balance — so if the aggregate counted it, a wallet the node
    // simply refused would read as if it had been emptied.
    // The FAILED and PENDING rows below deliberately CARRY a delta. A null there
    // would make this pass on n(null) === 0 and prove nothing about the status
    // filter — which is the thing that actually stops an unread wallet from
    // reading as an emptied one.
    try {
      const saved = state.wallets;
      state.wallets = [
        { address:'rREAD', label:'A', status:'CHECKED', balance_xrp: 100,  prev_balance_xrp: 1000,  delta_xrp: -900 },
        { address:'rFAIL', label:'B', status:'FAILED',  balance_xrp: 0,    prev_balance_xrp: 5e6,   delta_xrp: -5e6 },
        { address:'rPEND', label:'C', status:'PENDING', balance_xrp: 0,    prev_balance_xrp: 9e6,   delta_xrp: -9e6 },
        { address:'rNEW',  label:'D', status:'CHECKED', balance_xrp: 50,   prev_balance_xrp: null,  delta_xrp: null }
      ];
      o.aggregate = { total: totalDeltaXRP() };
      state.wallets = saved;
    } catch (e) { o.errs.push('aggregate: ' + e.message); }

    // ── "HOLDING 0% OF WHAT IT ONCE HELD" ─────────────────────────────────
    // The drain line rounds a ratio into a percentage. An unknown ratio must not
    // round to 0% — that reads as a total drain and is a claim, not a reading.
    try {
      const H = window.SW_HVT_HISTORY;
      H.record('rNOPEAK111111111111111111111111111', 900, 'test');
      const st = H.status('rNOPEAK111111111111111111111111111', 900);
      o.noPeakRatioNull = st.ratio === null;
      o.noPeakNotAlerted = !H.alerts().some(a => a.address === 'rNOPEAK111111111111111111111111111');

      // Drive the real action line with a null ratio. alerts() does not produce
      // one today, so stub it — otherwise the guard against "holding 0%" is
      // asserted against an input that never arrives, which tests nothing.
      const realAlerts = H.alerts;
      const savedRecv = state.receivers, savedSig = state.sigChanges, savedFrags = state.frags;
      try {
        state.receivers = []; state.sigChanges = []; state.frags = [];
        H.alerts = () => ([
          { address: 'rUNKNOWNRATIO1111111111111111111', balance: 500, state: 'DRAINED',
            expected: 0, ratio: null, gone: 0 },
          { address: 'rREALDRAIN11111111111111111111111', balance: 40000, state: 'DRAINED',
            expected: 2000000, ratio: 0.02, gone: 1960000 }
        ]);
        const acts = _intelActions({}).join('\n');
        o.actionLines = acts.split('\n').filter(l => /is holding/.test(l));
        o.unknownRatioSilent = !/rUNKNOWNRATIO|holding 0%/.test(acts);
        o.realDrainStillSpoken = /holding 2% of what it once held/.test(acts);
      } finally {
        H.alerts = realAlerts;
        state.receivers = savedRecv; state.sigChanges = savedSig; state.frags = savedFrags;
      }
    } catch (e) { o.errs.push('nopeak: ' + e.message); }

    // ── THE DASHBOARD SAYS IT TOO ─────────────────────────────────────────
    // The HUD panel read "Net Balance Delta · OUTFLOW · -3.11M XRP" — the same
    // sentence as the report, split across three elements.
    try {
      o.hud = {};
      renderHudFromPack(OUT);
      o.hud.outValue = (document.getElementById('hudNetDelta') || {}).textContent;
      o.hud.outBadge = (document.getElementById('hudDeltaBadge') || {}).textContent;
      renderHudFromPack(IN);
      o.hud.inValue  = (document.getElementById('hudNetDelta') || {}).textContent;
      o.hud.inBadge  = (document.getElementById('hudDeltaBadge') || {}).textContent;
      o.hud.title = (function () {
        const b = document.getElementById('hudDeltaBadge');
        return b && b.parentNode ? b.parentNode.textContent.trim() : '';
      })();
    } catch (e) { o.errs.push('hud: ' + e.message); }

    return o;
  });

  (r.errs || []).forEach(e => console.log('  (render error) ' + e));

  // ── 1. EVERY SURFACE IS ACTUALLY UNDER TEST ────────────────────────────────
  check('all four net-flow surfaces exist and rendered',
    r.surfaceNames.length === 4 && Object.keys(r.text || {}).every(k => r.text[k]),
    { names: r.surfaceNames, rendered: Object.keys(r.text || {}).filter(k => r.text[k]) });

  // ── 2. NO SURFACE STATES THE DIRECTION TWICE ───────────────────────────────
  Object.keys(r.verdict || {}).forEach(k => {
    const v = r.verdict[k];
    if (!v) return;
    check(k + ': outflow is not written as a negative',      v.outDouble.length === 0,  v.outDouble);
    check(k + ': inflow is not written as a negative',       v.inDouble.length === 0,   v.inDouble);
    check(k + ': flat run carries no stray minus',           v.flatDouble.length === 0, v.flatDouble);
  });

  // ── 3. NON-VACUITY: THE FIGURE IS STILL THERE AND STILL DIRECTIONAL ────────
  Object.keys(r.verdict || {}).forEach(k => {
    const v = r.verdict[k];
    if (!v) return;
    check(k + ': still prints the 3.11M magnitude on outflow', v.outHasMagnitude, v);
    check(k + ': still prints the 3.11M magnitude on inflow',  v.inHasMagnitude, v);
    check(k + ': says the money went out',                     v.outSaysOut, v);
    check(k + ': says the money came in',                      v.inSaysIn, v);
    check(k + ': outflow and inflow do not read identically',  v.outIsNotIn);
    check(k + ': a flat run prints no signed XRP figure',      v.flatHasNoSign, v);
  });

  // ── 4. A NEGATIVE BALANCE CANNOT BE STORED ─────────────────────────────────
  const h = r.hvt || {};
  check('a negative balance is refused by the shared history',  h.negRefused === true);
  check('and nothing is written for it',                        h.negNotStored === true);
  check('NaN is refused',                                       h.nanRefused === true);
  check('Infinity is refused',                                  h.infRefused === true);
  check('a genuine emptying still registers as DRAINED',        h.zeroAccepted === true, h);
  check('a drained wallet reports ratio 0, never below',        h.zeroRatio === 0, h.zeroRatio);
  check('no alert ever carries a negative balance or ratio',    h.alertsNoNeg === true);

  // ── 5. THE AGGREGATE COUNTS ONLY WALLETS THAT WERE READ ────────────────────
  // −900 is the one real delta. −5,000,900 or −14,000,900 would mean an unread
  // wallet was counted as emptied.
  check('net flow sums only CHECKED wallets (unread ≠ emptied)',
    r.aggregate && r.aggregate.total === -900, r.aggregate);

  // ── 6. AN UNKNOWN RATIO IS NOT 0% ──────────────────────────────────────────
  check('a wallet with no peak has a null ratio, not zero',     r.noPeakRatioNull === true);
  check('and is not reported as drained',                       r.noPeakNotAlerted === true);
  check('an unknown drain ratio produces no line, not "holding 0%"',
    r.unknownRatioSilent === true, r.actionLines);
  check('a real 2% drain is still spoken (the guard is not a mute)',
    r.realDrainStillSpoken === true, r.actionLines);

  // ── 7. THE DASHBOARD PANEL, WHICH SAID IT THREE TIMES ──────────────────────
  const hud = r.hud || {};
  check('HUD value carries the magnitude, not the sign',
    hud.outValue === '3.11M XRP' && hud.inValue === '3.11M XRP', hud);
  check('HUD badge is the only thing that states direction',
    hud.outBadge === 'OUTFLOW' && hud.inBadge === 'INFLOW', hud);
  check('HUD panel no longer calls a flow a balance',
    typeof hud.title === 'string' && !/balance/i.test(hud.title), hud.title);

  check('no page errors', errs.length === 0, errs.slice(0, 3));

  console.log('\n' + (fail === 0 ? 'ALL ' + pass + ' CHECKS PASS' : pass + ' pass, ' + fail + ' FAIL'));
  await browser.close();
  srv.close();
  process.exit(fail === 0 ? 0 : 1);
})().catch(e => { console.error(e); process.exit(1); });
