#!/usr/bin/env node
/* ── KGMT FALLBACK — when the narrative cannot be built, the fallback must still be
   real text. KGMT_TEXT was a parse-time constant with "[auto-rendered]" baked
   in, so the fallback published a placeholder to air (PR #42).

   Committed from a scratchpad harness that had been run by hand on every
   PR without ever being in the repo — CI cannot run what is not committed.

   Run: node scripts/kgmt-fallback.test.js
   Env: SW_TEST_PORT to override the port (default 8302).
──── */
const http=require('http'),fs=require('fs'),path=require('path');
const ROOT=path.join(__dirname,'..');
const PORT=Number(process.env.SW_TEST_PORT||8302);
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
const o=await p.evaluate(()=>{
  const P=PUBLIC_REPORT_PIPELINE_V1;
  const pack={date:'2026-08-27', wallets_checked:251, watchlist_total:251,
    shadow_volume_xrp:6e6, risk_score:{score:40,label:'Y'}, wallet_results:[], large_transfers:[]};
  const t1=P.kgmtText(pack);
  const t2=P.kgmtText({date:'2026-09-11', wallets_checked:1, watchlist_total:1,
    shadow_volume_xrp:0, risk_score:{score:1,label:'G'}, wallet_results:[], large_transfers:[]});
  const grab=(txt,h)=>{const i=txt.indexOf(h); if(i<0)return''; const r=txt.slice(i+h.length);
    return r.split(/\n\n/)[0].replace(/^\n/,'').trim();};
  return { full:t1,
    prayer:grab(t1,'🙏 THE DAILY PRAYER'), scripture:grab(t1,'📖 THE DAILY SCRIPTURE'),
    prayer2:grab(t2,'🙏 THE DAILY PRAYER'),
    hasPlaceholder:/\[auto-rendered\]/.test(t1),
    keepsVerdict:/Audit blocked today/.test(t1) && /could not assemble a publishable/.test(t1),
    keepsSignoff:/I’m XRPMan, and I tell on the banks\.|I'm XRPMan, and I tell on the banks\./.test(t1) };
});
console.log('  PRAYER    : '+JSON.stringify(o.prayer.slice(0,100)));
console.log('  SCRIPTURE : '+JSON.stringify(o.scripture.slice(0,100))+'\n');
ck('fallback no longer contains [auto-rendered]', !o.hasPlaceholder);
ck('fallback prayer is real text', o.prayer.length>25 && !/could not be generated|\[/.test(o.prayer), o.prayer.slice(0,60));
ck('fallback scripture is real text with a reference',
   /\b\d?\s?[A-Z][a-z]+\s+\d+:\d+/.test(o.scripture) && !/\[/.test(o.scripture), o.scripture.slice(0,60));
ck('fallback still says the report was blocked', o.keepsVerdict);
ck('fallback keeps the XRPMan sign-off', o.keepsSignoff);
ck('rotation still applies to the fallback', o.prayer!==o.prayer2);
ck('no page errors', errs.length===0, errs.slice(0,3));
await b.close();srv.close();
console.log('\n'+(fail?fail+' FAILED of '+(pass+fail):'ALL '+pass+' CHECKS PASS'));
process.exit(fail?1:0);
})();
