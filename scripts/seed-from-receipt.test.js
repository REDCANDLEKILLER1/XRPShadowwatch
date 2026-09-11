#!/usr/bin/env node
'use strict';
/* ── THE CHECKPOINT WAS IN THE REPOSITORY ALL ALONG ─────────────────────────
   A sealed report that proved 255 of 255 names the validated ledger every one
   of them was proven through. That is last_proven_ledger, written down and
   committed by the run that earned it — so the delta model can start with no
   database at all, which matters when the database is over quota.

   What this suite holds the seeder to:

     only a receipt that proved the WHOLE roster establishes a checkpoint
     a changed roster is refused, because the receipt records a hash not a list
     the newest earned anchor wins
     no balance is invented — the first run establishes that baseline
     genesis happens once
──────────────────────────────────────────────────────────────────────────── */
const path = require('path');
const fs = require('fs');
const ROOT = path.join(__dirname, '..');
const State = require(path.join(ROOT, 'src/db/evidence-state.js'));

let pass = 0, fail = 0;
const check = (name, ok, detail) => {
  if (ok) { pass++; console.log('  PASS  ' + name); }
  else { fail++; console.log('  FAIL  ' + name + (detail !== undefined ? '  -> ' + JSON.stringify(detail) : '')); }
};
const SRC = fs.readFileSync(path.join(ROOT, 'scripts/seed-state-from-receipt.js'), 'utf8');

// The script's own predicate, required rather than re-implemented, so the two
// cannot drift apart.
const { complete } = require(path.join(ROOT, 'scripts/seed-state-from-receipt.js'));

const receipt = (over) => Object.assign({
  report_id: 'SW-20260909-OP57K', scan_id: 'SC-MTTH0ITG',
  target_wallets: 255, transaction_windows_proved: 255,
  failed: 0, truncated: 0, unproven: 0,
  validated_anchor_ledger: 106858107, coverage_complete: true,
  roster_hash: 'd'.repeat(64), generated_at: '2026-09-09T02:15:31.000Z'
}, over || {});

console.log('\n1. only a run that proved the whole roster establishes a checkpoint');
check('255 of 255, nothing failed, is usable', complete(receipt()) === true);
// "255 wallets, 3 failed" establishes nothing for the other 252 either: the run
// was never sealed complete, so its anchor was never earned.
check('a run that failed a wallet is not usable', complete(receipt({ failed: 1 })) === false);
check('nor one that truncated', complete(receipt({ truncated: 1 })) === false);
check('nor one with an unproven wallet', complete(receipt({ unproven: 1 })) === false);
check('nor 254 of 255', complete(receipt({ transaction_windows_proved: 254 })) === false);
check('nor one whose own coverage flag is false',
  complete(receipt({ coverage_complete: false })) === false);
check('nor one with no anchor', complete(receipt({ validated_anchor_ledger: 0 })) === false);
check('nor one with a non-integer anchor',
  complete(receipt({ validated_anchor_ledger: 'latest' })) === false);
check('nor an empty roster', complete(receipt({ target_wallets: 0, transaction_windows_proved: 0 })) === false);

console.log('\n2. a changed roster is refused, not guessed at');
// The receipt records roster_hash but not the addresses. If the hash differs
// there is no way to know WHICH wallets that anchor covered, and seeding all of
// them would hand a checkpoint to a wallet nobody proved.
check('the roster hash is compared before anything is seeded',
  /selected\.hash !== receipt\.roster_hash/.test(SRC) &&
  SRC.indexOf('ROSTER_CHANGED_SINCE_RECEIPT') < SRC.indexOf('Store.seedGenesis'));
check('and the refusal explains why the hash alone is not enough',
  /records only its hash/.test(SRC));
check('the sizes are checked too', /ROSTER_SIZE_MISMATCH/.test(SRC));

console.log('\n3. the newest earned anchor wins');
check('usable receipts are ordered by anchor, and the last is taken',
  /sort\(\(a, b\) => Number\(a\.receipt\.validated_anchor_ledger\) - Number\(b\.receipt\.validated_anchor_ledger\)\)/.test(SRC) &&
  /usable\[usable\.length - 1\]/.test(SRC));
check('a specific report can be named instead', /--report/.test(SRC) && /REPORT_NOT_USABLE/.test(SRC));
check('an archive with no complete receipt is refused rather than half-seeded',
  /NO_COMPLETE_RECEIPT/.test(SRC));
check('and an archive with no receipts at all is refused', /NO_RECEIPTS/.test(SRC));

console.log('\n4. what genesis claims, and what it does not');
const ADDRS = Array.from({ length: 255 }, (_, i) => 'r' + String(i).padStart(33, '0'));
const seeded = State.genesis(
  ADDRS.map(a => ({ address: a, scan_coverage_through: 106858107, scan_coverage_through_close: null })),
  { anchor_ledger: 106858107, anchor_close: null });
check('every wallet is checkpointed at the anchor the run earned',
  seeded.wallet_count === 255 && seeded.wallets.every(w => w.last_proven_ledger === 106858107));
// Claiming a balance nobody read would give tomorrow's reconciliation a false
// endpoint, and a false endpoint is worse than no cross-check at all.
check('no balance is invented — the first run establishes that baseline',
  seeded.wallets.every(w => w.balance_drops === null && w.balance_ledger === null));
// And the seeder itself must not supply one: the check above builds its own
// genesis, so without this a balance added to the seeder's coverage rows would
// sail through.
const COVERAGE_MAP = (SRC.match(/const coverage = selected\.accounts\.map\([\s\S]*?\}\)\);/) || [''])[0];
check('and the seeder passes no balance into it',
  COVERAGE_MAP.length > 0 && !/balance/i.test(COVERAGE_MAP), COVERAGE_MAP.slice(0, 120));
check('and the seeder does not fabricate an anchor close time it never read',
  /anchor_close: null/.test(SRC) && /scan_coverage_through_close: null/.test(SRC));
check('the state hashes itself', seeded.state_sha256 === State.digest(seeded));
check('genesis has no predecessor', seeded.previous_state_sha256 === null);

console.log('\n5. the walk this produces');
const edge = State.edgeFor(seeded.wallets[0], 106901000);
check('the next run starts one ledger past the proven anchor', edge.from_ledger === 106858108);
check('and ends at today\'s anchor, whatever the gap', edge.through_ledger === 106901000);
check('no wallet is cold — all 255 carry a real checkpoint',
  seeded.wallets.every(w => State.edgeFor(w, 106901000).cold === false));

console.log('\n6. no database, and one write at most');
check('the seeder never requires the Neon connection',
  !/require\('\.\.\/src\/db\/connection'\)/.test(SRC) && !/getExecutor/.test(SRC));
check('and issues no SQL', !/\b(SELECT|INSERT|UPDATE|DELETE)\s/i.test(SRC.replace(/^\s*\/\/.*$/gm, '')));
check('it is a dry run unless --apply is given',
  /if \(!opts\.apply\)/.test(SRC) && /Nothing was written/.test(SRC));
check('genesis happens once — an existing chain is reported, not replaced',
  /ALREADY_SEEDED/.test(SRC) && /genesis happens once/.test(SRC));

console.log('\n' + (fail ? fail + ' FAILED of ' + (pass + fail) : 'ALL ' + pass + ' SEED-FROM-RECEIPT CHECKS PASS'));
process.exit(fail ? 1 : 0);
