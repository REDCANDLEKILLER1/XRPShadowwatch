'use strict';
const E = require('./evidence');
const db = require('./connection');
const roster = require('./roster');

const REPO = 'REDCANDLEKILLER1/XRPShadowwatch';
const MAIN_BRANCH = 'main';
const ARCHIVE_BRANCH = 'shadowwatch-report-archive';
const FILE_PATH = 'src/shared/auto-watchlist.json';
const MAX_CANDIDATES = 5;
const MAX_AUTO_ENTRIES = 100;
const ADDRESS_RE = /^r[1-9A-HJ-NP-Za-km-z]{24,35}$/;
const READY_TIERS = new Set(['CRITICAL_ADD_REVIEW', 'RECOMMEND_FOR_WATCH']);
const ALLOWED_TOP = new Set(['report_id', 'scan_id', 'evidence_scan_id', 'candidates']);
const ALLOWED_CANDIDATE = new Set([
  'address','suggested_label','suggested_category','classification','score',
  'action_tier','recommended_action','review_status'
]);
const MIN_LARGE_DROPS = 1000000000000n;      // 1M XRP
const SINGLE_AUTO_DROPS = MIN_LARGE_DROPS;      // server-verifiable promotion floor
const REPEAT_AUTO_DROPS = MIN_LARGE_DROPS;      // retained export name for tests/telemetry

const b64 = text => Buffer.from(text, 'utf8').toString('base64');
const unb64 = text => Buffer.from(text || '', 'base64').toString('utf8');
const json = value => JSON.stringify(value, null, 2) + '\n';

function validate(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('INVALID_ROSTER_PROMOTION_REQUEST');
  for (const key of Object.keys(raw)) if (!ALLOWED_TOP.has(key)) throw new Error('ROSTER_PROMOTION_FIELD_NOT_ALLOWED: ' + key);
  if (!/^SW-\d{8}-[A-Z0-9]{5}$/.test(raw.report_id || '')) throw new Error('INVALID_REPORT_ID');
  if (!/^SC-[A-Z0-9]+$/.test(raw.scan_id || '')) throw new Error('INVALID_SCAN_ID');
  if (!/^idx-[a-f0-9-]{36}$/.test(raw.evidence_scan_id || '')) throw new Error('INVALID_EVIDENCE_SCAN_ID');
  if (!Array.isArray(raw.candidates) || raw.candidates.length > MAX_CANDIDATES) throw new Error('INVALID_PROMOTION_CANDIDATES');

  const seen = new Set();
  const candidates = raw.candidates.map(candidate => {
    if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) throw new Error('INVALID_PROMOTION_CANDIDATE');
    for (const key of Object.keys(candidate)) if (!ALLOWED_CANDIDATE.has(key)) throw new Error('PROMOTION_CANDIDATE_FIELD_NOT_ALLOWED: ' + key);
    const address = String(candidate.address || '');
    if (!ADDRESS_RE.test(address) || seen.has(address)) throw new Error('INVALID_PROMOTION_ADDRESS');
    seen.add(address);
    const score = Number(candidate.score);
    if (!Number.isInteger(score) || score < 0 || score > 200) throw new Error('INVALID_PROMOTION_SCORE');
    const tier = String(candidate.action_tier || '');
    if (!READY_TIERS.has(tier)) throw new Error('PROMOTION_TIER_NOT_READY');
    if (tier === 'CRITICAL_ADD_REVIEW' && score < 150) throw new Error('PROMOTION_SCORE_TIER_MISMATCH');
    if (tier === 'RECOMMEND_FOR_WATCH' && (score < 100 || score >= 150)) throw new Error('PROMOTION_SCORE_TIER_MISMATCH');
    if (candidate.recommended_action !== 'ADD') throw new Error('PROMOTION_ACTION_NOT_READY');
    if (candidate.review_status === 'REJECTED' || candidate.review_status === 'IGNORED') throw new Error('PROMOTION_REVIEW_REFUSED');
    return {
      address,
      suggested_label: candidate.suggested_label ? String(candidate.suggested_label).slice(0, 100) : null,
      suggested_category: candidate.suggested_category ? String(candidate.suggested_category).slice(0, 50) : null,
      classification: candidate.classification ? String(candidate.classification).slice(0, 80) : 'LARGE_TRANSFER_RECEIVER',
      score,
      action_tier: tier
    };
  });
  return { report_id: raw.report_id, scan_id: raw.scan_id, evidence_scan_id: raw.evidence_scan_id, candidates };
}

