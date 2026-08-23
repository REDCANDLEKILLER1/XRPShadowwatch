#!/usr/bin/env node
/* ── HVT SEED VALIDATOR ───────────────────────────────────────────────────────
   Gate for src/shared/hvt-balance-seed.js.

   The seed is the one place where numbers read off the ledger become COMMITTED
   repository data, so it is the one place where a bad number stops being a
   display bug and becomes canon. The file's own header states the rule:

     "Every number in here has to have been read off the ledger by one of the
      apps — seeding it with invented balances would make the drain detector
      fire on numbers nobody ever observed."

   This script is that rule, enforced. It refuses a seed that could not have
   come from a completed run.

   What it CANNOT do: prove a balance is what the ledger actually said. Nothing
   offline can. It proves internal consistency and provenance plausibility —
   every address is a real XRPL address, every address is on the roster we
   claim to watch, no figure is physically impossible, and the high-water mark
   is actually a high-water mark. A number that passes here is not "verified
   true", it is "not detectably invented".

   COMPLETENESS IS MEASURED AGAINST THE REPORT'S ROSTER, NOT THE GENERATED FILE.
   src/shared/hvt-roster.js lists 243 targets; three modules push more on at
   runtime, and the live wall ends at 243 while the report ends at 251. An
   earlier version of this script compared against the generated file, so a seed
   missing all 8 report-only targets scored "243 of 243 - 100%" and passed
   --expect-complete. The canonical count now comes from the measured manifest
   scripts/effective-roster.json, and this script REFUSES to judge completeness
   if that manifest is absent rather than quietly falling back to 243.

   Usage:
     node scripts/validate-hvt-seed.js [path-to-seed.js]
     node scripts/validate-hvt-seed.js <seed> --expect-complete
     node scripts/validate-hvt-seed.js <seed> --expect-complete \
          --report-id SW-20260823-XXXXX --scan-id SC-... --app-version 16.7.1 \
          --evidence out.json      # write the provenance record for the commit

   Exit 0 = seed may be committed. Exit 1 = do not commit.
──────────────────────────────────────────────────────────────────────────── */
'use strict';

const fs   = require('fs');
const path = require('path');
const crypto = require('crypto');

const ROOT       = path.join(__dirname, '..');
const SEED_PATH  = process.argv.find(a => a.endsWith('.js') && !a.endsWith('validate-hvt-seed.js'))
                   || path.join(ROOT, 'src', 'shared', 'hvt-balance-seed.js');
const EXPECT_COMPLETE = process.argv.includes('--expect-complete');
const argOf = k => { const i = process.argv.indexOf(k); return i > -1 ? process.argv[i + 1] : null; };
const REPORT_ID   = argOf('--report-id');
const SCAN_ID     = argOf('--scan-id');
const APP_VERSION = argOf('--app-version');
const EVIDENCE    = argOf('--evidence');
const MANIFEST    = path.join(__dirname, 'effective-roster.json');

// XRPL total supply. Nothing may exceed it; anything near it is a parse error,
// not a wallet. (The 2026-08 richlist carried a row of 5,141,091,648 XRP that
// was a corrupt import, not a holder — this is the same class of defect.)
const TOTAL_XRP_SUPPLY = 100e9;

let pass = 0, fail = 0, warn = 0;
const check = (name, ok, detail) => {
  if (ok) { pass++; console.log('  PASS  ' + name); }
  else { fail++; console.log('  FAIL  ' + name + (detail !== undefined ? '  -> ' + JSON.stringify(detail) : '')); }
};
const note = (name, detail) => { warn++; console.log('  NOTE  ' + name + (detail !== undefined ? '  -> ' + JSON.stringify(detail) : '')); };

