#!/usr/bin/env node
/* ── A PROMOTION IS A CLAIM, AND IT HAS TO BE CHECKABLE LATER ────────────────
   Ten candidates from SW-20260916-SK5R3's discovery queue, reviewed and
   approved by the operator, joining the permanent roster: 408 → 418.

   Promotion is the one moment a wallet stops being "flagged" and starts being
   watched, so the entry has to carry the evidence that earned it. Every figure
   in the comment beside each address was read off the ledger by that scan and
   is repeated in source so a later reader can check the promotion instead of
   trusting it.

   What this suite guards is not the operator's judgement — that is theirs —
   but the things a promotion can silently break:

     · the server parses the SAME array (src/db/roster.js), so a malformed
       entry here is a ROSTER_MISMATCH on the next scan, not a local typo
     · a duplicate address would have a wallet proved twice and counted twice
     · a label collision makes two wallets indistinguishable in every readout
     · auto-promotion stays off — this was a review, and the safety contract
       that says so must still hold

   Run: node scripts/roster-promotion-sk5r3.test.js
──────────────────────────────────────────────────────────────────────────── */
'use strict';

const fs   = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const CORE = fs.readFileSync(path.join(ROOT, 'src/brief/02-core.js'), 'utf8');
const R    = require(path.join(ROOT, 'src/db/roster.js'));

let pass = 0, fail = 0;
const check = (name, ok, detail) => {
  if (ok) { pass++; console.log('  PASS  ' + name); }
  else { fail++; console.log('  FAIL  ' + name + (detail !== undefined ? '  -> ' + JSON.stringify(detail) : '')); }
};

// The ten, with the category each was promoted under.
const PROMOTED = [
  ['rDrtNsGeAoUWa6Hu12yGBPtLRMESRoyS5W', 'discovered_whale',            'WHALE_RECV_rDrtNs'],
  ['rKHfQYcL4hZ5PkdbQ6B2tLP59xrP6Gfn9J', 'discovered_receiver',         'EXOUT_RECV_rKHfQY'],
  ['rPBhF2Dsw168RSDFcdSGpSdm3da6XjCZBG', 'discovered_receiver',         'EXOUT_RECV_rPBhF2'],
  ['rLXUCgmbukkQvFSpftKDTd5Ep6Zr8mG6qt', 'next_hop_splitter',           'SPLITTER_rLXUCg'],
  ['rM8GeqeC8QzsEJcnTMZsag8wwKvJE1tuEf', 'discovered_unknown_highval',  'HIGHVAL_rM8Geq'],
  ['r3n7DWJVDAoPofr6NGAfaov3nquyTVM8gP', 'discovered_receiver',         'LARGE_RECV_r3n7DW'],
  ['rDKsbvy9uaNpPtvVFraJyNGfjvTw8xivgK', 'discovered_receiver',         'LARGE_RECV_rDKsbv'],
  ['rwQjUdbuPaSVYvcA5a3izRCGuGkywyMWjk', 'discovered_receiver',         'LARGE_RECV_rwQjUd'],
  ['rNKXCKKx3y6RkTkart277iMHxfgndrg99z', 'discovered_receiver',         'LARGE_RECV_rNKXCK'],
  ['rGpaXxcBQFCkELhqnHbrascpPDdxSbNqxA', 'discovered_receiver',         'LARGE_RECV_rGpaXx']
];

console.log('ROSTER PROMOTION — SW-20260916-SK5R3, 408 → 418\n');

const roster = R.roster();
const byAddr = new Map(roster.map(w => [w.address, w]));

// ══ 1. THE SERVER SEES EVERY ONE ═════════════════════════════════════════════
// This is the check that matters most. roster.js parses the same WATCHLIST out
// of 02-core.js and throws ROSTER_MISMATCH for any address the browser sends
// that the server's list lacks — so an entry the parser cannot read does not
// fail here, it fails the next morning's scan.
console.log('1. the server-side parser sees all ten');
check('the roster grew by exactly ten', roster.length === 418, roster.length);
PROMOTED.forEach(([addr, cat, label]) => {
  const w = byAddr.get(addr);
  check(label + ' is on the server roster', !!w, addr);
  if (w) check('  ' + label + ' carries its promoted category', w.cat === cat, w.cat);
  if (w) check('  ' + label + ' carries its label', w.label === label, w.label);
});

