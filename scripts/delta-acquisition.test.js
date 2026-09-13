#!/usr/bin/env node
'use strict';
/* ── A MORNING RUN WITH NO DATABASE ─────────────────────────────────────────
   GitHub holds the checkpoint. XRPL answers only what changed since it. Neon
   appears nowhere.

   What this suite holds the run to:

     the walk is unconditional            balance never decides whether to look
     one anchor for every wallet          wallet 3 and wallet 200 describe one instant
     the range is the checkpoint's        three days of gap searches three days
     a net-zero pass-through is caught    same balance, transactions still fetched
     a contradiction commits NOTHING      and the checkpoint does not move
     one failure commits NOTHING          254 of 255 is not a run
     one commit, never per wallet         all of it or none of it

   A fake XRPL peer and a fake GitHub, both recording every call.
──────────────────────────────────────────────────────────────────────────── */
const path = require('path');
const fs = require('fs');
const zlib = require('zlib');
const ROOT = path.join(__dirname, '..');
const D = require(path.join(ROOT, 'src/db/delta-acquisition.js'));
// The grouper, reached through the module so the ordering rule is tested
// directly rather than only through a run that happens to have one cause.
const groupOf = rows => D.groupByCause(rows);
const State = require(path.join(ROOT, 'src/db/evidence-state.js'));
const Store = require(path.join(ROOT, 'src/db/github-store.js'));

let pass = 0, fail = 0;
const check = (name, ok, detail) => {
  if (ok) { pass++; console.log('  PASS  ' + name); }
  else { fail++; console.log('  FAIL  ' + name + (detail !== undefined ? '  -> ' + JSON.stringify(detail) : '')); }
};
const ENV = { SHADOWWATCH_EVIDENCE_TOKEN: 'test-token' };
const WALLETS = ['rAlice', 'rBob', 'rCarol'];
const ANCHOR = 110000000;
const RIPPLE_EPOCH = 946684800;
const hashFor = (a, i) => (a + '0'.repeat(64)).slice(0, 60) + String(i).padStart(4, '0');

// A peer that answers the four read-only methods and records what it was asked.
function fakePeer(options) {
  const opts = options || {};
  const asked = [];
  const balances = opts.balances || {};
  const txs = opts.transactions || {};
  const LANES = opts.endpoints || ['wss://a', 'wss://b', 'wss://c', 'wss://d'];
  const lanes = LANES.map(endpoint => ({ endpoint, epoch: 1, inFlight: 0 }));
  let laneCursor = 0;
  const reader = {
    epoch: 1,
    stats: { requests: 0, events: [] },
    lanes,
    // The real Reader hands out the lane that can answer soonest; the fake
    // hands them out in turn, which is enough to prove a run SPREADS rather
    // than piling every wallet onto one server.
    async lane() { const l = lanes[laneCursor++ % lanes.length]; l.assigned = (l.assigned || 0) + 1; return l; },
    releaseLane(l) { if (l && l.assigned > 0) l.assigned--; },
    event() {},
    async ledger() { return { ledger: ANCHOR, close_ms: Date.UTC(2026, 8, 11, 6, 0, 0) }; },
    async request(command, expectedEpoch, pin) {
      this.stats.requests++;
      asked.push({ ...command, _endpoint: pin ? pin.endpoint : null });
      if (opts.pendingFrom && this.stats.requests > opts.pendingFrom) {
        const e = new Error('XRPL_ADMISSION_BUDGET_EXCEEDED'); e.pending = true; throw e;
      }
      if (command.command !== 'account_tx') throw new Error('UNEXPECTED_COMMAND_' + command.command);
      if (opts.failOn && opts.failOn === command.account) throw new Error('INJECTED_WALK_FAILURE');
      const list = (txs[command.account] || []).filter(t =>
        t.ledger >= command.ledger_index_min && t.ledger <= command.ledger_index_max);
      return {
        validated: true, account: command.account,
        ledger_index_min: command.ledger_index_min, ledger_index_max: command.ledger_index_max,
        transactions: list.map((t, i) => ({
          ledger_index: t.ledger, validated: true,
          tx: { Account: command.account, Destination: t.to || 'rDest', TransactionType: 'Payment',
            Amount: t.amount, hash: t.hash || hashFor(command.account, i),
            date: Math.floor(Date.UTC(2026, 8, 11, 5, 0, 0) / 1000) - RIPPLE_EPOCH, Fee: '12' },
          meta: { TransactionResult: 'tesSUCCESS', delivered_amount: t.amount, TransactionIndex: i,
            AffectedNodes: [{ ModifiedNode: { LedgerEntryType: 'AccountRoot',
              FinalFields: { Account: command.account, Balance: t.after },
              PreviousFields: { Balance: t.before } } }] }
        }))
      };
    },
    async balance(address, ledgerIndex, pin) {
      this.stats.requests++;
      asked.push({ command: 'account_info', account: address, _endpoint: pin ? pin.endpoint : null });
      const drops = balances[address];
      return drops === undefined ? null : { drops, ledger: ANCHOR };
    }
  };
  return { reader, asked };
}

// The same fake GitHub the store suite uses, trimmed to what a run needs.
// GitHub's documented ceiling for the contents API. Small here so a test can
// cross it without building a megabyte.
const CONTENTS_API_LIMIT = 1024;

