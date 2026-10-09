'use strict';
const fs=require('fs'),path=require('path'),zlib=require('zlib');
const R=require('./r2-master-backup'),F=require('../src/db/forensic-patterns'),{csv}=require('./forensic-export');
// Observational comparisons. Gaps between book snapshots cannot distinguish
// replenishment from entry into the visible top-N, fills, or cancellation.
function timeline(samples){
 const ordered=samples.slice().sort((a,b)=>a.sample.observed_at.localeCompare(b.sample.observed_at));
 const rows=[['observed_at','ledger_index','ticker_time','xrp_usd','bid_usd','ask_usd','pivot_band','source_key']],changes=[],legs=[];
 let previous=null;const seen=new Set();let repeatedLedgers=0;
 for(const {key,sample:s} of ordered){
  const price=s.ticker?Number(s.ticker.price):null,band=price===null?'UNKNOWN':Math.abs(price-1.41)<=0.0100000001?'NEAR_1_41':'OTHER_PRICE';
  rows.push([s.observed_at,s.scope.ledger_index,s.ticker?.time,s.ticker?.price,s.ticker?.bid,s.ticker?.ask,band,key]);
  if(seen.has(s.scope.ledger_hash)){repeatedLedgers++;continue;}seen.add(s.scope.ledger_hash);
  for(const fact of s.facts||[])for(const leg of fact.exchanges||[])legs.push({source_key:key,hash:fact.hash,ledger_index:fact.ledger_index,
   close_time:fact.close_time,...leg,ticker_time:s.ticker?.time||null,ticker_price_usd:s.ticker?.price||null,pivot_band:band,
   relation:'Same snapshot; no causal attribution'});
  const quotes=new Map();
  for(const [side,book] of Object.entries(s.books||{}))for(const offer of book.offers){
   try{const g=F.amount(offer.TakerGets),p=F.amount(offer.TakerPays),native=g.currency==='XRP'?g:p,stable=g.currency==='XRP'?p:g;
    if(native.currency!=='XRP'||!F.ASSETS.some(a=>F.assetKey(a)===F.assetKey(stable)))continue;
    const fraction=F.priceFraction(stable.value,native.value),k=JSON.stringify([offer.Account,side,F.assetKey(stable),fraction]);
    const old=quotes.get(k);quotes.set(k,{account:offer.Account,side,price_fraction:fraction,xrp:F.add(old?.xrp||'0',native.value)});
   }catch(_){/* Unknown asset/amount stays in the raw source, never a numeric zero. */}
  }
  const gap=previous?(Date.parse(s.observed_at)-Date.parse(previous.at))/1000:null;
  // Compare only adjacent observations <=30 minutes apart. Missing books reset
  // the comparison rather than treating absent quotes as zero-size liquidity.
  if(previous&&gap>0&&gap<=1800)for(const [k,q] of quotes){const before=previous.quotes.get(k);
   if(before&&F.sign(F.sub(q.xrp,before.xrp))>0)changes.push({kind:'VISIBLE_QUOTED_SIZE_INCREASE',...q,previous_xrp:before.xrp,
    increase_xrp:F.sub(q.xrp,before.xrp),before_key:previous.key,after_key:key,gap_seconds:gap,
    interpretation:'Visible nominal size increased. Partial funding and changing top-N visibility prevent a refill or manipulation verdict.'});
  }
  previous={at:s.observed_at,key,quotes};
 }
 return{schema:'shadowwatch-market-history/1',sample_count:ordered.length,unique_ledgers:seen.size,repeated_ledgers:repeatedLedgers,
  price_rows:rows,exchange_legs:legs,visible_size_increases:changes,
  conclusions:{bot_control:'UNTESTED',price_control:'UNTESTED',wallet_ownership:'UNATTRIBUTED'},
  limitations:['Discontinuous samples, not a complete tape','Coinbase USD price and XRPL RLUSD quotes are distinct markets',
   'Compare control prices and independent periods before drawing statistical conclusions','Wallet exchange legs are not additive global volume']};
}
async function appendMarket(out,s3,now=Date.now()){
 const before=await R.inventory(s3),cutoff=new Date(now-30*86400000).toISOString().slice(0,10),recent=new Date(now-86400000).toISOString().slice(0,10);
 const selected=[...before.objects].filter(([key])=>/^market\/\d{4}\/\d{2}\/\d{2}\/.+-[a-f0-9]{64}\.json\.gz$/.test(key)&&key.slice(7,17).replace(/\//g,'-')>=cutoff).sort();
 if(selected.length>10000||selected.reduce((n,[,bytes])=>n+bytes,0)>1024*1024*1024)throw Error('MARKET_HISTORY_LIMIT');
 const samples=[],sources=[];
 for(const [key,size] of selected){
  if(size>2*1024*1024)throw Error('MARKET_HISTORY_OBJECT_LIMIT');
  const sha=key.match(/-([a-f0-9]{64})\.json\.gz$/)[1],body=await R.download(s3,key,size,sha);
  const sample=JSON.parse(zlib.gunzipSync(body,{maxOutputLength:32*1024*1024}).toString('utf8'));
  if(sample.schema!=='shadowwatch-market-sample/1'||!sample.scope?.ledger_hash||!Number.isFinite(Date.parse(sample.observed_at)))throw Error('MARKET_HISTORY_SCHEMA');
  sources.push({key,sha256:sha,bytes:size,observed_at:sample.observed_at,ledger_hash:sample.scope.ledger_hash,errors:sample.errors});
  if(sample.observed_at.slice(0,10)>=recent){const target=path.join(out,'market/samples',key.slice(7));fs.mkdirSync(path.dirname(target),{recursive:true});fs.writeFileSync(target,body,{flag:'wx'});}
  // Keep only fields needed for comparisons, not the much larger raw ledger.
  const books=Object.fromEntries(Object.entries(sample.books||{}).map(([side,book])=>[side,{offers:book.offers.map(o=>({Account:o.Account,TakerGets:o.TakerGets,TakerPays:o.TakerPays}))}]));
  samples.push({key,sample:{observed_at:sample.observed_at,scope:sample.scope,ticker:sample.ticker,books,
   facts:sample.facts.filter(f=>f.exchanges?.length)}});
 }
 const result=timeline(samples);fs.mkdirSync(path.join(out,'market'),{recursive:true});
 fs.writeFileSync(path.join(out,'market/observed-prices.csv'),csv(result.price_rows),{flag:'wx'});delete result.price_rows;
 fs.writeFileSync(path.join(out,'market/history.json'),JSON.stringify({...result,sources},null,2)+'\n',{flag:'wx'});
 return{samples:samples.length,visible_size_increases:result.visible_size_increases.length};
}
module.exports={timeline,appendMarket};
