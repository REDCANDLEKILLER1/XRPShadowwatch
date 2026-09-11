#!/usr/bin/env node
'use strict';
/* ── THE RATE LIMITER MUST NOT BE ABLE TO TAKE THE READ PATH DOWN ───────────
   Admission used to be a row in Neon: every XRPL request began with an UPDATE
   and ended with another. When the database stopped accepting writes, every
   read-only XRPL call stopped with it — a wallet walk that needed nothing from
   the database could not make a single request, because the limiter in front of
   it needed a write it could not do.

   SW-20260909-CUK9R made 261 requests and sealed in 10m 04s. About 2.3 seconds
   per call, for calls that take tens of milliseconds. The waiting was not
   XRPL's.

   So the clock moved in-process. What this suite holds it to:

     the pacing behaviour is unchanged — same gap, same cooldown, same easing
     concurrent callers queue behind each other instead of stampeding
     a caller that cannot afford the wait is told, not slept past its deadline
     and the reader touches no database at all

   No network, no database, no real time.
──────────────────────────────────────────────────────────────────────────── */
const path = require('path');
const fs = require('fs');
const ROOT = path.join(__dirname, '..');
const A = require(path.join(ROOT, 'src/db/xrpl-admission.js'));

let pass = 0, fail = 0;
const check = (name, ok, detail) => {
  if (ok) { pass++; console.log('  PASS  ' + name); }
  else { fail++; console.log('  FAIL  ' + name + (detail !== undefined ? '  -> ' + JSON.stringify(detail) : '')); }
};

// Virtual time: the suite drives the clock rather than waiting on one.
function fake(options) {
  let t = 1000;
  const clock = A.createClock(Object.assign({ now: () => t, sleep: async ms => { t += ms; } }, options || {}));
  return { clock, now: () => t, advance: ms => { t += ms; } };
}

console.log('\n1. pacing is preserved, not merely present');
const f = fake();
check('the first caller goes immediately', f.clock.reserve() === 0);
check('the second waits one gap', f.clock.reserve() === A.MIN_GAP_MS);
check('and the third waits two', f.clock.reserve() === A.MIN_GAP_MS * 2);
// Reservations are taken when requested, not when served, so a burst of
// concurrent callers spreads out instead of all waking at the same instant.
const burst = fake();
const waits = Array.from({ length: 8 }, () => burst.clock.reserve());
check('a burst of eight is spread across eight slots',
  JSON.stringify(waits) === JSON.stringify([0, 250, 500, 750, 1000, 1250, 1500, 1750]), waits);
check('which is exactly what SCAN_PARALLEL=8 with no pacing did not do',
  waits[7] === A.MIN_GAP_MS * 7);

console.log('\n2. a refusal is honoured, and costs the rate');
const r = fake();
r.clock.reserve();
const wait = r.clock.refused(2000, 'slowDown');
check('the endpoint\'s own retry_after is used when it gives one', wait === 2000);
check('a cooldown is imposed for exactly that long', r.clock.cooldownRemaining() === 2000);
check('and the gap widens so the next attempt is not the same mistake at the same speed',
  r.clock.gap() === A.REFUSAL_FLOOR_MS, r.clock.gap());
const r2 = fake();
check('a refusal with no hint falls back to the floor, not to zero',
  r2.clock.refused(null, 'tooBusy') === A.REFUSAL_FLOOR_MS);
const r3 = fake();
for (let i = 0; i < 6; i++) r3.clock.refused(1, 'slowDown');
check('repeated refusals widen the gap but never past the ceiling',
  r3.clock.gap() === A.MAX_GAP_MS, r3.clock.gap());

console.log('\n3. easing is earned, not granted');
const e = fake();
e.clock.refused(1, 'slowDown');
const widened = e.clock.gap();
for (let i = 0; i < A.STREAK_BEFORE_EASING - 1; i++) e.clock.succeeded();
check('one lucky request does not undo a cooldown the endpoint asked for',
  e.clock.gap() === widened, e.clock.gap());
