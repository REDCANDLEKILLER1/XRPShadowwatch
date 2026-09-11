// XRPMAN Shadow Watch — one morning's acquisition, with GitHub as the store
// and XRPL asked only for what changed.
//
// ── THE SHAPE OF A RUN ─────────────────────────────────────────────────────
//
//   read evidence/state/latest.json          ONE file, a few hundred kB
//   pin one validated ledger as the anchor   every wallet shares it
//   for each wallet:
//       walk account_tx  last_proven_ledger+1 .. anchor      UNCONDITIONAL
//       read account_info balance pinned AT the anchor
//       reconcile the two
//   if 255/255 proved AND zero contradictions:
//       ONE commit: delta shards + run manifest + new state
//   otherwise:
//       commit nothing; the checkpoint does not move
//
// Neon appears nowhere in this file. It was read once, by the export, and the
// runtime does not depend on it again.
//
// ── WHY THE WALK IS UNCONDITIONAL ──────────────────────────────────────────
//
// Because a balance cannot tell you whether to look. A routing wallet that
// receives five million XRP and forwards five million XRP inside a day holds
// exactly the balance it started with, and is indistinguishable from a wallet
// that did nothing at all. Gating the walk on a balance delta would build that
// wallet a hiding place, and that wallet is the reason this project exists.
//
// So the balance runs the other way: between two balances pinned to two known
// ledgers, the XRP delta is an exact identity against the AccountRoot deltas of
// the transactions in between. When it does not hold, evidence is MISSING.
//
// ── WHY NOTHING IS WRITTEN UNTIL THE END ───────────────────────────────────
//
// A per-wallet commit would leave wallet 120 proven through today and wallet
// 121 on yesterday, with no single state describing what the system knows. A
// run that dies must leave the checkpoint exactly where it was — then the next
// run repeats the same bounded edge, which costs one account_tx per wallet and
// is the correct response to a failure rather than a recovery problem.
'use strict';

const zlib = require('zlib');
const T = require('./transactions');
const B = require('./balance');
const State = require('./evidence-state');
const Store = require('./github-store');
const X = require('./evidence-export');

const PAGE_LIMIT = 200;
const DEFAULT_CONCURRENCY = 4;

const gz = text => zlib.gzipSync(Buffer.from(text, 'utf8'), { level: 9 });

// ── One wallet's bounded edge ──────────────────────────────────────────────
//
// The range comes from edgeFor(): the checkpoint and the anchor, and nothing
// else. A wallet with no checkpoint is a cold bootstrap and says so; every
// other wallet walks only its own delta, however long that delta is. Three days
// without a run searches three days, because the checkpoint is three days old —
// not because anything counted the days.
async function walkWallet(reader, entry, anchor, options) {
  const opts = options || {};
  const edge = State.edgeFor(entry, anchor.ledger);
  const address = edge.address;
  const from = edge.cold ? (opts.coldFrom || null) : edge.from_ledger;
  if (from === null) {
    return { address, status: 'UNPROVEN', reason: 'COLD_BOOTSTRAP_RANGE_UNKNOWN', rows: [], edge };
  }
  // Nothing to prove: the checkpoint already reaches the anchor. This happens
  // when a run is repeated against the same ledger, and it is not an error.
  if (from > anchor.ledger) {
    return { address, status: 'COMPLETE', rows: [], edge,
      proof: { from_ledger: anchor.ledger, through_ledger: anchor.ledger, pages: 0, requests: 0 },
      reconciliation: { status: B.STATUS.NOT_APPLICABLE, reason: 'EDGE_ALREADY_PROVEN_THIS_ANCHOR' } };
  }

  const rows = [];
  let marker, pages = 0;
  const before = reader.stats.requests;
  do {
    const command = { command: 'account_tx', account: address, ledger_index_min: from,
      ledger_index_max: anchor.ledger, limit: PAGE_LIMIT, forward: true };
    if (marker) command.marker = marker;
    const result = await reader.request(command, reader.epoch);
    // The response has to name the range it answered for. Without that, a
    // server could quietly answer a narrower window and the walk would call it
    // exhausted.
    if (result.validated !== true || Number(result.ledger_index_min) !== from ||
        Number(result.ledger_index_max) !== anchor.ledger) throw new Error('ACCOUNT_TX_RESPONSE_RANGE_UNPROVEN');
    if (result.account !== address || !Array.isArray(result.transactions)) throw new Error('ACCOUNT_TX_RESPONSE_MALFORMED');
    for (const item of result.transactions) {
      const row = T.rowFromAccountTx(item, { observedVia: address, scanId: opts.scanId, rosterVersion: opts.rosterHash });
      if (row.ledger_index === null || row.ledger_index < from || row.ledger_index > anchor.ledger ||
          row.validated !== true || row.close_time_ms === null) throw new Error('ROW_OUTSIDE_PROVEN_RANGE');
      if (rows.length && row.ledger_index < rows[rows.length - 1].ledger_index) throw new Error('FORWARD_PAGE_ORDER_UNPROVEN');
      rows.push(row);
    }
    const next = result.marker;
    if (next && marker && JSON.stringify(next) === JSON.stringify(marker)) throw new Error('ACCOUNT_TX_MARKER_NOT_ADVANCING');
    marker = next; pages++;
  } while (marker);

  const merged = T.mergeSightings(rows);
  if (merged.some(r => r.conflicts.length)) throw new Error('CONFLICTING_TRANSACTION_SIGHTINGS');

  // The cross-check, read AFTER the walk and pinned to the same anchor, so both
  // describe one instant.
  const observed = await reader.balance(address, anchor.ledger);
  const reconciliation = B.reconcile({
    address, rows: merged,
    edge: { from_ledger: from, through_ledger: anchor.ledger },
    previous: { drops: entry && entry.balance_drops, ledger: entry && entry.balance_ledger },
    current: observed || {}
  });

  const last = merged.length ? merged.reduce((a, b) => b.ledger_index > a.ledger_index ? b : a) : null;
  return {
    address, status: 'COMPLETE', rows: merged, edge,
    proof: { from_ledger: from, through_ledger: anchor.ledger, pages, requests: reader.stats.requests - before },
    balance: observed,
    reconciliation,
    next_entry: State.walletEntry({
      address,
      last_proven_ledger: anchor.ledger,
      last_proven_close: anchor.close_iso,
      last_observed_tx_ledger: last ? last.ledger_index : (entry && entry.last_observed_tx_ledger),
      last_observed_tx_hash: last ? last.hash : (entry && entry.last_observed_tx_hash),
      balance_drops: observed ? observed.drops : (entry && entry.balance_drops),
      balance_ledger: observed ? observed.ledger : (entry && entry.balance_ledger),
      reconciliation: reconciliation.status
    })
  };
}

