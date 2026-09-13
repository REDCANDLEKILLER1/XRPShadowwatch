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
  check('admission comes from an in-process clock', /clock\.admit\(this\.deadline\)/.test(READER));
  check('success and refusal feed that clock, not a table',
    /lane\.clock\.succeeded\(\)/.test(READER) && /lane\.clock\.refused\(retryMs\(e\), e\.message\)/.test(READER));
  check('the clock is injectable, so pacing is testable without real time',
    /options\.clockFor/.test(READER) && /admission\.sharedFor\(e\)/.test(READER));
  // The property the live run proved was missing: a rate limit belongs to a
  // SERVER. One clock for the whole process meant one endpoint's cooldown
  // stalled every request in the run, including those bound for three servers
  // that had said nothing.
  check('the clock is per ENDPOINT, so one server\'s refusal does not stall the rest',
    /sharedFor\(endpoint\)/.test(fs.readFileSync(path.join(ROOT, 'src/db/xrpl-admission.js'), 'utf8')));
  check('and every endpoint carries traffic rather than sitting as failover',
    /ENDPOINTS\.map\(e => new Lane\(/.test(READER));
  // The property that made this necessary: a read-only call must not need a
  // write to happen first.
  check('nothing in the request path requires a write to succeed first',
    READER.split('async request(')[1].split('async ledger(')[0].indexOf('getExecutor') < 0);

  console.log('\n6. what was traded, and why it is the right trade');
  const SRC = fs.readFileSync(path.join(ROOT, 'src/db/xrpl-admission.js'), 'utf8');
  check('the loss of the shared clock is stated, not glossed',
    /shared clock/i.test(SRC) && /traded|trade/i.test(SRC));
  // The floor and the refusal floor are still the database clock's, because
  // those were right. The CEILING and the EASING are not, and a live run
  // proved it: xrplcluster refused once with "units quota (2000 per 10s)
  // exhausted", the gap doubled to the old five-second ceiling, and easing
  // needed thirty-one consecutive successes for a 20% cut. The run made 75
  // requests in 238 seconds and never got back down.
  check('the pacing floor is unchanged from the database clock',
    A.MIN_GAP_MS === 250 && A.REFUSAL_FLOOR_MS === 1000);
  // The property, not the numbers: a clock pushed to its ceiling must return
  // to the floor within a RUN's worth of successes — a few hundred — rather
  // than a few thousand. Whatever the constants are, this has to hold.
  const easeSteps = (max, floor, factor, streak) => {
    let gap = max, successes = 0;
    while (gap > floor && successes < 100000) {
      gap = Math.max(floor, Math.floor(gap * factor)); successes += streak;
    }
    return successes;
  };
  const toFloor = easeSteps(A.MAX_GAP_MS, A.MIN_GAP_MS, A.EASE_FACTOR, A.STREAK_BEFORE_EASING);
  check('a clock at its ceiling recovers to the floor inside one run',
    toFloor <= 300, { successes_needed: toFloor });
  check('and the old settings would NOT have — which is why they changed',
    easeSteps(5000, 250, 0.8, 31) > 300, { old: easeSteps(5000, 250, 0.8, 31) });
  check('the ceiling is still a real brake, several times the floor',
    A.MAX_GAP_MS >= A.MIN_GAP_MS * 4);
  // What the server itself asked for is never softened: the cooldown is the
  // retry-after, verbatim. Only our own secondary brake was retuned.
  check('a refusal still honours the endpoint\'s own retry-after exactly',
    (() => { let t = 1000; const c = A.createClock({ now: () => t, sleep: async () => {} });
      return c.refused(9891, 'units quota') === 9891 && c.cooldownRemaining() === 9891; })());
  check('one clock is shared across Readers in a process, so walks pace together',
    A.shared && typeof A.shared.reserve === 'function');

})();

