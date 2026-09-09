'use strict';
const assert = require('assert/strict');
const fs = require('fs');
const P = require('../src/db/github-roster');

function response(status, data) {
  return { status, ok: status >= 200 && status < 300, json: async () => data };
}
function fakeGithub(receipt) {
  let seq = 0;
  const files = new Map();
  function key(branch, path) { return branch + ':' + path; }
  files.set(key(P.ARCHIVE_BRANCH, 'reports/2026/09/09/SW-20260909-TEST1/receipt.json'), {
    sha: 'archive1', content: JSON.stringify(receipt, null, 2) + '\n'
  });
  files.set(key(P.MAIN_BRANCH, P.FILE_PATH), {
    sha: 'roster1', content: JSON.stringify({ version: 1, updated_at: null, entries: [] }, null, 2) + '\n'
  });
  async function fetch(url, options = {}) {
    const method = options.method || 'GET';
    const u = new URL(url);
    const prefix = '/repos/' + P.REPO;
    const path = u.pathname.slice(prefix.length);
    const match = path.match(/^\/contents\/(.+)$/);
    if (!match) return response(500, { message: 'unhandled ' + method + ' ' + path });
    const filePath = decodeURIComponent(match[1]);
    if (method === 'GET') {
      const branch = u.searchParams.get('ref') || P.MAIN_BRANCH;
      const file = files.get(key(branch, filePath));
      return file ? response(200, { sha: file.sha, content: Buffer.from(file.content).toString('base64') })
                  : response(404, { message: 'Not Found' });
    }
    if (method === 'PUT') {
      const body = JSON.parse(options.body || '{}');
      const branch = body.branch;
      const current = files.get(key(branch, filePath));
      if (current && body.sha !== current.sha) return response(409, { message: 'sha mismatch' });
      const sha = 'roster' + (++seq + 1);
      files.set(key(branch, filePath), { sha, content: Buffer.from(body.content, 'base64').toString('utf8') });
      return response(200, { content: { sha }, commit: { sha: 'commit' + seq } });
    }
    return response(500, { message: 'unhandled ' + method + ' ' + path });
  }
  return {
    fetch,
    file(branch, path) {
      const item = files.get(key(branch, path));
      return item && item.content;
    }
  };
}

const evidenceScan = 'idx-00000000-0000-4000-8000-000000000000';
const facts = {
  evidence_scan_id: evidenceScan,
  generated_at: '2026-09-09T12:00:00.000Z',
  target_wallets: 255,
  transaction_windows_proved: 255,
  failed: 0,
  truncated: 0,
  unproven: 0,
  coverage_complete: true
};
const input = {
  report_id: 'SW-20260909-TEST1',
  scan_id: 'SC-TEST123',
  evidence_scan_id: evidenceScan,
  candidates: [{
    address: 'rEQjQmKnSwdwcePyAdNWbm4VoSNvbodsti',
    suggested_label: 'SPLITTER_CANDIDATE_rEQjQm…dsti',
    suggested_category: 'next_hop_splitter',
    classification: 'NEXT_HOP_SPLITTER',
    score: 125,
    action_tier: 'RECOMMEND_FOR_WATCH',
    recommended_action: 'ADD',
    review_status: 'NEW'
  }]
};
const receipt = {
  report_id: input.report_id,
  scan_id: input.scan_id,
  evidence_scan_id: input.evidence_scan_id,
  coverage_complete: true
};
const env = {
  SHADOWWATCH_GITHUB_ARCHIVE_TOKEN: 'server-only',
  SHADOWWATCH_GITHUB_ARCHIVE_REPOSITORY: P.REPO,
  VERCEL_ENV: 'production'
};
const watched = [{ address: 'rBB8peCvJcSbkmuQSe6ct6cujqNzz465cB', label: 'INST_CUSTODY_B', cat: 'whale' }];
const qualification = async () => ({
  qualified: true,
  large_count: 1,
  max_drops: '4900000000000',
  total_drops: '4900000000000',
  latest: '2026-09-03T12:31:34.784Z'
});

async function main() {
  assert.throws(() => P.validate({ ...input, path: 'src/brief/02-core.js' }), /FIELD_NOT_ALLOWED/);
  assert.throws(() => P.validate({ ...input, candidates: [{ ...input.candidates[0], action_tier: 'REVIEW', score: 90, recommended_action: 'REVIEW' }] }), /TIER_NOT_READY/);
  assert.throws(() => P.validate({ ...input, candidates: [{ ...input.candidates[0], score: 90 }] }), /SCORE_TIER_MISMATCH/);
  console.log('PASS client cannot choose a path or promote REVIEW/MONITOR candidates');

  const gh = fakeGithub(receipt);
  const first = await P.promoteCandidates(input, {
    env, fetch: gh.fetch, archiveFacts: async () => facts, roster: () => watched, qualifyCandidate: qualification
  });
  assert.equal(first.status, 'PROMOTED');
  assert.equal(first.branch, 'main');
  assert.equal(first.path, P.FILE_PATH);
  assert.equal(first.added, 1);
  const saved = JSON.parse(gh.file(P.MAIN_BRANCH, P.FILE_PATH));
  assert.equal(saved.entries.length, 1);
  assert.equal(saved.entries[0].address, input.candidates[0].address);
  assert.equal(saved.entries[0].identified, false);
  assert.match(saved.entries[0].handle, /^AUTO_SPLITTER_/);
  console.log('PASS ready candidate writes only normalized data to the fixed machine watchlist');

  const duplicate = await P.promoteCandidates(input, {
    env, fetch: gh.fetch, archiveFacts: async () => facts, roster: () => watched, qualifyCandidate: qualification
  });
  assert.equal(duplicate.status, 'ALREADY_PRESENT');
  assert.equal(JSON.parse(gh.file(P.MAIN_BRANCH, P.FILE_PATH)).entries.length, 1);
  console.log('PASS duplicate promotion is idempotent');

  await assert.rejects(() => P.promoteCandidates(input, {
    env, fetch: fakeGithub(receipt).fetch,
    archiveFacts: async () => ({ ...facts, transaction_windows_proved: 254, coverage_complete: false }),
    roster: () => watched, qualifyCandidate: qualification
  }), /REQUIRES_COMPLETE_EVIDENCE/);
  console.log('PASS incomplete evidence cannot mutate the permanent roster');

  const notReady = await P.promoteCandidates(input, {
    env, fetch: fakeGithub(receipt).fetch, archiveFacts: async () => facts, roster: () => watched,
    qualifyCandidate: async () => ({ qualified: false, large_count: 0, max_drops: '0', total_drops: '0' })
  });
  assert.equal(notReady.status, 'NO_READY_CANDIDATES');
  console.log('PASS server evidence floor independently blocks an unproved client recommendation');

  const browser = fs.readFileSync(require.resolve('../src/brief/42-evidence-index.js'), 'utf8');
  assert.equal(browser.includes('SHADOWWATCH_GITHUB_ARCHIVE_TOKEN'), false);
  assert.match(browser, /MAX_EVIDENCE_CONCURRENCY=4/);
  assert.match(browser, /CRITICAL_ADD_REVIEW/);
  assert.match(browser, /RECOMMEND_FOR_WATCH/);
  console.log('PASS token remains server-only and evidence edge concurrency is bounded at four');

  console.log('ALL AUTO WATCHLIST PROMOTION CHECKS PASS');
}
main().catch(error => { console.error(error); process.exitCode = 1; });