e.clock.succeeded();
check('a full streak eases it', e.clock.gap() < widened, e.clock.gap());
const floor = fake();
for (let i = 0; i < 500; i++) floor.clock.succeeded();
check('easing never goes below the floor', floor.clock.gap() === A.MIN_GAP_MS, floor.clock.gap());
const reset = fake();
for (let i = 0; i < A.STREAK_BEFORE_EASING - 1; i++) reset.clock.succeeded();
reset.clock.refused(1, 'slowDown');
for (let i = 0; i < A.STREAK_BEFORE_EASING - 1; i++) reset.clock.succeeded();
check('a refusal resets the streak, so easing restarts from scratch',
  reset.clock.gap() === A.REFUSAL_FLOOR_MS, reset.clock.gap());

console.log('\n4. a caller that cannot afford the wait is told');
(async () => {
  const b = fake();
  for (let i = 0; i < 20; i++) b.clock.reserve();
  let refused = null;
  try { await b.clock.admit(b.now() + 100); } catch (err) { refused = err; }
  check('admit() refuses rather than sleeping past the caller\'s deadline',
    refused !== null && /XRPL_ADMISSION_BUDGET_EXCEEDED/.test(refused.message), refused && refused.message);
  check('and the refusal is resumable, not fatal',
    refused.pending === true && refused.retry_after_ms > 0);

  const ok = fake();
  const before = ok.now();
  await ok.clock.admit();
  await ok.clock.admit();
  check('without a deadline it simply waits the gap', ok.now() - before === A.MIN_GAP_MS, ok.now() - before);

  // A cooldown imposed by another caller mid-sleep must be observed, not
  // stepped over by a reservation taken before it existed.
  const race = fake();
  race.clock.reserve();
  const admitting = race.clock.admit();
  race.clock.refused(5000, 'slowDown');
  await admitting;
  check('a cooldown imposed while a caller slept is still honoured',
    race.clock.cooldownRemaining() === 0 && race.clock.stats().waitedMs >= 5000,
    race.clock.stats());

  console.log('\n5. the reader touches no database');
  const READER = fs.readFileSync(path.join(ROOT, 'src/db/xrpl-reader.js'), 'utf8');
  check('it no longer imports the connection module at all',
    !/require\('\.\/connection'\)/.test(READER));
  check('and makes no executor call anywhere', !/getExecutor|db\.transaction/.test(READER));
  check('and issues no SQL', !/\b(UPDATE|INSERT|SELECT|DELETE)\s+\w/i.test(READER.replace(/^\s*\/\/.*$/gm, '')));
  check('admission comes from the in-process clock', /this\.clock\.admit\(this\.deadline\)/.test(READER));
  check('success and refusal feed that clock, not a table',
    /this\.clock\.succeeded\(\)/.test(READER) && /this\.clock\.refused\(retryMs\(e\), e\.message\)/.test(READER));
  check('the clock is injectable, so pacing is testable without real time',
    /options\.clock \|\| admission\.shared/.test(READER));
  // The property that made this necessary: a read-only call must not need a
  // write to happen first.
  check('nothing in the request path requires a write to succeed first',
    READER.split('async request(')[1].split('async ledger(')[0].indexOf('getExecutor') < 0);

  console.log('\n6. what was traded, and why it is the right trade');
  const SRC = fs.readFileSync(path.join(ROOT, 'src/db/xrpl-admission.js'), 'utf8');
  check('the loss of the shared clock is stated, not glossed',
    /shared clock/i.test(SRC) && /traded|trade/i.test(SRC));
  check('the numbers match the ones the database clock used',
    A.MIN_GAP_MS === 250 && A.MAX_GAP_MS === 5000 &&
    A.REFUSAL_FLOOR_MS === 1000 && A.STREAK_BEFORE_EASING === 31);
  check('one clock is shared across Readers in a process, so walks pace together',
    A.shared && typeof A.shared.reserve === 'function');

  console.log('\n' + (fail ? fail + ' FAILED of ' + (pass + fail) : 'ALL ' + pass + ' XRPL ADMISSION CHECKS PASS'));
  process.exit(fail ? 1 : 0);
})();
