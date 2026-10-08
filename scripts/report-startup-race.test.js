'use strict';
const fs=require('fs'),vm=require('vm'),assert=require('assert/strict');
const core=fs.readFileSync('src/brief/02-core.js','utf8');
const market=core.slice(core.indexOf('async function market('),core.indexOf('\n// ── NEWS ENGINE'));
async function lateRead(body){
 const fields=Object.fromEntries(['inPrice','inDelta','inVolume','inXrpldex'].map(k=>[k,{value:k==='inXrpldex'?'999':''}]));
 let release,calls=0;const pending=new Promise(r=>release=r),token={cancelled:false};
 const context={state:{dexVolumeDecision:{stale:true}},$:k=>fields[k],MARKET_FETCH_TIMEOUT_MS:5000,n:Number,
 fetchWithTimeout:()=>{calls++;return body?Promise.resolve({ok:true,json:()=>pending}):pending;}};
 vm.createContext(context);vm.runInContext(market,context);
 const run=context.market(token);await Promise.resolve();await Promise.resolve();token.cancelled=true;
 release(body?{market_data:{current_price:{usd:9},total_volume:{usd:123}}}:{ok:true,json:async()=>({market_data:{current_price:{usd:9}}})});
 await run;assert.equal(fields.inPrice.value,'');assert.equal(fields.inVolume.value,'');assert.equal(fields.inXrpldex.value,'');assert.equal(context.state.dexVolumeDecision,null);assert.equal(calls,1);
}
(async()=>{
 await lateRead(false);await lateRead(true);
 const pipeline=fs.readFileSync('src/brief/10-pipeline.js','utf8');
 const start=pipeline.indexOf('function assertNarrativeFlow('),end=pipeline.indexOf('\nfunction assertHumanReadable',start);
 const ctx={_fail:(assertion,detail,excerpt)=>({assertion,detail,excerpt})};vm.createContext(ctx);vm.runInContext(pipeline.slice(start,end),ctx);
 assert.equal(ctx.assertNarrativeFlow('Executive Summary\n'+ 'A clear finding.\n\nSources\n[1] Article — https://example.com/'+ 'a'.repeat(500)),null);
 assert(ctx.assertNarrativeFlow('Repeated sentence. Repeated sentence.'));
 assert(ctx.assertNarrativeFlow('Word '.repeat(70)+'.'));
 assert.match(core,/clearTimeout\(bootTimer\)/);
 console.log('PASS startup: late response/body cannot mutate report inputs; stale native DEX cleared; prose audit keeps real duplicate/long-sentence checks.');
})().catch(e=>{console.error(e);process.exitCode=1;});
