'use strict';
// Exercise the actual RUN entry point, including sealing, on a fresh mobile
// page with XRPL unavailable. No live XRPL reads or evidence writes occur.
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const http = require('http');
const browserType = require('playwright')[process.env.SW_TEST_BROWSER || 'chromium'];
const ROOT = path.join(__dirname, '..');
const PORT = Number(process.env.SW_TEST_PORT || 8235);
const roster = require('../src/db/roster').select().accounts;
const anchor = 107449161;
const cutoff = new Date(Date.now() - 60000).toISOString();
const events = Array.from({length:200000}, (_, i) => ({
  hash:i.toString(16).padStart(64,'0'), ledger_index:anchor - i % 500,
  close_time:cutoff, tx_type:'Payment', tx_result:'tesSUCCESS', validated:true,
  from_account:roster[0], to_account:roster[1], amount_drops:'1000000', currency:'XRP',
  observed_via:[roster[0],roster[1]]
}));
let unavailable = false, reads = 0, writes = 0, slowNews = false, newsBodies = 0;
let releaseVerification = null;
const srv = http.createServer((req,res) => {
  const u = new URL(req.url, 'http://localhost');
  if (u.pathname === '/api/forensic-report') {
    // The analysis arrives after the old six-second cutoff while an unrelated
    // price lookup exceeds boot's ceiling. RUN must keep the completed result.
    if (slowNews) { res.writeHead(503); return res.end(); }
    setTimeout(()=>{
      res.writeHead(200, {'Content-Type':'application/json'});
      res.end(JSON.stringify({status:'AVAILABLE',summary:{schema:'shadowwatch-forensic-report/1',
        window_start:new Date(Date.parse(cutoff)-86400000).toISOString(),window_end:cutoff,
        exchange_transactions:2,classified_records:2,unclassified_records:0,
        xrp_sold_for_rlusd:'904.120603',xrp_bought_with_rlusd:'904.120603',
        repeated_quote_wallets:1,repeated_cancel_wallets:0,regular_transfer_wallets:0}}));
    },7000);
    return;
  }
  if (u.pathname === '/test/targeted-news') {
    res.writeHead(200, {'Content-Type':'application/json'});
    if (slowNews) { newsBodies++; res.write('{"articles":['); return; }
    return res.end('{"articles":[{"title":"Timely XRP context","url":"https://example.test/news"}]}');
  }
  if (u.pathname === '/api/delta') {
    if (req.method !== 'GET') { writes++; res.writeHead(405); return res.end(); }
    reads++;
    if (unavailable) {
      require('../api/delta').streamStoredReportRequest(res, {}, {readReport:async()=>{throw new Error('STORE_DOWN');}});
      return;
    }
    const body = { source:'STORED_VERIFIED_EVIDENCE', stored_checkpoint:true,
      state_version:204, state_sha256:'f'.repeat(64), scan_id:'stored-v204-test',
      anchor_ledger:anchor, anchor_close:cutoff, target_wallets:roster.length,
      complete_wallets:roster.length, failed_wallets:0, xrpl_requests:0,
      wallets:roster.map((address,i)=>({address,proven:true,status:'COMPLETE',proven_through:anchor,
        balance_drops:'2000000000',balance_ledger:i===0 ? anchor-10 : anchor,
        baseline_balance_drops:i===1 ? null : '1000000000',baseline_balance_ledger:anchor-30000})),
      events, window:{from:new Date(Number(u.searchParams.get('window_start_ms'))).toISOString(),to:cutoff,
        in_window:events.length,from_stored:events.length,from_this_run:0,days_without_shards:[],shards_verified:4,
        provenance:'OBSERVED',balance_baseline:{state_version:190}},
      freshness:{evidence_time:cutoff,anchor_ledger:anchor,state_version:204,status:'CURRENT'} };
    require('../api/delta').streamStoredReportRequest(res, {}, {heartbeatMs:100,
      readReport:async(input,deps)=>{
        deps.onReportProgress({phase:'history',states_walked:4,days_found:3,days_total:4});
        await new Promise(r=>setTimeout(r,400));
        deps.onReportProgress({phase:'verifying',files_verified:2,files_total:4});
        // Hold this phase until the browser has checked unchanged heartbeat progress.
        // A fixed delay can expire between assertions on a slower WebKit runner.
        await new Promise(resolve=>{releaseVerification=resolve;});
        deps.onReportProgress({phase:'assembling'});
        return body;
      }});
    return;
  }
  if (u.pathname === '/api/report-archive') {
    res.writeHead(200,{'Content-Type':'application/json'});
    return res.end(JSON.stringify({status:'ARCHIVED',commit_sha:'test-only',report_id:'test-only'}));
  }
  const file = path.resolve(ROOT, '.' + u.pathname);
  if (!file.startsWith(ROOT + path.sep) || !fs.existsSync(file) || !fs.statSync(file).isFile()) { res.writeHead(404); return res.end(); }
  res.setHeader('Content-Type', file.endsWith('.js')?'text/javascript':file.endsWith('.css')?'text/css':'text/html');
  fs.createReadStream(file).pipe(res);
});
(async () => {
  await new Promise(r=>srv.listen(PORT,'127.0.0.1',r));
  const browser = await browserType.launch({args:process.env.SW_TEST_BROWSER==='webkit'?[]:['--no-sandbox']});
  try {
    const page = await browser.newPage({viewport:{width:390,height:844},isMobile:true});
    await page.route('**/*',r=>r.request().url().startsWith('http://127.0.0.1:'+PORT) ? r.continue() : r.abort());
    await page.addInitScript(() => {
      window.liveRequests = 0;
      window.WebSocket = class {
        constructor() { window.liveConnections=(window.liveConnections||0)+1; this.readyState=3; setTimeout(()=>{if(this.onerror)this.onerror();},1); }
        close() {} send() { window.liveRequests++; throw new Error('LIVE_RPC_FORBIDDEN'); }
        addEventListener() {} removeEventListener() {}
      };
    });
    await page.goto('http://127.0.0.1:'+PORT+'/brief-console.html');
    await page.waitForFunction(()=>window.SW_STORED_EVIDENCE_READER_20260927);
    await page.waitForTimeout(8500); // roster promotion/load-time wrappers settle
    await page.waitForFunction(()=>document.getElementById('swReportMonitor').dataset.phase==='ready');
    async function reactorBelowHeader() {
      const header=await page.locator('#swDashHeader').boundingBox();
      const reactor=await page.locator('#swReactorPhase').boundingBox();
      assert(header && reactor && header.y>=0 && reactor.y>=header.y+header.height,
        'monitor adoption must not scroll the reactor behind the header');
    }
    await reactorBelowHeader();
    await page.evaluate(()=>{
      market = async()=>[];
      fetchNewsIntel = async()=>{state.newsIntel={items:[],top_headlines:[],source_status:{},source_breakdown:{}};};
      buildEvidenceLedNewsQueries = ()=>[{query:'XRP liquidity'}];
      const nativeFetch = window.fetch;
      window.fetch = (url,opts)=>{
        const outer=new URL(String(url),location.href),target=outer.searchParams.get('url');
        const query=target?new URL(target).searchParams.get('query'):null;
        return nativeFetch(query==='XRP liquidity'?'/test/targeted-news':url,opts);
      };
    });
    for (let attempt=0;attempt<2;attempt++) {
      slowNews = attempt === 1;
      await page.evaluate(stall=>{market=stall?()=>new Promise(()=>{}):async()=>[];},attempt===0);
      await page.evaluate(()=>clearEvidenceNewsCache());
      const running = page.evaluate(async()=>{
        await run();
        return {seal:!!state.seal,scanning:state.scanning,txs:state.txs.length,
          coverage:state.txScanCoverage,report:state.morningStoryReport.length,
          deltas:state.wallets.slice(0,2).map(w=>w.delta_xrp),disabled:document.getElementById('scanBtn').disabled,
          network:window.liveRequests,errors:state.errorLog.slice(-5),logs:state.runLog.slice(-8)};
      });
      running.catch(()=>{}); // preserve a foreground assertion if cleanup closes an in-flight RUN
      await page.waitForFunction(()=>document.getElementById('swReportMonitor').dataset.phase==='verifying');
      const beforeReturn=await page.evaluate(()=>window.liveConnections);
      await page.evaluate(()=>document.dispatchEvent(new Event('visibilitychange')));
      await page.waitForTimeout(300);
      assert.equal(await page.evaluate(()=>window.liveConnections),beforeReturn,'foregrounding stored RUN must not start legacy reconnect');
      await page.evaluate(async()=>{
        const original=connectXRPL;
        connectXRPL=async()=>{throw Error('TEST_OPTIONAL_CONNECTION_FAILURE');};
        try { await _ensureSock(null); } finally { connectXRPL=original; }
      });
      assert(await page.locator('#swReportMonitor').isVisible(),'monitor must survive dashboard adoption');
      const box=await page.locator('#swReportMonitor').boundingBox();
      assert(box && box.x>=0 && box.y>=0 && box.x+box.width<=390 && box.y+box.height<=844,'monitor must be in the first mobile viewport');
      assert.match(await page.locator('#swMonitorDetail').innerText(), /2 of 4 files verified/);
      assert.equal(await page.locator('#swMonitorBar').getAttribute('aria-valuenow'),'50');
      assert.match(await page.locator('#swMonitorSignal').innerText(),/Last server update/);
      await page.waitForTimeout(350);
      assert.equal(await page.locator('#swMonitorBar').getAttribute('aria-valuenow'),'50','heartbeats must not invent progress');
      assert(releaseVerification, 'verification phase must be waiting for the browser check');
      releaseVerification();
      releaseVerification=null;
      if (attempt===0 && process.env.SW_MONITOR_SCREENSHOT) await page.screenshot({path:process.env.SW_MONITOR_SCREENSHOT});
      if (slowNews) {
        await page.waitForFunction(()=>state.reportBuildStage && state.reportBuildStage.phase==='targeted-news');
        await page.waitForFunction(()=>document.getElementById('swMonitorTitle').textContent.includes('targeted news'));
        const debug = await page.evaluate(()=>buildShadowWatchDebugFile());
        assert(debug.includes('Report Status: IN_PROGRESS'));
        assert(debug.includes('[REPORT NOT SEALED'));
        assert(!debug.split('SECTION 02 —')[1].split('SECTION 03 —')[0].includes('Executive Summary'),
          'debug must not invent a public story before sealing');
      }
      let runTimer;
      const out = await Promise.race([running,new Promise((_,reject)=>{
        runTimer=setTimeout(()=>reject(Error('RUN_DID_NOT_FINISH')),90000);
      })]).finally(()=>clearTimeout(runTimer));
      console.log('RUN '+(attempt+1),JSON.stringify(out));
      if (slowNews) assert(newsBodies>0,'real targeted-news response body must stall during RUN');
      else assert(await page.evaluate(()=>state.pack.news_intel.items.some(x=>x.title==='Timely XRP context')),'timely context must reach this run');
      assert(out.seal,'stored RUN must seal even when XRPL is offline');
      const integrity=await page.evaluate(()=>({lost:state.pack.scan_link_lost,story:state.morningStoryReport,watch:state.pack.market_watch}));
      if(attempt===0){
        assert.equal(integrity.watch.status,'AVAILABLE','market-price timeout must preserve completed XRP/RLUSD analysis');
        assert.match(integrity.story,/904\.120603 XRP was exchanged for RLUSD/);
      }else{
        assert.equal(integrity.watch.status,'UNAVAILABLE','a rerun must not inherit the previous analysis');
        assert(!integrity.story.includes('904.120603'));
      }
      assert.equal(integrity.lost,false);
      assert(!integrity.story.includes('SCAN INCOMPLETE'));
      assert(integrity.story.includes('Live order/offer sweep: not collected'));
      assert.equal(out.txs,200000); assert(out.report>0); assert(!out.scanning); assert(!out.disabled);
      assert.equal(out.coverage.complete_wallets,roster.length); assert.equal(out.network,0);
      assert.deepEqual(out.deltas,[null,null],'stale balance and missing stored baseline cannot use device net flow');
      assert.equal(reads,attempt+1,'one stored GET per RUN, including rerun');
      await page.waitForFunction(()=>document.getElementById('swReportMonitor').dataset.phase==='complete');
      assert.match(await page.locator('#swMonitorDetail').innerText(), /archive saved/);
      const savedReports=await page.evaluate(async()=>({rows:await window.SW_SAVED_REPORTS.list(),text:state.morningStoryReport,id:state.seal.report_id}));
      assert.equal(savedReports.rows.filter(r=>r.payload).length,attempt+1,'each completed run is retained separately');
      assert.equal(savedReports.rows.find(r=>r.report_id===savedReports.id).text,savedReports.text,'save exact sealed Coffee & Crypto report');
    }
    unavailable = true;
    const failed = await page.evaluate(async()=>{await run();return {seal:state.seal,pack:state.pack,scanning:state.scanning,disabled:document.getElementById('scanBtn').disabled,network:window.liveRequests};});
    assert.equal(failed.seal,null); assert.equal(failed.pack,null); assert(!failed.scanning); assert(!failed.disabled);
    assert.equal(failed.network,0); assert.equal(writes,0);
    await page.waitForFunction(()=>document.getElementById('swReportMonitor').dataset.phase==='error');
    assert.match(await page.locator('#swMonitorDetail').innerText(),/STORE_DOWN/);
    assert.equal(await page.locator('#swMonitorBar').getAttribute('aria-valuenow'),null);
    await page.setViewportSize({width:1440,height:900});
    await reactorBelowHeader();
    assert.equal((await page.evaluate(()=>window.SW_SAVED_REPORTS.list())).filter(r=>r.payload).length,2,'failed run must not save a third report');
    await page.reload();
    await page.waitForSelector('#swSavedReportsButton');
    await page.click('#swSavedReportsButton');
    await page.waitForFunction(()=>document.querySelectorAll('#swSavedList .sw-saved-row').length>=2);
    assert.equal(reads,3,'reopening saved reports after reload must not trigger another scan');
    console.log('PASS full mobile RUN and rerun seal 200k stored events; store failure stops cleanly; zero acquisition writes/network fallback');
  } finally { await browser.close(); srv.closeAllConnections(); await new Promise(r=>srv.close(r)); }
})().catch(e=>{console.error(e);process.exit(1);});
