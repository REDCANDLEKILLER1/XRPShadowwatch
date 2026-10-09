'use strict';
const assert=require('assert/strict'),{Readable}=require('stream');
const M=require('./market-evidence'),R=require('./r2-master-backup');
const H=require('./market-history'),F=require('../src/db/forensic-patterns');
const now=Date.parse('2026-10-09T01:00:00Z'),hash='A'.repeat(64);
function fetcher({wrongBook=false,stale=false,failedTicker=false,bookValidated=true}={}){return async(url,opts)=>{
 let value;if(url.includes('coinbase')){if(failedTicker)throw Error('venue unavailable');value={bid:'1.40',ask:'1.42',price:'1.41',time:new Date(now-(stale?300000:1000)).toISOString()};}
 else {const call=JSON.parse(opts.body),p=call.params[0];
  assert(['ledger','book_offers'].includes(call.method));
  if(call.method==='ledger')value={result:{validated:true,ledger_hash:hash,ledger_index:100,ledger:{ledger_hash:hash,ledger_index:100,close_time:now/1000-946684800,transactions:[]}}};
  else{assert.equal(p.ledger_hash,hash);assert.equal(p.limit,200);value={result:{...(bookValidated===null?{}:{validated:bookValidated}),ledger_hash:wrongBook?'B'.repeat(64):hash,ledger_index:100,offers:[]}};}
 }return{ok:true,body:Readable.from([Buffer.from(JSON.stringify(value))])};};}
function s3({total=0,corrupt=false}={}){const files=new Map();let puts=0;return{files,get puts(){return puts;},async send(cmd){const a=cmd.input;
 if(cmd.constructor.name==='ListObjectsV2Command')return{Contents:[{Key:'older',Size:total}]};
 if(cmd.constructor.name==='PutObjectCommand'){assert.equal(a.Bucket,R.BUCKET);assert.equal(a.IfNoneMatch,'*');files.set(a.Key,a.Body);puts++;return{};}
 if(cmd.constructor.name==='GetObjectCommand')return{Body:Readable.from([corrupt?Buffer.from('bad'):files.get(a.Key)])};throw Error('Unexpected mutation');}};}
(async()=>{
 const sample=await M.collect({fetcher:fetcher(),clock:()=>now});assert.equal(sample.scope.continuous,false);assert.equal(sample.scope.history_complete,false);assert.equal(sample.ticker.price,'1.41');assert.deepEqual(sample.errors,[]);
 assert.equal((await M.collect({fetcher:fetcher({wrongBook:true}),clock:()=>now})).errors.length,2);
 assert.equal((await M.collect({fetcher:fetcher({bookValidated:null}),clock:()=>now})).errors.length,0);
 assert.equal((await M.collect({fetcher:fetcher({bookValidated:false}),clock:()=>now})).errors.length,2);
 assert.equal((await M.collect({fetcher:fetcher({stale:true}),clock:()=>now})).ticker,null);
 assert.equal((await M.collect({fetcher:fetcher({failedTicker:true}),clock:()=>now})).errors[0],'ticker:venue unavailable');
 await assert.rejects(()=>M.rpc('submit',{},fetcher()),/READ_METHOD_ONLY/);
 const remote=s3(),receipt=await M.publish(sample,remote);assert(receipt.independent_readback_verified);assert.equal(remote.puts,1);
 const full=s3({total:R.LIMIT});await assert.rejects(()=>M.publish(sample,full),/CAPACITY_STOP/);assert.equal(full.puts,0);
 await assert.rejects(()=>M.publish(sample,s3({corrupt:true})),/HASH_MISMATCH|SIZE_MISMATCH/);
 const quote=n=>({Account:'rWallet',TakerGets:String(n*1000000),TakerPays:{currency:F.ASSETS[0].currency,issuer:F.ASSETS[0].issuer,value:String(n*1.41)}});
 const a={...sample,books:{asks:{offers:[quote(10)]}}},b={...sample,observed_at:new Date(now+900000).toISOString(),scope:{...sample.scope,ledger_hash:'B'.repeat(64)},books:{asks:{offers:[quote(20)]}}};
 const history=H.timeline([{key:'first',sample:a},{key:'second',sample:b},{key:'duplicate',sample:b}]);
 assert.equal(history.unique_ledgers,2);assert.equal(history.repeated_ledgers,1);assert.equal(history.visible_size_increases.length,1);assert.equal(history.visible_size_increases[0].increase_xrp,'10');
 assert.equal(H.timeline([{key:'first',sample:a},{key:'later',sample:{...b,observed_at:new Date(now+3600000).toISOString()}}]).visible_size_increases.length,0);
 console.log('PASS read-only market methods, pinned validated ledger/books, stale ticker exclusion, venue gaps, bounded private publication, readback hash and capacity stop');
})().catch(e=>{console.error(e);process.exitCode=1;});
