'use strict';
const fs = require('fs');
let bad = 0;
function ok(name, cond, detail) {
  console.log((cond ? 'PASS ' : 'FAIL ') + name + (detail ? ' — ' + detail : ''));
  if (!cond) bad++;
}
const tune = fs.readFileSync('src/brief/17-report-scan-tuning-20260816.js','utf8');
const bridge = fs.readFileSync('src/brief/45-delta-evidence-index-20260911.js','utf8');
const delta = fs.readFileSync('src/db/delta-acquisition.js','utf8');

ok('evidence-service failure is fail-closed', /EVIDENCE_STORE_REQUIRED/.test(bridge));
ok('fail-closed bridge names all requested accounts', /accounts: \(accounts \|\| \[\]\)\.slice\(\)/.test(bridge));
ok('fatal evidence run refuses wallet proof', /run\.fatal_error/.test(bridge));
ok('missing evidence wallet is fail-closed', /EVIDENCE_WALLET_NOT_PROVEN/.test(tune));

ok('equal anchor is explicit already-current', /reason: currentFailed \? 'EVIDENCE_COVERAGE_GAP' : 'ALREADY_CURRENT'/.test(delta));
ok('already-current proof is per-wallet and anchor-bounded',
  /const through = Number\(w\.last_proven_ledger\) \|\| 0;/.test(delta) &&
  /const proven = through >= coveredAnchor;/.test(delta));
ok('lagging wallet is an evidence coverage failure',
  /EVIDENCE_WALLET_BEHIND_CHECKPOINT/.test(delta) &&
  /freshness: \{ wallets_proven: currentProven/.test(delta));
ok('concurrent equal-anchor race uses the same per-wallet coverage rule',
  /ALREADY_CURRENT_CONCURRENT/.test(delta) &&
  (delta.match(/const proven = through >= coveredAnchor;/g) || []).length >= 2);

const start = tune.indexOf('accountTxWindowDepth = async function');
const legacy = tune.indexOf('var rows = [], marker = null', start);
const refusal = tune.indexOf('EVIDENCE_WALLET_NOT_PROVEN', start);
ok('report path refuses before legacy walker', start >= 0 && refusal > start && legacy > refusal,
  'refusal=' + refusal + ' legacy=' + legacy);

ok('legacy browser history request increments runtime counter',
  /SW_HISTORY_ACCOUNT_TX_COUNT.*\+ 1/.test(tune) &&
  /SW_HISTORY_ACCOUNT_TX_WALLETS\[account\]/.test(tune));
ok('each evidence run resets historical-call counter',
  /SW_HISTORY_ACCOUNT_TX_COUNT = 0/.test(bridge) &&
  /SW_HISTORY_ACCOUNT_TX_WALLETS = Object\.create\(null\)/.test(bridge));
ok('runtime finish hard-fails if historical counter is nonzero',
  /HISTORICAL_ACCOUNT_TX_GATE_FAILED/.test(bridge) &&
  /if \(historicalCalls > 0\)/.test(bridge));
ok('successful runtime finish exports zero-call proof',
  /historical_watched_account_tx_calls: historicalCalls/.test(bridge) &&
  /database_first_runtime_gate: 'PASS'/.test(bridge));

if (bad) process.exit(1);
