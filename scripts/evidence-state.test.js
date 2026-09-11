#!/usr/bin/env node
'use strict';
/* ── THE CHECKPOINT LEFT THE DATABASE, SO THE RULES MOVED HERE ──────────────
   wallet_coverage_monotonic() is a BEFORE UPDATE trigger: it makes a backwards
   checkpoint structurally impossible, because Postgres refuses the write. A
   JSON file in a branch refuses nothing. Everything that trigger guaranteed is
   now a rule in advance()/verify(), and this suite is what makes those rules
   real rather than aspirational.

   The properties:
     a checkpoint never moves backwards, and never past the anchor it was proven against
     the state advances only on a WHOLE run — 255/255 and zero contradictions
     a state names the evidence committed with it, so proof always has a file behind it
     the chain is hashed, so an edit to any state breaks every link after it
     balance is carried, but never consulted to decide what to fetch

   No database, no network, no filesystem.
──────────────────────────────────────────────────────────────────────────── */
const path = require('path');
const fs = require('fs');
const ROOT = path.join(__dirname, '..');
const S = require(path.join(ROOT, 'src/db/evidence-state.js'));

let pass = 0, fail = 0;
const check = (name, ok, detail) => {
  if (ok) { pass++; console.log('  PASS  ' + name); }
  else { fail++; console.log('  FAIL  ' + name + (detail !== undefined ? '  -> ' + JSON.stringify(detail) : '')); }
};
// advance() refuses by throwing a tagged error. The reason is part of the
// contract: an operator reading a failed run has to learn which rule stopped it.
const refusal = (fn) => { try { fn(); return null; } catch (e) { return e.stateRefused ? e.message : 'UNTAGGED:' + e.message; } };

const COVERAGE = [
  { address: 'rAlice', scan_coverage_through: 100, scan_coverage_through_close: '2026-09-10T00:00:00.000Z' },
  { address: 'rBob', scan_coverage_through: 100, scan_coverage_through_close: '2026-09-10T00:00:00.000Z' },
  { address: 'rCarol', scan_coverage_through: 100, scan_coverage_through_close: '2026-09-10T00:00:00.000Z' }
];
const GENESIS = S.genesis(COVERAGE, { anchor_ledger: 100, anchor_close: '2026-09-10T00:00:00.000Z' });
const SHARD = { path: 'evidence/2026/09/11/events.ndjson.gz', sha256: 'a'.repeat(64), rows: 12 };
const run = (over) => Object.assign({
  anchor_ledger: 200, anchor_close: '2026-09-11T00:00:00.000Z',
  scan_id: 'idx-1', report_id: 'SW-20260911-AAAAA', sealed_at: '2026-09-11T00:05:00.000Z',
  target_wallets: 3, complete_wallets: 3, balance_contradictions: 0,
  evidence_shards: [SHARD],
  wallets: COVERAGE.map(c => ({ address: c.address, last_proven_ledger: 200,
    last_observed_tx_ledger: 150, last_observed_tx_hash: 'H'.repeat(64),
    balance_drops: '20000000000000', balance_ledger: 200, reconciliation: 'RECONCILED' }))
}, over || {});

console.log('\n1. genesis carries what Neon already proved');
check('every wallet appears', GENESIS.wallet_count === 3 && GENESIS.wallets.length === 3);
check('the checkpoint comes from the exported coverage, not from zero',
  GENESIS.wallets.every(w => w.last_proven_ledger === 100));
check('wallets are sorted, so the file hashes the same however it was built',
  GENESIS.wallets.map(w => w.address).join(',') === 'rAlice,rBob,rCarol');
check('genesis has no predecessor', GENESIS.previous_state_sha256 === null && GENESIS.state_version === 1);
check('and it hashes itself', GENESIS.state_sha256 === S.digest(GENESIS));
check('assembling the same state in a different order hashes identically',
  S.digest(S.genesis([COVERAGE[2], COVERAGE[0], COVERAGE[1]],
    { anchor_ledger: 100, anchor_close: '2026-09-10T00:00:00.000Z' })) === S.digest(GENESIS));

console.log('\n2. a whole run, or nothing');
// Per-wallet commits were the thing to avoid: a run that dies halfway would
// leave some checkpoints ahead of others and no single state to reason about.
const next = S.advance(GENESIS, run());
check('a complete, uncontradicted run advances the state', next.state_version === 2);
check('the new state chains to the old one', next.previous_state_sha256 === GENESIS.state_sha256);
check('and records which run sealed it',
  next.sealed_run.scan_id === 'idx-1' && next.sealed_run.report_id === 'SW-20260911-AAAAA');