function fakeGithub(files) {
  const calls = [];
  const blobs = new Map();
  const state = { headFiles: new Map(Object.entries(files || {})), head: 'c0', n: 0,
    blobBytes: new Map() };
  const commits = new Map([['c0', { files: new Map(state.headFiles) }]]);
  const gh = async (method, p, body, allow404) => {
    calls.push({ method, path: p });
    if (method === 'GET' && /^\/git\/ref\/heads\//.test(p)) return { object: { sha: state.head } };
    if (method === 'GET' && /^\/contents\//.test(p)) {
      const file = decodeURIComponent(p.slice('/contents/'.length).split('?')[0]);
      if (!state.headFiles.has(file)) { if (allow404) return null; throw Object.assign(new Error('404'), { status: 404 }); }
      // GitHub's contents API carries bytes only to 1 MB. Past that it
      // answers with the metadata and an EMPTY body — no error. The fake does
      // the same, because a fake that always returns the bytes cannot catch
      // the bug where the real one does not.
      const buf = Buffer.isBuffer(state.headFiles.get(file))
        ? state.headFiles.get(file) : Buffer.from(state.headFiles.get(file), 'utf8');
      const sha = 'blob-' + file;
      state.blobBytes.set(sha, buf);
      if (buf.length > CONTENTS_API_LIMIT) return { sha, size: buf.length, encoding: 'none', content: '' };
      return { sha, size: buf.length, encoding: 'base64', content: buf.toString('base64') };
    }
    // The blobs API, which carries what the contents API would not.
    if (method === 'GET' && /^\/git\/blobs\//.test(p)) {
      const sha = decodeURIComponent(p.slice('/git/blobs/'.length));
      const buf = state.blobBytes.get(sha);
      if (!buf) throw Object.assign(new Error('404'), { status: 404 });
      return { sha, size: buf.length, encoding: 'base64', content: buf.toString('base64') };
    }
    if (method === 'GET' && /^\/git\/commits\//.test(p)) return { tree: { sha: 't0' } };
    if (method === 'POST' && p === '/git/blobs') {
      const sha = 'b' + (++state.n);
      blobs.set(sha, Buffer.from(body.content, 'base64'));
      return { sha };
    }
    if (method === 'POST' && p === '/git/trees') { state.pending = body.tree; return { sha: 't' + (++state.n) }; }
    if (method === 'POST' && p === '/git/commits') {
      const sha = 'c' + (++state.n);
      const f = new Map(state.headFiles);
      // sha:null is git's deletion. The fake honours it, or a test would
      // pass on a store that silently kept files it was told to remove.
      for (const e of state.pending) { if (e.sha === null) f.delete(e.path); else f.set(e.path, blobs.get(e.sha)); }
      commits.set(sha, { files: f });
      state.proposed = sha;
      return { sha };
    }
    if (method === 'PATCH' && /^\/git\/refs\/heads\//.test(p)) {
      state.head = body.sha; state.headFiles = new Map(commits.get(body.sha).files);
      return {};
    }
    return {};
  };
  return { gh, calls, files: () => state.headFiles, head: () => state.head };
}

const genesisAt = (through, balances) => State.genesis(
  WALLETS.map(a => ({ address: a, scan_coverage_through: through,
    scan_coverage_through_close: '2026-09-10T06:00:00.000Z' })),
  { anchor_ledger: through, anchor_close: '2026-09-10T06:00:00.000Z' });

function seeded(through, balances) {
  const g = genesisAt(through);
  // Pin a prior balance so the reconciliation has both endpoints.
  const withBalance = State.seal({ ...g, wallets: g.wallets.map(w => State.walletEntry({
    ...w, balance_drops: (balances || {})[w.address] || '20000000000000', balance_ledger: through })) });
  return { [Store.STATE_PATH]: State.serialize(withBalance) };
}

const quiet = () => ({ rAlice: [], rBob: [], rCarol: [] });
const BAL = { rAlice: '20000000000000', rBob: '20000000000000', rCarol: '20000000000000' };

async function main() {
  console.log('\n1. one anchor, one state read, every wallet walked');
  const peer = fakePeer({ transactions: quiet(), balances: BAL });
  const gh = fakeGithub(seeded(ANCHOR - 1000));
  const out = await D.acquire({ report_id: 'SW-20260911-AAAAA', scan_id: 'idx-1' },
    { env: ENV, gh: gh.gh, reader: peer.reader, concurrency: 2 });
  check('the run completes and commits', out.committed === true && out.complete_wallets === 3, out.reason);
  const walks = peer.asked.filter(c => c.command === 'account_tx');
  check('every wallet was walked, none skipped', new Set(walks.map(c => c.account)).size === 3, walks.length);
  check('every walk used the SAME anchor as its upper bound',
    walks.every(c => c.ledger_index_max === ANCHOR));
  check('and started one ledger past that wallet\'s checkpoint',
    walks.every(c => c.ledger_index_min === ANCHOR - 999));
  const stateReads = gh.calls.filter(c => c.path.startsWith('/contents/' + Store.STATE_PATH));
  check('the state was read, and no archive file was',
    stateReads.length >= 1 && gh.calls.filter(c => /^\/contents\/evidence\/20/.test(c.path)).length === 0);
  check('balance was read once per wallet, pinned',
    peer.asked.filter(c => c.command === 'account_info').length === 3);
  check('ONE ref update for the whole run', gh.calls.filter(c => c.method === 'PATCH').length === 1);

  console.log('\n2. balance never decides whether to look');
  // Three wallets, identical balances before and after. One did nothing; one
  // received and forwarded five million XRP and came back to where it started.
  const passthrough = {
    rAlice: [],
    rBob: [
      { ledger: ANCHOR - 500, amount: '5000000000000', before: '20000000000000', after: '25000000000000' },
      { ledger: ANCHOR - 400, amount: '5000000000000', before: '25000000000000', after: '20000000000000' }
    ],
    rCarol: []
  };
  const peer2 = fakePeer({ transactions: passthrough, balances: BAL });
  const gh2 = fakeGithub(seeded(ANCHOR - 1000));
  const out2 = await D.acquire({ report_id: 'SW-20260911-BBBBB', scan_id: 'idx-2' },
    { env: ENV, gh: gh2.gh, reader: peer2.reader, concurrency: 1 });
  check('the net-zero wallet was walked exactly like the quiet ones',
    peer2.asked.filter(c => c.command === 'account_tx' && c.account === 'rBob').length === 1);
  check('and its two transactions were captured despite an unchanged balance',
    out2.transactions === 2 && out2.committed === true, { transactions: out2.transactions, reason: out2.reason });
  check('which reconciles — the evidence explains the zero delta',
    out2.balance_contradictions === 0 && out2.balance_reconciled === 3);
  // The structural version of the same rule.
  const SOURCE = fs.readFileSync(path.join(ROOT, 'src/db/delta-acquisition.js'), 'utf8');
  const WALK = SOURCE.split('async function walkWallet')[1].split('\nfunction buildShards')[0];
  const walkCode = WALK.replace(/^\s*\/\/.*$/gm, '');
  check('the range is computed before any balance is read',
    walkCode.indexOf('State.edgeFor(') < walkCode.indexOf('reader.balance('));
  check('and no branch in the walk tests a balance to decide whether to fetch',
    !/if\s*\([^)]*balance[^)]*\)\s*(\{|return)/i.test(walkCode));

  console.log('\n3. the gap is whatever the checkpoint says it is');
  const peer3 = fakePeer({ transactions: quiet(), balances: BAL });
  const gh3 = fakeGithub(seeded(ANCHOR - 250000));
  await D.acquire({ report_id: 'SW-20260911-CCCCC' }, { env: ENV, gh: gh3.gh, reader: peer3.reader });
  check('a three-day-old checkpoint searches the whole three days, not one',
    peer3.asked.filter(c => c.command === 'account_tx').every(c => c.ledger_index_min === ANCHOR - 249999));
  // The validated ledger has not moved since the last sealed run. There is
  // nothing new to prove, and discovering that by walking 255 wallets would
  // cost 255 requests to learn what one comparison already said.
  const peer4 = fakePeer({ transactions: quiet(), balances: BAL });
  const gh4 = fakeGithub(seeded(ANCHOR));
  const out4 = await D.acquire({ report_id: 'SW-20260911-DDDDD' }, { env: ENV, gh: gh4.gh, reader: peer4.reader });
  check('an unmoved anchor asks XRPL for nothing at all',
    peer4.asked.filter(c => c.command === 'account_tx').length === 0 &&
    peer4.asked.filter(c => c.command === 'account_info').length === 0);
  check('and it is a clean no-op, not a thrown error or a failed run',
    out4.committed === false && out4.reason === 'ANCHOR_NOT_ADVANCED', out4.reason);
  check('it reports the stored anchor so the reason is checkable',
    out4.stored_anchor_ledger === ANCHOR);
  check('and it commits nothing', gh4.calls.filter(c => c.method === 'PATCH').length === 0);

  console.log('\n4. a contradiction commits nothing');
  // rCarol's balance moved by 2 XRP with no transaction to explain it.
  const peer5 = fakePeer({ transactions: quiet(),
    balances: { ...BAL, rCarol: '18000000000000' } });
  const gh5 = fakeGithub(seeded(ANCHOR - 1000));
  const out5 = await D.acquire({ report_id: 'SW-20260911-EEEEE' }, { env: ENV, gh: gh5.gh, reader: peer5.reader });
  check('the run refuses to commit', out5.committed === false && out5.reason === 'RUN_CONTRADICTED', out5.reason);
  check('it names the wallet that cannot account for itself',
    out5.balance_contradiction_addresses.join(',') === 'rCarol', out5.balance_contradiction_addresses);
  // The CHECKPOINT did not move. The branch does move — the run writes down
  // the walking it finished so the next attempt does not pay XRPL for it twice
  // — and those are different claims. Asserting "no commit" would have been
  // asserting that the work was thrown away.
  check('the checkpoint did not move',
    JSON.parse(gh5.files().get(Store.STATE_PATH).toString('utf8')).state_version === 1 &&
    JSON.parse(gh5.files().get(Store.STATE_PATH).toString('utf8')).anchor_ledger === ANCHOR - 1000);
  check('but the finished work was written down rather than discarded',
    out5.journal_wallets === 3 && !!gh5.files().get(Store.JOURNAL_PATH), out5.journal_wallets);
  check('and the journal is quarantined — it names no path under the evidence days',
    JSON.parse(gh5.files().get(Store.JOURNAL_PATH).toString('utf8'))
      .row_shards.every(x => x.path.startsWith('evidence/runs/resume/')));
  check('and the checkpoint is exactly where it was',
    JSON.parse(gh5.files().get(Store.STATE_PATH)).wallets[0].last_proven_ledger === ANCHOR - 1000);
  check('the other two wallets still walked — the gate is the commit, not the walk',
    peer5.asked.filter(c => c.command === 'account_tx').length === 3);

  console.log('\n5. one failure is not a run');
  const peer6 = fakePeer({ transactions: quiet(), balances: BAL, failOn: 'rBob' });
  const gh6 = fakeGithub(seeded(ANCHOR - 1000));
  // A partial run must come back as a SUMMARY, not as an exception. The caller
  // has a report to render and an operator to tell; a thrown error loses the
  // 2 wallets that did prove and the reason the third did not.
  let threw6 = null;
  const out6 = await D.acquire({ report_id: 'SW-20260911-FFFFF' }, { env: ENV, gh: gh6.gh, reader: peer6.reader })
    .catch(e => { threw6 = e.message; return {}; });
  check('a partial run is reported, not thrown', threw6 === null, threw6);
  check('2 of 3 does not commit', out6.committed === false && out6.reason === 'RUN_INCOMPLETE', out6.reason);
  check('and the summary still carries what did prove',
    out6.complete_wallets === 2 && out6.target_wallets === 3,
    { complete: out6.complete_wallets, target: out6.target_wallets });
  check('the failure is reported with its cause',
    out6.failures.length === 1 && /INJECTED_WALK_FAILURE/.test(out6.failures[0].error) &&
    out6.failures[0].wallets === 1 && out6.failures[0].addresses.join(',') === 'rBob', out6.failures);
  check('the checkpoint did not move',
    JSON.parse(gh6.files().get(Store.STATE_PATH).toString('utf8')).state_version === 1);
  check('the two wallets that did prove were written down, and the failed one was not',
    out6.journal_wallets === 2 &&
    JSON.parse(gh6.files().get(Store.JOURNAL_PATH).toString('utf8'))
      .wallets.every(w => w.address !== 'rBob'), out6.journal_wallets);
  check('and the next run will repeat the same bounded edge',
    JSON.parse(gh6.files().get(Store.STATE_PATH)).state_version === 1);

  console.log('\n6. what lands in the commit');
  const peer7 = fakePeer({ transactions: passthrough, balances: BAL });
  const gh7 = fakeGithub(seeded(ANCHOR - 1000));
  const out7 = await D.acquire({ report_id: 'SW-20260911-GGGGG', scan_id: 'idx-7' },
    { env: ENV, gh: gh7.gh, reader: peer7.reader });
  const written = gh7.files();
  const shardPaths = [...written.keys()].filter(k => /^evidence\/\d{4}\//.test(k));
  check('delta shards are written under the ledger day', shardPaths.length > 0, shardPaths);
  check('events and participants are separate files',
    shardPaths.some(p => /events\.ndjson\.gz$/.test(p)) && shardPaths.some(p => /participants\.ndjson\.gz$/.test(p)));
  const eventsPath = shardPaths.find(p => /events\.ndjson\.gz$/.test(p));
  const events = zlib.gunzipSync(written.get(eventsPath)).toString('utf8').split('\n').filter(Boolean).map(JSON.parse);
  check('the shard holds the transactions the walk found', events.length === 2, events.length);
  check('and no payload is folded into an event',
    events.every(e => e.raw_tx === undefined && e.raw_meta === undefined));
  check('the AccountRoot deltas ride along, so tomorrow can still reconcile',
    events[0].evidence.balance_deltas[0].prev === '20000000000000');
  const newState = JSON.parse(written.get(Store.STATE_PATH));
  check('the state advanced to the anchor', newState.wallets.every(w => w.last_proven_ledger === ANCHOR));
  check('and carries the balance pinned to it',
    newState.wallets.every(w => w.balance_ledger === ANCHOR && w.balance_drops === '20000000000000'));
  check('the last observed transaction is recorded for the wallet that moved',
    newState.wallets.find(w => w.address === 'rBob').last_observed_tx_ledger === ANCHOR - 400);
  check('every shard the state claims is present in the same commit',
    newState.evidence_shards.every(s => written.has(s.path)), newState.evidence_shards.map(s => s.path));
  check('and hashes to the bytes that were committed',
    newState.evidence_shards.every(s => State.sha256(written.get(s.path)) === s.sha256));
  check('the run manifest is in the commit too', written.has(Store.runPath('SW-20260911-GGGGG')));

  console.log('\n7. no database, anywhere in this path');
  check('the acquisition module never requires the Neon connection',
    !/require\('\.\/connection'\)/.test(SOURCE) && !/getExecutor|db\.transaction/.test(SOURCE));
  check('and issues no SQL', !/\b(SELECT|INSERT|UPDATE|DELETE)\s/i.test(SOURCE.replace(/^\s*\/\/.*$/gm, '')));
  check('XRPL is asked only for reads the allowlist permits',
    /command: 'account_tx'/.test(SOURCE) && !/submit|sign/i.test(SOURCE.replace(/^\s*\/\/.*$/gm, '')));

  console.log('\n8. one sick endpoint does not collapse the run into 0/255');
  // A wallet that fails is retried, and because the Reader rotates endpoints on
  // a transport failure a retry is usually a different server.
  let flaky = 2;
  const peer8 = fakePeer({ transactions: quiet(), balances: BAL });
  const innerRequest = peer8.reader.request.bind(peer8.reader);
  peer8.reader.request = async function (command) {
    if (command.account === 'rBob' && flaky-- > 0) throw new Error('XRPL_CONNECTION_CLOSED');
    return innerRequest(command);
  };
  const gh8 = fakeGithub(seeded(ANCHOR - 1000));
  const out8 = await D.acquire({ report_id: 'SW-20260911-HHHHH' },
    { env: ENV, gh: gh8.gh, reader: peer8.reader, attempts: 3 });
  check('a wallet that failed twice is retried and still proves',
    out8.complete_wallets === 3 && out8.committed === true, out8.reason);
  const retried = out8.wallets.find(w => w.address === 'rBob');
  check('and the attempts it took are recorded, not hidden', retried.attempts === 3, retried);
  // A malformed response will not become valid by being asked again.
  const peer9 = fakePeer({ transactions: quiet(), balances: BAL });
  const inner9 = peer9.reader.request.bind(peer9.reader);
  let asked9 = 0;
  peer9.reader.request = async function (command) {
    if (command.account === 'rBob') { asked9++; throw new Error('ACCOUNT_TX_RESPONSE_MALFORMED'); }
    return inner9(command);
  };
  const gh9 = fakeGithub(seeded(ANCHOR - 1000));
  const out9 = await D.acquire({ report_id: 'SW-20260911-IIIII' },
    { env: ENV, gh: gh9.gh, reader: peer9.reader, attempts: 3 });
  check('a permanent refusal is not retried three times', asked9 === 1, asked9);
  check('and the run does not commit', out9.committed === false && out9.reason === 'RUN_INCOMPLETE');

  console.log('\n9. what may be rendered, separately from what may be claimed');
  // 249 of 255 proving is not "nothing happened". Returning no rows would hand
  // the operator 0/255, which reads as silence rather than as an unfinished run.
  const f9 = out9.freshness || {};
  check('the rows from the wallets that DID prove come back anyway',
    Array.isArray(out9.rows) && Array.isArray(out9.wallets) && out9.wallets.length === 3,
    { rows: Array.isArray(out9.rows), wallets: out9.wallets && out9.wallets.length });
  check('the freshness block says how many proved and how many did not',
    f9.wallets_proven === 2 && f9.wallets_unavailable === 1,
    { proven: f9.wallets_proven, unavailable: f9.wallets_unavailable });
  // Grouped by cause, but nothing is summarised away: every address is still
  // named. A hundred wallets sharing one reason is one fact, not a hundred.
  check('it names the wallet that could not be reached, and why',
    Array.isArray(f9.unavailable) && f9.unavailable.length === 1 &&
    f9.unavailable[0].addresses.join(',') === 'rBob' &&
    /MALFORMED/.test(f9.unavailable[0].error), f9.unavailable);
  check('and states plainly that the checkpoint does not advance',
    f9.checkpoint_advances === false, f9.checkpoint_advances);
  check('per-wallet proof is reported so the report can label each one',
    Array.isArray(out9.wallets) &&
    out9.wallets.filter(w => w.status === 'COMPLETE').every(w => w.proven_through === ANCHOR));
  const contradictedRun = await D.acquire({ report_id: 'SW-20260911-JJJJJ' },
    { env: ENV, gh: fakeGithub(seeded(ANCHOR - 1000)).gh,
      reader: fakePeer({ transactions: quiet(), balances: { ...BAL, rCarol: '18000000000000' } }).reader });
  check('a contradicted run also returns its rows and names the contradiction',
    Array.isArray(contradictedRun.rows) &&
    contradictedRun.freshness.contradicted.length === 1 &&
    contradictedRun.freshness.contradicted[0].address === 'rCarol', contradictedRun.freshness.contradicted);
  check('and the contradiction is framed as an integrity mismatch, not a diagnosis',
    /UNEXPLAINED/.test(contradictedRun.freshness.contradicted[0].reason) &&
    !/MISSING/.test(contradictedRun.freshness.contradicted[0].reason),
    contradictedRun.freshness.contradicted[0].reason);
  check('a committed run reports its rows too, so one path renders both',
    Array.isArray(out8.rows) && out8.freshness.checkpoint_advances === true);

  console.log('\n10. the window uses evidence we already own');
  // A second run the same day must not re-fetch the morning from XRPL: those
  // transactions are already committed.
  const DAY = '2026-09-11';
  const storedEvent = { hash: 'S'.repeat(64), ledger_index: ANCHOR - 900,
    close_time: DAY + 'T02:00:00.000Z', tx_type: 'Payment', validated: true, evidence: {} };
  const shard = zlib.gzipSync(Buffer.from(JSON.stringify(storedEvent) + '\n', 'utf8'), { level: 9 });
  const ghWindow = fakeGithub(seeded(ANCHOR - 1000));
  ghWindow.files().set('evidence/2026/09/11/events.ndjson.gz', shard);
  const freshRow = { hash: 'F'.repeat(64), ledger_index: ANCHOR - 100,
    close_time_iso: DAY + 'T05:00:00.000Z', tx_type: 'Payment', validated: true, evidence: {} };

  const win = await D.readReportWindow({
    window_start_ms: Date.parse(DAY + 'T00:00:00.000Z'),
    window_end_ms: Date.parse(DAY + 'T06:00:00.000Z'),
    rows: [freshRow]
  }, { env: ENV, gh: ghWindow.gh });
  check('the committed shard for the day is read back',
    win.from_stored === 1 && win.shards_read.includes('evidence/2026/09/11/events.ndjson.gz'),
    { from_stored: win.from_stored, shards: win.shards_read });
  check('and combined with the rows this run walked',
    win.from_this_run === 1 && win.in_window === 2, { run: win.from_this_run, total: win.in_window });
  check('the window is ordered, so the report reads it in ledger-time order',
    win.events[0].close_time < win.events[1].close_time);
  check('only the days the window touches are fetched, not the archive',
    win.days.length === 1 && win.days[0] === DAY, win.days);

  // The same transaction in both places must be counted once.
  const dupWin = await D.readReportWindow({
    window_start_ms: Date.parse(DAY + 'T00:00:00.000Z'),
    window_end_ms: Date.parse(DAY + 'T06:00:00.000Z'),
    rows: [{ ...storedEvent, close_time_iso: storedEvent.close_time }]
  }, { env: ENV, gh: ghWindow.gh });
  check('a transaction present in both storage and this run is counted once',
    dupWin.in_window === 1, dupWin.in_window);

  // Anything outside the window is not the window.
  const narrow = await D.readReportWindow({
    window_start_ms: Date.parse(DAY + 'T03:00:00.000Z'),
    window_end_ms: Date.parse(DAY + 'T06:00:00.000Z'),
    rows: [freshRow]
  }, { env: ENV, gh: ghWindow.gh });
  check('a stored row outside the window is excluded from it',
    narrow.in_window === 1 && narrow.events[0].hash === freshRow.hash, narrow.in_window);

  const empty = await D.readReportWindow({
    window_start_ms: Date.parse('2026-09-07T00:00:00.000Z'),
    window_end_ms: Date.parse('2026-09-07T06:00:00.000Z'), rows: []
  }, { env: ENV, gh: ghWindow.gh });
  check('a day with no shard is reported, not thrown',
    empty.in_window === 0 && empty.days_without_shards.includes('2026-09-07'), empty.days_without_shards);

  const SRC2 = fs.readFileSync(path.join(ROOT, 'src/db/delta-acquisition.js'), 'utf8');
  check('acquisition itself never loads a stored shard',
    !/Store\.readDays/.test(SRC2.split('async function acquire')[1].split('// ── The report window')[0]));
  check('freshly walked rows win a tie against a stored copy',
    /for \(const event of stored\.events\) byHash\.set[\s\S]{0,140}?for \(const event of fresh\) byHash\.set/.test(SRC2));

  console.log('\n11. the two lanes run concurrently');
  check('the checkpoint read and the anchor pin do not wait on each other',
    /Promise\.all\(\[\s*Store\.readState/.test(SRC2));
  check('and wallet walks run with bounded concurrency',
    /Array\.from\(\{ length: concurrency \}, worker\)/.test(SRC2));

  console.log('\n12. the roster grew — what a new wallet costs, and what it may claim');
  /* The roster went from 255 to 408. The state knows the wallets it has proven;
     the roster names the wallets we watch. The gap between them IS the set being
     admitted — and a wallet entering that set buys one bounded window of history,
     not the whole ledger, and says in the file where its evidence begins. */
  const ROSTER = WALLETS.concat(['rDave']);
  const peerR9 = fakePeer({ transactions: { ...quiet(),
      rDave: [{ ledger: ANCHOR - 20, amount: '1000000000', before: '9000000000', after: '10000000000' }] },
    balances: { ...BAL, rDave: '10000000000' } });
  const ghR9 = fakeGithub(seeded(ANCHOR - 1000));
  const outR9 = await D.acquire({ report_id: 'SW-20260911-JJJJJ', scan_id: 'idx-9', roster: ROSTER },
    { env: ENV, gh: ghR9.gh, reader: peerR9.reader, concurrency: 2 });
  check('the run completes with the new wallet included',
    outR9.committed === true && outR9.target_wallets === 4 && outR9.complete_wallets === 4, outR9.reason);
  check('and says plainly which wallets it admitted',
    outR9.wallets_admitted === 1 && JSON.stringify(outR9.admitted_wallets) === JSON.stringify(['rDave']));
  const walkR9 = peerR9.asked.filter(c => c.command === 'account_tx');
  const daveWalk = walkR9.filter(c => c.account === 'rDave');
  check('the new wallet was actually walked', daveWalk.length === 1);
  check('over a BOUNDED window, not to genesis',
    daveWalk[0].ledger_index_min === ANCHOR - 30000 + 1 && daveWalk[0].ledger_index_max === ANCHOR,
    daveWalk[0] && daveWalk[0].ledger_index_min);
  check('and the run reports the horizon it bought, so the report cannot claim past it',
    outR9.admitted_history_from_ledger === ANCHOR - 30000 + 1);
  check('the wallets already proven still walk only their own delta — an addition costs them nothing',
    walkR9.filter(c => c.account !== 'rDave').every(c => c.ledger_index_min === ANCHOR - 999));
  const stateR9 = JSON.parse(ghR9.files().get(Store.STATE_PATH).toString('utf8'));
  const daveR9 = stateR9.wallets.find(w => w.address === 'rDave');
  check('the committed state carries the new wallet with its horizon recorded',
    daveR9 && daveR9.admitted_at_ledger === ANCHOR && daveR9.history_from_ledger === ANCHOR - 30000 + 1, daveR9);
  check('and it is proven only to this anchor — no inherited checkpoint',
    daveR9.last_proven_ledger === ANCHOR);
  check('the existing wallets kept their own admission fields untouched (null: seeded before this store)',
    stateR9.wallets.filter(w => w.address !== 'rDave')
      .every(w => w.admitted_at_ledger === null && w.history_from_ledger === null));
  check('the run manifest names the admission too',
    JSON.parse(ghR9.files().get('evidence/runs/SW-20260911-JJJJJ.json').toString('utf8'))
      .admitted_wallets.join(',') === 'rDave');

  console.log('\n13. the second morning: an admitted wallet is an ordinary one');
  const peerR10 = fakePeer({ transactions: { ...quiet(), rDave: [] },
    balances: { ...BAL, rDave: '10000000000' } });
  peerR10.reader.ledger = async () => ({ ledger: ANCHOR + 1000, close_ms: Date.UTC(2026, 8, 12, 6, 0, 0) });
  const ghR10 = fakeGithub(Object.fromEntries(
    [...ghR9.files()].map(([k, v]) => [k, v.toString('utf8')])));
  const outR10 = await D.acquire({ report_id: 'SW-20260912-AAAAA', scan_id: 'idx-10', roster: ROSTER },
    { env: ENV, gh: ghR10.gh, reader: peerR10.reader, concurrency: 2 });
  check('it commits, and admits nobody — the wallet is already in',
    outR10.committed === true && outR10.wallets_admitted === 0, outR10.reason);
  const daveWalkR10 = peerR10.asked.filter(c => c.command === 'account_tx' && c.account === 'rDave');
  check('the new wallet now walks its own delta, not another cold window',
    daveWalkR10[0].ledger_index_min === ANCHOR + 1, daveWalkR10[0]);
  const daveR10 = JSON.parse(ghR10.files().get(Store.STATE_PATH).toString('utf8'))
    .wallets.find(w => w.address === 'rDave');
  check('and its horizon is carried unchanged — one cold window, bought once',
    daveR10.history_from_ledger === ANCHOR - 30000 + 1 && daveR10.admitted_at_ledger === ANCHOR);

  console.log('\n14. the roster is not a lever the caller gets to pull');
  const peerR11 = fakePeer({ transactions: quiet(), balances: BAL });
  const ghR11 = fakeGithub(seeded(ANCHOR - 1000));
  const outR11 = await D.acquire({ report_id: 'SW-20260911-KKKKK', scan_id: 'idx-11',
    roster: ['rAlice', 'rBob'] }, { env: ENV, gh: ghR11.gh, reader: peerR11.reader, concurrency: 2 });
  check('a wallet missing from the roster is NOT dropped — retiring one is a decision, not an inference',
    outR11.committed === true && outR11.target_wallets === 3 &&
    peerR11.asked.some(c => c.command === 'account_tx' && c.account === 'rCarol'), outR11.reason);
  check('but the discrepancy is reported rather than swallowed',
    JSON.stringify(outR11.watched_not_in_roster) === JSON.stringify(['rCarol']));
  check('a state committed without a roster admits nobody at all',
    (() => { const s = JSON.parse(ghR11.files().get(Store.STATE_PATH).toString('utf8'));
      return s.wallet_count === 3 && s.sealed_run.admitted_wallets.length === 0; })());
  check('and the API takes the roster from committed source, never from the request body',
    /roster: roster\.select\(\)\.accounts/.test(fs.readFileSync(path.join(ROOT, 'api/delta.js'), 'utf8')) &&
    !/input\.roster/.test(fs.readFileSync(path.join(ROOT, 'api/delta.js'), 'utf8')));

  console.log('\n15. a roster that grew by more than one run can carry');
  /* 153 wallets joined at once. One run cannot walk 153 cold windows inside a
     serverless ceiling — and a run that tries does not come back slow, it comes
     back dead, commits nothing, and leaves the roster where it was. So the
     admissions queue and a few join each morning, while every run stays whole.
     Nothing is skipped and no window narrows: a wallet joins on Tuesday. */
  const MANY = WALLETS.concat(['rDave', 'rErin', 'rFrank', 'rGrace']);
  const txsMany = { ...quiet(), rDave: [], rErin: [], rFrank: [], rGrace: [] };
  const balMany = { ...BAL, rDave: '1000', rErin: '2000', rFrank: '3000', rGrace: '4000' };
  const peerB = fakePeer({ transactions: txsMany, balances: balMany });
  const ghB = fakeGithub(seeded(ANCHOR - 1000));
  const outB = await D.acquire({ report_id: 'SW-20260911-MMMMM', scan_id: 'idx-b',
    roster: MANY, max_admissions: 2 },
    { env: ENV, gh: ghB.gh, reader: peerB.reader, concurrency: 2 });
  check('the run commits with only as many admissions as it can afford',
    outB.committed === true && outB.wallets_admitted === 2 && outB.target_wallets === 5, outB.reason);
  check('and names the ones still waiting rather than rounding them away',
    outB.wallets_awaiting_admission === 2 && outB.roster_wallets === 7);
  check('the batch is taken in address order, so the same run twice picks the same two',
    JSON.stringify(outB.admitted_wallets) === JSON.stringify(['rDave', 'rErin']));
  check('the deferred wallets were not walked — a deferral costs no XRPL request',
    !peerB.asked.some(c => c.account === 'rFrank' || c.account === 'rGrace'));
  check('and they are not in the committed state either',
    (() => { const st = JSON.parse(ghB.files().get(Store.STATE_PATH).toString('utf8'));
      return st.wallet_count === 5 && !st.wallets.some(w => w.address === 'rGrace'); })());

  const peerC = fakePeer({ transactions: txsMany, balances: balMany });
  peerC.reader.ledger = async () => ({ ledger: ANCHOR + 500, close_ms: Date.UTC(2026, 8, 12, 6, 0, 0) });
  const ghC = fakeGithub(Object.fromEntries([...ghB.files()].map(([k, v]) => [k, v.toString('utf8')])));
  const outC = await D.acquire({ report_id: 'SW-20260912-MMMMM', scan_id: 'idx-c',
    roster: MANY, max_admissions: 2 },
    { env: ENV, gh: ghC.gh, reader: peerC.reader, concurrency: 2 });
  check('the next morning takes the next two, and the queue empties',
    outC.committed === true && outC.wallets_admitted === 2 &&
    JSON.stringify(outC.admitted_wallets) === JSON.stringify(['rFrank', 'rGrace']) &&
    outC.wallets_awaiting_admission === 0, outC.reason);
  check('the wallets admitted yesterday walk their own delta today, not another cold window',
    peerC.asked.filter(c => c.command === 'account_tx' && c.account === 'rDave')[0]
      .ledger_index_min === ANCHOR + 1);
  check('and the roster is whole: 7 wallets, all proven to the same anchor',
    (() => { const st = JSON.parse(ghC.files().get(Store.STATE_PATH).toString('utf8'));
      return st.wallet_count === 7 &&
        st.wallets.every(w => w.last_proven_ledger === ANCHOR + 500); })());

  console.log('\n16. the silent gap before the first wallet is named');
  /* 85 seconds into a run with no wallet line, the operator cannot tell a slow
     first wallet from an XRPL connect that never happened. Each lane therefore
     reports the moment it lands. */
  const seen = [];
  const peerP = fakePeer({ transactions: quiet(), balances: BAL });
  const ghP = fakeGithub(seeded(ANCHOR - 1000));
  await D.acquire({ report_id: 'SW-20260911-PPPPP', scan_id: 'idx-p', roster: WALLETS.concat(['rDave']) },
    { env: ENV, gh: ghP.gh, reader: peerP.reader, concurrency: 2,
      onPhase: (name, detail) => seen.push({ name, ...detail }) });
  check('the checkpoint read reports itself', seen.some(p => p.name === 'state' && p.wallets === 3));
  check('the anchor pin reports itself, with the ledger it pinned',
    seen.some(p => p.name === 'anchor' && p.ledger === ANCHOR));
  check('and the plan says what is about to be walked before any of it is',
    seen.some(p => p.name === 'plan' && p.wallets === 4 && p.proven === 3 && p.admitting === 1));
  check('every phase lands before the first wallet line',
    (() => { const idx = seen.findIndex(p => p.name === 'plan');
      return idx === seen.length - 1; })(), seen.map(p => p.name));
  check('a run with no phase listener behaves identically',
    (await D.acquire({ report_id: 'SW-20260911-QQQQQ', scan_id: 'idx-q' },
      { env: ENV, gh: fakeGithub(seeded(ANCHOR - 1000)).gh,
        reader: fakePeer({ transactions: quiet(), balances: BAL }).reader })).committed === true);

  console.log('\n17. an addition on a ledger that has not moved waits rather than half-lands');
  const peerR12 = fakePeer({ transactions: quiet(), balances: BAL });
  const ghR12 = fakeGithub(seeded(ANCHOR));
  const outR12 = await D.acquire({ report_id: 'SW-20260911-LLLLL', scan_id: 'idx-12', roster: ROSTER },
    { env: ENV, gh: ghR12.gh, reader: peerR12.reader, concurrency: 2 });
  check('nothing is committed and the new wallet is named as pending',
    outR12.committed === false && outR12.reason === 'ANCHOR_NOT_ADVANCED' &&
    outR12.wallets_pending_admission === 1, outR12);
  check('and not one XRPL walk was spent discovering that',
    peerR12.asked.filter(c => c.command === 'account_tx').length === 0);

  console.log('\n18. a run that dies is not a run that starts over');
  /* The checkpoint stays all-or-nothing. The WORK does not have to. A run that
     dies at wallet 240 used to discard 240 wallets of finished walking and pay
     XRPL a second time for evidence it already had and had already validated.
     That was not a safety property; it was waste wearing one's clothes. */
  const crashTx = { rAlice: [], rCarol: [],
    rBob: [{ ledger: ANCHOR - 500, amount: '5000000000000', before: '20000000000000', after: '25000000000000' },
           { ledger: ANCHOR - 400, amount: '5000000000000', before: '25000000000000', after: '20000000000000' }] };
  const peerX1 = fakePeer({ transactions: crashTx, balances: BAL, failOn: 'rCarol' });
  const ghX = fakeGithub(seeded(ANCHOR - 1000));
  const outX1 = await D.acquire({ report_id: 'SW-20260911-RRRRR', scan_id: 'idx-r' },
    { env: ENV, gh: ghX.gh, reader: peerX1.reader, concurrency: 1 });
  check('the first attempt does not commit — one wallet never answered',
    outX1.committed === false && outX1.reason === 'RUN_INCOMPLETE', outX1.reason);
  check('and it wrote down the two wallets that did finish',
    outX1.journal_wallets === 2, outX1.journal_wallets);
  const journalled = JSON.parse(ghX.files().get(Store.JOURNAL_PATH).toString('utf8'));
  check('the journal pins the anchor the attempt used',
    journalled.anchor_ledger === ANCHOR);
  check('and the checkpoint it began from, so a moved checkpoint can be detected later',
    journalled.from_state_sha256 ===
      JSON.parse(ghX.files().get(Store.STATE_PATH).toString('utf8')).state_sha256);
  check('every journalled wallet carries the range it proved, not a bare done flag',
    journalled.wallets.every(w => w.proven_through === ANCHOR && w.proven_from === ANCHOR - 999));
  check('and the state entry it earned, so a resume commits what this run would have',
    journalled.wallets.every(w => w.entry && w.entry.address === w.address &&
      w.entry.last_proven_ledger === ANCHOR));

  // The second attempt: same store, a peer that now answers, and a fresh
  // report_id — the operator pressed Run again, they did not replay anything.
  const peerX2 = fakePeer({ transactions: crashTx, balances: BAL });
  const outX2 = await D.acquire({ report_id: 'SW-20260911-SSSSS', scan_id: 'idx-s' },
    { env: ENV, gh: ghX.gh, reader: peerX2.reader, concurrency: 1 });
  check('the second attempt commits', outX2.committed === true, outX2.reason);
  check('it adopted the journal rather than starting over',
    outX2.resumed && outX2.resumed.adopted === true &&
    outX2.wallets_recovered_from_journal === 2, outX2.resumed);
  check('and walked ONLY the wallet that was missing',
    peerX2.asked.filter(c => c.command === 'account_tx').length === 1 &&
    peerX2.asked.filter(c => c.command === 'account_tx')[0].account === 'rCarol',
    peerX2.asked.filter(c => c.command === 'account_tx').map(c => c.account));
  check('it finished against the SAME anchor, not a fresher one',
    outX2.anchor_ledger === ANCHOR);
  check('the recovered rows are in the commit — rBob\'s two transactions survived the crash',
    outX2.transactions === 2, outX2.transactions);
  check('all three wallets are proved, recovered ones included',
    outX2.complete_wallets === 3 && outX2.target_wallets === 3);
  const stateX = JSON.parse(ghX.files().get(Store.STATE_PATH).toString('utf8'));
  check('and the checkpoint advanced for every one of them',
    stateX.state_version === 2 && stateX.wallets.every(w => w.last_proven_ledger === ANCHOR));
  check('the journal is gone, removed by the commit that made it redundant',
    !ghX.files().get(Store.JOURNAL_PATH) &&
    journalled.row_shards.every(x => !ghX.files().get(x.path)));
  // Awaited, not handed to check() as a promise — a promise is truthy and the
  // assertion would have passed whatever it resolved to.
  const cleanGh = fakeGithub(seeded(ANCHOR - 1000));
  const cleanRun = await D.acquire({ report_id: 'SW-20260911-TTTTT', scan_id: 'idx-t' },
    { env: ENV, gh: cleanGh.gh, reader: fakePeer({ transactions: crashTx, balances: BAL }).reader });
  const cleanState = JSON.parse(cleanGh.files().get(Store.STATE_PATH).toString('utf8'));
  check('an uninterrupted run of the same morning commits',
    cleanRun.committed === true, cleanRun.reason);
  check('and the resumed run committed byte-identical evidence — same shards, same hashes',
    JSON.stringify(cleanState.evidence_shards) === JSON.stringify(stateX.evidence_shards),
    { resumed: stateX.evidence_shards, clean: cleanState.evidence_shards });

  console.log('\n19. a resume finishes the interrupted instant, not a fresh one');
  /* The whole reason the journal pins an anchor. If a resumed run pinned its
     own, the wallets walked before the disconnect would be proven to a
     different ledger than the ones walked after it, and the committed state
     would describe an instant that never existed. */
  const ghY = fakeGithub(seeded(ANCHOR - 1000));
  await D.acquire({ report_id: 'SW-20260911-AB123' },
    { env: ENV, gh: ghY.gh, reader: fakePeer({ transactions: crashTx, balances: BAL, failOn: 'rCarol' }).reader });
  const peerY = fakePeer({ transactions: crashTx, balances: BAL });
  // The ledger has moved on since the crash, as it always will have.
  peerY.reader.ledger = async () => ({ ledger: ANCHOR + 7000, close_ms: Date.UTC(2026, 8, 11, 12, 0, 0) });
  const outY = await D.acquire({ report_id: 'SW-20260911-AB124' },
    { env: ENV, gh: ghY.gh, reader: peerY.reader });
  check('it resumed', outY.committed === true && outY.resumed.adopted === true, outY.reason);
  check('and finished against the journal\'s anchor, not the fresher validated ledger',
    outY.anchor_ledger === ANCHOR, { used: outY.anchor_ledger, available: ANCHOR + 7000 });
  check('the wallet it still had to walk was bounded by that same older anchor',
    peerY.asked.filter(c => c.command === 'account_tx')
      .every(c => c.ledger_index_max === ANCHOR));
  check('so every wallet in the committed state names ONE instant',
    (() => { const st = JSON.parse(ghY.files().get(Store.STATE_PATH).toString('utf8'));
      return st.anchor_ledger === ANCHOR &&
        st.wallets.every(w => w.last_proven_ledger === ANCHOR); })());

  console.log('\n20. journalled rows are checked against the hash the journal recorded');
  const ghZ = fakeGithub(seeded(ANCHOR - 1000));
  await D.acquire({ report_id: 'SW-20260911-AC123' },
    { env: ENV, gh: ghZ.gh, reader: fakePeer({ transactions: crashTx, balances: BAL, failOn: 'rCarol' }).reader });
  const rowPath = JSON.parse(ghZ.files().get(Store.JOURNAL_PATH).toString('utf8')).row_shards[0].path;
  // Swap the rows for different ones. The journal still says they hash to what
  // was written, and that disagreement is the whole point of recording it.
  ghZ.files().set(rowPath, zlib.gzipSync(Buffer.from('{"hash":"FORGED"}\n', 'utf8')));
  const peerZ = fakePeer({ transactions: crashTx, balances: BAL });
  const outZ = await D.acquire({ report_id: 'SW-20260911-AC124' },
    { env: ENV, gh: ghZ.gh, reader: peerZ.reader });
  // The wallets ARE proven — the manifest says so and this run walked the rest
  // — but their transactions cannot be produced. Committing the checkpoint
  // anyway would advance a coverage floor past evidence that is not in the
  // repository, which is the one thing that must never happen. So the run
  // refuses, even though refusing costs another morning.
  check('rows that are not the bytes the journal recorded are refused, not used',
    outZ.committed === false && outZ.reason === 'JOURNAL_ROWS_UNREADABLE' &&
    /JOURNAL_SHARD_HASH_MISMATCH/.test(outZ.journal_rows_unreadable), outZ.reason);
  check('the forged rows never reached the checkpoint',
    JSON.parse(ghZ.files().get(Store.STATE_PATH).toString('utf8')).state_version === 1 &&
    !JSON.stringify(JSON.parse(ghZ.files().get(Store.STATE_PATH).toString('utf8'))).includes('FORGED'));
  check('and the bad journal is discarded rather than refused again every run',
    !ghZ.files().get(Store.JOURNAL_PATH));
  // Which means the NEXT run simply does the work itself.
  const peerZ2 = fakePeer({ transactions: crashTx, balances: BAL });
  const outZ2 = await D.acquire({ report_id: 'SW-20260911-AC125' },
    { env: ENV, gh: ghZ.gh, reader: peerZ2.reader });
  check('the run after it walks every wallet and commits',
    outZ2.committed === true && outZ2.complete_wallets === 3 &&
    outZ2.wallets_recovered_from_journal === 0 &&
    peerZ2.asked.filter(c => c.command === 'account_tx').length === 3, outZ2.reason);

  console.log('\n21. a journal is refused rather than trusted');
  /* Every refusal here costs one morning of re-walking. Every refusal NOT here
     costs correctness, which is not a trade this project makes. */
  const staleFor = async (mutate) => {
    const gh = fakeGithub(seeded(ANCHOR - 1000));
    await D.acquire({ report_id: 'SW-20260911-UUUUU' },
      { env: ENV, gh: gh.gh, reader: fakePeer({ transactions: crashTx, balances: BAL, failOn: 'rCarol' }).reader });
    const files = gh.files();
    const j = JSON.parse(files.get(Store.JOURNAL_PATH).toString('utf8'));
    files.set(Store.JOURNAL_PATH, Buffer.from(JSON.stringify(mutate(j), null, 2), 'utf8'));
    const out = await D.acquire({ report_id: 'SW-20260911-VVVVV' },
      { env: ENV, gh: gh.gh, reader: fakePeer({ transactions: crashTx, balances: BAL }).reader });
    return { out, gh };
  };
  const edited = await staleFor(j => ({ ...j, wallets: j.wallets.map(w =>
    ({ ...w, proven_through: ANCHOR + 5000 })) }));
  check('a journal edited by hand fails its own digest and is refused',
    edited.out.resumed && edited.out.resumed.adopted === false &&
    /DIGEST_MISMATCH/.test(edited.out.resumed.reason), edited.out.resumed);
  check('and the refused journal is discarded, not left to be refused every morning',
    !edited.gh.files().get(Store.JOURNAL_PATH));
  check('the run still completes — a bad journal costs a re-walk, never the run',
    edited.out.committed === true && edited.out.complete_wallets === 3, edited.out.reason);

  const unreadable = await (async () => {
    const gh = fakeGithub(seeded(ANCHOR - 1000));
    await D.acquire({ report_id: 'SW-20260911-WWWWW' },
      { env: ENV, gh: gh.gh, reader: fakePeer({ transactions: crashTx, balances: BAL, failOn: 'rCarol' }).reader });
    gh.files().set(Store.JOURNAL_PATH, Buffer.from('{ not json', 'utf8'));
    return D.acquire({ report_id: 'SW-20260911-XXXXX' },
      { env: ENV, gh: gh.gh, reader: fakePeer({ transactions: crashTx, balances: BAL }).reader });
  })();
  check('an unreadable journal is discarded rather than crashing the run',
    unreadable.committed === true && unreadable.resumed.reason === 'JOURNAL_UNREADABLE',
    unreadable.resumed);

  // The dangerous one: a journal that outlived a commit. Its wallets were
  // walked from checkpoints that have since moved, so adopting it would
  // re-claim a window already claimed.
  const moved = await (async () => {
    const gh = fakeGithub(seeded(ANCHOR - 1000));
    await D.acquire({ report_id: 'SW-20260911-YYYYY' },
      { env: ENV, gh: gh.gh, reader: fakePeer({ transactions: crashTx, balances: BAL, failOn: 'rCarol' }).reader });
    const j = gh.files().get(Store.JOURNAL_PATH);
    const peer = fakePeer({ transactions: crashTx, balances: BAL });
    await D.acquire({ report_id: 'SW-20260911-ZZZZZ' }, { env: ENV, gh: gh.gh, reader: peer.reader });
    // The commit removed it; put it back, exactly as a failed cleanup would.
    gh.files().set(Store.JOURNAL_PATH, j);
    const later = fakePeer({ transactions: crashTx, balances: BAL });
    later.reader.ledger = async () => ({ ledger: ANCHOR + 1000, close_ms: Date.UTC(2026, 8, 12, 6, 0, 0) });
    const out = await D.acquire({ report_id: 'SW-20260912-AAAAA' },
      { env: ENV, gh: gh.gh, reader: later.reader });
    return { out, peer: later };
  })();
  check('a journal that outlived its commit is refused: the checkpoint moved under it',
    moved.out.resumed && moved.out.resumed.adopted === false &&
    /CHECKPOINT_MOVED_SINCE/.test(moved.out.resumed.reason), moved.out.resumed);
  check('so the next run walks every wallet itself rather than inheriting stale proof',
    moved.peer.asked.filter(c => c.command === 'account_tx').length === 3);
  check('and it pinned its OWN anchor, not the dead journal\'s',
    moved.out.anchor_ledger === ANCHOR + 1000);

  console.log('\n22. a wallet that cannot finish is not started');
  /* Measured on the live ledger: most watched wallets move nothing in four days
     and answer in one page, but a busy exchange hot wallet needed 31 pages at
     roughly seven seconds each — 223 seconds against a 240-second budget. A
     wallet begun with seconds left is cut off mid-walk, and a partial walk
     proves nothing and cannot be journalled. It is simply thrown away. */
  const peerBud = fakePeer({ transactions: quiet(), balances: BAL });
  const ghBud = fakeGithub(seeded(ANCHOR - 1000));
  // Two wallets' worth of budget, then nothing.
  let walked = 0;
  const innerReq = peerBud.reader.request.bind(peerBud.reader);
  peerBud.reader.deadline = Date.now() + 3600000;
  peerBud.reader.request = async function (c, e) {
    const out = await innerReq(c, e);
    if (c.command === 'account_tx' && ++walked === 2) peerBud.reader.deadline = Date.now() + 1000;
    return out;
  };
  const outBud = await D.acquire({ report_id: 'SW-20260911-AD123' },
    { env: ENV, gh: ghBud.gh, reader: peerBud.reader, concurrency: 1 });
  check('the run stops starting wallets rather than beginning one it cannot finish',
    outBud.not_attempted_wallets >= 1, outBud.not_attempted_wallets);
  check('a wallet never reached is not reported as one that failed to answer',
    outBud.wallets.some(w => w.status === 'NOT_ATTEMPTED') &&
    outBud.failures.every(f => f.error === 'RUN_BUDGET_EXHAUSTED' ||
      !/RUN_BUDGET/.test(f.error)));
  check('it commits nothing — a roster not finished is not a run',
    outBud.committed === false && outBud.reason === 'RUN_INCOMPLETE');
  check('but the wallets it DID walk were written down, so the next run starts there',
    outBud.journal_wallets >= 1 && !!ghBud.files().get(Store.JOURNAL_PATH), outBud.journal_wallets);
  check('and no XRPL request was spent on the wallets it skipped',
    peerBud.asked.filter(c => c.command === 'account_tx').length ===
      outBud.wallets.filter(w => w.status === 'COMPLETE' || w.status === 'FAILED').length,
    { asked: peerBud.asked.filter(c => c.command === 'account_tx').length });

  console.log('\n23. a long wallet reports its pages rather than going quiet');
  const many = { rAlice: [], rBob: [], rCarol: [] };
  for (let i = 0; i < 5; i++) many.rBob.push({ ledger: ANCHOR - 900 + i, amount: '1000000',
    before: '20000000000000', after: '20000000000000', hash: hashFor('rBobPage', i) });
  const pages = [];
  const peerPg = fakePeer({ transactions: many, balances: BAL });
  await D.acquire({ report_id: 'SW-20260911-AE123' },
    { env: ENV, gh: fakeGithub(seeded(ANCHOR - 1000)).gh, reader: peerPg.reader,
      concurrency: 1, onPage: p => pages.push(p) });
  check('every wallet reports at least one page', pages.length >= 3, pages.length);
  check('each page says which wallet, how far in, and whether more is coming',
    pages.every(p => p.address && p.pages >= 1 && typeof p.more === 'boolean'), pages[0]);
  check('the last page of a wallet says so', pages.some(p => p.more === false));
  check('a run with no page listener behaves identically',
    (await D.acquire({ report_id: 'SW-20260911-AE124' },
      { env: ENV, gh: fakeGithub(seeded(ANCHOR - 1000)).gh,
        reader: fakePeer({ transactions: many, balances: BAL }).reader })).committed === true);

  console.log('\n24. the roster is spread across servers, not piled onto one');
  /* A live run's log named wss://xrplcluster.com on every line, hit "units
     quota (2000 per 10s) exhausted", and served 75 requests in 238 seconds
     while three configured endpoints sat idle. The endpoints were never the
     problem; using them was. */
  const peerSp = fakePeer({ transactions: quiet(), balances: BAL });
  await D.acquire({ report_id: 'SW-20260911-AF123' },
    { env: ENV, gh: fakeGithub(seeded(ANCHOR - 1000)).gh, reader: peerSp.reader, concurrency: 3 });
  const byEndpoint = {};
  for (const c of peerSp.asked) byEndpoint[c._endpoint] = (byEndpoint[c._endpoint] || 0) + 1;
  check('three wallets used three different servers',
    Object.keys(byEndpoint).filter(k => k !== 'null').length === 3, byEndpoint);
  check('and every request a wallet made went to that wallet\'s own server',
    ['rAlice', 'rBob', 'rCarol'].every(a => {
      const mine = peerSp.asked.filter(c => c.account === a);
      return new Set(mine.map(c => c._endpoint)).size === 1;
    }), peerSp.asked.map(c => c.account + '@' + c._endpoint));
  check('including its balance read, so a wallet is answered by one server throughout',
    peerSp.asked.filter(c => c.command === 'account_info').every(c => c._endpoint !== null));
  // A lane held forever makes its server look permanently busy and quietly
  // undoes the spreading. Every walk must hand its lane back, however it ended.
  check('every lane is handed back when its walk ends',
    peerSp.reader.lanes.every(l => !l.assigned), peerSp.reader.lanes.map(l => l.assigned));
  const peerRel = fakePeer({ transactions: quiet(), balances: BAL, failOn: 'rBob' });
  await D.acquire({ report_id: 'SW-20260911-AH123' },
    { env: ENV, gh: fakeGithub(seeded(ANCHOR - 1000)).gh, reader: peerRel.reader, concurrency: 2 });
  check('including the walk of a wallet that failed',
    peerRel.reader.lanes.every(l => !l.assigned), peerRel.reader.lanes.map(l => l.assigned));

  console.log('\n25. running out of budget is not a wallet failing');
  /* The live run reported 240 healthy wallets as FAILED in a few seconds,
     each after three attempts, because the admission clock threw once there
     was no time left and the retry loop treated that as the wallet's fault. */
  const peerPend = fakePeer({ transactions: quiet(), balances: BAL, pendingFrom: 2 });
  const outPend = await D.acquire({ report_id: 'SW-20260911-AG123' },
    { env: ENV, gh: fakeGithub(seeded(ANCHOR - 1000)).gh, reader: peerPend.reader, concurrency: 1 });
  check('a wallet cut off by the budget is NOT_ATTEMPTED, not FAILED',
    outPend.not_attempted_wallets >= 1 &&
    outPend.wallets.filter(w => w.status === 'FAILED').length === 0,
    outPend.wallets.map(w => w.status));
  check('and it is not retried three times on the way to that conclusion',
    outPend.wallets.filter(w => w.status === 'NOT_ATTEMPTED').every(w => w.attempts === 0));
  check('the run still reports what it did prove',
    outPend.committed === false && outPend.complete_wallets >= 1, outPend.reason);

  console.log('\n26. a hundred wallets with one cause is one fact, not a hundred');
  /* A real result listed the same 105 addresses three times — once in
     failures, once in freshness.unavailable, once in wallets_detail — and was
     three times the size it needed to be to say the same thing. */
  const peerG = fakePeer({ transactions: quiet(), balances: BAL, pendingFrom: 1 });
  const outG = await D.acquire({ report_id: 'SW-20260911-AJ123' },
    { env: ENV, gh: fakeGithub(seeded(ANCHOR - 1000)).gh, reader: peerG.reader, concurrency: 1 });
  check('wallets sharing a cause are reported under it once',
    outG.failures.length === 1 && outG.failures[0].error === 'RUN_BUDGET_EXHAUSTED',
    outG.failures.map(f => f.error));
  check('with the count, so nobody has to measure an array to learn it',
    outG.failures[0].wallets === outG.not_attempted_wallets, outG.failures[0].wallets);
  check('and EVERY address still named — grouping is not summarising away',
    outG.failures[0].addresses.length === outG.not_attempted_wallets &&
    outG.failures[0].addresses.every(a => typeof a === 'string' && a));
  check('every wallet still has its own record in the detail',
    outG.wallets.filter(w => w.status === 'NOT_ATTEMPTED').length === outG.not_attempted_wallets);
  check('two different causes stay two groups, ordered by how many they hit',
    (() => {
      const mixed = groupOf([{ error: 'A' }, { error: 'B' }, { error: 'B' }]);
      return mixed.length === 2 && mixed[0].error === 'B' && mixed[0].wallets === 2;
    })());

  console.log('\n27. a journal segment bigger than the contents API can carry');
  /* THE BUG THIS EXISTS FOR. GitHub's contents API returns file bytes only up
     to 1 MB; past that it answers with the metadata and an EMPTY body — no
     error, no 404. Decoding that gives an empty buffer, which then fails the
     hash check that was applied to it.

     Live: a resume died with JOURNAL_SHARD_HASH_MISMATCH on segment 7, which
     held several thousand transactions. The hash check was right. The read was
     wrong. */
  const bulky = { rAlice: [], rCarol: [], rBob: [] };
  for (let i = 0; i < 120; i++) {
    bulky.rBob.push({ ledger: ANCHOR - 900 + i, amount: '1000000',
      before: '20000000000000', after: '20000000000000', hash: hashFor('rBulk', i) });
  }
  const ghBig = fakeGithub(seeded(ANCHOR - 1000));
  const outBig1 = await D.acquire({ report_id: 'SW-20260911-AK123' },
    { env: ENV, gh: ghBig.gh, reader: fakePeer({ transactions: bulky, balances: BAL, failOn: 'rCarol' }).reader,
      concurrency: 1 });
  check('the first attempt journals a segment past the contents-API limit',
    outBig1.journal_wallets >= 1 &&
    JSON.parse(ghBig.files().get(Store.JOURNAL_PATH).toString('utf8'))
      .row_shards.some(sh => ghBig.files().get(sh.path).length > CONTENTS_API_LIMIT),
    JSON.parse(ghBig.files().get(Store.JOURNAL_PATH).toString('utf8'))
      .row_shards.map(sh => ghBig.files().get(sh.path).length));
  const peerBig = fakePeer({ transactions: bulky, balances: BAL });
  const outBig2 = await D.acquire({ report_id: 'SW-20260911-AK124' },
    { env: ENV, gh: ghBig.gh, reader: peerBig.reader, concurrency: 1 });
  check('the resume reads it through the blobs API and adopts it',
    outBig2.resumed && outBig2.resumed.adopted === true, outBig2.resumed);
  check('the manifest names how many rows are banked, without reading them yet',
    outBig2.resumed.rows_awaiting_load === 120, outBig2.resumed.rows_awaiting_load);
  check('and it commits, with the recovered transactions in the evidence',
    outBig2.committed === true && outBig2.transactions === 120,
    { committed: outBig2.committed, tx: outBig2.transactions, reason: outBig2.reason });
  check('the wallet whose rows were recovered was not walked a second time',
    !peerBig.asked.some(c => c.command === 'account_tx' && c.account === 'rBob'));

  // The same ceiling applies to committed day shards, which report assembly
  // reads. A busy day is far larger than a journal segment.
  const dayShard = [...ghBig.files().keys()]
    .find(k => /^evidence\/20.*events.*\.gz$/.test(k));
  const dayKey = dayShard && dayShard.split('/').slice(1, 4).join('-');
  check('the committed day shard is itself past the limit — the check is not vacuous',
    !!dayShard && ghBig.files().get(dayShard).length > CONTENTS_API_LIMIT,
    { path: dayShard, bytes: dayShard && ghBig.files().get(dayShard).length,
      limit: CONTENTS_API_LIMIT });
  const readBack = await Store.readDays([dayKey], { env: ENV, gh: ghBig.gh });
  check('and report assembly reads it back whole rather than empty',
    readBack.events.length === 120 && readBack.missing.length === 0,
    { events: readBack.events.length, missing: readBack.missing });

  console.log('\n28. journalled rows are read at the commit, not at the start');
  /* Measured live: a resume spent NINETY SECONDS of a 240-second budget reading
     121,409 journalled rows back, before walking a single wallet — and it gets
     worse every run, because each run journals more. Those rows are needed for
     exactly one thing, the commit, which a run that does not finish its roster
     never reaches. */
  const ghL = fakeGithub(seeded(ANCHOR - 1000));
  await D.acquire({ report_id: 'SW-20260911-AL123' },
    { env: ENV, gh: ghL.gh, reader: fakePeer({ transactions: crashTx, balances: BAL, failOn: 'rCarol' }).reader,
      concurrency: 1 });
  const bankedPaths = JSON.parse(ghL.files().get(Store.JOURNAL_PATH).toString('utf8'))
    .row_shards.map(sh => sh.path);
  check('the first attempt banked rows in the journal', bankedPaths.length >= 1);

  // Attempt two: still cannot finish (rCarol fails again), so it must never
  // touch the banked rows.
  const ghL2 = fakeGithub(Object.fromEntries([...ghL.files()].map(([k, v]) => [k, v])));
  const outL2 = await D.acquire({ report_id: 'SW-20260911-AL124' },
    { env: ENV, gh: ghL2.gh, reader: fakePeer({ transactions: crashTx, balances: BAL, failOn: 'rCarol' }).reader,
      concurrency: 1 });
  check('an attempt that cannot commit never reads them',
    outL2.committed === false &&
    !ghL2.calls.some(c => bankedPaths.some(p2 => c.path.indexOf(p2) > -1)),
    ghL2.calls.filter(c => /resume/.test(c.path)).map(c => c.path));
  check('but it still knows how many are banked, from the manifest alone',
    outL2.resumed.adopted === true && outL2.resumed.rows_awaiting_load > 0,
    outL2.resumed);
  check('and it reports its OWN transactions separately from the banked ones',
    outL2.transactions_journalled === outL2.resumed.rows_awaiting_load,
    { own: outL2.transactions, banked: outL2.transactions_journalled });

  // Attempt three finishes, so now — and only now — the rows are fetched.
  const ghL3 = fakeGithub(Object.fromEntries([...ghL2.files()].map(([k, v]) => [k, v])));
  const outL3 = await D.acquire({ report_id: 'SW-20260911-AL125' },
    { env: ENV, gh: ghL3.gh, reader: fakePeer({ transactions: crashTx, balances: BAL }).reader,
      concurrency: 1 });
  check('the attempt that COMMITS reads them',
    outL3.committed === true &&
    ghL3.calls.some(c => bankedPaths.some(p2 => c.path.indexOf(p2) > -1)), outL3.reason);
  check('and the committed evidence holds the banked rows plus this run\'s',
    outL3.transactions === 2, outL3.transactions);
  check('every wallet is proven, recovered ones included',
    outL3.complete_wallets === 3 && outL3.wallets_recovered_from_journal === 2);
  const stateL = JSON.parse(ghL3.files().get(Store.STATE_PATH).toString('utf8'));
  check('the checkpoint advanced for all of them',
    stateL.state_version === 2 && stateL.wallets.every(w => w.last_proven_ledger === ANCHOR));
  check('and the journal is gone',
    !ghL3.files().get(Store.JOURNAL_PATH) && bankedPaths.every(p2 => !ghL3.files().get(p2)));

  console.log('\n29. a run always comes back, even from a wallet that never does');
  /* Measured live: 266 of 267 wallets finished, the last one hung, and the run
     produced NO result at all — not a failure, not a partial, nothing. Every
     wallet already walked was journalled and safe, and the operator still saw
     "ended with no result", which is the least useful thing a run can say. */
  const peerHang = fakePeer({ transactions: quiet(), balances: BAL });
  const innerHang = peerHang.reader.request.bind(peerHang.reader);
  peerHang.reader.deadline = Date.now() + 4000;
  peerHang.reader.request = async function (c, e, pin) {
    // rCarol's walk never returns. Nothing cancels it; the run must stop
    // waiting for it of its own accord.
    if (c.command === 'account_tx' && c.account === 'rCarol') return new Promise(() => {});
    return innerHang(c, e, pin);
  };
  const started = Date.now();
  const outHang = await D.acquire({ report_id: 'SW-20260911-AM123' },
    { env: ENV, gh: fakeGithub(seeded(ANCHOR - 1000)).gh, reader: peerHang.reader,
      concurrency: 3, startReserveMs: 100 });
  const tookMs = Date.now() - started;
  check('the run returns instead of waiting forever',
    !!outHang && outHang.committed === false, outHang && outHang.reason);
  check('and it returns near the budget, not long after it',
    tookMs < 30000, tookMs + 'ms');
  check('the hung wallet is named as abandoned, not silently dropped',
    outHang.abandoned_wallets === 1 &&
    outHang.freshness.abandoned.join(',') === 'rCarol', outHang.freshness.abandoned);
  check('abandoned is its own fact — not merged with never-attempted',
    outHang.wallets.find(w => w.address === 'rCarol').status === 'ABANDONED',
    outHang.wallets.map(w => w.address + ':' + w.status));
  check('the wallets that DID finish are still reported',
    outHang.complete_wallets === 2, outHang.complete_wallets);
  check('and a part-walked wallet is journalled as nothing — it proved nothing',
    outHang.journal_wallets === 2, outHang.journal_wallets);

  console.log('\n' + (fail ? fail + ' FAILED of ' + (pass + fail) : 'ALL ' + pass + ' DELTA ACQUISITION CHECKS PASS'));
  process.exit(fail ? 1 : 0);
}
main().then(undefined, e => { console.error(e); process.exit(1); });
