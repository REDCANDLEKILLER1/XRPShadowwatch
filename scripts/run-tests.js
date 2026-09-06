#!/usr/bin/env node
/* ── THE GATE ────────────────────────────────────────────────────────────────
   Runs every committed regression suite and reports one verdict.

   Why a runner rather than a list of steps in the workflow YAML: the suites are
   browser-driven and each binds a port, so they run in sequence with a distinct
   port each. Keeping that here means `npm test` locally and CI run exactly the
   same thing — a contributor cannot be green locally and red in CI because the
   workflow ran a different set.

   This file is deliberately dumb. It discovers nothing and infers nothing: the
   list below is explicit, so a suite cannot silently stop being run by being
   renamed or moved. A missing file is a FAILURE, not a skip — "0 tests found,
   all passed" is the failure mode this whole exercise exists to prevent.

   Run: node scripts/run-tests.js
        node scripts/run-tests.js --only news        (substring filter)
──── */
'use strict';

const { spawnSync } = require('child_process');
const fs   = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');

// name, file, port. Ports are distinct so a leaked listener from one suite
// cannot make the next one fail for the wrong reason.
const SUITES = [
  ['syntax',                 'check-syntax.js',                  null],
  ['report-truth',           'report-truth-acceptance.test.js',  8201],
  ['news-attribution',       'news-provider-attribution.test.js', 8202],
  ['news-progressive-lane',  'news-progressive-lane.test.js',    8203],
  ['x-summary',              'x-summary-export.test.js',         8204],
  ['large-move-anomaly',     'large-move-anomaly.test.js',       null],
  ['proxy-acceptance',       'proxy-acceptance.test.js',         null],
  ['link-loss',              'report-link-loss.test.js',         8205],
  ['kgmt-fallback',          'kgmt-fallback.test.js',            8206],
  ['developer-language',     'developer-language.test.js',       8207],
  ['prayer-scripture',       'prayer-scripture.test.js',         8208],
  ['source-relevance',       'source-relevance.test.js',         8209],
  ['in-page-smoke',          'in-page-smoke.test.js',            8210],
  ['morning-story-canonical','morning-story-canonical.test.js',  8211],
  ['report-truth-4vf0c',     'report-truth-4vf0c.test.js',       8212],
  ['escrow-not-movement',    'escrow-not-movement.test.js',      8213],
  ['canonical-escrow-model', 'canonical-escrow-model.test.js',   8214],
  // No browser, no port, no database — pure decision logic for the evidence index.
  ['db-foundation',          'db-foundation.test.js',            null],
  // Pure decision logic, no browser and no network.
  ['dex-volume-truth',       'dex-volume-truth.test.js',         null],
  // Integration: the anchor, the row's ledger_index and the capped window,
  // driven through a fake XRPL server rather than a fake decision layer.
  ['ledger-anchor',          'ledger-anchor-prerequisites.test.js', null],
  // In-page, both V1 modes: the spoken Morning Story must carry the coverage
  // it earned, and the wording must survive the sanitizer.
  ['morning-coverage',       'morning-story-coverage-truth.test.js', 8215]
];

const only = (() => {
  const i = process.argv.indexOf('--only');
  return i > -1 ? process.argv[i + 1] : null;
})();

const results = [];
let failed = 0;

for (const [name, file, port] of SUITES) {
  if (only && name.indexOf(only) < 0) continue;

  const full = path.join(ROOT, 'scripts', file);
  if (!fs.existsSync(full)) {
    console.log('  MISSING  ' + name + '  (' + file + ')');
    results.push({ name, status: 'MISSING' });
    failed++;
    continue;
  }

  const env = Object.assign({}, process.env);
  if (port) env.SW_TEST_PORT = String(port);

  const started = Date.now();
  const r = spawnSync(process.execPath, [full], {
    cwd: ROOT, env, encoding: 'utf8', timeout: 5 * 60 * 1000
  });
  const secs = ((Date.now() - started) / 1000).toFixed(0);
  const tail = String(r.stdout || '').trim().split('\n').filter(Boolean).pop() || '(no output)';

  if (r.status === 0) {
    console.log('  PASS  ' + name.padEnd(22) + tail + '  [' + secs + 's]');
    results.push({ name, status: 'PASS' });
  } else {
    failed++;
    console.log('  FAIL  ' + name.padEnd(22) + tail + '  [' + secs + 's]');
    results.push({ name, status: 'FAIL', out: r.stdout, err: r.stderr });
  }
}

if (!results.length) {
  console.error('\nno suites matched — refusing to report success.');
  process.exit(1);
}

// Full output for whatever failed, so CI logs carry the diagnosis rather than
// just the verdict.
results.filter(x => x.status === 'FAIL').forEach(x => {
  console.log('\n' + '─'.repeat(70) + '\n' + x.name + '\n' + '─'.repeat(70));
  console.log(String(x.out || '').trim());
  const err = String(x.err || '').trim();
  if (err) console.log('stderr:\n' + err);
});

console.log('\n' + (failed
  ? failed + ' of ' + results.length + ' SUITES FAILED'
  : 'ALL ' + results.length + ' SUITES PASS'));
process.exit(failed ? 1 : 0);
