// XRPMAN Shadow Watch — the GitHub-backed evidence store.
//
// Server-side only. Uses the same pinned repository, branch and token as the
// sealed-report archive, and the same fast-forward commit path. The token
// never reaches browser JS.
//
// ── ONE COMMIT PER RUN, NEVER ONE PER WALLET ───────────────────────────────
//
// A per-wallet commit would mean 255 ref updates, 255 chances to be
// interrupted, and — worse — a half-advanced checkpoint. Wallet 120 would be
// proven through today while wallet 121 was still on yesterday, with no single
// state describing what the system actually knows.
//
// So a run accumulates in memory and lands as ONE commit: the new delta
// shards, the run manifest, the state history entry, and the updated
// latest.json, all in one tree, under one ref update. Either all of it is
// there or none of it is.
//
// A run that dies therefore advances nothing. The next run reads the same
// checkpoint and walks the same bounded edge again — which costs one
// account_tx per wallet and is exactly the behaviour we want from a failure.
//
// ── WHAT THE RUNTIME READS ─────────────────────────────────────────────────
//
// One file. `evidence/state/latest.json` is a few hundred kB for 255 wallets,
// and nothing else is fetched during normal acquisition. The historical shards
// are archive, not working set: they exist to be audited, exported and
// re-analysed, never to be loaded every morning.
'use strict';

const A = require('./github-archive');
const State = require('./evidence-state');

const STATE_PATH = 'evidence/state/latest.json';
const historyPath = version => 'evidence/state/history/' + String(version).padStart(8, '0') + '.json';
const runPath = reportId => 'evidence/runs/' + String(reportId) + '.json';

function target(env) { return A.archiveTarget(env || process.env); }

// Read one file from the branch at a given ref. Returns null for 404 — an
// absent state is a real answer (nothing has been committed yet), not an error.
async function readFile(gh, branch, path, ref) {
  const at = ref ? '?ref=' + encodeURIComponent(ref) : '?ref=' + encodeURIComponent(branch);
  const file = await gh('GET', '/contents/' + path + at, undefined, true);
  if (!file) return null;
  return Buffer.from(file.content || '', 'base64').toString('utf8');
}

// THE RUNTIME READ. One request, one file, verified before it is believed.
//
// A state that does not hash to its own digest is refused rather than used:
// the whole point of moving the checkpoint into a file people can edit is that
// an edit must be caught here, before it decides what the next run fetches.
async function readState(deps) {
  const d = deps || {};
  const { token, repo, branch } = target(d.env);
  const gh = d.gh || A.client(token, repo, d.fetch || fetch);
  const text = await readFile(gh, branch, STATE_PATH);
  if (text === null) return { state: null, missing: true, branch };
  let state;
  try { state = JSON.parse(text); }
  catch (_) { throw new Error('EVIDENCE_STATE_UNREADABLE: ' + STATE_PATH + ' is not JSON'); }
  const verdict = State.verify(state);
  if (!verdict.ok) throw new Error('EVIDENCE_STATE_UNVERIFIED: ' + verdict.problems.join(','));
  return { state, missing: false, branch };
}

