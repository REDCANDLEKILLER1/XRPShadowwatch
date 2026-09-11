#!/usr/bin/env node
'use strict';
/* ── ONE COMMIT PER RUN, OR THE CHECKPOINT DOES NOT MOVE ────────────────────
   A per-wallet commit would mean 255 ref updates and 255 chances to stop
   half-way, leaving wallet 120 proven through today and wallet 121 still on
   yesterday, with no single state describing what the system knows.

   So the run accumulates and lands as ONE commit — shards, run manifest, state
   history, latest.json — under one ref update. What this suite asserts is that
   the gate really is the commit: an incomplete run, a contradicted run or a
   stale anchor must write NOTHING, not "most of it".

   The GitHub API is a fake that records every call. No network, no database.
──────────────────────────────────────────────────────────────────────────── */
const path = require('path');
const fs = require('fs');
const ROOT = path.join(__dirname, '..');
const Store = require(path.join(ROOT, 'src/db/github-store.js'));
const State = require(path.join(ROOT, 'src/db/evidence-state.js'));

let pass = 0, fail = 0;
const check = (name, ok, detail) => {
  if (ok) { pass++; console.log('  PASS  ' + name); }
  else { fail++; console.log('  FAIL  ' + name + (detail !== undefined ? '  -> ' + JSON.stringify(detail) : '')); }
};
const ENV = { SHADOWWATCH_GITHUB_ARCHIVE_TOKEN: 'test-token' };