function githubClient(token, fetchImpl) {
  const base = 'https://api.github.com/repos/' + REPO;
  return async function(method, path, body, allow404) {
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
      const error = new Error('GITHUB_ROSTER_HTTP_' + response.status + ': ' + String(data.message || 'request failed'));
      error.status = response.status;
      throw error;
    }
    return data;
  };
}

function categoryFor(candidate) {
  const allowed = new Set(['discovered_receiver','discovered_whale','discovered_unknown_highval','next_hop_splitter','whale']);
  if (allowed.has(candidate.suggested_category)) return candidate.suggested_category;
  if (candidate.classification === 'NEXT_HOP_SPLITTER') return 'next_hop_splitter';
  return 'discovered_receiver';
}

function handleFor(candidate) {
  const prefix = candidate.classification === 'NEXT_HOP_SPLITTER' ? 'AUTO_SPLITTER' : 'AUTO_RECV';
  return prefix + '_' + candidate.address.slice(0, 6) + '_' + candidate.address.slice(-4);
}

async function defaultQualification(address, canonicalAccounts) {
  const q = db.getExecutor();
  const row = (await q(`SELECT
      count(*) FILTER (WHERE amount_drops::numeric >= $3::numeric)::integer AS large_count,
      COALESCE(max(amount_drops::numeric),0)::text AS max_drops,
      COALESCE(sum(amount_drops::numeric) FILTER (WHERE amount_drops::numeric >= $3::numeric),0)::text AS large_total_drops,
      max(close_time) AS latest
    FROM transactions
    WHERE validated=true AND tx_result='tesSUCCESS' AND currency='XRP'
      AND to_account=$1 AND from_account=ANY($2::text[])
      AND amount_drops IS NOT NULL
      AND close_time >= now() - interval '30 days'`,
    [address, canonicalAccounts, MIN_LARGE_DROPS.toString()])).rows[0] || {};
  const largeCount = Number(row.large_count || 0);
  const maxDrops = BigInt(row.max_drops || '0');
  const totalDrops = BigInt(row.large_total_drops || '0');
  const qualified = largeCount >= 1 && maxDrops >= SINGLE_AUTO_DROPS;
  return {
    qualified,
    large_count: largeCount,
    max_drops: maxDrops.toString(),
    total_drops: totalDrops.toString(),
    latest: row.latest || null
  };
}

