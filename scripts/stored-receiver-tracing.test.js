'use strict';
const assert=require('assert/strict'),fs=require('fs'),vm=require('vm');
const core=fs.readFileSync('src/brief/02-core.js','utf8');
const fence=fs.readFileSync('src/brief/46-stored-evidence-client-20260927.js','utf8');
const A='r9U99zU9nSFkVPNFRSV5afuPFaMgg2HufN',B='rMCVBYFYtVJy6F4gUSd7RrM8GXApM6MNDN';
const C='rDnkcDHdMqUuD8WXgjGXPoSECWndiopzCA',D='r3bh7pmTCWUuT7PGcQ9qSYptRuWDvHMc5D';
const start=Date.parse('2026-10-06T12:00:00Z'),end=Date.parse('2026-10-07T13:01:21Z');
let active=true,legacyCalls=0,rpcCalls=0;
const row=(hash,from,to,ledger,amount=2e6,extra={})=>Object.assign({hash,from,to,ledger_index:ledger,amount,type:'Payment',currency:'XRP',tx_result:'tesSUCCESS',proves_coverage:true,date:'2026-10-07T12:00:00Z',sender_label:'watched'},extra);
const context={state:{indexRun:{anchor_ledger:100,anchor_close_ms:end},txs:[],receivers:[],txScanCoverage:{full_window_complete:true}},
  window:{SW_EVIDENCE_INDEX:{storedActive:()=>active,checkpointWallet:address=>address===B?{balance_drops:'9000000000000',balance_ledger:100}:address===C?{balance_drops:'8000000000000',balance_ledger:99}:null},addEventListener(){}},
  document:{getElementById:()=>null},setInterval:()=>0,setTimeout:()=>0,
  scanReceivers:async()=>{legacyCalls++;return 'legacy';},xrpl:async()=>{rpcCalls++;throw Error('offline');},
  getTxWindow:()=>({startMs:start,endMs:end}),_deliveredToReceiver:()=>context.receipts,KNOWN:{},BASE58_RE:/^r[1-9A-HJ-NP-Za-km-z]+$/,
  setText(){},log(){},n:x=>Number(x)||0,fmt:x=>String(x),_swWho:x=>x,_swCls:x=>x,_swConf:x=>x};
