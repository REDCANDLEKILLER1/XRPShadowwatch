'use strict';
const assert=require('assert/strict'),S=require('../src/db/market-coverage'),E=require('../src/db/market-executions'),W=require('../src/shared/market-watch');
const now=Date.parse('2026-10-10T12:00:00Z'),env={SHADOWWATCH_EVIDENCE_TOKEN:'fixture'};
function fixture(){const s={schema:S.SCHEMA,code_sha:'a'.repeat(40),generated_at:new Date(now).toISOString(),state:'RUNNING',
 scope:'VALIDATED_LEDGERS_SINCE_ACTIVATION',read_only:true,automatic_admission:false,continuous:false,whole_market_complete:false,classification_complete:false,unique_market_volume:null,
 coverage:{start:100,next:104,verified_ledgers:4,observed_tip:200,observed_tip_close:new Date(now).toISOString(),last_verified_close:new Date(now-384000).toISOString(),collection_delay_ms:384000,schedule_delay_ms:60000,missing_ranges:[{from:104,through:200,reason:'BACKLOG'}]},
 storage:{bucket_bytes:2000000,bucket_limit:8000000000,daily_charged_bytes:500000,daily_limit:32*1048576,day_utc:'2026-10-10',measured_at:new Date(now).toISOString()},
 executions:{...E.empty(),transactions:10,execution_transactions:2,order_book_fills:2,partial_fills:1,order_book_xrp:'12.345678',order_book_rlusd:'18.518517'},samples:[]};s.sha256=S.seal(s);return s;}
const reader=s=>async(method,p)=>{assert.equal(method,'GET');if(p.startsWith('/git/ref'))return{object:{sha:'a'.repeat(40)}};
 if(p.startsWith('/contents/'))return s?{content:Buffer.from(JSON.stringify(s)).toString('base64'),encoding:'base64'}:null;throw Error('UNEXPECTED_READ');};
(async()=>{
 const summary=fixture();S.validate(summary);
 assert.equal((await S.read({env,gh:reader(summary),now})).status,'AVAILABLE');assert.equal((await S.read({env,gh:reader(summary),now:now+46*60000})).status,'STALE');
 assert.equal((await S.read({env,gh:reader(null),now})).status,'UNAVAILABLE');
 const tamper={...summary,raw_ledger:{secret:'must not publish'}};tamper.sha256=S.seal(tamper);assert.throws(()=>S.validate(tamper),/FIELDS/);
 const nested=fixture();nested.coverage.missing_ranges[0].private_key='do not expose';nested.sha256=S.seal(nested);assert.throws(()=>S.validate(nested),/FIELDS/);
 for(const patch of [{continuous:true},{automatic_admission:true},{coverage:{...summary.coverage,next:105}},{executions:{...summary.executions,order_book_xrp:'NaN'}}]){
  const bad={...summary,...patch};bad.sha256=S.seal(bad);assert.throws(()=>S.validate(bad));}
 await assert.rejects(()=>S.publish(summary,{env:{...env,VERCEL_ENV:'preview'},gh:reader(null)}),/NON_PRODUCTION/);
 const older={...summary,generated_at:new Date(now-60000).toISOString()};older.sha256=S.seal(older);
 assert.equal((await S.publish(older,{env,gh:reader(summary)})).reason,'NEWER_SUMMARY_EXISTS');
 let writes=0;const gh=async(method,p,body)=>{
  if(method==='GET')return p.startsWith('/git/commits')?{tree:{sha:'b'.repeat(40)}}:reader(null)(method,p);
  writes++;if(p==='/git/trees'){assert.equal(body.tree.length,1);assert.equal(body.tree[0].path,S.PATH);}
  if(method==='PATCH')assert.equal(body.force,false);return{sha:'c'.repeat(40)};
 };assert((await S.publish(summary,{env,gh})).published);assert(writes>0);
 const text=W.renderCollector({status:'AVAILABLE',summary});assert.match(text,/104–200/);assert.match(text,/12\.345678 XRP/);assert.match(text,/not total market volume/);
 assert(!W.renderCollector({status:'STALE',summary}).includes('12.345678 XRP'));assert.match(W.renderCollector({status:'UNAVAILABLE'}),/does not mean zero/);
 assert(!W.renderCollector({status:'UNAVAILABLE',summary}).includes('12.345678 XRP'));
 const base={status:'UNAVAILABLE',reason:'HTTP_ERROR'},loaded=await W.load(async url=>({ok:true,json:async()=>url==='/api/market-coverage'?{status:'AVAILABLE',summary}:base}));
 assert.equal(loaded.collector.summary.sha256,summary.sha256);assert.equal(loaded.status,'UNAVAILABLE');
 const report=W.inject('Saved report\nHow to Read It\nContext',{market_watch:loaded});assert.match(report,/Ledger-wide XRP\/RLUSD collector/);assert.match(report,/104–200/);assert.equal(W.inject(report,{market_watch:loaded}),report);
 const api=require('../api/market-coverage'),res={setHeader(){},status(n){this.code=n;return this;},json(v){this.body=v;return this;}};
 await api({method:'POST'},res);assert.equal(res.code,405);const original=S.read;S.read=async()=>{throw Error('PRIVATE_DATA');};
 try{await api({method:'GET'},res);assert.equal(res.code,503);assert(!JSON.stringify(res.body).includes('PRIVATE_DATA'));}finally{S.read=original;}
 console.log('PASS sealed coverage, monotonic private publication, stale/unknown states, no raw fields, preview refusal, independent report integration and read-only API');
})().catch(e=>{console.error(e);process.exitCode=1;});
module.exports={fixture};
