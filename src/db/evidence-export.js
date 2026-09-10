// XRPMAN Shadow Watch — the shape of an exported evidence archive.
//
// Pure: no database, no filesystem, no network. Everything here is the
// canonical projection, the deterministic serialization and the manifest
// arithmetic, so the operator scripts that read Neon and write files stay thin
// and this part is testable with no infrastructure at all.
//
// ── WHY AN EXPORT EXISTS ───────────────────────────────────────────────────
//
// Neon is a runtime store with a hard size ceiling, and the retention this
// project needs means old evidence is deleted. Deleted evidence that was never
// written down anywhere else is gone. So before anything is pruned, the
// forensic record leaves the database in a form that can be verified byte for
// byte and read without a database at all.
//
// ── WHAT IS EXPORTED, AND WHAT IS DELIBERATELY NOT ─────────────────────────
//
// Exported: the slim event, its participants (provenance included), the
// coverage proof, and the run audit. That is the forensic record — what
// happened, who touched it, what was proven, and by which run.
//
// NOT exported: raw_tx / raw_meta. The payload is a 48-hour cache, and a git
// repository is permanent in a way this data must not be. Committing ~300 MB
// of ledger payload would put it in every clone forever, unremovable without
// rewriting history for everyone. Storage that cannot delete is the wrong
// home for data governed by a retention policy. If the payload is ever wanted
// long-term it belongs in object storage, and this manifest records that the
// omission was a decision rather than an oversight.
//
// ── DETERMINISM, AND WHY IT IS THE POINT ───────────────────────────────────
//
// "Verified" has to mean something a command can decide. So the same rows
// always produce the same bytes: fixed key order, a total ordering on rows,
// and a hash over the UNCOMPRESSED text. Hashing the plaintext rather than the
// gzip means verification never depends on a compressor's framing choices —
// decompress, hash, compare.
'use strict';

const crypto = require('crypto');

const SCHEMA = 'shadowwatch-evidence-export/1';
// GitHub refuses a blob over 100 MB and warns over 50. Shards are capped well
// under that, and a day that exceeds it is split rather than truncated.
const MAX_SHARD_BYTES = 32 * 1024 * 1024;

const sha256 = value => crypto.createHash('sha256').update(value).digest('hex');

// A drops value stays a decimal string all the way out. 1e17 drops is past the
// exact range of a double, and an export that rounded evidence on its way to
// permanent storage would be worse than no export.
function _s(v) { return (v === null || v === undefined) ? null : String(v); }
function _int(v) {
  if (v === null || v === undefined) return null;
  const n = Number(v);
  return Number.isFinite(n) ? Math.trunc(n) : null;
}
function _iso(v) {
  if (v === null || v === undefined) return null;
  const ms = v instanceof Date ? v.getTime() : Date.parse(v);
  return Number.isFinite(ms) ? new Date(ms).toISOString() : null;
}

// ── The canonical exported event ───────────────────────────────────────────
// Every normalized column, in a fixed order, plus the derived `evidence`
// object that carries the AccountRoot balance deltas. Those deltas are what
// lets the balance cross-check keep working against exported history after the
// payload is long gone, so they are not optional.
//
// Related to but NOT the same as evidence.js::reportFact(): that is the
// projection a REPORT reads, deliberately narrow. This one has to be able to
// reconstruct the row.
const EVENT_KEYS = ['hash','ledger_index','close_time','tx_type','tx_result','validated',
  'from_account','to_account','amount_drops','amount_value','currency','issuer',
  'destination_tag','source_tag','sig_mode','signer_count','escrow_owner','escrow_destination',
  'escrow_amount_drops','fee_drops','sequence','tx_flags','transaction_index',
  'roster_version','first_seen_scan_id','ingested_at','evidence'];

function eventOf(row) {
  const r = row || {};
  return {
    hash: _s(r.hash),
    ledger_index: _int(r.ledger_index),
    close_time: _iso(r.close_time),
    tx_type: _s(r.tx_type),
    tx_result: _s(r.tx_result),
    validated: r.validated === true,
    from_account: _s(r.from_account),
    to_account: _s(r.to_account),
    amount_drops: _s(r.amount_drops),
    amount_value: _s(r.amount_value),
    currency: _s(r.currency),
    issuer: _s(r.issuer),
    destination_tag: _int(r.destination_tag),
    source_tag: _int(r.source_tag),
    sig_mode: _s(r.sig_mode),
    signer_count: _int(r.signer_count),
    escrow_owner: _s(r.escrow_owner),
    escrow_destination: _s(r.escrow_destination),
    escrow_amount_drops: _s(r.escrow_amount_drops),
    fee_drops: _s(r.fee_drops),
    sequence: _int(r.sequence),
    tx_flags: _int(r.tx_flags),
    transaction_index: _int(r.transaction_index),
    roster_version: _s(r.roster_version),
    first_seen_scan_id: _s(r.first_seen_scan_id),
    ingested_at: _iso(r.ingested_at),
    evidence: (r.evidence && typeof r.evidence === 'object') ? r.evidence : {}
  };
}

function participantOf(row) {
  const r = row || {};
  return { tx_hash: _s(r.tx_hash), address: _s(r.address), role: _s(r.role) };
}

