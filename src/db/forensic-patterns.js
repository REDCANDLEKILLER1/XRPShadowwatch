'use strict';
// Read-only derived evidence. Never equate automation, repeated orders, or
// opposing balance changes alone with manipulation or common ownership.
const ASSETS = Object.freeze([{symbol:'RLUSD',currency:'524C555344000000000000000000000000000000',
 issuer:'rMxCKbEDwqr76QuheSUMdEGf4B9xJ8m5De',verified_at:'2026-10-09',
 source:'https://docs.ripple.com/products/stablecoin/overview/token-addresses'}]);
const SCHEMA='shadowwatch-forensics/1';
// Exact fixed-point arithmetic for ledger values, including scientific IOUs.
function decimal(value){
 if(typeof value!=='string'||value.length>300)throw Error('FORENSIC_AMOUNT_INVALID');
 const m=value.match(/^(-?)(\d+)(?:\.(\d+))?(?:[eE]([+-]?\d+))?$/);
 if(!m)throw Error('FORENSIC_AMOUNT_INVALID');
 const scale=(m[3]||'').length-Number(m[4]||0);
 if(!Number.isSafeInteger(scale)||Math.abs(scale)>200)throw Error('FORENSIC_AMOUNT_RANGE');
 let n=BigInt((m[1]||'')+m[2]+(m[3]||'')),s=scale;
 if(s<0){n*=10n**BigInt(-s);s=0;}return{n,s};
}
function format({n,s}){const sign=n<0n?'-':'';let t=(n<0n?-n:n).toString().padStart(s+1,'0');
 if(s)t=(t.slice(0,-s)+'.'+t.slice(-s)).replace(/0+$/,'').replace(/\.$/,'');return n===0n?'0':sign+t;}
function add(a,b){const x=decimal(a),y=decimal(b),s=Math.max(x.s,y.s);return format({n:x.n*10n**BigInt(s-x.s)+y.n*10n**BigInt(s-y.s),s});}
const neg=a=>format({...decimal(a),n:-decimal(a).n});
const sub=(a,b)=>add(a,neg(b));
const sign=a=>decimal(a).n<0n?-1:decimal(a).n>0n?1:0;
const abs=a=>sign(a)<0?neg(a):format(decimal(a));
const xrp=drops=>format({n:decimal(drops).n,s:6});
function amount(a){
 if(typeof a==='string'&&/^\d+$/.test(a))return{currency:'XRP',issuer:null,value:xrp(a)};
 if(a&&typeof a.currency==='string'&&typeof a.issuer==='string')return{currency:a.currency,issuer:a.issuer,value:format(decimal(a.value))};
 throw Error('FORENSIC_ASSET_INVALID');
}
const assetKey=a=>a.currency+':'+(a.issuer||'');
function pair(gets,pays,assets){
 if(gets===undefined||pays===undefined)return null;
 const g=amount(gets),p=amount(pays),stable=g.currency==='XRP'?p:p.currency==='XRP'?g:null;
 const asset=stable&&assets.find(a=>assetKey(a)===assetKey(stable));
 if(!asset||sign(g.value)<=0||sign(p.value)<=0)return null;
 return{asset,side:g.currency==='XRP'?'SELL_XRP':'BUY_XRP',xrp:(g.currency==='XRP'?g:p).value,stable:stable.value};
}
function priceFraction(stable,native){const a=decimal(stable),b=decimal(native);let n=a.n*10n**BigInt(b.s),d=b.n*10n**BigInt(a.s);
 if(n<=0n||d<=0n)throw Error('FORENSIC_PRICE_INVALID');let x=n,y=d;while(y){const t=x%y;x=y;y=t;}return(n/x)+'/'+(d/x);}
