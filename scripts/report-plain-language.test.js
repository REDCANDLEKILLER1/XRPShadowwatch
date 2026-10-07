'use strict';
const assert=require('assert/strict'),http=require('http'),fs=require('fs'),path=require('path');
const browserType=require('playwright')[process.env.SW_TEST_BROWSER||'chromium'];
const root=path.join(__dirname,'..'),port=Number(process.env.SW_TEST_PORT||8237);
const server=http.createServer((q,r)=>{
 const file=path.resolve(root,'.'+new URL(q.url,'http://local').pathname);
 if(!file.startsWith(root+path.sep)||!fs.existsSync(file)||!fs.statSync(file).isFile()){r.writeHead(404);r.end();return;}
 r.setHeader('Content-Type',file.endsWith('.js')?'text/javascript':file.endsWith('.css')?'text/css':'text/html');fs.createReadStream(file).pipe(r);
});
(async()=>{
 await new Promise(r=>server.listen(port,'127.0.0.1',r));
 const browser=await browserType.launch({args:process.env.SW_TEST_BROWSER==='webkit'?[]:['--no-sandbox']});
 try{
  const page=await browser.newPage({viewport:{width:390,height:844},isMobile:true});const errors=[];page.on('pageerror',e=>errors.push(e.message));
  const origin='http://127.0.0.1:'+port;
  await page.route('**/*',r=>r.request().url().startsWith(origin)?r.continue():r.abort());
  await page.goto(origin+'/brief-console.html',{waitUntil:'domcontentloaded'});await page.waitForTimeout(9000);
  const result=await page.evaluate(()=>{
   const A='rLHzPsX6oXkzU2qL12kHCH8G8cnZv1rBJh',B='rnJrjec2vrTJAAQUTMTjj7U6xdXrk9N4mT',C='rw2ciyaNshpHe7bCHo4bRWq6pqqynnWKQg',U='rsyDbFqTfyaBBLGBrEqLkTmZKmhArCUDC0';
   window.SW_WALLET_IDENTITIES=Object.assign({},window.SW_WALLET_IDENTITIES,{[A]:{name:'Kraken',provenance:'xrpscan'},[B]:{name:'Kraken',provenance:'xrpscan'},[C]:{name:'Coinbase',provenance:'xrpscan'}});
   const W=WATCHLIST.slice(0,20).map(w=>({...w,status:'CHECKED',balance_xrp:1000000,prev_balance_xrp:1000000,delta_xrp:0}));
   const pack={date:'2026-10-06',scan_id:'SC-EDITORIAL-FIXTURE',wallets_checked:20,wallets_failed:0,wallets_invalid:0,watchlist_total:20,wallet_results:W,
    tx_scan_coverage:{target_wallets:20,complete_wallets:20,failed_wallets:0,truncated_wallets:0,unproven_wallets:0,unknown_status_wallets:0,anchor_ok:true,counts_reconcile:true,full_window_complete:true},
    tx_window:{label:'LAST 24H'},xrp_price:1.5098,xrp_delta_24h_pct:-0.1,total_balance_delta_xrp:-12410000,shadow_volume_xrp:112000000,tx_24h_count:54034,total_tx_xrp:409610000,active_wallets:18,
    large_transfers:[{from:A,to:B,amount:100000000,hash:'a'.repeat(64)},{from:U,to:C,amount:6000000,hash:'b'.repeat(64)},{from:U,to:C,amount:6000000,hash:'c'.repeat(64)}],receiver_followthrough:[],offers_scanned_count:12,
    risk_score:{score:41,label:'YELLOW / WATCH',drivers:['large transfer count','shadow volume','dust/tag flags']},
    evidence_freshness:{evidence_time:'2026-10-06T10:19:40.000Z',status:'LAST_GOOD_STALE'},
    evidence_index:{stored_checkpoint:true},live_enrichment_unavailable:true};
   state.txs=[];state.escrow=[];state.discoveryInbox=[];
   state.rippleEscrowPosition={complete:true,locked_xrp:31400000000,active_objects:98,answered_owners:20,expected_owners:20};
   window.SW_SHADOW_FLOW_TIMING_20260816.metrics=()=>({transfer_count:476,total_xrp:122030000,clustered_transfer_count:420,clustered_flow_xrp:106710000,cluster_pattern_count:59});
   const input=JSON.parse(JSON.stringify(pack)),api=window.PUBLIC_REPORT_PIPELINE_V1;
   const interpretations=JSON.stringify(api.assemble(pack).interpretations);
   const text=String(canonicalMorningStory(pack,{rebuild:true}));
   const raw=api.assemble(pack).text;
   const inputsUnchanged=Object.keys(input).every(k=>JSON.stringify(input[k])===JSON.stringify(pack[k])),interpretationsUnchanged=interpretations===JSON.stringify(api.assemble(pack).interpretations);
   const lost={...pack,scan_link_lost:true,offers_scanned_count:undefined};
   const incomplete={...pack,tx_scan_coverage:{...pack.tx_scan_coverage,complete_wallets:19,unproven_wallets:1,full_window_complete:false}};
   const unknown={...pack};delete unknown.tx_scan_coverage;
   const onward={...pack,receiver_followthrough:[{address:B,forwarded_large_count:2,forwarded_large_total_xrp:5000000}]};
   const holding={...pack,receiver_followthrough:[{address:B,classification:'RECEIVER_STILL_HOLDING_SIZE',balance_xrp:37000000}]};
   const band={...pack,market:{price:1.33,pct24h:-0.1},forensic_memory:{band_hold_days:20}};
   const quiet={...pack,large_transfers:[],shadow_volume_xrp:0,tx_24h_count:0,total_tx_xrp:0,total_balance_delta_xrp:0,xrp_price:0,risk_score:{score:5,drivers:[]}};
   return {text,raw,onward:api.assemble(onward).text,holding:api.assemble(holding).text,band:api.assemble(band).text,lost:api.render(lost),incomplete:api.render(incomplete),unknown:api.render(unknown),quiet:api.render(quiet),published:SW_PUBLIC_MORNING_4K_20260817.publicText(text),inputsUnchanged,interpretationsUnchanged,mode:window._SW_REPORT_MODE};
  });
  assert(result.inputsUnchanged,'editorial rendering must not mutate evidence');assert(result.interpretationsUnchanged,'rendering must not change interpretations');
  assert.match(result.raw,/112M XRP moved across 3 large transfers during the last 24h/);
  assert.match(result.text,/100M XRP.*internal to Kraken/);assert.match(result.text,/6M XRP moved from/);
  assert.equal((result.raw.match(/6M XRP moved from/g)||[]).length,1,'lead transfer is narrated once');
  assert.match(result.onward,/recipient of the largest transfer later sent 5M XRP onward in 2 large transactions/);
  assert.equal((result.onward.match(/5M XRP onward/g)||[]).length,1,'follow-through detail is retained once');
  assert.match(result.holding,/still holding about 37M XRP/);
  assert.match(result.band,/approximately 20 days/);assert(!/external pressure or managed absorption/.test(result.band));
  assert.match(result.raw,/moderate watch score \(41\/100\)/);assert.match(result.raw,/not a price forecast or proof of wrongdoing/);
  assert.match(result.text,/12\.41M XRP outward/);assert(!/−12\.41M XRP outward/.test(result.text));
  assert.match(result.text,/122\.03M XRP.*476 payments/);assert.match(result.text,/106\.71M XRP.*420.*59/);
  assert.match(result.text,/several wallets sending to one/);assert.match(result.text,/one wallet sending to several/);
  const flow=result.text.split('Under the Surface\n')[1].split('How to Read It\n')[0];assert(!/112M XRP/.test(flow),'mid-size section does not repeat whale total');
  assert.match(result.text,/31\.40B XRP locked now/);assert.match(result.text,/98 active validated-ledger escrow objects/);assert.match(result.text,/registry check 20\/20/);
  assert.match(result.text,/count is of separate locks, not wallets/);assert.match(result.text,/not every escrow on the XRPL/);
  assert.match(result.text,/2026-10-06T10:19:40.000Z.*LAST GOOD STALE/);assert.match(result.text,/Live order\/offer sweep: not collected/);
  assert.match(result.lost,/SCAN INCOMPLETE — CONNECTION LOST/);assert.match(result.lost,/REPORT NOT SEALED/);assert.match(result.lost,/not a verdict/);
  assert.match(result.incomplete,/19 of 20 watched wallets proved the requested window/);assert.match(result.incomplete,/1 unproven/);assert.match(result.incomplete,/withholding an all-clear/);
  assert.match(result.unknown,/coverage was not established/);assert.match(result.quiet,/watched-wallet record/);
  for(const s of ['THE DAILY PRAYER','THE DAILY SCRIPTURE','I’m XRPMan, and I tell on the banks.'])assert(result.text.includes(s),s);
  assert(result.published.length<=4000);assert.match(result.published,/\(41\/100\)/);assert.match(result.published,/31\.40B/);
  assert(!/banks like to move|single, deliberate|every transfer is a confession|where they land tells me who/i.test(result.text));
  assert.equal(errors.length,0,errors.join('\n'));
  if(process.env.SW_REPORT_PREVIEW){
   fs.mkdirSync(path.join(root,'docs'),{recursive:true});
   fs.writeFileSync(path.join(root,'docs/report-editorial-preview.md'),'# ShadowWatch editorial preview\n\nGenerated by the real canonical renderer from a controlled test fixture. These are illustrative fixture findings, not a new live scan. The fixture uses the October 6 market, flow and escrow figures alongside three synthetic large-transfer rows.\n\n```text\n'+result.text+'\n```\n\nThe publishable copy is '+result.published.length+' characters; the full canonical report is '+result.text.length+' characters.\n');
  }
  console.log('PASS plain-language canonical report, unique transfer lead, exact amounts and score, untouched inputs, incomplete/unknown safeguards, flow/escrow explanations, 4K copy, mobile rendering');
 }finally{await browser.close();await new Promise(r=>server.close(r));}
})().catch(e=>{console.error(e);server.close();process.exit(1);});
