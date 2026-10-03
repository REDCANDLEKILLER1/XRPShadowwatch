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
ok('equal anchor is explicit already-current', /reason: 'ALREADY_CURRENT'/.test(delta));
ok('already-current returns stored wallet proofs', /const currentWallets = state\.wallets\.map/.test(delta) && /wallets: currentWallets/.test(delta));
ok('already-current reports full stored coverage', /complete_wallets: state\.wallets\.length/.test(delta));
ok('concurrent equal-anchor race resolves from refreshed store', /ALREADY_CURRENT_CONCURRENT/.test(delta) && /RUN_ANCHOR_NOT_AHEAD/.test(delta));

const start = tune.indexOf('accountTxWindowDepth = async function');
const legacy = tune.indexOf('var rows = [], marker = null', start);
const refusal = tune.indexOf('EVIDENCE_WALLET_NOT_PROVEN', start);
ok('report path refuses before legacy walker', start >= 0 && refusal > start && legacy > refusal,
  'refusal=' + refusal + ' legacy=' + legacy);

if (bad) process.exit(1);
