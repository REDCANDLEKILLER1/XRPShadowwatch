#!/usr/bin/env node
'use strict';

const http=require('http'), fs=require('fs'), path=require('path');
const ROOT=path.join(__dirname,'..');
const PORT=Number(process.env.SW_TEST_PORT||8234);
const MIME={'.html':'text/html','.js':'text/javascript','.css':'text/css','.json':'application/json','.svg':'image/svg+xml','.png':'image/png'};
function serve(){return http.createServer((q,r)=>{let u=decodeURIComponent(q.url.split('?')[0]); if(u==='/')u='/brief-console.html'; const f=path.join(ROOT,u); if(!f.startsWith(ROOT)||!fs.existsSync(f)||fs.statSync(f).isDirectory()){r.writeHead(404);r.end('not found');return;} r.writeHead(200,{'Content-Type':MIME[path.extname(f)]||'application/octet-stream'}); fs.createReadStream(f).pipe(r);}).listen(PORT);}
function chromium(){try{return require('playwright').chromium;}catch(_){return require('/opt/node22/lib/node_modules/playwright').chromium;}}
let pass=0,fail=0;
function check(name,ok,detail){if(ok){pass++;console.log('  PASS  '+name);}else{fail++;console.log('  FAIL  '+name+(detail!==undefined?' -> '+JSON.stringify(detail):''));}}

