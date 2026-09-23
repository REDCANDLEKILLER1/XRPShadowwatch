#!/usr/bin/env node
/* ── A RECORD FROM AUGUST IS NOT A FINDING FROM THIS MORNING ─────────────────
   SW-20260915-D49XL exported:

       scan_id: null
       found_this_scan: 11
       carried_over_from_earlier_scans: 0

   with one of those eleven "current" candidates carrying a first_seen AND a
   last_seen of 24 August. Nothing was fabricated. Real historical records were
   published as this scan's findings because the rule was fail-OPEN:

       function _discoverySeenThisRun(c) {
         const stamp = _discoveryRunStamp();
         if (!stamp) return true;        // cannot tell — do not under-report
         return !!c && c.last_seen === stamp;
       }

   and the stamp it depends on, state.discoveryLastRunISO, lives only in
   memory. Reload the page with a restored inbox and there is no stamp, so
   every candidate ever queued became a finding of the current scan.

   Two things were wrong. A wall clock is not a run identity, and "cannot tell"
   is not "current". Attribution now hangs off the run's own id and is carried
   per candidate by the pass that observed it, so an active run does not make
   the inbox current. Where the question cannot be asked at all the answer is
   NOT EVALUATED — which is a different claim from zero, and both are different
   from eleven.

   Run: node scripts/discovery-run-attribution.test.js
──────────────────────────────────────────────────────────────────────────── */
'use strict';

const fs   = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const CORE = fs.readFileSync(path.join(ROOT, 'src/brief/02-core.js'), 'utf8');
const PIPE = fs.readFileSync(path.join(ROOT, 'src/brief/10-pipeline.js'), 'utf8');

let pass = 0, fail = 0;
const check = (name, ok, detail) => {
  if (ok) { pass++; console.log('  PASS  ' + name); }
  else { fail++; console.log('  FAIL  ' + name + (detail !== undefined ? '  -> ' + JSON.stringify(detail) : '')); }
};

function lift(name) {
  const at = CORE.indexOf('\nfunction ' + name + '(');
  if (at < 0) throw new Error('could not find ' + name);
  let i = CORE.indexOf('{', at), depth = 0, end = -1;
  for (let j = i; j < CORE.length; j++) {
    if (CORE[j] === '{') depth++;
    else if (CORE[j] === '}') { depth--; if (depth === 0) { end = j + 1; break; } }
  }
  return CORE.slice(at + 1, end);
}

// The three arbiters, lifted from the shipped source and driven against a real
// `state` — the same object production reads.
function build(state) {
  const body = lift('_discoveryRunStamp') + lift('_discoveryRunId') +
               lift('_discoverySeenThisRun') + lift('_discoverySplit') +
               'return { runId:_discoveryRunId, seen:_discoverySeenThisRun, split:_discoverySplit };';
  return new Function('state', 'String', 'Array', body)(state, String, Array);
}

// The real shape, including the August record that shipped as current.
const AUGUST = { address: 'rAUG24', score: 140, action_tier: 'CRITICAL_ADD_REVIEW',
                 first_seen: '2026-08-24T11:02:00.000Z', last_seen: '2026-08-24T11:02:00.000Z',
                 last_seen_run: 'SC-AUGUST-RUN' };
const TODAY  = { address: 'rTODAY', score: 160, action_tier: 'CRITICAL_ADD_REVIEW',
                 first_seen: '2026-09-15T14:58:00.000Z', last_seen: '2026-09-15T14:58:00.000Z',
                 last_seen_run: 'SC-RUN-B', qualifying_hashes_this_run: ['A'.repeat(64)] };

console.log('DISCOVERY RUN ATTRIBUTION — NO RUN ID, NO CURRENT FINDING\n');

console.log('0. the arbiters under test are the shipped ones');
let M = null;
try { M = build({}); } catch (e) { console.log('     (lift failed: ' + e.message + ')'); }
check('all three were extracted from 02-core', !!M && typeof M.split === 'function');
check('run identity no longer comes from the clock',
      !/const stamp = _discoveryRunStamp\(\);\s*\n\s*if \(!stamp\) return true;/.test(CORE));

// ══ 1. NO CURRENT RUN ID ═════════════════════════════════════════════════════
// The exact D49XL condition: a restored inbox, no run.
console.log('\n1. no current run id — a historical candidate is not a current finding');
M = build({ discoveryInbox: [AUGUST], discoveryLastRunISO: null });
check('there is no run identity to attribute against', M.runId() === null, M.runId());
check('the August candidate is not seen this scan', M.seen(AUGUST) === false);
let s = M.split([AUGUST]);
check('nothing is reported as fresh', s.fresh.length === 0, s.fresh.length);
check('it is reported as carried over instead', s.carried.length === 1);
check('and the question is marked unanswerable, not answered zero',
      s.evaluated === false && s.known === false, { evaluated: s.evaluated, known: s.known });
check('a wall-clock stamp alone does not make it current',
      build({ discoveryLastRunISO: '2026-08-24T11:02:00.000Z' }).seen(AUGUST) === false);

// ══ 2. A RUN IS ACTIVE, BUT NOT THE ONE THAT SAW IT ══════════════════════════
console.log('\n2. run B is active — a candidate seen only in run A stays historical');
M = build({ indexRun: { scan_id: 'SC-RUN-B' }, discoveryInbox: [AUGUST] });
check('the run identity is read from the active run', M.runId() === 'SC-RUN-B', M.runId());
check('run A’s candidate is not current', M.seen(AUGUST) === false);
s = M.split([AUGUST]);
check('an active run does not make the inbox current', s.fresh.length === 0, s.fresh.length);
check('the question WAS asked this time', s.evaluated === true);
check('and it is attributed to the run that asked', s.run_id === 'SC-RUN-B', s.run_id);