/* ── base58check, so a typo'd address cannot enter the repo ───────────────── */
const ALPHABET = 'rpshnaf39wBUDNEGHJKLM4PQRST7VWXYZ2bcdeCg65jkm8oFqi1tuvAxyz';
function base58decode(s) {
  let num = 0n;
  for (const ch of s) {
    const i = ALPHABET.indexOf(ch);
    if (i < 0) return null;                       // excludes 0 O I l by construction
    num = num * 58n + BigInt(i);
  }
  const bytes = [];
  while (num > 0n) { bytes.unshift(Number(num & 0xffn)); num >>= 8n; }
  for (const ch of s) { if (ch === 'r' && bytes[0] !== 0) bytes.unshift(0); else break; }
  return Buffer.from(bytes);
}
function validAddress(a) {
  if (typeof a !== 'string' || a[0] !== 'r' || a.length < 25 || a.length > 35) return false;
  const buf = base58decode(a);
  if (!buf || buf.length !== 25) return false;
  const body = buf.subarray(0, 21), want = buf.subarray(21);
  const h1 = crypto.createHash('sha256').update(body).digest();
  const got = crypto.createHash('sha256').update(h1).digest().subarray(0, 4);
  return got.equals(want);
}

/* ── load the seed and the roster as a browser would ─────────────────────── */
function loadGlobal(file, prop) {
  const src = fs.readFileSync(file, 'utf8');
  const w = {};
  new Function('window', src + '\n;').call({ window: w }, w);
  return w[prop];
}

console.log('HVT SEED VALIDATION');
console.log('  seed:   ' + path.relative(ROOT, SEED_PATH));

let seed, roster;
try { seed = loadGlobal(SEED_PATH, 'SW_HVT_BALANCE_SEED'); }
catch (e) { console.log('  FAIL  seed file does not parse  -> ' + e.message); process.exit(1); }
try { roster = loadGlobal(path.join(ROOT, 'src', 'shared', 'hvt-roster.js'), 'SW_HVT_ROSTER'); }
catch (e) { console.log('  FAIL  roster does not parse  -> ' + e.message); process.exit(1); }

const generatedAddrs = new Set((roster.targets || []).map(t => t.address));

// The canonical roster for completeness is what the REPORT actually watches,
// measured — never the generated file, and never a number typed in here.
let manifest = null;
try { manifest = JSON.parse(fs.readFileSync(MANIFEST, 'utf8')); } catch (_) {}
const canonicalAddrs = manifest && Array.isArray(manifest.reportTargets)
  ? new Set(manifest.reportTargets)
  : null;

console.log('  generated roster: ' + generatedAddrs.size);
if (canonicalAddrs) {
  console.log('  canonical roster: ' + canonicalAddrs.size + ' (report, measured)');
} else {
  console.log('  canonical roster: UNKNOWN — scripts/effective-roster.json missing');
}
console.log('');

/* ── 1. shape ─────────────────────────────────────────────────────────────── */
console.log('1. shape');
check('seed object exists', !!seed);
check('version is 1', seed && seed.version === 1, seed && seed.version);
const balances = (seed && seed.balances) || {};
const addrs = Object.keys(balances);
const empty = addrs.length === 0;

if (empty) {
  console.log('');
  console.log('  NOTE  the seed is EMPTY (balances: {}).');
  console.log('        This is the committed starting state, not a failure: the file');
  console.log('        ships empty ON PURPOSE so no device ever starts from a number');
  console.log('        nobody observed. It stays empty until a completed run is');
  console.log('        exported through SW_HVT_HISTORY.downloadSeed().');
  console.log('');
  console.log(EXPECT_COMPLETE
    ? 'EMPTY SEED — --expect-complete was requested, so this is a failure.'
    : 'EMPTY SEED — valid but carries no baseline. Nothing to validate.');
  process.exit(EXPECT_COMPLETE ? 1 : 0);
}

check('exported date is present and well-formed',
  /^\d{4}-\d{2}-\d{2}$/.test(seed.exported || ''), seed.exported);

/* ── 2. provenance: could this have come from a real run? ─────────────────── */
console.log('\n2. provenance');
const badAddr = addrs.filter(a => !validAddress(a));
check('every address is a valid XRPL address (base58check)', badAddr.length === 0, badAddr.slice(0, 5));

