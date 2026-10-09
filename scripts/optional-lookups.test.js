'use strict';
const assert=require('assert/strict'),fs=require('fs'),vm=require('vm'),http=require('http'),path=require('path');
const source=fs.readFileSync(path.join(__dirname,'../src/brief/02-core.js'),'utf8');
const now=Date.now(),known='r9NpyVfLfUG8hatuCCHKzosyDtKnBdsEN3';
async function escrow(){
 const calls=[],logs=[],state={txWindowEffective:{startMs:now-86400000,endMs:now},indexRun:{anchor_ledger:1234}};
 const c={Date,window:{SW_EVIDENCE_INDEX:{storedActive:()=>true,checkpointWallet:()=>({proven:true})}},state,ESCROW_DAY:86400000,
  loadEscrowHistory:()=>[{hash:'old',ts:now-31*86400000},{hash:'future',ts:now+100000},{hash:'cached',ts:now-2*86400000}],saveEscrowHistory:()=>{},
  escrowFromTxs:by=>{by.verified={hash:'verified',ts:now-1000};},escrowWallets:()=>[known,'other1','other2','other3'],getActiveWatchlist:()=>[{address:known}],
  xrpl:async(_,req)=>{calls.push(req);if(req.account==='other2')throw Error('rate limit: units quota');return {transactions:[{validated:true,hash:'live',ts:now-5000,ledger:1230},{validated:false,hash:'unvalidated',ts:now-5000}]};},
  parseEscrowItem:x=>x,log:x=>logs.push(x)};
 vm.createContext(c);vm.runInContext(source.slice(source.indexOf('async function escrowBackfill('),source.indexOf('// Best-effort, read-only follow-on')),c);
 await c.escrowBackfill({});assert.equal(calls.length,2);assert(!calls.some(r=>r.account===known));assert.equal(calls[0].ledger_index_max,1234);
 assert.equal(state.escrowHistoryCoverage.stored_wallets,1);assert.equal(state.escrowHistoryCoverage.lookup_wallets,1);assert.equal(state.escrowHistoryCoverage.unavailable_wallets,2);assert.equal(state.escrowHistoryCoverage.complete_30_day_history,false);
 assert.deepEqual(Array.from(state.escrow,x=>x.hash).sort(),['cached','live','verified']);assert(!logs.some(s=>s.includes('wallets read')));
 console.log('PASS escrow reuses watched evidence, bounds lookup ledger, rejects unvalidated/future/expired rows, stops at quota, and reports partial history honestly');
}
const root=path.resolve(__dirname,'..'),port=Number(process.env.SW_TEST_PORT||8241);
const server=http.createServer((req,res)=>{let p=path.resolve(root,'.'+new URL(req.url,'http://local').pathname);fs.readFile(p,(e,d)=>{res.setHeader('Content-Type',p.endsWith('.js')?'text/javascript':p.endsWith('.css')?'text/css':'text/html');res.statusCode=e?404:200;res.end(e?'':d);});});
(async()=>{await escrow();await new Promise(r=>server.listen(port,'127.0.0.1',r));const browser=await require('playwright').chromium.launch({args:['--no-sandbox']});
 try{const page=await browser.newPage();await page.route('**/*',r=>r.request().url().startsWith('http://127.0.0.1:'+port)?r.continue():r.abort());await page.routeWebSocket(/wss:\/\//,w=>w.close());await page.goto('http://127.0.0.1:'+port+'/brief-console.html');await page.waitForFunction(()=>window.SW_TARGETED_NEWS_SUPPRESSION_20260817); 
 const result=await page.evaluate(async()=>{
  const requests=[];fetchWithTimeout=async url=>{requests.push(url);return {response:{ok:true},body:decodeURIComponent(url).includes('gdeltproject')?'Please slow down':'<rss><channel><title>Feed</title><item><title>Ripple escrow update</title><link>https://example.test/story</link><pubDate>Fri, 09 Oct 2026 04:00:00 GMT</pubDate></item></channel></rss>'};};
  newsSuppression=()=>({suppressed:false});state.newsIntel={source_status:{gdelt:'OK'}};
  const pack={news_intel:{items:[]}},oldPack={news_intel:{items:[]}};state.pack=oldPack;
  const rows=await fetchEvidenceLedNews([{query:'Ripple escrow news'}],{pack,budgetMs:1000});
  state.newsIntel={source_status:{gdelt:'FAILED',google_news:'OK',rss_feeds:'OK',cryptocompare:'OK'}};
  const second={news_intel:{items:[]}},before=requests.length;
  const suppressed=await fetchEvidenceLedNews([{query:'Ripple custody update'}],{pack:second,budgetMs:1000});
  return{rows,pack,oldPack,requests,suppressed,second,next:requests.slice(before)};
 });
 assert.equal(result.rows.length,1);assert.equal(result.rows[0].source,'Google News');assert.equal(result.rows[0].title,'Ripple escrow update');assert.equal(result.rows[0].url,'https://example.test/story');assert.equal(result.pack.news_intelligence_router.failed_queries[0].provider,'GDELT');assert.equal(result.oldPack.news_intel.items.length,0);
 assert(result.requests.every(x=>x.startsWith('/api/proxy?url=')));assert.equal(result.suppressed.length,1);assert.equal(result.next.length,1);assert(decodeURIComponent(result.next[0]).includes('news.google.com'));assert(result.second.news_intelligence_router.source_limits.some(s=>s.includes('GDELT skipped')));
 console.log('PASS targeted news uses same-origin proxy, real RSS parser, labeled Google fallback, suppressed-GDELT fallback, and current-run pack ownership');
 }finally{await browser.close();server.close();}
})().catch(e=>{console.error(e);server.close();process.exitCode=1;});
