#!/usr/bin/env node
/* ── A TIMEOUT IS NOT A REFUSAL, AND THE DIFFERENCE COSTS MINUTES ────────────
   SW-20260915-D49XL, measured from its own run log:

       18:33:03 → 18:35:27   160 wallets   0.90 s/wallet
       18:35:47  xrplcluster.com times out and is retired
       18:35:49  reconnected to honeycluster.io
       18:35:51-18:36:01  five "recovered account_info after 1 retry(s)"
       18:35:27 → 18:37:37    48 wallets   2.71 s/wallet   <- 3x slower

   One backoff served both causes — halve the concurrency, double the gap. That
   is right when the SERVER names a quota ("2000 units per 10s, wait 60s"). It
   is wrong for a socket going quiet: that is one endpoint failing, the socket
   is rotated anyway, and halving concurrency on top punishes the healthy
   replacement for the dead one's silence.

   Six backoffs took limit 8→1 and gap 25→1000ms. Recovery could not undo it:
   a slot returned only after 64 CONSECUTIVE successes and `successes` resets to
   zero on every backoff, so climbing 1→8 needed ~448 clean reads in a run that
   makes about 870. One timeout storm set the concurrency for the whole run.

   Quota backoff is deliberately unchanged. It is the server's instruction and
   this project does not argue with a named cooldown.

   Run: node scripts/xrpl-admission-recovery.test.js
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

function lift(name) {
  const at = SRC.indexOf('\nfunction ' + name + '(');
  if (at < 0) throw new Error('could not find function ' + name);
  let i = SRC.indexOf('{', at), depth = 0, end = -1;
  for (let j = i; j < SRC.length; j++) {
    if (SRC[j] === '{') depth++;
    else if (SRC[j] === '}') { depth--; if (depth === 0) { end = j + 1; break; } }
  }
  return SRC.slice(at + 1, end);
}

// Constants come from the source too — a test that hardcodes 8 and 12 would
// still pass if production quietly changed them.
function constOf(name) {
  const m = new RegExp('const ' + name + '\\s*=\\s*(\\d+)').exec(SRC);
  return m ? Number(m[1]) : null;
}
const LIMIT_MAX = constOf('XRPL_LIMIT_MAX');
const FLOOR_T   = constOf('XRPL_LIMIT_FLOOR_TRANSPORT');
const RECOVER   = constOf('XRPL_RECOVER_AFTER');
const GAP_MIN   = constOf('XRPL_GAP_MIN');
const GAP_MAX   = constOf('XRPL_GAP_MAX');

function build() {
  const body =
    'var _xrplTraffic = { active:0, limit:' + LIMIT_MAX + ', gap:' + GAP_MIN + ', next:0, queue:[], timer:null, successes:0 };' +
    'var _xrplAdmission = { limit_min:' + LIMIT_MAX + ', limit_max:' + LIMIT_MAX + ', gap_max:' + GAP_MIN + ',' +
    '  backoffs_quota:0, backoffs_transport:0, quota_waits:0, quota_wait_ms:0 };' +
    'var XRPL_LIMIT_MAX=' + LIMIT_MAX + ',XRPL_LIMIT_FLOOR_TRANSPORT=' + FLOOR_T +
    ',XRPL_GAP_MIN=' + GAP_MIN + ',XRPL_GAP_MAX=' + GAP_MAX + ',XRPL_RECOVER_AFTER=' + RECOVER + ';' +
    lift('_xrplNoteAdmission') + lift('_xrplBackoff') + lift('_xrplCredit') +
    'return { t:_xrplTraffic, a:_xrplAdmission, backoff:_xrplBackoff, credit:_xrplCredit };';
  return new Function('Math', body)(Math);
}

console.log('XRPL ADMISSION — RECOVERY HAS TO BE REACHABLE INSIDE ONE RUN\n');

console.log('0. the constants under test are the shipped ones');
check('all five constants were read from 02-core',
      [LIMIT_MAX, FLOOR_T, RECOVER, GAP_MIN, GAP_MAX].every(v => typeof v === 'number' && v > 0),
      { LIMIT_MAX, FLOOR_T, RECOVER, GAP_MIN, GAP_MAX });
check('the backoff takes a cause', /_xrplBackoff\(quota \? 'quota' : 'transport'\)/.test(SRC));

// ══ 1. A NAMED COOLDOWN IS STILL OBEYED ══════════════════════════════════════
console.log('\n1. a quota rejection still backs off hard (unchanged on purpose)');
let M = build();
M.backoff('quota');
check('concurrency halves', M.t.limit === Math.floor(LIMIT_MAX / 2), M.t.limit);
check('the gap jumps', M.t.gap >= 100, M.t.gap);
M.backoff('quota'); M.backoff('quota'); M.backoff('quota');
check('repeated refusals can reach a single in-flight read', M.t.limit === 1, M.t.limit);
check('the gap is capped, not unbounded', M.t.gap <= GAP_MAX, M.t.gap);
check('quota backoffs are counted', M.a.backoffs_quota === 4, M.a.backoffs_quota);

// ══ 2. A SILENT SOCKET IS NOT A REFUSAL ══════════════════════════════════════
console.log('\n2. a transport timeout steps down instead of halving');
M = build();
M.backoff('transport');
check('one slot is given up, not half of them', M.t.limit === LIMIT_MAX - 1, M.t.limit);
for (let i = 0; i < 10; i++) M.backoff('transport');
check('a floor of ' + FLOOR_T + ' keeps some parallelism', M.t.limit === FLOOR_T, M.t.limit);
check('transport backoffs are counted separately', M.a.backoffs_transport === 11, M.a.backoffs_transport);
check('the two causes are tallied apart', M.a.backoffs_quota === 0, M.a.backoffs_quota);

// ══ 3. THE RUN THAT WAS MEASURED ═════════════════════════════════════════════
// The exact sequence from D49XL: one rotation plus five recovered reads, all
// timeouts, none of them a quota rejection.
console.log('\n3. the D49XL timeout storm, replayed');
M = build();
for (let i = 0; i < 6; i++) M.backoff('transport');
console.log('     after six timeout backoffs: limit ' + M.t.limit + ' · gap ' + M.t.gap + 'ms');
check('concurrency survives the storm', M.t.limit >= FLOOR_T, M.t.limit);
check('it is not driven to a single read', M.t.limit > 1, M.t.limit);
// The balance pass that followed had 240 wallets left to read.
let reads = 0;
while (M.t.limit < LIMIT_MAX && reads < 240) { M.credit(); reads++; }
check('full concurrency returns inside the same pass', M.t.limit === LIMIT_MAX,
      { limit: M.t.limit, reads });
console.log('     recovered to ' + LIMIT_MAX + ' after ' + reads + ' clean reads (240 remained)');
check('and it took far fewer reads than the old 64-per-slot rule', reads < 240, reads);
check('the gap came back down too', M.t.gap <= GAP_MIN * 4, M.t.gap);

console.log('\n   the old rule, for contrast');
// 64 CONSECUTIVE successes per slot. Climbing 1 -> 8 needed 448 of them, and
// `successes` resets to zero on every backoff, so a single further retry
// restarted the count. 240 wallets remained in the pass when the storm hit, so
// the pass could not undo it however clean the rest of the run was. (An earlier
// framing of mine said the run could never recover at all; 448 is in fact fewer
// than the ~870 reads a whole run makes. The true limit is the pass, and the
// reset — not the run's total.)
const OLD_RULE_READS = 64 * (LIMIT_MAX - 1);
check('the old rule could not recover inside the pass that was damaged',
      OLD_RULE_READS > 240, OLD_RULE_READS + ' consecutive reads needed, 240 wallets left');
check('and the new rule can', reads <= 240, reads);

// ══ 4. CREDIT CANNOT OVERSHOOT ═══════════════════════════════════════════════
console.log('\n4. recovery stops at the ceiling');
M = build();
for (let i = 0; i < 500; i++) M.credit();
check('concurrency never exceeds ' + LIMIT_MAX, M.t.limit === LIMIT_MAX, M.t.limit);
check('the gap never falls below ' + GAP_MIN + 'ms', M.t.gap === GAP_MIN, M.t.gap);

console.log('\n   a slot takes ' + RECOVER + ' clean reads, not one');
M = build();
M.backoff('transport');
const dropped = M.t.limit;
for (let i = 0; i < RECOVER - 1; i++) M.credit();
check('a near-miss does not restore the slot', M.t.limit === dropped, M.t.limit);
M.credit();
check('the ' + RECOVER + 'th read does', M.t.limit === dropped + 1, M.t.limit);

console.log('\n   a backoff resets the progress toward the next slot');
M = build();
M.backoff('transport');
for (let i = 0; i < RECOVER - 1; i++) M.credit();
M.backoff('transport');
for (let i = 0; i < RECOVER - 1; i++) M.credit();
check('partial credit does not survive a backoff', M.t.limit === LIMIT_MAX - 2, M.t.limit);

// ══ 5. THE PRESSURE LEAVES A TRACE ═══════════════════════════════════════════
console.log('\n5. what happened to admission is recorded');
M = build();
for (let i = 0; i < 6; i++) M.backoff('transport');
check('the lowest concurrency reached is kept', M.a.limit_min === M.t.limit, M.a.limit_min);
check('the worst gap is kept', M.a.gap_max >= M.t.gap, M.a.gap_max);
for (let i = 0; i < 200; i++) M.credit();
check('recovery does not erase the low-water mark', M.a.limit_min < LIMIT_MAX, M.a.limit_min);

console.log('\n6. the profile ships with every run (source guard)');
check('per-request latency is timed', /_xrplNoteLatency\(cmd\.command, Date\.now\(\) - _t0\)/.test(SRC));
check('a failed read is not counted as a fast one', /_xrplNoteLatency\(cmd\.command, 0, 'fail'\)/.test(SRC));
check('the profile lands on the pack', /p\.xrpl_read_profile\s*=\s*xrplReadProfile\(\)/.test(SRC));
check('quota waits are read from the counter that enforces the cap',
      /out\.admission\.quota_waits\s*=\s*n\(state\._quotaWaits\)/.test(SRC));

console.log('\n' + (fail === 0 ? 'ALL ' + pass + ' CHECKS PASS' : pass + ' pass, ' + fail + ' FAIL'));
process.exit(fail === 0 ? 0 : 1);
