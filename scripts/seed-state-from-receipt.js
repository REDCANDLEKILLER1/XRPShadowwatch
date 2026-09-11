#!/usr/bin/env node
'use strict';
// Seed the GitHub checkpoint from a sealed report receipt. No database.
//
// ── THE POINT ──────────────────────────────────────────────────────────────
//
// The checkpoint has been in the repository all along. A sealed report that
// proved 255 of 255 wallets names the validated ledger every one of them was
// proven through:
//
//   "target_wallets": 255, "transaction_windows_proved": 255,
//   "failed": 0, "truncated": 0, "unproven": 0,
//   "validated_anchor_ledger": 106858107, "coverage_complete": true
//
// That IS last_proven_ledger for all 255. It was written down, hashed and
// committed at the time, by the run that earned it. Reading it back needs no
// Neon, no export and no migration — which matters, because the database is
// over its storage quota and may not answer at all.
//
// After this, every run walks last_proven_ledger+1 -> today's anchor. The
// historical transactions still sit in Neon and can be exported later; they are
// not needed to start, because the report reads a window, not a history.
//
// ── WHAT IT REFUSES ────────────────────────────────────────────────────────
//
// A receipt that did not prove every wallet. "255 wallets, 3 failed" does not
// establish a checkpoint for the 252 either, because the run was never sealed
// as complete and its anchor was never earned.
//
// A roster that has changed since. The receipt records a roster_hash but not
// the addresses, so if the hash differs there is no way to tell WHICH wallets
// that anchor covered. Seeding all of them would hand a checkpoint to a wallet
// nobody proved. Refused, with the two hashes printed.
//
// Usage:
//   node scripts/seed-state-from-receipt.js                 # dry run
//   node scripts/seed-state-from-receipt.js --apply
//   node scripts/seed-state-from-receipt.js --report SW-20260909-OP57K --apply

const A = require('../src/db/github-archive');
const Store = require('../src/db/github-store');
const State = require('../src/db/evidence-state');
const roster = require('../src/db/roster');

function args(argv) {
  const out = { apply: false, report: null };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--apply') out.apply = true;
    else if (argv[i] === '--report') out.report = argv[++i];
  }
  return out;
}

// A receipt establishes a checkpoint only if its run proved the whole roster.
function complete(receipt) {
  return receipt && receipt.coverage_complete === true &&
    Number(receipt.transaction_windows_proved) === Number(receipt.target_wallets) &&
    Number(receipt.target_wallets) > 0 &&
    Number(receipt.failed || 0) === 0 && Number(receipt.truncated || 0) === 0 &&
    Number(receipt.unproven || 0) === 0 &&
    Number.isInteger(Number(receipt.validated_anchor_ledger)) &&
    Number(receipt.validated_anchor_ledger) > 0;
}