check('254 of 255 does not advance anything',
  refusal(() => S.advance(GENESIS, run({ complete_wallets: 2 }))) === 'RUN_INCOMPLETE: 2 of 3 wallets proved');
// The contradiction gate, at the last place it can still stop a bad claim.
check('one balance contradiction does not advance anything',
  /^RUN_CONTRADICTED: 1 wallet/.test(refusal(() => S.advance(GENESIS, run({ balance_contradictions: 1 })))));
check('a run missing a wallet entirely is refused',
  /RUN_WALLET_COUNT_MISMATCH/.test(refusal(() => S.advance(GENESIS, run({ wallets: run().wallets.slice(0, 2) })))));
check('and a wallet silently dropped from the roster is refused',
  /WALLET_DROPPED_FROM_STATE|RUN_WALLET_COUNT_MISMATCH/.test(refusal(() =>
    S.advance(GENESIS, run({ target_wallets: 2, complete_wallets: 2, wallets: run().wallets.slice(0, 2) })))));

console.log('\n3. the monotonic rule the database used to enforce');
check('a checkpoint that moves backwards is refused',
  /^CHECKPOINT_WOULD_MOVE_BACKWARDS: rAlice 100 -> 99$/.test(refusal(() => S.advance(GENESIS, run({
    wallets: run().wallets.map(w => w.address === 'rAlice' ? { ...w, last_proven_ledger: 99 } : w) })))));
check('standing still is allowed — a repeat run proves nothing new, but loses nothing',
  S.advance(GENESIS, run({ wallets: run().wallets.map(w => ({ ...w, last_proven_ledger: 100 })) })).state_version === 2);
check('a checkpoint past the run anchor is refused',
  /^CHECKPOINT_PAST_ANCHOR: rAlice claims 201 against anchor 200$/.test(refusal(() => S.advance(GENESIS, run({
    wallets: run().wallets.map(w => w.address === 'rAlice' ? { ...w, last_proven_ledger: 201 } : w) })))));
check('an unproven wallet is refused rather than carried forward',
  /RUN_WALLET_UNPROVEN/.test(refusal(() => S.advance(GENESIS, run({
    wallets: run().wallets.map(w => w.address === 'rBob' ? { ...w, last_proven_ledger: null } : w) })))));
// Anchors come from validated ledgers and only move forward. Reusing one would
// let a run re-claim a window it already claimed.
check('an anchor that does not advance is refused',
  /RUN_ANCHOR_NOT_AHEAD/.test(refusal(() => S.advance(next, run({ anchor_ledger: 200 })))));
check('and so is one that goes backwards',
  /RUN_ANCHOR_NOT_AHEAD/.test(refusal(() => S.advance(next, run({ anchor_ledger: 150 })))));

console.log('\n4. proof always has a file behind it');
check('a state advance must name the evidence committed with it',
  /RUN_SHARDS_MISSING/.test(refusal(() => S.advance(GENESIS, run({ evidence_shards: null })))));
check('and every shard must be hashed, not merely named',
  /RUN_SHARD_UNHASHED/.test(refusal(() => S.advance(GENESIS, run({
    evidence_shards: [{ path: 'evidence/x.ndjson.gz' }] })))));
check('a shard with a malformed hash is refused',
  /RUN_SHARD_UNHASHED/.test(refusal(() => S.advance(GENESIS, run({
    evidence_shards: [{ path: 'evidence/x.ndjson.gz', sha256: 'not-a-hash' }] })))));
check('the shards are recorded in the state that depends on them',
  next.evidence_shards.length === 1 && next.evidence_shards[0].sha256 === SHARD.sha256);
// A quiet day genuinely produces no new events. That is not a missing shard —
// it is an empty list, which is a different claim and an allowed one.
check('a run that found nothing may still advance, with no shards',
  S.advance(GENESIS, run({ evidence_shards: [] })).state_version === 2);

console.log('\n5. the chain makes an edit visible');
check('an untouched chain verifies', S.verify(next, GENESIS).ok);
const edited = JSON.parse(JSON.stringify(next));
edited.wallets[0].last_proven_ledger = 999;
check('editing a checkpoint by hand breaks the state digest',
  S.verify(edited, GENESIS).problems.includes('DIGEST_MISMATCH'));
