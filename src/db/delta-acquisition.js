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
  let journal = null, resumed = null, resumedRows = [];
  const stale = journalRead && !journalRead.missing && journalRead.journal
    ? Journal.usable(journalRead.journal, state) : null;
  if (journalRead && !journalRead.missing && (journalRead.unreadable || (stale && !stale.ok))) {
    // Refused. Discard it rather than leave it to be refused again every
    // morning from here on, and say why.
    resumed = { adopted: false,
      reason: journalRead.unreadable ? 'JOURNAL_UNREADABLE' : stale.problems.join(','),
      report_id: journalRead.journal ? journalRead.journal.report_id : null };
    phase('journal', resumed);
    try { await Store.clearJournal(journalRead.journal, { env: d.env, gh: d.gh, fetch: d.fetch }); }
    catch (e) { resumed.discard_error = e.message; }
  } else if (journalRead && journalRead.journal && stale && stale.ok) {
    const candidate = journalRead.journal;
    try {
      resumedRows = await Store.readJournalRows(candidate, { env: d.env, gh: d.gh, fetch: d.fetch });
      journal = candidate;
      anchor = { ledger: Number(journal.anchor_ledger), close_ms: null,
        close_iso: journal.anchor_close || null };
      resumed = { adopted: true, report_id: journal.report_id, segments: journal.segments,
        wallets_already_walked: journal.wallets.length, rows_recovered: resumedRows.length,
        anchor_ledger: anchor.ledger, started_at: journal.started_at };
      phase('journal', resumed);
    } catch (e) {
      // The manifest verified but its rows would not come back. That is a lost
      // optimisation, exactly like a manifest that failed to verify — and the
      // run must survive it. Killing the run here meant an unreadable segment
      // stopped every attempt from that point on, which is the opposite of
      // what a resume journal is for.
      resumedRows = [];
      resumed = { adopted: false, reason: 'JOURNAL_ROWS_UNREADABLE: ' + e.message,
        report_id: candidate.report_id };
      phase('journal', resumed);
      try { await Store.clearJournal(candidate, { env: d.env, gh: d.gh, fetch: d.fetch }); }
      catch (e2) { resumed.discard_error = e2.message; }
    }
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
  const alreadyWalked = journal ? journal.wallets.slice() : [];
  const walkedSet = new Set(alreadyWalked.map(w => w.address));
  const entries = roster.filter(e => !walkedSet.has(e.address));
  phase('plan', { wallets: roster.length, to_walk: entries.length,
    recovered: alreadyWalked.length, proven: state.wallets.length,
    admitting: admitted.length, awaiting: deferred.length,
    cold_from_ledger: admitted.length ? coldFrom : null });

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

  const writeSegment = async batch => {
    const wallets = batch.map(r => Journal.walletRecord({
      address: r.address, proven_from: r.proof.from_ledger, proven_through: r.proof.through_ledger,
      rows: r.rows.length, reconciliation: r.reconciliation && r.reconciliation.status,
      entry: r.next_entry }));
    const written = await Store.appendJournal(journal,
      { wallets, rows: batch.flatMap(r => r.rows) }, { env: d.env, gh: d.gh, fetch: d.fetch });
    journal = written.journal; journalWritten = true;
    phase('journal-flush', { segment: journal.segments, wallets_recorded: journal.wallet_count,
      commit_sha: written.commit_sha });
  };

  let lastFlushAt = Date.now();
  const maybeFlush = async force => {
    const batch = [];
    for (let i = 0; i < results.length; i++) {
      const r = results[i];
      if (r && r.status === 'COMPLETE' && !flushed.has(i)) batch.push({ i, r });
    }
    const overdue = Date.now() - lastFlushAt >= JOURNAL_INTERVAL_MS;
    if (!batch.length || (!force && !overdue && batch.length < flushEvery)) return;
    lastFlushAt = Date.now();
    for (const b of batch) flushed.add(b.i);
    flushing = flushing.then(() => writeSegment(batch.map(b => b.r))).catch(e => {
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
  const worker = async () => {
    for (;;) {
      const index = cursor++;
      if (index >= entries.length) return;
      const entry = entries[index];
      // Do not start what cannot finish. A wallet begun with seconds left is
      // cut off mid-walk, and a partial walk proves nothing and cannot be
      // written down — it is simply thrown away. Stopping here turns that into
      // a flush and a resume that starts on this wallet next time.
      if (reader.deadline && reader.deadline - Date.now() < START_RESERVE_MS) {
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
              onPage: d.onPage });
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

  await Promise.all(Array.from({ length: concurrency }, worker));
  await flushing;

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
  const rows = T.mergeSightings(resumedRows.concat(complete.flatMap(r => r.rows)));
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
    // Grouped by CAUSE, not one entry per wallet. A hundred wallets sharing
    // one reason is one fact about the run, and listing it a hundred times
    // made the result three times its useful size — the same addresses already
    // appear, once, in the per-wallet detail.
    unavailable: groupByCause(failed),
    contradicted: contradicted.slice()
  };
  const wallets = alreadyWalked.map(w => ({
    address: w.address, status: 'RECOVERED',
    proven_through: w.proven_through, rows: w.rows,
    reconciliation: w.reconciliation, attempts: 0, error: null
  })).concat(results.map(r => ({
    address: r && r.address, status: (r && r.status) || 'FAILED',
    proven_through: r && r.proof ? r.proof.through_ledger : null,
    rows: r && r.rows ? r.rows.length : 0,
    reconciliation: (r && r.reconciliation && r.reconciliation.status) || null,
    attempts: (r && r.attempts) || 0,
    error: (r && r.error) || null
  })));

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
    return { journal_segments: journal.segments, journal_wallets: journal.wallet_count,
      journal_error: journalError };
  };
  if (failed.length) {
    return { ...summary, committed: false, reason: 'RUN_INCOMPLETE',
      rows, wallets, freshness, ...(await saveWork()) };
  }
  if (contradicted.length) {
    return { ...summary, committed: false, reason: 'RUN_CONTRADICTED',
      rows, wallets, freshness, ...(await saveWork()) };
  }

  const built = buildShards(rows);
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
    }, { env: d.env, gh: d.gh, fetch: d.fetch });
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

module.exports = { acquire, walkWallet, buildShards, readReportWindow, groupByCause, PAGE_LIMIT };