async function main() {
  const opts = args(process.argv.slice(2));
  // TWO repositories, deliberately. The sealed receipts live in the
  // application repo's archive branch, where the runs that earned them wrote
  // them. The checkpoint they establish belongs in the evidence repo, which is
  // where every later run will look for it.
  const { token, repo, branch } = A.archiveTarget(process.env);
  const gh = A.client(token, repo, fetch);
  const ref = await A.archiveRef(gh, branch);
  const evidence = A.evidenceTarget(process.env);

  console.log('SEED CHECKPOINT FROM SEALED REPORT');
  console.log('  receipts from     ' + repo);
  console.log('                    ' + branch + ' @ ' + ref.object.sha.slice(0, 7));
  console.log('  checkpoint to     ' + evidence.repo);
  console.log('                    ' + evidence.branch);

  // One tree read finds every receipt without walking the directory structure.
  const commit = await gh('GET', '/git/commits/' + ref.object.sha);
  const tree = await gh('GET', '/git/trees/' + commit.tree.sha + '?recursive=1');
  const paths = (tree.tree || []).filter(n => n.type === 'blob' && /^reports\/.*\/receipt\.json$/.test(n.path))
    .map(n => n.path).sort();
  console.log('  receipts found    ' + paths.length);
  if (!paths.length) throw new Error('NO_RECEIPTS: the archive branch holds no sealed report to seed from');

  const candidates = [];
  for (const path of paths) {
    const file = await gh('GET', '/contents/' + path + '?ref=' + encodeURIComponent(branch), undefined, true);
    if (!file) continue;
    let receipt; try { receipt = JSON.parse(Buffer.from(file.content || '', 'base64').toString('utf8')); }
    catch (_) { continue; }
    candidates.push({ path, receipt });
  }

  const usable = candidates.filter(c => complete(c.receipt))
    .sort((a, b) => Number(a.receipt.validated_anchor_ledger) - Number(b.receipt.validated_anchor_ledger));
  console.log('  proved 255/255    ' + usable.length + ' of ' + candidates.length);
  for (const c of candidates) {
    const r = c.receipt;
    console.log('    ' + (complete(r) ? 'usable  ' : 'skipped ') + r.report_id +
      '  ' + r.transaction_windows_proved + '/' + r.target_wallets +
      '  anchor ' + r.validated_anchor_ledger + '  ' + r.generated_at);
  }
  if (!usable.length) throw new Error('NO_COMPLETE_RECEIPT: no sealed report proved its whole roster; there is no earned checkpoint to seed from');

  const chosen = opts.report
    ? usable.find(c => c.receipt.report_id === opts.report)
    : usable[usable.length - 1];
  if (!chosen) throw new Error('REPORT_NOT_USABLE: ' + opts.report + ' is not among the complete receipts');
  const receipt = chosen.receipt;
  const anchor = Number(receipt.validated_anchor_ledger);

  // The receipt names a roster by hash, not by address. If it differs there is
  // no way to know which wallets that anchor covered.
  const selected = roster.select();
  console.log('\n  chosen            ' + receipt.report_id + '  anchor ' + anchor);
  console.log('  roster now        ' + selected.accounts.length + ' wallets · ' + selected.hash.slice(0, 16));
  console.log('  roster proved     ' + receipt.target_wallets + ' wallets · ' + String(receipt.roster_hash).slice(0, 16));
  if (selected.hash !== receipt.roster_hash) {
    throw new Error('ROSTER_CHANGED_SINCE_RECEIPT: the roster no longer matches the one this anchor proved, ' +
      'and the receipt records only its hash — so which wallets it covered cannot be determined. ' +
      'Seed from a receipt whose roster_hash is ' + selected.hash + ', or re-prove the current roster.');
  }
  if (Number(receipt.target_wallets) !== selected.accounts.length) {
    throw new Error('ROSTER_SIZE_MISMATCH: ' + receipt.target_wallets + ' proved, ' + selected.accounts.length + ' current');
  }

  // Every wallet in the proven roster, checkpointed at the anchor its run
  // earned. No balance: the first run establishes that baseline, and claiming
  // one we never read would give the cross-check a false endpoint.
  const coverage = selected.accounts.map(address => ({
    address, scan_coverage_through: anchor, scan_coverage_through_close: null
  }));
  const preview = State.genesis(coverage, { anchor_ledger: anchor, anchor_close: null,
    sealed_run: { report_id: receipt.report_id, scan_id: receipt.scan_id || null,
      target_wallets: Number(receipt.target_wallets), complete_wallets: Number(receipt.transaction_windows_proved),
      balance_contradictions: 0, sealed_at: receipt.sealed_at || null } });

  console.log('\n  state version     ' + preview.state_version);
  console.log('  wallets seeded    ' + preview.wallet_count + ', all at ledger ' + anchor);
  console.log('  state sha256      ' + preview.state_sha256);
  console.log('  bytes             ' + Buffer.byteLength(State.serialize(preview), 'utf8').toLocaleString());
  console.log('  mode              ' + (opts.apply ? 'APPLY' : 'DRY RUN (pass --apply to write)'));

  if (!opts.apply) {
    console.log('\nDry run. Nothing was written.');
    console.log('The first run after seeding walks ' + (anchor + 1) + ' -> today\'s validated anchor,');
    console.log('which is the gap since ' + receipt.generated_at + ' and nothing more.');
    return;
  }

  const result = await Store.seedGenesis({ coverage, anchor_ledger: anchor, anchor_close: null,
    sealed_run: preview.sealed_run }, {});
  console.log('\n' + result.status);
  if (result.status === 'ALREADY_SEEDED') {
    console.log('  a checkpoint chain already exists at version ' + result.state_version +
      ' (' + String(result.state_sha256).slice(0, 16) + ')');
    console.log('  genesis happens once; nothing was changed.');
    return;
  }
  console.log('  commit            ' + result.commit_sha);
  console.log('  wallets           ' + result.wallets);
  console.log('  state sha256      ' + result.state_sha256);
  console.log('\nNo database was read or written. The next run walks ' + (anchor + 1) + " -> today's anchor.");
}

// Exported so the suite exercises the same predicate the script runs, rather
// than a paraphrase of it that could drift.
module.exports = { complete };

if (require.main === module) {
  main().catch(e => { console.error(String(e && e.message || e)); process.exitCode = 1; });
}