const resealed = S.seal(edited);
check('re-sealing it fixes the digest but breaks the chain to its predecessor',
  S.digest(resealed) === resealed.state_sha256 &&
  S.verify({ ...resealed, previous_state_sha256: 'b'.repeat(64) }, GENESIS).problems.includes('CHAIN_BROKEN'));
// And if the editor keeps the chain intact, the monotonic check still catches
// a rewind — which is the failure that actually matters.
const rewound = S.seal({ ...next, wallets: next.wallets.map(w => ({ ...w, last_proven_ledger: 50 })) });
check('a rewound checkpoint is caught even with the chain intact',
  S.verify(rewound, GENESIS).problems.some(p => p.startsWith('CHECKPOINT_MOVED_BACKWARDS')));
check('a skipped version is caught',
  S.verify(S.seal({ ...next, state_version: 9 }), GENESIS).problems.includes('VERSION_NOT_SEQUENTIAL'));
check('a state that does not hash to its own digest cannot be advanced from',
  /STATE_DIGEST_MISMATCH/.test(refusal(() => S.advance(edited, run({ anchor_ledger: 300 })))));

console.log('\n6. balance is carried, never consulted');
// The rule the whole delta design rests on. A routing wallet that receives and
// forwards the same five million XRP inside a day is net-zero at both ends and
// looks identical to a quiet one, so the walk must not ask the balance first.
const SOURCE = fs.readFileSync(path.join(ROOT, 'src/db/evidence-state.js'), 'utf8');
const EDGE_FN = SOURCE.split('function edgeFor')[1].split('\nmodule.exports')[0];
check('the edge is computed from the checkpoint and the anchor alone',
  !/balance/i.test(EDGE_FN.replace(/^\s*\/\/.*$/gm, '')));
const flat = S.edgeFor({ address: 'rAlice', last_proven_ledger: 100, balance_drops: '5', balance_ledger: 100 }, 200);
const moved = S.edgeFor({ address: 'rBob', last_proven_ledger: 100, balance_drops: '999', balance_ledger: 100 }, 200);
check('a wallet whose balance did not move gets the same walk as one that did',
  flat.from_ledger === moved.from_ledger && flat.through_ledger === moved.through_ledger);
check('the walk starts one ledger past the checkpoint', flat.from_ledger === 101 && flat.through_ledger === 200);
// Three days without a run must search three days, not one.
check('a stale checkpoint searches the whole gap, not a fixed day',
  S.edgeFor({ address: 'rAlice', last_proven_ledger: 100 }, 300000).through_ledger === 300000);
check('a wallet with no checkpoint is a cold bootstrap, and says so',
  S.edgeFor({ address: 'rNew', last_proven_ledger: null }, 200).cold === true &&
  S.edgeFor({ address: 'rNew', last_proven_ledger: null }, 200).from_ledger === null);
check('an existing wallet is never cold because a new one was added',
  S.edgeFor({ address: 'rAlice', last_proven_ledger: 100 }, 200).cold === false);
check('an edge without an anchor is an error, not an unbounded walk',
  (() => { try { S.edgeFor({ address: 'rA', last_proven_ledger: 1 }, null); return false; } catch (_) { return true; } })());
check('a balance is carried only when pinned to a ledger',
  /BALANCE_NOT_PINNED/.test(refusal(() => S.advance(GENESIS, run({
    wallets: run().wallets.map(w => w.address === 'rAlice' ? { ...w, balance_ledger: null } : w) })))));

console.log('\n7. the file stays small enough to read every run');
const serialized = S.serialize(S.genesis(
  Array.from({ length: 255 }, (_, i) => ({ address: 'r' + String(i).padStart(33, '0'), scan_coverage_through: 100000000 })),
  { anchor_ledger: 100000000 }));
const bytes = Buffer.byteLength(serialized, 'utf8');
check('255 wallets of state is a few hundred kB at most', bytes < 300 * 1024, bytes);
check('it is valid JSON and round-trips', S.digest(JSON.parse(serialized)) === JSON.parse(serialized).state_sha256);

console.log('\n' + (fail ? fail + ' FAILED of ' + (pass + fail) : 'ALL ' + pass + ' EVIDENCE STATE CHECKS PASS'));
process.exit(fail ? 1 : 0);
