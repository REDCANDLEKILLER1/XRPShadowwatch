(function(root,factory){if(typeof module==='object'&&module.exports)module.exports=factory();else root.SW_MARKET_WATCH=factory();})(typeof window!=='undefined'?window:this,function(){
 'use strict';
 var HEADING='XRP/RLUSD market activity watch',LEGACY_HEADING='Market activity watch';
 function value(s){if(typeof s!=='string'||!/^\d+(?:\.\d{1,6})?$/.test(s))return null;var parts=s.split('.');return parts[0].replace(/\B(?=(\d{3})+(?!\d))/g,',')+(parts[1]?'.'+parts[1]:'');}
 function time(s){var d=new Date(s);if(!Number.isFinite(d.getTime()))return null;return d.toLocaleString('en-US',{timeZone:'America/Chicago',month:'short',day:'numeric',hour:'numeric',minute:'2-digit',timeZoneName:'short'});}
 function render(envelope){
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
  var block=render(pack.market_watch)+'\n\n',match=t.match(/(?:^|\n)(How to Read It|VERDICT|🙏 THE DAILY PRAYER|NEWS USED:)/);
  if(match){var at=match.index+(t[match.index]==='\n'?1:0);return t.slice(0,at)+block+t.slice(at);}
  return t+'\n\n'+block.trim();
 }
 async function load(fetcher){
  var controller=new AbortController(),timer;
  try{return await Promise.race([(async function(){var r=await(fetcher||fetch)('/api/forensic-report',{signal:controller.signal,cache:'no-store'});
   if(!r.ok)return{status:'UNAVAILABLE',reason:'HTTP_ERROR',http_status:r.status};var body=await r.json();return body&&['AVAILABLE','STALE','UNAVAILABLE'].indexOf(body.status)>=0?body:{status:'UNAVAILABLE',reason:'INVALID_RESPONSE'};})(),
   new Promise(function(resolve){timer=setTimeout(function(){resolve({status:'UNAVAILABLE',reason:'TIMEOUT'});controller.abort();},20000);})]);}
  catch(_){return{status:'UNAVAILABLE',reason:'NETWORK_ERROR'};}finally{clearTimeout(timer);controller.abort();}
 }
 return{render:render,inject:inject,load:load};
});
