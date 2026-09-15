// XRPMAN Shadow Watch — the canonical checkpoint state, and the rules that
// keep it honest once it lives in a git repository instead of Postgres.
//
// Pure: no database, no filesystem, no network.
//
// ── WHAT MOVING THE CHECKPOINT OUT OF POSTGRES COSTS ───────────────────────
//
// wallet_coverage_monotonic() is a BEFORE UPDATE trigger. It makes it
// STRUCTURALLY impossible for a proven checkpoint to move backwards or be
// cleared — not by convention, not by careful application code, but because
// the database refuses the write. A JSON file in a branch has no such trigger.
// Anyone with push access can open it in an editor and advance
// last_proven_ledger by hand, and the next run would believe it and skip
// ledgers nobody read. That is not a storage detail; it is the difference
// between a forensic record and a number in a file.
//
// So the state has to be VERIFIABLE, not merely readable:
//
//   1. It is HASH-CHAINED. Each state names the sha256 of the state it
//      replaced, so history is a chain and an edit breaks every link after it.
//   2. It is MONOTONIC BY RULE, checked here rather than hoped for: advance()
//      refuses any transition that moves a checkpoint backwards, skips a
//      version, or reuses an anchor.
//   3. It is ACCOMPANIED. A state advance is only valid alongside the evidence
//      shards committed with it, named and hashed, so a checkpoint can never
//      claim proof that no file backs.
//   4. It ADVANCES ONLY ON A WHOLE RUN. Not per wallet — 255/255 proved, zero
//      balance contradictions, or the state does not move at all. A run that
//      dies leaves the checkpoint exactly where it was and the next run repeats
//      the same bounded edge, which is cheap and correct.
//
// None of that is as strong as a database trigger: a determined editor with
// push access can rewrite the whole chain. What it does is make tampering
// VISIBLE rather than silent, and make an accident impossible.
'use strict';

const crypto = require('crypto');

const SCHEMA = 'shadowwatch-evidence-state/1';
const sha256 = value => crypto.createHash('sha256')
  .update(Buffer.isBuffer(value) ? value : Buffer.from(String(value), 'utf8')).digest('hex');

function _int(v) {
  if (v === null || v === undefined) return null;
  const n = Number(v);
  return Number.isInteger(n) && n > 0 ? n : null;
}
function _drops(v) {
  if (v === null || v === undefined) return null;
  const s = String(v).trim();
  return /^[0-9]+$/.test(s) ? s : null;
}
function _s(v) { return (v === null || v === undefined || v === '') ? null : String(v); }

// One wallet's line in the state. Deliberately small: this file is read at the
// start of every run, and nothing here is evidence — it is a pointer INTO the
// evidence, plus the balance needed to cross-check the next delta.
function walletEntry(input) {
  const w = input || {};
  return {
    address: _s(w.address),
    // The checkpoint. The next run walks last_proven_ledger+1 -> anchor.
    last_proven_ledger: _int(w.last_proven_ledger),
    last_proven_close: _s(w.last_proven_close),
    // The most recent transaction actually seen. Not a checkpoint and never
    // used as one — a quiet wallet has none — but it is the audit anchor that
    // makes "the marker moved" checkable by a human reading the file.
    last_observed_tx_ledger: _int(w.last_observed_tx_ledger),
    last_observed_tx_hash: _s(w.last_observed_tx_hash),
    // Pinned to last_proven_ledger, so the next run's reconciliation has both
    // endpoints of an exact identity rather than two unrelated readings.
    balance_drops: _drops(w.balance_drops),
    balance_ledger: _int(w.balance_ledger),
    reconciliation: _s(w.reconciliation) || 'NOT_APPLICABLE',
    // The two facts that make a roster addition honest. admitted_at_ledger is
    // the anchor of the run that let this wallet in; history_from_ledger is the
    // EARLIEST ledger any run has ever read for it. Everything before that
    // horizon is unread, and the report may not speak about it.
    //
    // Both are null on the 255 wallets seeded from the Neon proof: their
    // horizon predates this store and is not knowable from here. Null means
    // UNKNOWN, never "from the beginning".
    admitted_at_ledger: _int(w.admitted_at_ledger),
    history_from_ledger: _int(w.history_from_ledger)
  };
}

