'use strict';
const assert=require('assert/strict'),http=require('http'),fs=require('fs'),path=require('path');
const {chromium,webkit}=require('playwright'),R=require('../src/db/forensic-report');
const C=require('../src/db/market-coverage'),E=require('../src/db/market-executions');
const a='r9NpyVfLfUG8hatuCCHKzosyDtKnBdsEN3',b='rMhkqz3DeU7GUUJKGZofusbrTwZe6bDyb1';
const now=Date.now(),records=Array.from({length:6},(_,i)=>({hash:(i+1).toString(16).padStart(64,'0'),ledger_index:100+i,close_time:new Date(now-60000+i*10000).toISOString(),status:'ANALYZED',orders:[],exchanges:[],payments:[{from:a,to:b,delivered:{currency:'XRP',value:'10'}}]}));
const summary=R.build(records,{verified:true,restore_verified:true,source_commit:'a'.repeat(40),manifest_sha256:'b'.repeat(64),anchor_close:new Date(now).toISOString()});
assert.equal(summary.pattern_details[0].account,a);assert.equal(summary.pattern_details[0].to,b);assert.equal(summary.pattern_details[0].hashes.length,3);
assert.equal(summary.regular_transfer_wallets,1);assert.equal(summary.pattern_details[0].interval_seconds,10);
const invalid=JSON.parse(JSON.stringify(summary));invalid.pattern_details[0].hashes=['not-a-hash'];invalid.sha256=R.seal(invalid);assert.throws(()=>R.validate(invalid),/DETAILS_INVALID/);
const coverage={schema:C.SCHEMA,code_sha:'a'.repeat(40),generated_at:new Date(now).toISOString(),state:'RUNNING',
 scope:'VALIDATED_LEDGERS_SINCE_ACTIVATION',read_only:true,automatic_admission:false,continuous:false,whole_market_complete:false,classification_complete:false,unique_market_volume:null,
 coverage:{start:100,next:104,verified_ledgers:4,observed_tip:200,observed_tip_close:new Date(now).toISOString(),last_verified_close:new Date(now-384000).toISOString(),collection_delay_ms:384000,schedule_delay_ms:60000,missing_ranges:[{from:104,through:200,reason:'BACKLOG'}]},
 storage:{bucket_bytes:2000000,bucket_limit:8000000000,daily_charged_bytes:500000,daily_limit:32*1048576,day_utc:new Date(now).toISOString().slice(0,10),measured_at:new Date(now).toISOString()},
 executions:{...E.empty(),transactions:10,execution_transactions:1,order_book_fills:1,partial_fills:1,order_book_xrp:'12.345678',order_book_rlusd:'18.518517'},
 samples:[{hash:'C'.repeat(64),ledger_index:103,account:b,venue:'ORDER_BOOK',completion:'PARTIAL',side:'SELL_XRP',xrp:'12.345678',rlusd:'18.518517'}]};
coverage.sha256=C.seal(coverage);C.validate(coverage);
const root=path.resolve(__dirname,'..'),port=Number(process.env.SW_TEST_PORT||8240);let status='AVAILABLE',collectorStatus='AVAILABLE',calls=0,collectorCalls=0;
const server=http.createServer((req,res)=>{if(req.url==='/api/forensic-report'){calls++;res.setHeader('Content-Type','application/json');res.end(JSON.stringify({status,summary}));return;}
 if(req.url==='/api/market-coverage'){collectorCalls++;res.setHeader('Content-Type','application/json');res.end(JSON.stringify({status:collectorStatus,summary:coverage}));return;}
 let file=path.resolve(root,'.'+new URL(req.url,'http://local').pathname.replace(/^\/$/,'/index.html'));
 if(!file.startsWith(root+path.sep)){res.writeHead(403).end();return;}
 fs.readFile(file,(e,body)=>{res.setHeader('Content-Type',({'.js':'text/javascript','.css':'text/css','.html':'text/html'})[path.extname(file)]||'application/octet-stream');res.statusCode=e?404:200;res.end(e?'':body);});});
