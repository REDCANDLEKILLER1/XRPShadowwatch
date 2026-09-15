#!/usr/bin/env node
'use strict';
/* ── THE JOURNAL IS NOT EVIDENCE, AND THAT IS EXACTLY WHY IT NEEDS RULES ────
   The journal exists so a run that dies at wallet 240 resumes at 241 instead
   of paying XRPL a second time for 240 wallets it already walked. It proves
   nothing and advances no coverage floor.

   But it DOES decide what a resumed run skips. A journal that could be edited,
   replayed, or pointed at the wrong anchor would let a run inherit "proof" it
   never earned — which is the one failure this whole project exists to make
   impossible. So the journal is held to the same standard as the checkpoint:

     hashed, so an edit is caught rather than believed
     anchored, so a wallet cannot enter it proven to a different instant
     pinned to the checkpoint it began from, so it dies when that moves
     append-only per wallet, so a wallet cannot be recorded twice
     quarantined, so it can never name a path report assembly reads

   No database, no network, no filesystem.
──────────────────────────────────────────────────────────────────────────── */
const path = require('path');
const ROOT = path.join(__dirname, '..');
const J = require(path.join(ROOT, 'src/db/run-journal.js'));

let pass = 0, fail = 0;
const check = (name, ok, detail) => {
  if (ok) { pass++; console.log('  PASS  ' + name); }
  else { fail++; console.log('  FAIL  ' + name + (detail !== undefined ? '  -> ' + JSON.stringify(detail) : '')); }
};
const refusal = fn => { try { fn(); return null; } catch (e) { return e.journalRefused ? e.message : 'UNTAGGED:' + e.message; } };

const ANCHOR = 110000000;
const STATE = { state_sha256: 'a'.repeat(64), anchor_ledger: ANCHOR - 1000 };
const BASE = J.begin({
  report_id: 'SW-20260913-AAAAA', scan_id: 'idx-1', started_at: '2026-09-13T06:00:00.000Z',
  from_state_version: 7, from_state_sha256: STATE.state_sha256,
  anchor_ledger: ANCHOR, anchor_close: '2026-09-13T06:00:00.000Z',
  cold_from_ledger: null, admitted_wallets: []
});
const wallet = (address, over) => Object.assign({
  address, proven_from: ANCHOR - 999, proven_through: ANCHOR, rows: 3,
  reconciliation: 'RECONCILED',
  entry: { address, last_proven_ledger: ANCHOR }
}, over || {});
const SHARD = { path: 'evidence/runs/resume/SW-20260913-AAAAA-0001.ndjson.gz',
  sha256: 'b'.repeat(64), rows: 6 };

console.log('\n1. a journal begins empty and hashes itself');
check('nothing is recorded yet', BASE.wallet_count === 0 && BASE.segments === 0);
check('it hashes to its own digest', BASE.journal_sha256 === J.digest(BASE));
check('it carries the anchor it will be finished against', BASE.anchor_ledger === ANCHOR);
check('and the checkpoint it began from', BASE.from_state_sha256 === STATE.state_sha256);
check('assembling the same journal in a different wallet order hashes identically',
  J.digest(J.record(BASE, { wallets: [wallet('rAlice'), wallet('rBob')], row_shards: [] })) ===
  J.digest(J.record(BASE, { wallets: [wallet('rBob'), wallet('rAlice')], row_shards: [] })));

console.log('\n2. recording a segment');
const ONE = J.record(BASE, { wallets: [wallet('rAlice'), wallet('rBob')], row_shards: [SHARD] });
check('both wallets are in', ONE.wallet_count === 2 && ONE.segments === 1);
check('the shard is named and hashed', ONE.row_shards.length === 1 &&
  ONE.row_shards[0].path === SHARD.path);
check('each wallet carries the range it proved, not a done flag',
  ONE.wallets.every(w => w.proven_from === ANCHOR - 999 && w.proven_through === ANCHOR));
check('and the state entry it earned',
  ONE.wallets.every(w => w.entry && w.entry.last_proven_ledger === ANCHOR));
check('the journal re-hashes after the append', ONE.journal_sha256 === J.digest(ONE));
const TWO = J.record(ONE, { wallets: [wallet('rCarol')], row_shards: [] });
check('a second segment appends rather than replaces',
  TWO.wallet_count === 3 && TWO.segments === 2 && TWO.row_shards.length === 1);
check('done addresses are what a resumed run skips',
  [...J.doneAddresses(TWO)].sort().join(',') === 'rAlice,rBob,rCarol');

console.log('\n3. what record() refuses');
check('a wallet recorded twice is refused — it would double its rows into the run',
  /JOURNAL_WALLET_ALREADY_RECORDED: rAlice/.test(
    refusal(() => J.record(ONE, { wallets: [wallet('rAlice')], row_shards: [] }))));
check('a wallet proven to some other anchor is refused',
  /JOURNAL_WALLET_WRONG_ANCHOR/.test(
    refusal(() => J.record(BASE, { wallets: [wallet('rZed', { proven_through: ANCHOR - 5 })], row_shards: [] }))));
check('a wallet proven PAST the anchor is refused too',
  /JOURNAL_WALLET_WRONG_ANCHOR/.test(
    refusal(() => J.record(BASE, { wallets: [wallet('rZed', { proven_through: ANCHOR + 5 })], row_shards: [] }))));
check('a wallet with no state entry is refused — a resume could not commit it',
  /JOURNAL_WALLET_ENTRY_MISSING/.test(
    refusal(() => J.record(BASE, { wallets: [wallet('rZed', { entry: null })], row_shards: [] }))));
