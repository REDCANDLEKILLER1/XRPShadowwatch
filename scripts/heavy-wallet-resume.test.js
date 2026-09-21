#!/usr/bin/env node
'use strict';
/* ── A WALLET THAT CANNOT FINISH IN ONE BUDGET MUST NOT START OVER IN THE NEXT ─
   The evidence checkpoint last advanced 2026-09-16 12:58Z. Since then every
   invocation has resumed the same journal (SW-20260917-PRG8S, anchor 107047364)
   and died on the same two wallets: COINBASE_HOT and BITHUMB_HOT. 415 of 418
   walked; three short for over a day.

   Why they never finish: a day of an exchange hot wallet is ~24 pages, deep
   marker walks run ~7 s a page, and the budget after the reserve is ~167 s.
   Doesn't fit — and a wallet cut off mid-walk journals NOTHING ("a partial walk
   proves nothing and cannot be written down"), so each invocation restarts both
   from page one. The walk is alphabetical and rw… sorts last, so they start
   after the light wallets, with even less budget. RUN_INCOMPLETE every time,
   the browser then walks 396 wallets itself, and the journal's anchor — with no
   age limit — pins the report to the 17th.

   Three rules this suite holds the run to. All three FAIL on the code as it
   stands; that failure is the reproduction. Not registered in run-tests.js
   until the fix lands.

     1. Partial progress survives the budget: what a cut-off wallet fully read
        is journalled, and the next run resumes past it instead of at page one.
     2. Unfinished-last-time walks first, so the heavy wallet gets the whole
        budget rather than the tail of it.
     3. A journal whose anchor has fallen more than twelve hours behind the
        live ledger re-anchors and keeps its work as partial progress, instead
        of pinning the report to the day it was started. (Six hours behind it
        still finishes the interrupted morning — acquisition suite, case 19.)

   Run: node scripts/heavy-wallet-resume.test.js
──────────────────────────────────────────────────────────────────────────── */
const path = require('path');
const ROOT = path.join(__dirname, '..');
const D = require(path.join(ROOT, 'src/db/delta-acquisition.js'));
const State = require(path.join(ROOT, 'src/db/evidence-state.js'));
const Store = require(path.join(ROOT, 'src/db/github-store.js'));

let pass = 0, fail = 0;
const check = (name, ok, detail) => {
  if (ok) { pass++; console.log('  PASS  ' + name); }
  else { fail++; console.log('  FAIL  ' + name + (detail !== undefined ? '  -> ' + JSON.stringify(detail) : '')); }
};
const ENV = { SHADOWWATCH_EVIDENCE_TOKEN: 'test-token' };
const ANCHOR = 110000000;
const RIPPLE_EPOCH = 946684800;
const hashFor = (a, i) => (a + '0'.repeat(64)).slice(0, 60) + String(i).padStart(4, '0');
const sleep = ms => new Promise(r => setTimeout(r, ms));

