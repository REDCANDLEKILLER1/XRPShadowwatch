#!/usr/bin/env node
'use strict';
// Bounded public reads only: one validated ledger + two public RLUSD books +
// Coinbase XRP-USD ticker. No wallet credentials, signing, or submit method.
const zlib=require('zlib');
const {PutObjectCommand}=require('@aws-sdk/client-s3');
const R=require('./r2-master-backup'),B=require('../src/db/master-backup'),F=require('../src/db/forensic-patterns');
const T=require('../src/db/transactions'),X=require('../src/db/evidence-export');
const RPC='https://s1.ripple.com:51234/',TICKER='https://api.exchange.coinbase.com/products/XRP-USD/ticker';
const MAX_RESPONSE=16*1024*1024,MAX_SAMPLE=2*1024*1024,DAILY_LIMIT=32*1024*1024;
async function request(url,options={},fetcher=fetch){
 const response=await fetcher(url,{...options,redirect:'error',signal:AbortSignal.timeout(20000)});
 if(!response.ok)throw Error('HTTP_'+response.status);
 const parts=[];let size=0;for await(const b of response.body){size+=b.length;if(size>MAX_RESPONSE)throw Error('MARKET_RESPONSE_LIMIT');parts.push(b);}
 return JSON.parse(Buffer.concat(parts).toString('utf8'));
}
async function rpc(method,params,fetcher){
 if(!['ledger','book_offers'].includes(method))throw Error('MARKET_READ_METHOD_ONLY');
 const r=await request(RPC,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({method,params:[{api_version:2,...params}]})},fetcher);
 if(r.error||r.result?.error||!r.result)throw Error('XRPL_READ_FAILED:'+String(r.result?.error||r.error||'NO_RESULT').replace(/[^A-Za-z0-9_]/g,''));return r.result;
}
async function collect({fetcher=fetch,clock=Date.now}={}){
 const started=clock(),errors=[];
 const ledger=await rpc('ledger',{ledger_index:'validated',transactions:true,expand:true},fetcher),l=ledger.ledger;
 const hash=ledger.ledger_hash||l?.ledger_hash,index=Number(ledger.ledger_index||l?.ledger_index);
 if(ledger.validated!==true||!l||!Number.isSafeInteger(index)||!/^[A-Fa-f0-9]{64}$/.test(hash)||!Array.isArray(l.transactions))throw Error('MARKET_LEDGER_UNPROVEN');
 const close=new Date((Number(l.close_time)+946684800)*1000).toISOString();
 if(clock()-Date.parse(close)>120000||Date.parse(close)>clock()+10000)throw Error('MARKET_LEDGER_STALE');
 const stable={currency:F.ASSETS[0].currency,issuer:F.ASSETS[0].issuer},native={currency:'XRP'};
 const results=await Promise.allSettled([
  rpc('book_offers',{ledger_hash:hash,taker_gets:native,taker_pays:stable,limit:200},fetcher),
  rpc('book_offers',{ledger_hash:hash,taker_gets:stable,taker_pays:native,limit:200},fetcher),
  request(TICKER,{},fetcher)]);
 const books={};let ticker=null;
 for(let i=0;i<2;i++){const side=i===0?'asks':'bids',r=results[i];
  if(r.status!=='fulfilled'){errors.push(side+':'+r.reason.message);continue;}
  // book_offers may omit `validated`. Its exact hash/index must instead match
  // the separately validated ledger above. Explicit false is always refused.
  const v=r.value;if(v.validated===false||v.ledger_hash!==hash||Number(v.ledger_index)!==index||!Array.isArray(v.offers)||v.offers.length>200){errors.push(side+':UNPROVEN_BOOK');continue;}
  books[side]={ledger_hash:hash,verification:'MATCHES_SEPARATELY_VALIDATED_LEDGER',limit:200,complete_book:false,offers:v.offers};
 }
 const t=results[2];if(t.status==='fulfilled'){
  const v=t.value,age=clock()-Date.parse(v.time);
  if(['price','bid','ask'].every(k=>typeof v[k]==='string'&&Number.isFinite(Number(v[k]))&&Number(v[k])>0)&&Number(v.bid)<=Number(v.ask)&&Number.isFinite(age)&&age>=-10000&&age<=120000)
   ticker={venue:'Coinbase Exchange',pair:'XRP-USD',url:TICKER,observed_at:new Date(clock()).toISOString(),...v};
  else errors.push('ticker:INVALID_OR_STALE');
 }else errors.push('ticker:'+t.reason.message);
 const facts=[],seen=new Set();
 for(const item of l.transactions){
  const tx=item.tx_json||item.tx||item,meta=item.meta||item.metaData;
  const txHash=item.hash||tx.hash;
  if(!/^[A-Fa-f0-9]{64}$/.test(txHash)||seen.has(txHash)||!meta||!Number.isInteger(meta.TransactionIndex))throw Error('MARKET_TX_INVALID');seen.add(txHash);
  // Raw response is saved verbatim below. Add the ledger timestamp only to the normalized view.
  const row=T.rowFromAccountTx({tx_json:{...tx,date:l.close_time},meta,hash:txHash,ledger_index:index,validated:true});
  const event=X.eventOf({...row,close_time:close});facts.push(F.inspect(event,X.payloadOf(row)));
 }
 return{schema:'shadowwatch-market-sample/1',started_at:new Date(started).toISOString(),observed_at:new Date(clock()).toISOString(),
  scope:{network:'XRPL mainnet',ledger_index:index,ledger_hash:hash,close_time:close,continuous:false,history_complete:false,
   book_limit_per_side:200,cex_scope:'One venue; no exchange customer identities or derivatives positions',
   cadence:'Scheduled snapshots; no claim about events between samples'},
  sources:{xrpl:RPC,ticker:TICKER},assets:F.ASSETS,errors,ledger,books,ticker,facts,
  hypothesis:{pivot_usd:1.41,band_usd:0.01,status:'UNTESTED',note:'Collect all sampled prices, including outside the proposed band. RLUSD is not assumed to equal USD.'}};
}
async function publish(sample,s3){
 const body=zlib.gzipSync(JSON.stringify(sample)+'\n');if(body.length>MAX_SAMPLE)throw Error('MARKET_SAMPLE_SIZE_STOP');
 const day=sample.observed_at.slice(0,10).replace(/-/g,'/'),prefix='market/'+day+'/';
 const key=prefix+sample.observed_at.replace(/[:.]/g,'-')+'-'+B.sha256(body)+'.json.gz';
 const before=await R.inventory(s3),dayBytes=[...before.objects].filter(([k])=>k.startsWith(prefix)).reduce((n,[,size])=>n+size,0);
 if(before.total+body.length>R.LIMIT||dayBytes+body.length>DAILY_LIMIT)throw Error('MARKET_CAPACITY_STOP');
 await s3.send(new PutObjectCommand({Bucket:R.BUCKET,Key:key,Body:body,IfNoneMatch:'*',ContentType:'application/gzip'}));
 await R.download(s3,key,body.length,B.sha256(body));
 return{key,sha256:B.sha256(body),bytes:body.length,ledger_index:sample.scope.ledger_index,errors:sample.errors,independent_readback_verified:true};
}
if(require.main===module)collect().then(s=>publish(s,R.client())).then(r=>console.log(JSON.stringify(r))).catch(e=>{console.error('Market collection failed:',e.message);process.exitCode=1;});
module.exports={collect,publish,request,rpc,MAX_SAMPLE,DAILY_LIMIT};
