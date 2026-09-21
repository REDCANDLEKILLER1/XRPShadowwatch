'use strict';
// The GitHub-backed morning run. No database.
//
// One POST does the whole acquisition: read the checkpoint from the evidence
// repo, pin one validated ledger, walk every wallet's bounded edge, cross-check
// balances, and — only if the run is complete and uncontradicted — make one
// atomic commit that advances the checkpoint.
//
// It is one call rather than 255 because the accumulation has to live
// somewhere, and a serverless function cannot hold it between invocations. A
// run that exceeds the budget commits nothing and the next attempt repeats the
// same bounded edge, which costs one account_tx per wallet.
const zlib = require('zlib');
const D = require('../src/db/delta-acquisition');
const Store = require('../src/db/github-store');
const State = require('../src/db/evidence-state');
const A = require('../src/db/github-archive');
const roster = require('../src/db/roster');
const { acquireReader, releaseReader } = require('../src/db/xrpl-reader');

// ── THE WALK GETS WHAT IS LEFT AFTER THE ENDING IS PAID FOR ───────────────
//
// The function's ceiling is 300 s (vercel.json). This used to give the walk
// 240 s of it, leaving 60 s for everything after: flushing the journal, and
// assembling the report window — which is ~101k events out of ~138k stored and
// was measured at roughly eighteen seconds on its own.
//
// Live on 2026-09-14 that was not enough. A run starting at 15:43:27 had still
// not answered when the browser gave up 290 seconds later, with the whole of
// that time showing nothing at all.
//
// The asymmetry that decides this: an attempt that RETURNS writes its journal,
// and the next attempt resumes from it. An attempt killed by the platform
// mid-flush can lose that write, and then the next attempt walks the same
// wallets again — so a shorter walk that finishes is worth more than a longer
// one that is cut off. Ninety seconds of reserve buys the ending twice over.
//
// This is a tuning figure derived from one measured overrun, not a proven
// optimum. The run reports 'journal-loaded', 'shards-built' and 'committed'
// with their own durations; read those rather than re-guessing this number.
const FUNCTION_CEILING_MS = 300000;
const ENDING_RESERVE_MS = 90000;
const READ_BUDGET_MS = FUNCTION_CEILING_MS - ENDING_RESERVE_MS;

// The roster is parsed out of committed source. A parse failure must not turn
// a status check into a 500 — the checkpoint is still readable and still worth
// reporting — so it degrades to null rather than throwing.
const rosterCount = () => { try { return roster.select().accounts.length; } catch (_) { return null; } };

// ── WHAT THE REPORT ACTUALLY NEEDS BACK ────────────────────────────────────
//
// Not the evidence. The evidence — every raw_tx and raw_meta the walk fetched —
// belongs in the repository, and a run that walked two hundred thousand of them
// cannot hand that to a browser over one response. The REPORT needs the
// transactions inside its window, once each, with enough of each to render a
// line about it.
//
// And the window is not the same thing as the delta. The first run of a day
// walks the day; a second run walks only what happened since the first, and its
// delta is nearly empty while the morning's transactions sit committed in the
// repository. Handing the report that delta would render an empty morning and
// call it a quiet day. So the window is ASSEMBLED — what is stored for the days
// it touches, unioned with what this run just walked.
const REPORT_KEYS = ['hash', 'ledger_index', 'close_time', 'tx_type', 'tx_result', 'validated',
  'from_account', 'to_account', 'amount_drops', 'amount_value', 'currency', 'issuer',
  'destination_tag', 'sig_mode', 'signer_count', 'escrow_owner', 'escrow_destination',
  'escrow_amount_drops', 'observed_via'];
const slim = event => {
  const out = {};
  for (const key of REPORT_KEYS) { if (event[key] !== null && event[key] !== undefined) out[key] = event[key]; }
  return out;
};

