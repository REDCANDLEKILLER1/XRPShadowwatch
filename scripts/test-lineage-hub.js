'use strict';
const hub = require('../api/lineage-hub.js');
const t = hub._test;
let pass=0,fail=0;
function check(name,cond,detail){if(cond){pass++;console.log('PASS',name)}else{fail++;console.log('FAIL',name,detail||'')}}

const meta={AffectedNodes:[{ModifiedNode:{LedgerEntryType:'AccountRoot',FinalFields:{Account:'rA',Balance:'900'},PreviousFields:{Balance:'1000'}}}]};
check('exact AccountRoot delta', t.accountBalanceDeltaDrops(meta,'rA')===-100n);
const item={ledger_index:123,tx:{Account:'rA',Destination:'rB',TransactionType:'Payment',Amount:'90',Fee:'10',hash:'ABC',date:1},meta:{TransactionResult:'tesSUCCESS',delivered_amount:'90',AffectedNodes:[{ModifiedNode:{LedgerEntryType:'AccountRoot',FinalFields:{Account:'rA',Balance:'900'},PreviousFields:{Balance:'1000'}}},{ModifiedNode:{LedgerEntryType:'AccountRoot',FinalFields:{Account:'rB',Balance:'590'},PreviousFields:{Balance:'500'}}}]}};
const e=t.normalizeEffect('rA',item);
check('effect preserves exact drops', e && e.balanceDeltaDrops==='-100' && e.feeDrops==='10' && e.outflowDrops==='90',e);
const f=t.directFlow('rA',item);
check('native payment flow', f && f.dest==='rB' && f.drops==='90' && f.classification==='NATIVE_PAYMENT',f);
const issued={ledger_index:124,tx:{Account:'rA',Destination:'rB',TransactionType:'Payment',Amount:{currency:'USD',value:'1',issuer:'rI'},Fee:'10'},meta:{TransactionResult:'tesSUCCESS',delivered_amount:{currency:'USD',value:'1',issuer:'rI'}}};
check('issued currency is not XRP flow', t.directFlow('rA',issued)===null);
check('delta path allowlist', !!t.sanitizeDeltaPath('data/genesis-lineage/deltas/2026-08/a.json'));
check('delta path traversal blocked', t.sanitizeDeltaPath('data/genesis-lineage/deltas/../manifest.json')===null);
check('client cannot advance beyond validated tip', t.canonicalTargetLedger(999999,123456)===123456);
check('client may request an older deterministic tip', t.canonicalTargetLedger(120000,123456)===120000);
console.log(`lineage hub tests ${pass}/${pass+fail}`);
process.exitCode=fail?1:0;
