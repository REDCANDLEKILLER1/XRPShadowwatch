// XRPMAN Shadow Watch — the resume journal.
//
// Pure: no database, no filesystem, no network.
//
// ── WHAT THIS IS, AND WHAT IT DELIBERATELY IS NOT ──────────────────────────
//
// The checkpoint is all-or-nothing and stays that way. A run proves its whole
// roster or it proves nothing, because a half-advanced checkpoint would leave
// wallet 120 reading as proven through today while wallet 121 sat on
// yesterday, with no single state describing what the system knows. That rule
// is not negotiable and this file does not touch it.
//
// But "the checkpoint does not move" was doing a second job it was never meant
// to do: it was also throwing away the WORK. A run that died at wallet 240
// discarded 240 wallets of finished walking and started over from one, paying
// XRPL twice for evidence it had already fetched and validated. That is not a
// safety property. That is waste wearing a safety property's clothes.
//
// So the two are separated:
//
//   THE CHECKPOINT   what we have PROVEN        atomic, one commit, all or none
//   THE JOURNAL      work already DONE          appended as it goes, resumable
//
// The journal proves nothing. It advances no coverage floor, it is never read
// by report assembly, and it lives in its own quarantined subtree that
// readDays() does not touch. Its only claim is "these rows were already
// fetched from this anchor" — and every one of them still has to pass the same
// whole-run gate before anything is committed.
//
// ── WHY IT PINS THE ANCHOR ─────────────────────────────────────────────────
//
// A resumed run MUST finish against the anchor the interrupted one pinned. If
// it picked a fresh one, the wallets walked before the disconnect would be
// proven to a different ledger than the wallets walked after it, and the state
// would describe an instant that never existed. So the journal carries the
// anchor and a resuming run adopts it. The window ends slightly earlier than
// "now" — and says so — which is the honest cost of resuming.
//
// ── WHY IT PINS THE CHECKPOINT IT STARTED FROM ─────────────────────────────
//
// If a run committed while this journal was lying around, the journal
// describes a world that no longer exists: its wallets were walked from
// checkpoints that have since moved. Adopting it would re-prove a window
// already claimed. So the journal records the state it began from, and a
// mismatch discards it rather than resuming from it. Discarding costs one
// morning of re-walking. Resuming from a stale journal costs correctness.
'use strict';

const crypto = require('crypto');

const SCHEMA = 'shadowwatch-run-journal/1';
const sha256 = value => crypto.createHash('sha256')
  .update(Buffer.isBuffer(value) ? value : Buffer.from(String(value), 'utf8')).digest('hex');

function _int(v) {
  if (v === null || v === undefined) return null;
  const n = Number(v);
  return Number.isInteger(n) && n > 0 ? n : null;
}
function _s(v) { return (v === null || v === undefined || v === '') ? null : String(v); }

// Key order fixed and lists sorted, so the same journal always hashes the same
// way regardless of the order the wallets happened to finish in.
function canonical(journal) {
  const j = journal || {};
  return {
    schema: SCHEMA,
    report_id: _s(j.report_id),
    scan_id: _s(j.scan_id),
    started_at: _s(j.started_at),
    segments: Number(j.segments) || 0,
    from_state_version: _int(j.from_state_version),
    from_state_sha256: _s(j.from_state_sha256),
    anchor_ledger: _int(j.anchor_ledger),
    anchor_close: _s(j.anchor_close),
    cold_from_ledger: _int(j.cold_from_ledger),
    admitted_wallets: (j.admitted_wallets || []).slice().sort(),
    wallet_count: (j.wallets || []).length,
    wallets: (j.wallets || []).slice().sort((a, b) =>
      String(a.address) < String(b.address) ? -1 : (String(a.address) > String(b.address) ? 1 : 0)),
    row_shards: (j.row_shards || []).slice().sort((a, b) =>
      String(a.path) < String(b.path) ? -1 : (String(a.path) > String(b.path) ? 1 : 0))
  };
}
function digest(journal) { return sha256(JSON.stringify(canonical(journal))); }
function seal(journal) {
  const body = canonical(journal);
  return { ...body, journal_sha256: digest(body) };
}
function serialize(journal) { return JSON.stringify(seal(journal), null, 2) + '\n'; }

// One finished wallet's line. It carries the range actually proven, not a bare
// "done" flag: a resumed run must be able to check that what it inherited was
// walked against the anchor it is now finishing against.
function walletRecord(input) {
  const w = input || {};
  return {
    address: _s(w.address),
    proven_from: _int(w.proven_from),
    proven_through: _int(w.proven_through),
    rows: Number(w.rows) || 0,
    reconciliation: _s(w.reconciliation) || 'NOT_APPLICABLE',
    // The state entry this wallet earned. Kept whole so a resumed run commits
    // exactly what the interrupted one would have, rather than reconstructing
    // it from a summary and hoping the reconstruction matches.
    entry: w.entry || null
  };
}