// Assembling the window is the same job whichever way the answer travels, so
// it is done in one place. It used to live inside the non-streaming responder
// only, which quietly made the streaming endpoint unable to serve the report at
// all: it ended at 'done' with no events, so the report path could not use the
// one endpoint that says what it is doing while it does it.
async function attachWindow(body, result, input) {
  const startMs = Number(input.window_start_ms), endMs = Number(input.window_end_ms);
  // The rows never cross the wire. They are the evidence; the repository holds
  // them, and the browser has no use for a raw ledger payload.
  delete body.rows;
  // A committed run hands back only the window's days, so its count is the
  // one it states; an uncommitted one still carries every row it walked.
  body.transactions_walked = Number.isFinite(Number(result.transactions))
    ? Number(result.transactions) : (result.rows || []).length;

  if (Number.isFinite(startMs) && Number.isFinite(endMs)) {
    try {
      const assembled = await D.readReportWindow(
        { window_start_ms: startMs, window_end_ms: endMs, rows: result.rows || [] }, {});
      body.events = assembled.events.map(slim);
      body.window = { from: new Date(startMs).toISOString(), to: new Date(endMs).toISOString(),
        days: assembled.days, in_window: assembled.in_window,
        from_stored: assembled.from_stored, from_this_run: assembled.from_this_run,
        days_without_shards: assembled.days_without_shards,
        unattributed: assembled.unattributed,
        // Carried to the browser because the report's coverage line has to be
        // able to say that some of its attribution is inferred from surviving
        // events rather than recorded from a walk. A number the server keeps to
        // itself cannot make the report more honest.
        attributed_derived_only: assembled.attributed_derived_only,
        provenance: assembled.provenance };
    } catch (e) {
      // The window could not be assembled. Say so rather than quietly handing
      // back this run's delta as though it were the day.
      body.events = null;
      body.window = { error: String(e.message || 'REPORT_WINDOW_UNAVAILABLE') };
    }
  } else {
    body.events = null;
    body.window = { error: 'REPORT_WINDOW_NOT_REQUESTED' };
  }
  return body;
}

// The final NDJSON line, built in ONE place so the fake server in the suite can
// build it the same way the real one does. A test whose fixture assembles its
// own version of this would pass over a server that had stopped attaching the
// window at all — which is exactly the defect worth catching, because the
// report cannot be rendered without it.
async function buildStreamDone(summary, wallets, result, input) {
  const done = await attachWindow({ t: 'done', ...summary, wallets_detail: wallets },
    result, input);
  // Same packer as the non-streaming path, so the two cannot drift into
  // sending differently-shaped events.
  packEvents(done);
  return done;
}

async function respondWithWindow(res, result, input, reader) {
  const body = await attachWindow({ ...result }, result, input);

  // ── COMPRESSED INSIDE THE JSON, NOT AROUND IT ──────────────────────────
  //
  // A 72-hour window over this roster is ninety thousand events — tens of
  // megabytes of JSON, past what a function response will carry. It has to be
  // compressed.
  //
  // The obvious way is Content-Encoding: gzip on the response. The problem is
  // that the platform also negotiates compression from Accept-Encoding, and if
  // it compresses a body that already says it is gzipped, the browser gunzips
  // once and finds gzip. That fails as a network error with no useful message,
  // and it cannot be tested from here — only in production, on a live report.
  //
  // So the events travel as a gzipped base64 STRING inside ordinary JSON. No
  // Content-Encoding, no negotiation, nothing the platform can double. Both
  // halves are exercised by the suite because both halves are just code.
  packEvents(body);
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  return res.end(JSON.stringify(body));
}

// Pulled out and exported so the DECISION is testable rather than only its
// spelling. A source check can see the word "gzip" in a file whose compression
// never runs — one did, and passed while the feature was disabled.
const GZIP_EVENTS_ABOVE = 200;
function packEvents(body) {
  if (!body || !Array.isArray(body.events) || body.events.length <= GZIP_EVENTS_ABOVE) return body;
  body.events_count = body.events.length;
  body.events_gz = zlib.gzipSync(Buffer.from(JSON.stringify(body.events), 'utf8'),
    { level: 6 }).toString('base64');
  body.events = null;
  return body;
}

