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
const D = require('../src/db/delta-acquisition');
const Store = require('../src/db/github-store');
const State = require('../src/db/evidence-state');
const A = require('../src/db/github-archive');
const roster = require('../src/db/roster');
const { acquireReader, releaseReader } = require('../src/db/xrpl-reader');

// Leave room inside the function's own ceiling to serialise and return a
// result. A run that is going to be cut off should say so rather than be killed
// mid-sentence.
const READ_BUDGET_MS = 240000;

// The roster is parsed out of committed source. A parse failure must not turn
// a status check into a 500 — the checkpoint is still readable and still worth
// reporting — so it degrades to null rather than throwing.
const rosterCount = () => { try { return roster.select().accounts.length; } catch (_) { return null; } };

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
      max_admissions: Math.max(0, Math.min(Number(input.max_admissions) || 12, 60))
    };
    const concurrency = Number(input.concurrency) || 4;

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
        endpoint: reader.stats.actual_endpoint || null,
        first_failure: reader.stats.first_failure || null,
        ms: Date.now() - startedAt }), 5000);
      if (typeof beat.unref === 'function') beat.unref();
      try {
        const result = await D.acquire(job, { reader, concurrency,
          // The lanes report as they land, so a stalled XRPL connect is visible
          // as a missing anchor rather than as a run that is simply quiet.
          onPhase: (name, detail) => { lastPhase = name === 'plan' ? 'wallets' : name;
            line({ t: 'phase', phase: name, ...detail, ms: Date.now() - startedAt }); },
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
        line({ t: 'done', ...summary, wallets_detail: wallets,
          xrpl: { requests: reader.stats.requests, retries: reader.stats.retries,
            reconnects: reader.stats.reconnects, waits_ms: reader.stats.waits_ms,
            endpoint: reader.stats.actual_endpoint || null,
            events: (reader.stats.events || []).slice(0, 40) },
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
    return res.json(result);
  } catch (e) {
    // A connection string can appear in a driver error; it must never leave
    // the server even though this path no longer uses one.
    const safe = String(e.message || 'DELTA_RUN_FAILED').replace(/postgres(?:ql)?:\/\/\S+/gi, '[redacted]');
    const status = /NOT_CONFIGURED|STATE_MISSING/.test(safe) ? 503 : 500;
    return res.status(status).json({ error: safe, committed: false });
  } finally { if (reader) releaseReader(reader); }
};
