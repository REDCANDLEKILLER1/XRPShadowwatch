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
// ── WHAT IS EXPORTED ───────────────────────────────────────────────────────
//
// Everything: the slim event, its participants (provenance included), the
// complete ledger payload where it is still present, the coverage proof, and
// the run audit. What happened, who touched it, what the ledger actually said,
// what was proven, and by which run.
//
// The payload rides in its OWN shards rather than inside the event. It is by
// far the largest part — 186 MB of the measured store against ~105 MB for
// everything else — and separating it means the daily runtime path never
// touches those files, while they are still in the repository if a classifier
// that does not exist yet ever needs them.
//
// An earlier revision of this file excluded the payload on the grounds that a
// git repository cannot delete and ~300 MB would sit in every clone forever.
// That figure was the uncompressed total, and it was the wrong number to
// reason from: gzipped ledger JSON is highly repetitive, so the payload shards
// are a fraction of it. The manifest records the real compressed size, so the
// decision is made against a measurement rather than an estimate.
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

// The complete ledger payload, verbatim, keyed by hash. Separate from the
// event so that acquisition never loads it and an archive consumer can choose
// whether to fetch it at all.
function payloadOf(row) {
  const r = row || {};
  return {
    hash: _s(r.hash),
    raw_tx: (r.raw_tx && typeof r.raw_tx === 'object') ? r.raw_tx : null,
    raw_meta: (r.raw_meta && typeof r.raw_meta === 'object') ? r.raw_meta : null
  };
}
// A payload row with neither half is not evidence of anything and would only
// pad the archive with nulls.
function hasPayload(payload) {
  return !!(payload && payload.hash && (payload.raw_tx || payload.raw_meta));
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
function orderPayloads(a, b) {
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
//
// The split is done on the LINES, and records are only stringified first,
// because the commit path builds a day's payload file from lines it never
// parses — a raw ledger payload read back from the day's stored shard, or one
// written straight from the walk, is the same bytes either way, and parsing
// forty thousand of them into objects just to stringify them again was most
// of what the ending's memory went on. One algorithm, so the two callers
// cannot split a day at different points.
// Incremental: lines are pushed as they come and each finished piece is
// handed to `pack` the moment it fills, so a day's payload file can be built
// and compressed slice by slice without its text ever being whole. Without
// `pack` the piece keeps its text, which is what shard() below relies on.
class LineSharder {
  constructor(basePath, cap, pack) {
    this.basePath = basePath;
    this.limit = cap || MAX_SHARD_BYTES;
    this.pack = typeof pack === 'function' ? pack : null;
    this.pieces = [];
    this.current = []; this.bytes = 0;
  }
  push(line) {
    const size = Buffer.byteLength(line, 'utf8') + 1;
    // A single record larger than the cap still gets its own shard rather than
    // being dropped: an oversized row is a problem to report, not to hide.
    if (this.bytes && this.bytes + size > this.limit) this.flush();
    this.current.push(line); this.bytes += size;
  }
  flush() {
    if (!this.current.length) return;
    const text = this.current.join('\n') + '\n';
    const piece = { rows: this.current.length };
    if (this.pack) piece.packed = this.pack(text); else { piece.lines = this.current; piece.text = text; }
    this.pieces.push(piece);
    this.current = []; this.bytes = 0;
  }
  end() {
    this.flush();
    const n = this.pieces.length;
    return this.pieces.map((piece, i) => ({
      path: n === 1 ? this.basePath : this.basePath.replace(/\.ndjson$/, '.' + String(i + 1).padStart(3, '0') + '.ndjson'),
      ...piece
    }));
  }
}
function shardLines(lines, basePath, cap) {
  const sharder = new LineSharder(basePath, cap);
  for (const line of lines) sharder.push(line);
  return sharder.end();
}
function shard(records, basePath, cap) {
  const lines = records.map(r => JSON.stringify(r));
  let at = 0;
  return shardLines(lines, basePath, cap).map(piece => {
    const slice = records.slice(at, at + piece.lines.length);
    at += piece.lines.length;
    return { path: piece.path, records: slice, text: piece.text };
  });
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
  sha256, eventOf, participantOf, payloadOf, hasPayload, coverageOf,
  ndjson, orderEvents, orderParticipants, orderPayloads, dayOf, dayPath, shard, shardLines, LineSharder,
  fileEntry, manifestDigest, sealManifest
};
