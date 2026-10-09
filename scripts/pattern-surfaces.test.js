'use strict';
const assert=require('assert/strict'),http=require('http'),fs=require('fs'),path=require('path');
const {chromium,webkit}=require('playwright'),R=require('../src/db/forensic-report');
const a='r9NpyVfLfUG8hatuCCHKzosyDtKnBdsEN3',b='rMhkqz3DeU7GUUJKGZofusbrTwZe6bDyb1';
const now=Date.now(),records=Array.from({length:6},(_,i)=>({hash:(i+1).toString(16).padStart(64,'0'),ledger_index:100+i,close_time:new Date(now-60000+i*10000).toISOString(),status:'ANALYZED',orders:[],exchanges:[],payments:[{from:a,to:b,delivered:{currency:'XRP',value:'10'}}]}));
const summary=R.build(records,{verified:true,restore_verified:true,source_commit:'a'.repeat(40),manifest_sha256:'b'.repeat(64),anchor_close:new Date(now).toISOString()});
assert.equal(summary.pattern_details[0].account,a);assert.equal(summary.pattern_details[0].to,b);assert.equal(summary.pattern_details[0].hashes.length,3);
assert.equal(summary.regular_transfer_wallets,1);assert.equal(summary.pattern_details[0].interval_seconds,10);
const invalid=JSON.parse(JSON.stringify(summary));invalid.pattern_details[0].hashes=['not-a-hash'];invalid.sha256=R.seal(invalid);assert.throws(()=>R.validate(invalid),/DETAILS_INVALID/);
const root=path.resolve(__dirname,'..'),port=Number(process.env.SW_TEST_PORT||8240);let status='AVAILABLE',calls=0;
const server=http.createServer((req,res)=>{if(req.url==='/api/forensic-report'){calls++;res.setHeader('Content-Type','application/json');res.end(JSON.stringify({status,summary}));return;}
 let file=path.resolve(root,'.'+new URL(req.url,'http://local').pathname.replace(/^\/$/,'/index.html'));
 if(!file.startsWith(root+path.sep)){res.writeHead(403).end();return;}
 fs.readFile(file,(e,body)=>{res.setHeader('Content-Type',({'.js':'text/javascript','.css':'text/css','.html':'text/html'})[path.extname(file)]||'application/octet-stream');res.statusCode=e?404:200;res.end(e?'':body);});});
(async()=>{await new Promise(r=>server.listen(port,'127.0.0.1',r));const browser=await(process.env.SW_TEST_BROWSER==='webkit'?webkit:chromium).launch({args:process.env.SW_TEST_BROWSER==='webkit'?[]:['--no-sandbox']});
try{const page=await browser.newPage({viewport:{width:1440,height:900}});await page.route('**/*',r=>r.request().url().startsWith('http://127.0.0.1:'+port)?r.continue():r.abort());await page.routeWebSocket(/wss:\/\//,ws=>ws.close());
 await page.goto('http://127.0.0.1:'+port+'/');await page.waitForFunction(()=>document.querySelector('#pattern-watch-live').textContent.includes('Regular transfers · 6 events'));
 await page.evaluate(()=>{document.getElementById('splash-screen').remove();});
 for(const mode of ['live','map','graph']){await page.evaluate(m=>{switchView(m);document.getElementById('pattern-watch-'+m).open=true;},mode);
 const p=page.locator('#pattern-watch-'+mode);assert.match(await p.textContent(),/Regular transfers · 6 events/);assert.match(await p.textContent(),/not proof of bots/);assert.equal(await p.locator('a[href*="/transactions/"]').count(),3);
 assert.equal(await p.locator('a[href*="/accounts/"]').count(),2);
 if(mode==='graph')assert.equal(await p.locator('svg').count(),1);
 await p.locator('select').selectOption('REPEATED_LIMIT_PRICE');assert.match(await p.textContent(),/No findings for this filter/);await p.locator('select').selectOption('');
 }
 await page.evaluate(()=>switchView('live'));await page.locator('#pattern-watch-live button').filter({hasText:'Trace wallet'}).click();assert.equal(await page.locator('#view-graph').isVisible(),true);
 assert.equal(await page.evaluate(x=>window.SW_PATTERN_WATCH.hasWallet(x),a),true);
 assert.equal(calls,1,'three panels share one API request');
 await page.evaluate(x=>{const row=document.createElement('div');document.getElementById('feed').appendChild(row);SW_PATTERN_WATCH.decorateTransaction(row,x,'');},a);
 assert.equal(await page.locator('#feed .sw-pattern-badge').count(),1);
 await page.setViewportSize({width:390,height:844});for(const mode of ['live','map','graph']){await page.evaluate(m=>switchView(m),mode);const p=page.locator('#pattern-watch-'+mode);const box=await p.boundingBox();assert(box.width<=390);assert(await p.evaluate(e=>e.scrollWidth<=e.clientWidth+1));}
 await page.screenshot({path:'/tmp/shadowwatch-pattern-phone.png'});
 status='STALE';await page.evaluate(()=>SW_PATTERN_WATCH.refresh());assert.equal(await page.evaluate(x=>SW_PATTERN_WATCH.hasWallet(x),a),false);assert.equal(await page.locator('#feed .sw-pattern-badge').count(),0);assert.equal(await page.locator('#pattern-watch-graph .sw-pattern-card').count(),0);assert.match(await page.locator('#pattern-watch-graph').textContent(),/too old/);
 status='AVAILABLE';summary.classified_records=0;summary.unclassified_records=summary.observed_records;await page.evaluate(()=>SW_PATTERN_WATCH.refresh());assert.match(await page.locator('#pattern-watch-live').textContent(),/trading activity is unknown/);assert.equal(await page.locator('#pattern-watch-live .sw-pattern-totals').count(),0);
 status='UNAVAILABLE';await page.evaluate(()=>SW_PATTERN_WATCH.refresh());assert.match(await page.locator('#pattern-watch-live').textContent(),/not available/);
 console.log('PASS sealed wallet evidence, invalid refs rejected, shared fetch, LIVE/MAP/GRAPH filters and routes, explorer links, trace, phone bounds, stale/unavailable no wallet flags');
}finally{await browser.close();server.close();}})().catch(e=>{console.error(e);server.close();process.exitCode=1;});
