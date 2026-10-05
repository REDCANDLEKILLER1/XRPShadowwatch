'use strict';
// Exercise the actual RUN entry point, including sealing, on a fresh mobile
// page with XRPL unavailable. No live XRPL reads or evidence writes occur.
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const http = require('http');
const { chromium } = require('playwright');
const ROOT = path.join(__dirname, '..');
const PORT = Number(process.env.SW_TEST_PORT || 8235);
const roster = require('../src/db/roster').select().accounts;
const anchor = 107449161;
const cutoff = new Date(Date.now() - 60000).toISOString();
const events = Array.from({length:150000}, (_, i) => ({
  hash:i.toString(16).padStart(64,'0'), ledger_index:anchor - i % 500,
  close_time:cutoff, tx_type:'Payment', tx_result:'tesSUCCESS', validated:true,
  from_account:roster[0], to_account:roster[1], amount_drops:'1000000', currency:'XRP',
  observed_via:[roster[0],roster[1]]
}));
let unavailable = false, reads = 0, writes = 0;
const srv = http.createServer((req,res) => {
  const u = new URL(req.url, 'http://localhost');
  if (u.pathname === '/api/delta') {
    if (req.method !== 'GET') { writes++; res.writeHead(405); return res.end(); }
    reads++;
    if (unavailable) { res.writeHead(503, {'Content-Type':'application/json'}); return res.end('{"error":"STORE_DOWN"}'); }
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
    require('../api/delta').streamStoredReport(res,body,750);
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
  const browser = await chromium.launch({args:['--no-sandbox']});
  try {
    const page = await browser.newPage({viewport:{width:390,height:844},isMobile:true});
    await page.route('**/*',r=>r.request().url().startsWith('http://127.0.0.1:'+PORT) ? r.continue() : r.abort());
    await page.addInitScript(() => {
      window.liveRequests = 0;
      window.WebSocket = class {
        constructor() { this.readyState=3; setTimeout(()=>{if(this.onerror)this.onerror();},1); }
        close() {} send() { window.liveRequests++; throw new Error('LIVE_RPC_FORBIDDEN'); }
        addEventListener() {} removeEventListener() {}
      };
    });
    await page.goto('http://127.0.0.1:'+PORT+'/brief-console.html');
    await page.waitForFunction(()=>window.SW_STORED_EVIDENCE_READER_20260927);
    await page.waitForTimeout(8500); // roster promotion/load-time wrappers settle
    await page.evaluate(()=>{
      market = async()=>[];
      fetchNewsIntel = async()=>{state.newsIntel={items:[],top_headlines:[],source_status:{},source_breakdown:{}};};
      fetchEvidenceLedNews = async()=>[];
    });
    for (let attempt=0;attempt<2;attempt++) {
      const out = await page.evaluate(async()=>{
        await run();
        return {seal:!!state.seal,scanning:state.scanning,txs:state.txs.length,
          coverage:state.txScanCoverage,report:state.morningStoryReport.length,
          deltas:state.wallets.slice(0,2).map(w=>w.delta_xrp),disabled:document.getElementById('scanBtn').disabled,
          network:window.liveRequests,errors:state.errorLog.slice(-5),logs:state.runLog.slice(-8)};
      });
      console.log('RUN '+(attempt+1),JSON.stringify(out));
      assert(out.seal,'stored RUN must seal even when XRPL is offline');
      assert.equal(out.txs,150000); assert(out.report>0); assert(!out.scanning); assert(!out.disabled);
      assert.equal(out.coverage.complete_wallets,roster.length); assert.equal(out.network,0);
      assert.deepEqual(out.deltas,[null,null],'stale balance and missing stored baseline cannot use device net flow');
      assert.equal(reads,attempt+1,'one stored GET per RUN, including rerun');
    }
    unavailable = true;
    const failed = await page.evaluate(async()=>{await run();return {seal:state.seal,pack:state.pack,scanning:state.scanning,disabled:document.getElementById('scanBtn').disabled,network:window.liveRequests};});
    assert.equal(failed.seal,null); assert.equal(failed.pack,null); assert(!failed.scanning); assert(!failed.disabled);
    assert.equal(failed.network,0); assert.equal(writes,0);
    console.log('PASS full mobile RUN and rerun seal 150k stored events; store failure stops cleanly; zero acquisition writes/network fallback');
  } finally { await browser.close(); await new Promise(r=>srv.close(r)); }
})().catch(e=>{console.error(e);process.exit(1);});