// ── Turning a run's rows into the files it will commit ─────────────────────
//
// Grouped by the day the LEDGER closed, exactly as the export shards are, so an
// archive assembled from daily runs is indistinguishable from one exported in
// a single pass. Deterministic: same rows, same bytes, same hashes.
function buildShards(rows) {
  const byDay = new Map();
  for (const row of rows) {
    const event = X.eventOf({ ...row, close_time: row.close_time_iso });
    const day = X.dayOf(event.close_time);
    if (!day) throw new Error('ROW_WITHOUT_CLOSE_TIME');
    if (!byDay.has(day)) byDay.set(day, { events: [], participants: [], payloads: [] });
    const bucket = byDay.get(day);
    bucket.events.push(event);
    for (const p of T.participantsOf(row)) bucket.participants.push(X.participantOf(p));
    const payload = X.payloadOf(row);
    if (X.hasPayload(payload)) bucket.payloads.push(payload);
  }

  const files = {}, shards = [];
  const emit = (records, order, basePath) => {
    if (!records.length) return;
    for (const piece of X.shard(records.slice().sort(order), basePath, X.MAX_SHARD_BYTES)) {
      const packed = gz(piece.text);
      const path = piece.path + '.gz';
      files[path] = packed;
      // The hash the state will carry is over the file as committed, so the
      // checkpoint's claim can be checked against the bytes in the repository.
      shards.push({ path, sha256: X.sha256(packed), rows: piece.records.length });
    }
  };
  for (const day of [...byDay.keys()].sort()) {
    const base = 'evidence/' + X.dayPath(day);
    const bucket = byDay.get(day);
    emit(bucket.events, X.orderEvents, base + '/events.ndjson');
    // Deduped per (hash, address, role): the same transaction seen by two
    // watched wallets contributes both observations, once each.
    const seen = new Set();
    const participants = bucket.participants.filter(p => {
      const key = p.tx_hash + '|' + p.address + '|' + p.role;
      if (seen.has(key)) return false;
      seen.add(key); return true;
    });
    emit(participants, X.orderParticipants, base + '/participants.ndjson');
    emit(bucket.payloads, X.orderPayloads, base + '/payloads.ndjson');
  }
  return { files, shards };
}

