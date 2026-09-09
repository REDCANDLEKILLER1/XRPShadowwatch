#!/usr/bin/env node
/* ── THE SPOKEN TEXT MUST CARRY THE COVERAGE IT EARNED ────────────────────────
   The Morning Story is read aloud on air and posted to X. Before this, with the
   V1 pipeline enabled — the production default — it carried NO transaction
   window coverage caveat at all, even when coverage was explicitly incomplete.
   The structured report said INCOMPLETE. The spoken text said nothing.

   Measured on main by A/B against window.SW_PIPELINE_V1_KILL:

       V1 ON  (production)   caveat ABSENT
       V1 OFF                caveat present

   THE MECHANISM. Layer 17 wraps buildMorningStoryText to prepend the caveat.
   10-pipeline's _boot re-installs after 2000ms when
   window.buildMorningStoryText._pipelineV1Hooked is missing — and layer 17's
   wrapper did not carry that flag. So the re-install captured 17's wrapper as
   `legacy`, called it only to harvest prayer and scripture, and returned
   renderPublicReport(pack) instead. 17's caveat was computed and discarded.
   Fourteen separate wrappers sit on buildMorningStoryText, which is why no
   install marker survives to the outside.

   THE FIX IS NOT WINNING THE RACE. The renderer that actually produces the
   spoken text consumes the canonical verdict itself, from layer 17's
   coverageFrom — the same function the structured report and the X export use,
   not a second copy of the rule. The race is also closed, so losing it is not
   silent, but the text no longer depends on that.

   WORDING IS LOAD-BEARING. sanitizePublicNarrative DELETES every match, WARN
   included (body.replace(..., '')), so a caveat containing a forbidden pattern
   is silently gutted rather than rejected. These assert the rendered line
   survives sanitization intact.

   Run: node scripts/morning-story-coverage-truth.test.js
   Env: SW_TEST_PORT to override the port (default 8215).
──────────────────────────────────────────────────────────────────────────── */
'use strict';

const http = require('http');
const fs   = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const PORT = Number(process.env.SW_TEST_PORT || 8215);
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

// The pack fixtures, built in-page so the same shapes drive both modes.
const EVAL = `(() => {
  const mk = (cov) => ({ tx_scan_coverage: cov,
    tx_window:{label:'LAST 24H',startMs:Date.now()-86400000,endMs:Date.now()},
    large_transfers:[],escrow_transfers:[],txs:[],wallets:[],news_articles:[],
    news_intel:{top_headlines:[]},tx_24h_count:0,shadow_volume_xrp:0,
    xrp_price:1.42,wallets_checked:251,watchlist_total:251 });
  const full = {target_wallets:251,complete_wallets:251,failed_wallets:0,truncated_wallets:0,
                unproven_wallets:0,unknown_status_wallets:0,anchor_ok:true,full_window_complete:true};
  // ISOLATING: every pre-existing term satisfied, only unproven non-zero.
  const unprovenOnly = Object.assign({}, full, {unproven_wallets:32, full_window_complete:false});
  const noAnchor = Object.assign({}, full, {anchor_ok:false});
  const noKey = (() => { const c = Object.assign({}, full); delete c.unproven_wallets; return c; })();
  const story = (p) => { try { return String(window.buildMorningStoryText(p)||''); } catch(e){ return 'ERR '+e.message; } };
  const cov = (t) => (String(t).split('\\n').find(l => /Transaction window coverage/i.test(l)) || '');
  const goodText = story(mk(full));
  const idle = mk(null); idle.wallets_checked=0; idle.watchlist_total=0;
  const idleText = story(idle);
  const partialText = story(mk(Object.assign({}, full, {complete_wallets:235,failed_wallets:16,full_window_complete:false})));
  return {
    v1Enabled: window.SW_PIPELINE_V1_KILL !== true,
    goodQuiet: !/Transaction window coverage/i.test(goodText),
    goodLen: goodText.length,
    idleText, partialText, anchorlessText:story(mk(noAnchor)), missingKeyText:story(mk(noKey)),
    unproven: cov(story(mk(unprovenOnly))),
    noAnchor: cov(story(mk(noAnchor))),
    absentKey: cov(story(mk(noKey)))
  };
})()`;

async function runMode(killV1) {
  const exe = '/opt/pw-browsers/chromium-1194/chrome-linux/chrome';
  const browser = await chromium().launch(
    fs.existsSync(exe) ? { executablePath: exe, args: ['--no-sandbox'] } : { args: ['--no-sandbox'] });
  const page = await browser.newPage();
  const errs = [];
  page.on('pageerror', e => errs.push(e.message));
  if (killV1) await page.addInitScript(() => { window.SW_PIPELINE_V1_KILL = true; });
  await page.route('**/*', r =>
    r.request().url().startsWith('http://127.0.0.1:' + PORT) ? r.continue() : r.abort());
  await page.goto('http://127.0.0.1:' + PORT + '/brief-console.html', { waitUntil: 'domcontentloaded' });
  // Readiness gate, not a sleep: layer 17 arrives via an injection chain, and
  // testing before it lands would exercise the unwrapped core and pass
  // vacuously.
  await page.waitForFunction(() =>
    typeof window.buildMorningStoryText === 'function' &&
    !!window.SW_REPORT_SCAN_TUNING_20260816, null, { timeout: 60000 });
  // PAST the 2000ms re-install at 10-pipeline _boot — the whole question.
  await page.waitForTimeout(6000);
  const out = await page.evaluate(EVAL);
  out.errs = errs;
  await browser.close();
  return out;
}

