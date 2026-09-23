#!/usr/bin/env node
/* ── A PROMOTION IS A CLAIM, AND IT HAS TO BE CHECKABLE LATER ────────────────
   Ten candidates from SW-20260916-SK5R3's discovery queue, reviewed and
   approved by the operator, joined the permanent roster: 408 → 418.
   Five operator-reviewed ADD candidates from SW-20260923-H21LA later lifted
   the current roster to 423; this suite guards both reviewed promotion sets.

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
const CORE  = fs.readFileSync(path.join(ROOT, 'src/brief/02-core.js'), 'utf8');
const BUILD = fs.readFileSync(path.join(ROOT, 'scripts/build-hvt-roster.js'), 'utf8');
const R     = require(path.join(ROOT, 'src/db/roster.js'));

let pass = 0, fail = 0;
const check = (name, ok, detail) => {
  if (ok) { pass++; console.log('  PASS  ' + name); }
  else { fail++; console.log('  FAIL  ' + name + (detail !== undefined ? '  -> ' + JSON.stringify(detail) : '')); }
};

// The ten, with the category each was promoted under.
const PROMOTED = [
  ['rDrtNsGeAoUWa6Hu12yGBPtLRMESRoyS5W', 'discovered_whale',            'ACTIVATION_HUB_19K'],
  ['rKHfQYcL4hZ5PkdbQ6B2tLP59xrP6Gfn9J', 'discovered_receiver',         'REDP7_CLUSTER_A'],
  ['rPBhF2Dsw168RSDFcdSGpSdm3da6XjCZBG', 'discovered_receiver',         'REDP7_CLUSTER_B'],
  ['rLXUCgmbukkQvFSpftKDTd5Ep6Zr8mG6qt', 'next_hop_splitter',           'FUNDED_STANDALONE_R3QNB'],
  ['rM8GeqeC8QzsEJcnTMZsag8wwKvJE1tuEf', 'discovered_unknown_highval',  'COINCHECK_ORIGIN_2017'],
  ['r3n7DWJVDAoPofr6NGAfaov3nquyTVM8gP', 'discovered_receiver',         'MULTISIG_ACTIVATION_HUB_5K'],
  ['rDKsbvy9uaNpPtvVFraJyNGfjvTw8xivgK', 'discovered_receiver',         'UNION_CHAIN_PROVISIONING'],
  ['rwQjUdbuPaSVYvcA5a3izRCGuGkywyMWjk', 'discovered_receiver',         'REDP7_CLUSTER_C'],
  ['rNKXCKKx3y6RkTkart277iMHxfgndrg99z', 'discovered_receiver',         'WHALE_ACTIVATOR_512'],
  ['rGpaXxcBQFCkELhqnHbrascpPDdxSbNqxA', 'discovered_receiver',         'RLUSD_FLOW_MULTISIG']
];

const H21LA_PROMOTED = [
  ['rGdZW2rphjrEFvr2M2zL16EryUXe9ryHwd', 'next_hop_splitter',  'SPLITTER_rGdZW2'],
  ['rnTJrNZAeLmahACbkFdBDTMPmqmm6fCbTE', 'discovered_receiver', 'EXOUT_RECV_rnTJrN'],
  ['r4MQxQHJMLAGKR4pmM6TgZtsjkjog5iQX8', 'discovered_receiver', 'LARGE_RECV_r4MQxQ'],
  ['r4SZcNFQ1u3xfQp5WG9WUHUSPyRgdsZaZq', 'discovered_whale',    'WHALE_RECV_r4SZcN'],
  ['rKryEVqD7SUZ9SJYRgeESZDQeJ9EkkA1sg', 'discovered_whale',    'WHALE_RECV_rKryEV']
];

console.log('ROSTER PROMOTION — reviewed discovery sets; current roster 423\n');

const roster = R.roster();
const byAddr = new Map(roster.map(w => [w.address, w]));

// ══ 1. THE SERVER SEES EVERY ONE ═════════════════════════════════════════════
// This is the check that matters most. roster.js parses the same WATCHLIST out
// of 02-core.js and throws ROSTER_MISMATCH for any address the browser sends
// that the server's list lacks — so an entry the parser cannot read does not
// fail here, it fails the next morning's scan.
console.log('1. the server-side parser sees both reviewed promotion sets');
check('the reviewed permanent roster now contains exactly 423 wallets', roster.length === 423, roster.length);
PROMOTED.forEach(([addr, cat, label]) => {
  const w = byAddr.get(addr);
  check(label + ' is on the server roster', !!w, addr);
  if (w) check('  ' + label + ' carries its promoted category', w.cat === cat, w.cat);
  if (w) check('  ' + label + ' carries its label', w.label === label, w.label);
});

H21LA_PROMOTED.forEach(([addr, cat, label]) => {
  const w = byAddr.get(addr);
  const sourceLine = BUILD.split('\n').find(l => l.indexOf(addr) > -1) || '';
  check(label + ' is on the server roster', !!w, addr);
  // Shared HVT rows are intentionally normalized by src/db/roster.js to the
  // server's broad "whale" category. The finer discovery subtype remains in
  // REPORT_PROMOTIONS so roster regeneration keeps the reviewed classification.
  if (w) check('  ' + label + ' is normalized to the server HVT category', w.cat === 'whale', w.cat);
  check('  ' + label + ' keeps its reviewed discovery subtype in the generator',
        sourceLine.indexOf("cat: '" + cat + "'") > -1, sourceLine);
  if (w) check('  ' + label + ' carries its behavioral label', w.label === label, w.label);
});

// ══ 2. NOTHING IS DOUBLE-COUNTED OR INDISTINGUISHABLE ════════════════════════
console.log('\n2. no address or label was collided into an existing one');
check('every address on the roster is unique',
      new Set(roster.map(w => w.address)).size === roster.length,
      roster.length - new Set(roster.map(w => w.address)).size);
const labelCounts = {};
roster.forEach(w => { labelCounts[w.label] = (labelCounts[w.label] || 0) + 1; });
const collided = PROMOTED.concat(H21LA_PROMOTED).map(p => p[2]).filter(l => labelCounts[l] !== 1);
check('none of the ten labels collides with an existing one', collided.length === 0, collided);

// ══ 3. THE ADDRESSES ARE WELL-FORMED ═════════════════════════════════════════
// A malformed address is quarantined by the scanner as INVALID_ADDR and quietly
// costs a roster slot for the life of the file — BITRUE_COLD and INDODAX_COLD
// are already in this file for that reason.
console.log('\n3. every promoted address is a well-formed XRPL address');
const XRPL_ADDR = /^r[1-9A-HJ-NP-Za-km-z]{24,34}$/;
PROMOTED.concat(H21LA_PROMOTED).forEach(([addr, , label]) => {
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

// ══ 4b. THE LEDGER ORIGIN TRAVELS TOO ════════════════════════════════════════
// Funding parent and inception are the part nobody self-declares, and they are
// painful to reconstruct later — the funding transaction sits outside every
// reporting window this app uses.
console.log('\n4b. each entry records where the wallet came from');
PROMOTED.forEach(([addr, , label]) => {
  const line = block.split('\n').find(l => l.indexOf(addr) > -1) || '';
  check(label + ' records its funding parent and creation date',
        /funded by \S+ \d{4}-\d{2}-\d{2}/.test(line), line.slice(-80));
  check('  ' + label + ' states whether a published name exists',
        /no published name|XRPScan verified name/.test(line), line.slice(-80));
});

// The one wallet with a third-party name must NOT be labelled with it: a
// registry entry is a claim, and this project does not put claims in labels.
console.log('\n4c. a third-party name is recorded, never used as the label');
const union = byAddr.get('rDKsbvy9uaNpPtvVFraJyNGfjvTw8xivgK');
check('the XRPScan name is recorded in the evidence', /Union Chain/.test(block));
check('it is marked as a registry claim, not ownership proof',
      /NOT ownership proof/.test(block));
check('the label names the FUNCTION, and the entity only where it is confirmed',
      union && union.label === 'UNION_CHAIN_PROVISIONING', union && union.label);

// ══ 4d. THE SHARED FUNDER ════════════════════════════════════════════════════
// Three of the ten lead back to one parent. That account was ALREADY on the
// roster from the operator's manifest, so this records the link rather than
// adding a row — and the suite must prove no second row was created.
console.log('\n4d. the shared funder is recorded, not duplicated');
const FUNDER = 'rEdP7wDoHo6LW9nertpTbxgtF6uFkyS7b5';
check('the funder is on the roster exactly once',
      roster.filter(w => w.address === FUNDER).length === 1,
      roster.filter(w => w.address === FUNDER).length);
check('its entry names the three wallets it funded',
      new RegExp('parent of rKHfQY[\\s\\S]{0,200}rwQjUd[\\s\\S]{0,200}rPBhF2|rKHfQY[\\s\\S]{0,300}rwQjUd[\\s\\S]{0,300}rPBhF2').test(CORE));
check('it records the 110-second creation window', /110 seconds/.test(CORE));
check('it keeps a neutral label rather than naming an operator',
      (byAddr.get(FUNDER) || {}).label === 'WATCHED_rEdP7w',
      (byAddr.get(FUNDER) || {}).label);
check('and says plainly that the shape does not identify an owner',
      /does not say whose/.test(CORE));

// ══ 4e. EVERY LABEL SAYS WHAT IT KNOWS, AND WITHHOLDS WHAT IT DOES NOT ═══════
// The labels name a FUNCTION — activation hub, cluster member, RLUSD flow —
// because function is what the ledger proves. Ownership is stated as unknown
// in the entry rather than implied by a name.
console.log('\n4e. attribution strength is stated, never implied');
const STRENGTH = /OWNER UNKNOWN|OWNERSHIP UNVERIFIED|CONFIRMED ENTITY/;
PROMOTED.forEach(([addr, , label]) => {
  const line = block.split('\n').find(l => l.indexOf(addr) > -1) || '';
  check(label + ' states how strong its attribution is', STRENGTH.test(line), line.slice(0, 110));
});
check('nine of the ten withhold ownership explicitly',
      PROMOTED.filter(([a]) => /OWNER UNKNOWN|OWNERSHIP UNVERIFIED/
        .test(block.split('\n').find(l => l.indexOf(a) > -1) || '')).length === 9,
      PROMOTED.filter(([a]) => /OWNER UNKNOWN|OWNERSHIP UNVERIFIED/
        .test(block.split('\n').find(l => l.indexOf(a) > -1) || '')).length);
check('exactly one claims a confirmed entity',
      (block.match(/CONFIRMED ENTITY/g) || []).length === 1);

// The one label carrying an exchange name rests on a single registry, and the
// other registry disagrees. A label that names a company must say so.
console.log('\n4f. a contested registry label says it is contested');
const coincheck = block.split('\n').find(l => l.indexOf('rM8Geq') > -1) || '';
check('COINCHECK_ORIGIN_2017 records that XRPScan carries no such label',
      /XRPScan carries NO label/.test(coincheck), coincheck.slice(0, 120));
check('and that the claim is the funding origin, not present ownership',
      /never present ownership/.test(coincheck));
check('Union Chain records that HitBTC funding is not HitBTC ownership',
      /does NOT make it a HitBTC wallet/.test(block));

// Activation counts reframe these wallets: a hub that activated ~19,700
// accounts is infrastructure, not a holder. Recorded so nobody reads a
// provisioning wallet as accumulation.
console.log('\n4g. activation counts are recorded where they exist');
[['rDrtNs', '19,700'], ['rDKsbv', '88,100'], ['r3n7DW', '5,000'], ['rNKXCK', '512'], ['rPBhF2', '31']]
  .forEach(([who, count]) => {
    const line = block.split('\n').find(l => l.indexOf(who) > -1) || '';
    check(who + ' records ~' + count + ' activations', line.indexOf(count) > -1, line.slice(-90));
  });
check('the largest hub is marked as a provisioning wallet, not a holder',
      /provisioning hub, not a holder/.test(block));
check('the one wallet that is NOT a hub says so',
      /has NOT acted as an activation hub/.test(block));

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
