'use strict';
// Liquidity executions, counted once per Offer or AMM node in a validated tx.
// These are NOT opposing wallet flows, unique economic trades, or whole-market volume.
const F=require('./forensic-patterns');
const ASSET=F.ASSETS[0],AMM_FLAG=0x01000000;
const isStable=a=>a&&a.currency===ASSET.currency&&a.issuer===ASSET.issuer;
function pair(gets,pays){
 const g=F.amount(gets),p=F.amount(pays);
 if(g.currency==='XRP'&&isStable(p))return{side:'SELL_XRP',xrp:g.value,rlusd:p.value};
 if(p.currency==='XRP'&&isStable(g))return{side:'BUY_XRP',xrp:p.value,rlusd:g.value};
 return null;
}
function classify(item){
 const tx=item.tx_json||item.tx||item,meta=item.meta||item.metaData,hash=item.hash||tx.hash;
 const out={hash,status:'NO_MATCH',fills:[],limitations:[],liquidity_events:0};
 if(item.validated!==true||meta?.TransactionResult!=='tesSUCCESS'){out.status='NOT_SUCCESSFUL_VALIDATED';return out;}
 if(!/^[A-Fa-f0-9]{64}$/.test(hash)||!Array.isArray(meta.AffectedNodes)){out.status='UNSUPPORTED';return out;}
 if(/^AMM/.test(tx.TransactionType)){out.status='LIQUIDITY_OPERATION';out.liquidity_events=1;return out;}
 if(!['OfferCreate','Payment'].includes(tx.TransactionType))return out;
 try{
  const nodes=meta.AffectedNodes,seen=new Set(),pools=new Set();
  let candidate=[tx.TakerGets,tx.TakerPays,tx.Amount,tx.SendMax,tx.DeliverMin].some(isStable);
  const fill=(id,value)=>{
   if(!/^[A-Fa-f0-9]{64}$/.test(id)||seen.has(id.toUpperCase())||!/^r[1-9A-HJ-NP-Za-km-z]{24,34}$/.test(value.account))throw Error('EXECUTION_NODE_INVALID');seen.add(id.toUpperCase());
   if(F.sign(value.xrp)<=0||F.sign(value.rlusd)<=0)throw Error('EXECUTION_AMOUNT_INVALID');
   out.fills.push({id:hash+':'+id,...value,price_fraction:F.priceFraction(value.rlusd,value.xrp)});
  };
  for(const w of nodes){
   const n=w.ModifiedNode||w.DeletedNode||w.CreatedNode;if(!n)continue;
   const f=n.FinalFields||n.NewFields||{},p=n.PreviousFields||{};
   if(n.LedgerEntryType==='RippleState'&&f.Balance?.currency===ASSET.currency&&
     [f.LowLimit?.issuer,f.HighLimit?.issuer].includes(ASSET.issuer)){
    candidate=true;
    if((Number(f.Flags)&AMM_FLAG)!==0)pools.add(f.LowLimit.issuer===ASSET.issuer?f.HighLimit.issuer:f.LowLimit.issuer);
   }
   if(n.LedgerEntryType!=='Offer'||w.CreatedNode)continue;
   if(!isStable(p.TakerGets)&&!isStable(p.TakerPays)&&!isStable(f.TakerGets)&&!isStable(f.TakerPays))continue;
   candidate=true;
   // Deletion alone is NOT execution: cancellations, expired and unfunded offers occur here too.
   if(p.TakerGets===undefined||p.TakerPays===undefined){out.limitations.push('OFFER_DELETION_WITHOUT_EXECUTION_DELTAS');continue;}
   const before=pair(p.TakerGets,p.TakerPays),after=pair(f.TakerGets,f.TakerPays);
   if(!before||!after||before.side!==after.side)throw Error('EXECUTION_PAIR_CHANGED');
   const xrp=F.sub(before.xrp,after.xrp),rlusd=F.sub(before.rlusd,after.rlusd);
   if(F.sign(xrp)===0&&F.sign(rlusd)===0)continue;
   fill(n.LedgerIndex,{venue:'ORDER_BOOK',account:f.Account,side:before.side,xrp,rlusd,
    completion:w.ModifiedNode?'PARTIAL':F.sign(after.xrp)===0&&F.sign(after.rlusd)===0?'FULL':'PARTIAL_REMOVED'});
  }
  const changes=F.balances(tx,meta);
  for(const account of pools){
   const n=nodes.map(w=>w.ModifiedNode).find(n=>n?.LedgerEntryType==='AccountRoot'&&n.FinalFields?.Account===account&&/^[A-Fa-f0-9]{64}$/.test(n.FinalFields.AMMID));
   const legs=[...(changes.get(account)?.values()||[])].filter(x=>F.sign(x.value)!==0);
   const x=legs.find(x=>x.currency==='XRP'),s=legs.find(isStable);
   if(!n||legs.length!==2||!x||!s||F.sign(x.value)===F.sign(s.value)){out.limitations.push('AMM_BALANCES_UNRECONCILED');continue;}
   fill(n.LedgerIndex,{venue:'AMM',account,side:F.sign(x.value)<0?'SELL_XRP':'BUY_XRP',
    xrp:F.abs(x.value),rlusd:F.abs(s.value),completion:'POOL_NET_SWAP',amount_basis:'NET_POOL_BALANCE_CHANGE_INCLUDES_FEES'});
  }
  out.status=out.fills.length?'VERIFIED_EXECUTIONS':candidate?'UNCLASSIFIED_CANDIDATE':'NO_MATCH';
 }catch(_){out.status='UNSUPPORTED';out.fills=[];out.limitations=['EXECUTION_METADATA_UNRECONCILED'];}
 return out;
}
function empty(){return{transactions:0,execution_transactions:0,order_book_fills:0,partial_fills:0,amm_swaps:0,
 liquidity_operations:0,unclassified_transactions:0,order_book_xrp:'0',order_book_rlusd:'0',amm_xrp:'0',amm_rlusd:'0'};}
function add(a,b){const out={};for(const k of Object.keys(empty()))out[k]=typeof a[k]==='string'?F.add(a[k],b[k]):a[k]+b[k];return out;}
function totals(records){const t=empty();for(const r of records){t.transactions++;
 if(r.fills.length)t.execution_transactions++;
 if(['UNSUPPORTED','UNCLASSIFIED_CANDIDATE'].includes(r.status)||r.limitations.length)t.unclassified_transactions++;
 t.liquidity_operations+=r.liquidity_events;
 for(const f of r.fills){const kind=f.venue==='AMM'?'amm':'order_book';t[kind==='amm'?'amm_swaps':'order_book_fills']++;
  if(f.completion.startsWith('PARTIAL'))t.partial_fills++;
  t[kind+'_xrp']=F.add(t[kind+'_xrp'],f.xrp);t[kind+'_rlusd']=F.add(t[kind+'_rlusd'],f.rlusd);}
 }return t;}
module.exports={classify,empty,add,totals};