const knownAddrs = canonicalAddrs || generatedAddrs;
const strangers = addrs.filter(a => !knownAddrs.has(a));
// Runtime promotions are injected after the generated roster, so a seed taken
// from a live app legitimately carries a few addresses the generated file does
// not list yet. That is expected drift, not contamination — but it must be
// small and it must be named, never silently absorbed.
if (strangers.length === 0) {
  check('every address is on the canonical roster', true);
} else if (strangers.length <= 16) {
  note('addresses not in the GENERATED roster (runtime promotions?)', strangers);
  check('all non-roster addresses are still valid XRPL addresses',
    strangers.every(validAddress), strangers.filter(a => !validAddress(a)));
} else {
  check('addresses outside the roster are few enough to be promotions',
    false, { count: strangers.length, sample: strangers.slice(0, 5) });
}

/* ── 3. the numbers ───────────────────────────────────────────────────────── */
console.log('\n3. figures');
const rec = a => balances[a];
const nonFinite = addrs.filter(a => {
  const r = rec(a);
  return !r || ![r.peak, r.last, r.n].every(v => Number.isFinite(Number(v)));
});
check('every record has finite peak, last and n', nonFinite.length === 0, nonFinite.slice(0, 5));

const nonPositive = addrs.filter(a => !(Number(rec(a).peak) > 0));
check('every peak is positive (a peak of 0 is not an observation)',
  nonPositive.length === 0, nonPositive.slice(0, 5));

const negLast = addrs.filter(a => Number(rec(a).last) < 0);
check('no negative balances', negLast.length === 0, negLast.slice(0, 5));

const overSupply = addrs.filter(a => Number(rec(a).peak) > TOTAL_XRP_SUPPLY);
check('no figure exceeds total XRP supply', overSupply.length === 0,
  overSupply.slice(0, 5).map(a => ({ a, peak: rec(a).peak })));

// peak is a HIGH-WATER MARK and is never lowered. last > peak means the export
// came from a store that lost that invariant.
const peakViolations = addrs.filter(a => Number(rec(a).last) > Number(rec(a).peak));
check('peak is never below last (high-water invariant holds)',
  peakViolations.length === 0,
  peakViolations.slice(0, 5).map(a => ({ a, peak: rec(a).peak, last: rec(a).last })));

const badN = addrs.filter(a => !(Number(rec(a).n) >= 1));
check('every record was observed at least once (n >= 1)', badN.length === 0, badN.slice(0, 5));

const badStamps = addrs.filter(a => {
  const r = rec(a);
  return (r.peakAt && isNaN(Date.parse(r.peakAt))) || (r.lastAt && isNaN(Date.parse(r.lastAt)));
});
check('timestamps parse where present', badStamps.length === 0, badStamps.slice(0, 5));

/* ── 4. completeness against the roster ───────────────────────────────────── */
console.log('\n4. coverage');
if (!canonicalAddrs) {
  // Refuse to judge completeness off the generated file. That is the exact
  // mistake this section used to make.
  check('canonical roster manifest is present', false,
    'run: node scripts/build-effective-roster.js');
  console.log('  Cannot judge completeness without it. Generated-file coverage is');
  console.log('  reported below for information only and is NOT an acceptance signal.');
  const g = [...generatedAddrs].filter(a => balances[a]).length;
  console.log('  (informational) ' + g + ' of ' + generatedAddrs.size + ' generated targets');
} else {
  const covered = [...canonicalAddrs].filter(a => balances[a]);
  const missing = [...canonicalAddrs].filter(a => !balances[a]);
  const pct = canonicalAddrs.size ? Math.round(covered.length / canonicalAddrs.size * 100) : 0;
  console.log('  ' + covered.length + ' of ' + canonicalAddrs.size +
              ' canonical (report) targets carry a baseline (' + pct + '%)');

  // Name the report-only targets explicitly when they are what is missing —
  // that is the failure mode the old check could not see.
  const reportOnly = new Set((manifest.reportOnly || []).map(r => r.address));
  const missingReportOnly = missing.filter(a => reportOnly.has(a));
  if (missingReportOnly.length) {
    console.log('  ' + missingReportOnly.length + ' of the missing are REPORT-ONLY targets — a seed');
    console.log('  exported after a wall-only scan will always be short by exactly these:');
    missingReportOnly.forEach(a => console.log('    ' + a));
  }
  if (missing.length) {
    console.log('  ' + missing.length + ' without a baseline — these start blind on a fresh device.');
    missing.slice(0, 8).forEach(a => console.log('    ' + a));
    if (missing.length > 8) console.log('    …');
  }
  if (EXPECT_COMPLETE) {
    check('every canonical target has a baseline (--expect-complete)', missing.length === 0,
      { missing: missing.length, of: canonicalAddrs.size });
  } else if (missing.length) {
    note('seed is partial — NOT acceptable as the canonical cold seed', { missing: missing.length });
  }
}