// The canonical serialization. Key order is fixed and the wallet list is
// sorted, so the same state always hashes the same way regardless of how it
// was assembled.
function canonical(state) {
  const s = state || {};
  return {
    schema: SCHEMA,
    state_version: s.state_version,
    previous_state_sha256: s.previous_state_sha256 || null,
    anchor_ledger: s.anchor_ledger,
    anchor_close: s.anchor_close || null,
    sealed_run: s.sealed_run || null,
    wallet_count: (s.wallets || []).length,
    wallets: (s.wallets || []).slice().sort((a, b) =>
      String(a.address) < String(b.address) ? -1 : (String(a.address) > String(b.address) ? 1 : 0)),
    evidence_shards: (s.evidence_shards || []).slice().sort((a, b) =>
      String(a.path) < String(b.path) ? -1 : (String(a.path) > String(b.path) ? 1 : 0))
  };
}
function digest(state) { return sha256(JSON.stringify(canonical(state))); }
function seal(state) {
  const body = canonical(state);
  return { ...body, state_sha256: digest(body) };
}
function serialize(state) { return JSON.stringify(seal(state), null, 2) + '\n'; }

// The genesis state: every wallet known, nothing proven. Produced once from the
// exported coverage snapshot so the first GitHub-backed run starts from what
// Neon already proved rather than cold.
function genesis(coverage, options) {
  const opts = options || {};
  return seal({
    state_version: 1,
    previous_state_sha256: null,
    anchor_ledger: _int(opts.anchor_ledger),
    anchor_close: _s(opts.anchor_close),
    sealed_run: opts.sealed_run || null,
    wallets: (coverage || []).map(row => walletEntry({
      address: row.address,
      last_proven_ledger: row.scan_coverage_through,
      last_proven_close: row.scan_coverage_through_close,
      last_observed_tx_ledger: row.last_observed_tx_ledger,
      balance_drops: row.balance_drops,
      balance_ledger: row.balance_ledger,
      reconciliation: 'NOT_APPLICABLE'
    })),
    evidence_shards: opts.evidence_shards || []
  });
}

