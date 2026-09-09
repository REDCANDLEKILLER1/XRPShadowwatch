#!/usr/bin/env node
'use strict';
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const M = require('../src/db/watchlist-promotions');

const GOOD = 'r3kcWLCLaqVaC9VeLDakKHW26LuYcYHZpZ';
const SECOND = 'rDT9vb8Jd9USHfWFh5nEhpwfJD3DbjXn88';
const report = 'SW-20260909-CUK9R';
const scan = 'SC-MTU3SZS4';
let checks = 0;
function ok(cond, msg) { assert.ok(cond, msg); checks++; }
function eq(a, b, msg) { assert.deepStrictEqual(a, b, msg); checks++; }
async function rejects(fn, rx, msg) {
  let err = null;
  try { await fn(); } catch (e) { err = e; }
  ok(err && rx.test(String(err.message)), msg + (err ? ' (' + err.message + ')' : ''));
}

function response(status, body) {
  return { status, ok: status >= 200 && status < 300, json: async () => body };
}
function fakeGithub(initialRows, opts = {}) {
  let rows = JSON.parse(JSON.stringify(initialRows || []));
  let sha = 'blob-1';
  let puts = 0;
  let gets = 0;
  let conflictOnce = !!opts.conflictOnce;
  const requests = [];
  const fetch = async (url, init = {}) => {
    requests.push({ url, init });
    const method = init.method || 'GET';
    if (method === 'GET' && url.includes('/contents/' + M.FILE)) {
      gets++;
      return response(200, { sha, content: Buffer.from(JSON.stringify(rows, null, 2) + '\n').toString('base64') });
    }
    if (method === 'PUT' && url.endsWith('/contents/' + M.FILE)) {
      puts++;
      if (conflictOnce) { conflictOnce = false; return response(409, { message: 'conflict' }); }
      const body = JSON.parse(init.body);
      rows = JSON.parse(Buffer.from(body.content, 'base64').toString('utf8'));
      sha = 'blob-' + (puts + 1);
      return response(200, { commit: { sha: 'commit-' + puts }, content: { sha } });
    }
    return response(404, { message: 'not found' });
  };
  return { fetch, rows: () => rows, puts: () => puts, gets: () => gets, requests };
}

