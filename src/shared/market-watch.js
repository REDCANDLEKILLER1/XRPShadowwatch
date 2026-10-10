(function(root,factory){if(typeof module==='object'&&module.exports)module.exports=factory();else root.SW_MARKET_WATCH=factory();})(typeof window!=='undefined'?window:this,function(){
 'use strict';
 var HEADING='XRP/RLUSD market activity watch',LEGACY_HEADING='Market activity watch';
 function value(s){if(typeof s!=='string'||!/^\d+(?:\.\d{1,6})?$/.test(s))return null;var parts=s.split('.');return parts[0].replace(/\B(?=(\d{3})+(?!\d))/g,',')+(parts[1]?'.'+parts[1]:'');}
 function time(s){var d=new Date(s);if(!Number.isFinite(d.getTime()))return null;return d.toLocaleString('en-US',{timeZone:'America/Chicago',month:'short',day:'numeric',hour:'numeric',minute:'2-digit',timeZoneName:'short'});}
 function renderWallet(envelope){
  var e=envelope||{},s=e.summary;
  if(e.status==='STALE'&&s&&time(s.window_end))return HEADING+'\nThe latest market-activity analysis ended '+time(s.window_end)+'. It is too old to describe current activity.';
  if(e.status!=='AVAILABLE'||!s||s.schema!=='shadowwatch-forensic-report/1'||!time(s.window_end)||value(s.xrp_sold_for_rlusd)===null||value(s.xrp_bought_with_rlusd)===null)
   return HEADING+'\nVerified XRP/RLUSD trading-pattern analysis is not available for this report.'+
    (e.reason==='TIMEOUT'?' The analysis request timed out.':e.reason==='HTTP_ERROR'?' The analysis service could not provide a result.':e.reason==='NETWORK_ERROR'?' The analysis request could not be completed.':'')+
    ' Missing analysis does not mean zero XRP/RLUSD trading. This does not establish that no activity occurred.';
  var lines=[HEADING,'Observation period: '+time(s.window_start)+' to '+time(s.window_end)+'.'];
  if(s.exchange_transactions>0)lines.push('In the analyzed wallet records, '+value(s.xrp_sold_for_rlusd)+' XRP was exchanged for RLUSD, and '+value(s.xrp_bought_with_rlusd)+' XRP was bought with RLUSD. These are observed wallet flows, not total market volume.');
  else if(s.classified_records>0)lines.push('No qualifying XRP/RLUSD exchanges were identified in the records analyzed. Other assets and venues are outside this measurement.');
  else lines.push('There are no classified records in this observation period, so no trading-activity conclusion is available.');
  var patterns=[];
  if(s.repeated_quote_wallets>0)patterns.push(s.repeated_quote_wallets+' wallet'+(s.repeated_quote_wallets===1?'':'s')+' repeatedly quoted the same price');
  if(s.repeated_cancel_wallets>0)patterns.push(s.repeated_cancel_wallets+' wallet'+(s.repeated_cancel_wallets===1?'':'s')+' repeatedly canceled orders');
  if(s.regular_transfer_wallets>0)patterns.push(s.regular_transfer_wallets+' wallet'+(s.regular_transfer_wallets===1?'':'s')+' sent transfers at regular intervals');
  if(patterns.length)lines.push('Patterns to watch: '+patterns.join('; ')+'.');
  if(s.unclassified_records>0)lines.push(s.unclassified_records+' records could not be classified.');
  lines.push('These observations do not establish who controls the wallets or whether anyone is controlling the price.');
  return lines.join('\n');
 }
 function inject(text,pack){
  if(!pack||!Object.prototype.hasOwnProperty.call(pack,'market_watch'))return text;
  var t=String(text||'');if(t.indexOf(HEADING+'\n')>=0||t.indexOf(LEGACY_HEADING+'\n')>=0)return t;
  var block=render(pack.market_watch,{asOf:pack.market_watch_as_of_utc})+'\n\n',match=t.match(/(?:^|\n)(How to Read It|VERDICT|🙏 THE DAILY PRAYER|NEWS USED:)/);
  if(match){var at=match.index+(t[match.index]==='\n'?1:0);return t.slice(0,at)+block+t.slice(at);}
  return t+'\n\n'+block.trim();
 }
 function instant(v){if(v===null||v===undefined||v==='')return null;var n=typeof v==='number'?v:Date.parse(v);return Number.isFinite(n)?n:null;}
 function reference(envelope,options){return instant(options&&options.asOf)??instant(envelope&&envelope.checked_at);}
 function minutes(ms){var n=Math.max(0,Math.ceil(ms/60000));return n+' minute'+(n===1?'':'s');}
 function collectorStatus(e,asOf){
  var s=e&&e.summary,at=instant(asOf),generated=instant(s&&s.generated_at);
  if(!s||s.schema!=='shadowwatch-market-coverage/1'||!s.coverage||!s.executions||!s.storage||generated===null||
   ['AVAILABLE','STALE'].indexOf(e.status)<0||(at!==null&&generated>at+300000))return 'UNAVAILABLE';
  return e.status==='STALE'||(at!==null&&at-generated>45*60000)?'STALE':'AVAILABLE';
 }
 function collectorLabel(e,asOf){
  var status=collectorStatus(e,asOf),s=e&&e.summary;
  if(status==='UNAVAILABLE')return 'Collection status unavailable';
  if(status==='STALE')return 'Collector needs an update';
  if(s.state==='CAPPED')return 'Collection limit reached';
  if(s.state==='GAP'||s.state==='ERROR')return 'Collection needs attention';
  if((s.coverage.missing_ranges||[]).length)return 'Saved sample · missing coverage';
  return 'Saved sample · limited coverage';
 }
 function overview(envelope,options){
  var e=envelope||{},at=reference(e,options),walletEnvelope=e,w=e.summary;
  // Use one explicit time for a saved report. The dashboard supplies its current
  // render time, so an old AVAILABLE response cannot stay fresh indefinitely.
  if(e.status==='AVAILABLE'&&w&&at!==null&&instant(w.window_end)!==null&&at-instant(w.window_end)>36*3600000)walletEnvelope=Object.assign({},e,{status:'STALE'});
  var walletLines=renderWallet(walletEnvelope).split('\n').slice(1),found=[],missing=[],meaning=[];
  walletLines.forEach(function(line){
   if(/^Observation period:/.test(line))missing.push(line.replace('Observation period:','Watched-wallet analysis window:'));
   else if(/^These observations/.test(line))return;
   else if(walletEnvelope.status!=='AVAILABLE'||/could not be classified|no classified records/i.test(line))missing.push(line);
   else found.push(line);
  });
  var ce=e.collector||{status:'UNAVAILABLE'},s=ce.summary,status=collectorStatus(ce,at);
  if(status==='UNAVAILABLE')missing.push('Ledger-wide collection coverage is unavailable. Missing evidence does not mean zero trading.');
  else{
   var c=s.coverage,t=s.executions,b=s.storage,gaps=c.missing_ranges||[];
   found.push('Ledger-wide XRP/RLUSD collector: '+c.verified_ledgers+' verified ledgers (ledger snapshots)'+(Number.isSafeInteger(t.transactions)?', '+t.transactions+' transactions':'')+' since activation.');
   if(status==='AVAILABLE'){
    found.push(t.order_book_fills+' verified order-book fill'+(t.order_book_fills===1?'':'s')+' ('+t.partial_fills+' partial): matched amounts of '+t.order_book_xrp+' XRP and '+t.order_book_rlusd+' RLUSD.');
    found.push(t.amm_swaps?'AMM swaps: '+t.amm_swaps+'; net pool movement '+t.amm_xrp+' XRP / '+t.amm_rlusd+' RLUSD, including fees.':'No verified XRP/RLUSD AMM swaps in this collected sample.');
    if(t.liquidity_operations)missing.push(t.liquidity_operations+' AMM liquidity operations were excluded from swap totals.');
    if(t.unclassified_transactions)missing.push(t.unclassified_transactions+' transactions could not yet be classified; trade totals are incomplete.');
   }else missing.push('The collector snapshot is too old to describe current activity; execution totals are withheld until an update arrives.');
   missing.push('Collector snapshot saved '+time(s.generated_at)+(at!==null?' ('+minutes(at-Date.parse(s.generated_at))+' old at '+time(new Date(at).toISOString())+')':'')+'.');
   missing.push(c.last_verified_close?'Latest verified ledger closed '+time(c.last_verified_close)+(at!==null?' ('+minutes(at-Date.parse(c.last_verified_close))+' before that check)':'')+'.':'Latest verified ledger time is unavailable.');
   if(gaps.length)missing.push('Missing ranges at that snapshot: '+gaps.map(function(r){return r.from+'–'+r.through+' ('+r.reason+')';}).join('; ')+'. The backlog may have grown.');
   else missing.push('No gaps were recorded up to the last observed ledger. This does not establish current or continuous coverage.');
   if(s.state==='CAPPED')missing.push('The saved run stopped at a collection limit.');
   if(s.state==='GAP'||s.state==='ERROR')missing.push('The saved run needs attention before coverage can advance.');
   missing.push('Private storage: '+(b.bucket_bytes/1e9).toFixed(3)+' / '+(b.bucket_limit/1e9).toFixed(0)+' GB. Daily collection budget: '+(b.daily_charged_bytes/1048576).toFixed(2)+' / '+(b.daily_limit/1048576).toFixed(0)+' MiB ('+b.day_utc+' UTC).');
  }
  meaning.push('Wallet flows and collected trades cover different records and periods; do not add their totals. These samples are not total market volume or proof of bots, wallet ownership, or price control.');
  meaning.push('Collection targets a run every 15 minutes, with at most four new ledgers per run. It cannot keep up with XRPL; a saved result does not confirm scheduled runs.');
  return{title:HEADING,label:collectorLabel(ce,at),asOf:at,collectorStatus:status,walletStatus:walletEnvelope.status,sections:[
   {title:'What we found',lines:found.length?found:['No verified trading findings are available for this view.']},
   {title:'What’s missing',lines:missing},{title:'Why it matters',lines:meaning}]};
 }
 function renderCollector(e,options){
  var s=e&&e.summary;
  var status=collectorStatus(e,options&&options.asOf);
  if(status==='UNAVAILABLE')return 'Ledger-wide XRP/RLUSD collector\nCollection coverage is unavailable. Missing evidence does not mean zero trading.';
  var c=s.coverage,t=s.executions,b=s.storage;
  var lines=['Ledger-wide XRP/RLUSD collector',
   'Saved run status: '+(status==='STALE'?'STALE · ':'')+s.state+'. Snapshot: '+time(s.generated_at)+'. This is a saved result, not a live-running indicator.',
   'Verified '+c.verified_ledgers+' ledgers since activation at '+c.start+'. Next ledger: '+c.next+'. Latest observed ledger: '+(c.observed_tip===null?'unknown':c.observed_tip)+'.',
   'Collection lag at snapshot: '+Math.ceil(c.collection_delay_ms/60000)+' minutes. Gap beyond the 15-minute run target: '+Math.ceil(c.schedule_delay_ms/60000)+' minutes.'];
  if(c.missing_ranges.length)lines.push('Missing ranges: '+c.missing_ranges.map(function(r){return r.from+'–'+r.through+' ('+r.reason+')';}).join('; ')+'.');
  lines.push('Private storage: '+(b.bucket_bytes/1000000000).toFixed(3)+' / '+(b.bucket_limit/1000000000).toFixed(0)+' GB. Collector daily charged budget ('+b.day_utc+' UTC): '+(b.daily_charged_bytes/1048576).toFixed(2)+' / '+(b.daily_limit/1048576).toFixed(0)+' MiB.');
  if(status!=='STALE'){
   lines.push('Since activation: '+t.order_book_fills+' verified order-book fill'+(t.order_book_fills===1?'':'s')+' ('+t.partial_fills+' partial), with matched amounts of '+t.order_book_xrp+' XRP and '+t.order_book_rlusd+' RLUSD.');
   lines.push('AMM swaps: '+t.amm_swaps+'; net pool movement '+t.amm_xrp+' XRP / '+t.amm_rlusd+' RLUSD, including pool fees.');
   lines.push(t.unclassified_transactions+' transactions need further reconciliation; '+t.liquidity_operations+' AMM operations excluded from swap totals.');
  }else lines.push('This snapshot is stale; execution totals are withheld until a fresh collector summary is available.');
  lines.push('Coverage begins at activation. These are observed liquidity executions, not total market volume, continuous coverage, or proof of price control.');
  return lines.join('\n');
 }
 function render(envelope,options){
  if(!envelope||!envelope.collector)return renderWallet(envelope);
  var model=overview(envelope,options);
  return model.title+'\n'+model.sections.map(function(section){return section.title+'\n'+section.lines.join('\n');}).join('\n\n');
 }
 async function load(fetcher){
  var controller=new AbortController(),timer,collector,base;
  async function read(url){try{var r=await(fetcher||fetch)(url,{signal:controller.signal,cache:'no-store'});
   if(!r.ok)return{status:'UNAVAILABLE',reason:'HTTP_ERROR',http_status:r.status};var body=await r.json();
   return body&&['AVAILABLE','STALE','UNAVAILABLE'].indexOf(body.status)>=0?body:{status:'UNAVAILABLE',reason:'INVALID_RESPONSE'};
  }catch(_){return{status:'UNAVAILABLE',reason:'NETWORK_ERROR'};}}
  try{return await Promise.race([Promise.all([
   read('/api/forensic-report').then(function(v){base=v;}),read('/api/market-coverage').then(function(v){collector=v;})
  ]).then(function(){return Object.assign({},base,{collector:collector});}),
   new Promise(function(resolve){timer=setTimeout(function(){resolve(Object.assign({},base||{status:'UNAVAILABLE',reason:'TIMEOUT'},
    {collector:collector||{status:'UNAVAILABLE',reason:'TIMEOUT'}}));controller.abort();},20000);})]);}
  finally{clearTimeout(timer);controller.abort();}
 }
 return{render:render,renderWallet:renderWallet,renderCollector:renderCollector,overview:overview,collectorStatus:collectorStatus,collectorLabel:collectorLabel,inject:inject,load:load};
});
