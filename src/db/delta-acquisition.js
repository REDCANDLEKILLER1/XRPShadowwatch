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
const Journal = require('./run-journal');
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
// Admissions are therefore BATCHED: each run takes the next few in address
// order, the rest stay pending and are named in the result. The 255 already
// proven walk their delta throughout and are never affected.
//
// ── HOW BIG THE BATCH SHOULD BE, MEASURED RATHER THAN GUESSED ──────────────
//
// The first value here was twelve, chosen before any of these wallets had been
// looked at and while a failed run still lost all of its work. Both of those
// have changed. The journal now keeps what a run walked, so a batch that does
// not finish costs a wait rather than a loss — and the wallets themselves have
// been measured. Thirty of the 153, over a full 30,000-ledger cold window:
//
//   18 of 30 silent — no transactions at all in 33 hours
//    9 of 30 answered in one page
//    3 of 30 needed more than one
//   1.07 requests and 0.39 seconds per wallet
//
// At that cost the entire remaining roster is about a minute of walking, not
// twelve mornings of it. Twelve was not caution, it was an untested number
// standing in for a measurement.
//
// This is still a budget decision and not a forensic one: nothing is skipped
// and no window is narrowed. A wallet joins when a run commits, and a run that
// runs out of road leaves it named as awaiting rather than half-admitted.
const DEFAULT_MAX_ADMISSIONS = 150;

// How many finished wallets accumulate before the run writes them down. Every
// flush is one commit, so flushing per wallet would be 255 ref updates — the
// exact cost the single-commit rule exists to avoid. Flushing never is what we
// had. Twenty-five is roughly ten commits a run, and it bounds what a
// disconnect can cost to the wallets walked since the last flush.
const DEFAULT_JOURNAL_EVERY = 25;
// …or every half minute, whichever comes first. Measured on the live ledger:
// most watched wallets move nothing in four days and answer in one page, but a
// busy exchange hot wallet can need thirty-one pages at roughly seven seconds
// each — public nodes slow down sharply as a marker walks deep. A run can
// therefore finish three wallets in four minutes, which a count-based flush
// would never write down at all.
const JOURNAL_INTERVAL_MS = 30000;

// Budget left below which the run stops STARTING wallets. A wallet begun with
// twenty seconds remaining is a wallet that will be cut off mid-walk, and a
// partial walk proves nothing and cannot be journalled — the work is simply
// lost. Stopping cleanly converts that into a flush and a resume.
const START_RESERVE_MS = 25000;

// ── A JOURNAL THAT FELL A DAY BEHIND THE LEDGER RE-ANCHORS ─────────────────
//
// A resumed run finishes against the anchor the interrupted one pinned — that
// is right for a run cut off an hour ago. It is wrong for one cut off
// yesterday: SW-20260917-PRG8S was resumed on the 18th against 17 Sep 13:00,
// so the window was capped 92,249 seconds short and a sealed report would
// have been about the wrong day. Past this age the run takes the live anchor
// and keeps every journalled wallet as partial progress toward it.
//
// Twelve hours, because the line is "the same day or not". A retry six hours
// after a crash still finishes the morning it interrupted — that is the
// property test 19 of the acquisition suite pins, and it is right. A retry the
// next day would be finishing yesterday, and nobody asked for yesterday.
const STALE_JOURNAL_MS = 12 * 3600 * 1000;
const STALE_JOURNAL_LEDGERS = 12000;  // ~12 h at one ledger every ~3.7 s

// Level 6, not 9. Measured on a representative shard: level 9 took 43 ms and
// level 6 took 19 ms, for output 0.1% larger. Level 9 was buying nothing and
// charging more than twice the CPU for it, on a path that gzips tens of
// megabytes at the end of a run.
const gz = text => zlib.gzipSync(Buffer.from(text, 'utf8'), { level: 6 });

// ── One wallet's bounded edge ──────────────────────────────────────────────
//
// The range comes from edgeFor(): the checkpoint and the anchor, and nothing
// else. A wallet with no checkpoint is a cold bootstrap and says so; every
// other wallet walks only its own delta, however long that delta is. Three days
// without a run searches three days, because the checkpoint is three days old —
// not because anything counted the days.
async function walkWallet(reader, entry, anchor, options) {
  const opts = options || {};
  // One lane for this whole wallet. account_tx markers are the server's own
  // bookmark into its own data, so a paged walk has to finish where it began —
  // but DIFFERENT wallets go to different servers, which is how the roster's
  // load gets spread instead of piling onto one endpoint.
  const lane = typeof reader.lane === 'function' ? await reader.lane() : null;
  const ask = (command) => lane
    ? reader.request(command, lane.epoch, lane)
    : reader.request(command, reader.epoch);
  // Held for the whole walk and handed back however the walk ends. A lane that
  // is never released makes its server look permanently busy and quietly
  // undoes the spreading it exists to provide.
  const release = () => { if (lane && typeof reader.releaseLane === 'function') reader.releaseLane(lane); };
  try {
    return await walkOn(reader, entry, anchor, opts, lane, ask);
  } finally { release(); }
}