function begin(input) {
  const i = input || {};
  return seal({
    report_id: i.report_id, scan_id: i.scan_id, started_at: i.started_at,
    segments: 0,
    from_state_version: i.from_state_version,
    from_state_sha256: i.from_state_sha256,
    anchor_ledger: i.anchor_ledger, anchor_close: i.anchor_close,
    cold_from_ledger: i.cold_from_ledger,
    admitted_wallets: i.admitted_wallets || [],
    wallets: [], row_shards: []
  });
}

// Append one segment of finished work. Refuses anything that would let a
// journal disagree with itself.
function record(journal, segment) {
  const j = journal, s = segment || {};
  const reject = reason => { const e = new Error(reason); e.journalRefused = true; throw e; };
  if (!j || !j.journal_sha256) reject('JOURNAL_MISSING');
  if (digest(j) !== j.journal_sha256) reject('JOURNAL_DIGEST_MISMATCH');

  const known = new Set((j.wallets || []).map(w => w.address));
  const added = (s.wallets || []).map(walletRecord);
  for (const w of added) {
    if (!w.address) reject('JOURNAL_WALLET_ADDRESS_MISSING');
    // Recording a wallet twice would double its rows into the run and make the
    // journal's own count disagree with the evidence behind it.
    if (known.has(w.address)) reject('JOURNAL_WALLET_ALREADY_RECORDED: ' + w.address);
    // A wallet may only enter the journal proven to the journal's own anchor.
    // Anything else is a wallet walked against a different instant.
    if (w.proven_through !== _int(j.anchor_ledger)) {
      reject('JOURNAL_WALLET_WRONG_ANCHOR: ' + w.address + ' proven through ' +
        w.proven_through + ' against anchor ' + j.anchor_ledger);
    }
    if (!w.entry || w.entry.address !== w.address) reject('JOURNAL_WALLET_ENTRY_MISSING: ' + w.address);
    known.add(w.address);
  }
  const shards = (s.row_shards || []).map(x => {
    if (!x || !_s(x.path) || !/^[a-f0-9]{64}$/.test(String(x.sha256 || ''))) {
      reject('JOURNAL_SHARD_UNHASHED: every journalled row file must be named and hashed');
    }
    // The journal's rows live in their own subtree. A journal that could name a
    // path under the evidence days would be able to plant rows that report
    // assembly reads without any checkpoint backing them.
    if (!String(x.path).startsWith('evidence/runs/resume/')) {
      reject('JOURNAL_SHARD_OUTSIDE_RESUME: ' + x.path);
    }
    return { path: String(x.path), sha256: String(x.sha256), rows: Number(x.rows) || 0 };
  });

  return seal({
    ...j,
    segments: Number(j.segments || 0) + 1,
    wallets: (j.wallets || []).concat(added),
    row_shards: (j.row_shards || []).concat(shards)
  });
}

// May this journal be resumed from, given the checkpoint as it stands NOW?
//
// Every refusal here costs one morning of re-walking. Every refusal not here
// costs correctness, which is not a trade this project makes.
function usable(journal, state) {
  const problems = [];
  const j = journal, s = state;
  if (!j || j.schema !== SCHEMA) problems.push('SCHEMA_UNKNOWN');
  else {
    if (digest(j) !== j.journal_sha256) problems.push('DIGEST_MISMATCH');
    if (!/^SW-\d{8}-[A-Z0-9]{5}$/.test(String(j.report_id || ''))) problems.push('REPORT_ID_INVALID');
    if (_int(j.anchor_ledger) === null) problems.push('ANCHOR_MISSING');
    if (s) {
      // The checkpoint moved while this journal sat. Its wallets were walked
      // from checkpoints that no longer describe anything.
      if (_s(j.from_state_sha256) !== _s(s.state_sha256)) problems.push('CHECKPOINT_MOVED_SINCE');
      // And the anchor must still be ahead of what is already proven, or
      // finishing this run would re-claim a window already claimed.
      if (_int(s.anchor_ledger) !== null && _int(j.anchor_ledger) <= _int(s.anchor_ledger)) {
        problems.push('ANCHOR_NO_LONGER_AHEAD');
      }
    }
    for (const w of (j.wallets || [])) {
      if (_int(w.proven_through) !== _int(j.anchor_ledger)) {
        problems.push('WALLET_WRONG_ANCHOR:' + w.address);
      }
      if (!w.entry || w.entry.address !== w.address) problems.push('WALLET_ENTRY_MISSING:' + w.address);
    }
  }
  return { ok: problems.length === 0, problems };
}

function doneAddresses(journal) {
  return new Set(((journal && journal.wallets) || []).map(w => w.address));
}

// Every file the journal owns, so a completed run can remove all of it in the
// same commit that lands the evidence. A journal outliving its run would be
// offered to the next one and refused — correctly, but noisily.
function ownedPaths(journal, journalPath) {
  return [journalPath].concat(((journal && journal.row_shards) || []).map(s => s.path));
}

module.exports = { SCHEMA, sha256, canonical, digest, seal, serialize, walletRecord,
  begin, record, usable, doneAddresses, ownedPaths };
