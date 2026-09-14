'use strict';
const crypto = require('crypto');

const REPO = 'REDCANDLEKILLER1/XRPShadowwatch';
const BRANCH = 'main';
const FILE = 'src/shared/watchlist-promotions.json';
const MAX_PROMOTIONS = 2000;
const ALLOWED = new Set(['report_id', 'scan_id', 'address']);
const B58 = 'rpshnaf39wBUDNEGHJKLM4PQRST7VWXYZ2bcdeCg65jkm8oFqi1tuvAxyz';

const b64 = text => Buffer.from(text, 'utf8').toString('base64');
const json = value => JSON.stringify(value, null, 2) + '\n';

function b58decode(s) {
  let n = 0n;
  for (const c of s) {
    const i = B58.indexOf(c);
    if (i < 0) return null;
    n = n * 58n + BigInt(i);
  }
  let h = n.toString(16);
  if (h.length % 2) h = '0' + h;
  const body = n === 0n ? Buffer.alloc(0) : Buffer.from(h, 'hex');
  let pad = 0;
  for (const c of s) { if (c === B58[0]) pad++; else break; }
  return Buffer.concat([Buffer.alloc(pad), body]);
}
function isXrplAddress(s) {
  if (typeof s !== 'string' || !/^r[1-9A-HJ-NP-Za-km-z]{24,34}$/.test(s)) return false;
  const buf = b58decode(s);
  if (!buf || buf.length !== 25 || buf[0] !== 0) return false;
  const sha = x => crypto.createHash('sha256').update(x).digest();
  return sha(sha(buf.subarray(0, 21))).subarray(0, 4).equals(buf.subarray(21));
}
function validate(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('INVALID_PROMOTION_REQUEST');
  for (const key of Object.keys(input)) if (!ALLOWED.has(key)) throw new Error('PROMOTION_FIELD_NOT_ALLOWED: ' + key);
  if (!/^SW-\d{8}-[A-Z0-9]{5}$/.test(input.report_id || '')) throw new Error('INVALID_REPORT_ID');
  if (!/^SC-[A-Z0-9]+$/.test(input.scan_id || '')) throw new Error('INVALID_SCAN_ID');
  if (!isXrplAddress(input.address)) throw new Error('INVALID_XRPL_ADDRESS');
  return { report_id: input.report_id, scan_id: input.scan_id, address: input.address };
}
function neutralEntry(input, now) {
  return {
    address: input.address,
    label: 'AUTO_WATCH_' + input.address.slice(0, 8),
    cat: 'discovered_unknown_highval',
    source_report: input.report_id,
    source_scan: input.scan_id,
    promoted_at: now,
    source: 'canonical_add'
  };
}
function client(token, repo, fetchImpl) {
  const base = 'https://api.github.com/repos/' + repo;
  return async function request(method, path, body, allow404) {
    const response = await fetchImpl(base + path, {
      method,
      headers: {
        Accept: 'application/vnd.github+json',
        Authorization: 'Bearer ' + token,
        'X-GitHub-Api-Version': '2022-11-28',
        'Content-Type': 'application/json'
      },
      body: body === undefined ? undefined : JSON.stringify(body)
    });
    if (allow404 && response.status === 404) return null;
    const data = await response.json().catch(() => ({}));
    if (!response.ok) {
      const error = new Error('GITHUB_PROMOTION_HTTP_' + response.status + ': ' + String(data.message || 'request failed'));
      error.status = response.status;
      throw error;
    }
    return data;
  };
}

async function promote(raw, deps = {}) {
  const input = validate(raw);
  const env = deps.env || process.env;
  if (env.VERCEL_ENV && env.VERCEL_ENV !== 'production') throw new Error('PROMOTION_NOT_PRODUCTION');
  const repo = env.SHADOWWATCH_GITHUB_PROMOTION_REPOSITORY || REPO;
  const branch = env.SHADOWWATCH_GITHUB_PROMOTION_BRANCH || BRANCH;
  if (repo !== REPO || branch !== BRANCH) throw new Error('PROMOTION_TARGET_REFUSED');
  if (env.VERCEL_GIT_REPO_OWNER && env.VERCEL_GIT_REPO_OWNER !== 'REDCANDLEKILLER1') throw new Error('PROMOTION_DEPLOYMENT_REFUSED');
  if (env.VERCEL_GIT_REPO_SLUG && env.VERCEL_GIT_REPO_SLUG !== 'XRPShadowwatch') throw new Error('PROMOTION_DEPLOYMENT_REFUSED');
  const token = env.SHADOWWATCH_GITHUB_PROMOTION_TOKEN || env.SHADOWWATCH_GITHUB_ARCHIVE_TOKEN;
  if (!token) throw new Error('GITHUB_PROMOTION_NOT_CONFIGURED');

  const fetchImpl = deps.fetch || fetch;
  const gh = client(token, repo, fetchImpl);
  const nowValue = typeof deps.now === 'function' ? deps.now() : deps.now;
  const now = nowValue ? new Date(nowValue).toISOString() : new Date().toISOString();

  for (let attempt = 0; attempt < 4; attempt++) {
    const current = await gh('GET', '/contents/' + FILE + '?ref=' + encodeURIComponent(branch), undefined, true);
    let rows = [];
    let currentSha = null;
    if (current) {
      currentSha = current.sha;
      try { rows = JSON.parse(Buffer.from(current.content || '', 'base64').toString('utf8')); }
      catch (_) { throw new Error('PROMOTION_ROSTER_INVALID'); }
    }
    if (!Array.isArray(rows)) throw new Error('PROMOTION_ROSTER_INVALID');
    if (rows.length > MAX_PROMOTIONS) throw new Error('PROMOTION_ROSTER_TOO_LARGE');
    if (rows.some(row => row && row.address === input.address)) {
      return {
        attempted: true,
        status: 'ALREADY_PROMOTED',
        address: input.address,
        report_id: input.report_id,
        scan_id: input.scan_id,
        branch,
        commit_sha: null,
        retry_count: attempt
      };
    }

    const next = rows.concat([neutralEntry(input, now)]);
    const payload = {
      message: 'watchlist: promote ' + input.address.slice(0, 10) + ' from ' + input.report_id,
      content: b64(json(next)),
      branch
    };
    if (currentSha) payload.sha = currentSha;

    try {
      const made = await gh('PUT', '/contents/' + FILE, payload);
      return {
        attempted: true,
        status: 'PROMOTED',
        address: input.address,
        report_id: input.report_id,
        scan_id: input.scan_id,
        branch,
        commit_sha: made && made.commit && made.commit.sha || null,
        promoted_at: now,
        retry_count: attempt
      };
    } catch (e) {
      // A concurrent promotion may move the blob between our GET and PUT.
      // Re-read and retry; if the other request promoted this same address the
      // duplicate check above turns the next pass into ALREADY_PROMOTED.
      if ((e.status === 409 || e.status === 422) && attempt < 3) continue;
      throw e;
    }
  }
  throw new Error('GITHUB_PROMOTION_RETRY_EXHAUSTED');
}

module.exports = {
  promote, validate, isXrplAddress, neutralEntry,
  REPO, BRANCH, FILE, MAX_PROMOTIONS
};
