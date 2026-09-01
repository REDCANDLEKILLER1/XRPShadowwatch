#!/usr/bin/env node
/* ── PRAYER AND SCRIPTURE — both are read aloud every morning. They must be real
   text with a real reference, never a placeholder, and must rotate by date.
   They went missing once and had to be fixed under a 25-minute deadline.

   Committed from a scratchpad harness that had been run by hand on every
   PR without ever being in the repo — CI cannot run what is not committed.

   Run: node scripts/prayer-scripture.test.js
   Env: SW_TEST_PORT to override the port (default 8304).
──── */
const http=require('http'),fs=require('fs'),path=require('path');
const ROOT=path.join(__dirname,'..');
const PORT=Number(process.env.SW_TEST_PORT||8304);
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
  const mk=d=>({date:d, scan_id:'SC-P', wallets_checked:251, watchlist_total:251,
    wallet_results:[], large_transfers:[], xrp_price:1.47, shadow_volume_xrp:6e6,
    risk_score:{score:40,label:'YELLOW'}});
  const grab=(txt,hdr)=>{ const i=txt.indexOf(hdr); if(i<0) return '';
    const rest=txt.slice(i+hdr.length); const m=rest.match(/^\n─+\n([\s\S]*?)(?=\n\n[^\n]+\n─{3,})/);
    return m?m[1].trim():rest.slice(0,200).trim(); };
  const t1=PUBLIC_REPORT_PIPELINE_V1.assemble(mk('2026-08-27')).text;
  const t2=PUBLIC_REPORT_PIPELINE_V1.assemble(mk('2026-09-04')).text;
  return {
    prayer1: grab(t1,'🙏 THE DAILY PRAYER'), scripture1: grab(t1,'📖 THE DAILY SCRIPTURE'),
    prayer2: grab(t2,'🙏 THE DAILY PRAYER'), scripture2: grab(t2,'📖 THE DAILY SCRIPTURE'),
    anyPlaceholder: /see dev panel|auto-rendered/.test(t1)
  };
});
console.log('  PRAYER    : '+JSON.stringify(o.prayer1.slice(0,110)));
console.log('  SCRIPTURE : '+JSON.stringify(o.scripture1.slice(0,110))+'\n');
ck('prayer is real text, not a placeholder',
   o.prayer1.length>25 && !/see dev panel|auto-rendered|\[/.test(o.prayer1), o.prayer1.slice(0,60));
ck('scripture is real text, not a placeholder',
   o.scripture1.length>20 && !/see dev panel|auto-rendered|\[/.test(o.scripture1), o.scripture1.slice(0,60));
ck('scripture carries a book/chapter reference', /\b\d?\s?[A-Z][a-z]+\s+\d+:\d+/.test(o.scripture1), o.scripture1.slice(0,60));
ck('no placeholder text anywhere in the story', !o.anyPlaceholder);
ck('rotation: a different date gives a different prayer',
   o.prayer1!==o.prayer2 || o.scripture1!==o.scripture2);
ck('no page errors', errs.length===0, errs.slice(0,3));
await b.close();srv.close();
console.log('\n'+(fail?fail+' FAILED of '+(pass+fail):'ALL '+pass+' CHECKS PASS'));
process.exit(fail?1:0);
})();
