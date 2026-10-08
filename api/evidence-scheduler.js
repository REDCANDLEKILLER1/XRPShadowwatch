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
const MAX_ATTEMPTS = 2;
const RETRY_MIN_REMAINING_MS = 45000;

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

function retryableResult(result) {
  return !!(result && result.committed !== true && result.reason === 'RUN_INCOMPLETE');
}

function retryableError(error) {
  const msg = String(error && (error.message || error.code) || error || '');
  return /timeout|timed out|network|connection|socket|link down|link closed|ECONNRESET|ECONNREFUSED|ETIMEDOUT|EAI_AGAIN|too busy|quota|rate.?limit|\b429\b|temporar/i.test(msg);
}

async function runScheduledAcquisition(deps) {
  const d = deps || {};
  // Recovery slots only finish saved work; they never begin a fresh collection.
  if (d.resumeOnly) {
    const Store = require('../src/db/github-store');
    const Journal = require('../src/db/run-journal');
    const [loaded, saved] = await Promise.all([
      (d.readState || Store.readState)(), (d.readJournal || Store.readJournal)()
    ]);
    if (!loaded.state || !saved.journal || saved.unreadable ||
        !Journal.usable(saved.journal, loaded.state).ok) {
      return {httpStatus:200,body:{ok:true,status:'NO_PENDING_RECOVERY',evidence_write_attempted:false}};
    }
  }
  const now = typeof d.now === 'function' ? Number(d.now()) : Date.now();
  const clockNow = typeof d.clockNow === 'function' ? d.clockNow : Date.now;
  const makeId = d.makeReportId || (ms => schedulerReportId(ms));
  const getRoster = d.selectRoster || (() => require('../src/db/auto-roster').selection({env:d.env||process.env}));
  const getReader = d.acquireReader || acquireReader;
  const putReader = d.releaseReader || releaseReader;
  const acquire = d.acquire || D.acquire;
  const selected = await getRoster();
  const accounts = selected && Array.isArray(selected.accounts) ? selected.accounts : [];
  if (!accounts.length) throw new Error('SCHEDULER_ROSTER_EMPTY');

  const reportId = makeId(now);
  const deadline = now + READ_BUDGET_MS;
  const phases = [];
  const onPhase = (name, detail) => {
    const record = { phase: name, ...(detail || {}) };
    phases.push(record);
    if (!d.silent) console.log('[evidence-scheduler] phase ' + name + ' ' + JSON.stringify(detail || {}));
  };
  const job = {
    report_id: reportId,
    scan_id: null,
    sealed_at: null,
    roster: accounts,
    auto_roster: selected.auto_roster || null,
    ...(selected.auto_roster && selected.auto_roster.candidates.length ? {cold_window_ledgers:100000} : {}),
    max_admissions: MAX_ADMISSIONS,
    // No report window: scheduler commits ledger evidence only. Interactive
    // report runs later read whatever current proven window they need.
    window_start_ms: null,
    window_end_ms: null
  };

  let result = null;
  let attempts = 0;
  let totalRequests = 0;
  let retrySkipped = null;

  if (!d.silent) console.log('[evidence-scheduler] start ' + reportId + ' wallets=' + accounts.length);

  while (attempts < MAX_ATTEMPTS) {
    attempts++;
    onPhase('attempt', { attempt: attempts, max_attempts: MAX_ATTEMPTS, retry: attempts > 1 });
    const reader = getReader();
    reader.deadline = deadline;
    try {
      result = await acquire(job, {
        reader,
        concurrency: CONCURRENCY,
        onPhase
      });
      totalRequests += Number(result && result.xrpl_requests) ||
        Number(reader.stats && reader.stats.requests) || 0;
    } catch (e) {
      totalRequests += Number(reader.stats && reader.stats.requests) || 0;
      const remaining = deadline - Number(clockNow());
      if (attempts < MAX_ATTEMPTS && remaining >= RETRY_MIN_REMAINING_MS && retryableError(e)) {
        onPhase('retry', {
          next_attempt: attempts + 1,
          trigger: 'TRANSIENT_ERROR',
          remaining_ms: Math.max(0, remaining),
          error: String(e && e.message || e)
        });
        continue;
      }
      if (attempts < MAX_ATTEMPTS && retryableError(e) && remaining < RETRY_MIN_REMAINING_MS) {
        retrySkipped = 'INSUFFICIENT_BUDGET';
        onPhase('retry-skipped', {
          trigger: 'TRANSIENT_ERROR',
          remaining_ms: Math.max(0, remaining),
          minimum_ms: RETRY_MIN_REMAINING_MS
        });
      }
      throw e;
    } finally {
      putReader(reader);
    }

    if (!retryableResult(result) || attempts >= MAX_ATTEMPTS) break;
    const remaining = deadline - Number(clockNow());
    if (remaining < RETRY_MIN_REMAINING_MS) {
      retrySkipped = 'INSUFFICIENT_BUDGET';
      onPhase('retry-skipped', {
        trigger: 'RUN_INCOMPLETE',
        remaining_ms: Math.max(0, remaining),
        minimum_ms: RETRY_MIN_REMAINING_MS
      });
      break;
    }
    onPhase('retry', {
      next_attempt: attempts + 1,
      trigger: 'RUN_INCOMPLETE',
      remaining_ms: Math.max(0, remaining),
      complete_wallets: Number(result.complete_wallets) || 0,
      target_wallets: Number(result.target_wallets) || accounts.length
    });
  }

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
    xrpl_requests: totalRequests,
    resumed: result && result.resumed || null,
    attempts,
    retried: attempts > 1,
    retry_skipped: retrySkipped,
    retry_exhausted: attempts >= MAX_ATTEMPTS && retryableResult(result),
    phases: phases.slice(-16)
  };
  if (!d.silent) console.log('[evidence-scheduler] done ' + JSON.stringify(body));
  return { httpStatus: verdict.httpStatus, body };
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
    const out = await runScheduledAcquisition({resumeOnly:req._shadowwatchResumeOnly === true});
    return res.status(out.httpStatus).json(out.body);
  } catch (e) {
    console.error('[evidence-scheduler] failed', e && e.stack || e);
    return res.status(500).json({ ok: false, status: 'ERROR', error: String(e && e.message || e) });
  }
}

module.exports = handler;
module.exports._test = {
  READ_BUDGET_MS, CONCURRENCY, MAX_ADMISSIONS, MAX_ATTEMPTS, RETRY_MIN_REMAINING_MS,
  enabled, authorized, schedulerReportId, classify, retryableResult, retryableError, runScheduledAcquisition
};