/* ── summary ──────────────────────────────────────────────────────────────── */
// ── 5. provenance ────────────────────────────────────────────────────────
// A committed seed becomes canonical forensic data. Six months from now it must
// be possible to say exactly which sealed run produced it.
console.log('\n5. provenance');
if (EXPECT_COMPLETE) {
  check('source Report ID supplied (--report-id)', !!REPORT_ID, REPORT_ID);
  check('source Scan ID supplied (--scan-id)', !!SCAN_ID, SCAN_ID);
  check('app version supplied (--app-version)', !!APP_VERSION, APP_VERSION);
} else {
  if (REPORT_ID)   console.log('  report id:  ' + REPORT_ID);
  if (SCAN_ID)     console.log('  scan id:    ' + SCAN_ID);
  if (APP_VERSION) console.log('  app:        ' + APP_VERSION);
  if (!REPORT_ID && !SCAN_ID && !APP_VERSION)
    note('no provenance supplied — required with --expect-complete');
}

const totalPeak = addrs.reduce((s, a) => s + Number(rec(a).peak || 0), 0);
console.log('\nsummary');
console.log('  addresses:   ' + addrs.length);
console.log('  exported:    ' + seed.exported);
console.log('  total peak:  ' + Math.round(totalPeak).toLocaleString() + ' XRP');
console.log('  file size:   ' + (fs.statSync(SEED_PATH).size / 1024).toFixed(1) + ' KB');

if (EVIDENCE) {
  const evidence = {
    seed_file: path.relative(ROOT, SEED_PATH),
    seed_sha256: crypto.createHash('sha256').update(fs.readFileSync(SEED_PATH)).digest('hex'),
    validated_at: new Date().toISOString(),
    validator: 'scripts/validate-hvt-seed.js',
    expect_complete: EXPECT_COMPLETE,
    source: { report_id: REPORT_ID, scan_id: SCAN_ID, app_version: APP_VERSION,
              exported: seed.exported },
    roster: { generated: generatedAddrs.size,
              canonical: canonicalAddrs ? canonicalAddrs.size : null,
              roster_version: manifest ? manifest.rosterVersion : null },
    coverage: canonicalAddrs
      ? { covered: [...canonicalAddrs].filter(a => balances[a]).length, of: canonicalAddrs.size }
      : null,
    seed_records: addrs.length,
    total_peak_xrp: Math.round(totalPeak),
    result: fail ? 'FAIL' : 'PASS',
    checks: { pass: pass, fail: fail, notes: warn }
  };
  fs.writeFileSync(EVIDENCE, JSON.stringify(evidence, null, 2) + '\n');
  console.log('  evidence:    ' + EVIDENCE);
}

console.log('');
if (fail) { console.log(fail + ' CHECK' + (fail > 1 ? 'S' : '') + ' FAILED — do not commit this seed.'); process.exit(1); }
console.log('ALL ' + pass + ' CHECKS PASS' + (warn ? ' (' + warn + ' note' + (warn > 1 ? 's' : '') + ')' : '') + ' — seed may be committed.');
process.exit(0);