function balances(tx,meta){
 const accounts=new Map();
 const put=(account,currency,issuer,value)=>{if(!account)throw Error('FORENSIC_BALANCE_ACCOUNT_MISSING');
  if(!accounts.has(account))accounts.set(account,new Map());const m=accounts.get(account),key=assetKey({currency,issuer});
  m.set(key,{currency,issuer,value:add(m.get(key)?.value||'0',value)});};
 for(const wrapper of meta.AffectedNodes){
  const kind=wrapper.CreatedNode?'created':wrapper.DeletedNode?'deleted':'modified';
  const node=wrapper.CreatedNode||wrapper.DeletedNode||wrapper.ModifiedNode;if(!node)continue;
  const f=node.NewFields||node.FinalFields||{},p=node.PreviousFields||{};
  if(node.LedgerEntryType==='AccountRoot'){
   if(kind!=='created'&&p.Balance===undefined)continue;
   const before=kind==='created'?'0':p.Balance,after=kind==='deleted'?'0':f.Balance;
   if(!/^\d+$/.test(before)||!/^\d+$/.test(after))throw Error('FORENSIC_XRP_BALANCE_INVALID');
   put(f.Account,'XRP',null,xrp(sub(after,before)));
  }else if(node.LedgerEntryType==='RippleState'){
   if(kind!=='created'&&p.Balance===undefined)continue;
   const before=kind==='created'?'0':p.Balance.value,after=kind==='deleted'?'0':f.Balance.value;
   const delta=sub(after,before),low=f.LowLimit?.issuer,high=f.HighLimit?.issuer,currency=f.Balance?.currency;
   if(!currency||!low||!high)throw Error('FORENSIC_TRUSTLINE_INVALID');
   put(low,currency,high,delta);put(high,currency,low,neg(delta));
  }
 }
 // Subtract the submitter's known fee from expenditure, not from trade proceeds.
 const payer=accounts.get(tx.Account)?.get('XRP:');
 if(payer){if(typeof tx.Fee!=='string'||!/^\d+$/.test(tx.Fee))throw Error('FORENSIC_FEE_MISSING');payer.value=add(payer.value,xrp(tx.Fee));}
 return accounts;
}
function inspect(event,payload,assets=ASSETS){
 const out={schema:SCHEMA,hash:event.hash,ledger_index:event.ledger_index,transaction_index:event.transaction_index,
  close_time:event.close_time,tx_type:event.tx_type,status:'UNANALYZED',exchanges:[],orders:[],payments:[],limitations:[]};
 if(event.validated!==true||event.tx_result!=='tesSUCCESS'){out.status='NOT_SUCCESSFUL_VALIDATED';return out;}
 const tx=payload?.raw_tx,meta=payload?.raw_meta;
 if(!tx||!meta||!Array.isArray(meta.AffectedNodes)){out.status='MISSING_RAW_METADATA';return out;}
 if(payload.hash!==event.hash||(tx.hash&&tx.hash!==event.hash)||tx.TransactionType!==event.tx_type||
    tx.Account!==event.from_account||meta.TransactionResult!==event.tx_result||meta.TransactionIndex!==event.transaction_index){out.status='PAYLOAD_EVENT_MISMATCH';return out;}
 try{
  const makerPairs=new Map(),nodes=meta.AffectedNodes;
  for(const w of nodes){const n=w.ModifiedNode||w.DeletedNode;if(!n||n.LedgerEntryType!=='Offer')continue;
   const f=n.FinalFields||{},p=n.PreviousFields||{};
   // Deletion without both amount deltas can be cancellation/expiry/unfunding.
   if(p.TakerGets===undefined||p.TakerPays===undefined)continue;
   const old=pair(p.TakerGets,p.TakerPays,assets);if(!old)continue;
   const g=amount(f.TakerGets),pa=amount(f.TakerPays),og=amount(p.TakerGets),op=amount(p.TakerPays);
   if(assetKey(g)!==assetKey(og)||assetKey(pa)!==assetKey(op))throw Error('FORENSIC_OFFER_ASSET_CHANGED');
   if(sign(sub(og.value,g.value))>0&&sign(sub(op.value,pa.value))>0){
    if(!makerPairs.has(f.Account))makerPairs.set(f.Account,new Set());makerPairs.get(f.Account).add(assetKey(old.asset));
   }
  }
  const proposed=tx.TransactionType==='OfferCreate'?pair(tx.TakerGets,tx.TakerPays,assets):null;
  if(tx.TransactionType==='OfferCreate'||tx.TransactionType==='OfferCancel'){
   const removed=nodes.filter(w=>w.DeletedNode?.LedgerEntryType==='Offer'&&w.DeletedNode.FinalFields?.Account===tx.Account&&
    w.DeletedNode.FinalFields?.Sequence===tx.OfferSequence).length;
   out.orders.push({account:tx.Account,kind:tx.TransactionType,sequence:tx.Sequence??null,
    cancel_sequence:tx.OfferSequence??null,cancel_confirmed:tx.OfferSequence!==undefined&&removed>0,
    replacement_requested:tx.TransactionType==='OfferCreate'&&tx.OfferSequence!==undefined,
    stored_offer_created:nodes.some(w=>w.CreatedNode?.LedgerEntryType==='Offer'&&w.CreatedNode.NewFields?.Account===tx.Account),
    pair:proposed,limit_price_fraction:proposed?priceFraction(proposed.stable,proposed.xrp):null});
  }
  const changes=balances(tx,meta);
  for(const [account,all] of changes){
   const legs=[...all.values()].filter(v=>sign(v.value)!==0),native=legs.find(v=>v.currency==='XRP');
   if(!native||legs.length!==2)continue;
   const token=legs.find(v=>v.currency!=='XRP'),asset=token&&assets.find(a=>assetKey(a)===assetKey(token));
   if(!asset||sign(native.value)===sign(token.value))continue;
   let basis=null;
   if(account===tx.Account&&proposed&&assetKey(proposed.asset)===assetKey(asset))basis='OFFERCREATE_OWNER';
   else if(account===tx.Account&&tx.TransactionType==='Payment'&&tx.Destination===account&&
    pair(tx.SendMax,meta.delivered_amount,assets))basis='SELF_PAYMENT';
   else if(makerPairs.get(account)?.has(assetKey(asset)))basis='CONSUMED_OFFER_OWNER';
   if(!basis)continue;
   out.exchanges.push({account,kind:'EXECUTED_NET_EXCHANGE',basis,side:sign(native.value)<0?'SELL_XRP':'BUY_XRP',
    currency:asset.currency,issuer:asset.issuer,symbol:asset.symbol,xrp:abs(native.value),stable:abs(token.value),
    effective_price_fraction:priceFraction(abs(token.value),abs(native.value)),
    // Convenience only; exact values and rational price above are the evidence.
    effective_price_approx:Number(abs(token.value))/Number(abs(native.value))});
  }
  if(tx.TransactionType==='Payment'&&tx.Destination){
   const delivered=meta.delivered_amount;
   if(delivered!==undefined&&delivered!=='unavailable')out.payments.push({from:tx.Account,to:tx.Destination,
    destination_tag:tx.DestinationTag??null,source_tag:tx.SourceTag??null,delivered:amount(delivered),
    cross_currency_requested:!!tx.SendMax&&assetKey(amount(tx.SendMax))!==assetKey(amount(delivered))});
   else out.limitations.push('DELIVERED_AMOUNT_UNAVAILABLE');
  }
  out.status='ANALYZED';
 }catch(e){out.status='UNSUPPORTED_METADATA';out.exchanges=[];out.orders=[];out.payments=[];out.limitations.push(e.message);}
 return out;
}
function summarize(records){
 const wallets=new Map(),routes=new Map(),statuses={},flags=[];
 function wallet(a){if(!wallets.has(a))wallets.set(a,{account:a,exchanges:[],orders:[],xrp_received:'0',xrp_sent:'0',stable_totals:{}});return wallets.get(a);}
 for(const r of records){statuses[r.status]=(statuses[r.status]||0)+1;
  const ref={hash:r.hash,ledger_index:r.ledger_index,transaction_index:r.transaction_index,close_time:r.close_time};
  for(const t of r.exchanges){const w=wallet(t.account);w.exchanges.push({...ref,...t});const k=t.currency+':'+t.issuer;
   const total=w.stable_totals[k]||(w.stable_totals[k]={symbol:t.symbol,buy_xrp:'0',sell_xrp:'0',stable_spent:'0',stable_received:'0',legs:0});
   const sell=t.side==='SELL_XRP';total[sell?'sell_xrp':'buy_xrp']=add(total[sell?'sell_xrp':'buy_xrp'],t.xrp);
   total[sell?'stable_received':'stable_spent']=add(total[sell?'stable_received':'stable_spent'],t.stable);total.legs++;
  }
  for(const o of r.orders)wallet(o.account).orders.push({...ref,...o});
  for(const p of r.payments){if(p.delivered.currency!=='XRP'||p.from===p.to||p.cross_currency_requested)continue;
   const a=wallet(p.from),b=wallet(p.to);a.xrp_sent=add(a.xrp_sent,p.delivered.value);b.xrp_received=add(b.xrp_received,p.delivered.value);
   const k=JSON.stringify([p.from,p.to,p.destination_tag]);if(!routes.has(k))routes.set(k,[]);routes.get(k).push({...ref,...p});
  }
 }
 for(const w of wallets.values()){
  const repeated=new Map();for(const o of w.orders){if(!o.pair)continue;const k=[o.pair.side,assetKey(o.pair.asset),o.limit_price_fraction].join(':');if(!repeated.has(k))repeated.set(k,[]);repeated.get(k).push(o.hash);}
  for(const [price_key,hashes] of repeated)if(hashes.length>=3)flags.push({kind:'REPEATED_LIMIT_PRICE',account:w.account,price_key,count:hashes.length,hashes});
  const churn=w.orders.filter(o=>o.cancel_confirmed);if(churn.length>=5)flags.push({kind:'REPEATED_CONFIRMED_CANCEL',account:w.account,count:churn.length,hashes:churn.map(o=>o.hash)});
 }
 for(const list of routes.values()){
  list.sort((a,b)=>a.ledger_index-b.ledger_index||(a.transaction_index??Infinity)-(b.transaction_index??Infinity));
  if(list.length<6)continue;const gaps=list.slice(1).map((r,i)=>(Date.parse(r.close_time)-Date.parse(list[i].close_time))/1000);
  const mid=gaps.slice().sort((a,b)=>a-b)[Math.floor(gaps.length/2)];
  if(mid>=10&&gaps.every(g=>Math.abs(g-mid)<=Math.max(2,mid*0.02)))flags.push({kind:'REGULAR_TRANSFER_INTERVAL',account:list[0].from,to:list[0].to,
   destination_tag:list[0].destination_tag,interval_seconds:mid,count:list.length,hashes:list.map(r=>r.hash)});
 }
 return{schema:SCHEMA,statuses,wallets:[...wallets.values()].sort((a,b)=>a.account.localeCompare(b.account)),flags,
  interpretation:'Pattern flags are investigation leads, not proof of bot control, manipulation, identity, or common ownership. Exchange totals count wallet legs, not market volume.',
  rules:{repeated_price_min_orders:3,cancel_min:5,regular_transfer_min:6,interval_tolerance:'max(2 seconds, 2%)'}};
}
module.exports={SCHEMA,ASSETS,add,sub,abs,sign,amount,assetKey,priceFraction,inspect,summarize};