vm.createContext(context);
vm.runInContext(core.slice(core.indexOf('function renderReceiverFollowthrough('),core.indexOf('// Coordination memory —')),context);
vm.runInContext(fence,context);
(async()=>{
 context.receipts=[row('receipt',D,A,10),row('largest',D,A,20,8e6),row('b',D,B,10),row('c',D,C,10),row('d',A,D,10),
   row('unproved',D,'rFake',10,2e6,{proves_coverage:false})];
 context.state.txs=[row('before',A,D,19),row('sameledger',A,D,20),row('after',A,D,21,3e6),row('after',A,D,21,3e6),
   row('second',A,D,22,1e6),row('small',A,D,23,10),row('failed',A,D,24,5e6,{tx_result:'tecPATH_DRY'}),
   row('unproved',A,D,25,5e6,{proves_coverage:false}),row('token',A,D,26,5e6,{currency:'USD'}),
   row('escrow',A,D,27,5e6,{type:'EscrowCreate'}),row('escrowfinish',A,D,28,5e6,{type:'EscrowFinish'}),
   row('futureledger',A,D,101),row('futuretime',A,D,30,2e6,{date:'2026-10-07T14:00:00Z'}),
   row('oldtime',A,D,30,2e6,{date:'2026-10-05T14:00:00Z'}),row('self',A,A,30),row('sentinel',A,D,30,1e11)];
 const original=JSON.stringify(context.state.txs),coverage=JSON.stringify(context.state.txScanCoverage);
 const rows=await context.scanReceivers();assert.equal(rows.length,4);
 const forwarded=rows.find(r=>r.address===A);assert.equal(forwarded.forwarded_large_count,2);assert.equal(forwarded.forwarded_large_total_xrp,4e6);
 assert.equal(forwarded.tx_count,3);assert.equal(forwarded.source_hash,'largest');assert.equal(forwarded.classification,'NEXT_HOP_FORWARDING_DETECTED');
 assert.equal(forwarded.history_complete,false);assert.equal(forwarded.balance_xrp,null);assert.equal(forwarded.observed_forward_hashes.join(','),'after,second');
 const noForward=rows.find(r=>r.address===B);assert.equal(noForward.balance_xrp,9e6);assert.equal(noForward.classification,'RECEIVER_FOLLOWTHROUGH_UNPROVEN');
 assert.equal(rows.find(r=>r.address===C).balance_xrp,null,'stale balance cannot imply retained funds');
 assert.equal(rows.find(r=>r.address===D).classification,'RECEIVER_FOLLOWTHROUGH_UNPROVEN');
 assert.equal(rpcCalls,0,'no optional socket request or reacquisition');assert.equal(legacyCalls,0);
 assert.equal(JSON.stringify(context.state.txs),original);assert.equal(JSON.stringify(context.state.txScanCoverage),coverage);
 let text=context.renderReceiverFollowthrough(rows,8).join('\n');assert.match(text,/receiver history is incomplete/);assert.match(text,/follow-through unknown/);assert(!text.includes('held —'));
 const failed=context.renderReceiverFollowthrough([{address:A,classification:'NEXT_HOP_SCAN_FAILED',forwarded_large_count:0,balance_xrp:null}],1).join('');assert(!failed.includes('held'));
 context.state.indexRun.anchor_ledger=null;assert.equal((await context.scanReceivers()).length,0,'missing anchor fails closed');
 context.state.indexRun.anchor_ledger=100;await context.scanReceivers();assert.equal(context.state.receivers.length,4,'rerun replaces prior results');
 active=false;assert.equal(await context.scanReceivers(),'legacy');assert.equal(legacyCalls,1,'legacy live mode delegates unchanged');
 // Verify installation on the actual mobile console, not just isolated helpers.
 const http=require('http'),path=require('path'),browserType=require('playwright')[process.env.SW_TEST_BROWSER||'chromium'];
 const root=path.resolve('.'),port=Number(process.env.SW_TEST_PORT||8238);
 const server=http.createServer((req,res)=>{const file=path.resolve(root,'.'+new URL(req.url,'http://test').pathname);
   if(!file.startsWith(root+path.sep)||!fs.existsSync(file)||!fs.statSync(file).isFile()){res.writeHead(404);return res.end();}
   res.setHeader('Content-Type',file.endsWith('.js')?'text/javascript':'text/html');fs.createReadStream(file).pipe(res);});
 await new Promise(r=>server.listen(port,'127.0.0.1',r));let browser;
 try {
   browser=await browserType.launch({args:process.env.SW_TEST_BROWSER==='webkit'?[]:['--no-sandbox']});
   const page=await browser.newPage({viewport:{width:390,height:844},isMobile:true});
   await page.route('**/*',r=>r.request().url().startsWith('http://127.0.0.1:'+port)?r.continue():r.abort());
   await page.addInitScript(()=>{window.WebSocket=class{constructor(){this.readyState=3;}close(){}addEventListener(){}removeEventListener(){}};});
   await page.goto('http://127.0.0.1:'+port+'/brief-console.html');await page.waitForTimeout(8500);
   const result=await page.evaluate(async f=>{
     SW_EVIDENCE_INDEX.storedActive=()=>true;SW_EVIDENCE_INDEX.checkpointWallet=()=>null;
     getTxWindow=()=>({startMs:f.start,endMs:f.end});state.indexRun={anchor_ledger:100,anchor_close_ms:f.end};
     KNOWN[f.A]=undefined;KNOWN[f.B]=undefined;
     state.large=f.receipts;state.escrowLarge=[];state.txs=f.txs;
     state.txScanCoverage={full_window_complete:true};const before=JSON.stringify(state.txs);
     let requests=0;xrpl=async()=>{requests++;throw Error('offline');};
     await scanReceivers(null);
     return {rows:state.receivers,requests,untouched:before===JSON.stringify(state.txs),coverage:state.txScanCoverage,
       text:renderReceiverFollowthrough(state.receivers,10).join('\n'),installed:!!scanReceivers.__swStoredReceiverTrace};
   },{start,end,A,B,receipts:[row('source',D,A,10),row('b',D,B,10)],txs:[row('onward',A,D,11,3e6)]});
   assert(result.installed);assert.equal(result.requests,0);assert(result.untouched);assert(result.coverage.full_window_complete);
   assert.equal(result.rows.find(r=>r.address===A).forwarded_large_total_xrp,3e6);
   assert.equal(result.rows.find(r=>r.address===B).classification,'RECEIVER_FOLLOWTHROUGH_UNPROVEN');assert(!result.text.includes('held —'));
 } finally {if(browser)await browser.close();await new Promise(r=>server.close(r));}
 console.log('PASS stored receiver tracing: offline observed forwards, post-receipt order, exact deduplication, bounded proof, unknown retention, unchanged inputs/coverage, live delegation');
})().catch(e=>{console.error(e);process.exit(1);});
