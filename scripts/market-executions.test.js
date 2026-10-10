'use strict';
const assert=require('assert/strict'),E=require('../src/db/market-executions'),F=require('../src/db/forensic-patterns'),{hash}=require('./fixtures/market-test-helpers');
const a='r9NpyVfLfUG8hatuCCHKzosyDtKnBdsEN3',pool='rMhkqz3DeU7GUUJKGZofusbrTwZe6bDyb1',issuer=F.ASSETS[0].issuer;
const stable=n=>({currency:F.ASSETS[0].currency,issuer,value:String(n)});
const tx=nodes=>({validated:true,hash:hash(1234),tx_json:{TransactionType:'OfferCreate',Account:a,Fee:'12'},
 meta:{TransactionIndex:0,TransactionResult:'tesSUCCESS',AffectedNodes:nodes}});
function offer(kind='ModifiedNode',gets='6000000',pays='9'){
 return{[kind]:{LedgerEntryType:'Offer',LedgerIndex:hash(5678),PreviousFields:{TakerGets:'10000000',TakerPays:stable(15)},
  FinalFields:{Account:a,TakerGets:gets,TakerPays:stable(pays)}}};
}
const partial=E.classify(tx([offer()]));assert.equal(partial.fills.length,1);assert.equal(partial.fills[0].xrp,'4');assert.equal(partial.fills[0].rlusd,'6');assert.equal(partial.fills[0].completion,'PARTIAL');
const full=E.classify(tx([offer('DeletedNode','0','0')]));assert.equal(full.fills[0].xrp,'10');assert.equal(full.fills[0].completion,'FULL');
const removed=E.classify(tx([offer('DeletedNode')]));assert.equal(removed.fills[0].xrp,'4');assert.equal(removed.fills[0].completion,'PARTIAL_REMOVED');
const unfunded=offer('DeletedNode');delete unfunded.DeletedNode.PreviousFields;
assert.equal(E.classify(tx([unfunded])).fills.length,0,'deleted offers are not automatically fills');
const canceled=tx([offer('DeletedNode')]);canceled.tx_json.TransactionType='OfferCancel';assert.equal(E.classify(canceled).fills.length,0);
const failed=tx([offer()]);failed.meta.TransactionResult='tecPATH_DRY';assert.equal(E.classify(failed).fills.length,0);
assert.equal(E.classify({...tx([offer()]),validated:false}).fills.length,0);
assert.equal(E.classify(tx([offer(),offer()])).status,'UNSUPPORTED','same offer cannot be double counted');
const wrong=offer();wrong.ModifiedNode.PreviousFields.TakerPays.issuer=a;assert.equal(E.classify(tx([wrong])).fills.length,0);
const increased=offer('ModifiedNode','11000000','16');assert.equal(E.classify(tx([increased])).fills.length,0);
function amm(){return[
 {ModifiedNode:{LedgerEntryType:'AccountRoot',LedgerIndex:hash(99),PreviousFields:{Balance:'100000000'},FinalFields:{Account:pool,AMMID:hash(88),Balance:'90000000'}}},
 {ModifiedNode:{LedgerEntryType:'RippleState',LedgerIndex:hash(98),PreviousFields:{Balance:{currency:F.ASSETS[0].currency,value:'150'}},
  FinalFields:{Flags:0x01000000,LowLimit:{issuer:pool},HighLimit:{issuer},Balance:{currency:F.ASSETS[0].currency,value:'165'}}}}
 ];}
const swap=E.classify(tx(amm()));assert.equal(swap.fills.length,1);assert.equal(swap.fills[0].venue,'AMM');assert.equal(swap.fills[0].xrp,'10');assert.equal(swap.fills[0].rlusd,'15');
const reversed=amm(),trust=reversed[1].ModifiedNode;
trust.FinalFields.LowLimit.issuer=issuer;trust.FinalFields.HighLimit.issuer=pool;trust.PreviousFields.Balance.value='-150';trust.FinalFields.Balance.value='-165';
assert.deepEqual(E.classify(tx(reversed)).fills,swap.fills,'low/high issuer orientation cannot change the pool result');
for(const type of ['AMMDeposit','AMMWithdraw','AMMCreate','AMMClawback']){const p=tx(amm());p.tx_json.TransactionType=type;assert.equal(E.classify(p).fills.length,0);}
const uncertain=amm();delete uncertain[0].ModifiedNode.FinalFields.AMMID;assert.equal(E.classify(tx(uncertain)).fills.length,0);
const routed=tx([offer(),...amm()]);routed.tx_json.TransactionType='Payment';routed.tx_json.Destination=pool;routed.tx_json.Amount=stable('999999');routed.meta.delivered_amount=stable('6');
const route=E.classify(routed);assert.equal(route.fills.length,2);assert.equal(E.totals([route]).order_book_xrp,'4');assert.equal(E.totals([route]).amm_xrp,'10');
assert(!JSON.stringify(route.fills).includes('999999'),'requested Payment Amount never determines an execution');
 const missing=tx([]);missing.tx_json.TransactionType='Payment';missing.tx_json.Amount=stable('99');
 assert.equal(E.classify(missing).status,'UNCLASSIFIED_CANDIDATE','incomplete pair metadata is unknown, not evidence of no activity');
const real=require('./fixtures/forensic-live-ledger-107530078.json');
const live=real.transactions.map(t=>E.classify({...t,validated:true}));
assert(live.every(r=>r.fills.length>0));assert.equal(E.totals(live).order_book_xrp,'904.120603','captured partial fills counted once, not twice for maker/taker');
assert.equal(E.totals(live).order_book_fills,2);
console.log('PASS captured fills counted once, partial/full/removed distinction, cancellation exclusion, issuer identity, AMM orientation, liquidity exclusions and routed/partial-payment metadata');