// ── The transition, and everything it refuses ─────────────────────────────
//
// `run` describes one completed acquisition. The state moves only if the whole
// run earned it; there is no partial advance, because a partial advance is
// exactly how a checkpoint gets ahead of the evidence behind it.
function advance(prior, run) {
  const r = run || {};
  const reject = reason => { const e = new Error(reason); e.stateRefused = true; throw e; };

  if (!prior || !prior.state_sha256) reject('STATE_MISSING: nothing to advance from');
  if (digest(prior) !== prior.state_sha256) reject('STATE_DIGEST_MISMATCH: the prior state does not hash to its own recorded digest');

  const anchor = _int(r.anchor_ledger);
  if (anchor === null) reject('RUN_ANCHOR_MISSING');
  // Anchors come from validated ledgers and only move forward. Reusing or
  // rewinding one would let a run re-prove a window it already claimed.
  if (_int(prior.anchor_ledger) !== null && anchor <= _int(prior.anchor_ledger)) {
    reject('RUN_ANCHOR_NOT_AHEAD: ' + anchor + ' does not advance past ' + prior.anchor_ledger);
  }

  // THE WHOLE-RUN GATE. Anything less and the checkpoint does not move.
  const target = Number(r.target_wallets), complete = Number(r.complete_wallets);
  if (!Number.isInteger(target) || target <= 0) reject('RUN_TARGET_UNKNOWN');
  if (complete !== target) reject('RUN_INCOMPLETE: ' + complete + ' of ' + target + ' wallets proved');
  const contradictions = Number(r.balance_contradictions || 0);
  if (contradictions > 0) {
    reject('RUN_CONTRADICTED: ' + contradictions + ' wallet(s) moved balance the evidence cannot explain');
  }

  // A checkpoint may not claim proof that no committed file backs.
  const shards = Array.isArray(r.evidence_shards) ? r.evidence_shards : null;
  if (!shards) reject('RUN_SHARDS_MISSING: a state advance must name the evidence committed with it');
  for (const shard of shards) {
    if (!shard || !_s(shard.path) || !/^[a-f0-9]{64}$/.test(String(shard.sha256 || ''))) {
      reject('RUN_SHARD_UNHASHED: every committed shard must be named and hashed');
    }
  }

  const priorByAddress = new Map((prior.wallets || []).map(w => [w.address, w]));
  // Wallets this run declares it is ADMITTING to the roster. Growing the
  // watchlist is a decision, so it has to be stated: a wallet that merely turns
  // up among the results without being named here is still refused, exactly as
  // it was before admission existed. What changed is that there is now a door,
  // not that the wall came down.
  const admitting = new Set((r.admitted_wallets || []).map(a => String(a)));
  const incoming = (r.wallets || []).map(walletEntry);
  if (incoming.length !== target) reject('RUN_WALLET_COUNT_MISMATCH: ' + incoming.length + ' entries for ' + target + ' wallets');

  const wallets = [];
  for (const next of incoming) {
    if (!next.address) reject('RUN_WALLET_ADDRESS_MISSING');
    const was = priorByAddress.get(next.address);
    if (!was) {
      if (!admitting.has(next.address)) reject('RUN_WALLET_NOT_IN_STATE: ' + next.address);
      // An admitted wallet enters on exactly the terms every other wallet is
      // held to, and on one more besides: it may not inherit a checkpoint it
      // did not earn. It proved a range in THIS run, bounded by THIS anchor,
      // and it records how far back it actually read — so the file itself says
      // where this wallet's evidence begins and a later reader cannot mistake
      // "watched since Tuesday" for "we have its history".
      if (next.admitted_at_ledger !== anchor) {
        reject('ADMISSION_NOT_AT_ANCHOR: ' + next.address + ' claims admission at ' +
          next.admitted_at_ledger + ' against anchor ' + anchor);
      }
      if (next.history_from_ledger === null) {
        reject('ADMISSION_HORIZON_UNKNOWN: ' + next.address + ' must record how far back it read');
      }
      if (next.history_from_ledger > anchor) {
        reject('ADMISSION_HORIZON_PAST_ANCHOR: ' + next.address + ' claims to have read from ' +
          next.history_from_ledger + ' against anchor ' + anchor);
      }
      if (next.last_proven_ledger !== anchor) {
        reject('ADMISSION_CHECKPOINT_UNEARNED: ' + next.address + ' may be proven only to this run\'s anchor, not ' +
          next.last_proven_ledger);
      }
    } else {
      // The other direction: an addition must never rewrite what is already
      // known. A wallet in the state has an admission and a horizon that are
      // facts about the past; a run carries them forward and may not restate
      // them, so "re-admitting" an existing wallet cannot be used to move its
      // horizon and quietly widen what the report may claim.
      if (admitting.has(next.address)) reject('WALLET_ALREADY_IN_STATE: ' + next.address);
      if (next.admitted_at_ledger !== _int(was.admitted_at_ledger)) {
        reject('ADMISSION_LEDGER_REWRITTEN: ' + next.address);
      }
      if (_int(was.history_from_ledger) !== null && next.history_from_ledger !== _int(was.history_from_ledger)) {
        reject('HISTORY_HORIZON_REWRITTEN: ' + next.address + ' ' +
          was.history_from_ledger + ' -> ' + next.history_from_ledger);
      }
    }
    if (next.last_proven_ledger === null) reject('RUN_WALLET_UNPROVEN: ' + next.address);
    // The monotonic rule the database used to enforce. Equal is allowed — a
    // repeat run against the same anchor proves nothing new — but never less.
    if (was && was.last_proven_ledger !== null && next.last_proven_ledger < was.last_proven_ledger) {
      reject('CHECKPOINT_WOULD_MOVE_BACKWARDS: ' + next.address + ' ' +
        was.last_proven_ledger + ' -> ' + next.last_proven_ledger);
    }
    // And it may not run past the anchor the run was bounded by, which is the
    // other way a checkpoint gets ahead of what was read.
    if (next.last_proven_ledger > anchor) {
      reject('CHECKPOINT_PAST_ANCHOR: ' + next.address + ' claims ' + next.last_proven_ledger +
        ' against anchor ' + anchor);
    }
    // A balance must be pinned to be comparable. Unpinned it cannot anchor the
    // next run's reconciliation, so it is not carried as if it could.
    if ((next.balance_drops === null) !== (next.balance_ledger === null)) {
      reject('BALANCE_NOT_PINNED: ' + next.address);
    }
    wallets.push(next);
  }
  // Every wallet the state knew about must still be accounted for. Dropping one
  // silently would retire a watched wallet without anyone deciding to.
  for (const address of priorByAddress.keys()) {
    if (!wallets.some(w => w.address === address)) reject('WALLET_DROPPED_FROM_STATE: ' + address);
  }

  return seal({
    state_version: Number(prior.state_version) + 1,
    previous_state_sha256: prior.state_sha256,
    anchor_ledger: anchor,
    anchor_close: _s(r.anchor_close),
    sealed_run: {
      scan_id: _s(r.scan_id),
      report_id: _s(r.report_id),
      target_wallets: target,
      complete_wallets: complete,
      balance_contradictions: 0,
      sealed_at: _s(r.sealed_at),
      // Named in the sealed run, so a roster change is visible in the state
      // that carried it rather than only in the diff of the wallet list.
      admitted_wallets: [...admitting].sort()
    },
    wallets,
    evidence_shards: shards.map(s => ({ path: String(s.path), sha256: String(s.sha256), rows: _int(s.rows) }))
  });
}