async function walkOn(reader, entry, anchor, opts, lane, ask) {
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
    const result = await ask(command);
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
    // A wallet with thirty pages is four minutes of silence otherwise, which is
    // indistinguishable from a hang. Reported per page so a slow wallet reads
    // as slow rather than as stuck.
    if (typeof opts.onPage === 'function') opts.onPage({ address, pages, rows: rows.length, more: !!marker });
    // What is SAFE to bank so far: every ledger strictly below the last row's.
    // A page boundary can split a ledger, so that ledger is withheld and
    // re-read on resume; forward order makes everything below it complete.
    if (marker && rows.length && typeof opts.onProgress === 'function') {
      const through = rows[rows.length - 1].ledger_index - 1;
      if (through >= from) {
        opts.onProgress({ address, from, through, pages, cold: !!edge.cold,
          rows: rows.filter(r => r.ledger_index <= through) });
      }
    }
  } while (marker);

  const merged = T.mergeSightings(rows);
  if (merged.some(r => r.conflicts.length)) throw new Error('CONFLICTING_TRANSACTION_SIGHTINGS');

  // The cross-check, read AFTER the walk and pinned to the same anchor, so both
  // describe one instant.
  const observed = await reader.balance(address, anchor.ledger, lane);
  const reconciliation = B.reconcile({
    address, rows: merged,
    edge: { from_ledger: from, through_ledger: anchor.ledger },
    previous: { drops: entry && entry.balance_drops, ledger: entry && entry.balance_ledger },
    current: observed || {}
  });

  const last = merged.length ? merged.reduce((a, b) => b.ledger_index > a.ledger_index ? b : a) : null;
  return {
    address, status: 'COMPLETE', rows: merged, edge,
    proof: { from_ledger: from, through_ledger: anchor.ledger, pages,
      requests: reader.stats.requests - before, endpoint: lane ? lane.endpoint : null },
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
// ── A COMMIT ADDS TO A DAY; IT DOES NOT REPLACE ONE ───────────────────────
//
// This built a day's files from THIS RUN's rows alone, and the commit wrote
// them by path — so whatever the day already held was overwritten. Events
// survived by accident, because a busy day spills into events.001/.002 and a
// one-shard run never overwrites the numbered ones. Participants fit in a
// single file and were destroyed outright. From the repository's own history
// of evidence/2026/09/14/participants.ndjson.gz:
//
//   138,518 rows -> 102,873 -> 17
//
// 102,856 rows of provenance gone, and with them every attribution the report
// makes: provenance is the link between a transaction and the watched wallet
// whose walk saw it.
//
// The invariant, stated once: ONCE PROVENANCE FOR A TRANSACTION IS COMMITTED,
// A LATER RUN MUST NOT SILENTLY ERASE IT. So `prior` carries what each affected
// day already holds and is merged in here, deduped on the identity each record
// type already has — the same keys the sort orders use, so a merged day is
// byte-identical whichever run wrote it.
//
// Only days receiving new rows appear in byDay, so only those are read and
// rewritten. A reporting window that merely READS other days does not touch
// them.
function buildShards(rows, prior) {
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
  // Prior records first so they are the ones kept on a tie, then this run's.
  // `keep` is the identity of each record type: an event is its hash, a
  // provenance row is (hash, address, role) — the same triple the day's sort
  // order uses — and a payload is its hash.
  const mergeBy = (keep, previous, fresh) => {
    const out = [], seen = new Set();
    for (const record of (previous || []).concat(fresh)) {
      const id = keep(record);
      if (seen.has(id)) continue;
      seen.add(id); out.push(record);
    }
    return out;
  };
  const eventId = e => String(e.hash);
  const participantId = p => p.tx_hash + '|' + p.address + '|' + p.role;
  const payloadId = p => String(p.hash);

  for (const day of [...byDay.keys()].sort()) {
    const base = 'evidence/' + X.dayPath(day);
    const bucket = byDay.get(day);
    const was = (prior && prior[day]) || {};
    emit(mergeBy(eventId, was.events, bucket.events), X.orderEvents, base + '/events.ndjson');
    // Deduped per (hash, address, role): the same transaction seen by two
    // watched wallets contributes both observations, once each — and a row
    // already committed by an earlier run is one of them.
    emit(mergeBy(participantId, was.participants, bucket.participants),
      X.orderParticipants, base + '/participants.ndjson');
    emit(mergeBy(payloadId, was.payloads, bucket.payloads), X.orderPayloads, base + '/payloads.ndjson');
  }
  return { files, shards };
}

// ── THE ENDING, ONE DAY AT A TIME ──────────────────────────────────────────
//
// buildShards above takes every row of the commit as one array. That is fine
// for a morning's delta and fatal for a stalled week's: on 21 Sep the journal
// held 419,380 rows — 1.16 GB of decompressed JSON — and reading them into one
// array took 1.3 GB of heap before the merge began. Vercel killed the instance
// for running out of memory, twice in a row, with all 418 wallets proven.
//
// So the commit is STAGED instead. Each row is read once and split in two:
// the raw ledger payload goes into a gzipped per-day bucket as text, keyed by
// which sighting it came from, and the slim remainder — everything the event
// and provenance rows are built from — into another. What stays resident is
// one small entry per distinct hash saying which sighting's payload the merge
// would keep. Then each day is built on its own: its slim rows are merged, the
// day's stored files are read, the three outputs are sharded and gzipped, and
// the day's buckets are released before the next day begins. The working set
// is one day, not the window.
//
// The rule for which payload survives is mergeSightings' own — the first
// sighting's, unless a later one carries strictly more AffectedNodes — applied
// here to a pointer instead of to the payload. The suite holds this builder to
// byte-identical output against buildShards for the same rows.
const STAGE_CHUNK_BYTES = 4 * 1024 * 1024;

class DayPartition {
  constructor(chunkBytes) {
    this.limit = chunkBytes || STAGE_CHUNK_BYTES;
    this.buckets = new Map();
  }
  bucket(day, kind) {
    const key = day + ' ' + kind;
    let b = this.buckets.get(key);
    if (!b) { b = { day, pending: [], bytes: 0, chunks: [] }; this.buckets.set(key, b); }
    return b;
  }
  add(day, kind, line) {
    const b = this.bucket(day, kind);
    b.pending.push(line); b.bytes += line.length + 1;
    if (b.bytes >= this.limit) this.flush(b);
  }
  flush(b) {
    if (!b.pending.length) return;
    // Level 1: this is a holding pen, not the archive. It is decompressed
    // again minutes from now and the archive's own shards are gzipped at 6.
    b.chunks.push(zlib.gzipSync(Buffer.from(b.pending.join('\n') + '\n', 'utf8'), { level: 1 }));
    b.pending = []; b.bytes = 0;
  }
  days() { return [...new Set([...this.buckets.values()].map(b => b.day))].sort(); }
  // Hands the lines back and FORGETS them: a day is read out exactly once.
  take(day, kind) {
    const key = day + ' ' + kind;
    const b = this.buckets.get(key);
    if (!b) return [];
    this.flush(b);
    const lines = [];
    for (const chunk of b.chunks) {
      for (const line of zlib.gunzipSync(chunk).toString('utf8').split('\n')) if (line) lines.push(line);
    }
    this.buckets.delete(key);
    return lines;
  }
  packedBytes() {
    let n = 0;
    for (const b of this.buckets.values()) for (const c of b.chunks) n += c.length;
    return n;
  }
}

class Stage {
  constructor(opts) {
    this.partition = new DayPartition(opts && opts.chunkBytes);
    this.best = new Map();     // hash -> { sid, nodes, has }
    this.total = 0;            // rows ingested, sightings included
    this.nextSid = 0;
  }
  ingest(row) {
    // A row with no hash is not evidence; mergeSightings drops it, and so does this.
    if (!row || !row.hash) return;
    const day = X.dayOf(row.close_time_iso);
    if (!day) throw new Error('ROW_WITHOUT_CLOSE_TIME');
    const sid = this.nextSid++;
    this.total++;
    const payload = X.payloadOf(row);
    const has = X.hasPayload(payload);
    const nodes = ((row.raw_meta && row.raw_meta.AffectedNodes) || []).length;
    const prior = this.best.get(row.hash);
    if (!prior) this.best.set(row.hash, { sid, nodes, has });
    else if (nodes > prior.nodes) { prior.sid = sid; prior.nodes = nodes; prior.has = has; }
    if (has) this.partition.add(day, 'payloads', sid + ' ' + row.hash + ' ' + JSON.stringify(payload));
    const { raw_tx, raw_meta, ...slim } = row;   // eslint-disable-line no-unused-vars
    this.partition.add(day, 'rows', JSON.stringify(slim));
  }
}

// Pass one over the journal. Every shard is hash-checked by the reader before
// a row of it is delivered; a failure here is the journal's, and the caller
// treats it as such. The rows are not kept.
async function stageJournal(journal, deps) {
  const d = deps || {};
  const stage = new Stage({ chunkBytes: d.chunkBytes });
  await Store.readJournalRowsEach(journal, { env: d.env, gh: d.gh, fetch: d.fetch,
    prefetch: d.prefetch, onShard: d.onShard }, row => stage.ingest(row));
  return stage;
}

// Pass two: one day at a time, in day order, so the shard list comes out in
// the order buildShards produced it. `keep_days` names the days whose merged
// slim rows the caller wants back — the report window's, so the response can
// carry what it always carried for those days and nothing for the rest.
async function buildDays(stage, input, deps) {
  const d = deps || {};
  const phase = (name, detail) => { if (typeof d.onPhase === 'function') d.onPhase(name, detail || {}); };
  const store = { env: d.env, gh: d.gh, fetch: d.fetch };
  const keep = new Set((input && input.keep_days) || []);
  const files = {}, shards = [], kept = [];
  const emit = (records, order, basePath) => {
    if (!records.length) return;
    for (const piece of X.shard(records.slice().sort(order), basePath, X.MAX_SHARD_BYTES)) {
      const packed = gz(piece.text);
      const path = piece.path + '.gz';
      files[path] = packed;
      shards.push({ path, sha256: X.sha256(packed), rows: piece.records.length });
    }
  };
  const mergeBy = (key, previous, fresh) => {
    const out = [], seen = new Set();
    for (const record of (previous || []).concat(fresh)) {
      const id = key(record);
      if (seen.has(id)) continue;
      seen.add(id); out.push(record);
    }
    return out;
  };
  const eventId = e => String(e.hash);
  const participantId = p => p.tx_hash + '|' + p.address + '|' + p.role;
  // The hash is the first field of every payload line this code has ever
  // written, so it is read off the text; a line shaped any other way is parsed.
  const hashOfLine = line => {
    const m = /^\{"hash":"([^"\\]*)"/.exec(line);
    if (m) return m[1];
    try { return String(JSON.parse(line).hash); } catch (_) { return null; }
  };

  for (const day of stage.partition.days()) {
    const base = 'evidence/' + X.dayPath(day);
    const tDay = Date.now();
    const merged = T.mergeSightings(stage.partition.take(day, 'rows').map(line => JSON.parse(line)));
    if (keep.has(day)) for (const row of merged) kept.push(row);
    const events = [], participants = [];
    for (const row of merged) {
      const event = X.eventOf({ ...row, close_time: row.close_time_iso });
      if (!X.dayOf(event.close_time)) throw new Error('ROW_WITHOUT_CLOSE_TIME');
      events.push(event);
      for (const p of T.participantsOf(row)) participants.push(X.participantOf(p));
    }
    // What the day already holds, read before it is written, because a commit
    // ADDS to a day rather than replacing it. Only this day: a run that merely
    // reports on other days does not cause them to be rewritten.
    phase('day-merge-read', { day, rows: merged.length });
    const [pe, pp, pl] = await Promise.all([
      Store.readDays([day], store),
      Store.readDays([day], store, 'participants'),
      Store.readDays([day], store, 'payloads', { lines: true })
    ]);
    phase('day-merge-read-done', { day, events: pe.events.length, participants: pp.events.length,
      payloads: pl.lines.length, took_ms: Date.now() - tDay });
    emit(mergeBy(eventId, pe.events, events), X.orderEvents, base + '/events.ndjson');
    emit(mergeBy(participantId, pp.events, participants), X.orderParticipants, base + '/participants.ndjson');

    // Payloads are merged as TEXT. Stored lines first so they are the ones
    // kept on a tie, then this commit's — one per hash, the sighting the merge
    // rule chose — ordered by hash and split by the same cap as everything else.
    const seen = new Set(), lines = [];
    for (const line of pl.lines) {
      const h = hashOfLine(line);
      if (h === null || seen.has(h)) continue;
      seen.add(h); lines.push({ h, line });
    }
    for (const tagged of stage.partition.take(day, 'payloads')) {
      const sp1 = tagged.indexOf(' '), sp2 = tagged.indexOf(' ', sp1 + 1);
      const sid = Number(tagged.slice(0, sp1)), h = tagged.slice(sp1 + 1, sp2);
      const chosen = stage.best.get(h);
      if (!chosen || chosen.sid !== sid || !chosen.has || seen.has(h)) continue;
      seen.add(h); lines.push({ h, line: tagged.slice(sp2 + 1) });
    }
    lines.sort((a, b) => a.h < b.h ? -1 : (a.h > b.h ? 1 : 0));
    if (lines.length) {
      for (const piece of X.shardLines(lines.map(l => l.line), base + '/payloads.ndjson', X.MAX_SHARD_BYTES)) {
        const packed = gz(piece.text);
        const path = piece.path + '.gz';
        files[path] = packed;
        shards.push({ path, sha256: X.sha256(packed), rows: piece.lines.length });
      }
    }
    phase('day-built', { day, events: events.length, took_ms: Date.now() - tDay });
  }
  return { files, shards, transactions: stage.best.size, rows: kept };
}