(async () => {
  const srv = serve();

  const on  = await runMode(false);
  const off = await runMode(true);

  console.log('\n1. the caveat reaches the FINAL spoken text — V1 ON (production default)');
  console.log('     ' + (on.unproven || '(ABSENT)'));
  check('V1 is actually enabled in this mode', on.v1Enabled === true, on.v1Enabled);
  // THE REGRESSION. This was absent on main with V1 on.
  check('THE REGRESSION — an incomplete run is stated in the spoken text',
        /Transaction window coverage/i.test(on.unproven), on.unproven || '(ABSENT)');
  // ISOLATING: complete_wallets === target_wallets, zero failed, zero truncated,
  // so only the unproven term can produce this. complete_wallets:219 would be
  // decided by the older `complete === target` term and prove nothing new.
  check('and the unproven count is NAMED, not folded away',
        /32 unproven/.test(on.unproven), on.unproven);
  check('a run with no validated anchor is stated too',
        /Transaction window coverage/i.test(on.noAnchor), on.noAnchor || '(ABSENT)');
  check('an absent unproven count reads as NOT ESTABLISHED, never silence',
        /was not established this run/i.test(on.absentKey), on.absentKey || '(ABSENT)');

  console.log('\n2. V1 OFF — the legacy path must not regress');
  console.log('     ' + (off.unproven || '(ABSENT)'));
  check('V1 is actually disabled in this mode', off.v1Enabled === false, off.v1Enabled);
  check('the legacy path still states an incomplete run',
        /TRANSACTION WINDOW COVERAGE|Transaction window coverage/i.test(off.unproven),
        off.unproven || '(ABSENT)');
  check('and still states an absent coverage object',
        /NOT MEASURED|was not established/i.test(off.absentKey), off.absentKey || '(ABSENT)');

  console.log('\n3. the Lady K format is preserved on a clean run');
  // A complete run must stay quiet. A caveat on every report would train the
  // listener to ignore it, which is how a real one gets missed.
  check('a fully proven run carries NO coverage caveat — V1 ON', on.goodQuiet, on.goodQuiet);
  check('nor V1 OFF', off.goodQuiet, off.goodQuiet);
  check('and the report is still a full report, not a stub',
        on.goodLen > 1200 && off.goodLen > 1200, { on: on.goodLen, off: off.goodLen });

  console.log('\n4. the wording survives sanitizePublicNarrative');
  // The sanitizer DELETES matches rather than rejecting them, so a forbidden
  // pattern would silently gut the sentence. These are the categories that
  // would bite: cat 4 ALL_CAPS_UNDERSCORE, cat 6 braces/brackets, cat 8
  // "partial coverage", cat 12 "threshold".
  const line = on.unproven;
  check('no ALL_CAPS_UNDERSCORE token (cat 4 would delete a reason code)',
        !/\b[A-Z]{2,}(?:_[A-Z0-9]+){1,}\b/.test(line), line);
  check('no braces or brackets (cat 6)', !/[{}\[\]]/.test(line), line);
  check('does not say "partial coverage" (cat 8)', !/partial coverage/i.test(line), line);
  check('does not say "threshold" or "heuristic" (cat 12)',
        !/\b(threshold|heuristic|confidence score)\b/i.test(line), line);
  // The strongest form: the sentence came through the real sanitizer intact.
  check('the rendered sentence is complete, not gutted mid-clause',
        /proved the requested window/.test(line) && /all-clear\.$/.test(line.trim()), line);

  check('no page errors, V1 ON',  on.errs.length === 0,  on.errs.slice(0, 3));
  check('no page errors, V1 OFF', off.errs.length === 0, off.errs.slice(0, 3));

  console.log('\n5. missing evidence cannot sound like a quiet completed scan');
  for (const [label, text] of [['idle', on.idleText], ['partially acquired', on.partialText], ['anchorless', on.anchorlessText], ['missing proof status', on.missingKeyText]]) {
    check(label+' narrative withholds a quiet conclusion',
      !/nothing crossed that was worth waking|Calm rails|rails stayed calm|board sat still|rails ran quiet|No move crossed|Nothing hit the threshold|nothing to charge tonight|Nobody big blinked|Nothing forced my hand/i.test(text), text);
    check(label+' narrative explicitly states the unresolved read',
      /cannot establish whether|Coverage is the unresolved finding|acquired record is incomplete/i.test(text), text);
  }
  check('idle escrow does not manufacture measured zero releases or locks',
    !/Ripple, last .*: 0 releases|Other XRPL escrow, last .*none detected/i.test(on.idleText) &&
    /No Ripple escrow events are present in the acquired record/.test(on.idleText), on.idleText);

  srv.close();
  console.log('\n' + (fail ? fail + ' FAILED of ' + (pass + fail) : 'ALL ' + pass + ' CHECKS PASS'));
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
