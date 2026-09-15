#!/usr/bin/env node
/* ── A PHASE THAT SAYS NOTHING LOOKS EXACTLY LIKE A PHASE THAT HUNG ──────────
   SW-20260915-TBUCI ran 17m11s and its run log was silent for 13m26s of it —
   78% of the run — in four stretches:

       15:00:34 → 15:06:43   6m09s   Phase 1 balance pass, 408 wallets
       15:06:51 → 15:07:58   1m07s   escrow backfill
       15:08:16 → 15:10:37   2m21s   offers
       15:10:37 → 15:14:26   3m49s   offers, continued

   The scan was working correctly the whole time. The operator could not tell,
   and that is the whole defect: the app's only honest liveness signal was mute
   for the stretches where a person is deciding whether to give up.

   The LIVE SCAN LOG panel was not misplaced — it already holds the prime row-1
   slot and already repaints on every live tick. It had nothing to repaint.

   Two properties:
     1. a long loop reports at bounded intervals, and does not write one line
        per wallet into a log a human has to read
     2. the silence is MEASURED and shipped in every TOTAL DEBUG, so the next
        phase that goes quiet is found by reading a number rather than by
        someone abandoning a scan

   Run: node scripts/scan-liveness.test.js
──────────────────────────────────────────────────────────────────────────── */
'use strict';

const fs   = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const SRC  = fs.readFileSync(path.join(ROOT, 'src/brief/02-core.js'), 'utf8');

let pass = 0, fail = 0;
const check = (name, ok, detail) => {
  if (ok) { pass++; console.log('  PASS  ' + name); }
  else { fail++; console.log('  FAIL  ' + name + (detail !== undefined ? '  -> ' + JSON.stringify(detail) : '')); }
};

// 02-core is a 32k-line browser file with no module boundary, so the two pure
// functions are lifted by source extraction rather than by loading the engine.
// Extraction is verified below: if the shape changes, the guard fails loudly
// instead of testing a stale copy.
function lift(name) {
  const at = SRC.indexOf('\nfunction ' + name + '(');
  if (at < 0) throw new Error('could not find function ' + name);
  let i = SRC.indexOf('{', at), depth = 0, end = -1;
  for (let j = i; j < SRC.length; j++) {
    if (SRC[j] === '{') depth++;
    else if (SRC[j] === '}') { depth--; if (depth === 0) { end = j + 1; break; } }
  }
  if (end < 0) throw new Error('unbalanced body for ' + name);
  return SRC.slice(at + 1, end);
}

console.log('SCAN LIVENESS — A WORKING SCAN MUST NOT LOOK HUNG\n');

// ══ 0. THE SOURCE IS THE ONE UNDER TEST ══════════════════════════════════════
console.log('0. the functions under test are the shipped ones');
let logTickSrc = '', silenceSrc = '';
try { logTickSrc = lift('logTick'); } catch (e) { /* reported below */ }
try { silenceSrc = lift('runLogSilence'); } catch (e) { /* reported below */ }
check('logTick was extracted from 02-core', /_logTickAt/.test(logTickSrc), logTickSrc.slice(0, 60));
check('runLogSilence was extracted from 02-core', /max_gap_ms/.test(silenceSrc), silenceSrc.slice(0, 60));

// Build a sandbox with a recording log().
const emitted = [];
let NOW = 1000000;
const sandbox = {
  Date: { now: () => NOW },
  log: msg => emitted.push(msg),
  Number, String, Array, RegExp, Math
};
const factory = new Function('Date', 'log', 'Number', 'String', 'Array', 'RegExp', 'Math',
  'var _logTickAt = {};' + logTickSrc + silenceSrc +
  'return { logTick: logTick, runLogSilence: runLogSilence, reset: function(){ _logTickAt = {}; } };');
const M = factory(sandbox.Date, sandbox.log, Number, String, Array, RegExp, Math);

// ══ 1. A LONG LOOP REPORTS, AND DOES NOT SHOUT ═══════════════════════════════
console.log('\n1. a long loop reports at bounded intervals');
emitted.length = 0; M.reset();
check('the first call always speaks', M.logTick('balances', 'Balances: 8 / 408 wallets read', 10000) === true);
check('and it reached the log', emitted.length === 1 && /8 \/ 408/.test(emitted[0]), emitted);

NOW += 1000;
check('a call one second later is throttled', M.logTick('balances', 'Balances: 16 / 408', 10000) === false);
check('nothing was written', emitted.length === 1, emitted);

NOW += 9500;   // 10.5s since the first
check('a call past the interval speaks again', M.logTick('balances', 'Balances: 96 / 408', 10000) === true);
check('and it reached the log', emitted.length === 2 && /96 \/ 408/.test(emitted[1]), emitted);

console.log('\n   the real loop shape: 408 wallets, 8 at a time, 6m09s');
emitted.length = 0; M.reset();
NOW = 2000000;
const CHUNKS = 51;                        // 408 / 8
const PER_CHUNK_MS = 369000 / CHUNKS;     // the measured 6m09s pass
for (let c = 1; c <= CHUNKS; c++) {
  M.logTick('balances', 'Balances: ' + (c * 8) + ' / 408 wallets read', 10000);
  NOW += PER_CHUNK_MS;
}
check('it spoke during the pass rather than at the end', emitted.length >= 10, emitted.length);
check('it did not write one line per chunk', emitted.length < CHUNKS, emitted.length);
check('the operator sees a moving count', /Balances: \d+ \/ 408/.test(emitted[emitted.length - 1] || ''),
      emitted[emitted.length - 1]);