// The UTC days a report window touches — the same walk readReportWindow does.
function windowDays(run) {
  const from = Number(run && run.window_start_ms), to = Number(run && run.window_end_ms);
  if (!Number.isFinite(from) || !Number.isFinite(to) || to < from) return [];
  const days = [];
  const start = new Date(from);
  for (let t = Date.UTC(start.getUTCFullYear(), start.getUTCMonth(), start.getUTCDate()); t <= to; t += 86400000) {
    days.push(new Date(t).toISOString().slice(0, 10));
  }
  return days;
}

// Wallets that did not complete, grouped by the reason they did not. Keeps
// every address — nothing is summarised away — but says each reason once.
function groupByCause(results) {
  const byCause = new Map();
  for (const r of results) {
    const cause = (r && r.error) || 'UNKNOWN';
    if (!byCause.has(cause)) byCause.set(cause, { error: cause, wallets: 0, addresses: [], max_attempts: 0 });
    const bucket = byCause.get(cause);
    bucket.wallets++;
    bucket.addresses.push(r && r.address);
    bucket.max_attempts = Math.max(bucket.max_attempts, (r && r.attempts) || 0);
  }
  return [...byCause.values()].sort((a, b) => b.wallets - a.wallets);
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
  // Each lane reports the moment it lands. Between "start" and the first wallet
  // line there is otherwise a silent gap covering the GitHub read, the XRPL
  // connect and the anchor pin — and a stall in any of them looks identical to
  // a slow first wallet. That ambiguity is the same one the per-wallet stream
  // was built to remove; it just moved one level up.
  const phase = (name, detail) => { if (typeof d.onPhase === 'function') d.onPhase(name, detail || {}); };
  const [loaded, header, journalRead] = await Promise.all([
    Store.readState({ env: d.env, gh: d.gh, fetch: d.fetch })
      .then(r => { phase('state', { seeded: !r.missing,
        state_version: r.state ? r.state.state_version : null,
        wallets: r.state ? r.state.wallet_count : 0 }); return r; }),
    reader.ledger('validated')
      .then(h => { phase('anchor', { ledger: h.ledger,
        endpoint: reader.stats.actual_endpoint || null }); return h; }),
    // A third independent lane. An absent journal is the normal case and costs
    // one 404; a present one is a previous run that did not finish.
    Store.readJournal({ env: d.env, gh: d.gh, fetch: d.fetch })
      .then(r => r, e => ({ journal: null, missing: true, error: e.message }))
  ]);
  if (loaded.missing) throw new Error('EVIDENCE_STATE_MISSING: seed the checkpoint from a sealed report before the first run');
  const state = loaded.state;
  // One anchor, shared by every wallet, so wallet 3 and wallet 200 describe the
  // same ledger state.
  let anchor = { ledger: header.ledger, close_ms: header.close_ms, close_iso: new Date(header.close_ms).toISOString() };

  // ── RESUMING ────────────────────────────────────────────────────────────
  //
  // A resumed run must finish against the anchor the interrupted one pinned.
  // Picking a fresh one would leave the wallets walked before the disconnect
  // proven to a different ledger than the ones walked after it, and the state
  // would describe an instant that never existed. So the journal's anchor wins,
  // the window ends slightly earlier than "now", and the result says so.
  // ── THE ROWS ARE NOT READ UNTIL THEY ARE NEEDED ─────────────────────────
  //
  // Measured on a live resume: reading 121,409 journalled rows back took NINETY
  // SECONDS of a 240-second budget, before a single wallet was walked. The
  // journal exists to save work and at that size it was spending more than it
  // saved — and getting worse every run, because each run journals more.
  //
  // But those rows are needed for exactly one thing: the commit. A run that
  // does not finish its roster never reaches it. So the manifest is read at the
  // start (it is small, and it says which wallets to skip) and the rows are
  // fetched only once the whole-run gate has actually passed. The cost lands on
  // the run that finishes, not on every run that does not.
  let journal = null, resumed = null;
  const stale = journalRead && !journalRead.missing && journalRead.journal
    ? Journal.usable(journalRead.journal, state) : null;
  // usable() is pure and cannot see the branch, so it cannot know whether the
  // blobs behind the manifest still exist. They are checked HERE, before the
  // journal is adopted, because adopting it means treating its wallets as
  // already walked — and a wallet whose rows are gone is not walked, it is
  // merely claimed. Left to commit time this surfaced as a refusal no run could
  // clear; found here it is one discard and an honest re-walk.
  let missingShards = [];
  if (journalRead && !journalRead.missing && journalRead.journal && stale && stale.ok) {
    try {
      missingShards = await Store.missingJournalShards(journalRead.journal,
        { env: d.env, gh: d.gh, fetch: d.fetch });
    } catch (e) {
      // If the branch cannot be listed, the journal cannot be shown to be
      // sound. Refuse it rather than adopt it on the strength of a read that
      // did not happen.
      missingShards = ['SHARD_PRESENCE_UNKNOWN: ' + e.message];
    }
  }
  if (journalRead && !journalRead.missing &&
      (journalRead.unreadable || (stale && !stale.ok) || missingShards.length)) {
    // Refused. Discard it rather than leave it to be refused again every
    // morning from here on, and say why.
    resumed = { adopted: false,
      reason: journalRead.unreadable ? 'JOURNAL_UNREADABLE'
        : (missingShards.length ? 'JOURNAL_SHARDS_MISSING' : stale.problems.join(',')),
      missing_shards: missingShards.length || undefined,
      missing_shard_paths: missingShards.length ? missingShards.slice(0, 5) : undefined,
      report_id: journalRead.journal ? journalRead.journal.report_id : null };
    phase('journal', resumed);
    try {
      const discarded = await Store.clearJournal(journalRead.journal,
        { env: d.env, gh: d.gh, fetch: d.fetch });
      resumed.discard_status = discarded && discarded.status;
    } catch (e) { resumed.discard_error = e.message; }
  } else if (journalRead && journalRead.journal && stale && stale.ok) {
    journal = journalRead.journal;
    anchor = { ledger: Number(journal.anchor_ledger), close_ms: null,
      close_iso: journal.anchor_close || null };
    resumed = { adopted: true, report_id: journal.report_id, segments: journal.segments,
      wallets_already_walked: Journal.doneAddresses(journal).size,
      wallets_partial: Journal.partialRecords(journal).size,
      rows_awaiting_load: (journal.row_shards || []).reduce((n, sh) => n + (Number(sh.rows) || 0), 0),
      anchor_ledger: anchor.ledger, started_at: journal.started_at };
    const journalCloseMs = journal.anchor_close ? Date.parse(journal.anchor_close) : NaN;
    const behindMs = (Number.isFinite(header.close_ms) && Number.isFinite(journalCloseMs))
      ? header.close_ms - journalCloseMs : null;
    const behindLedgers = Number(header.ledger) - Number(journal.anchor_ledger);
    // Either signal is enough. A server that reported a stale close time, or a
    // journal that never recorded one, must not be able to keep an old anchor
    // pinned by making the other signal unreadable.
    const staleJournal = (behindMs !== null && behindMs > STALE_JOURNAL_MS) ||
      behindLedgers > STALE_JOURNAL_LEDGERS;
    if (staleJournal) {
      const liveClose = new Date(header.close_ms).toISOString();
      journal = Journal.reanchor(journal, { anchor_ledger: header.ledger, anchor_close: liveClose, by: run.report_id });
      anchor = { ledger: header.ledger, close_ms: header.close_ms, close_iso: liveClose };
      resumed.reanchored = { from_ledger: Number(journalRead.journal.anchor_ledger),
        from_close: journalRead.journal.anchor_close || null,
        to_ledger: header.ledger, to_close: liveClose,
        behind_ms: behindMs, behind_ledgers: behindLedgers };
      // Nothing is finished against the NEW anchor; everything banked is partial.
      resumed.wallets_already_walked = 0;
      resumed.wallets_partial = journal.wallets.length;
      resumed.anchor_ledger = anchor.ledger;
    }
    phase('journal', resumed);
  }

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
  // A resumed run admits exactly who the interrupted one admitted. Re-deciding
  // it against a roster that may have changed since would leave the journal's
  // wallets and this run's wallets describing two different rosters.
  const admitted = journal ? (journal.admitted_wallets || []).slice() : waiting.slice(0, maxAdmissions);
  const deferred = journal ? waiting.filter(a => admitted.indexOf(a) < 0) : waiting.slice(admitted.length);
  // And the other direction. A wallet the state knows but the roster no longer
  // lists is NOT dropped: retiring a watched wallet is a decision, and a run
  // does not infer a decision from a list it was handed. It keeps being walked
  // and the discrepancy is reported, which is the difference between noticing
  // an edit and obeying one.
  const rosterAbsent = rosterList
    ? state.wallets.map(w => w.address).filter(a => !rosterList.includes(a)) : [];
  const coldWindow = Math.max(1, Number(run.cold_window_ledgers) || COLD_WINDOW_LEDGERS);
  // Same reasoning: the horizon a resumed run buys is the one already bought,
  // so the wallets admitted before the disconnect and after it share it.
  const coldFrom = journal && Number(journal.cold_from_ledger)
    ? Number(journal.cold_from_ledger) : Math.max(1, anchor.ledger - coldWindow + 1);

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
  const roster = state.wallets.concat(
    admitted.map(address => State.walletEntry({ address })));
  // Wallets a previous attempt already finished. Their evidence is recovered
  // from the journal rather than re-fetched: the rows were validated when they
  // were walked and the file they came from was hash-checked on the way in.
  const alreadyWalked = journal
    ? journal.wallets.filter(w => Number(w.proven_through) === anchor.ledger) : [];
  const walkedSet = new Set(alreadyWalked.map(w => w.address));
  // Partial progress from an earlier attempt. The wallet resumes one past the
  // ledger it banked through, carrying the balance that bank was reconciled
  // to, so this leg's reconciliation joins the previous one instead of
  // comparing the old checkpoint against half the rows.
  const partials = journal ? Journal.partialRecords(journal) : new Map();
  const partialContradicted = new Set();
  const entries = roster.filter(e => !walkedSet.has(e.address)).map(e => {
    const p = partials.get(e.address);
    if (!p) return e;
    if (p.reconciliation === B.STATUS.CONTRADICTION) partialContradicted.add(e.address);
    const banked = p.entry || {};
    return State.walletEntry({ ...e,
      last_proven_ledger: p.proven_through, last_proven_close: null,
      last_observed_tx_ledger: banked.last_observed_tx_ledger !== undefined ? banked.last_observed_tx_ledger : e.last_observed_tx_ledger,
      last_observed_tx_hash: banked.last_observed_tx_hash !== undefined ? banked.last_observed_tx_hash : e.last_observed_tx_hash,
      balance_drops: banked.balance_drops, balance_ledger: banked.balance_ledger,
      admitted_at_ledger: banked.admitted_at_ledger !== undefined ? banked.admitted_at_ledger : e.admitted_at_ledger,
      history_from_ledger: banked.history_from_ledger !== undefined ? banked.history_from_ledger : e.history_from_ledger });
  });
  // ── HEAVIEST FIRST ─────────────────────────────────────────────────────
  // The walk was alphabetical, and rw… sorts last: COINBASE_HOT and
  // BITHUMB_HOT started after four hundred light wallets had spent the budget,
  // every morning.
  //
  // The first version of this rule put PARTIAL wallets first. On 21 Sep, after
  // two re-anchors, every wallet was partial except the three that had never
  // once fitted in a budget — COINBASE_HOT, BITHUMB_HOT and one small one —
  // so the rule put the two wallets that caused the wedge behind all 391
  // others. Backwards.
  //
  // Cost, as best the journal can estimate it. A wallet the journal has NO
  // record of is the one most likely to be unfinishable and goes first. Among
  // the rest, the rows already banked say how busy a wallet is; recency breaks
  // ties for wallets that have banked nothing.
  const banked = e => partials.has(e.address) ? (Number(partials.get(e.address).rows) || 0) : -1;
  const unknown = e => (journal && !partials.has(e.address) && !walkedSet.has(e.address)) ? 1 : 0;
  const recency = e => Number(e.last_observed_tx_ledger) || 0;
  entries.sort((a, b) => (unknown(b) - unknown(a)) || (banked(b) - banked(a)) || (recency(b) - recency(a)) ||
    (String(a.address) < String(b.address) ? -1 : (String(a.address) > String(b.address) ? 1 : 0)));
  phase('plan', { wallets: roster.length, to_walk: entries.length,
    recovered: alreadyWalked.length, resuming_partial: partials.size,
    proven: state.wallets.length,
    admitting: admitted.length, awaiting: deferred.length,
    cold_from_ledger: admitted.length ? coldFrom : null,
    reanchored: !!(resumed && resumed.reanchored) });
  // Said out loud, because "it stopped starting wallets with a minute left"
  // looks like a bug until you know the minute was spoken for.
  if (journal && journal.row_shards && journal.row_shards.length) {
    phase('reserve', { banked_rows: (journal.row_shards || [])
      .reduce((n, sh) => n + (Number(sh.rows) || 0), 0) });
  }

  // The journal is created in memory and written on the first flush. Creating
  // it up front would cost a commit before a single wallet had been walked,
  // for a run that may well finish without ever needing it.
  if (!journal) {
    journal = Journal.begin({ report_id: run.report_id, scan_id: run.scan_id || null,
      started_at: run.sealed_at || new Date(Date.now()).toISOString(),
      from_state_version: state.state_version, from_state_sha256: state.state_sha256,
      anchor_ledger: anchor.ledger, anchor_close: anchor.close_iso,
      cold_from_ledger: admitted.length ? coldFrom : null,
      admitted_wallets: admitted });
  }
  let journalWritten = journal.segments > 0;
  const results = new Array(entries.length);
  const concurrency = Math.max(1, Math.min(Number(d.concurrency) || DEFAULT_CONCURRENCY, 8));
  let cursor = 0;

  // ── WRITING THE WORK DOWN AS IT GOES ────────────────────────────────────
  //
  // Not the checkpoint — the WORK. Each flush records which wallets finished
  // and the rows behind them, so a run that dies at wallet 240 resumes at 241
  // instead of paying XRPL a second time for 240 wallets it already walked.
  //
  // Appends are serialised through one promise chain. The workers run
  // concurrently, but two concurrent appends would each build on the same
  // parent commit and one of them would be lost.
  const flushEvery = Math.max(1, Math.min(Number(d.journalEvery) || DEFAULT_JOURNAL_EVERY, 200));
  const flushed = new Set();
  let flushing = Promise.resolve(), journalError = null, reported = 0;
  // ── PARTIAL PROGRESS, PER WALLET ─────────────────────────────────────────
  // progress[i] is the newest page-by-page state of an in-flight walk; the
  // banked* arrays are what has actually been written down and reconciled.
  const progress = new Array(entries.length);
  const bankedThrough = new Array(entries.length);
  const bankedBalance = new Array(entries.length);
  const bankedRowCount = new Array(entries.length).fill(0);
  const bankedContradiction = new Array(entries.length).fill(false);
  entries.forEach((e, i) => { if (partialContradicted.has(e.address)) bankedContradiction[i] = true; });

  const writeSegment = async (batch, partialBatch) => {
    const wallets = batch.map(({ i, r }) => Journal.walletRecord({
      address: r.address, proven_from: r.proof.from_ledger, proven_through: r.proof.through_ledger,
      // Only what is not already in a partial shard from THIS run.
      rows: r.rows.filter(row => bankedThrough[i] === undefined || row.ledger_index > bankedThrough[i]).length,
      reconciliation: r.reconciliation && r.reconciliation.status,
      entry: r.next_entry }));
    const rows = batch.flatMap(({ i, r }) =>
      r.rows.filter(row => bankedThrough[i] === undefined || row.ledger_index > bankedThrough[i]));
    // A partial leg is banked only once it is RECONCILED against a balance
    // pinned at the ledger it reaches. Without that, the next run would compare
    // the old checkpoint balance against half the rows and manufacture a
    // contradiction. If the balance cannot be read now, the leg waits.
    const landed = [];
    for (const { i, p } of (partialBatch || [])) {
      const prevThrough = bankedThrough[i] !== undefined ? bankedThrough[i] : p.from - 1;
      const legRows = p.rows.filter(row => row.ledger_index > prevThrough);
      let observed = null;
      try { observed = await reader.balance(p.address, p.through, null); } catch (_) { observed = null; }
      if (!observed || Number(observed.ledger) !== p.through) continue;
      const previous = bankedBalance[i] || { drops: p.entry && p.entry.balance_drops, ledger: p.entry && p.entry.balance_ledger };
      const rec = B.reconcile({ address: p.address, rows: legRows,
        edge: { from_ledger: prevThrough + 1, through_ledger: p.through }, previous, current: observed });
      const last = legRows.length ? legRows[legRows.length - 1] : null;
      const entry = State.walletEntry({ ...(p.entry || {}), address: p.address,
        last_proven_ledger: p.through, last_proven_close: null,
        last_observed_tx_ledger: last ? last.ledger_index : (p.entry && p.entry.last_observed_tx_ledger),
        last_observed_tx_hash: last ? last.hash : (p.entry && p.entry.last_observed_tx_hash),
        balance_drops: observed.drops, balance_ledger: observed.ledger,
        reconciliation: rec.status,
        admitted_at_ledger: p.cold ? anchor.ledger : (p.entry && p.entry.admitted_at_ledger),
        history_from_ledger: p.cold ? p.from : (p.entry && p.entry.history_from_ledger) });
      wallets.push(Journal.walletRecord({ address: p.address, proven_from: prevThrough + 1,
        proven_through: p.through, rows: legRows.length, reconciliation: rec.status, entry }));
      for (const row of legRows) rows.push(row);
      landed.push({ i, through: p.through, balance: observed, rows: legRows.length,
        contradicted: B.contradicted(rec) });
    }
    if (!wallets.length && !rows.length) return;
    const written = await Store.appendJournal(journal,
      { wallets, rows }, { env: d.env, gh: d.gh, fetch: d.fetch });
    journal = written.journal; journalWritten = true;
    for (const l of landed) {
      bankedThrough[l.i] = l.through; bankedBalance[l.i] = l.balance;
      bankedRowCount[l.i] += l.rows; if (l.contradicted) bankedContradiction[l.i] = true;
    }
    phase('journal-flush', { segment: journal.segments, wallets_recorded: Journal.doneAddresses(journal).size,
      partial_recorded: Journal.partialRecords(journal).size, commit_sha: written.commit_sha });
  };

  let lastFlushAt = Date.now();
  const maybeFlush = async force => {
    const batch = [];
    for (let i = 0; i < results.length; i++) {
      const r = results[i];
      if (r && r.status === 'COMPLETE' && !flushed.has(i)) batch.push({ i, r });
    }
    const overdue = Date.now() - lastFlushAt >= JOURNAL_INTERVAL_MS;
    // Partial legs go out with a forced or overdue flush, never on the count:
    // each costs a pinned balance read, and a walk that will finish inside the
    // next few seconds should not pay it.
    const partialBatch = [];
    if (force || overdue) {
      for (let i = 0; i < entries.length; i++) {
        const p = progress[i];
        if (!p || (results[i] && results[i].status === 'COMPLETE')) continue;
        if (p.through > (bankedThrough[i] !== undefined ? bankedThrough[i] : -1)) partialBatch.push({ i, p });
      }
    }
    if ((!batch.length && !partialBatch.length) || (!force && !overdue && batch.length < flushEvery)) return;
    lastFlushAt = Date.now();
    for (const b of batch) flushed.add(b.i);
    flushing = flushing.then(() => writeSegment(batch, partialBatch)).catch(e => {
      // A journal that cannot be written is a lost optimisation, never a lost
      // run: the walk continues and the whole-run gate is untouched. The
      // wallets are unmarked so a later flush can try again — record() refuses
      // duplicates, and a failed append left the journal unadvanced, so
      // retrying cannot double-count them.
      for (const b of batch) flushed.delete(b.i);
      journalError = journalError || e.message;
    });
    await flushing;
  };

  // Per-wallet recovery. One sick endpoint must not turn the run into 0/255, so
  // a wallet that fails is retried — and because the Reader rotates endpoints
  // on a transport failure, a retry is usually a different server. Attempts are
  // bounded and every one is recorded: a wallet that took three tries is not
  // the same fact as one that answered first time.
  const attemptsPerWallet = Math.max(1, Math.min(Number(d.attempts) || 3, 5));
  // Injectable so the suite can exercise the budget paths without spending a
  // real twenty-five seconds to reach them.
  // ── THE RESERVE HAS TO PAY FOR THE ENDING, NOT JUST STOP STARTING ───────
  //
  // A flat 25 seconds was enough when the ending was one small commit. It is
  // not enough now: a run holding 165,000 banked rows has to READ them back
  // (25 seconds, measured) and then gzip, blob and commit them, and if it
  // spends its last second starting another wallet it has nothing left to
  // finish with. That is why a run reached 266 of 267 and still committed
  // nothing — it was not short of wallets, it was short of ending.
  //
  // So the reserve grows with what is banked. Roughly a second per five
  // thousand journalled rows on top of the floor, which covers the measured
  // read and leaves room for the write.
  const bankedRows = journal
    ? (journal.row_shards || []).reduce((n, sh) => n + (Number(sh.rows) || 0), 0) : 0;
  const startReserveMs = Number.isFinite(Number(d.startReserveMs))
    ? Math.max(0, Number(d.startReserveMs))
    : START_RESERVE_MS + Math.ceil(bankedRows / 5000) * 1000;
  // ── ONE LANE FOR THE LIGHT END ───────────────────────────────────────────
  // Heavy-first with every worker pulling from the front means every lane is
  // held by a heavy wallet for the whole budget — 684 wallets "never started"
  // across two runs on 21 Sep, most of them a single page. So the last worker
  // pulls from the LIGHT end instead: the heavies grind on the other lanes
  // while a hundred-odd light wallets a run finish behind them. The two ends
  // meet in the middle; no wallet is handed out twice.
  let tailCursor = entries.length - 1;
  const take = fromTail => {
    if (cursor > tailCursor) return -1;
    return fromTail ? tailCursor-- : cursor++;
  };
  const worker = async (fromTail) => {
    for (;;) {
      const index = take(fromTail);
      if (index < 0) return;
      const entry = entries[index];
      // Do not start what cannot finish. A wallet begun with seconds left is
      // cut off mid-walk, and a partial walk proves nothing and cannot be
      // written down — it is simply thrown away. Stopping here turns that into
      // a flush and a resume that starts on this wallet next time.
      if (reader.deadline && reader.deadline - Date.now() < startReserveMs) {
        results[index] = { address: entry.address, status: 'NOT_ATTEMPTED',
          error: 'RUN_BUDGET_EXHAUSTED', attempts: 0, earlier_failures: [], rows: [] };
        if (typeof d.onWallet === 'function') {
          d.onWallet(results[index], alreadyWalked.length + (++reported), roster.length);
        }
        continue;
      }
      const tried = [];
      for (let attempt = 1; attempt <= attemptsPerWallet; attempt++) {
        try {
          const walked = await walkWallet(reader, entry, anchor,
            { scanId: run.scan_id, rosterHash: state.state_sha256, coldFrom,
              onPage: d.onPage,
              onProgress: p => { progress[index] = { ...p, entry }; } });
          // A contradiction on a banked leg — this run's or an earlier one's —
          // is a contradiction for the wallet, whatever the final leg says.
          if (bankedContradiction[index] && walked.status === 'COMPLETE') {
            walked.reconciliation = { ...(walked.reconciliation || {}),
              status: B.STATUS.CONTRADICTION, reason: 'PARTIAL_LEG_CONTRADICTED' };
          }
          results[index] = { ...walked, attempts: attempt, earlier_failures: tried };
          break;
        } catch (e) {
          tried.push({ attempt, error: e.message, endpoint: reader.stats.actual_endpoint || null });
          // OUT OF BUDGET IS NOT A BROKEN WALLET. The admission clock throws
          // this when the wait it would have to impose runs past the run's
          // deadline — it means "there is no time left", not "this wallet
          // would not answer". Retrying it three times burns through the rest
          // of the roster in seconds and reports two hundred healthy wallets
          // as failures, which is what a live run actually did.
          if (e.pending) {
            results[index] = { address: entry.address, status: 'NOT_ATTEMPTED',
              error: 'RUN_BUDGET_EXHAUSTED', attempts: 0, earlier_failures: [], rows: [] };
            break;
          }
          // A permanent refusal will not become a success by being asked again.
          const permanent = /INVALID|MALFORMED|OUTSIDE_PROVEN_RANGE|CONFLICTING/.test(e.message);
          if (permanent || attempt === attemptsPerWallet) {
            results[index] = { address: entry.address, status: 'FAILED', error: e.message,
              attempts: attempt, earlier_failures: tried, rows: [] };
            break;
          }
        }
      }
      // Counted against the WHOLE roster, recovered wallets included, so the
      // progress bar does not restart at zero on a resumed run.
      if (typeof d.onWallet === 'function') {
        d.onWallet(results[index], alreadyWalked.length + (++reported), roster.length);
      }
      await maybeFlush(false);
    }
  };

  // ── A RUN ALWAYS COMES BACK ─────────────────────────────────────────────
  //
  // Promise.all waits for every worker, and a worker waits for its wallet. One
  // wallet that never returns therefore holds the entire run — measured live:
  // 266 of 267 wallets finished, the last one hung, and the run produced NO
  // result at all. Not a failure, not a partial: nothing. Every wallet that had
  // been walked was already journalled and safe, and the operator still saw
  // "ended with no result", which is the least useful thing a run can say.
  //
  // So the workers are RACED against the budget. When it expires we stop
  // waiting; the stragglers are named as abandoned, nothing they were part-way
  // through is journalled — a partial walk proves nothing — and the run returns
  // and says what it did.
  const workers = Promise.all(Array.from({ length: concurrency },
    (_, k) => worker(concurrency > 1 && k === concurrency - 1)));
  const budgetLeft = () => Math.max(0, (reader.deadline || 0) - Date.now());
  // NOT unref'd. This timer is the only thing keeping the process alive while a
  // hung wallet holds a promise that will never settle — an unref'd one lets
  // Node decide the loop is empty and exit silently, which produces exactly the
  // "no result at all" this whole mechanism exists to prevent. It is cleared
  // the moment the workers win, so it never delays a healthy run.
  let abandonTimer = null;
  await Promise.race([
    workers.then(() => { if (abandonTimer) clearTimeout(abandonTimer); }),
    new Promise(resolve => { abandonTimer = setTimeout(resolve, budgetLeft() || 1); })
  ]);
  // Whatever is still unfinished is unfinished. Its worker may keep running in
  // the background until the process ends; its result is not read either way.
  const abandoned = [];
  for (let i = 0; i < entries.length; i++) {
    if (results[i]) continue;
    results[i] = { address: entries[i].address, status: 'ABANDONED',
      error: 'RUN_BUDGET_EXPIRED_MID_WALK', attempts: 1, earlier_failures: [], rows: [] };
    abandoned.push(entries[i].address);
  }
  if (abandoned.length) phase('abandoned', { wallets: abandoned.length, addresses: abandoned });
  // The flush still has to land, but it must not be able to hang the run
  // either — the same lesson, one level down.
  let flushTimer = null;
  await Promise.race([
    flushing.then(() => { if (flushTimer) clearTimeout(flushTimer); },
                  () => { if (flushTimer) clearTimeout(flushTimer); }),
    new Promise(resolve => { flushTimer = setTimeout(resolve, 20000); })
  ]);

  const complete = results.filter(r => r && r.status === 'COMPLETE');
  const failed = results.filter(r => !r || r.status !== 'COMPLETE');
  // Wallets recovered from the journal count as proved because they WERE
  // proved — walked against this same anchor, their rows hash-checked on the
  // way back in. They simply were not walked by this invocation.
  const provedTotal = complete.length + alreadyWalked.length;
  const contradicted = complete.filter(r => B.contradicted(r.reconciliation))
    .map(r => ({ address: r.address, reason: r.reconciliation.reason,
      unexplained_drops: r.reconciliation.unexplained_drops || null }))
    .concat(alreadyWalked.filter(w => w.reconciliation === B.STATUS.CONTRADICTION)
      .map(w => ({ address: w.address, reason: 'RECOVERED_FROM_JOURNAL',
        unexplained_drops: null })));
  // Only what THIS attempt walked. The journalled rows join at commit time.
  const rows = T.mergeSightings(complete.flatMap(r => r.rows));
  // Every entry the state will carry: the ones recovered and the ones walked.
  const nextEntries = alreadyWalked.map(w => w.entry).concat(complete.map(r => r.next_entry));

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
    wallets_proven: provedTotal,
    wallets_walked_this_attempt: complete.length,
    wallets_recovered_from_journal: alreadyWalked.length,
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
    // Separated, because "we ran out of time before reaching it" and "it was
    // asked and would not answer" are different facts about a wallet and the
    // report must not merge them into one shrug.
    wallets_not_attempted: results.filter(r => r && r.status === 'NOT_ATTEMPTED').length,
    // Different from "not attempted": this one was STARTED and did not come
    // back before the budget expired. A part-walked wallet proves nothing and
    // is journalled as nothing, but it is not the same fact as one never begun.
    wallets_abandoned: abandoned.length,
    abandoned: abandoned.slice(),
    partial: entries.map((e, i) => ({ i, e })).filter(({ i }) => bankedThrough[i] !== undefined &&
      !(results[i] && results[i].status === 'COMPLETE'))
      .map(({ i, e }) => ({ address: e.address, proven_through: bankedThrough[i], rows: bankedRowCount[i] })),
    // Grouped by CAUSE, not one entry per wallet. A hundred wallets sharing
    // one reason is one fact about the run, and listing it a hundred times
    // made the result three times its useful size — the same addresses already
    // appear, once, in the per-wallet detail.
    unavailable: groupByCause(failed),
    contradicted: contradicted.slice()
  };
  // ── PROVEN IS A FACT THIS FILE OWNS, NOT A STRING THE CLIENT DECODES ────
  //
  // provedTotal above counts a journal-recovered wallet as proved, and says
  // why: it WAS walked against this anchor. But the per-wallet projection
  // labelled it 'RECOVERED' and the report only ever accepted 'COMPLETE', so
  // the client read 408 proved wallets as 408 failures and refused to render a
  // report against evidence the server had just told it was proven.
  //
  // The status string stays — "walked here" and "recovered from the journal"
  // are genuinely different facts about a wallet and the operator should see
  // which. What changes is that proven-ness is no longer INFERRED from it.
  // This file says `proven` outright, from the same two sets provedTotal is
  // counted from, so a third proven status can never again mean one number to
  // the server and another to the report.
  const wallets = alreadyWalked.map(w => ({
    address: w.address, status: 'RECOVERED', proven: true,
    proven_through: w.proven_through, rows: w.rows,
    reconciliation: w.reconciliation, attempts: 0, error: null
  })).concat(results.map(r => ({
    address: r && r.address, status: (r && r.status) || 'FAILED',
    proven: !!(r && r.status === 'COMPLETE'),
    proven_through: r && r.proof ? r.proof.through_ledger : null,
    rows: r && r.rows ? r.rows.length : 0,
    reconciliation: (r && r.reconciliation && r.reconciliation.status) || null,
    attempts: (r && r.attempts) || 0,
    error: (r && r.error) || null
  })));
  // A cut-off wallet with banked progress says so and says how far.
  for (const w of wallets) {
    const i = entries.findIndex(e => e.address === w.address);
    if (i < 0 || bankedThrough[i] === undefined || w.proven) continue;
    w.partial_through = bankedThrough[i];
    w.rows_banked = bankedRowCount[i];
    if (w.status === 'ABANDONED' || w.status === 'NOT_ATTEMPTED') w.error = 'WALK_INCOMPLETE_RESUMABLE';
  }
  // The projection and the count must describe the same run. If they ever
  // disagree the report is about to be told a different number than the
  // checkpoint gate used, which is the defect this block exists to end.
  if (wallets.filter(w => w.proven).length !== provedTotal) {
    throw new Error('PROVEN_PROJECTION_DISAGREES_WITH_COUNT: ' +
      wallets.filter(w => w.proven).length + ' vs ' + provedTotal);
  }

  const summary = {
    report_id: run.report_id, scan_id: run.scan_id || null,
    anchor_ledger: anchor.ledger, anchor_close: anchor.close_iso,
    state_version_read: state.state_version,
    target_wallets: roster.length, complete_wallets: provedTotal,
    wallets_walked_this_attempt: complete.length,
    wallets_recovered_from_journal: alreadyWalked.length,
    resumed: resumed || null,
    journal_error: journalError,
    failed_wallets: failed.length,
    not_attempted_wallets: results.filter(r => r && r.status === 'NOT_ATTEMPTED').length,
    abandoned_wallets: abandoned.length,
    // Started, cut off, and written down as far as it got. Not proven — it is
    // where that wallet resumes.
    partial_wallets: bankedThrough.filter((t, i) => t !== undefined && !(results[i] && results[i].status === 'COMPLETE')).length,
    balance_contradictions: contradicted.length,
    balance_contradiction_addresses: contradicted.map(r => r.address).sort(),
    balance_reconciled: complete.filter(r => r.reconciliation && r.reconciliation.status === B.STATUS.RECONCILED).length,
    transactions: rows.length,
    // What this attempt walked, separate from what is banked. A resumed run
    // that reports only its own rows is not reporting less evidence — the rest
    // is journalled and joins at the commit — but the two must not be added up
    // into one number that means neither.
    transactions_journalled: resumed && resumed.adopted ? (resumed.rows_awaiting_load || 0) : 0,
    wallets_admitted: admitted.length,
    admitted_wallets: admitted.slice(),
    admitted_history_from_ledger: admitted.length ? coldFrom : null,
    wallets_awaiting_admission: deferred.length,
    roster_wallets: rosterList ? rosterList.length : null,
    watched_not_in_roster: rosterAbsent.slice().sort(),
    xrpl_requests: reader.stats.requests,
    failures: groupByCause(failed)
  };

  // 4. The gate. Anything short of a whole, uncontradicted run commits nothing,
  //    and the checkpoint stays exactly where it was.
  // A run that will not commit flushes whatever it finished. That is the whole
  // point of the journal: the checkpoint does not move, and the WORK is not
  // thrown away either. A run that IS about to commit skips this — the commit
  // deletes the journal in the same breath, so writing it first would be a
  // round trip to GitHub for a file that dies moments later.
  const saveWork = async () => {
    await maybeFlush(true); await flushing;
    return { journal_segments: journal.segments,
      journal_wallets: Journal.doneAddresses(journal).size,
      journal_partial_wallets: Journal.partialRecords(journal).size,
      journal_error: journalError };
  };
  // ── A RECOVERED WALLET IS PROVEN ONLY WHERE ITS ROWS ARE ────────────────
  //
  // The journal's rows are hash-checked when they are READ BACK, and that read
  // happens once, at the commit. Every path that returns BEFORE it — an
  // incomplete run, a contradicted one, an unreadable journal — has not
  // verified those bytes this run and does not carry them in `rows`, so the
  // window it returns cannot contain the recovered wallets' transactions.
  //
  // Reporting them proved there would claim two things at once that are not
  // both true: that their evidence was checked, and that the report window
  // covers them. Neither is. So on every early return they come back unproven
  // with the reason, and complete_wallets, the per-wallet detail and the
  // freshness block are recomputed together so the three agree.
  //
  // The work is NOT lost — it stays in the journal and the next run adopts it.
  // What is withheld is the CLAIM, which is the only thing that was ever
  // unearned.
  const withoutUnverifiedRecoveries = (reason) => {
    const detail = wallets.map(w => w.status === 'RECOVERED'
      ? { ...w, proven: false, error: w.error || reason } : w);
    const proved = detail.filter(w => w.proven).length;
    return {
      wallets: detail,
      complete_wallets: proved,
      failed_wallets: detail.length - proved,
      wallets_recovered_from_journal: 0,
      freshness: { ...freshness, wallets_proven: proved,
        wallets_recovered_from_journal: 0,
        wallets_unavailable: detail.length - proved }
    };
  };

  if (failed.length) {
    return { ...summary, committed: false, reason: 'RUN_INCOMPLETE', rows,
      ...withoutUnverifiedRecoveries('RECOVERED_ROWS_NOT_VERIFIED_THIS_RUN'),
      ...(await saveWork()) };
  }
  if (contradicted.length) {
    return { ...summary, committed: false, reason: 'RUN_CONTRADICTED', rows,
      ...withoutUnverifiedRecoveries('RECOVERED_ROWS_NOT_VERIFIED_THIS_RUN'),
      ...(await saveWork()) };
  }

  // ── THE GATE HAS PASSED; THE ENDING IS PAID FOR ONE DAY AT A TIME ───────
  //
  // This run WILL commit, which is the only moment the journalled rows are
  // needed. They used to be read into one array here, merged, and rebuilt into
  // day files all at once — and on 21 Sep, with 419,380 of them banked and every
  // wallet proven, Vercel killed the instance for running out of memory. Twice.
  // See the staging builder above: the rows are read once, split, bucketed by
  // day as gzipped text, and each day is built and released on its own.
  const keepDays = windowDays(run);
  let staged = null;
  if (journal && (journal.row_shards || []).length) {
    phase('journal-load', { shards: journal.row_shards.length,
      rows: resumed && resumed.rows_awaiting_load });
    try {
      const t0 = Date.now();
      staged = await stageJournal(journal, { env: d.env, gh: d.gh, fetch: d.fetch,
        onShard: (n, total, rowCount) => phase('journal-shard',
          { shard: n, of: total, rows: rowCount, ms: Date.now() - t0 }) });
      phase('journal-loaded', { rows: staged.total, distinct: staged.best.size,
        staged_bytes: staged.partition.packedBytes(), took_ms: Date.now() - t0 });
    } catch (e) {
      // The wallets are proven — their manifest entries say so and this run
      // walked the rest — but their transactions cannot be produced. Committing
      // the checkpoint without them would advance a coverage floor past
      // evidence that is not in the repository, which is the one thing that
      // must never happen. So the run refuses, discards the journal, and the
      // next attempt walks those wallets again.
      const saved = { journal_rows_unreadable: e.message };
      try {
        const discarded = await Store.clearJournal(journal, { env: d.env, gh: d.gh, fetch: d.fetch });
        saved.discard_status = discarded && discarded.status;
      } catch (e2) { saved.discard_error = e2.message; }

      // ── AND THEY STOP BEING PROVED, BECAUSE THE PROOF DID NOT READ BACK ──
      //
      // A recovered wallet is proved on the strength of rows that were
      // hash-checked on the way back in. That check just failed, so the claim
      // behind every one of them failed with it, and they must not leave this
      // function still marked proven — a report rendering against them would be
      // claiming coverage from evidence the store could not produce.
      //
      // The run already refuses to COMMIT here. This makes it refuse to CLAIM,
      // which is the separate half: complete_wallets and the per-wallet detail
      // have to describe the same run, or the gauge reads 408/408 while every
      // wallet behind it is refused.
      return { ...summary, committed: false, reason: 'JOURNAL_ROWS_UNREADABLE', rows,
        ...withoutUnverifiedRecoveries('JOURNAL_ROWS_UNREADABLE: ' + e.message),
        ...saved };
    }
  } else {
    staged = new Stage();
  }
  // This attempt's own rows join the staging after the journal's — the order
  // the merge always saw them in. A fault in THESE is this run's, not the
  // journal's, and is thrown as such rather than costing the journal.
  for (const row of rows) staged.ingest(row);

  // ── THE LAST MILE, SAID OUT LOUD ────────────────────────────────────────
  //
  // Between "journal-load" and "done" the run used to say nothing, and that gap
  // turned out to be twenty-eight minutes of a thirty-two minute run. It is the
  // same silent-gap problem as the one before the first wallet, one level
  // deeper: without these lines the only way to find where a commit spends its
  // time is to guess. Each day now reports as it is read, merged and built.
  const tBuild = Date.now();
  const built = await buildDays(staged, { keep_days: keepDays },
    { env: d.env, gh: d.gh, fetch: d.fetch, onPhase: phase });
  staged = null;
  phase('shards-built', { files: Object.keys(built.files).length,
    bytes: Object.values(built.files).reduce((n, b) => n + b.length, 0),
    took_ms: Date.now() - tBuild });
  const tCommit = Date.now();
  let committed;
  try {
    committed = await Store.commitRun({
    report_id: run.report_id, scan_id: run.scan_id || null, sealed_at: run.sealed_at || null,
    anchor_ledger: anchor.ledger, anchor_close: anchor.close_iso,
    target_wallets: roster.length, complete_wallets: provedTotal, balance_contradictions: 0,
    evidence_shards: built.shards,
    wallets: nextEntries,
    admitted_wallets: admitted,
    // Named so the commit that lands the evidence also removes the journal,
    // in the same tree and the same ref update. A separate cleanup call is a
    // call that can fail after the evidence is already in.
    journal: journalWritten ? journal : null,
    files: built.files
    }, { env: d.env, gh: d.gh, fetch: d.fetch,
      onBlob: (n, total, path) => { if (n === 1 || n === total || n % 5 === 0) {
        phase('uploading', { file: n, of: total, path, ms: Date.now() - tCommit }); } } });
    phase('committed', { took_ms: Date.now() - tCommit });
  } catch (e) {
    // The gate refused, or GitHub did. Either way the walking was real and
    // must not be paid for twice, so it is written down before the failure is
    // reported. The checkpoint is exactly where it was.
    const saved = await saveWork();
    const err = new Error(e.message);
    err.runSummary = { ...summary, committed: false, reason: 'COMMIT_REFUSED',
      commit_error: e.message, rows, wallets, freshness, ...saved };
    throw err;
  }

  // The rows that come back are the report window's days only, merged and
  // stripped of their raw payloads — the repository holds the evidence, and a
  // response carrying a week of it is the same memory the ending just refused
  // to spend. `transactions` still counts every distinct hash committed.
  return { ...summary, committed: true, transactions: built.transactions,
    rows: built.rows, rows_retained_days: keepDays, wallets, freshness, ...committed };
}

