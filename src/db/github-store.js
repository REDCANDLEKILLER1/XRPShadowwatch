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
const Journal = require('./run-journal');

const STATE_PATH = 'evidence/state/latest.json';
// The resume journal's own subtree. Quarantined on purpose: readDays() reads
// evidence/YYYY/MM/DD and never looks here, so journalled rows can never reach
// report assembly without first passing the whole-run gate and being written
// into the evidence days properly.
const JOURNAL_PATH = 'evidence/runs/resume/latest.json';
const JOURNAL_PREFIX = 'evidence/runs/resume/';
// ── WHY THE CONTENT HASH IS IN THE PATH ────────────────────────────────────
//
// It used to be report id plus segment number, and the segment number came from
// the run's OWN in-memory copy of the journal. Two runs against the same
// journal therefore both believed they were writing segment 17, and both wrote
// it to the same path. The second overwrote the first.
//
// That happened. In one afternoon: segment 17 written three times by two runs
// with 408, 399 and 367 wallets, one of them then discarding a journal the
// other was still appending to, and a surviving manifest left referencing
// fifteen shards that no longer existed. Forty-two thousand rows of walked
// evidence, unrecoverable.
//
// A path that includes the content's own hash cannot collide unless the content
// is identical, in which case the collision is harmless.
// CONTENT-ADDRESSED, with no segment number in it at all. The segment number
// was the collision: it came from each run's own copy of the journal, so two
// runs both wrote "segment 17" to one path and the second overwrote the first.
// A path that is only the run and the content's hash cannot collide unless the
// content is identical — and identical content is the same shard, which the
// manifest then records once rather than twice.
const journalRowPath = (reportId, digest) =>
  'evidence/runs/resume/' + String(reportId) + '-' + String(digest).slice(0, 16) + '.ndjson.gz';
const historyPath = version => 'evidence/state/history/' + String(version).padStart(8, '0') + '.json';
const runPath = reportId => 'evidence/runs/' + String(reportId) + '.json';

// The EVIDENCE repository, not the application repo. Daily shards and the
// checkpoint live in their own private store so the code repo's history stays
// small and the two can carry different access.
function target(env) { return A.evidenceTarget(env || process.env); }

// Read one file from the branch at a given ref. Returns null for 404 — an
// absent state is a real answer (nothing has been committed yet), not an error.
// ── READING A FILE THAT MIGHT BE BIG ───────────────────────────────────────
//
// The contents API returns file bytes only up to 1 MB. Past that it answers
// with the metadata and an EMPTY body — no error, no 404, just nothing where
// the content should be. Decoding that gives an empty buffer, which then fails
// whatever check was applied to it.
//
// That is exactly how a resume broke: a journal segment holding several
// thousand transactions gzipped past a megabyte, came back empty, and failed
// its own hash. The hash check was right; the read was wrong.
//
// So a short read falls through to the git blobs API, which carries the same
// bytes up to 100 MB. The metadata response already names the blob, so this
// costs one extra request only on the files that need it.
async function readBytes(gh, branch, path, ref) {
  const at = ref ? '?ref=' + encodeURIComponent(ref) : '?ref=' + encodeURIComponent(branch);
  const file = await gh('GET', '/contents/' + path + at, undefined, true);
  if (!file) return null;
  // An explicit non-base64 encoding is GitHub saying "the bytes are not here"
  // (it answers `encoding: "none"` past its size limit). An ABSENT encoding is
  // not that claim, and treating it as one would have quietly broken every
  // caller that worked before.
  let bytes = (file.encoding && file.encoding !== 'base64')
    ? Buffer.alloc(0) : Buffer.from(file.content || '', 'base64');
  const expected = Number(file.size);
  if (Number.isFinite(expected) && bytes.length !== expected) {
    if (!file.sha) throw new Error('GITHUB_CONTENT_TRUNCATED: ' + path);
    const blob = await gh('GET', '/git/blobs/' + file.sha);
    bytes = Buffer.from(blob.content || '', (blob.encoding === 'base64') ? 'base64' : 'utf8');
    // If it STILL does not match, the file is not what the index says it is,
    // and guessing which of the two is right is not this function's business.
    if (bytes.length !== expected) throw new Error('GITHUB_CONTENT_TRUNCATED: ' + path +
      ' (' + bytes.length + ' of ' + expected + ' bytes)');
  }
  return bytes;
}