// ── A peer that PAGES. The acquisition suite's peer answers every wallet in one
// page, which is exactly why a heavy wallet has never existed in a test. This
// one returns `perPage` transactions per page with an advancing marker, and
// each page of a heavy wallet costs `pageMs` of wall clock.
function pagedPeer(options) {
  const opts = options || {};
  const asked = [];
  const reads = {};
  const txs = opts.transactions || {};
  const perPage = opts.perPage || 1;
  const pageMs = opts.pageMs || 0;
  const live = opts.liveLedger || ANCHOR;
  const lanes = ['wss://a', 'wss://b', 'wss://c', 'wss://d'].map(endpoint => ({ endpoint, epoch: 1, inFlight: 0 }));
  let cursor = 0;
  const reader = {
    epoch: 1, stats: { requests: 0, events: [] }, lanes,
    async lane() { const l = lanes[cursor++ % lanes.length]; l.assigned = (l.assigned || 0) + 1; return l; },
    releaseLane(l) { if (l && l.assigned > 0) l.assigned--; },
    event() {},
    // The close time moves with the ledger: ~3.7 s each. A fake whose clock
    // stood still while its ledger advanced a day made "a day later" invisible
    // to a rule that reads the clock first.
    async ledger() { return { ledger: live, close_ms: Date.UTC(2026, 8, 18, 14, 0, 0) + Math.round((live - ANCHOR) * 3700) }; },
    async request(command, expectedEpoch, pin) {
      this.stats.requests++;
      asked.push({ ...command, _at: Date.now() });
      if (command.command !== 'account_tx') throw new Error('UNEXPECTED_COMMAND_' + command.command);
      const all = (txs[command.account] || []).filter(t =>
        t.ledger >= command.ledger_index_min && t.ledger <= command.ledger_index_max);
      const start = command.marker ? Number(command.marker.p) : 0;
      const page = all.slice(start, start + perPage);
      if (all.length > perPage && pageMs) await sleep(pageMs);
      const more = start + perPage < all.length;
      return {
        validated: true, account: command.account,
        ledger_index_min: command.ledger_index_min, ledger_index_max: command.ledger_index_max,
        marker: more ? { p: start + perPage } : undefined,
        transactions: page.map((t, i) => ({
          ledger_index: t.ledger, validated: true,
          tx: { Account: command.account, Destination: 'rDest', TransactionType: 'Payment',
            Amount: t.amount, hash: hashFor(command.account, start + i),
            date: Math.floor(Date.UTC(2026, 8, 18, 5, 0, 0) / 1000) - RIPPLE_EPOCH, Fee: '12' },
          meta: { TransactionResult: 'tesSUCCESS', delivered_amount: t.amount, TransactionIndex: start + i,
            AffectedNodes: [{ ModifiedNode: { LedgerEntryType: 'AccountRoot',
              FinalFields: { Account: command.account, Balance: t.after },
              PreviousFields: { Balance: t.before } } }] }
        }))
      };
    },
    async balance(address, ledgerIndex, pin) {
      this.stats.requests++;
      asked.push({ command: 'account_info', account: address, ledger: ledgerIndex });
      // Pinned, and TRUE for that ledger: the partial bank reads the balance at
      // the ledger it reached, and a leg reconciled against the wrong previous
      // balance must contradict rather than pass.
      const at = Number.isInteger(Number(ledgerIndex)) ? Number(ledgerIndex) : live;
      // The ledger lies about ONE wallet, by a constant, from its first pinned
      // read onward. Keyed on the read rather than on a ledger so it does not
      // depend on how many pages fit in a budget on a loaded machine: the first
      // leg always starts from the truthful checkpoint and ends inside the lie
      // (contradicts); every later leg starts and ends inside it (reconciles).
      // Other wallets are never lied to, so a refusal can only be this one's.
      if (opts.lieFor === address) { reads[address] = (reads[address] || 0) + 1; }
      const lie = (opts.lieFor === address) ? 5000000n : 0n;
      if (opts.failPinnedBelow && at < opts.failPinnedBelow) throw new Error('INJECTED_BALANCE_READ_FAILURE');
      return { drops: String(BigInt(balanceAt(txs, address, at)) + lie), ledger: at };
    }
  };
  return { reader, asked };
}

