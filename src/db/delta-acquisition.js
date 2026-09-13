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

// ── HOW FAR BACK A NEWLY ADMITTED WALLET READS ─────────────────────────────
//
// A wallet joining the roster has no checkpoint, so there is no delta to walk —
// only a decision about how much history to buy on its first morning. Walking
// it to genesis would be honest and unaffordable: some of these wallets have
// hundreds of thousands of transactions, and one cold wallet could consume the
// entire run's budget and strand the other four hundred.
//
// So the first walk is BOUNDED and the bound is RECORDED. ~30,000 ledgers is
// roughly 33 hours at four seconds a ledger, which covers the report's 24-hour
// window with margin under any plausible close rate. Everything before that is
// unread, the state says so per wallet in history_from_ledger, and the report
// may not speak about it. A wallet admitted this morning is "watched since this
// ledger" — not "we have its history".
const COLD_WINDOW_LEDGERS = 30000;

// ── HOW MANY MAY JOIN AT ONCE ──────────────────────────────────────────────
//
// One run is one serverless invocation with a hard ceiling, and the admission
// clock paces every XRPL request 250 ms apart. 408 wallets already cost at
// least 816 requests — one account_tx plus one account_info each — which is
// 204 seconds of pacing alone against a 240-second budget. A cold wallet costs
// more than that: 33 hours of history can be several pages.
//
// So admitting 153 wallets in one run does not produce a slow run, it produces
// a run that dies, commits nothing, and leaves the roster exactly where it was
// — then does it again tomorrow. Admissions are therefore BATCHED: each run
// takes the next few in address order, the rest stay pending and are named in
// the result, and the roster fills in over several mornings while every run
// stays whole and atomic. The 255 already proven walk their delta throughout
// and are never affected.
//
// This is a budget decision, not a forensic one. Nothing is skipped and no
// window is narrowed; a wallet simply joins on Tuesday instead of Monday.
const DEFAULT_MAX_ADMISSIONS = 12;

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
      reconciliation: { status: B.STATUS.NOT_APPLICABLE, reason: 'EDGE_ALREADY_PROVEN_THIS_ANCHOR' },
      // Carried unchanged. Nothing was read, so nothing about this wallet moves
      // — but it still has to appear in the state the run writes, or it would
      // read as dropped.
      next_entry: State.walletEntry(entry) };
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
      reconciliation: reconciliation.status,
      // An admitted wallet stamps both facts now; every other wallet carries
      // forward what it already had. A run never restates either.
      admitted_at_ledger: edge.cold ? anchor.ledger : (entry && entry.admitted_at_ledger),
      history_from_ledger: edge.cold ? from : (entry && entry.history_from_ledger)
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

  // 1+2. Two independent lanes, run concurrently: the checkpoint comes from
  // GitHub and the anchor from XRPL, and neither needs the other. Serialising
  // them bought nothing but latency.
  const [loaded, header] = await Promise.all([
    Store.readState({ env: d.env, gh: d.gh, fetch: d.fetch }),
    reader.ledger('validated')
  ]);
  if (loaded.missing) throw new Error('EVIDENCE_STATE_MISSING: seed the checkpoint from a sealed report before the first run');
  const state = loaded.state;
  // One anchor, shared by every wallet, so wallet 3 and wallet 200 describe the
  // same ledger state.
  const anchor = { ledger: header.ledger, close_ms: header.close_ms, close_iso: new Date(header.close_ms).toISOString() };

  // ── THE ROSTER AND THE STATE ARE DIFFERENT THINGS ───────────────────────
  //
  // The roster is the list of wallets ShadowWatch watches. The state is what it
  // has PROVEN about them. On a steady morning they name the same set, and the
  // difference is empty. When the roster grows, the difference is exactly the
  // wallets being admitted — so admission is not a separate mechanism bolted
  // on, it is what the gap between those two lists means.
  //
  // The roster is supplied by the server from committed source. It is never
  // taken from a request body: a caller who could name the roster could name a
  // wallet nobody decided to watch and have the run stamp it as admitted.
  const known = new Set(state.wallets.map(w => w.address));
  const rosterList = Array.isArray(run.roster)
    ? [...new Set(run.roster.map(a => String(a)))] : null;
  const waiting = rosterList ? rosterList.filter(a => !known.has(a)).sort() : [];
  // Sorted, so "the next few" is the same few on every attempt rather than
  // whichever ones a Set happened to yield first.
  const maxAdmissions = Math.max(0, Number.isFinite(Number(run.max_admissions))
    ? Number(run.max_admissions) : DEFAULT_MAX_ADMISSIONS);
  const admitted = waiting.slice(0, maxAdmissions);
  const deferred = waiting.slice(admitted.length);
  // And the other direction. A wallet the state knows but the roster no longer
  // lists is NOT dropped: retiring a watched wallet is a decision, and a run
  // does not infer a decision from a list it was handed. It keeps being walked
  // and the discrepancy is reported, which is the difference between noticing
  // an edit and obeying one.
  const rosterAbsent = rosterList
    ? state.wallets.map(w => w.address).filter(a => !rosterList.includes(a)) : [];
  const coldWindow = Math.max(1, Number(run.cold_window_ledgers) || COLD_WINDOW_LEDGERS);
  const coldFrom = Math.max(1, anchor.ledger - coldWindow + 1);

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
      // The new wallets have nothing proven and would gladly be walked — but a
      // state advance requires an anchor ahead of the last one, so admitting
      // them against this ledger would be re-claiming a window already claimed.
      // They are admitted on the next ledger, one wait, no work wasted.
      wallets_pending_admission: waiting.length,
      balance_contradictions: 0, balance_contradiction_addresses: [], balance_reconciled: 0,
      transactions: 0, xrpl_requests: reader.stats.requests, failures: [],
      committed: false, reason: 'ANCHOR_NOT_ADVANCED',
      stored_anchor_ledger: Number(state.anchor_ledger) };
  }

  // 3. Every wallet, unconditionally — the proven ones on their own delta, the
  //    admitted ones on one bounded cold window each.
  const entries = state.wallets.concat(
    admitted.map(address => State.walletEntry({ address })));
  const results = new Array(entries.length);
  const concurrency = Math.max(1, Math.min(Number(d.concurrency) || DEFAULT_CONCURRENCY, 8));
  let cursor = 0;
  // Per-wallet recovery. One sick endpoint must not turn the run into 0/255, so
  // a wallet that fails is retried — and because the Reader rotates endpoints
  // on a transport failure, a retry is usually a different server. Attempts are
  // bounded and every one is recorded: a wallet that took three tries is not
  // the same fact as one that answered first time.
  const attemptsPerWallet = Math.max(1, Math.min(Number(d.attempts) || 3, 5));
  const worker = async () => {
    for (;;) {
      const index = cursor++;
      if (index >= entries.length) return;
      const entry = entries[index];
      const tried = [];
      for (let attempt = 1; attempt <= attemptsPerWallet; attempt++) {
        try {
          const walked = await walkWallet(reader, entry, anchor,
            { scanId: run.scan_id, rosterHash: state.state_sha256, coldFrom });
          results[index] = { ...walked, attempts: attempt, earlier_failures: tried };
          break;
        } catch (e) {
          tried.push({ attempt, error: e.message, endpoint: reader.stats.actual_endpoint || null });
          // A permanent refusal will not become a success by being asked again.
          const permanent = /INVALID|MALFORMED|OUTSIDE_PROVEN_RANGE|CONFLICTING/.test(e.message);
          if (permanent || attempt === attemptsPerWallet) {
            results[index] = { address: entry.address, status: 'FAILED', error: e.message,
              attempts: attempt, earlier_failures: tried, rows: [] };
            break;
          }
        }
      }
      if (typeof d.onWallet === 'function') d.onWallet(results[index], index + 1, entries.length);
    }
  };
  await Promise.all(Array.from({ length: concurrency }, worker));

  const complete = results.filter(r => r && r.status === 'COMPLETE');
  const failed = results.filter(r => !r || r.status !== 'COMPLETE');
  const contradicted = complete.filter(r => B.contradicted(r.reconciliation));
  const rows = T.mergeSightings(complete.flatMap(r => r.rows));

  // ── WHAT MAY BE RENDERED, SEPARATELY FROM WHAT MAY BE CLAIMED ───────────
  // Evidence from a wallet that completed is real whether or not the run as a
  // whole earned its checkpoint. Returning nothing because six wallets of 255
  // failed would throw away 249 wallets of true observations and leave the
  // operator with 0/255 — which reads as "nothing happened" rather than "we
  // could not finish". So the rows always come back, and the freshness block
  // says exactly what they cover and what they do not.
  //
  // The COMMIT stays all-or-nothing. Renderable and provable are different
  // questions and this is where they separate.
  const freshness = {
    anchor_ledger: anchor.ledger,
    anchor_close: anchor.close_iso,
    proven_from_ledger: Number(state.anchor_ledger) || null,
    wallets_proven: complete.length,
    wallets_unavailable: failed.length,
    wallets_contradicted: contradicted.length,
    // Said plainly, because it is the one thing a reader of this morning's
    // report could otherwise get wrong: these wallets are watched from here,
    // and nothing is known about them before this ledger.
    wallets_admitted: admitted.length,
    admitted: admitted.slice(),
    admitted_history_from_ledger: admitted.length ? coldFrom : null,
    // Named, not merely counted. A roster of 408 with 141 still waiting is a
    // different fact from a roster of 267, and the report must not round one
    // into the other.
    wallets_awaiting_admission: deferred.length,
    watched_not_in_roster: rosterAbsent.slice().sort(),
    checkpoint_advances: failed.length === 0 && contradicted.length === 0,
    unavailable: failed.map(r => ({ address: r && r.address,
      error: (r && r.error) || 'UNKNOWN', attempts: (r && r.attempts) || 0 })),
    contradicted: contradicted.map(r => ({ address: r.address,
      reason: r.reconciliation.reason,
      unexplained_drops: r.reconciliation.unexplained_drops || null }))
  };
  const wallets = results.map(r => ({
    address: r && r.address, status: (r && r.status) || 'FAILED',
    proven_through: r && r.proof ? r.proof.through_ledger : null,
    rows: r && r.rows ? r.rows.length : 0,
    reconciliation: (r && r.reconciliation && r.reconciliation.status) || null,
    attempts: (r && r.attempts) || 0,
    error: (r && r.error) || null
  }));

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
    wallets_admitted: admitted.length,
    admitted_wallets: admitted.slice(),
    admitted_history_from_ledger: admitted.length ? coldFrom : null,
    wallets_awaiting_admission: deferred.length,
    roster_wallets: rosterList ? rosterList.length : null,
    watched_not_in_roster: rosterAbsent.slice().sort(),
    xrpl_requests: reader.stats.requests,
    failures: failed.map(r => ({ address: r && r.address, error: (r && r.error) || 'UNKNOWN' }))
  };

  // 4. The gate. Anything short of a whole, uncontradicted run commits nothing,
  //    and the checkpoint stays exactly where it was.
  if (failed.length) {
    return { ...summary, committed: false, reason: 'RUN_INCOMPLETE', rows, wallets, freshness };
  }
  if (contradicted.length) {
    return { ...summary, committed: false, reason: 'RUN_CONTRADICTED', rows, wallets, freshness };
  }

  const built = buildShards(rows);
  const committed = await Store.commitRun({
    report_id: run.report_id, scan_id: run.scan_id || null, sealed_at: run.sealed_at || null,
    anchor_ledger: anchor.ledger, anchor_close: anchor.close_iso,
    target_wallets: entries.length, complete_wallets: complete.length, balance_contradictions: 0,
    evidence_shards: built.shards,
    wallets: complete.map(r => r.next_entry),
    admitted_wallets: admitted,
    files: built.files
  }, { env: d.env, gh: d.gh, fetch: d.fetch });

  return { ...summary, committed: true, rows, wallets, freshness, ...committed };
}

