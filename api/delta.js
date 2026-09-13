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
      const archive = A.archiveTarget(process.env);
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
    const result = await D.acquire({
      report_id: input.report_id,
      scan_id: typeof input.scan_id === 'string' ? input.scan_id : null,
      sealed_at: typeof input.sealed_at === 'string' ? input.sealed_at : null
    }, { reader, concurrency: Number(input.concurrency) || 4 });
    return res.json(result);
  } catch (e) {
    // A connection string can appear in a driver error; it must never leave
    // the server even though this path no longer uses one.
    const safe = String(e.message || 'DELTA_RUN_FAILED').replace(/postgres(?:ql)?:\/\/\S+/gi, '[redacted]');
    const status = /NOT_CONFIGURED|STATE_MISSING/.test(safe) ? 503 : 500;
    return res.status(status).json({ error: safe, committed: false });
  } finally { if (reader) releaseReader(reader); }
};