module.exports = async function handler(req, res) {
  res.setHeader('Cache-Control', 'private, no-store, max-age=0');
  res.setHeader('CDN-Cache-Control', 'no-store');
  res.setHeader('Vercel-CDN-Cache-Control', 'no-store');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  if (!['GET', 'POST'].includes(req.method)) return res.status(405).json({ error: 'METHOD_NOT_ALLOWED' });
  const input = req.method === 'GET' ? (req.query || {}) : (req.body || {});

  if (req.method === 'POST' && req.headers.origin) {
    let origin;
    try { origin = new URL(req.headers.origin).host; }
    catch (_) { return res.status(403).json({ error: 'INVALID_ORIGIN' }); }
    if (origin !== req.headers.host) return res.status(403).json({ error: 'CROSS_ORIGIN_WRITE_REFUSED' });
  }

  const allowed = req.method === 'GET' ? ['state', 'health'] : ['run', 'seed'];
  if (!allowed.includes(input.action)) return res.status(400).json({ error: 'ACTION_NOT_ALLOWED' });

  let reader;
  try {
    if (input.action === 'health' || input.action === 'state') {
      const loaded = await Store.readState({});
      return res.json({
        configured: true,
        seeded: !loaded.missing,
        branch: loaded.branch,
        state_version: loaded.state ? loaded.state.state_version : null,
        state_sha256: loaded.state ? loaded.state.state_sha256 : null,
        anchor_ledger: loaded.state ? loaded.state.anchor_ledger : null,
        wallets: loaded.state ? loaded.state.wallet_count : 0,
        // What the roster says versus what the checkpoint has proven. The gap
        // is the wallets still waiting to join, and it is worth seeing BEFORE
        // a run rather than inferring it from a count that looks short.
        roster_wallets: rosterCount(),
        wallets_awaiting_admission: loaded.state
          ? Math.max(0, rosterCount() - Number(loaded.state.wallet_count || 0)) : rosterCount(),
        // The per-wallet checkpoints, so the UI can show what is proven before
        // a run starts rather than only after it finishes.
        wallets_detail: input.action === 'state' && loaded.state ? loaded.state.wallets : undefined
      });
    }

    // ── Seed the checkpoint from a sealed report, over HTTP ────────────────
    //
    // The same decision the CLI makes, exposed as an action because the
    // operator works from a phone and cannot run a script. The credential lives
    // here either way; moving the trigger does not move the trust.
    //
    // Idempotent and self-refusing: genesis happens once, a roster that no
    // longer matches the sealed one is refused, and nothing is overwritten.
    if (input.action === 'seed') {
      // Already seeded? Say so before walking every receipt in the archive.
      // Genesis happens once, and after the roster grows past the sealed run
      // that seeded it the receipt comparison below would refuse — which is
      // correct, but reads as a failure when the answer is simply "done".
      const already = await Store.readState({});
      if (!already.missing) {
        return res.json({ status: 'ALREADY_SEEDED', branch: already.branch,
          state_version: already.state.state_version,
          state_sha256: already.state.state_sha256,
          anchor_ledger: already.state.anchor_ledger,
          wallets: already.state.wallet_count });
      }
      // Reading receipts accepts either token: one fine-grained token scoped
      // to both repositories is the normal setup, and demanding two separate
      // secrets to perform one read is a configuration trap rather than a
      // security boundary. Writing the checkpoint still goes through the
      // evidence target below.
      const archive = A.archiveReadTarget(process.env);
      const gh = A.client(archive.token, archive.repo, fetch);
      const ref = await A.archiveRef(gh, archive.branch);
      const commit = await gh('GET', '/git/commits/' + ref.object.sha);
      const tree = await gh('GET', '/git/trees/' + commit.tree.sha + '?recursive=1');
      const paths = (tree.tree || []).filter(n => n.type === 'blob' &&
        /^reports\/.*\/receipt\.json$/.test(n.path)).map(n => n.path);
      if (!paths.length) return res.status(503).json({ error: 'NO_RECEIPTS' });

      const usable = [];
      for (const path of paths) {
        const file = await gh('GET', '/contents/' + path + '?ref=' + encodeURIComponent(archive.branch), undefined, true);
        if (!file) continue;
        let r; try { r = JSON.parse(Buffer.from(file.content || '', 'base64').toString('utf8')); } catch (_) { continue; }
        // Only a run that proved its WHOLE roster establishes a checkpoint.
        if (r.coverage_complete === true &&
            Number(r.transaction_windows_proved) === Number(r.target_wallets) &&
            Number(r.target_wallets) > 0 && Number(r.failed || 0) === 0 &&
            Number(r.truncated || 0) === 0 && Number(r.unproven || 0) === 0 &&
            Number.isInteger(Number(r.validated_anchor_ledger)) && Number(r.validated_anchor_ledger) > 0) {
          usable.push(r);
        }
      }
      if (!usable.length) return res.status(503).json({ error: 'NO_COMPLETE_RECEIPT' });
      usable.sort((a, b) => Number(a.validated_anchor_ledger) - Number(b.validated_anchor_ledger));
      const receipt = input.report_id
        ? usable.find(r => r.report_id === input.report_id) : usable[usable.length - 1];
      if (!receipt) return res.status(400).json({ error: 'REPORT_NOT_USABLE', usable: usable.map(r => r.report_id) });

      // The receipt names a roster by HASH, not by address. If it differs there
      // is no way to know which wallets that anchor covered, and seeding them
      // all would hand a checkpoint to a wallet nobody proved.
      const selected = roster.select();
      if (selected.hash !== receipt.roster_hash) {
        return res.status(409).json({ error: 'ROSTER_CHANGED_SINCE_RECEIPT',
          roster_now: selected.hash, roster_proved: receipt.roster_hash,
          wallets_now: selected.accounts.length, wallets_proved: Number(receipt.target_wallets) });
      }
      const anchor = Number(receipt.validated_anchor_ledger);
      const seeded = await Store.seedGenesis({
        coverage: selected.accounts.map(address => ({
          address, scan_coverage_through: anchor, scan_coverage_through_close: null })),
        anchor_ledger: anchor, anchor_close: null,
        sealed_run: { report_id: receipt.report_id, scan_id: receipt.scan_id || null,
          target_wallets: Number(receipt.target_wallets),
          complete_wallets: Number(receipt.transaction_windows_proved),
          balance_contradictions: 0, sealed_at: receipt.sealed_at || null }
      }, {});
      return res.json({ ...seeded, seeded_from: receipt.report_id, anchor_ledger: anchor,
        wallets: selected.accounts.length,
        next_walk_from: anchor + 1 });
    }

    if (!/^SW-\d{8}-[A-Z0-9]{5}$/.test(String(input.report_id || ''))) {
      return res.status(400).json({ error: 'INVALID_REPORT_ID' });
    }
    reader = acquireReader();
    reader.deadline = Date.now() + READ_BUDGET_MS;
    const job = {
      report_id: input.report_id,
      scan_id: typeof input.scan_id === 'string' ? input.scan_id : null,
      sealed_at: typeof input.sealed_at === 'string' ? input.sealed_at : null,
      // The roster comes from committed source, read HERE and never from the
      // request. A caller who could name the roster could name any address and
      // have the run admit it to the watchlist — so the client does not get to
      // say who is watched, the repository does.
      roster: roster.select().accounts,
      // How many new wallets may join THIS run. A budget dial, not a forensic
      // one: it changes when a wallet joins, never what is proven about it.
      // Bounded so a caller cannot ask for a run that cannot finish.
      // Measured: a cold admission costs about one request and 0.4 seconds, so
      // the whole remaining roster is a minute of walking. The ceiling is a
      // guard against a caller asking for something absurd, not a throttle.
      max_admissions: Math.max(0, Math.min(Number(input.max_admissions) || 150, 200)),
      // The report window, so the run knows which days' rows to hand back.
      // It decides what is RETAINED for the response, never what is proven
      // or committed: the evidence goes to the repository whole either way.
      window_start_ms: Number.isFinite(Number(input.window_start_ms)) ? Number(input.window_start_ms) : null,
      window_end_ms: Number.isFinite(Number(input.window_end_ms)) ? Number(input.window_end_ms) : null
    };
    // Measured, not guessed. A deep account_tx page costs roughly seven
    // seconds on a public node — the cost is the server's, not the 250 ms
    // admission clock's — so pages overlap profitably and the run is latency
    // bound rather than pacing bound. Four workers left the link mostly idle
    // while one exchange wallet ground through thirty-one pages.
    const concurrency = Math.max(1, Math.min(Number(input.concurrency) || 8, 8));

    // ── Streaming progress ────────────────────────────────────────────────
    //
    // A run takes minutes and the caller otherwise sees a spinner and then, at
    // the very end, either a result or a timeout with nothing to say about it.
    // A wallet that hung is indistinguishable from a network stall, which makes
    // a failed run undiagnosable from the outside.
    //
    // So progress is written as it happens: one NDJSON line per wallet, then a
    // final line carrying the same object the non-streaming path returns.
    // Nothing about the run changes — the gate, the commit and the refusals are
    // identical. Only the caller's view of it does.
    if (input.stream) {
      res.setHeader('Content-Type', 'application/x-ndjson; charset=utf-8');
      res.setHeader('X-Accel-Buffering', 'no');
      const line = value => { try { res.write(JSON.stringify(value) + '\n'); } catch (_) {} };
      const startedAt = Date.now();
      line({ t: 'start', report_id: job.report_id, budget_ms: READ_BUDGET_MS,
        roster_wallets: job.roster.length, max_admissions: job.max_admissions,
        at: new Date().toISOString() });

      // ── A HEARTBEAT, BECAUSE SILENCE IS NOT A DIAGNOSIS ──────────────────
      //
      // A run that emits "start" and then nothing for ninety seconds tells the
      // operator only that it is slow, which is the one thing they can already
      // see. It cannot distinguish a GitHub read that is taking its time from
      // an XRPL socket that never opened — and those need opposite responses.
      //
      // So every few seconds the run says what it is waiting on and, crucially,
      // how many XRPL requests it has actually issued. A request count stuck at
      // zero means the transport never carried anything; a climbing one means
      // the walk is simply slow. That single number separates the two.
      let lastPhase = 'connecting', walletsDone = 0;
      const beat = setInterval(() => line({ t: 'tick',
        waiting_on: lastPhase, wallets_done: walletsDone,
        xrpl_requests: reader.stats.requests,
        xrpl_retries: reader.stats.retries, xrpl_reconnects: reader.stats.reconnects,
        // Per endpoint, because the whole point is that they are no longer one
        // number. A run that felt slow should be showable as slow on ONE
        // server rather than everywhere.
        lanes: typeof reader.laneStats === 'function'
          ? reader.laneStats().map(l => l.endpoint.replace('wss://', '') +
              ' ' + l.requests + (l.refusals ? '/' + l.refusals + 'ref' : '') +
              (l.cooldown_ms ? ' cool' + Math.round(l.cooldown_ms / 1000) + 's' : '') +
              (l.retired ? ' RETIRED' : '')).join(' · ')
          : null,
        first_failure: reader.stats.first_failure || null,
        ms: Date.now() - startedAt }), 5000);
      if (typeof beat.unref === 'function') beat.unref();
      try {
        const result = await D.acquire(job, { reader, concurrency,
          // The lanes report as they land, so a stalled XRPL connect is visible
          // as a missing anchor rather than as a run that is simply quiet.
          // 'reserve' is an announcement, not a thing the run waits on — it
          // was overwriting "wallets" and making a healthy walk read as stuck.
          onPhase: (name, detail) => {
            if (name !== 'reserve') lastPhase = name === 'plan' ? 'wallets' : name;
            line({ t: 'phase', phase: name, ...detail, ms: Date.now() - startedAt }); },
          // One line per PAGE of a long wallet. Thirty-one pages is four
          // minutes; without this it is four minutes of nothing.
          onPage: p => line({ t: 'page', ...p, ms: Date.now() - startedAt }),
          onWallet: (w, done, total) => { walletsDone = done;
            return line({ t: 'wallet', n: done, total,
            address: w && w.address, status: (w && w.status) || 'FAILED',
            rows: (w && w.rows) ? w.rows.length : 0,
            attempts: (w && w.attempts) || 1,
            reconciliation: (w && w.reconciliation && w.reconciliation.status) || null,
            error: (w && w.error) || null,
            ms: Date.now() - startedAt }); }
        });
        // The rows themselves are large and the page does not render them;
        // the counts and the freshness block are what a reader needs.
        const { rows, wallets, ...summary } = result;
        // The window is the expensive part of the ending and the report cannot
        // be assembled without it, so the caller is told it is happening rather
        // than left watching the last wallet line for another twenty seconds.
        lastPhase = 'window';
        line({ t: 'phase', phase: 'window', ms: Date.now() - startedAt });
        const done = await buildStreamDone(summary, wallets, result, input);
        line({ ...done,
          xrpl: { requests: reader.stats.requests, retries: reader.stats.retries,
            reconnects: reader.stats.reconnects, waits_ms: reader.stats.waits_ms,
            lanes: typeof reader.laneStats === 'function' ? reader.laneStats() : null,
            events: (reader.stats.events || []).slice(0, 40) },
          heap_mb: Math.round(process.memoryUsage().heapUsed / 1048576),
          elapsed_ms: Date.now() - startedAt });
      } catch (e) {
        const safe = String(e.message || 'DELTA_RUN_FAILED').replace(/postgres(?:ql)?:\/\/\S+/gi, '[redacted]');
        // A commit refusal still walked real wallets and still wrote them down.
        // Reporting only the error would hide what the attempt achieved and
        // make the next run look like it started from nothing.
        line({ t: 'error', error: safe, committed: false, waiting_on: lastPhase,
          ...(e.runSummary || {}),
          xrpl: { requests: reader.stats.requests, retries: reader.stats.retries,
            reconnects: reader.stats.reconnects, endpoint: reader.stats.actual_endpoint || null,
            first_failure: reader.stats.first_failure || null,
            events: (reader.stats.events || []).slice(0, 40) },
          elapsed_ms: Date.now() - startedAt });
      } finally { clearInterval(beat); }
      return res.end();
    }

    const result = await D.acquire(job, { reader, concurrency });
    return await respondWithWindow(res, result, input, reader);
  } catch (e) {
    // A connection string can appear in a driver error; it must never leave
    // the server even though this path no longer uses one.
    const safe = String(e.message || 'DELTA_RUN_FAILED').replace(/postgres(?:ql)?:\/\/\S+/gi, '[redacted]');
    const status = /NOT_CONFIGURED|STATE_MISSING/.test(safe) ? 503 : 500;
    return res.status(status).json({ error: safe, committed: false });
  } finally { if (reader) releaseReader(reader); }
};

module.exports.packEvents = packEvents;
module.exports.buildStreamDone = buildStreamDone;
module.exports.GZIP_EVENTS_ABOVE = GZIP_EVENTS_ABOVE;