// A GitHub that behaves like the real one where it matters: contents reads,
// blob/tree/commit creation, and a ref PATCH that refuses a non-fast-forward.
function fakeGithub(options) {
  const opts = options || {};
  const calls = [];
  const blobs = new Map();
  const state = { headFiles: opts.files ? new Map(Object.entries(opts.files)) : new Map(), head: 'c0', n: 0 };
  const commits = new Map([['c0', { tree: 't0', files: new Map(state.headFiles) }]]);
  let conflictsLeft = opts.conflicts || 0;

  const gh = async (method, pathArg, body, allow404) => {
    calls.push({ method, path: pathArg, body });
    if (method === 'GET' && /^\/git\/ref\/heads\//.test(pathArg)) return { object: { sha: state.head } };
    if (method === 'GET' && /^\/contents\//.test(pathArg)) {
      const file = decodeURIComponent(pathArg.slice('/contents/'.length).split('?')[0]);
      const at = /ref=([^&]+)/.exec(pathArg);
      const snapshot = at && commits.get(decodeURIComponent(at[1])) ? commits.get(decodeURIComponent(at[1])).files : state.headFiles;
      if (!snapshot.has(file)) { if (allow404) return null; throw Object.assign(new Error('404'), { status: 404 }); }
      return { content: Buffer.from(snapshot.get(file), 'utf8').toString('base64') };
    }
    if (method === 'GET' && /^\/git\/commits\//.test(pathArg)) return { tree: { sha: 't' + pathArg.slice(-1) } };
    if (method === 'POST' && pathArg === '/git/blobs') {
      const sha = 'b' + (++state.n);
      blobs.set(sha, Buffer.from(body.content, 'base64').toString('utf8'));
      return { sha };
    }
    if (method === 'POST' && pathArg === '/git/trees') { state.pendingTree = body.tree; return { sha: 't' + (++state.n) }; }
    if (method === 'POST' && pathArg === '/git/commits') {
      const sha = 'c' + (++state.n);
      const files = new Map(state.headFiles);
      for (const entry of state.pendingTree) files.set(entry.path, blobs.get(entry.sha));
      commits.set(sha, { tree: body.tree, files });
      state.proposed = sha;
      return { sha };
    }
    if (method === 'PATCH' && /^\/git\/refs\/heads\//.test(pathArg)) {
      // Someone else moved the branch first. The real API answers 422.
      if (conflictsLeft > 0) { conflictsLeft--; throw Object.assign(new Error('422'), { status: 422 }); }
      state.head = body.sha;
      state.headFiles = new Map(commits.get(body.sha).files);
      return { object: { sha: body.sha } };
    }
    if (method === 'GET' && pathArg === '') return { default_branch: 'main' };
    return {};
  };
  return { gh, calls, files: () => state.headFiles, head: () => state.head };
}

const COVERAGE = ['rAlice', 'rBob', 'rCarol'].map(a => ({ address: a, scan_coverage_through: 100 }));
const GENESIS = State.genesis(COVERAGE, { anchor_ledger: 100, anchor_close: '2026-09-10T00:00:00.000Z' });
const SEEDED = { [Store.STATE_PATH]: State.serialize(GENESIS) };
const SHARD_PATH = 'evidence/2026/09/11/events.ndjson.gz';
const SHARD_BYTES = Buffer.from('{"hash":"A"}\n', 'utf8');
const run = (over) => Object.assign({
  report_id: 'SW-20260911-AAAAA', scan_id: 'idx-1', sealed_at: '2026-09-11T00:05:00.000Z',
  anchor_ledger: 200, anchor_close: '2026-09-11T00:00:00.000Z',
  target_wallets: 3, complete_wallets: 3, balance_contradictions: 0,
  evidence_shards: [{ path: SHARD_PATH, sha256: State.sha256(SHARD_BYTES), rows: 1 }],
  wallets: COVERAGE.map(c => ({ address: c.address, last_proven_ledger: 200,
    balance_drops: '20000000000000', balance_ledger: 200, reconciliation: 'RECONCILED' })),
  files: { [SHARD_PATH]: SHARD_BYTES }
}, over || {});

const refused = async (fn) => { try { await fn(); return null; } catch (e) { return e.message; } };

async function main() {
  console.log('\n1. the runtime read is one file, verified before it is believed');
  const reader = fakeGithub({ files: SEEDED });
  const got = await Store.readState({ env: ENV, gh: reader.gh });
  check('the stored state is returned', got.state.state_version === 1 && got.missing === false);
  const contentReads = reader.calls.filter(c => /^\/contents\//.test(c.path));
  check('exactly one file is fetched — the archive is never loaded to acquire',
    contentReads.length === 1 && contentReads[0].path.startsWith('/contents/' + Store.STATE_PATH), contentReads.map(c => c.path));
  check('and it is the small state file, not a shard',
    Store.STATE_PATH === 'evidence/state/latest.json');
  const absent = await Store.readState({ env: ENV, gh: fakeGithub({ files: {} }).gh });
  check('an absent state is a real answer, not an error', absent.missing === true && absent.state === null);
  // An edited checkpoint must be caught HERE, before it decides what to fetch.
  const tampered = JSON.parse(State.serialize(GENESIS));
  tampered.wallets[0].last_proven_ledger = 999999;
  const bad = fakeGithub({ files: { [Store.STATE_PATH]: JSON.stringify(tampered, null, 2) } });
  check('a hand-edited state is refused rather than used',
    /EVIDENCE_STATE_UNVERIFIED/.test(await refused(() => Store.readState({ env: ENV, gh: bad.gh }))));
  const garbage = fakeGithub({ files: { [Store.STATE_PATH]: 'not json' } });
  check('an unparseable state is refused rather than treated as absent',
    /EVIDENCE_STATE_UNREADABLE/.test(await refused(() => Store.readState({ env: ENV, gh: garbage.gh }))));

  console.log('\n2. a whole run lands as exactly one commit');
  const writer = fakeGithub({ files: SEEDED });
  const result = await Store.commitRun(run(), { env: ENV, gh: writer.gh });
  check('the commit succeeds and advances the state', result.status === 'COMMITTED' && result.state_version === 2);
  const refPatches = writer.calls.filter(c => c.method === 'PATCH');
  check('ONE ref update, not one per wallet', refPatches.length === 1, refPatches.length);
  const written = writer.files();
  check('the delta shard is in it', written.has(SHARD_PATH));
  check('the updated state is in the same commit', written.has(Store.STATE_PATH));
  check('an immutable copy of the state version is too',
    written.has(Store.historyPath(2)), [...written.keys()]);
  check('and the run manifest', written.has(Store.runPath('SW-20260911-AAAAA')));
  const committed = JSON.parse(written.get(Store.STATE_PATH));
  check('the committed state chains to the one it replaced',
    committed.previous_state_sha256 === GENESIS.state_sha256 && committed.state_version === 2);
  check('every wallet checkpoint advanced to the anchor',
    committed.wallets.every(w => w.last_proven_ledger === 200));
  check('the history copy is byte-identical to latest',
    written.get(Store.historyPath(2)) === written.get(Store.STATE_PATH));

  console.log('\n3. a run that did not earn it writes NOTHING');
  for (const [name, over, expect] of [
    ['an incomplete run', { complete_wallets: 2 }, /RUN_INCOMPLETE/],
    ['a contradicted run', { balance_contradictions: 1 }, /RUN_CONTRADICTED/],
    ['a backwards checkpoint', { wallets: run().wallets.map(w =>
      w.address === 'rAlice' ? { ...w, last_proven_ledger: 50 } : w) }, /CHECKPOINT_WOULD_MOVE_BACKWARDS/],
    ['a checkpoint past the anchor', { wallets: run().wallets.map(w =>
      w.address === 'rBob' ? { ...w, last_proven_ledger: 500 } : w) }, /CHECKPOINT_PAST_ANCHOR/],
    ['an unhashed shard', { evidence_shards: [{ path: SHARD_PATH }] }, /RUN_SHARD_UNHASHED/]
  ]) {
    const g = fakeGithub({ files: SEEDED });
    const message = await refused(() => Store.commitRun(run(over), { env: ENV, gh: g.gh }));
    const patched = g.calls.filter(c => c.method === 'PATCH').length;
    check(name + ' is refused', expect.test(String(message)), message);
    check('  ...and moves the branch not at all', patched === 0 && g.head() === 'c0', { patched, head: g.head() });
    check('  ...leaving the previous state exactly as it was',
      JSON.parse(g.files().get(Store.STATE_PATH)).state_version === 1);
  }

  console.log('\n4. nothing this path writes can reach the sealed-report archive');
  const stray = fakeGithub({ files: SEEDED });
  check('a shard path outside evidence/ is refused before any request',
    /SHARD_PATH_OUTSIDE_EVIDENCE/.test(await refused(() => Store.commitRun(
      run({ files: { 'reports/2026/09/11/receipt.json': 'x' } }), { env: ENV, gh: stray.gh }))));
  check('and it is refused before the branch is even read', stray.calls.length === 0, stray.calls.length);
  const SOURCE = fs.readFileSync(path.join(ROOT, 'src/db/github-store.js'), 'utf8');
  check('the store writes no path of its own outside evidence/',
    (SOURCE.match(/'(evidence|reports)\/[^']*'/g) || []).every(p => p.startsWith("'evidence/")));
  check('the target is the pinned one, not an environment-chosen repo',
    /A\.archiveTarget\(/.test(SOURCE) && !/SHADOWWATCH_GITHUB_ARCHIVE_REPOSITORY/.test(SOURCE));

  console.log('\n5. a concurrent run cannot be overwritten');
  // Someone else moved the branch while this run was walking. Retrying is
  // correct only if the state is re-read and re-advanced.
  const raced = fakeGithub({ files: SEEDED, conflicts: 1 });
  const afterRetry = await Store.commitRun(run(), { env: ENV, gh: raced.gh });
  check('a lost race is retried and then succeeds',
    afterRetry.status === 'COMMITTED' && afterRetry.retry_count === 1, afterRetry.retry_count);
  check('the state is re-read on each attempt, not computed once',
    raced.calls.filter(c => c.path.startsWith('/contents/' + Store.STATE_PATH)).length >= 2);
  // And if the other run already proved a later anchor, this run is stale and
  // must not clobber it with an older view.
  const ahead = State.advance(GENESIS, run({ anchor_ledger: 300,
    wallets: run().wallets.map(w => ({ ...w, last_proven_ledger: 300 })) }));
  const stale = fakeGithub({ files: { [Store.STATE_PATH]: State.serialize(ahead) } });
  check('a run whose anchor is behind the stored state is refused, not merged',
    /RUN_ANCHOR_NOT_AHEAD/.test(await refused(() => Store.commitRun(run(), { env: ENV, gh: stale.gh }))));
  check('and that refusal writes nothing', stale.calls.filter(c => c.method === 'PATCH').length === 0);

  console.log('\n6. genesis happens exactly once');
  const fresh = fakeGithub({ files: {} });
  const seeded = await Store.seedGenesis({ coverage: COVERAGE, anchor_ledger: 100 }, { env: ENV, gh: fresh.gh });
  check('an empty branch is seeded', seeded.status === 'SEEDED' && seeded.wallets === 3);
  check('with the checkpoints Neon already proved, not from zero',
    JSON.parse(fresh.files().get(Store.STATE_PATH)).wallets.every(w => w.last_proven_ledger === 100));
  const again = await Store.seedGenesis({ coverage: COVERAGE, anchor_ledger: 100 }, { env: ENV, gh: fresh.gh });
  check('re-seeding is refused rather than resetting the chain', again.status === 'ALREADY_SEEDED');
  check('and it does not move the branch', fresh.calls.filter(c => c.method === 'PATCH').length === 1);
  const unseeded = fakeGithub({ files: {} });
  check('committing a run before genesis is refused',
    /EVIDENCE_STATE_MISSING/.test(await refused(() => Store.commitRun(run(), { env: ENV, gh: unseeded.gh }))));

  console.log('\n' + (fail ? fail + ' FAILED of ' + (pass + fail) : 'ALL ' + pass + ' GITHUB EVIDENCE STORE CHECKS PASS'));
  process.exit(fail ? 1 : 0);
}
main().then(undefined, e => { console.error(e); process.exit(1); });
