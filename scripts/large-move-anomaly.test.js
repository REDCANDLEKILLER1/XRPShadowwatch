#!/usr/bin/env node
/* ── THE STANDOUT ANOMALY MUST NOT BE AN EXCHANGE MOVING ITS OWN MONEY ────────
   summarizeLargeMoves picked the standout transfer purely by size, so on
   2026-08-31 (SW-20260831-4VF0C) the report opened with:

       "The standout individual anomaly was 25.29M XRP moved from Kraken to
        Kraken."

   Both ends were sourced Kraken wallets — routine exchange treasury movement,
   and the least anomalous thing on the board. Meanwhile an unnamed whale
   sending 22.77M XRP to Coinbase sat below it, unmentioned as the lead.

   Read aloud, "from Kraken to Kraken" also just sounds like a mistake.

   Three properties, and the third is the one that matters most:
     1. a cross-entity transfer is promoted over a larger same-entity one
     2. when a same-entity move IS the only thing on the board, the wording
        says "between two X wallets" rather than "from X to X"
     3. the demoted internal transfer is still REPORTED, and its provenance
        still carried — demoting must never become hiding

   Run: node scripts/large-move-anomaly.test.js
──────────────────────────────────────────────────────────────────────────── */
'use strict';

const fs   = require('fs');
const path = require('path');
const vm   = require('vm');

let pass = 0, fail = 0;
const check = (name, ok, detail) => {
  if (ok) { pass++; console.log('  PASS  ' + name); }
  else { fail++; console.log('  FAIL  ' + name + (detail !== undefined ? '  -> ' + JSON.stringify(detail) : '')); }
};

// Load 10-pipeline.js in a sandbox with the identity registry the real run had.
function load(identities) {
  const src = fs.readFileSync(path.join(__dirname, '..', 'src/brief/10-pipeline.js'), 'utf8');
  const win = { SW_WALLET_IDENTITIES: identities || {} };
  const ctx = {
    window: win, document: { getElementById: () => null, addEventListener() {} },
    localStorage: { getItem: () => null, setItem() {}, removeItem() {} },
    console, setTimeout, clearTimeout, Date, Math, JSON,
    setInterval: () => 0, clearInterval: () => {},
    requestAnimationFrame: (f) => setTimeout(f, 0)
  };
  ctx.globalThis = ctx; ctx.self = ctx;
  vm.createContext(ctx);
  vm.runInContext(src, ctx, { filename: '10-pipeline.js' });
  // The module is an IIFE; helpers are reachable only through its public API.
  return (win.PUBLIC_REPORT_PIPELINE_V1 && win.PUBLIC_REPORT_PIPELINE_V1.helpers) || {};
}

// The real board from SW-20260831-4VF0C, top transfers by size.
const KRAKEN_A = 'rLHzPsX6oXkzU2qL12kHCH8G8cnZv1rBJh';
const KRAKEN_B = 'rnJrjec2vrTJAAQUTMTjj7U6xdXrk9N4mT';
const WHALE    = 'rsyDbFqTfyaBBLGBrEqLkTmZKmhArCUDC0';
const COINBASE = 'rw2ciyaNshpHe7bCHo4bRWq6pqqynnWKQg';

const IDENT = {};
IDENT[KRAKEN_A] = { name: 'Kraken', provenance: 'xrpscan' };
IDENT[KRAKEN_B] = { name: 'Kraken', provenance: 'xrpscan' };
IDENT[COINBASE] = { name: 'Coinbase', provenance: 'xrpscan' };
// WHALE deliberately absent — an unidentified wallet.

const PACK = {
  large_transfers: [
    { from: KRAKEN_A, to: KRAKEN_B, amount: 25290000, hash: 'A'.repeat(64) },
    { from: WHALE,    to: COINBASE, amount: 22770000, hash: 'B'.repeat(64) },
    { from: KRAKEN_B, to: KRAKEN_A, amount: 20000000, hash: 'C'.repeat(64) }
  ]
};

console.log('STANDOUT ANOMALY SELECTION\n');

const fn = load(IDENT).summarizeLargeMoves;
check('summarizeLargeMoves is reachable', typeof fn === 'function');
if (typeof fn !== 'function') { console.log('\n1 FAILED'); process.exit(1); }

const out = fn(PACK);
console.log('  headline: ' + JSON.stringify(out.headline));
console.log('  summary : ' + JSON.stringify(out.summary) + '\n');

console.log('1. the anomaly crosses between entities');
check('headline is NOT the Kraken-to-Kraken move',
      !/from Kraken to Kraken/i.test(out.headline), out.headline);
check('headline is the whale -> Coinbase transfer',
      /22\.77M XRP/.test(out.headline) && /Coinbase/.test(out.headline), out.headline);

console.log('\n2. the demoted internal move is still reported');
check('the 25.29M move is still stated', /25\.29M XRP/.test(out.summary), out.summary);
check('it is described as internal, not as a crossing transfer',
      /internal to Kraken/i.test(out.summary), out.summary);
check('its ledger hash is carried as provenance',
      (out.source_refs || []).some(r => r.id === 'A'.repeat(64)),
      (out.source_refs || []).map(r => r.kind + ':' + String(r.id).slice(0, 6)));
check('a Kraken label ref is carried for the name used',
      (out.source_refs || []).some(r => r.kind === 'label_registry' && /Kraken/.test(r.label || '')));

console.log('\n3. an all-internal board does not read as a mistake');
const INTERNAL_ONLY = { large_transfers: [
  { from: KRAKEN_A, to: KRAKEN_B, amount: 25290000, hash: 'D'.repeat(64) },
  { from: KRAKEN_B, to: KRAKEN_A, amount: 11000000, hash: 'E'.repeat(64) }
] };
const only = load(IDENT).summarizeLargeMoves(INTERNAL_ONLY);
console.log('  headline: ' + JSON.stringify(only.headline));
check('never prints "from Kraken to Kraken"',
      !/from Kraken to Kraken/i.test(only.headline), only.headline);
check('says the move was between two Kraken wallets',
      /between two Kraken wallets/i.test(only.headline), only.headline);
check('still reports the amount', /25\.29M XRP/.test(only.headline), only.headline);

console.log('\n4. two unidentified wallets are NOT treated as one entity');
// Both ends unknown: they render with the same fallback wording, so an
// identity-blind comparison would wrongly call this internal and demote a
// genuine stranger-to-stranger transfer.
const STRANGERS = { large_transfers: [
  { from: 'rStranger1AAAAAAAAAAAAAAAAAAAAAAAA', to: 'rStranger2BBBBBBBBBBBBBBBBBBBBBBBB',
    amount: 30000000, hash: 'F'.repeat(64) },
  { from: WHALE, to: COINBASE, amount: 1000000, hash: '9'.repeat(64) }
] };
const str = load(IDENT).summarizeLargeMoves(STRANGERS);
console.log('  headline: ' + JSON.stringify(str.headline));
check('the 30M stranger-to-stranger transfer still leads',
      /30\.00M XRP|30M XRP/.test(str.headline), str.headline);
check('it is not described as internal',
      !/between two/i.test(str.headline) && !/internal to/i.test(str.headline), str.headline);

console.log('\n' + (fail ? fail + ' FAILED of ' + (pass + fail) : 'ALL ' + pass + ' CHECKS PASS'));
process.exit(fail ? 1 : 0);