async function readFile(gh, branch, path, ref) {
  const bytes = await readBytes(gh, branch, path, ref);
  return bytes === null ? null : bytes.toString('utf8');
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

// ── THE RESUME JOURNAL ─────────────────────────────────────────────────────
//
// Read at the start of a run, appended as the run goes, and deleted by the
// commit that lands the evidence. It proves nothing; it only stops the next
// attempt paying XRPL a second time for rows it already has.
async function readJournal(deps) {
  const d = deps || {};
  const { token, repo, branch } = target(d.env);
  const gh = d.gh || A.client(token, repo, d.fetch || fetch);
  const text = await readFile(gh, branch, JOURNAL_PATH);
  if (text === null) return { journal: null, missing: true, branch };
  let journal;
  // A journal that is not readable is not a crisis — it is work we will redo.
  // Failing the run over it would turn a lost optimisation into a lost morning.
  try { journal = JSON.parse(text); }
  catch (_) { return { journal: null, missing: false, unreadable: true, branch }; }
  return { journal, missing: false, branch };
}

// Read back the rows a journal owns. Every file is checked against the hash the
// journal recorded, so a resumed run works from the bytes it wrote and not from
// whatever happens to be at that path now.
async function readJournalRows(journal, deps) {
  const d = deps || {};
  const { token, repo, branch } = target(d.env);
  const gh = d.gh || A.client(token, repo, d.fetch || fetch);
  const zlib = require('zlib');
  const rows = [];
  for (const shard of ((journal && journal.row_shards) || [])) {
    const packed = await readBytes(gh, branch, shard.path);
    if (packed === null) throw new Error('JOURNAL_SHARD_MISSING: ' + shard.path);
    if (Journal.sha256(packed) !== shard.sha256) throw new Error('JOURNAL_SHARD_HASH_MISMATCH: ' + shard.path);
    const text = zlib.gunzipSync(packed).toString('utf8');
    for (const line of text.split('\n')) { if (line) rows.push(JSON.parse(line)); }
  }
  return rows;
}

// Append one segment: the finished wallets and the gzipped rows behind them,
// in ONE commit. This is the only place the store writes without the whole-run
// gate, and it is allowed to because nothing it writes is a claim.
// Appends are OPTIMISTIC. The manifest is re-read inside the attempt and this
// segment is applied to whatever is actually on the branch, not to the copy
// this run started with. Without that, two runs each append to their own stale
// view and one of them is silently lost — or worse, believes it holds evidence
// the other has since removed.
async function appendJournal(journal, segment, deps) {
  const d = deps || {};
  const { token, repo, branch } = target(d.env);
  const gh = d.gh || A.client(token, repo, d.fetch || fetch);
  const zlib = require('zlib');
  const packed = zlib.gzipSync(Buffer.from(
    (segment.rows || []).map(r => JSON.stringify(r)).join('\n') + ((segment.rows || []).length ? '\n' : ''),
    'utf8'), { level: 9 });
  const digest = Journal.sha256(packed);

  let lastRefusal = null;
  for (let attempt = 0; attempt < 4; attempt++) {
    const ref = await A.archiveRef(gh, branch);
    const text = await readFile(gh, branch, JOURNAL_PATH, ref.object.sha);
    // Apply to what is THERE. An absent manifest means someone discarded the
    // journal underneath this run — and a discard deletes the ROW FILES, not
    // just the manifest naming them.
    //
    // This used to re-establish from the run's in-memory copy, on the reasoning
    // that our copy was the only surviving record of the work. It was not. A
    // manifest is a set of POINTERS; once the blobs are gone the pointers name
    // nothing, and the re-established journal claimed nineteen shards of which
    // four still existed. Every run afterwards read shard 0001, got a 404, and
    // refused with JOURNAL_ROWS_UNREADABLE — a wedge no run could clear,
    // because the discard meant to clear it tripped over the same dead paths.
    //
    // So a discarded journal is GONE. This run re-establishes an empty one and
    // contributes this segment to it. The wallets walked before the discard are
    // re-walked tomorrow, which is one morning of work — the cost this file has
    // always been willing to pay, and the one the alternative disguised as a
    // saving while making the store unusable.
    let base = journal;
    if (text === null) {
      base = Journal.begin({
        report_id: journal.report_id, scan_id: journal.scan_id,
        started_at: journal.started_at,
        from_state_version: journal.from_state_version,
        from_state_sha256: journal.from_state_sha256,
        anchor_ledger: journal.anchor_ledger, anchor_close: journal.anchor_close,
        cold_from_ledger: journal.cold_from_ledger,
        admitted_wallets: journal.admitted_wallets || []
      });
    }
    if (text !== null) {
      let onDisk = null;
      try { onDisk = JSON.parse(text); } catch (_) { onDisk = null; }
      if (onDisk && onDisk.report_id === journal.report_id) base = onDisk;
      else if (onDisk) {
        // A different run owns the resume slot. Appending to it would mix two
        // runs' evidence under one anchor, which is not a thing to repair
        // later — so this run keeps its work in memory and says so.
        const e = new Error('JOURNAL_OWNED_BY_ANOTHER_RUN: ' + onDisk.report_id);
        e.journalConflict = true;
        throw e;
      }
    }

    // Wallets this segment carries that the base already has were recorded by
    // someone else; recording them again is refused by record(), so they are
    // dropped rather than duplicated.
    const already = Journal.doneAddresses(base);
    const fresh = (segment.wallets || []).filter(w => !already.has(w.address));
    const path = journalRowPath(base.report_id, digest);
    const shards = (segment.rows || []).length
      ? [{ path, sha256: digest, rows: segment.rows.length }] : [];
    const next = Journal.record(base, { wallets: fresh, row_shards: shards });

    const files = { [JOURNAL_PATH]: Journal.serialize(next) };
    if (shards.length) files[path] = packed;
    try {
      const written = await A.commitFiles(gh, branch, ref.object.sha, files,
        'journal: ' + next.report_id + ' segment ' + next.segments + ' — ' +
        next.wallet_count + ' wallets walked — anchor ' + next.anchor_ledger);
      return { journal: next, commit_sha: written.commit_sha };
    } catch (e) {
      if (!e.refConflict || attempt === 3) throw e;
      lastRefusal = e;
    }
  }
  throw lastRefusal || new Error('JOURNAL_APPEND_RETRY_EXHAUSTED');
}

// What the branch ACTUALLY holds under a prefix, at a given commit. Used to
// tell a path that exists from a path only a manifest remembers.
async function listUnder(gh, commitSha, prefix) {
  const commit = await gh('GET', '/git/commits/' + commitSha);
  const tree = await gh('GET', '/git/trees/' + commit.tree.sha + '?recursive=1');
  const out = new Set();
  for (const e of ((tree && tree.tree) || [])) {
    if (e && e.type === 'blob' && String(e.path).startsWith(prefix)) out.add(e.path);
  }
  return out;
}

// Which of a journal's row shards are no longer on the branch.
//
// A journal is a set of pointers, and pointers outlive what they point at. The
// manifest is small and is read at the start of every run; its blobs are not
// read until commit time, which is minutes later and — until this check existed
// — the first moment anyone noticed they were gone. By then the run had walked
// nothing, because the manifest said those wallets were already done.
//
// One tree read at adoption time turns that from a run that proves nothing into
// a run that walks for real.
async function missingJournalShards(journal, deps) {
  const d = deps || {};
  const shards = (journal && journal.row_shards) || [];
  if (!shards.length) return [];
  const { token, repo, branch } = target(d.env);
  const gh = d.gh || A.client(token, repo, d.fetch || fetch);
  const ref = await A.archiveRef(gh, branch);
  const present = await listUnder(gh, ref.object.sha, JOURNAL_PREFIX);
  return shards.map(sh => sh.path).filter(p => !present.has(p));
}

// Remove a journal and everything it owns, without touching anything else.
// Used when a journal is refused: leaving it would offer the same refusal to
// every run after this one.
// Discards only what the manifest ON THE BRANCH names, read at the moment of
// deletion — never a copy this run has been holding. A stale copy named fifteen
// shards that a later run had already replaced, and deleting by it destroyed
// work that was still being written.
//
// And only if the branch still holds the journal being discarded. If another
// run has since started its own, that one is not ours to delete.
async function clearJournal(journal, deps) {
  const d = deps || {};
  const { token, repo, branch } = target(d.env);
  const gh = d.gh || A.client(token, repo, d.fetch || fetch);
  const ref = await A.archiveRef(gh, branch);
  const text = await readFile(gh, branch, JOURNAL_PATH, ref.object.sha);
  if (text === null) return { status: 'ALREADY_GONE', files_removed: 0 };
  let onDisk = null;
  try { onDisk = JSON.parse(text); } catch (_) { onDisk = null; }
  if (onDisk && journal && journal.report_id && onDisk.report_id !== journal.report_id) {
    return { status: 'NOT_OURS_TO_DISCARD', held_by: onDisk.report_id, files_removed: 0 };
  }
  // ── DELETE ONLY WHAT IS ACTUALLY THERE ──────────────────────────────────
  //
  // A manifest can outlive the blobs it names — that is precisely the state
  // this discard exists to clean up. Handing the tree API a deletion for a path
  // that is no longer in the tree makes the whole commit depend on how it
  // chooses to answer that, and a discard that cannot run is a journal no run
  // can ever clear. So the branch is listed first and the deletion is the
  // intersection: every owned path that still exists, and nothing else.
  const present = await listUnder(gh, ref.object.sha, JOURNAL_PREFIX);
  const owned = Journal.ownedPaths(onDisk, JOURNAL_PATH);
  const files = {};
  for (const p of owned) if (present.has(p)) files[p] = null;
  const missing = owned.filter(p => !present.has(p));
  if (!Object.keys(files).length) {
    return { status: 'ALREADY_GONE', files_removed: 0, missing_paths: missing.length };
  }
  const written = await A.commitFiles(gh, branch, ref.object.sha, files,
    'journal: discard ' + ((onDisk && onDisk.report_id) || 'unreadable') + ' — not resumable');
  return { status: 'DISCARDED', commit_sha: written.commit_sha,
    files_removed: written.files_removed, missing_paths: missing.length };
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
      // The roster change this run carried, named in the run's own manifest so
      // a wallet's first morning is findable without diffing two state files.
      admitted_wallets: state.sealed_run.admitted_wallets || [],
      state_version: state.state_version, state_sha256: state.state_sha256,
      evidence_shards: state.evidence_shards, sealed_at: state.sealed_run.sealed_at
    }, null, 2) + '\n';

    // The journal dies with the commit that makes it redundant — same tree,
    // same ref update. A second call to clean it up is a call that can fail
    // after the evidence has landed, leaving a stale journal for the next run
    // to refuse.
    //
    // Removed by what the BRANCH says it owns, read in this same attempt, not
    // by the copy this run has been carrying. A stale copy names shards that a
    // later append has already superseded, and deleting by it takes out files
    // another run is still relying on.
    if (run.journal) {
      const journalText = await readFile(gh, branch, JOURNAL_PATH, ref.object.sha);
      let onDisk = null;
      if (journalText !== null) { try { onDisk = JSON.parse(journalText); } catch (_) { onDisk = null; } }
      // Only ours. If another run has taken the resume slot since, its journal
      // is not this commit's to remove.
      if (!onDisk || onDisk.report_id === run.journal.report_id) {
        // Only paths the branch actually holds, for the same reason the
        // discard does it: a manifest can name a blob that is already gone,
        // and asking to delete it puts THIS commit — the one carrying the
        // whole day's evidence — at the mercy of how the tree API answers a
        // deletion for a path that is not there.
        const present = await listUnder(gh, ref.object.sha, JOURNAL_PREFIX);
        for (const p of Journal.ownedPaths(onDisk || run.journal, JOURNAL_PATH)) {
          if (present.has(p)) files[p] = null;
        }
      }
    }

    try {
      const written = await A.commitFiles(gh, branch, ref.object.sha, files,
        'evidence: ' + run.report_id + ' — state v' + state.state_version +
        ' — ' + state.sealed_run.complete_wallets + '/' + state.sealed_run.target_wallets +
        ' — anchor ' + state.anchor_ledger, d.onBlob);
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

// ── Reading back the evidence we already own ───────────────────────────────
//
// ACQUISITION never calls this: the walk needs the checkpoint and nothing else.
// REPORT ASSEMBLY does, and only for the days the window actually touches —
// one or two files, not the archive. A second run on the same day needs the
// morning's transactions, and they are already committed; re-fetching them from
// XRPL would be paying twice for evidence we own.
//
// A day with no shard is not an error. It means nothing was committed for that
// day, which for a day inside a proven window means nothing happened.
async function readDays(days, deps, kind) {
  const d = deps || {};
  const { token, repo, branch } = target(d.env);
  const gh = d.gh || A.client(token, repo, d.fetch || fetch);
  const zlib = require('zlib');
  // 'events' by default; 'participants' reads the provenance shards alongside
  // them. The participants file is what records WHICH watched wallet's walk saw
  // a transaction, and the report attributes every movement by that — without
  // it every row comes back unattributed.
  // Three kinds share this reader because they share a layout. 'payloads' was
  // missing, which meant the commit could not read back what a day already held
  // and so could only overwrite it.
  const name = kind === 'participants' ? 'participants'
    : kind === 'payloads' ? 'payloads' : 'events';
  const out = { events: [], files: [], missing: [] };
  for (const day of (days || [])) {
    const base = 'evidence/' + String(day).replace(/-/g, '/');
    // Shards are numbered only when a day had to be split, so try the plain
    // name first and then the numbered series until one is absent.
    const candidates = ['/' + name + '.ndjson.gz'];
    for (let i = 1; i <= 999; i++) candidates.push('/' + name + '.' + String(i).padStart(3, '0') + '.ndjson.gz');
    let found = 0;
    for (const suffix of candidates) {
      const path = base + suffix;
      // Day shards are routinely larger than a megabyte — a busy day can hold
      // tens of thousands of events — so they go through the same path.
      const packed = await readBytes(gh, branch, path);
      if (packed === null) { if (suffix === '/' + name + '.ndjson.gz') continue; break; }
      const text = zlib.gunzipSync(packed).toString('utf8');
      for (const line of text.split('\n')) { if (line) out.events.push(JSON.parse(line)); }
      out.files.push(path); found++;
    }
    if (!found) out.missing.push(day);
  }
  return out;
}

module.exports = { STATE_PATH, JOURNAL_PATH, historyPath, runPath, journalRowPath, readBytes, readFile,
  readState, commitRun, seedGenesis, readDays,
  readJournal, readJournalRows, appendJournal, clearJournal, missingJournalShards };
