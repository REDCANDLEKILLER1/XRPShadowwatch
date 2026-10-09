'use strict';
const assert=require('assert/strict'),R=require('../src/db/forensic-report'),F=require('../src/db/forensic-patterns'),W=require('../src/shared/market-watch');
const T=require('../src/db/transactions'),X=require('../src/db/evidence-export'),real=require('./fixtures/forensic-live-ledger-107530078.json');
const records=real.transactions.map(item=>{const row=T.rowFromAccountTx({tx_json:item.tx_json||item.tx||item,hash:item.hash,
 ledger_index:real.provenance.ledger_index,validated:true,meta:item.meta||item.metaData});return F.inspect(X.eventOf({...row,close_time:real.provenance.close_time}),X.payloadOf(row));});
const verified={verified:true,restore_verified:true,source_commit:'a'.repeat(40),manifest_sha256:'b'.repeat(64),anchor_close:real.provenance.close_time};
const env={SHADOWWATCH_EVIDENCE_TOKEN:'fixture'},now=Date.parse(verified.anchor_close);
function reader(summary){return async(method,p)=>{assert.equal(method,'GET');if(p.startsWith('/git/ref'))return{object:{sha:'c'.repeat(40)}};
 if(p.startsWith('/contents/'))return summary?{encoding:'base64',content:Buffer.from(JSON.stringify(summary)).toString('base64')}:null;throw Error('UNEXPECTED_READ');};}
(async()=>{
 const summary=R.build(records,verified,new Date(now+1000).toISOString());assert.equal(summary.exchange_transactions,2);assert.equal(summary.exchange_wallets,3);
 assert.equal(summary.xrp_sold_for_rlusd,'904.120603');assert.equal(summary.xrp_bought_with_rlusd,'904.120603');
 assert.equal(summary.observed_records,2);assert(!('wallets' in summary));assert(!('destination_uri' in summary));
 assert.throws(()=>R.build(records,{...verified,restore_verified:false}),/RESTORE_REQUIRED/);
 assert.throws(()=>R.build(records.concat(records),verified),/DUPLICATE/);
 assert.throws(()=>R.validate({...summary,xrp_sold_for_rlusd:'90000000000'}),/INVALID/);
 const counts={...summary,classified_records:20};counts.sha256=R.seal(counts);assert.throws(()=>R.validate(counts),/COUNTS_INVALID/);
 const missing=R.build([{...records[0],hash:'C'.repeat(64),status:'MISSING_RAW_METADATA',exchanges:[],orders:[],payments:[]}],verified);
 assert.equal(missing.unclassified_records,1);
 const outside=R.build([{...records[0],close_time:new Date(now-86400001).toISOString()}],verified);assert.equal(outside.observed_records,0);
 assert.equal((await R.read({env,gh:reader(summary),now:now+1000})).status,'AVAILABLE');
 assert.equal((await R.read({env,gh:reader(summary),now:now+37*3600000})).status,'STALE');
 assert.equal((await R.read({env,gh:reader(null),now})).status,'UNAVAILABLE');
 await assert.rejects(()=>R.read({env,gh:reader(summary),now:now-1}),/FUTURE/);
 const writes=[],blobs=new Map();let next=0;
 const gh=async(method,p,body)=>{
  if(method==='GET')return p.startsWith('/git/commits')?{tree:{sha:'d'.repeat(40)}}:reader(null)(method,p);
  writes.push({method,p,body});if(p==='/git/blobs'){const sha=String(++next);blobs.set(sha,Buffer.from(body.content,'base64').toString());return{sha};}
  if(p==='/git/trees'){assert.equal(body.tree.length,2);assert(body.tree.every(e=>e.path.startsWith('forensics/report/')));return{sha:'e'.repeat(40)};}
  if(p==='/git/commits')return{sha:'f'.repeat(40)};if(method==='PATCH'){assert.equal(body.force,false);return{};}throw Error('UNEXPECTED_WRITE');
 };
 assert((await R.publish(summary,{env,gh})).published);assert.equal(writes.filter(w=>w.method==='PATCH').length,1);
 const newer=R.build(records,{...verified,anchor_close:new Date(now+3600000).toISOString()});
 assert.equal((await R.publish(summary,{env,gh:reader(newer)})).reason,'NEWER_SUMMARY_EXISTS');
 await assert.rejects(()=>R.publish(summary,{env:{...env,VERCEL_ENV:'preview'},gh}),/NON_PRODUCTION/);
 const text=W.render({status:'AVAILABLE',summary});assert.match(text,/904\.120603 XRP was exchanged for RLUSD/);assert(!text.includes('904.120,603'));assert.match(text,/not total market volume/);
 assert.match(W.render({status:'UNAVAILABLE'}),/not available/);assert(!W.render({status:'STALE',summary}).includes('904.120603'));
 assert.match(W.render({status:'AVAILABLE',summary:missing}),/could not be classified/);assert.match(W.render({status:'AVAILABLE',summary:outside}),/no classified records/);
 const original='Ledger story\nDetails\n\nHow to Read It\nContext\n',pack={market_watch:{status:'AVAILABLE',summary}},injected=W.inject(original,pack);
 assert(injected.indexOf('Market activity watch')<injected.indexOf('How to Read It'));assert.equal(W.inject(injected,pack),injected);assert.equal(W.inject(original,{}),original);
 assert.equal((await W.load(async()=>{throw Error('offline');})).status,'UNAVAILABLE');
 assert.equal((await W.load(async()=>({ok:true,json:async()=>({status:'AVAILABLE',summary})}))).summary.sha256,summary.sha256);
 let deadline,signal;
 const sandbox={module:{exports:{}},AbortController,setTimeout:(fn,ms)=>{assert.equal(ms,6000);deadline=fn;return 1;},clearTimeout:()=>{}};
 require('vm').runInNewContext(require('fs').readFileSync(require.resolve('../src/shared/market-watch'),'utf8'),sandbox);
 const bounded=sandbox.module.exports.load((url,opts)=>{signal=opts.signal;return new Promise(()=>{});});
 deadline();assert.equal((await bounded).status,'UNAVAILABLE');assert.equal(signal.aborted,true);
 const api=require('../api/forensic-report'),responses=[],res={setHeader(){},status(code){this.code=code;return this;},json(body){responses.push(body);return this;}};
 await api({method:'POST'},res);assert.equal(res.code,405);
 const save=R.read;R.read=async()=>{throw Error('DO_NOT_LEAK_PRIVATE_SECRET');};try{await api({method:'GET'},res);assert.equal(res.code,503);assert(!JSON.stringify(responses).includes('DO_NOT_LEAK'));}finally{R.read=save;}
 console.log('PASS verified report rollup, exact real fills, bounded period, unclassified/stale/missing distinction, private summary-only publication, monotonic pointer, preview write refusal, canonical injection and read-only API');
})().catch(e=>{console.error(e);process.exitCode=1;});