// ── REPAIRING WHAT CAN BE PROVEN, AND NOTHING ELSE ────────────────────────
//
// A commit used to overwrite a day's provenance instead of merging it, and
// 102,856 rows were destroyed before that was fixed. Some of what was lost is
// recoverable: where a surviving event shows a watched wallet as sender or
// receiver, that wallet demonstrably saw the transaction, and a provenance row
// can be rebuilt from the event alone.
//
// The rest cannot. A walk that returned a transaction WITHOUT the wallet being
// a party to it leaves no trace in the event, and there is no way to tell which
// of four hundred wallets saw it. Those are left unattributed, because an
// invented observer is worse than a missing one — the report would attribute
// movement to a wallet on no evidence at all.
//
// Everything rebuilt here is DERIVED_VIA, never OBSERVED_VIA. The distinction
// lives in the role rather than in a flag, so a consumer cannot lose it by not
// knowing to look. And nothing already committed is altered: this ADDS rows,
// and the day is marked PARTIAL_RECONSTRUCTED so no reader can mistake a
// repaired day for one whose observations survived.
function reconstructProvenance(input) {
  const i = input || {};
  const events = i.events || [];
  const roster = new Set(i.roster || []);
  const existing = i.existing || [];

  const out = [], seen = new Set();
  const add = (tx_hash, address, role) => {
    const id = tx_hash + '|' + address + '|' + role;
    if (seen.has(id)) return false;
    seen.add(id); out.push({ tx_hash, address, role }); return true;
  };
  // What survived comes first and comes through untouched, including its role.
  let observedRows = 0;
  for (const p of existing) {
    if (!p || !p.tx_hash || !p.address || !p.role) continue;
    if (add(p.tx_hash, p.address, p.role) && p.role === T.ROLE.OBSERVED_VIA) observedRows++;
  }

  let derivedRows = 0, withoutProvenance = 0;
  const attributed = new Set(existing.filter(p => p && (p.role === T.ROLE.OBSERVED_VIA ||
    p.role === T.ROLE.DERIVED_VIA)).map(p => p.tx_hash));
  // ── ONLY WHERE THE OBSERVATION IS ACTUALLY MISSING ──────────────────────
  //
  // Found by the dry run before a single row was written: this derived for
  // EVERY event with a watched party, including the five committed days that
  // were never damaged and are already 100% attributed. That would have layered
  // 223,000 weaker derived_via rows on top of intact observations and marked
  // five healthy days PARTIAL_RECONSTRUCTED for no reason.
  //
  // A derived row is a repair. Where nothing is broken there is nothing to
  // repair, and adding a weaker claim beside a stronger one only makes the
  // stronger one harder to see.
  const observedFor = new Set(existing.filter(p => p && p.role === T.ROLE.OBSERVED_VIA)
    .map(p => p.tx_hash));
  for (const e of events) {
    if (!e || !e.hash) continue;
    if (observedFor.has(e.hash)) continue;   // the walk that saw it survived
    // Only the two roles the EVENT can prove. A submitter is the signer, which
    // is not the same as a party to the movement, and is deliberately not used
    // here: this repair claims only what the surviving row demonstrates.
    const parties = [e.from_account, e.to_account].filter(a => a && roster.has(a));
    for (const address of parties) {
      if (add(e.hash, address, T.ROLE.DERIVED_VIA)) derivedRows++;
    }
    if (parties.length) attributed.add(e.hash);
    if (!attributed.has(e.hash)) withoutProvenance++;
  }

  return {
    participants: out,
    coverage: {
      day: i.day || null,
      // Never 'COMPLETE' once anything has been derived: a repaired day is
      // partial by construction, because the rows that could not be derived are
      // gone for good. A day that needed NO repair keeps its own status — it
      // was never damaged, and calling it reconstructed would be a false
      // downgrade of intact evidence.
      status: derivedRows > 0 ? 'PARTIAL_RECONSTRUCTED' : 'UNCHANGED',
      observed_rows: observedRows,
      derived_rows: derivedRows,
      events: events.length,
      events_without_provenance: withoutProvenance,
      reconstructed_at: i.now || null,
      note: 'derived_via rows are inferred from the surviving event, not records of a walk'
    }
  };
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
  // Events and their provenance, read together. Nothing else in the archive is
  // touched: two small file sets for the one or two days the window covers.
  const [stored, seen] = await Promise.all([
    Store.readDays(days, d),
    Store.readDays(days, d, 'participants')
  ]);
  const fresh = (input.rows || []).map(r => X.eventOf({ ...r, close_time: r.close_time_iso || r.close_time }));
  const byHash = new Map();
  // Freshly walked rows win on a tie: they came from this run's proven range.
  for (const event of stored.events) byHash.set(event.hash, event);
  for (const event of fresh) byHash.set(event.hash, event);

  // ── WHO SAW IT ──────────────────────────────────────────────────────────
  //
  // A transaction with no observer is a transaction the report cannot attribute
  // to any watched wallet — it renders with an empty account, label and
  // category. The event projection deliberately does not carry provenance
  // (provenance is not a property of the transaction), so it is rejoined here
  // from the participants shards, where every walk that saw a transaction was
  // recorded as an OBSERVED_VIA row.
  const observers = new Map();
  const note = (hash, address) => {
    if (!hash || !address) return;
    let list = observers.get(hash);
    if (!list) { list = []; observers.set(hash, list); }
    if (list.indexOf(address) < 0) list.push(address);
  };
  // The role constant, not a string literal — the writer and the reader must
  // not be able to drift apart on the one field this join depends on.
  // Both roles attribute a transaction, and they are counted separately because
  // they are not the same claim: OBSERVED_VIA records that a wallet's walk
  // returned the row, DERIVED_VIA infers from the surviving event that the
  // wallet must have seen it. The report has to be able to tell them apart.
  const derivedOnly = new Set(), observedHashes = new Set();
  for (const p of seen.events) {
    if (!p) continue;
    if (p.role === T.ROLE.OBSERVED_VIA) { note(p.tx_hash, p.address); observedHashes.add(p.tx_hash); }
    else if (p.role === T.ROLE.DERIVED_VIA) { note(p.tx_hash, p.address); derivedOnly.add(p.tx_hash); }
  }
  // A transaction with even one surviving observation is attributed on the
  // strength of that, whatever else was rebuilt alongside it. Done after the
  // loop so the answer does not depend on the order rows happen to appear in.
  for (const h of observedHashes) derivedOnly.delete(h);
  // This run's own rows already know their observers; they are not in any shard
  // yet because the commit that writes them may not have happened.
  for (const r of (input.rows || [])) {
    const via = Array.isArray(r.observed_via) ? r.observed_via : (r.observed_via ? [r.observed_via] : []);
    for (const address of via) note(r.hash, address);
  }

  const events = [...byHash.values()]
    .filter(e => {
      const t = Date.parse(e.close_time);
      return Number.isFinite(t) && t >= from.getTime() && t <= to.getTime();
    })
    .map(e => ({ ...e, observed_via: observers.get(e.hash) || [] }))
    .sort(X.orderEvents);
  return { events, days, shards_read: stored.files.concat(seen.files),
    days_without_shards: stored.missing,
    from_stored: stored.events.length, from_this_run: fresh.length, in_window: events.length,
    unattributed: events.filter(e => !e.observed_via.length).length,
    // ── HOW MUCH OF THE ATTRIBUTION IS INFERRED ───────────────────────────
    // A window whose attribution rests on reconstructed rows is weaker than one
    // whose provenance survived, and the report must be able to say so rather
    // than presenting both as the same fact.
    attributed_derived_only: events.filter(e => derivedOnly.has(e.hash)).length,
    provenance: events.some(e => derivedOnly.has(e.hash))
      ? 'PARTIAL_RECONSTRUCTED' : 'OBSERVED' };
}

module.exports = { acquire, walkWallet, buildShards, Stage, stageJournal, buildDays, windowDays,
  readReportWindow, reconstructProvenance, groupByCause, PAGE_LIMIT };
