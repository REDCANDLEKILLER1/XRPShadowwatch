const fs = require('fs');
const assert = require('assert');

const hotfix = fs.readFileSync('src/brief/36-operational-morning-hotfix.js', 'utf8');
const loader = fs.readFileSync('src/brief/14-identity-lookup.js', 'utf8');

assert.match(hotfix, /COLD_LOOKBACK_H = 72/);
assert.match(hotfix, /ACCOUNT_TX_LIMIT = 400/);
assert.match(hotfix, /ledger_index_max: anchor/);
assert.match(hotfix, /state\.indexRun = null/);
assert.match(hotfix, /full_window_complete === true/);
assert.match(hotfix, /checkpoint NOT advanced/);
assert.match(hotfix, /source: 'XRPL_DIRECT_OPERATIONAL'/);
const codeOnly = hotfix.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
assert.doesNotMatch(codeOnly, /\bsubmit\b|\bsigning\b|\bseed\b|\bsecret\b|OfferCreate|PaymentChannelClaim|EscrowFinish\s*\(/i);
assert.match(loader, /36-operational-morning-hotfix\.js/);
assert(loader.indexOf('36-operational-morning-hotfix.js') < loader.indexOf("tx.onload = loadOperationalMorningHotfix"));
console.log('operational morning hotfix gate: PASS');
