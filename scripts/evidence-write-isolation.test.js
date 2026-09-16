#!/usr/bin/env node
/* ── THE EVIDENCE STORE IS ONE STORE, AND A PREVIEW SHARES IT ────────────────
   localStorage is per-origin, so a branch preview FEELS sandboxed. The evidence
   store is not. evidenceTarget() pins one repository and one branch for every
   deployment, and the preview carries the same token, so a preview run writes
   the checkpoint production reads.

   On 2026-09-16 that happened. A preview of the 418-wallet roster (PR #78) ran
   and wrote runs into the shared checkpoint. Production — whose roster is 408 —
   then read a state carrying 418 wallets and planned against it:

       Evidence: state · 418 wallets
       Evidence: anchor 107024587 · 91/418 proved · RUN_INCOMPLETE
       SCAN: 408 wallets
       tx_scan_coverage {"target_wallets":408,"complete_wallets":90, ...}

   One morning, one run, two denominators. Nothing in the code said the store
   was shared, and nothing refused the write.

   READS STAY OPEN. A preview that cannot read the checkpoint cannot produce a
   report at all, and reading is what makes a preview worth running. Only the
   four writers are gated, by name.

   VERCEL_ENV is 'production' | 'preview' | 'development' on Vercel and absent
   everywhere else. Absent means this is not a Vercel deployment — a local
   operator script or this suite — and those keep their write access, because
   scripts/db-export-evidence.js and scripts/github-publish-export.js are how
   the store is seeded in the first place.

   Run: node scripts/evidence-write-isolation.test.js
──────────────────────────────────────────────────────────────────────────── */
'use strict';

const fs   = require('fs');
const path = require('path');

const ROOT  = path.join(__dirname, '..');
const A     = require(path.join(ROOT, 'src/db/github-archive.js'));
const Store = require(path.join(ROOT, 'src/db/github-store.js'));
const STORE_SRC = fs.readFileSync(path.join(ROOT, 'src/db/github-store.js'), 'utf8');

let pass = 0, fail = 0;
const check = (name, ok, detail) => {
  if (ok) { pass++; console.log('  PASS  ' + name); }
  else { fail++; console.log('  FAIL  ' + name + (detail !== undefined ? '  -> ' + JSON.stringify(detail) : '')); }
};

const TOKEN = { SHADOWWATCH_EVIDENCE_TOKEN: 'x-not-a-real-token' };
const envFor = v => (v === undefined ? { ...TOKEN } : { ...TOKEN, VERCEL_ENV: v });

console.log('EVIDENCE WRITE ISOLATION — A PREVIEW MAY READ, NEVER WRITE\n');

// ══ 0. THE STORE REALLY IS SHARED ════════════════════════════════════════════
// If the target ever became per-environment, this suite would be guarding a
// problem that no longer exists. Pin the fact it is guarding.
console.log('0. every environment still resolves to the same store');
const prodT = A.evidenceTarget(envFor('production'));
const prevT = A.evidenceTarget(envFor('preview'));
check('production and preview resolve to the same repository',
      prodT.repo === prevT.repo, { production: prodT.repo, preview: prevT.repo });
check('and the same branch', prodT.branch === prevT.branch,
      { production: prodT.branch, preview: prevT.branch });
check('a write guard exists to be tested', typeof A.evidenceWriteTarget === 'function');

// ══ 1. WRITES ════════════════════════════════════════════════════════════════
console.log('\n1. only production may write');
const refusalFor = v => {
  try { A.evidenceWriteTarget(envFor(v)); return null; } catch (e) { return e; }
};
check('production is allowed', refusalFor('production') === null);
check('a preview is refused', !!refusalFor('preview'));
check('a development deployment is refused', !!refusalFor('development'));
check('an unknown Vercel environment is refused', !!refusalFor('staging'));

const prev = refusalFor('preview');
check('the refusal is named, not generic',
      /EVIDENCE_WRITE_REFUSED_NON_PRODUCTION/.test(String(prev && prev.message)), prev && prev.message);
check('it says which environment was refused', prev && prev.environment === 'preview', prev && prev.environment);
check('it says why — the checkpoint is shared with production',
      /shared with production/.test(String(prev && prev.message)), prev && prev.message);
check('it carries a flag a caller can branch on', prev && prev.evidenceWriteRefused === true);

// ══ 2. READS ARE NOT GATED ═══════════════════════════════════════════════════
// A preview that cannot read cannot produce a report, and a preview that cannot
// produce a report is not worth deploying.
console.log('\n2. a preview can still read');
let readOk = true, readErr = null;
try { A.evidenceTarget(envFor('preview')); } catch (e) { readOk = false; readErr = e; }
check('evidenceTarget still answers for a preview', readOk, readErr && readErr.message);
check('and returns a usable token', !!prevT.token);

// ══ 3. LOCAL AND CI KEEP THEIR WRITE ACCESS ══════════════════════════════════
// Absent VERCEL_ENV is not a Vercel deployment. db-export-evidence.js and
// github-publish-export.js seed the store from an operator's machine, and this
// suite runs with no VERCEL_ENV at all.
console.log('\n3. absent VERCEL_ENV is not a refusal');
check('no VERCEL_ENV writes fine', refusalFor(undefined) === null, String(refusalFor(undefined)));
check('an empty VERCEL_ENV writes fine', (() => {
  try { A.evidenceWriteTarget({ ...TOKEN, VERCEL_ENV: '' }); return true; } catch (_) { return false; }
})());
check('a missing token still fails first, on its own error', (() => {
  try { A.evidenceWriteTarget({ VERCEL_ENV: 'production' }); return false; }
  catch (e) { return /EVIDENCE_STORE_NOT_CONFIGURED/.test(e.message); }
})());