// Read-side: is this state internally consistent, and does it follow the one
// before it? Called before a run trusts a checkpoint, so a tampered file is
// caught before it can decide what to fetch.
function verify(state, previous) {
  const problems = [];
  if (!state || state.schema !== SCHEMA) problems.push('SCHEMA_UNKNOWN');
  if (!state || digest(state) !== state.state_sha256) problems.push('DIGEST_MISMATCH');
  if (state && !Number.isInteger(Number(state.state_version))) problems.push('VERSION_INVALID');
  if (state && Array.isArray(state.wallets) && state.wallets.length !== Number(state.wallet_count)) {
    problems.push('WALLET_COUNT_MISMATCH');
  }
  if (previous) {
    if (digest(previous) !== previous.state_sha256) problems.push('PREVIOUS_DIGEST_MISMATCH');
    if (state.previous_state_sha256 !== previous.state_sha256) problems.push('CHAIN_BROKEN');
    if (Number(state.state_version) !== Number(previous.state_version) + 1) problems.push('VERSION_NOT_SEQUENTIAL');
    const was = new Map((previous.wallets || []).map(w => [w.address, w]));
    for (const w of (state.wallets || [])) {
      const before = was.get(w.address);
      if (before && before.last_proven_ledger !== null &&
          Number(w.last_proven_ledger) < Number(before.last_proven_ledger)) {
        problems.push('CHECKPOINT_MOVED_BACKWARDS:' + w.address);
      }
      // A wallet's evidence horizon is a fact about what was read. Moving it
      // earlier would claim history nobody fetched; moving it later would
      // silently disown evidence already committed. Neither is a valid edit.
      if (before && _int(before.history_from_ledger) !== null &&
          _int(w.history_from_ledger) !== _int(before.history_from_ledger)) {
        problems.push('HISTORY_HORIZON_CHANGED:' + w.address);
      }
      if (before && _int(before.admitted_at_ledger) !== _int(w.admitted_at_ledger)) {
        problems.push('ADMISSION_LEDGER_CHANGED:' + w.address);
      }
    }
  }
  return { ok: problems.length === 0, problems };
}

// What the next run asks XRPL for, per wallet. The ONLY input is the
// checkpoint and the anchor: no balance, no heuristic, no skip. A wallet whose
// balance has not moved gets exactly the same walk as one that emptied out,
// because a routing wallet that receives and forwards the same five million XRP
// inside a day looks identical to a quiet one from the balance alone.
function edgeFor(entry, anchorLedger) {
  const anchor = _int(anchorLedger);
  if (anchor === null) throw new Error('ANCHOR_REQUIRED');
  const from = _int(entry && entry.last_proven_ledger);
  return {
    address: entry && entry.address,
    // No checkpoint means a cold bootstrap for that wallet alone; every other
    // wallet still walks only its own delta.
    from_ledger: from === null ? null : from + 1,
    through_ledger: anchor,
    cold: from === null
  };
}

module.exports = { SCHEMA, sha256, walletEntry, canonical, digest, seal, serialize,
  genesis, advance, verify, edgeFor };