// The proof. Never derived, never recomputed on import — copied.
function coverageOf(row) {
  const r = row || {};
  return {
    address: _s(r.address),
    scan_coverage_from: _int(r.scan_coverage_from),
    scan_coverage_through: _int(r.scan_coverage_through),
    scan_coverage_from_close: _iso(r.scan_coverage_from_close),
    scan_coverage_through_close: _iso(r.scan_coverage_through_close),
    evidence_retained_from: _int(r.evidence_retained_from),
    evidence_retained_through: _int(r.evidence_retained_through),
    evidence_retained_from_close: _iso(r.evidence_retained_from_close),
    last_observed_tx_ledger: _int(r.last_observed_tx_ledger),
    last_status: _s(r.last_status),
    last_scan_id: _s(r.last_scan_id),
    updated_at: _iso(r.updated_at)
  };
}

// One JSON object per line, keys in declaration order, no whitespace. A
// trailing newline on the last line too, so concatenating shards is valid
// NDJSON and a diff of two exports is line-oriented.
function ndjson(records) {
  if (!records.length) return '';
  return records.map(r => JSON.stringify(r)).join('\n') + '\n';
}

// A TOTAL order, not merely a sort. close_time alone is not unique — a ledger
// closes many transactions at the same instant — so the hash breaks the tie
// and two exports of the same rows cannot differ by row order.
function orderEvents(a, b) {
  const at = String(a.close_time || ''), bt = String(b.close_time || '');
  if (at !== bt) return at < bt ? -1 : 1;
  return String(a.hash) < String(b.hash) ? -1 : (String(a.hash) > String(b.hash) ? 1 : 0);
}
function orderParticipants(a, b) {
  for (const k of ['tx_hash', 'address', 'role']) {
    const av = String(a[k] || ''), bv = String(b[k] || '');
    if (av !== bv) return av < bv ? -1 : 1;
  }
  return 0;
}

// UTC day. The archive is keyed by the day the LEDGER closed, never by the day
// the export ran — an export re-run tomorrow must produce the same paths.
function dayOf(closeTimeIso) {
  const iso = _iso(closeTimeIso);
  return iso ? iso.slice(0, 10) : null;
}
const dayPath = day => day.replace(/-/g, '/');

// Split one day's records into shards no larger than the cap. Deterministic:
// the split points are a function of the ordered records alone.
function shard(records, basePath, cap) {
  const limit = cap || MAX_SHARD_BYTES;
  const out = [];
  let current = [], bytes = 0;
  const flush = () => {
    if (!current.length) return;
    out.push({ records: current, text: ndjson(current) });
    current = []; bytes = 0;
  };
  for (const record of records) {
    const line = JSON.stringify(record) + '\n';
    const size = Buffer.byteLength(line, 'utf8');
    // A single record larger than the cap still gets its own shard rather than
    // being dropped: an oversized row is a problem to report, not to hide.
    if (bytes && bytes + size > limit) flush();
    current.push(record); bytes += size;
  }
  flush();
  return out.map((s, i) => ({
    path: out.length === 1 ? basePath : basePath.replace(/\.ndjson$/, '.' + String(i + 1).padStart(3, '0') + '.ndjson'),
    records: s.records,
    text: s.text
  }));
}

// The manifest entry for one written file. `sha256` is over the plaintext and
// is the authority; `gz_sha256` records what landed on disk so a corrupted
// file is distinguishable from a wrong one.
function fileEntry(path, text, gzBytes, gzSha) {
  const events = [];
  let ledgerMin = null, ledgerMax = null, closeMin = null, closeMax = null, rows = 0;
  for (const line of text.split('\n')) {
    if (!line) continue;
    rows++;
    let record; try { record = JSON.parse(line); } catch (_) { continue; }
    events.push(record);
    if (record.ledger_index !== undefined && record.ledger_index !== null) {
      if (ledgerMin === null || record.ledger_index < ledgerMin) ledgerMin = record.ledger_index;
      if (ledgerMax === null || record.ledger_index > ledgerMax) ledgerMax = record.ledger_index;
    }
    if (record.close_time) {
      if (closeMin === null || record.close_time < closeMin) closeMin = record.close_time;
      if (closeMax === null || record.close_time > closeMax) closeMax = record.close_time;
    }
  }
  return { path, rows, bytes: Buffer.byteLength(text, 'utf8'), gz_bytes: gzBytes === undefined ? null : gzBytes,
    sha256: sha256(Buffer.from(text, 'utf8')), gz_sha256: gzSha || null,
    ledger_min: ledgerMin, ledger_max: ledgerMax, close_min: closeMin, close_max: closeMax };
}

// The manifest is itself hashed, over a canonical serialization that excludes
// the hash field. Otherwise "the manifest says the files are fine" is a claim
// with nothing behind it: a tampered manifest would agree with tampered files.
function manifestDigest(manifest) {
  const { manifest_sha256, ...rest } = manifest || {};
  return sha256(Buffer.from(JSON.stringify(rest), 'utf8'));
}
function sealManifest(manifest) {
  return { ...manifest, manifest_sha256: manifestDigest(manifest) };
}

module.exports = {
  SCHEMA, MAX_SHARD_BYTES, EVENT_KEYS,
  sha256, eventOf, participantOf, coverageOf,
  ndjson, orderEvents, orderParticipants, dayOf, dayPath, shard,
  fileEntry, manifestDigest, sealManifest
};
