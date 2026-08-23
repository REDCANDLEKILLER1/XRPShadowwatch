const http=require('http'),fs=require('fs'),path=require('path');
// Resolved from THIS file, never an absolute path — the lesson from the proxy
// suite, which silently tested main's code from any other directory.
const ROOT=path.join(__dirname,'..'),PORT=Number(process.env.P||8151);
const MIME={'.html':'text/html','.js':'text/javascript','.css':'text/css','.json':'application/json','.svg':'image/svg+xml','.png':'image/png'};
const srv=http.createServer((q,r)=>{let u=decodeURIComponent(q.url.split('?')[0]);if(u==='/')u='/index.html';
 const f=path.join(ROOT,u);
 if(!f.startsWith(ROOT)||!fs.existsSync(f)||fs.statSync(f).isDirectory()){r.writeHead(404);r.end('nf');return;}
 r.writeHead(200,{'Content-Type':MIME[path.extname(f)]||'application/octet-stream'});fs.createReadStream(f).pipe(r);}).listen(PORT);
(async()=>{
let chromium;try{({chromium}=require('playwright'))}catch(_){({chromium}=require('/opt/node22/lib/node_modules/playwright'))}
const exe='/opt/pw-browsers/chromium-1194/chrome-linux/chrome';
const b=await chromium.launch(fs.existsSync(exe)?{executablePath:exe,args:['--no-sandbox']}:{args:['--no-sandbox']});
let pass=0,fail=0;
const check=(n,c,d)=>{ if(c){pass++;console.log('  PASS  '+n);} else {fail++;console.log('  FAIL  '+n+(d!==undefined?'  -> '+JSON.stringify(d):''));} };

// ---- phase 1: a browser WITH history exports a seed -----------------------
const p1=await b.newPage();
await p1.route('**/*',r=>r.request().url().startsWith('http://127.0.0.1:'+PORT)?r.continue():r.abort());
await p1.goto('http://127.0.0.1:'+PORT+'/brief-console.html',{waitUntil:'domcontentloaded'});
await p1.waitForTimeout(9000);

const phase1=await p1.evaluate(()=>{
  const R=window.SW_HVT_ROSTER;
  const eff=R.targets.length;                       // AFTER runtime promotions
  const H=window.SW_HVT_HISTORY;
  H.reset();
  // Record a synthetic-but-plausible reading for EVERY roster target, as a
  // completed run would. Values are marked synthetic; this proves the PATH,
  // it is not seed data and is never committed.
  R.targets.forEach((t,i)=>{ H.record(t.address, 1e6+i*1000, t.label); });
  const seedText=H.exportSeed();
  const st=H.stats();
  return { eff, seedText, tracked:st.tracked,
           seedBytes:seedText.length,
           hasHeader:/SW_HVT_BALANCE_SEED/.test(seedText) };
});
console.log('EFFECTIVE ROSTER (after runtime promotions): '+phase1.eff);
console.log('seed bytes for a full roster: '+phase1.seedBytes+' ('+(phase1.seedBytes/1024).toFixed(1)+' KB)\n');

console.log('1. export');
check('exportSeed() emits a SW_HVT_BALANCE_SEED file', phase1.hasHeader);
check('every roster target is represented', phase1.tracked===phase1.eff, {tracked:phase1.tracked,roster:phase1.eff});

// parse the emitted seed the way a browser would
const seedObj=await p1.evaluate(t=>{ const w={}; new Function('window',t)(w); return w.SW_HVT_BALANCE_SEED; }, phase1.seedText);
check('seed declares a version and an export date', seedObj.version===1 && /^\d{4}-\d{2}-\d{2}$/.test(seedObj.exported||''), {v:seedObj.version,e:seedObj.exported});
check('seed carries peak+last+n per address',
  Object.values(seedObj.balances).every(r=>r.peak>0&&r.last>0&&r.n>0));
await p1.close();

// ---- phase 2: a CLEAN browser loads that seed as its cold baseline --------
const p2=await b.newPage();
await p2.route('**/*',r=>{
  const u=r.request().url();
  if(!u.startsWith('http://127.0.0.1:'+PORT)) return r.abort();
  // serve the freshly-exported seed in place of the empty committed one
  if(u.endsWith('/src/shared/hvt-balance-seed.js'))
    return r.fulfill({status:200,contentType:'text/javascript',body:phase1.seedText});
  return r.continue();
});
await p2.goto('http://127.0.0.1:'+PORT+'/brief-console.html',{waitUntil:'domcontentloaded'});
await p2.waitForTimeout(9000);

const phase2=await p2.evaluate(()=>{
  const H=window.SW_HVT_HISTORY, R=window.SW_HVT_ROSTER;
  const a=R.targets[0].address;
  const localBefore=localStorage.getItem('SW_SHARED_HVT_HISTORY_V1');
  const rec=H.get(a);                                 // read the baseline
  const localAfter=localStorage.getItem('SW_SHARED_HVT_HISTORY_V1');
  const st=H.stats();
  return { seedLoaded: !!(window.SW_HVT_BALANCE_SEED&&Object.keys(window.SW_HVT_BALANCE_SEED.balances).length),
           baselineFound: !!(rec&&rec.peak>0), peak: rec&&rec.peak,
           tracked: st.tracked,
           mutatedOnRead: localBefore!==localAfter,
           hadNoLocalHistory: localBefore===null };
});
console.log('\n2. clean browser adopts the seed');
check('clean browser started with NO local history', phase2.hadNoLocalHistory);
check('committed seed is loaded', phase2.seedLoaded);
check('baseline established for a roster wallet', phase2.baselineFound, {peak:phase2.peak});
check('all targets have a baseline on first load', phase2.tracked===phase1.eff, {tracked:phase2.tracked,roster:phase1.eff});
check('reading the baseline MUTATES NOTHING', !phase2.mutatedOnRead);
await p2.close();
await b.close();srv.close();
console.log('\n'+(fail?fail+' FAILED of '+(pass+fail):'ALL '+pass+' ROUND-TRIP CHECKS PASS'));
process.exit(fail?1:0);
})();