async function promoteCandidates(raw, deps = {}) {
  const input = validate(raw);
  const env = deps.env || process.env;
  const token = env.SHADOWWATCH_GITHUB_ARCHIVE_TOKEN;
  if (!token) throw new Error('GITHUB_ROSTER_NOT_CONFIGURED');
  if (env.VERCEL_ENV && env.VERCEL_ENV !== 'production') throw new Error('GITHUB_ROSTER_PRODUCTION_ONLY');
  const repo = env.SHADOWWATCH_GITHUB_ARCHIVE_REPOSITORY || REPO;
  if (repo !== REPO) throw new Error('GITHUB_ROSTER_TARGET_REFUSED');

  const facts = await (deps.archiveFacts || E.archiveFacts)(input.evidence_scan_id);
  if (!facts || facts.coverage_complete !== true ||
      Number(facts.transaction_windows_proved) !== Number(facts.target_wallets) ||
      Number(facts.failed || 0) !== 0 || Number(facts.truncated || 0) !== 0 || Number(facts.unproven || 0) !== 0) {
    throw new Error('ROSTER_PROMOTION_REQUIRES_COMPLETE_EVIDENCE');
  }

  const fetchImpl = deps.fetch || fetch;
  const gh = githubClient(token, fetchImpl);
  const generatedAt = String(facts.generated_at || '');
  const date = /^\d{4}-\d{2}-\d{2}/.test(generatedAt) ? generatedAt.slice(0, 10) : null;
  if (!date) throw new Error('ROSTER_PROMOTION_RUN_DATE_UNPROVEN');
  const receiptPath = '/contents/reports/' + date.replace(/-/g, '/') + '/' + input.report_id +
    '/receipt.json?ref=' + encodeURIComponent(ARCHIVE_BRANCH);
  const receiptFile = await gh('GET', receiptPath, undefined, true);
  if (!receiptFile) throw new Error('ROSTER_PROMOTION_ARCHIVE_RECEIPT_REQUIRED');
  let receipt;
  try { receipt = JSON.parse(unb64(receiptFile.content)); }
  catch (_) { throw new Error('ROSTER_PROMOTION_ARCHIVE_RECEIPT_INVALID'); }
  if (receipt.report_id !== input.report_id || receipt.scan_id !== input.scan_id ||
      receipt.evidence_scan_id !== input.evidence_scan_id || receipt.coverage_complete !== true) {
    throw new Error('ROSTER_PROMOTION_ARCHIVE_IDENTITY_MISMATCH');
  }

  const canonical = (deps.roster || roster.roster)();
  const canonicalAccounts = canonical.map(w => w.address);
  const watched = new Set(canonicalAccounts);
  const qualify = deps.qualifyCandidate || defaultQualification;
  const accepted = [];
  const skipped = [];
  for (const candidate of input.candidates) {
    if (watched.has(candidate.address)) {
      skipped.push({ address: candidate.address, reason: 'ALREADY_WATCHED' });
      continue;
    }
    const proof = await qualify(candidate.address, canonicalAccounts);
    if (!proof || proof.qualified !== true) {
      skipped.push({ address: candidate.address, reason: 'SERVER_EVIDENCE_FLOOR_NOT_MET' });
      continue;
    }
    accepted.push({ candidate, proof });
  }

  if (!accepted.length) {
    return { status: 'NO_READY_CANDIDATES', report_id: input.report_id, added: 0, skipped: skipped.length, skipped_candidates: skipped };
  }

  for (let attempt = 0; attempt < 4; attempt++) {
    const current = await gh('GET', '/contents/' + FILE_PATH + '?ref=' + MAIN_BRANCH, undefined, true);
    let document = { version: 1, updated_at: null, entries: [] };
    if (current) {
      try { document = JSON.parse(unb64(current.content)); }
      catch (_) { throw new Error('AUTO_WATCHLIST_INVALID_JSON'); }
    }
    if (!document || document.version !== 1 || !Array.isArray(document.entries)) throw new Error('AUTO_WATCHLIST_INVALID');
    if (document.entries.length > MAX_AUTO_ENTRIES) throw new Error('AUTO_WATCHLIST_SIZE_REFUSED');

    const existing = new Set(document.entries.map(e => e && e.address).filter(Boolean));
    const now = new Date().toISOString();
    const additions = [];
    for (const item of accepted) {
      if (existing.has(item.candidate.address)) {
        skipped.push({ address: item.candidate.address, reason: 'ALREADY_PROMOTED' });
        continue;
      }
      if (document.entries.length + additions.length >= MAX_AUTO_ENTRIES) {
        skipped.push({ address: item.candidate.address, reason: 'AUTO_WATCHLIST_CAP_REACHED' });
        continue;
      }
      const maxXrp = Number(BigInt(item.proof.max_drops || '0')) / 1e6;
      additions.push({
        address: item.candidate.address,
        handle: handleFor(item.candidate),
        cat: categoryFor(item.candidate),
        identified: false,
        source: 'auto_wallet_finder',
        source_report: input.report_id,
        source_scan: input.scan_id,
        evidence_scan_id: input.evidence_scan_id,
        classification: item.candidate.classification,
        score: item.candidate.score,
        action_tier: item.candidate.action_tier,
        server_evidence: {
          large_receipts_from_watched: Number(item.proof.large_count || 0),
          max_received_xrp: Number.isFinite(maxXrp) ? maxXrp : null,
          latest: item.proof.latest || null
        },
        added_at: now
      });
    }

    if (!additions.length) {
      return { status: 'ALREADY_PRESENT', report_id: input.report_id, added: 0, skipped: skipped.length, skipped_candidates: skipped };
    }

    document.entries = document.entries.concat(additions).sort((a, b) => String(a.address).localeCompare(String(b.address)));
    document.updated_at = now;
    const body = {
      message: 'watchlist: auto-promote ' + additions.length + ' candidate(s) from ' + input.report_id,
      content: b64(json(document)),
      branch: MAIN_BRANCH
    };
    if (current && current.sha) body.sha = current.sha;
    try {
      const saved = await gh('PUT', '/contents/' + FILE_PATH, body);
      return {
        status: 'PROMOTED',
        report_id: input.report_id,
        branch: MAIN_BRANCH,
        path: FILE_PATH,
        commit_sha: saved.commit && saved.commit.sha || null,
        added: additions.length,
        skipped: skipped.length,
        addresses: additions.map(e => e.address),
        skipped_candidates: skipped,
        retry_count: attempt
      };
    } catch (e) {
      if ((e.status === 409 || e.status === 422) && attempt < 3) continue;
      throw e;
    }
  }
  throw new Error('GITHUB_ROSTER_RETRY_EXHAUSTED');
}

module.exports = {
  promoteCandidates, validate, defaultQualification, REPO, MAIN_BRANCH, ARCHIVE_BRANCH,
  FILE_PATH, MAX_CANDIDATES, MAX_AUTO_ENTRIES, MIN_LARGE_DROPS, SINGLE_AUTO_DROPS, REPEAT_AUTO_DROPS
};