console.log('\n7. four endpoints, four lanes — the thing that was configured but never used');
/* ── WHAT THE LIVE RUN SHOWED ───────────────────────────────────────────────
   The endpoint list has been four servers long from the start, but connect()
   returned the socket it already had, so every request went down ONE
   WebSocket. A real run's log said `wss://xrplcluster.com` on every single
   line, hit "units quota (2000 per 10s) exhausted", and — because the clock
   was global — served 75 requests in 238 seconds while three idle servers sat
   there willing to answer. These checks are what makes that impossible to
   reintroduce quietly. */
{
  const R = require(path.join(ROOT, 'src/db/xrpl-reader.js'));
  const ENDPOINTS = ['wss://a', 'wss://b', 'wss://c', 'wss://d'];
  const clocks = new Map();
  const clockFor = e => {
    if (!clocks.has(e)) clocks.set(e, A.createClock({ now: () => 0, sleep: async () => {} }));
    return clocks.get(e);
  };
  const reader = new R.Reader({ clockFor });
  check('a reader holds one lane per configured endpoint',
    reader.lanes.length === 4 && new Set(reader.lanes.map(l => l.endpoint)).size === 4,
    reader.lanes.map(l => l.endpoint));
  check('each lane has its OWN clock, not one shared across all of them',
    new Set(reader.lanes.map(l => l.clock)).size === 4);
  // And the real default, not just the injected one: without clockFor, the
  // lanes must still get per-endpoint clocks rather than the process-wide one.
  check('the DEFAULT clock is per endpoint, not the process-wide singleton',
    A.sharedFor('wss://one') !== A.sharedFor('wss://two') &&
    A.sharedFor('wss://one') !== A.shared);
  check('and the same endpoint always gets the same clock, so walks still pace',
    A.sharedFor('wss://one') === A.sharedFor('wss://one'));
  check('a real reader built without injection has four distinct clocks',
    new Set(new R.Reader().lanes.map(l => l.clock)).size === 4);

  // Four wallets asking for a lane must not all be handed the same one.
  reader.openLane = async lane => { lane.sock = { readyState: 1, url: lane.endpoint }; return lane.sock; };
  (async () => {
    // NOTHING is incremented by hand here. An earlier version of this check
    // did `l.inFlight++` after each lane() call and passed against a Reader
    // that handed the SAME lane to every caller — a live measurement showed
    // 100 requests on xrplcluster, 6 on s1 and 0 on s2. The reservation has to
    // be the Reader's job, so the test must not do it.
    const held = [];
    for (let i = 0; i < 4; i++) held.push((await reader.lane()).endpoint);
    check('four concurrent walks land on four different servers',
      new Set(held).size === 4, held);
    check('a lane is marked held the moment it is handed out, not on first request',
      reader.lanes.every(l => l.assigned === 1), reader.lanes.map(l => l.assigned));
    // Eight walks over four lanes should be two apiece, not eight on one.
    const more = [];
    for (let i = 0; i < 4; i++) more.push((await reader.lane()).endpoint);
    check('and a fifth through eighth walk double up evenly rather than piling on',
      reader.lanes.every(l => l.assigned === 2), reader.lanes.map(l => l.assigned));
    check('a released lane becomes available again',
      (() => { const l = reader.lanes[0]; reader.releaseLane(l); reader.releaseLane(l);
        return l.assigned === 0 && reader.pickLane().endpoint === l.endpoint; })());
    check('releasing a lane that is not held cannot drive the count negative',
      (() => { const l = reader.lanes[0]; reader.releaseLane(l); reader.releaseLane(l);
        return l.assigned === 0; })());
    for (const l of reader.lanes) { l.inFlight = 0; l.assigned = 0; }

    // A refusal on one lane must not touch the others.
    const lane = reader.lanes[0];
    lane.clock.refused(9891, 'units quota (2000 per 10s) exhausted');
    check('a refusal cools the lane that refused',
      lane.clock.cooldownRemaining() === 9891);
    check('and leaves every other lane ready immediately',
      reader.lanes.slice(1).every(l => l.clock.cooldownRemaining() === 0));
    const next = reader.pickLane();
    check('so the next request goes to a server that did not refuse',
      next.endpoint !== lane.endpoint, next.endpoint);
    // A cooldown expires; the server that imposed it has not changed its mind.
    // Ordering by cooldown alone made the strictest endpoint eligible again the
    // instant its wait lapsed and it promptly took the next wallet — measured
    // live as 18 refusals on one server while two others took none at all.
    // A fresh reader, so no clock has a cooldown outstanding and the only
    // thing separating the lanes is their refusal history.
    const cooled = new R.Reader({ clockFor: () => A.createClock({ now: () => 0, sleep: async () => {} }) });
    cooled.lanes[0].refusals = 5;
    check('a lane whose cooldown has EXPIRED is still avoided if it keeps refusing',
      cooled.lanes[0].clock.cooldownRemaining() === 0 &&
      cooled.pickLane().endpoint !== cooled.lanes[0].endpoint,
      { chosen: cooled.pickLane().endpoint });
    check('but one bad moment does not exile an otherwise healthy lane',
      (() => { cooled.lanes[1].refusals = 1; cooled.lanes[2].assigned = 3;
        return cooled.lanes[1].cost() < cooled.lanes[0].cost() &&
               cooled.lanes[1].cost() < cooled.lanes[2].cost(); })());

    // Retiring lanes one at a time must not take the pool down with them.
    reader.lanes[1].retired = true; reader.lanes[2].retired = true;
    check('a pool with one lane left still answers',
      reader.pickLane().endpoint === reader.lanes[3].endpoint);
    reader.lanes[3].retired = true; reader.lanes[0].retired = true;
    let threw = null;
    try { reader.pickLane(); } catch (e) { threw = e.message; }
    check('and a pool with none left says so rather than returning nothing',
      threw === 'XRPL_ALL_ENDPOINTS_RETIRED', threw);
  })().then(() => {
    console.log('\n' + (fail ? fail + ' FAILED of ' + (pass + fail) : 'ALL ' + pass + ' XRPL ADMISSION CHECKS PASS'));
    process.exit(fail ? 1 : 0);
  });
}