// The point of the whole exercise: no stretch of that pass is silent for long.
(() => {
  const stamped = [];
  let t = 0;
  emitted.forEach(() => {});
  // Re-run recording emission times so the gap is measured, not assumed.
  emitted.length = 0; M.reset(); NOW = 3000000;
  const times = [];
  for (let c = 1; c <= CHUNKS; c++) {
    if (M.logTick('balances', 'Balances: ' + (c * 8) + ' / 408', 10000)) times.push(NOW);
    NOW += PER_CHUNK_MS;
  }
  let worst = 0;
  for (let i = 1; i < times.length; i++) worst = Math.max(worst, times[i] - times[i - 1]);
  // A single emission leaves the loop above untouched and `worst` at 0, which
  // would pass this check while the pass was in fact silent throughout — the
  // exact shape of the bug being fixed. Require enough emissions for the gap to
  // mean something before believing it.
  check('there were enough lines for a gap to be measurable', times.length >= 10, times.length);
  check('no gap inside the pass exceeds 15s',
        times.length >= 10 && worst <= 15000, Math.round(worst) + 'ms over ' + times.length + ' lines');
})();

console.log('\n   phases do not throttle each other');
emitted.length = 0; M.reset(); NOW = 4000000;
M.logTick('balances', 'Balances: 8 / 408', 10000);
check('a different phase speaks immediately', M.logTick('offers', 'Offers: 8 / 408', 10000) === true);
check('both lines are present', emitted.length === 2, emitted);

// ══ 2. THE SILENCE IS MEASURED ═══════════════════════════════════════════════
console.log('\n2. the silence is measured, not assumed');

// The real run log of SW-20260915-TBUCI, at its four transitions.
const TBUCI = [
  '[15:00:33] XRPL link dropped — reconnecting…',
  '[15:00:34] XRPL link re-established. Scan continues.',
  '[15:06:43] Phase 1 complete. Phase 2 tx-scan needed for 408 / 408 wallets.',
  '[15:06:51] Ripple escrow current position: 31,700,000,000 XRP',
  '[15:07:58] Escrow backfill: 437 event(s) in 30d history.',
  '[15:08:16] NEXT_HOP: rKHfQY…fn9J RECEIVER_STILL_HOLDING_SIZE 1.14M XRP',
  '[15:10:37] ✓ OFFERS COREUM_INC_FRONT_A: 1',
  '[15:14:26] OFFERS total: 1 active across 408 wallets'
];
const s = M.runLogSilence(TBUCI);
console.log('     max gap: ' + Math.round(s.max_gap_ms / 1000) + 's · stretches over 30s: ' + s.gaps_over_30s);
check('every stamped line was counted', s.lines === TBUCI.length, s.lines);
check('the worst gap is the 6m09s balance pass', s.max_gap_ms === 369000, s.max_gap_ms);
check('it names the line the silence began after',
      /XRPL link re-established/.test(String(s.max_gap_after)), s.max_gap_after);
check('it names the line that broke it',
      /Phase 1 complete/.test(String(s.max_gap_before)), s.max_gap_before);
check('all four stretches over 30s are counted', s.gaps_over_30s === 4, s.gaps_over_30s);

console.log('\n   a talkative run measures as quiet');
const CHATTY = ['[10:00:00] a', '[10:00:05] b', '[10:00:11] c', '[10:00:19] d'];
const cs = M.runLogSilence(CHATTY);
check('max gap is the real 8s', cs.max_gap_ms === 8000, cs.max_gap_ms);
check('no stretch counts as a stall', cs.gaps_over_30s === 0, cs.gaps_over_30s);

console.log('\n   it does not invent gaps it cannot know');
const MESSY = ['no timestamp here', '[10:00:00] a', 'also unstamped', '[10:00:04] b'];
const ms2 = M.runLogSilence(MESSY);
check('unstamped lines are skipped, not guessed', ms2.lines === 2, ms2.lines);
check('the gap is between the stamped pair', ms2.max_gap_ms === 4000, ms2.max_gap_ms);
const BACKWARDS = ['[23:59:58] a', '[00:00:02] b', '[00:00:09] c'];
const bs = M.runLogSilence(BACKWARDS);
check('a clock that wraps midnight contributes no negative gap',
      bs.max_gap_ms === 7000, bs.max_gap_ms);
check('empty input is empty, not an error',
      M.runLogSilence([]).max_gap_ms === 0 && M.runLogSilence(null).max_gap_ms === 0);

// ══ 3. THE LOOPS THAT WENT QUIET NOW REPORT ══════════════════════════════════
// Source guards, and named as such: these assert the call sites exist, not that
// they fire. What proves they fire is run_log_silence, measured on every run.
console.log('\n3. the four measured stretches have a reporter (source guard)');
check('the balance pass reports', /logTick\('balances'/.test(SRC));
check('the offer sweep reports', /logTick\('offers'/.test(SRC));
check('escrow backfill reports', /logTick\('escrow-backfill'/.test(SRC));
check('the run records its own worst silence onto the pack',
      /p\.run_log_silence\s*=/.test(SRC));
check('resetLog clears the throttle so run 2 is not muted by run 1',
      /function resetLog\(\)[^}]*_logTickAt\s*=\s*\{\}/.test(SRC));

console.log('\n' + (fail === 0 ? 'ALL ' + pass + ' CHECKS PASS' : pass + ' pass, ' + fail + ' FAIL'));
process.exit(fail === 0 ? 0 : 1);