(async()=>{await new Promise(r=>server.listen(port,'127.0.0.1',r));const browser=await(process.env.SW_TEST_BROWSER==='webkit'?webkit:chromium).launch({args:process.env.SW_TEST_BROWSER==='webkit'?[]:['--no-sandbox']});
try{const page=await browser.newPage({viewport:{width:1440,height:900}});await page.route('**/*',r=>r.request().url().startsWith('http://127.0.0.1:'+port)?r.continue():r.abort());await page.routeWebSocket(/wss:\/\//,ws=>ws.close());
 await page.goto('http://127.0.0.1:'+port+'/');await page.waitForFunction(()=>document.querySelector('#pattern-watch-live').textContent.includes('Regular transfers · 6 events'));
 // The desktop landing hook runs 300ms after DOMContentLoaded. Wait for it
 // before selecting tabs so it cannot move the test back to HOME mid-click.
 await page.waitForFunction(()=>window.switchView.__swWall===true);
 await page.evaluate(()=>{document.getElementById('splash-screen').remove();});
 for(const mode of ['live','map','graph']){await page.evaluate(m=>{switchView(m);document.getElementById('pattern-watch-'+m).open=true;},mode);
 const p=page.locator('#pattern-watch-'+mode);assert.match(await p.textContent(),/Regular transfers · 6 events/);assert.match(await p.textContent(),/not proof of bots/);assert.equal(await p.locator('a[href*="/transactions/"]').count(),4);
 assert.equal(await p.locator('a[href*="/accounts/"]').count(),3);
 assert.match(await p.textContent(),/104–200 \(BACKLOG\)/);assert.match(await p.textContent(),/Private storage: 0.002 \/ 8 GB/);
 assert.match(await p.textContent(),/Collection lag at snapshot: 7 minutes/);assert.match(await p.textContent(),/Verified order-book fill · partial/);
 assert.equal(await p.locator('.sw-execution-card').count(),1);
 if(mode==='graph')assert.equal(await p.locator('svg').count(),1);
 await p.locator('select').selectOption('REPEATED_LIMIT_PRICE');assert.match(await p.textContent(),/No findings for this filter/);await p.locator('select').selectOption('');
 }
 await page.evaluate(()=>switchView('live'));await page.locator('#pattern-watch-live button').filter({hasText:'Trace wallet'}).click();assert.equal(await page.locator('#view-graph').isVisible(),true);
 assert.equal(await page.evaluate(x=>window.SW_PATTERN_WATCH.hasWallet(x),a),true);
 assert.equal(calls,1,'three panels share one API request');
 assert.equal(collectorCalls,1,'three panels share one coverage request');
 await page.evaluate(([from,to])=>handleTx({TransactionType:'Payment',Account:from,Destination:to,Amount:'10000000',hash:'F'.repeat(64)},{TransactionResult:'tesSUCCESS',delivered_amount:'10000000',AffectedNodes:[]}),[a,b]);
 assert.equal(await page.locator('#feed .sw-pattern-badge').count(),1);
 await page.setViewportSize({width:390,height:844});for(const mode of ['live','map','graph']){await page.evaluate(m=>switchView(m),mode);const p=page.locator('#pattern-watch-'+mode);const box=await p.boundingBox();assert(box.width<=390);assert(await p.evaluate(e=>e.scrollWidth<=e.clientWidth+1));}
 await page.screenshot({path:'/tmp/shadowwatch-pattern-phone.png'});
 status='STALE';collectorStatus='STALE';await page.evaluate(()=>SW_PATTERN_WATCH.refresh());assert.equal(await page.evaluate(x=>SW_PATTERN_WATCH.hasWallet(x),a),false);assert.equal(await page.locator('#feed .sw-pattern-badge').count(),0);assert.equal(await page.locator('#pattern-watch-graph .sw-pattern-card').count(),0);assert.match(await page.locator('#pattern-watch-graph').textContent(),/too old/);
 assert(!((await page.locator('#pattern-watch-live').textContent()).includes('12.345678 XRP')));
 status='AVAILABLE';summary.classified_records=0;summary.unclassified_records=summary.observed_records;await page.evaluate(()=>SW_PATTERN_WATCH.refresh());assert.match(await page.locator('#pattern-watch-live').textContent(),/trading activity is unknown/);assert.equal(await page.locator('#pattern-watch-live .sw-pattern-totals').count(),0);
 status='UNAVAILABLE';collectorStatus='AVAILABLE';await page.evaluate(()=>SW_PATTERN_WATCH.refresh());assert.match(await page.locator('#pattern-watch-live').textContent(),/not available/);
 assert.equal(await page.locator('#pattern-watch-live .sw-execution-card').count(),1,'coverage survives a missing legacy report');
 await page.evaluate(()=>switchView('live'));await page.locator('#pattern-watch-live button').filter({hasText:'Trace execution wallet'}).click();assert.equal(await page.locator('#view-graph').isVisible(),true);
 collectorStatus='UNAVAILABLE';await page.evaluate(()=>SW_PATTERN_WATCH.refresh());assert.equal(await page.locator('#pattern-watch-live .sw-execution-card').count(),0);assert.match(await page.locator('#pattern-watch-live').textContent(),/coverage is unavailable/);
 console.log('PASS LIVE/MAP/GRAPH coverage, fills, gap/storage/delay displays, independent fetches, explorer links, execution tracing, phone bounds and stale/unknown withholding');
}finally{await browser.close();server.close();}})().catch(e=>{console.error(e);server.close();process.exitCode=1;});
