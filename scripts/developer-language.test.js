#!/usr/bin/env node
/* ── DEVELOPER LANGUAGE — internal handles, module names and debug phrasing must
   never reach the reader-facing report.

   Committed from a scratchpad harness that had been run by hand on every
   PR without ever being in the repo — CI cannot run what is not committed.

   Run: node scripts/developer-language.test.js
   Env: SW_TEST_PORT to override the port (default 8303).
──── */
const http=require('http'),fs=require('fs'),path=require('path');
const ROOT=path.join(__dirname,'..');
const PORT=Number(process.env.SW_TEST_PORT||8303);
const MIME={'.html':'text/html','.js':'text/javascript','.css':'text/css','.json':'application/json','.svg':'image/svg+xml','.png':'image/png'};
const srv=http.createServer((q,r)=>{let u=decodeURIComponent(q.url.split('?')[0]);if(u==='/')u='/index.html';
 const f=path.join(ROOT,u);
 if(!f.startsWith(ROOT)||!fs.existsSync(f)||fs.statSync(f).isDirectory()){r.writeHead(404);r.end('nf');return;}
 r.writeHead(200,{'Content-Type':MIME[path.extname(f)]||'application/octet-stream'});fs.createReadStream(f).pipe(r);}).listen(PORT);
(async()=>{
let chromium;try{({chromium}=require('playwright'))}catch(_){({chromium}=require('/opt/node22/lib/node_modules/playwright'))}
const exe='/opt/pw-browsers/chromium-1194/chrome-linux/chrome';
const b=await chromium.launch(fs.existsSync(exe)?{executablePath:exe,args:['--no-sandbox']}:{args:['--no-sandbox']});
const p=await b.newPage(); const errs=[];
p.on('pageerror',e=>errs.push(e.message));
await p.route('**/*',r=>r.request().url().startsWith('http://127.0.0.1:'+PORT)?r.continue():r.abort());
await p.goto('http://127.0.0.1:'+PORT+'/brief-console.html',{waitUntil:'domcontentloaded'});
await p.waitForTimeout(10000);
let pass=0,fail=0;
const ck=(n,c,d)=>{c?(pass++,console.log('  PASS  '+n)):(fail++,console.log('  FAIL  '+n+(d!==undefined?'  -> '+JSON.stringify(d):'')));};
const HEADLINE="XRP's Institutional Pipeline Widens as ETF Flows Hit Multi-Month Highs";
const o=await p.evaluate((HL)=>{
  const A=PUBLIC_REPORT_PIPELINE_V1.assertions||{};
  const assertDev=A.assertNoDeveloperLanguage;
  const interps=[{source_refs:[{kind:'news_article',url:'https://x/a',label:HL}]}];
  return {
    // 1. the exact VXOQO case: dev term only inside a cited headline
    headlineOnly: assertDev('Executive Summary\nAnd in the news: '+HL+'.\n', interps),
    // 2. a REAL leak must still hard-block
    realLeak: assertDev('Executive Summary\nThe pipeline could not assemble a narrative.\n', interps),
    // 3. real leak with no interpretations at all
    realLeakNoInterp: assertDev('Executive Summary\nevidence_level was NONE.\n', []),
    // 4. the Binance/NaN regression must stay fixed
    binance: assertDev('Executive Summary\nBinance absorbed 40M XRP this scan.\n', []),
    // 5. dev term in body AND a headline present -> still blocks
    both: assertDev('Executive Summary\nOur governor cleared it. And: '+HL+'.\n', interps)
  };
}, HEADLINE);
ck('cited headline containing "pipeline" no longer blocks the report', o.headlineOnly===null, o.headlineOnly);
ck('a REAL "pipeline" leak in our own prose still hard-blocks', o.realLeak!==null && /pipeline/.test(JSON.stringify(o.realLeak)));
ck('real leak still blocks when there are no interpretations', o.realLeakNoInterp!==null);
ck('Binance/NaN regression stays fixed', o.binance===null, o.binance);
ck('headline present but real leak too -> still blocks', o.both!==null);
ck('no page errors', errs.length===0, errs.slice(0,3));
await b.close();srv.close();
console.log('\n'+(fail?fail+' FAILED of '+(pass+fail):'ALL '+pass+' CHECKS PASS'));
process.exit(fail?1:0);
})();