// ══ 3. GENUINE EVIDENCE IN THE CURRENT RUN ═══════════════════════════════════
console.log('\n3. a candidate this run actually observed counts, once');
M = build({ indexRun: { scan_id: 'SC-RUN-B' } });
check('it is seen this scan', M.seen(TODAY) === true);
s = M.split([AUGUST, TODAY]);
check('exactly one is fresh', s.fresh.length === 1, s.fresh.map(c => c.address));
check('and it is the right one', s.fresh[0].address === 'rTODAY');
check('the historical one is still kept, not deleted', s.carried.length === 1 && s.carried[0].address === 'rAUG24');
check('fresh and carried account for every candidate, with no double count',
      s.fresh.length + s.carried.length === 2);

// ══ 4. REPEATED EXPORTS CHANGE NOTHING ═══════════════════════════════════════
console.log('\n4. exporting twice does not change what was found');
M = build({ indexRun: { scan_id: 'SC-RUN-B' } });
const before = JSON.stringify([AUGUST, TODAY]);
const first = M.split([AUGUST, TODAY]);
const second = M.split([AUGUST, TODAY]);
check('the candidate records are untouched', JSON.stringify([AUGUST, TODAY]) === before);
check('the counts are identical', first.fresh.length === second.fresh.length &&
      first.carried.length === second.carried.length);
check('the run attribution is identical', first.run_id === second.run_id);
check('no timestamp moved', AUGUST.last_seen === '2026-08-24T11:02:00.000Z' &&
      TODAY.last_seen === '2026-09-15T14:58:00.000Z');
check('no score moved', AUGUST.score === 140 && TODAY.score === 160);

// ══ 5. THE THREE SURFACES AGREE ══════════════════════════════════════════════
// TXT, JSON and the spoken sentence must read the same split and must all
// withhold rather than one publishing a zero while another publishes eleven.
console.log('\n5. TXT, JSON and the spoken sentence agree (source guard)');
check('JSON reports null, not 0, when the run cannot be attributed',
      /found_this_scan: _sp\.evaluated \? _fresh\.length : null/.test(CORE));
check('JSON names the attribution state explicitly',
      /discovery_attribution: _sp\.evaluated \? 'ATTRIBUTED_TO_RUN' : 'NOT_EVALUATED'/.test(CORE));
check('TXT says NOT EVALUATED rather than a number',
      /_split\.evaluated \? _split\.fresh\.length : 'NOT EVALUATED'/.test(CORE));
check('the per-candidate flag asks about the run, not the clock',
      /_discoverySeenThisRun\(c\)\n?/.test(CORE) &&
      !/_discoverySeenThisRun\(\{ last_seen:/.test(CORE));
check('the spoken sentence no longer falls back to the whole queue',
      !/var pool=\(sp&&sp\.known\)\?sp\.fresh:list;/.test(PIPE) &&
      /var pool=evaluated\?sp\.fresh:\[\];/.test(PIPE));
check('and it says so out loud instead of going quiet',
      /this queue is not attributed to the current scan/.test(PIPE));
check('the tile withholds too', /if \(!split\.evaluated\) return null;/.test(CORE));

// ══ 5b. A CORRECT ZERO IS AN ANSWER ══════════════════════════════════════════
// SW-20260916-WH9AZ published "0 recommended for review" in the Morning Story
// and the JSON, and "2 recommended for review" in the structured report, from
// one run — because the summary guarded its legacy fallback with
// `if (!recommended)`, which cannot tell a canonical zero from no answer.
console.log('\n5b. a canonical zero is not mistaken for no answer');
const summarySrc = (function () {
  const at = CORE.indexOf('function buildDiscoverySummaryLines()');
  return at < 0 ? '' : CORE.slice(at, at + 2600);
})();
check('the summary function was located', summarySrc.length > 0);
check('the counter starts as null, not zero',
      /let recommended = null;/.test(summarySrc),
      (/let recommended = [^\n;]*/.exec(summarySrc) || [])[0]);
check('the legacy fallback fires only when nothing answered',
      /if \(recommended === null\) \{/.test(summarySrc));
check('a falsy zero can no longer trigger it',
      !/if \(!recommended\) \{/.test(summarySrc));
// The tier rule the canonical count uses is the same one the JSON reports, so
// zero REVIEW/MONITOR candidates must read as zero on both.
check('the canonical count uses the same tiers the JSON counts',
      /c\.action_tier === 'CRITICAL_ADD_REVIEW' \|\| c\.action_tier === 'RECOMMEND_FOR_WATCH'/.test(summarySrc));

console.log('\n6. the pass stamps the run that observed the candidate');
check('candidates carry the observing run id', /last_seen_run: \(typeof _discoveryRunId === 'function'\)/.test(CORE));
check('this run’s qualifying evidence is recorded separately from the union',
      /qualifying_hashes_this_run: Array\.from\(new Set\(Array\.from\(c\.qualifying_hashes \|\| \[\]\)\)\)/.test(CORE));
check('and the export carries both for inspection',
      /last_seen_run:      c\.last_seen_run \|\| null/.test(CORE));

console.log('\n' + (fail === 0 ? 'ALL ' + pass + ' CHECKS PASS' : pass + ' pass, ' + fail + ' FAIL'));
process.exit(fail === 0 ? 0 : 1);