(async () => {
  // Request validation is strict and base58check-backed.
  eq(M.validate({ report_id: report, scan_id: scan, address: GOOD }).address, GOOD, 'valid request accepted');
  await rejects(() => Promise.resolve(M.validate({ report_id: report, scan_id: scan, address: GOOD, label: 'spoof' })), /FIELD_NOT_ALLOWED/, 'extra candidate metadata refused');
  await rejects(() => Promise.resolve(M.validate({ report_id: report, scan_id: scan, address: GOOD.slice(0, -1) + 'A' })), /INVALID_XRPL_ADDRESS/, 'bad checksum refused');

  const env = { SHADOWWATCH_GITHUB_PROMOTION_TOKEN: 'test-token' };
  const gh1 = fakeGithub([]);
  const made = await M.promote({ report_id: report, scan_id: scan, address: GOOD }, { env, fetch: gh1.fetch, now: '2026-09-09T13:00:00Z' });
  eq(made.status, 'PROMOTED', 'new address promoted');
  eq(made.commit_sha, 'commit-1', 'commit sha returned');
  eq(gh1.puts(), 1, 'one GitHub write for one promotion');
  eq(gh1.rows().length, 1, 'promotion row appended');
  eq(gh1.rows()[0].cat, 'discovered_unknown_highval', 'server uses neutral category, not client identity/classification');
  eq(gh1.rows()[0].source_report, report, 'report provenance stored');
  eq(gh1.rows()[0].source_scan, scan, 'scan provenance stored');

  const gh2 = fakeGithub([{ address: GOOD, label: 'EXISTING', cat: 'discovered_receiver' }]);
  const dup = await M.promote({ report_id: report, scan_id: scan, address: GOOD }, { env, fetch: gh2.fetch });
  eq(dup.status, 'ALREADY_PROMOTED', 'duplicate is idempotent');
  eq(gh2.puts(), 0, 'duplicate does not create another commit');

  const gh3 = fakeGithub([], { conflictOnce: true });
  const retried = await M.promote({ report_id: report, scan_id: scan, address: SECOND }, { env, fetch: gh3.fetch });
  eq(retried.status, 'PROMOTED', 'conflict retry eventually promotes');
  eq(retried.retry_count, 1, 'conflict retry count exposed');
  eq(gh3.gets(), 2, 'conflict causes a fresh roster read');

  await rejects(
    () => M.promote({ report_id: report, scan_id: scan, address: SECOND }, { env: { ...env, VERCEL_ENV: 'preview' }, fetch: gh3.fetch }),
    /PROMOTION_NOT_PRODUCTION/,
    'preview deployment cannot mutate production roster'
  );
  await rejects(
    () => M.promote({ report_id: report, scan_id: scan, address: SECOND }, { env: { ...env, SHADOWWATCH_GITHUB_PROMOTION_BRANCH: 'other' }, fetch: gh3.fetch }),
    /PROMOTION_TARGET_REFUSED/,
    'promotion branch is fixed to main'
  );

  // Seeded handoff wallet is a valid canonical promotion row.
  const seed = JSON.parse(fs.readFileSync(path.join(__dirname, '../src/shared/watchlist-promotions.json'), 'utf8'));
  eq(seed.length, 1, 'handoff seed contains exactly one canonical ADD');
  eq(seed[0].address, GOOD, 'CUK9R ADD wallet seeded');
  ok(M.isXrplAddress(seed[0].address), 'seed address passes XRPL checksum');
  ok(/watchlist-promotions\.json/.test(fs.readFileSync(path.join(__dirname, '../src/db/roster.js'), 'utf8')), 'server canonical roster consumes committed promotions');
  ok(/43-live-watchlist-promotion-20260909\.js/.test(fs.readFileSync(path.join(__dirname, '../src/brief/14-identity-lookup.js'), 'utf8')), 'guaranteed report entrypoint loads live promotion runtime');
  ok(JSON.parse(fs.readFileSync(path.join(__dirname, '../vercel.json'), 'utf8')).functions['api/watchlist-promote.js'], 'Vercel registers promotion endpoint');

  // Browser runtime: committed roster loads; only ADD auto-promotes; REVIEW/MONITOR stay put;
  // candidate wording and failed-rescan preservation are exercised without a browser/network.
  const runtimeSource = fs.readFileSync(path.join(__dirname, '../src/brief/43-live-watchlist-promotion-20260909.js'), 'utf8');
  const classes = new Set(['sealed']);
  const els = Object.create(null);
  function el(id, text) { return els[id] = { id, textContent: text || '' }; }
  el('mainReport', 'prior main'); el('report4k', 'prior public'); el('agentBox', 'prior agent');
  el('masterPaste', 'prior master'); el('bundleBox', 'prior bundle'); el('briefBox', 'prior brief'); el('sealJson', '{"old":true}');
  el('scanBtn', 'RUN');
  const posted = [];
  const marked = [];
  const events = {};
  const context = {
    console,
    Date,
    Promise,
    Object,
    JSON,
    RegExp,
    String,
    Number,
    Array,
    Error,
    setTimeout: fn => { Promise.resolve().then(fn); return 1; },
    clearTimeout: () => {},
    setInterval: () => 1,
    clearInterval: () => {},
    localStorage: { getItem: () => null, setItem: () => {}, removeItem: () => {} },
    navigator: {},
    WATCHLIST: [],
    KNOWN: {},
    state: {
      pack: { report_id: report, scan_id: scan, marker: 'prior' },
      seal: { report_id: report, scan_id: scan },
      morningStoryReport: 'prior story',
      discoveryInbox: []
    },
    document: {
      body: { classList: {
        contains: c => classes.has(c),
        add: (...cs) => cs.forEach(c => classes.add(c)),
        remove: (...cs) => cs.forEach(c => classes.delete(c))
      } },
      getElementById: id => els[id] || null
    },
    fetch: async (url, init = {}) => {
      if (String(url).startsWith('/src/shared/watchlist-promotions.json')) {
        return { ok: true, status: 200, json: async () => seed };
      }
      if (url === '/api/watchlist-promote') {
        const body = JSON.parse(init.body);
        posted.push(body);
        return { ok: true, status: 200, json: async () => ({ status: 'PROMOTED', commit_sha: 'runtime-commit' }) };
      }
      throw new Error('unexpected fetch ' + url);
    },
    log: () => {},
    elog: () => {}
  };
  context.window = context;
  context.window.SW_HVT_ROSTER = { stats: { total: 0, from_report_only: 0 }, targets: [] };
  const candidates = [
    { address: SECOND, suggested_label: 'ADD_ME', suggested_category: 'discovered_receiver', recommended_action: 'ADD', is_already_watched: false, seen_this_scan: false },
    { address: 'rEQjQmKnSwdwcePyAdNWbm4VoSNvbodsti', recommended_action: 'REVIEW', is_already_watched: false, seen_this_scan: true },
    { address: 'rLpvuHZFE46NUyZH5XaMvmYRJZF7aory7t', recommended_action: 'MONITOR', is_already_watched: false, seen_this_scan: true }
  ];
  context.window.AUTO_WALLET_FINDER = {
    buildSuggestedWatchlistAdditions: () => candidates,
    exportSuggestedWalletsTXT: () => 'SAFETY: All entries below are suggestions only.\nNo watchlist mutations occur automatically.\nReview each entry. Use Add-Reviewed action to confirm.',
    exportSuggestedWalletsJSON: () => ({ safety: { permanent_additions_require_review: true, no_auto_add: true } }),
    markCandidateReviewed: (address, status) => marked.push({ address, status })
  };
  context.window.SHADOW_EVENT_BUS = { on: (name, fn) => { events[name] = fn; } };
  context.window.buildMorningStoryText = () =>
    'Evidence: In the discovery queue right now: 3 flagged candidates — 2 found this scan, 0 recommended for review, separate from the 255 wallets on the permanent watch list — every one flagged on behavior.';
  context.window.run = async () => {
    context.state.pack = { marker: 'failed partial' };
    els.mainReport.textContent = 'failed partial';
    classes.delete('sealed'); classes.add('error');
  };

  vm.createContext(context);
  vm.runInContext(runtimeSource, context, { filename: '43-live-watchlist-promotion-20260909.js' });
  await context.window.SW_LIVE_WATCHLIST_PROMOTION.loadCommittedPromotions();
  ok(context.WATCHLIST.some(w => w.address === GOOD), 'committed promotion merges into WATCHLIST');
  ok(context.KNOWN[GOOD], 'committed promotion merges into KNOWN');
  eq(context.window.SW_LIVE_WATCHLIST_PROMOTION.canonicalAdditions().map(x => x.address), [SECOND], 'runtime selects only canonical ADD');
  ok(/1 marked ADD, 1 REVIEW, 1 MONITOR/.test(context.window.SW_LIVE_WATCHLIST_PROMOTION.candidateCountLine()), 'candidate counts use canonical actions');
  ok(/Canonical ADD entries auto-promote/.test(context.window.AUTO_WALLET_FINDER.exportSuggestedWalletsTXT()), 'TXT export states live promotion truth');
  eq(context.window.AUTO_WALLET_FINDER.exportSuggestedWalletsJSON().safety.no_auto_add, false, 'JSON export no_auto_add corrected');
  ok(/1 marked ADD, 1 REVIEW, 1 MONITOR/.test(context.window.buildMorningStoryText()), 'morning story wording corrected');
  eq(els.scanBtn.onclick, context.window.run, 'actual scan button is rebound to failed-rescan preservation wrapper');

  const priorPack = context.state.pack;
  await context.window.run();
  eq(context.state.pack, priorPack, 'failed rescan restores prior pack');
  eq(els.mainReport.textContent, 'prior main', 'failed rescan restores prior report surface');
  ok(classes.has('sealed') && !classes.has('error'), 'failed rescan keeps prior report sealed');

  const promoted = await context.window.SW_LIVE_WATCHLIST_PROMOTION.promoteCanonicalAdds({ seal: { report_id: report, scan_id: scan } });
  eq(promoted.results.length, 1, 'one canonical ADD attempted');
  eq(posted.length, 1, 'one server promotion POST');
  eq(posted[0], { report_id: report, scan_id: scan, address: SECOND }, 'POST contains only report id, scan id, address');
  eq(marked, [{ address: SECOND, status: 'ADDED' }], 'successful promotion marks candidate ADDED');
  ok(!context.WATCHLIST.some(w => w.address === SECOND), 'new promotion waits for the deployment-backed roster before entering WATCHLIST');

  console.log('watchlist promotion: ' + checks + '/' + checks + ' passed');
})().catch(e => { console.error(e && e.stack || e); process.exit(1); });
