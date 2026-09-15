#!/usr/bin/env node
/* ── A BACKGROUNDED PAGE HAS NO WORKING CLOCK ────────────────────────────────
   SW-20260915-D49XL lost 20m23s inside the offer sweep:

       18:49:43   Offers: 120 / 408
       (nothing at all)
       19:10:06   socket found dead, reconnect
       19:10:46   "Screen returned with the XRPL link down — reconnecting…"
                  sweep resumes at 128 / 408

   Two things had to be true together, and both were.

   1. The only deadline on a read was setTimeout(..., 15000). Chrome on Android
      throttles background timers to about once a minute and can freeze them
      after a few minutes hidden, so while the page is hidden a read has no
      deadline at all.

   2. The visibility handler written for this case opened with
      `if (_sockOpen(state._sock)) return;`. A backgrounded mobile socket goes
      HALF-OPEN — readyState still OPEN, nothing will ever arrive — so it saw a
      healthy socket and returned. The same run shows the other case at
      18:38:25: socket detectably closed, handler fired, seconds lost instead
      of minutes.

   The fix does not add a better timer, because no timer runs. In-flight reads
   are tracked by wall clock and swept on the way back to the foreground, which
   is the one moment a real clock exists again.

   Run: node scripts/xrpl-background-stall.test.js
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

console.log('XRPL BACKGROUND STALL — NOTHING MAY WAIT ON A FROZEN CLOCK\n');

// ══ 0. THE FUNCTION UNDER TEST IS THE SHIPPED ONE ════════════════════════════
console.log('0. the sweep under test is the shipped one');
let sweepSrc = '';
try { sweepSrc = lift('_xrplSweepStalled'); } catch (_) {}
check('_xrplSweepStalled was extracted from 02-core', /_xrplInFlight/.test(sweepSrc), sweepSrc.slice(0, 50));

let NOW = 1000000;
const mk = () => {
  const set = new Set();
  const fn = new Function('_xrplInFlight', 'Date', 'Error',
    sweepSrc + 'return _xrplSweepStalled;')(set, { now: () => NOW }, Error);
  return { set, sweep: fn };
};
const req = (cmd, t0) => {
  const r = { t0, command: cmd, failed: null };
  r.fail = e => { r.failed = e; };
  return r;
};

// ══ 1. THE READ THAT WAS LOST ════════════════════════════════════════════════
console.log('\n1. the offer sweep read that waited 20m23s');
let M = mk();
NOW = 1000000;
const stuck = req('account_offers', NOW);           // issued at 18:49:43
M.set.add(stuck);
NOW += 20 * 60000 + 23000;                          // the screen comes back at 19:10:06
const n1 = M.sweep('stalled while the screen was off', 15000);
check('the stalled read is found', n1 === 1, n1);
check('it is failed, not left hanging', !!stuck.failed, stuck.failed && stuck.failed.message);
check('the failure names the command', /account_offers/.test(String(stuck.failed && stuck.failed.message)));
check('the failure names the cause', /screen was off/.test(String(stuck.failed && stuck.failed.message)),
      stuck.failed && stuck.failed.message);
check('it is coded so the retry path can see it',
      stuck.failed && stuck.failed.code === 'XRPL_STALLED', stuck.failed && stuck.failed.code);
check('it reads as a timeout, which is what the caller already retries on',
      /^timeout /.test(String(stuck.failed && stuck.failed.message)));

// ══ 2. A HEALTHY READ IS NOT KILLED ══════════════════════════════════════════
// The sweep runs on every return to the foreground, including the ones where
// nothing is wrong. A read issued a moment before the screen came back must
// survive, or a quick glance at another app would cost a retry every time.
console.log('\n2. a read that is merely young is left alone');
M = mk(); NOW = 2000000;
const fresh = req('account_info', NOW);
M.set.add(fresh);
NOW += 3000;                                        // three seconds is not a stall
check('nothing is swept', M.sweep('screen returned', 15000) === 0);
check('the young read is untouched', fresh.failed === null);

console.log('\n   the boundary is the RPC deadline itself');
M = mk(); NOW = 3000000;
const onEdge = req('account_info', NOW);
M.set.add(onEdge);
NOW += 14999;
check('one millisecond under the deadline survives', M.sweep('r', 15000) === 0, onEdge.failed);
NOW += 1;
check('the deadline exactly is swept', M.sweep('r', 15000) === 1);

// ══ 3. A WHOLE PASS CAUGHT MID-FLIGHT ════════════════════════════════════════
console.log('\n3. a chunk of eight, caught mid-flight');
M = mk(); NOW = 4000000;
const chunk = [];
for (let i = 0; i < 8; i++) { const r = req('account_offers', NOW); chunk.push(r); M.set.add(r); }
// Issued a minute before the screen came back: still 60s past the 15s
// deadline, so it is stalled too. Age is the rule, not when the gap began.
const late = req('account_offers', NOW + 19 * 60000);
M.set.add(late);
// And one issued a heartbeat before the return, which must survive.
const justInTime = req('account_offers', NOW + 20 * 60000 - 2000);
M.set.add(justInTime);
NOW += 20 * 60000;
const n3 = M.sweep('screen returned', 15000);
check('every read past the deadline is failed, the chunk and the late one', n3 === 9, n3);
check('all eight of the chunk carry a failure', chunk.every(r => r.failed), chunk.filter(r => !r.failed).length);
check('the read issued 60s before the return is stalled too', !!late.failed);
check('the read issued 2s before the return survives', justInTime.failed === null);
check('an empty flight sweeps cleanly', mk().sweep('r', 15000) === 0);

// ══ 4. THE HANDLER NO LONGER TRUSTS A SOCKET THAT LOOKS OPEN ═════════════════
// This is the line that cost the twenty minutes. Source guards, named as such.
console.log('\n4. the visibility handler (source guard)');
const handler = SRC.slice(SRC.indexOf('A HALF-OPEN SOCKET IS THE CASE'),
                          SRC.indexOf('A HALF-OPEN SOCKET IS THE CASE') + 2600);
check('the early return no longer fires on a bare open socket',
      !/if \(_sockOpen\(state\._sock\)\) return;\s*\n\s*log\('Screen returned/.test(SRC));
check('the sweep runs before any socket check',
      handler.indexOf('_xrplSweepStalled') < handler.indexOf('_sockOpen'),
      { sweep: handler.indexOf('_xrplSweepStalled'), sock: handler.indexOf('_sockOpen') });
check('a stall forces a reconnect even when the socket reports open',
      /_sockOpen\(state\._sock\) && !stalled/.test(handler));
check('hidden time is stamped when the page goes away',
      /if \(document\.hidden\) \{[\s\S]{0,140}state\._hiddenAt = Date\.now\(\)/.test(handler));
check('the RPC deadline is read from the same place the request uses',
      /SW_XRPL_RPC_TIMEOUT_MS/.test(handler));

// ══ 5. THE HOLE IS NEVER ANONYMOUS AGAIN ═════════════════════════════════════
console.log('\n5. backgrounding is recorded (source guard)');
['hidden_ms', 'hidden_spans', 'hidden_longest_ms', 'stalls_on_return'].forEach(k =>
  check('admission records ' + k, new RegExp(k + ':\\s*0').test(SRC) && SRC.indexOf('_a.' + k) > -1 || SRC.indexOf(k) > -1));
check('the run says how long the screen was off', /Screen was off for /.test(SRC));
check('in-flight reads are tracked, not just timed',
      /_xrplInFlight\.add\(track\)/.test(SRC) && /_xrplInFlight\.delete\(track\)/.test(SRC));
check('a settled read leaves the flight set', /_xrplInFlight\.delete\(track\);/.test(SRC));

console.log('\n' + (fail === 0 ? 'ALL ' + pass + ' CHECKS PASS' : pass + ' pass, ' + fail + ' FAIL'));
process.exit(fail === 0 ? 0 : 1);