// ── The report window: what we already own, plus the edge just walked ──────
//
// The delta a daily run fetches IS the window when the run is daily. It stops
// being so on a second run the same day — the morning's transactions are then
// already committed, and re-fetching them from XRPL would be paying twice for
// evidence we own. So the window is assembled from the committed shards for the
// days it touches (one or two files, never the archive) unioned with the rows
// this run just walked.
//
// Deduped by hash, because a transaction inside the overlap appears in both.
async function readReportWindow(input, deps) {
  const d = deps || {};
  const from = new Date(input.window_start_ms), to = new Date(input.window_end_ms);
  if (!Number.isFinite(from.getTime()) || !Number.isFinite(to.getTime()) || to < from) {
    throw new Error('INVALID_REPORT_WINDOW');
  }
  const days = [];
  for (let t = Date.UTC(from.getUTCFullYear(), from.getUTCMonth(), from.getUTCDate());
       t <= to.getTime(); t += 86400000) {
    days.push(new Date(t).toISOString().slice(0, 10));
  }
  const stored = await Store.readDays(days, d);
  const fresh = (input.rows || []).map(r => X.eventOf({ ...r, close_time: r.close_time_iso || r.close_time }));
  const byHash = new Map();
  // Freshly walked rows win on a tie: they came from this run's proven range.
  for (const event of stored.events) byHash.set(event.hash, event);
  for (const event of fresh) byHash.set(event.hash, event);
  const events = [...byHash.values()]
    .filter(e => {
      const t = Date.parse(e.close_time);
      return Number.isFinite(t) && t >= from.getTime() && t <= to.getTime();
    })
    .sort(X.orderEvents);
  return { events, days, shards_read: stored.files, days_without_shards: stored.missing,
    from_stored: stored.events.length, from_this_run: fresh.length, in_window: events.length };
}

module.exports = { acquire, walkWallet, buildShards, readReportWindow, PAGE_LIMIT };
