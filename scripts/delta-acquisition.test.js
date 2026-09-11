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
const State = require(path.join(ROOT, 'src/db/evidence-state.js'));
const Store = require(path.join(ROOT, 'src/db/github-store.js'));

let pass = 0, fail = 0;
const check = (name, ok, detail) => {
  if (ok) { pass++; console.log('  PASS  ' + name); }
  else { fail++; console.log('  FAIL  ' + name + (detail !== undefined ? '  -> ' + JSON.stringify(detail) : '')); }
};
const ENV = { SHADOWWATCH_GITHUB_ARCHIVE_TOKEN: 'test-token' };
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
  const reader = {
    epoch: 1,
    stats: { requests: 0, events: [] },
    event() {},
    async ledger() { return { ledger: ANCHOR, close_ms: Date.UTC(2026, 8, 11, 6, 0, 0) }; },
    async request(command) {
      this.stats.requests++;
      asked.push(command);
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
    async balance(address) {
      this.stats.requests++;
      asked.push({ command: 'account_info', account: address });
      const drops = balances[address];
      return drops === undefined ? null : { drops, ledger: ANCHOR };
    }
  };
  return { reader, asked };
}

// The same fake GitHub the store suite uses, trimmed to what a run needs.
function fakeGithub(files) {
  const calls = [];
  const blobs = new Map();
  const state = { headFiles: new Map(Object.entries(files || {})), head: 'c0', n: 0 };
  const commits = new Map([['c0', { files: new Map(state.headFiles) }]]);
  const gh = async (method, p, body, allow404) => {
    calls.push({ method, path: p });
    if (method === 'GET' && /^\/git\/ref\/heads\//.test(p)) return { object: { sha: state.head } };
    if (method === 'GET' && /^\/contents\//.test(p)) {
      const file = decodeURIComponent(p.slice('/contents/'.length).split('?')[0]);
      if (!state.headFiles.has(file)) { if (allow404) return null; throw Object.assign(new Error('404'), { status: 404 }); }
      return { content: Buffer.from(state.headFiles.get(file), 'utf8').toString('base64') };
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
      for (const e of state.pending) f.set(e.path, blobs.get(e.sha));
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
  check('the branch did not move', gh5.calls.filter(c => c.method === 'PATCH').length === 0);
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
    out6.failures.length === 1 && /INJECTED_WALK_FAILURE/.test(out6.failures[0].error), out6.failures);
  check('nothing was written', gh6.calls.filter(c => c.method === 'PATCH').length === 0);
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

  console.log('\n' + (fail ? fail + ' FAILED of ' + (pass + fail) : 'ALL ' + pass + ' DELTA ACQUISITION CHECKS PASS'));
  process.exit(fail ? 1 : 0);
}
main().then(undefined, e => { console.error(e); process.exit(1); });
