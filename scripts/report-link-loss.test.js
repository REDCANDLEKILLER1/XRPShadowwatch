#!/usr/bin/env node
/* ── LINK LOSS — a balance the scan never read is not a balance of zero.
   SW-20260813-WS4WU reported "the tracked wallet board remained flat at 0 XRP
   net" on a night with 36 transfers over threshold and 145M XRP of movement.
   The scan had lost its link; absence of data was published as a finding of zero.

   Committed from a scratchpad harness that had been run by hand on every
   PR without ever being in the repo — CI cannot run what is not committed.

   Run: node scripts/report-link-loss.test.js
   Env: SW_TEST_PORT to override the port (default 8301).
──── */
const http=require('http'),fs=require('fs'),path=require('path');
const ROOT=path.join(__dirname,'..');
const PORT=Number(process.env.SW_TEST_PORT||8301);
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

const R=await p.evaluate(()=>{
  // pack with explicit counts
  const mk=(checked,total)=>({
    date:'2026-08-26', scan_link_lost:true, scan_link_lost_at:'2026-08-26T12:20:00Z',
    wallets_checked:checked, wallets_failed:Math.max(0,total-checked), watchlist_total:total,
    wallet_results:Array.from({length:total},(_,i)=>({address:'r'+i,label:'W'+i,
      status:i<checked?'CHECKED':'FAILED', balance_xrp:i<checked?1e6:0})),
    large_transfers:[], risk_score:{score:5,label:'GREEN'}
  });
  // pack with NO wallets_checked -> must fall back to counting rows
  const noCount=(checked,total)=>{const q=mk(checked,total);
    delete q.wallets_checked; delete q.wallets_failed; return q;};
  // pack with no target at all
  const noTarget=(checked)=>({ scan_link_lost:true, large_transfers:[],
    wallet_results:Array.from({length:checked},(_,i)=>({address:'r'+i,status:'CHECKED'})) ,
    get wallet_results_len(){return checked;} });
  const strip=o=>{const q=JSON.parse(JSON.stringify(o)); delete q.watchlist_total; delete q.wallets_checked;
    delete q.wallets_failed; return q;};

  const L=q=>scanIntegrity(q).line;
  return {
    zero:      L(mk(0,251)),
    one:       L(mk(1,251)),
    partial35: L(mk(35,197)),
    near:      L(mk(250,251)),
    full:      L(mk(251,251)),
    rowFallback_full:    L(noCount(251,251)),
    rowFallback_partial: L(noCount(35,197)),
    unknownTarget: (function(){ const q={scan_link_lost:true,large_transfers:[],
        wallet_results:[{status:'CHECKED'},{status:'CHECKED'}]};
        delete q.watchlist_total; return L(strip({...q, wallet_results:undefined, wallets:undefined,
        }) ) ; })(),
    unknownTarget2: L({scan_link_lost:true, large_transfers:[], wallets_checked:5}),
    healthy:   L({date:'x', wallets_checked:251, watchlist_total:251, wallet_results:[]}),
    healthySealed: scanIntegrity({date:'x',wallets_checked:251,watchlist_total:251}).sealed,
    zeroSealed:    scanIntegrity(mk(0,251)).sealed,
    // exact-match status: a hypothetical longer status must NOT count as read
    prefixTrap: L({scan_link_lost:true, large_transfers:[], watchlist_total:2,
      wallet_results:[{status:'CHECKED_PARTIAL'},{status:'CHECKED_PARTIAL'}]}),
    // audit re-run: no watchlist_total, one INVALID_ADDR. The counter sum
    // checked+failed omits invalid and used to yield target=2 -> false COMPLETE.
    invalidRow: L({scan_link_lost:true, large_transfers:[],
      wallets_checked:2, wallets_failed:0, wallets_invalid:1,
      wallet_results:[{status:'CHECKED'},{status:'CHECKED'},{status:'INVALID_ADDR'}]}),
    // same shape but the rows are absent, so the counters are the only source
    invalidCountersOnly: L({scan_link_lost:true, large_transfers:[],
      wallets_checked:2, wallets_failed:0, wallets_invalid:1}),
    // a genuinely complete run that also carries an invalid row must NOT be
    // downgraded: 3 of 3 accounted for, but only 2 returned balances
    invalidAllAccounted: L({scan_link_lost:true, large_transfers:[],
      wallets_checked:3, wallets_failed:0, wallets_invalid:0,
      wallet_results:[{status:'CHECKED'},{status:'CHECKED'},{status:'CHECKED'}]})
  };
});
const show=(k,v)=>console.log('    '+k.padEnd(20)+JSON.stringify(String(v).slice(0,132)));
console.log('  lines produced:');
['zero','one','partial35','near','full','rowFallback_full','unknownTarget2','prefixTrap'].forEach(k=>show(k,R[k]));
console.log('');
const CLAIMS_COMPLETE=/coverage figure stands/;
const SAYS_PARTIAL=/coverage below is partial/;
const SAYS_UNPROVEN=/could not be proven/;

ck('0/251  → total-outage wording, no completeness claim',
   /no balances at all/.test(R.zero) && !CLAIMS_COMPLETE.test(R.zero));