// THE RUN COMMIT. `run` is the completed acquisition; `files` are the delta
// shards it produced, as { path: Buffer|string }.
//
// advance() is called INSIDE the retry loop, against the state as it stands at
// that moment. That is deliberate: if another run committed while this one was
// walking, re-advancing against the newer state makes this run's anchor no
// longer ahead, and advance() refuses rather than overwriting someone else's
// checkpoint with an older view.
async function commitRun(input, deps) {
  const d = deps || {};
  const { token, repo, branch } = target(d.env);
  const gh = d.gh || A.client(token, repo, d.fetch || fetch);
  const run = input || {};
  if (!run.report_id) throw new Error('RUN_REPORT_ID_REQUIRED');
  const shards = run.files || {};
  for (const path of Object.keys(shards)) {
    // Everything this writes lives under evidence/. The sealed-report archive
    // under reports/ is a different subtree with a different lifecycle, and
    // this path must never be able to touch it.
    if (!path.startsWith('evidence/')) throw new Error('SHARD_PATH_OUTSIDE_EVIDENCE: ' + path);
  }

  let lastRefusal = null;
  for (let attempt = 0; attempt < 4; attempt++) {
    const ref = await A.archiveRef(gh, branch);
    const text = await readFile(gh, branch, STATE_PATH, ref.object.sha);
    const prior = text === null ? null : JSON.parse(text);
    if (!prior) throw new Error('EVIDENCE_STATE_MISSING: seed genesis before committing a run');

    // The gate. Refuses an incomplete run, a contradicted run, a backwards
    // checkpoint, a checkpoint past the anchor, an unhashed shard, or a stale
    // anchor. Nothing is written if this throws.
    const state = State.advance(prior, run);

    const files = Object.assign({}, shards);
    files[STATE_PATH] = State.serialize(state);
    // An immutable copy per version, so the chain can be walked without
    // reading git history, and a rewritten latest.json disagrees with it.
    files[historyPath(state.state_version)] = State.serialize(state);
    files[runPath(run.report_id)] = JSON.stringify({
      report_id: run.report_id, scan_id: run.scan_id || null,
      anchor_ledger: state.anchor_ledger, anchor_close: state.anchor_close,
      target_wallets: state.sealed_run.target_wallets,
      complete_wallets: state.sealed_run.complete_wallets,
      balance_contradictions: 0,
      state_version: state.state_version, state_sha256: state.state_sha256,
      evidence_shards: state.evidence_shards, sealed_at: state.sealed_run.sealed_at
    }, null, 2) + '\n';

    try {
      const written = await A.commitFiles(gh, branch, ref.object.sha, files,
        'evidence: ' + run.report_id + ' — state v' + state.state_version +
        ' — ' + state.sealed_run.complete_wallets + '/' + state.sealed_run.target_wallets +
        ' — anchor ' + state.anchor_ledger);
      return { status: 'COMMITTED', branch, commit_sha: written.commit_sha,
        state_version: state.state_version, state_sha256: state.state_sha256,
        files_written: written.files_written, bytes_written: written.bytes_written, retry_count: attempt };
    } catch (e) {
      if (!e.refConflict || attempt === 3) throw e;
      lastRefusal = e;
    }
  }
  throw lastRefusal || new Error('EVIDENCE_STATE_COMMIT_RETRY_EXHAUSTED');
}

// Seed the chain once, from the exported coverage snapshot, so the first
// GitHub-backed run starts from what Neon already proved rather than cold.
// Refuses to overwrite an existing chain: genesis happens exactly once.
async function seedGenesis(input, deps) {
  const d = deps || {};
  const { token, repo, branch } = target(d.env);
  const gh = d.gh || A.client(token, repo, d.fetch || fetch);
  const ref = await A.archiveRef(gh, branch);
  const existing = await readFile(gh, branch, STATE_PATH, ref.object.sha);
  if (existing !== null) {
    const current = JSON.parse(existing);
    return { status: 'ALREADY_SEEDED', branch, state_version: current.state_version,
      state_sha256: current.state_sha256 };
  }
  const state = State.genesis(input.coverage, {
    anchor_ledger: input.anchor_ledger, anchor_close: input.anchor_close,
    sealed_run: input.sealed_run || null, evidence_shards: input.evidence_shards || []
  });
  const files = {
    [STATE_PATH]: State.serialize(state),
    [historyPath(state.state_version)]: State.serialize(state)
  };
  const written = await A.commitFiles(gh, branch, ref.object.sha, files,
    'evidence: genesis state — ' + state.wallet_count + ' wallets — anchor ' + state.anchor_ledger);
  return { status: 'SEEDED', branch, commit_sha: written.commit_sha,
    state_version: state.state_version, state_sha256: state.state_sha256, wallets: state.wallet_count };
}

module.exports = { STATE_PATH, historyPath, runPath, readState, commitRun, seedGenesis };