// The same fake GitHub the store and acquisition suites use, trimmed to what a
// run needs: refs, contents, blobs, trees, commits, and a ref that moves.
function fakeGithub(files) {
  const calls = [];
  const blobs = new Map();
  const state = { headFiles: new Map(Object.entries(files || {})), head: 'c0', n: 0, blobBytes: new Map() };
  const commits = new Map([['c0', { files: new Map(state.headFiles) }]]);
  const gh = async (method, p, body, allow404) => {
    calls.push({ method, path: p });
    if (method === 'GET' && /^\/git\/ref\/heads\//.test(p)) return { object: { sha: state.head } };
    if (method === 'GET' && /^\/contents\//.test(p)) {
      const file = decodeURIComponent(p.slice('/contents/'.length).split('?')[0]);
      if (!state.headFiles.has(file)) { if (allow404) return null; throw Object.assign(new Error('404'), { status: 404 }); }
      const raw = state.headFiles.get(file);
      const buf = Buffer.isBuffer(raw) ? raw : Buffer.from(raw, 'utf8');
      const sha = 'blob-' + file; state.blobBytes.set(sha, buf);
      return { sha, size: buf.length, encoding: 'base64', content: buf.toString('base64') };
    }
    if (method === 'GET' && /^\/git\/blobs\//.test(p)) {
      const sha = decodeURIComponent(p.slice('/git/blobs/'.length));
      const buf = state.blobBytes.get(sha);
      if (!buf) throw Object.assign(new Error('404'), { status: 404 });
      return { sha, size: buf.length, encoding: 'base64', content: buf.toString('base64') };
    }
    if (method === 'GET' && /^\/git\/commits\//.test(p)) return { tree: { sha: 'tree-' + decodeURIComponent(p.slice('/git/commits/'.length)) } };
    if (method === 'GET' && /^\/git\/trees\//.test(p)) {
      const commitSha = decodeURIComponent(p.slice('/git/trees/'.length).split('?')[0]).replace(/^tree-/, '');
      const snapshot = (commitSha === state.head || !commits.has(commitSha)) ? state.headFiles : commits.get(commitSha).files;
      return { tree: [...snapshot.keys()].map(k => ({ path: k, type: 'blob' })) };
    }
    if (method === 'POST' && p === '/git/blobs') { const sha = 'b' + (++state.n); blobs.set(sha, Buffer.from(body.content, 'base64')); return { sha }; }
    if (method === 'POST' && p === '/git/trees') {
      for (const e of body.tree) if (e.sha === null && !state.headFiles.has(e.path)) throw Object.assign(new Error('422 delete of absent path: ' + e.path), { status: 422 });
      state.pending = body.tree; return { sha: 't' + (++state.n) };
    }
    if (method === 'POST' && p === '/git/commits') {
      const sha = 'c' + (++state.n); const f = new Map(state.headFiles);
      for (const e of state.pending) { if (e.sha === null) f.delete(e.path); else f.set(e.path, blobs.get(e.sha)); }
      commits.set(sha, { files: f }); return { sha };
    }
    if (method === 'PATCH' && /^\/git\/refs\/heads\//.test(p)) { state.head = body.sha; state.headFiles = new Map(commits.get(body.sha).files); return {}; }
    return {};
  };
  return { gh, calls, files: () => state.headFiles, head: () => state.head };
}

function seededStore(wallets, through) {
  const g = State.genesis(wallets.map(a => ({ address: a, scan_coverage_through: through,
    scan_coverage_through_close: '2026-09-16T12:58:31.000Z' })),
    { anchor_ledger: through, anchor_close: '2026-09-16T12:58:31.000Z' });
  const sealed = State.seal({ ...g, wallets: g.wallets.map(w => State.walletEntry({
    ...w, balance_drops: '20000000000000', balance_ledger: through })) });
  return { [Store.STATE_PATH]: State.serialize(sealed) };
}
function readJournal(gh) {
  const raw = gh.files().get(Store.JOURNAL_PATH);
  if (!raw) return null;
  return JSON.parse(Buffer.isBuffer(raw) ? raw.toString('utf8') : raw);
}
// Forty inbound payments, one per page, ascending ledgers, and the balance
// MOVES by 1 XRP on each: a heavy wallet in miniature whose partial legs can
// only reconcile if each is compared against the balance at its own ledger.
const BASE_DROPS = 20000000000000n;
const heavy = (n) => Array.from({ length: n }, (_, i) => ({
  ledger: ANCHOR - 900 + i, amount: '1000000',
  before: String(BASE_DROPS + BigInt(i) * 1000000n), after: String(BASE_DROPS + BigInt(i + 1) * 1000000n) }));
// Balance of an address at a ledger, from the same fixture the pages come from.
const balanceAt = (txs, address, ledger) => {
  const n = (txs[address] || []).filter(t => t.ledger <= ledger).length;
  return String(BASE_DROPS + BigInt(n) * 1000000n);
};

async function main() {
  // ══ 1. PARTIAL PROGRESS SURVIVES THE BUDGET ══════════════════════════════
  console.log('\n1. a wallet cut off mid-walk banks what it fully read, and the next run resumes past it');
  const WALLETS = ['rAlice', 'rBob', 'rZedHot'];        // rZedHot sorts last, like rw2ci…
  const HEAVY = 40;
  const txs = { rAlice: [], rBob: [], rZedHot: heavy(HEAVY) };

  const gh = fakeGithub(seededStore(WALLETS, ANCHOR - 1000));
  const p1 = pagedPeer({ transactions: txs, perPage: 1, pageMs: 40 });
  p1.reader.deadline = Date.now() + 700;                 // enough for ~14 pages of 40 at 40 ms each
  const out1 = await D.acquire({ report_id: 'SW-20260918-HVY01' },
    { env: ENV, gh: gh.gh, reader: p1.reader, concurrency: 1, startReserveMs: 0 });
  const hot1 = p1.asked.filter(c => c.command === 'account_tx' && c.account === 'rZedHot');
  check('run 1 ends incomplete — the roster is not finished',
    out1.committed === false && out1.reason === 'RUN_INCOMPLETE', out1.reason);
  check('the heavy wallet was cut off mid-walk, not skipped',
    out1.wallets.find(w => w.address === 'rZedHot').status === 'ABANDONED', out1.wallets.map(w => w.status));
  check('and it had fetched several pages before the budget expired',
    hot1.length >= 3 && hot1.length < HEAVY, hot1.length);
  const j1 = readJournal(gh);
  check('the two light wallets were journalled', !!j1 && j1.wallets.length >= 2, j1 && j1.wallets.map(w => w.address));
  const hotRecord1 = j1 && j1.wallets.find(w => w.address === 'rZedHot');
  // THE DEFECT. Today this record does not exist: the pages were thrown away.
  check('the heavy wallet\'s PARTIAL progress was journalled too',
    !!hotRecord1 && hotRecord1.rows >= 1, hotRecord1 || 'no record — pages discarded');
  check('recorded as unfinished, proven through less than the anchor',
    !!hotRecord1 && Number(hotRecord1.proven_through) < ANCHOR, hotRecord1 && hotRecord1.proven_through);
  check('and the banked leg was RECONCILED against a balance pinned at the ledger it reached',
    !!hotRecord1 && hotRecord1.reconciliation === 'RECONCILED' &&
    hotRecord1.entry && Number(hotRecord1.entry.balance_ledger) === Number(hotRecord1.proven_through),
    hotRecord1 && { reconciliation: hotRecord1.reconciliation, balance_ledger: hotRecord1.entry && hotRecord1.entry.balance_ledger });

  // Run 2: same store, same slow pages, same budget.
  const p2 = pagedPeer({ transactions: txs, perPage: 1, pageMs: 40 });
  p2.reader.deadline = Date.now() + 700;
  const out2 = await D.acquire({ report_id: 'SW-20260918-HVY02' },
    { env: ENV, gh: gh.gh, reader: p2.reader, concurrency: 1, startReserveMs: 0 });
  check('run 2 adopts the journal', out2.resumed && out2.resumed.adopted === true, out2.resumed);
  const hot2 = p2.asked.filter(c => c.command === 'account_tx' && c.account === 'rZedHot');
  const firstFrom = hot2.length ? hot2[0].ledger_index_min : null;
  // THE DEFECT, from the other side: today run 2 asks from ANCHOR-999 again.
  check('run 2 resumes the heavy wallet PAST what run 1 read, not from page one',
    firstFrom !== null && firstFrom > ANCHOR - 999, { first_request_from: firstFrom, page_one_would_be: ANCHOR - 999 });
  // Not "about once": two partial fetches of fourteen never add up to forty, so
  // a count can pass on the defect. What must not happen is the same ledger
  // being asked for twice: run 2's lowest bound must clear the highest ledger
  // run 1 actually received.
  const highest1 = Math.max(-1, ...hot1.map(c => c.ledger_index_min)); // pages advance by marker, min stays; use rows instead
  const received1 = (j1 && hotRecord1) ? Number(hotRecord1.proven_through) : null;
  check('run 2 does not re-request a ledger run 1 already read',
    received1 !== null && firstFrom !== null && firstFrom > received1, { run1_proven_through: received1, run2_first_from: firstFrom });

  // Keep resuming. A wallet of 40 pages at ~14 per budget needs three runs; it
  // must converge, not loop.
  let outN = out2, runs = 2;
  while (outN.committed !== true && runs < 6) {
    const pN = pagedPeer({ transactions: txs, perPage: 1, pageMs: 40 });
    pN.reader.deadline = Date.now() + 700;
    outN = await D.acquire({ report_id: 'SW-20260918-HVY0' + (++runs) },
      { env: ENV, gh: gh.gh, reader: pN.reader, concurrency: 1, startReserveMs: 0 });
  }
  check('the run eventually completes and commits (' + runs + ' runs)', outN.committed === true, { runs, reason: outN.reason });
  check('with every wallet proven at the anchor',
    outN.committed === true && outN.complete_wallets === WALLETS.length, outN.complete_wallets);
  // Not merely "no contradiction": a leg reconciled against the wrong previous
  // balance does not contradict, it STANDS DOWN (EDGE_LEAVES_GAP) — and a
  // check that only forbids contradiction passes on a wallet nothing verified.
  const hotFinal = outN.wallets && outN.wallets.find(w => w.address === 'rZedHot');
  check('and the heavy wallet RECONCILED end to end across its legs — every leg joined the last',
    outN.committed === true && outN.balance_contradictions === 0 &&
    !!hotFinal && hotFinal.reconciliation === 'RECONCILED', hotFinal && { reconciliation: hotFinal.reconciliation });

  // ══ 2. A FRESH RUN WALKS THE KNOWN-HEAVY WALLET FIRST ═══════════════════
  console.log('\n2. on a fresh anchor the wallet known to be busy is walked first, not last');
  /* On a RESUME the abandoned wallet is always alphabetically first among what
     remains — the walk is sequential, so everything unstarted sorts after it —
     which means "unfinished first" is satisfied by accident and cannot be
     tested there. Where the order costs a run is the FIRST invocation of a new
     anchor: every light wallet goes first, and the exchange hot wallet starts
     with whatever budget is left. The checkpoint already knows who was busy:
     last_observed_tx_ledger sits at the previous anchor for a wallet that
     moves every day and far behind it for one that never moves. */
  const W2 = ['rAlice', 'rBob', 'rCarol', 'rZedHot'];
  const txs2 = { rAlice: [], rBob: [], rCarol: [], rZedHot: heavy(HEAVY) };
  const files2 = seededStore(W2, ANCHOR - 1000);
  // Stamp activity: the hot wallet moved right up to the checkpoint; the rest
  // last moved long before it.
  const st2 = JSON.parse(files2[Store.STATE_PATH]);
  st2.wallets = st2.wallets.map(w => State.walletEntry({ ...w,
    last_observed_tx_ledger: w.address === 'rZedHot' ? ANCHOR - 1000 : ANCHOR - 900000 }));
  files2[Store.STATE_PATH] = State.serialize(State.seal(st2));
  const gh2 = fakeGithub(files2);
  const q1 = pagedPeer({ transactions: txs2, perPage: 1, pageMs: 40 });
  q1.reader.deadline = Date.now() + 700;
  await D.acquire({ report_id: 'SW-20260918-ORD01' }, { env: ENV, gh: gh2.gh, reader: q1.reader, concurrency: 1, startReserveMs: 0 });
  const order = q1.asked.filter(c => c.command === 'account_tx').map(c => c.account);
  check('the busy wallet is the FIRST walked on a fresh run',
    order.length > 0 && order[0] === 'rZedHot', order.slice(0, 4));

  // ══ 3. A STALE JOURNAL RE-ANCHORS INSTEAD OF PINNING ════════════════════
  console.log('\n3. a journal whose anchor is a day behind the live ledger does not pin the run to yesterday');
  const W3 = ['rAlice', 'rBob', 'rZedHot'];
  const txs3 = { rAlice: [], rBob: [], rZedHot: heavy(HEAVY) };
  const gh3 = fakeGithub(seededStore(W3, ANCHOR - 1000));
  const r1 = pagedPeer({ transactions: txs3, perPage: 1, pageMs: 40, liveLedger: ANCHOR });
  r1.reader.deadline = Date.now() + 700;
  const o1 = await D.acquire({ report_id: 'SW-20260917-OLD01' }, { env: ENV, gh: gh3.gh, reader: r1.reader, concurrency: 1, startReserveMs: 0 });
  check('day one leaves a journal anchored at day one', o1.committed === false && readJournal(gh3) && readJournal(gh3).anchor_ledger === ANCHOR);
  // Day two: the live ledger is ~25 hours further on (XRPL closes one every ~3.7 s).
  const DAY = Math.round(25 * 3600 / 3.7);
  const r2 = pagedPeer({ transactions: txs3, perPage: 1, pageMs: 40, liveLedger: ANCHOR + DAY });
  r2.reader.deadline = Date.now() + 700;
  const o2 = await D.acquire({ report_id: 'SW-20260918-NEW02' }, { env: ENV, gh: gh3.gh, reader: r2.reader, concurrency: 1, startReserveMs: 0 });
  check('day two walks to TODAY\'s ledger, not yesterday\'s',
    o2.anchor_ledger === ANCHOR + DAY, { got: o2.anchor_ledger, yesterday: ANCHOR, today: ANCHOR + DAY });
  check('and it did not throw away yesterday\'s work — the light wallets were not re-walked from their old checkpoint',
    r2.asked.filter(c => c.command === 'account_tx' && c.account === 'rAlice').every(c => c.ledger_index_min > ANCHOR),
    r2.asked.filter(c => c.command === 'account_tx' && c.account === 'rAlice').map(c => c.ledger_index_min));

  // ══ 4. A CONTRADICTION ON A BANKED LEG STILL BLOCKS THE COMMIT ══════════
  console.log('\n4. a leg that contradicted when it was banked is a contradiction for the wallet, whatever the last leg says');
  /* The ledger's balance for the heavy wallet is wrong by 5 XRP from its first
     pinned read onward. The FIRST leg starts from the truthful checkpoint
     balance and ends inside the lie, so it contradicts when it is banked.
     Every later leg starts and ends inside the lie, so on its own it
     reconciles perfectly. If the run only looked at the final leg it would
     commit a wallet whose evidence it has already seen does not add up. The
     light wallets are never lied to, so the refusal can only be this one's. */
  const W4 = ['rAlice', 'rBob', 'rZedHot'];
  const txs4 = { rAlice: [], rBob: [], rZedHot: heavy(HEAVY) };
  const gh4 = fakeGithub(seededStore(W4, ANCHOR - 1000));
  let out4 = null, runs4 = 0;
  do {
    const p4 = pagedPeer({ transactions: txs4, perPage: 1, pageMs: 40, lieFor: 'rZedHot' });
    p4.reader.deadline = Date.now() + 700;
    out4 = await D.acquire({ report_id: 'SW-20260918-LIE0' + (++runs4) },
      { env: ENV, gh: gh4.gh, reader: p4.reader, concurrency: 1, startReserveMs: 0 });
  } while (out4.reason === 'RUN_INCOMPLETE' && runs4 < 6);
  const j4 = readJournal(gh4);
  const hot4 = j4 && j4.wallets.find(w => w.address === 'rZedHot');
  check('the banked leg recorded its contradiction',
    !!hot4 && hot4.reconciliation === 'CONTRADICTION', hot4 && hot4.reconciliation);
  check('the wallet was walked to the anchor in the end (' + runs4 + ' runs)',
    out4.reason !== 'RUN_INCOMPLETE', out4.reason);
  check('and the run REFUSED to commit — a leg that did not add up is not cured by a later leg that does',
    out4.committed === false && out4.reason === 'RUN_CONTRADICTED' &&
    out4.balance_contradiction_addresses.includes('rZedHot'), { reason: out4.reason, addresses: out4.balance_contradiction_addresses });
  check('and it was THIS wallet alone — the light wallets reconciled truthfully',
    JSON.stringify(out4.balance_contradiction_addresses) === JSON.stringify(['rZedHot']), out4.balance_contradiction_addresses);

  // ══ 5. A LEG WHOSE PINNED BALANCE CANNOT BE READ IS HELD, NOT BANKED ═══
  console.log('\n5. when the pinned balance cannot be read, the leg waits rather than being banked unverified');
  const W5 = ['rAlice', 'rBob', 'rZedHot'];
  const txs5 = { rAlice: [], rBob: [], rZedHot: heavy(HEAVY) };
  const gh5 = fakeGithub(seededStore(W5, ANCHOR - 1000));
  // Every pinned read BELOW the anchor fails; the anchor itself answers.
  const p5 = pagedPeer({ transactions: txs5, perPage: 1, pageMs: 40, failPinnedBelow: ANCHOR });
  p5.reader.deadline = Date.now() + 700;
  const out5 = await D.acquire({ report_id: 'SW-20260918-NOBAL1' },
    { env: ENV, gh: gh5.gh, reader: p5.reader, concurrency: 1, startReserveMs: 0 });
  const j5 = readJournal(gh5);
  check('the heavy wallet was cut off as before',
    out5.wallets.find(w => w.address === 'rZedHot').status === 'ABANDONED');
  check('but NOTHING was banked for it — an unverified leg is not evidence',
    !!j5 && !j5.wallets.some(w => w.address === 'rZedHot'), j5 && j5.wallets.map(w => w.address));
  check('the light wallets, whose anchor read succeeded, were journalled',
    !!j5 && ['rAlice', 'rBob'].every(a => j5.wallets.some(w => w.address === a)));

  // ══ 6. A WALLET THE JOURNAL HAS NEVER MANAGED TO BANK GOES FIRST ════════
  console.log('\n6. a wallet with no journal record at all is walked before the partial ones, not after');
  /* Live, 21 Sep: after two re-anchors every wallet was partial except three —
     COINBASE_HOT, BITHUMB_HOT and one small one — the three that had never
     once fitted in a budget. "Partial first" therefore put the two wallets
     that caused the whole wedge BEHIND all 391 others. A wallet the journal
     has no record of is the one most likely to be unfinishable; it gets the
     first lane. */
  const Journal = require(path.join(ROOT, 'src/db/run-journal.js'));
  const W6 = ['rAlice', 'rBob', 'rCarol', 'rZedHot'];
  const txs6 = { rAlice: [], rBob: [], rCarol: [], rZedHot: heavy(HEAVY) };
  const files6 = seededStore(W6, ANCHOR - 1000);
  const st6 = JSON.parse(files6[Store.STATE_PATH]);
  // A journal in which the three light wallets are PARTIAL and the heavy one
  // is absent — the shape a re-anchored journal takes.
  let j6 = Journal.begin({ report_id: 'SW-20260921-PRIOR', scan_id: null, started_at: '2026-09-21T00:00:00.000Z',
    from_state_version: st6.state_version, from_state_sha256: st6.state_sha256,
    anchor_ledger: ANCHOR, anchor_close: '2026-09-21T03:00:00.000Z', cold_from_ledger: null, admitted_wallets: [] });
  j6 = Journal.record(j6, { wallets: ['rAlice', 'rBob', 'rCarol'].map(a => ({
    address: a, proven_from: ANCHOR - 999, proven_through: ANCHOR - 500, rows: 0, reconciliation: 'RECONCILED',
    entry: State.walletEntry({ ...st6.wallets.find(w => w.address === a), last_proven_ledger: ANCHOR - 500 }) })), row_shards: [] });
  files6[Store.JOURNAL_PATH] = Journal.serialize(j6);
  const gh6 = fakeGithub(files6);
  const p6 = pagedPeer({ transactions: txs6, perPage: 1, pageMs: 40 });
  p6.reader.deadline = Date.now() + 700;
  const out6 = await D.acquire({ report_id: 'SW-20260921-ORD06' }, { env: ENV, gh: gh6.gh, reader: p6.reader, concurrency: 1, startReserveMs: 0 });
  const order6 = p6.asked.filter(c => c.command === 'account_tx').map(c => c.account);
  check('the journal was adopted with three partial wallets', out6.resumed && out6.resumed.adopted === true && out6.resumed.wallets_partial === 3, out6.resumed);
  check('the never-banked wallet is walked FIRST', order6.length > 0 && order6[0] === 'rZedHot', order6.slice(0, 4));

  // ══ 7. ONE LANE FOR THE LIGHT END ═══════════════════════════════════════
  console.log('\n7. with more than one lane, the light wallets drain while the heavy ones grind');
  /* 684 wallets "never started" across two runs on 21 Sep: four lanes, all
     four held by heavy wallets for the whole budget, and 384 wallets that
     needed a page each never got one. Heavy-first was right; heavy-ONLY is
     not. One worker takes from the light end. */
  const W7 = ['rAlice', 'rBob', 'rCarol', 'rYakHot', 'rZedHot'];
  const txs7 = { rAlice: [], rBob: [], rCarol: [], rYakHot: heavy(HEAVY), rZedHot: heavy(HEAVY) };
  const files7 = seededStore(W7, ANCHOR - 1000);
  const st7 = JSON.parse(files7[Store.STATE_PATH]);
  st7.wallets = st7.wallets.map(w => State.walletEntry({ ...w,
    last_observed_tx_ledger: /Hot$/.test(w.address) ? ANCHOR - 1000 : ANCHOR - 900000 }));
  files7[Store.STATE_PATH] = State.serialize(State.seal(st7));
  const gh7 = fakeGithub(files7);
  const p7 = pagedPeer({ transactions: txs7, perPage: 1, pageMs: 40 });
  p7.reader.deadline = Date.now() + 700;
  const out7 = await D.acquire({ report_id: 'SW-20260921-LANE7' }, { env: ENV, gh: gh7.gh, reader: p7.reader, concurrency: 2, startReserveMs: 0 });
  const status7 = Object.fromEntries(out7.wallets.map(w => [w.address, w.status]));
  check('a heavy wallet took a lane and was cut off', status7.rZedHot === 'ABANDONED' || status7.rYakHot === 'ABANDONED', status7);
  check('and every light wallet still COMPLETED in the same run',
    ['rAlice', 'rBob', 'rCarol'].every(a => status7[a] === 'COMPLETE'), status7);
  check('nothing light was left "not attempted" with a lane idle',
    !['rAlice', 'rBob', 'rCarol'].some(a => status7[a] === 'NOT_ATTEMPTED'), status7);

  console.log('\n' + (fail === 0 ? 'ALL ' + pass + ' CHECKS PASS' : pass + ' pass, ' + fail + ' FAIL'));
  process.exit(fail === 0 ? 0 : 1);
}
main().catch(e => { console.error(e); process.exit(1); });