ck('1/251  → PARTIAL, states 1 of 251, never claims complete',
   SAYS_PARTIAL.test(R.one) && /Only 1 of 251/.test(R.one) && !CLAIMS_COMPLETE.test(R.one));
ck('35/197 → PARTIAL, states 35 of 197',
   SAYS_PARTIAL.test(R.partial35) && /Only 35 of 197/.test(R.partial35));
ck('250/251 → PARTIAL, not complete',
   SAYS_PARTIAL.test(R.near) && /Only 250 of 251/.test(R.near) && !CLAIMS_COMPLETE.test(R.near));
ck('251/251 → COMPLETE wording, names the total',
   CLAIMS_COMPLETE.test(R.full) && /All 251 watched wallets/.test(R.full));
ck('missing wallets_checked, full → row fallback still proves COMPLETE',
   CLAIMS_COMPLETE.test(R.rowFallback_full), R.rowFallback_full.slice(0,90));
ck('missing wallets_checked, partial → row fallback reports PARTIAL',
   SAYS_PARTIAL.test(R.rowFallback_partial) && /Only 35 of 197/.test(R.rowFallback_partial));
ck('unknown target → never infers COMPLETE, says unproven',
   SAYS_UNPROVEN.test(R.unknownTarget2) && !CLAIMS_COMPLETE.test(R.unknownTarget2), R.unknownTarget2.slice(0,90));
ck('exact status match: CHECKED_PARTIAL does NOT count as read',
   !CLAIMS_COMPLETE.test(R.prefixTrap), R.prefixTrap.slice(0,90));
ck('INVALID_ADDR row counts toward target → PARTIAL 2 of 3, not COMPLETE',
   SAYS_PARTIAL.test(R.invalidRow) && /Only 2 of 3/.test(R.invalidRow) && !CLAIMS_COMPLETE.test(R.invalidRow),
   R.invalidRow.slice(0,110));
ck('counters-only fallback includes wallets_invalid → PARTIAL 2 of 3',
   SAYS_PARTIAL.test(R.invalidCountersOnly) && /Only 2 of 3/.test(R.invalidCountersOnly),
   R.invalidCountersOnly.slice(0,110));
ck('a genuinely complete run is still reported COMPLETE',
   CLAIMS_COMPLETE.test(R.invalidAllAccounted) && /All 3 watched wallets/.test(R.invalidAllAccounted),
   R.invalidAllAccounted.slice(0,110));
ck('healthy pack → no line at all, still sealed', R.healthy==='' && R.healthySealed===true);
ck('link loss still unsealed', R.zeroSealed===false);
// ── THE CAVEAT KEYS ON THE WEAKER COVERAGE ──────────────────────────────────
// SW-20260903 run 2: 251/251 balances answered, so scanCoverage reported 100%
// and every partial-read caveat stayed silent — while only 219/251 proved their
// transaction window. A 59/100 score and a "net distributing" direction were
// published from 87% of the transaction data, unqualified, directly beneath an
// Executive Summary line reading TX WINDOW: INCOMPLETE.
const COV = await p.evaluate(() => {
  const mk = (txOk) => ({
    date:'x', wallets_checked:251, wallets_failed:0, watchlist_total:251,
    tx_scan_coverage:{ target_wallets:251, complete_wallets:txOk,
      failed_wallets:251-txOk, truncated_wallets:0,
      unproven_wallets:0, unknown_status_wallets:0, anchor_ok:true,
      full_window_complete:txOk===251 }
  });
  const H = (window.PUBLIC_REPORT_PIPELINE_V1 && window.PUBLIC_REPORT_PIPELINE_V1.helpers) || {};
  const f = (typeof H.coverageForNarrative === 'function') ? H.coverageForNarrative : null;
  if (!f) return { reachable:false };
  const short = f(mk(219)), ok = f(mk(251));
  return { reachable:true,
    shortDegraded:short.degraded, shortChecked:short.checked, shortTotal:short.total,
    shortBasis:short.basis, shortCaveat:short.caveat, shortNoun:short.basis_noun,
    okDegraded:ok.degraded, okBasis:ok.basis };
});
ck('the coverage helper is reachable through the module API', COV.reachable===true);
ck('the weaker (transaction) coverage IS flagged when balances are 251/251',
   COV.shortDegraded===true, COV);
ck('it reports the transaction numbers, not the balance ones',
   COV.shortChecked===219 && COV.shortTotal===251, COV);
ck('it names the basis so the wording can be accurate',
   COV.shortBasis==='transaction window', COV.shortBasis);
ck('its caveat says transaction window, not "failed to read"',
   /transaction window/.test(String(COV.shortCaveat||'')), COV.shortCaveat);
ck('the Verdict noun matches the basis',
   /proved the transaction window/.test(String(COV.shortNoun||'')), COV.shortNoun);
ck('a run complete on BOTH is not flagged', COV.okDegraded===false, COV);
ck('and that run reports the balance basis', COV.okBasis==='balance', COV.okBasis);

ck('no page errors', errs.length===0, errs.slice(0,3));
await b.close();srv.close();
console.log('\n'+(fail?fail+' FAILED of '+(pass+fail):'ALL '+pass+' CHECKS PASS'));
process.exit(fail?1:0);
})();