// ── The run ────────────────────────────────────────────────────────────────
async function acquire(input, deps) {
  const d = deps || {};
  const reader = d.reader;
  if (!reader) throw new Error('READER_REQUIRED');
  const run = input || {};
  if (!run.report_id) throw new Error('RUN_REPORT_ID_REQUIRED');

  // 1. ONE file. The archive is never loaded to acquire.
  const loaded = await Store.readState({ env: d.env, gh: d.gh, fetch: d.fetch });
  if (loaded.missing) throw new Error('EVIDENCE_STATE_MISSING: seed genesis from the export before the first run');
  const state = loaded.state;

  // 2. One anchor, shared by every wallet, so wallet 3 and wallet 200 describe
  //    the same ledger state.
  const header = await reader.ledger('validated');
  const anchor = { ledger: header.ledger, close_ms: header.close_ms, close_iso: new Date(header.close_ms).toISOString() };

  // The validated ledger has not moved since the last sealed run, so there is
  // by definition nothing new to prove: every checkpoint already reaches it.
  // This is a clean no-op, not a failure — walking 255 wallets to discover that
  // would cost 255 requests to learn what one comparison already said, and
  // attempting the commit would be asking to re-claim a window we already
  // claimed. Wait for the next ledger and run again.
  if (Number(state.anchor_ledger) && anchor.ledger <= Number(state.anchor_ledger)) {
    return { report_id: run.report_id, scan_id: run.scan_id || null,
      anchor_ledger: anchor.ledger, anchor_close: anchor.close_iso,
      state_version_read: state.state_version,
      target_wallets: state.wallets.length, complete_wallets: 0, failed_wallets: 0,
      balance_contradictions: 0, balance_contradiction_addresses: [], balance_reconciled: 0,
      transactions: 0, xrpl_requests: reader.stats.requests, failures: [],
      committed: false, reason: 'ANCHOR_NOT_ADVANCED',
      stored_anchor_ledger: Number(state.anchor_ledger) };
  }

  // 3. Every wallet, unconditionally.
  const entries = state.wallets.slice();
  const results = new Array(entries.length);
  const concurrency = Math.max(1, Math.min(Number(d.concurrency) || DEFAULT_CONCURRENCY, 8));
  let cursor = 0;
  const worker = async () => {
    for (;;) {
      const index = cursor++;
      if (index >= entries.length) return;
      const entry = entries[index];
      try {
        results[index] = await walkWallet(reader, entry, anchor,
          { scanId: run.scan_id, rosterHash: state.state_sha256, coldFrom: run.cold_from_ledger });
      } catch (e) {
        results[index] = { address: entry.address, status: 'FAILED', error: e.message, rows: [] };
      }
      if (typeof d.onWallet === 'function') d.onWallet(results[index], index + 1, entries.length);
    }
  };
  await Promise.all(Array.from({ length: concurrency }, worker));

  const complete = results.filter(r => r && r.status === 'COMPLETE');
  const failed = results.filter(r => !r || r.status !== 'COMPLETE');
  const contradicted = complete.filter(r => B.contradicted(r.reconciliation));
  const rows = T.mergeSightings(complete.flatMap(r => r.rows));
  const summary = {
    report_id: run.report_id, scan_id: run.scan_id || null,
    anchor_ledger: anchor.ledger, anchor_close: anchor.close_iso,
    state_version_read: state.state_version,
    target_wallets: entries.length, complete_wallets: complete.length,
    failed_wallets: failed.length,
    balance_contradictions: contradicted.length,
    balance_contradiction_addresses: contradicted.map(r => r.address).sort(),
    balance_reconciled: complete.filter(r => r.reconciliation && r.reconciliation.status === B.STATUS.RECONCILED).length,
    transactions: rows.length,
    xrpl_requests: reader.stats.requests,
    failures: failed.map(r => ({ address: r && r.address, error: (r && r.error) || 'UNKNOWN' }))
  };

  // 4. The gate. Anything short of a whole, uncontradicted run commits nothing,
  //    and the checkpoint stays exactly where it was.
  if (failed.length) {
    return { ...summary, committed: false, reason: 'RUN_INCOMPLETE' };
  }
  if (contradicted.length) {
    return { ...summary, committed: false, reason: 'RUN_CONTRADICTED' };
  }

  const built = buildShards(rows);
  const committed = await Store.commitRun({
    report_id: run.report_id, scan_id: run.scan_id || null, sealed_at: run.sealed_at || null,
    anchor_ledger: anchor.ledger, anchor_close: anchor.close_iso,
    target_wallets: entries.length, complete_wallets: complete.length, balance_contradictions: 0,
    evidence_shards: built.shards,
    wallets: complete.map(r => r.next_entry),
    files: built.files
  }, { env: d.env, gh: d.gh, fetch: d.fetch });

  return { ...summary, committed: true, ...committed };
}

module.exports = { acquire, walkWallet, buildShards, PAGE_LIMIT };