// ══ 4. THE FOUR WRITERS REFUSE BEFORE TOUCHING GITHUB ════════════════════════
// The guard is worth nothing if the request goes out first. Each writer is
// driven with a preview env and a gh client that records every call; the
// refusal must arrive with the recorder still empty.
console.log('\n4. each writer refuses before any request is made');
const calls = [];
const spy = new Proxy({}, { get: () => (...a) => { calls.push(a); return Promise.resolve({}); } });

const writers = [
  ['appendJournal', () => Store.appendJournal({ segments: [] }, { rows: [] }, { env: envFor('preview'), gh: spy })],
  ['clearJournal',  () => Store.clearJournal({ segments: [] }, { env: envFor('preview'), gh: spy })],
  ['commitRun',     () => Store.commitRun({ report_id: 'SW-20260916-AID58', files: {} }, { env: envFor('preview'), gh: spy })],
  ['seedGenesis',   () => Store.seedGenesis({ files: {} }, { env: envFor('preview'), gh: spy })]
];

(async () => {
  for (const [name, run] of writers) {
    calls.length = 0;
    let err = null;
    try { await run(); } catch (e) { err = e; }
    check(name + ' refuses on a preview',
          !!err && /EVIDENCE_WRITE_REFUSED_NON_PRODUCTION/.test(err.message),
          err && err.message);
    check('  ' + name + ' made no GitHub call', calls.length === 0, calls.length);
  }

  // And the readers must NOT be gated — same env, same spy.
  console.log('\n   the readers are untouched by the guard');
  for (const [name, run] of [
    ['readState',  () => Store.readState({ env: envFor('preview'), gh: spy })],
    ['readJournal',() => Store.readJournal({ env: envFor('preview'), gh: spy })]
  ]) {
    let err = null;
    try { await run(); } catch (e) { err = e; }
    check(name + ' is not refused for being a preview',
          !err || !/EVIDENCE_WRITE_REFUSED/.test(err.message), err && err.message);
  }

  // ══ 5. SOURCE GUARD — the split is by function, not by accident ════════════
  console.log('\n5. the store routes writers and readers apart (source guard)');
  const fnAt = line => {
    const lines = STORE_SRC.split('\n');
    for (let i = line - 1; i >= 0; i--) if (/^(async )?function /.test(lines[i])) return lines[i];
    return '';
  };
  const writeFns = ['appendJournal', 'clearJournal', 'commitRun', 'seedGenesis'];
  const readFns  = ['readState', 'readJournal', 'readJournalRows', 'missingJournalShards', 'readDays'];
  const body = name => {
    const at = STORE_SRC.indexOf('function ' + name + '(');
    return at < 0 ? '' : STORE_SRC.slice(at, at + 400);
  };
  writeFns.forEach(n => check(n + ' resolves through the write guard', /writeTarget\(/.test(body(n)), body(n).slice(0, 120)));
  readFns.forEach(n => check(n + ' still uses the plain read target',
        /(^|[^e])target\(d\.env\)/.test(body(n)) && !/writeTarget\(/.test(body(n)), body(n).slice(0, 120)));
  check('no writer was left on the read path',
        writeFns.every(n => /writeTarget\(/.test(body(n))));

  // ══ 6. THE DISCREPANCY IS SAID WHERE SOMEONE IS LOOKING ═══════════════════
  // The state deliberately keeps proving a wallet the roster no longer lists,
  // so 91/418 beside 90/408 is correct behaviour, not a bug. But on 2026-09-16
  // the operator had no way to know that: the server reported it as
  // watched_not_in_roster, which reached the debug JSON and nowhere else.
  console.log('\n6. a roster/checkpoint gap is explained in the run log (source guard)');
  const L45 = fs.readFileSync(path.join(ROOT, 'src/brief/45-delta-evidence-index-20260911.js'), 'utf8');
  const ACQ = fs.readFileSync(path.join(ROOT, 'src/db/delta-acquisition.js'), 'utf8');
  check('the server still reports the gap', /watched_not_in_roster: rosterAbsent/.test(ACQ));
  check('the browser now reads it', /result\.watched_not_in_roster/.test(L45));
  check('and logs it only when there IS a gap', /if \(absent\.length\) \{/.test(L45));
  check('the line says the wallets are still walked and counted',
        /still walked and counted/.test(L45));
  check('it names the first few rather than dumping all of them',
        /absent\.slice\(0, 3\)/.test(L45) && /and ' \+ \(absent\.length - 3\) \+ ' more/.test(L45));
  check('the state still refuses to drop a wallet the roster omits',
        /is NOT dropped/.test(ACQ) && /does not infer a decision from a list it was handed/.test(ACQ),
        'that behaviour is deliberate and must stay');

  console.log('\n' + (fail === 0 ? 'ALL ' + pass + ' CHECKS PASS' : pass + ' pass, ' + fail + ' FAIL'));
  process.exit(fail === 0 ? 0 : 1);
})().catch(e => { console.error('HARNESS ERROR: ' + (e && e.stack || e)); process.exit(1); });
