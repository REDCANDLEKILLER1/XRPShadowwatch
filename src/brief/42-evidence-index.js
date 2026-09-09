(function(){
  'use strict';
  var MAX_EVIDENCE_CONCURRENCY=4;
  var AUTO_ROSTER_URL='/src/shared/auto-watchlist.json';
  var AUTO_PROMOTION_URL='/api/roster-promotion';
  var active=0, queue=[], metrics=null, autoRosterAdded=0;
  function slot(){return new Promise(function(resolve){queue.push(resolve);pump();});}
  function pump(){if(active>=MAX_EVIDENCE_CONCURRENCY||!queue.length)return;active++;queue.shift()(function(){active--;pump();});pump();}
  async function call(action,input,write){
    var params=Object.assign({action:action},input||{});
    var controller=new AbortController(), timer=setTimeout(function(){controller.abort();},290000);
    try {
    var response=await fetch('/api/evidence'+(write?'':'?'+new URLSearchParams(params)),write?{
      method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(params),cache:'no-store'
      ,signal:controller.signal
    }:{cache:'no-store',signal:controller.signal});
    var data;try{data=await response.json();}catch(_){throw new Error('EVIDENCE_STORE_UNAVAILABLE');}
    if(!response.ok){var failure=new Error(data.error||'EVIDENCE_REQUEST_FAILED');failure.transport=data.transport||null;throw failure;}
    return data;
    } catch(e) {if(e.name==='AbortError')throw new Error('EVIDENCE_RESPONSE_TIMEOUT');throw e;}
    finally {clearTimeout(timer);}
  }
  function validAddress(value){return /^r[1-9A-HJ-NP-Za-km-z]{24,35}$/.test(String(value||''));}
  async function mergeAutoRoster(accounts){
    var chosen=Array.isArray(accounts)?accounts.slice():[];
    try{
      var watch=(typeof WATCHLIST!=='undefined'&&Array.isArray(WATCHLIST))?WATCHLIST:null;
      var fullRoster=!!watch&&watch.length>0&&watch.every(function(w){return w&&chosen.indexOf(w.address)>=0;});
      var response=await fetch(AUTO_ROSTER_URL+'?v='+Date.now(),{cache:'no-store'});
      if(!response.ok)return chosen;
      var payload=await response.json();
      var entries=payload&&Array.isArray(payload.entries)?payload.entries:[];
      var added=0;
      entries.forEach(function(item){
        if(!item||!validAddress(item.address))return;
        var entry={label:String(item.handle||('AUTO_'+item.address.slice(0,6)+'_'+item.address.slice(-4))),
          address:item.address,cat:String(item.cat||'discovered_receiver')};
        if(watch&&!watch.some(function(w){return w&&w.address===entry.address;})){watch.push(entry);added++;}
        try{if(typeof KNOWN!=='undefined'&&KNOWN&&!KNOWN[entry.address])KNOWN[entry.address]=entry;}catch(_){}
        if(fullRoster&&chosen.indexOf(entry.address)<0)chosen.push(entry.address);
      });
      autoRosterAdded=added;
      if(added&&typeof populateScanTarget==='function')try{populateScanTarget();}catch(_){}
      if(added&&typeof log==='function')log('Auto watchlist: '+added+' GitHub-promoted candidate(s) joined this run.');
    }catch(e){
      if(typeof log==='function')log('Auto watchlist unavailable; continuing with committed base roster: '+e.message);
    }
    return chosen;
  }
  function readyPromotionCandidates(){
    try{
      if(typeof state==='undefined'||!Array.isArray(state.discoveryInbox))return [];
      return state.discoveryInbox.filter(function(c){
        return c&&validAddress(c.address)&&!c.is_already_watched&&c.recommended_action==='ADD'&&
          (c.action_tier==='CRITICAL_ADD_REVIEW'||c.action_tier==='RECOMMEND_FOR_WATCH')&&
          c.review_status!=='REJECTED'&&c.review_status!=='IGNORED';
      }).slice(0,5).map(function(c){
        return {address:c.address,suggested_label:c.suggested_label||null,suggested_category:c.suggested_category||null,
          classification:c.classification||null,score:Number(c.score)||0,action_tier:c.action_tier,
          recommended_action:c.recommended_action,review_status:c.review_status||'NEW'};
      });
    }catch(_){return [];}
  }
  async function submitReadyPromotions(seal){
    var archive;
    try{archive=(typeof state!=='undefined')&&state.githubArchive;}catch(_){archive=null;}
    if(!archive||(['ARCHIVED','ALREADY_ARCHIVED'].indexOf(archive.status)<0))return null;
    var candidates=readyPromotionCandidates();
    if(!candidates.length)return null;
    var indexRun=null;
    try{indexRun=state.indexRun;}catch(_){}
    if(!seal||!seal.report_id||!seal.scan_id||!indexRun||!indexRun.scan_id)return null;
    var response=await fetch(AUTO_PROMOTION_URL,{method:'POST',headers:{'Content-Type':'application/json'},cache:'no-store',
      body:JSON.stringify({report_id:seal.report_id,scan_id:seal.scan_id,evidence_scan_id:indexRun.scan_id,candidates:candidates})});
    var result=await response.json().catch(function(){return {status:'FAILED',error:'ROSTER_PROMOTION_RESPONSE_INVALID'};});
    try{state.githubRosterPromotion=result;}catch(_){}
    if(metrics)metrics.auto_promotion=result;
    if(!response.ok)throw new Error(result.error||'ROSTER_PROMOTION_FAILED');
    if(typeof log==='function')log('Auto watchlist: '+(result.added||0)+' candidate(s) promoted to GitHub; '+(result.skipped||0)+' skipped.');
    return result;
  }
  function installArchivePromotionHook(){
    if(typeof window==='undefined')return;
    window.addEventListener('load',function(){
      try{
        var original=window.archiveSealedReport;
        if(typeof original!=='function'||original._swAutoCandidatePromotion)return;
        var wrapped=async function(p,seal){
          var result=await original.apply(this,arguments);
          try{await submitReadyPromotions(seal);}catch(e){
            try{if(typeof elog==='function')elog('Auto watchlist promotion',e);else if(typeof log==='function')log('Auto watchlist promotion failed: '+e.message);}catch(_){}
          }
          return result;
        };
        wrapped._swAutoCandidatePromotion=true;
        window.archiveSealedReport=wrapped;
      }catch(_){}
    },{once:true});
  }
  installArchivePromotionHook();
  window.SW_EVIDENCE_INDEX={
    begin:async function(windowRange,accounts){
      accounts=await mergeAutoRoster(accounts);
      var run=await call('begin',{start_ms:windowRange.startMs,end_ms:windowRange.endMs,accounts:accounts},true);
      if(run.pending)throw new Error('EVIDENCE_ANCHOR_PENDING: '+(run.error||'server recovery budget reached'));
      if(!run.scan_id||!Array.isArray(run.accounts)||run.accounts.length!==accounts.length||
        run.accounts.some(function(a){return accounts.indexOf(a)<0;})||!Number.isInteger(run.anchor_ledger)||
        !Number.isFinite(run.anchor_close_ms)||!run.roster_hash)throw new Error('EVIDENCE_RUN_IDENTITY_UNPROVEN');
      metrics={scan_id:run.scan_id,roster_hash:run.roster_hash,target_wallets:run.accounts.length,
        requests:0,rows_fetched:0,indexed_wallets:0,stored_transactions_loaded:0,pages_read:0,errors:[],transport:run.transport,
        max_concurrency:MAX_EVIDENCE_CONCURRENCY,auto_roster_added:autoRosterAdded};
      return run;
    },
    metrics:function(){return metrics;},
    finish:async function(run){
      var result=await call('summary',{scan_id:run.scan_id},false);
      if(result.scan_id!==run.scan_id||result.roster_hash!==run.roster_hash||result.anchor_ledger!==run.anchor_ledger)
        throw new Error('EVIDENCE_SUMMARY_IDENTITY_MISMATCH');
      metrics.server_summary={status:result.status,complete_wallets:result.complete_wallets,target_wallets:result.target_wallets,
        requests:result.requests,rows_fetched:result.rows_fetched};
      return metrics.server_summary;
    },
    proveWallet:async function(run,address){
      var release=await slot();
      try{
        var resumed=0,started=Date.now(),acquired;
        do{
          acquired=await call('catchup',{scan_id:run.scan_id,address:address},true);
          metrics.requests+=Number(acquired.requests)||0;metrics.rows_fetched+=Number(acquired.rows_fetched)||0;
          if(acquired.transport){
            metrics.actual_endpoint=acquired.transport.actual_endpoint;
            metrics.reconnects=(metrics.reconnects||0)+(acquired.transport.reconnects||0);
            if(acquired.transport.first_failure&&!metrics.first_failure)metrics.first_failure=acquired.transport.first_failure;
            metrics.last_transport=acquired.transport;
          }
          if(!acquired.pending)break;
          var wait=Math.max(1000,Number(acquired.retry_after_ms)||1000);
          if(++resumed>4||Date.now()+wait-started>900000)throw new Error('EVIDENCE_RECOVERY_EXHAUSTED: '+acquired.error);
          if(typeof log==='function')log('Evidence recovery: pausing '+Math.ceil(wait/1000)+'s before resuming '+address);
          await new Promise(function(resolve){setTimeout(resolve,wait);});
        }while(true);
        var proof=acquired.proof;
        if(!proof||proof.status!=='COMPLETE'||proof.run_id!==run.scan_id||Number(proof.anchor_ledger)!==Number(run.anchor_ledger))
          throw new Error('INDEX_WALLET_PROOF_UNPROVEN');
        metrics.indexed_wallets++;
        if(typeof window.updateShadowTxProgress==='function')window.updateShadowTxProgress(metrics);
        if(typeof log==='function')log('Evidence edge '+address+': '+(acquired.mode||'stored')+', '+(acquired.rows_fetched||0)+' new observation(s), '+(acquired.requests||0)+' XRPL read(s)');
        return {rows:[],proof:proof};
      }catch(e){metrics.errors.push({address:address,error:e.message,transport:e.transport||null});throw e;}
      finally{release();}
    },
    readRun:async function(run){
      var rows=[],after='';
      do{
        var result=await call('read-run',{scan_id:run.scan_id,after:after},false);
        if(!result.available||result.scan_id!==run.scan_id||result.roster_hash!==run.roster_hash||
          result.anchor_ledger!==run.anchor_ledger||result.complete_wallets!==result.target_wallets)
          throw new Error(result.error||'INDEX_RUN_WINDOW_UNPROVEN');
        rows=rows.concat(result.transactions||[]);after=result.next||'';metrics.pages_read++;
        metrics.stored_transactions_loaded=rows.length;
        if(typeof window.updateShadowTxProgress==='function')window.updateShadowTxProgress(metrics);
      }while(after);
      return rows;
    },
    readWallet:async function(run,address){
      var release=await slot();
      try{
        var resumed=0,started=Date.now(),acquired;
        do{
          acquired=await call('catchup',{scan_id:run.scan_id,address:address},true);
          metrics.requests+=Number(acquired.requests)||0;metrics.rows_fetched+=Number(acquired.rows_fetched)||0;
          if(acquired.transport){
            metrics.actual_endpoint=acquired.transport.actual_endpoint;
            metrics.reconnects=(metrics.reconnects||0)+(acquired.transport.reconnects||0);
            if(acquired.transport.first_failure&&!metrics.first_failure)metrics.first_failure=acquired.transport.first_failure;
            metrics.last_transport=acquired.transport;
          }
          if(!acquired.pending)break;
          var wait=Math.max(1000,Number(acquired.retry_after_ms)||1000);
          if(++resumed>4||Date.now()+wait-started>900000)throw new Error('EVIDENCE_RECOVERY_EXHAUSTED: '+acquired.error);
          if(typeof log==='function')log('Evidence recovery: pausing '+Math.ceil(wait/1000)+'s before resuming '+address);
          await new Promise(function(resolve){setTimeout(resolve,wait);});
        }while(true);
        var rows=[],after='',proof;
        do{
          var result=await call('read',{scan_id:run.scan_id,address:address,after:after},false);
          if(!result.available||result.scan_id!==run.scan_id||result.roster_hash!==run.roster_hash||
             !result.proof||result.proof.anchor_ledger!==run.anchor_ledger)throw new Error('INDEX_WINDOW_UNPROVEN');
          rows=rows.concat(result.transactions);proof=result.proof;after=result.next||'';metrics.pages_read++;
        }while(after);
        proof=Object.assign({},proof,{actual_endpoint:acquired.transport&&acquired.transport.actual_endpoint,
          transport_epoch:acquired.transport&&acquired.transport.transport_epoch,
          edge_fetch_from_ledger:acquired.fetch_from_ledger,edge_fetch_to_ledger:acquired.fetch_to_ledger,
          xrpl_requests:Number(acquired.requests)||0,index_rows_returned:rows.length});
        metrics.indexed_wallets++;
        if(typeof log==='function')log('Evidence index '+address+': '+acquired.mode+', '+rows.length+' retained rows, '+(acquired.requests||0)+' XRPL reads');
        return {rows:rows,proof:proof};
      }catch(e){metrics.errors.push({address:address,error:e.message,transport:e.transport||null});throw e;}
      finally{release();}
    }
  };
})();