(async()=>{
 const srv=serve();
 const exe='/opt/pw-browsers/chromium-1194/chrome-linux/chrome';
 const b=await chromium().launch(fs.existsSync(exe)?{executablePath:exe,args:['--no-sandbox']}:{args:['--no-sandbox']});
 const p=await b.newPage();
 const pageErrors=[]; p.on('pageerror',e=>pageErrors.push(e.stack||e.message));
 await p.route('**/*',r=>r.request().url().startsWith('http://127.0.0.1:'+PORT)?r.continue():r.abort());
 await p.goto('http://127.0.0.1:'+PORT+'/brief-console.html',{waitUntil:'domcontentloaded'});
 await p.waitForFunction(()=>typeof buildIntelBrief==='function' && typeof runAutoWalletDiscovery==='function' && typeof attachNewsHealthToPack==='function',null,{timeout:60000});
 await p.waitForTimeout(5000);

 const out=await p.evaluate(()=>{
   const result={stages:[],txCount:152500};
   const watched=(typeof WATCHLIST!=='undefined'?WATCHLIST:[]).slice(0,423);
   if(!watched.length) return {error:'WATCHLIST_MISSING'};
   const a=watched[0].address,b=watched[1].address;
   const txs=new Array(result.txCount);
   for(let i=0;i<txs.length;i++){
     txs[i]={hash:'SYN'+i,from:(i%2?a:b),to:(i%3?b:a),amount:100000+(i%900000),currency:'XRP',type:'Payment',
       tx_result:'tesSUCCESS',date:new Date(1760000000000+i*1000).toISOString(),timestamp:new Date(1760000000000+i*1000).toISOString()};
   }
   state.txs=txs;
   state.wallets=watched.map((w,i)=>Object.assign({},w,{status:'CHECKED',balance_xrp:1000000+i,prev_balance_xrp:999000+i,delta_xrp:1000}));
   state.large=[];
   state.escrowLarge=[];
   state.frags=[];
   state.receivers=[];
   state.clusters=[];
   state.walletProfiles=state.wallets.map(w=>({address:w.address,label:w.label,archetype:'QUIET_HOLDER'}));
   state.behavioralClusters={clusters:[],cluster_count:0};
   state.relatedOffers={candidates_by_watched:{}};
   state.coordination={pairs:[],snapshots_analyzed:0};
   state.discoveryInbox=[];
   state.discoveryHistory=[];
   state.newsIntel={items:[
     {title:'XRP Ledger activity rises',summary:'XRPL payments and liquidity',source:'U.Today',url:'https://u.today/xrp-ledger'},
     {title:'Ripple XRP ETF update',summary:'XRP institutional custody',source:'Coinpedia',url:'https://coinpedia.org/xrp-etf'},
     {title:'RLUSD liquidity expands',summary:'Ripple stablecoin liquidity',source:'NewsBTC',url:'https://newsbtc.com/rlusd'},
     {title:'XRP whale movement',summary:'XRP whale transfer',source:'Bitcoinist',url:'https://bitcoinist.com/xrp-whale'},
     {title:'XRPL account growth',summary:'XRP Ledger accounts',source:'CryptoSlate',url:'https://cryptoslate.com/xrpl'}
   ],top_headlines:[],source_status:{rss_feeds:'OK'},source_breakdown:{'U.Today':1,Coinpedia:1,NewsBTC:1,Bitcoinist:1,CryptoSlate:1},
      macro_risk_score:0,regulatory_score:0,banking_stress_score:0,war_oil_score:0};
   const pack={date:'2026-09-26',scan_id:'SC-STACKTEST',report_id:'SW-20260926-STACK1',wallet_results:state.wallets,
     wallets_checked:state.wallets.length,watchlist_total:state.wallets.length,wallets_failed:0,wallets_invalid:0,
     tx_scan_coverage:{target_wallets:state.wallets.length,complete_wallets:state.wallets.length,failed_wallets:0,truncated_wallets:0,unproven_wallets:0,unknown_status_wallets:0,anchor_ok:true,full_window_complete:true},
     tx_24h_count:txs.length,total_tx_xrp:0,total_balance_delta_xrp:state.wallets.length*1000,ordinary_balance_delta_xrp:state.wallets.length*1000,
     shadow_volume_xrp:0,large_transfers:[],fragmentation_flags:[],receiver_followthrough:[],xrp_price:1.5,xrp_delta_24h_pct:0,
     news_intel:state.newsIntel,risk_score:{score:10,label:'GREEN / QUIET',drivers:[]}};
   state.pack=pack;
   state.riskScore=pack.risk_score;

   function stage(name,fn){
     const t=performance.now();
     try{const v=fn(); result.stages.push({name,ok:true,ms:Math.round(performance.now()-t),kind:typeof v}); return v;}
     catch(e){result.stages.push({name,ok:false,ms:Math.round(performance.now()-t),error:e&&e.message,stack:String(e&&e.stack||'').slice(0,2500)}); throw e;}
   }
   try{
     stage('discovery',()=>runAutoWalletDiscovery(pack));
     stage('pattern-snapshot',()=>savePatternSnapshot(pack));
     stage('wallet-memory',()=>updateWalletMemory(pack));
     stage('pattern-memory',()=>updatePatternMemory(pack));
     stage('news-intent',()=>attachNewsIntentToPack(pack));
     stage('news-health',()=>attachNewsHealthToPack(pack));
     stage('intel-brief',()=>buildIntelBrief(pack));
     result.ok=true;
   }catch(e){result.ok=false; result.error=e&&e.message;}
   return result;
 });

 console.log('POST-NEWS STACK REGRESSION');
 console.log(JSON.stringify(out,null,2));
 check('fixture carries at least 150k canonical transactions',out.txCount>=150000,out.txCount);
 check('late intelligence sequence does not overflow',out.ok===true,out);
 check('discovery completed',!!out.stages.find(x=>x.name==='discovery'&&x.ok),out.stages);
 check('news health completed',!!out.stages.find(x=>x.name==='news-health'&&x.ok),out.stages);
 check('Intel Brief completed',!!out.stages.find(x=>x.name==='intel-brief'&&x.ok),out.stages);
 check('no page errors',pageErrors.length===0,pageErrors.slice(0,3));
 await b.close();srv.close();
 console.log('\n'+(fail?fail+' FAILED of '+(pass+fail):'ALL '+pass+' CHECKS PASS'));
 process.exit(fail?1:0);
})().catch(e=>{console.error(e);process.exit(1);});
