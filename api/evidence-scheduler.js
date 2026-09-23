'use strict';
// ShadowWatch independent evidence scheduler.
//
// Production-only, cron-authenticated, and disabled until the operator flips
// SHADOWWATCH_EVIDENCE_SCHEDULER_ENABLED=true. It advances the SAME GitHub
// checkpoint as /api/delta by calling the existing acquisition core directly;
// no browser, report render, legacy fallback, signing, or XRPL mutation exists
// on this path.
const crypto = require('crypto');
const D = require('../src/db/delta-acquisition');
const roster = require('../src/db/roster');
const { acquireReader, releaseReader } = require('../src/db/xrpl-reader');

const READ_BUDGET_MS = 210000; // mirrors /api/delta: 300s ceiling - 90s ending reserve
const CONCURRENCY = 8;
const MAX_ADMISSIONS = 150;

function enabled(env) {
  return String((env || process.env).SHADOWWATCH_EVIDENCE_SCHEDULER_ENABLED || '').toLowerCase() === 'true';
}

function authorized(req, env) {
  const e = env || process.env;
  const secret = String(e.CRON_SECRET || '');
  if (secret.length < 16) return { ok: false, error: 'CRON_SECRET_NOT_CONFIGURED' };
  const header = req && req.headers && (req.headers.authorization || req.headers.Authorization);
  return header === 'Bearer ' + secret
    ? { ok: true }
    : { ok: false, error: 'UNAUTHORIZED' };
}

function schedulerReportId(nowMs, randomBytes) {
  const now = new Date(Number(nowMs));
  const ymd = now.toISOString().slice(0, 10).replace(/-/g, '');
  const bytes = (randomBytes || crypto.randomBytes)(3);
  const suffix = ('E' + Buffer.from(bytes).toString('hex').toUpperCase()).slice(0, 5);
  return 'SW-' + ymd + '-' + suffix;
}

function classify(result) {
  if (result && result.committed === true) return { status: 'ADVANCED', httpStatus: 200, ok: true };
  const reason = result && result.reason;
  if (reason === 'ANCHOR_NOT_ADVANCED') return { status: 'CURRENT', httpStatus: 200, ok: true };
  // Bounded incompleteness is resumable work, not a lie and not a reason to
  // throw away the journal. Vercel cron does not retry failed invocations, so
  // return 202 and let the next scheduled run resume it.
  if (reason === 'RUN_INCOMPLETE') return { status: 'RESUMABLE_INCOMPLETE', httpStatus: 202, ok: true };
  return { status: 'BLOCKED', httpStatus: 503, ok: false };
}

async function runScheduledAcquisition(deps) {
  const d = deps || {};
  const now = typeof d.now === 'function' ? Number(d.now()) : Date.now();
  const makeId = d.makeReportId || (ms => schedulerReportId(ms));
  const getRoster = d.selectRoster || (() => roster.select());
  const getReader = d.acquireReader || acquireReader;
  const putReader = d.releaseReader || releaseReader;
  const acquire = d.acquire || D.acquire;
  const selected = getRoster();
  const accounts = selected && Array.isArray(selected.accounts) ? selected.accounts : [];
  if (!accounts.length) throw new Error('SCHEDULER_ROSTER_EMPTY');

  const reader = getReader();
  reader.deadline = now + READ_BUDGET_MS;
  const reportId = makeId(now);
  const phases = [];
  const onPhase = (name, detail) => {
    const record = { phase: name, ...(detail || {}) };
    phases.push(record);
    if (!d.silent) console.log('[evidence-scheduler] phase ' + name + ' ' + JSON.stringify(detail || {}));
  };

  try {
    if (!d.silent) console.log('[evidence-scheduler] start ' + reportId + ' wallets=' + accounts.length);
    const result = await acquire({
      report_id: reportId,
      scan_id: null,
      sealed_at: null,
      roster: accounts,
      max_admissions: MAX_ADMISSIONS,
      // No report window: scheduler commits ledger evidence only. Interactive
      // report runs later read whatever current proven window they need.
      window_start_ms: null,
      window_end_ms: null
    }, {
      reader,
      concurrency: CONCURRENCY,
      onPhase
    });
    const verdict = classify(result);
    const body = {
      ok: verdict.ok,
      status: verdict.status,
      report_id: reportId,
      reason: result && result.reason || null,
      committed: !!(result && result.committed),
      anchor_ledger: result && result.anchor_ledger || null,
      anchor_close: result && result.anchor_close || null,
      state_version: result && (result.state_version || result.state_version_read) || null,
      target_wallets: result && result.target_wallets || accounts.length,
      complete_wallets: result && result.complete_wallets || 0,
      failed_wallets: result && result.failed_wallets || 0,
      transactions: result && result.transactions || 0,
      xrpl_requests: result && result.xrpl_requests || (reader.stats && reader.stats.requests) || 0,
      resumed: result && result.resumed || null,
      phases: phases.slice(-12)
    };
    if (!d.silent) console.log('[evidence-scheduler] done ' + JSON.stringify(body));
    return { httpStatus: verdict.httpStatus, body };
  } finally {
    putReader(reader);
  }
}

async function handler(req, res) {
  res.setHeader('Cache-Control', 'private, no-store, max-age=0');
  res.setHeader('CDN-Cache-Control', 'no-store');
  res.setHeader('Vercel-CDN-Cache-Control', 'no-store');
  res.setHeader('X-Content-Type-Options', 'nosniff');

  if (!req || req.method !== 'GET') return res.status(405).json({ ok: false, error: 'METHOD_NOT_ALLOWED' });
  if (process.env.VERCEL_ENV !== 'production') {
    return res.status(403).json({ ok: false, error: 'PRODUCTION_ONLY' });
  }
  const auth = authorized(req, process.env);
  if (!auth.ok) {
    return res.status(auth.error === 'CRON_SECRET_NOT_CONFIGURED' ? 503 : 401)
      .json({ ok: false, error: auth.error });
  }
  if (!enabled(process.env)) {
    return res.status(200).json({ ok: true, status: 'DISABLED', evidence_write_attempted: false });
  }

  try {
    const out = await runScheduledAcquisition();
    return res.status(out.httpStatus).json(out.body);
  } catch (e) {
    console.error('[evidence-scheduler] failed', e && e.stack || e);
    return res.status(500).json({ ok: false, status: 'ERROR', error: String(e && e.message || e) });
  }
}

module.exports = handler;
module.exports._test = {
  READ_BUDGET_MS, CONCURRENCY, MAX_ADMISSIONS,
  enabled, authorized, schedulerReportId, classify, runScheduledAcquisition
};
