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

  const allowed = req.method === 'GET' ? ['state', 'health'] : ['run'];
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