// ══ 2. NOTHING IS DOUBLE-COUNTED OR INDISTINGUISHABLE ════════════════════════
console.log('\n2. no address or label was collided into an existing one');
check('every address on the roster is unique',
      new Set(roster.map(w => w.address)).size === roster.length,
      roster.length - new Set(roster.map(w => w.address)).size);
const labelCounts = {};
roster.forEach(w => { labelCounts[w.label] = (labelCounts[w.label] || 0) + 1; });
const collided = PROMOTED.map(p => p[2]).filter(l => labelCounts[l] !== 1);
check('none of the ten labels collides with an existing one', collided.length === 0, collided);

// ══ 3. THE ADDRESSES ARE WELL-FORMED ═════════════════════════════════════════
// A malformed address is quarantined by the scanner as INVALID_ADDR and quietly
// costs a roster slot for the life of the file — BITRUE_COLD and INDODAX_COLD
// are already in this file for that reason.
console.log('\n3. every promoted address is a well-formed XRPL address');
const XRPL_ADDR = /^r[1-9A-HJ-NP-Za-km-z]{24,34}$/;
PROMOTED.forEach(([addr, , label]) => {
  check(label + ' matches the XRPL address form', XRPL_ADDR.test(addr), addr);
});
check('and so does every OTHER address on the roster (the promotion broke none)',
      roster.every(w => XRPL_ADDR.test(w.address)),
      roster.filter(w => !XRPL_ADDR.test(w.address)).map(w => w.address).slice(0, 5));

// ══ 4. THE EVIDENCE TRAVELS WITH THE ENTRY ═══════════════════════════════════
// A promotion whose reasoning lives only in a commit message cannot be audited
// from the file. Each entry keeps the figures the scan actually read.
console.log('\n4. each entry carries the evidence that earned it');
const block = CORE.slice(CORE.indexOf('SW-20260916-SK5R3 review'),
                         CORE.indexOf('].map(x => ({ label: x[0]'));
check('the promotion block names the scan that produced it',
      /SW-20260916-SK5R3/.test(block));
check('it says the review was the operator’s, not automatic',
      /operator reviewed and approved|operator took on the same review/.test(block));
check('it records that seven were below ADD tier at promotion',
      /seven were still\s*\n?\s*\/\/ MONITOR\/REVIEW at promotion/.test(block) ||
      /MONITOR\/REVIEW at promotion/.test(block), 'the caveat must be in the file, not only in chat');
check('it records that four had a single scan behind them',
      /seen in only one scan/.test(block));
PROMOTED.forEach(([addr, , label]) => {
  const line = block.split('\n').find(l => l.indexOf(addr) > -1) || '';
  check(label + ' records a score out of 200', /score \d+\/200/.test(line), line.slice(-70));
  check('  ' + label + ' records how many scans saw it', /seen \d+ scans?/.test(line), line.slice(-70));
  check('  ' + label + ' says richlist rank or explicitly that there was no reading',
        /richlist #\d+|no richlist reading|balance not read/.test(line), line.slice(-70));
});

// ══ 5. THIS WAS A REVIEW, AND AUTO-PROMOTION IS STILL OFF ════════════════════
// The roster growing must never be read as the safety contract loosening.
console.log('\n5. promotion by review did not turn auto-promotion on');
check('permanent additions still require review',
      /permanent_additions_require_review: true/.test(CORE));
check('labels are still declared suggestions only',
      /labels_are_suggestions_only: true/.test(CORE));
check('no_auto_add still holds', /no_auto_add: true/.test(CORE));
check('the finder still does not add on its own',
      !/autoAdd:\s*true/.test(CORE), 'SHADOW_BUILDER_RECS.autoAdd must stay false');

console.log('\n' + (fail === 0 ? 'ALL ' + pass + ' CHECKS PASS' : pass + ' pass, ' + fail + ' FAIL'));
process.exit(fail === 0 ? 0 : 1);