check('an entry for a DIFFERENT address is refused',
  /JOURNAL_WALLET_ENTRY_MISSING/.test(
    refusal(() => J.record(BASE, { wallets: [wallet('rZed', { entry: { address: 'rOther' } })], row_shards: [] }))));
check('an address-less wallet is refused',
  /JOURNAL_WALLET_ADDRESS_MISSING/.test(
    refusal(() => J.record(BASE, { wallets: [wallet(null)], row_shards: [] }))));
check('an unhashed row file is refused',
  /JOURNAL_SHARD_UNHASHED/.test(refusal(() => J.record(BASE,
    { wallets: [], row_shards: [{ path: SHARD.path }] }))));
// The quarantine. A journal that could name a path under evidence/YYYY/MM/DD
// would be planting rows that report assembly reads with no checkpoint behind
// them — evidence by assertion rather than by proof.
check('a row file outside the resume subtree is refused',
  /JOURNAL_SHARD_OUTSIDE_RESUME/.test(refusal(() => J.record(BASE,
    { wallets: [], row_shards: [{ path: 'evidence/2026/09/13/events.ndjson.gz', sha256: 'c'.repeat(64) }] }))));
check('and so is one that tries to reach the checkpoint itself',
  /JOURNAL_SHARD_OUTSIDE_RESUME/.test(refusal(() => J.record(BASE,
    { wallets: [], row_shards: [{ path: 'evidence/state/latest.json', sha256: 'c'.repeat(64) }] }))));
check('a journal that does not hash to its own digest cannot be appended to',
  /JOURNAL_DIGEST_MISMATCH/.test(refusal(() => J.record(
    { ...ONE, anchor_ledger: ANCHOR + 1 }, { wallets: [], row_shards: [] }))));

console.log('\n4. what usable() refuses');
check('an untouched journal is usable', J.usable(TWO, STATE).ok);
check('an edited journal is caught by its own digest',
  J.usable({ ...TWO, wallets: TWO.wallets.map(w => ({ ...w, rows: 999 })) }, STATE)
    .problems.includes('DIGEST_MISMATCH'));
// The dangerous case: a journal that outlived a commit. Its wallets were walked
// from checkpoints that have since moved, so resuming would re-claim a window
// already claimed.
check('a journal whose checkpoint has moved under it is refused',
  J.usable(TWO, { ...STATE, state_sha256: 'd'.repeat(64) })
    .problems.includes('CHECKPOINT_MOVED_SINCE'));
check('a journal whose anchor is no longer ahead of the checkpoint is refused',
  J.usable(TWO, { ...STATE, anchor_ledger: ANCHOR })
    .problems.includes('ANCHOR_NO_LONGER_AHEAD'));
check('and one whose anchor is behind it',
  J.usable(TWO, { ...STATE, anchor_ledger: ANCHOR + 1 })
    .problems.includes('ANCHOR_NO_LONGER_AHEAD'));
// Re-sealed by hand, so the digest is valid again — the per-wallet anchor check
// is what is left, and it has to hold on its own.
check('a re-sealed journal with a wallet on the wrong anchor is still refused',
  J.usable(J.seal({ ...TWO, wallets: TWO.wallets.map((w, i) =>
    i ? w : { ...w, proven_through: ANCHOR - 400 }) }), STATE)
    .problems.some(p => p.startsWith('WALLET_WRONG_ANCHOR:')));
check('and one with a wallet whose state entry was stripped',
  J.usable(J.seal({ ...TWO, wallets: TWO.wallets.map((w, i) =>
    i ? w : { ...w, entry: null }) }), STATE)
    .problems.some(p => p.startsWith('WALLET_ENTRY_MISSING:')));
check('an unknown schema is refused', !J.usable({ ...TWO, schema: 'something-else/9' }, STATE).ok);
check('a malformed report id is refused',
  J.usable(J.seal({ ...TWO, report_id: 'not-a-report' }), STATE)
    .problems.includes('REPORT_ID_INVALID'));
check('a journal with no anchor is refused',
  J.usable(J.seal({ ...TWO, anchor_ledger: null }), STATE).problems.includes('ANCHOR_MISSING'));
check('usable() never throws on rubbish — a bad journal costs a re-walk, not the run',
  (() => { for (const v of [null, undefined, {}, { schema: J.SCHEMA }, 'x', 42]) {
    try { if (J.usable(v, STATE).ok) return false; } catch (_) { return false; } }
    return true; })());

console.log('\n5. everything the journal owns can be removed with it');
const owned = J.ownedPaths(TWO, 'evidence/runs/resume/latest.json');
check('the manifest and every row file are named',
  owned.length === 2 && owned[0] === 'evidence/runs/resume/latest.json' &&
  owned[1] === SHARD.path, owned);
check('a journal with no rows still names its manifest',
  J.ownedPaths(BASE, 'evidence/runs/resume/latest.json').length === 1);
check('and a missing journal names it too, so a stray file can still be cleaned up',
  J.ownedPaths(null, 'evidence/runs/resume/latest.json').length === 1);

console.log('\n6. it stays small enough to read at the start of every run');
const big = Array.from({ length: 408 }, (_, i) =>
  wallet('r' + String(i).padStart(33, '0')));
const full = J.record(BASE, { wallets: big, row_shards: [SHARD] });
const bytes = Buffer.byteLength(J.serialize(full), 'utf8');
check('408 wallets of journal is well under a megabyte', bytes < 512 * 1024, bytes);
check('and it round-trips through JSON unchanged',
  J.digest(JSON.parse(J.serialize(full))) === full.journal_sha256);

console.log('\n' + (fail ? fail + ' FAILED of ' + (pass + fail) : 'ALL ' + pass + ' RUN JOURNAL CHECKS PASS'));
process.exit(fail ? 1 : 0);
