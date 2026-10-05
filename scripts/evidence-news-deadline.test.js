'use strict';
// Real production function + real timeout/body helper. No network calls.
const assert=require('assert'),fs=require('fs'),vm=require('vm');
const source=fs.readFileSync(require('path').join(__dirname,'../src/brief/02-core.js'),'utf8');
function context(fetch) {
  const pack={news_intel:{items:[]}};
  const c={state:{settings:{},pack:{news_intel:{items:[]}}},n:Number,fetch,AbortController,setTimeout,clearTimeout,
    EVIDENCE_NEWS_CACHE:{},EVIDENCE_NEWS_CACHE_TTL:43200000,log:()=>{},_abortErr:message=>new Error(message)};
  vm.createContext(c);
  vm.runInContext(source.slice(source.indexOf('async function fetchWithTimeout('),source.indexOf('function _abortErr(')),c);
  vm.runInContext(source.slice(source.indexOf('async function fetchEvidenceLedNews('),source.indexOf('// Cache management helpers')),c);
  return {c,pack};
}
const intents=[{query:'XRP liquidity'},{query:'XRP custody'}];
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
async function bounded(promise) {
  let timer;try{return await Promise.race([promise,new Promise((_,r)=>{timer=setTimeout(()=>r(Error('NEWS_STILL_HUNG')),1000);})]);}finally{clearTimeout(timer);}
}
(async()=>{
  let aborted=false;
  let {c,pack}=context(async(_,o)=>({ok:true,text:()=>new Promise((_,reject)=>{
    o.signal.addEventListener('abort',()=>{aborted=true;reject(Error('aborted'));});
  })}));
  assert.equal((await bounded(c.fetchEvidenceLedNews(intents,{pack,budgetMs:30}))).length,0);
  assert(aborted,'timeout must remain active while reading response body');
  assert(pack.news_intelligence_router.source_limits.some(s=>s.includes('time budget')));

  let finishLate,requests=0;
  ({c,pack}=context(async()=>{requests++;return {ok:true,text:()=>new Promise(r=>{finishLate=r;})};}));
  await bounded(c.fetchEvidenceLedNews(intents,{pack,budgetMs:30}));
  const snapshot=JSON.stringify(pack);
  finishLate(JSON.stringify({articles:[{title:'Late headline',url:'https://example.test/late'}]}));
  await sleep(20);
  assert.equal(JSON.stringify(pack),snapshot,'a transport ignoring abort cannot modify a sealed pack later');
  assert.equal(Object.keys(c.EVIDENCE_NEWS_CACHE).length,0,'late body cannot poison the cache');
  assert.equal(requests,1,'no next query after the shared deadline');

  ({c,pack}=context(()=>new Promise(()=>{})));
  assert.equal((await bounded(c.fetchEvidenceLedNews(intents,{pack,budgetMs:30}))).length,0,'even an ignored abort before headers must release RUN');

  ({c,pack}=context(async()=>({ok:true,text:async()=>JSON.stringify({articles:[{title:'Timely headline',url:'https://example.test/news'}]})})));
  const results=await c.fetchEvidenceLedNews(intents.slice(0,1),{pack,budgetMs:500});
  assert.equal(results.length,1);assert.equal(pack.news_intel.items[0].title,'Timely headline');
  assert.equal(c.state.pack.news_intel.items.length,0,'context attaches to the in-flight pack, not stale global state');
  assert.equal(Object.keys(c.EVIDENCE_NEWS_CACHE).length,1);
  const uploadSource=source.slice(source.indexOf('async function uploadSealedReport('),source.indexOf('async function archiveSealedReport('));
  for (const bodyStall of [false,true]) {
    const upload={AbortController,clearTimeout,setTimeout:fn=>setTimeout(fn,30),
      fetch:()=>bodyStall?Promise.resolve({json:()=>new Promise(()=>{})}):new Promise(()=>{})};
    vm.createContext(upload);vm.runInContext(uploadSource,upload);
    await assert.rejects(bounded(upload.uploadSealedReport({report_id:'test'})),/ARCHIVE_SAVE_TIMEOUT/);
  }
  console.log('PASS archive upload bounds both headers and response body');
  console.log('PASS targeted news bounds headers and body, ignored abort, late writes/cache, query admission, and current-run context');
})().catch(e=>{console.error(e);process.exit(1);});
