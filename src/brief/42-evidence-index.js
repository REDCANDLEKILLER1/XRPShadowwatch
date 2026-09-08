(function(){
  'use strict';
  var active=0, queue=[], metrics=null;
  function slot(){return new Promise(function(resolve){queue.push(resolve);pump();});}
  function pump(){if(active>=2||!queue.length)return;active++;queue.shift()(function(){active--;pump();});pump();}
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
  window.SW_EVIDENCE_INDEX={
    begin:async function(windowRange,accounts){
      var run=await call('begin',{start_ms:windowRange.startMs,end_ms:windowRange.endMs,accounts:accounts},true);
      if(run.pending)throw new Error('EVIDENCE_ANCHOR_PENDING: '+(run.error||'server recovery budget reached'));
      if(!run.scan_id||!Array.isArray(run.accounts)||run.accounts.length!==accounts.length||
        run.accounts.some(function(a){return accounts.indexOf(a)<0;})||!Number.isInteger(run.anchor_ledger)||
        !Number.isFinite(run.anchor_close_ms)||!run.roster_hash)throw new Error('EVIDENCE_RUN_IDENTITY_UNPROVEN');
      metrics={scan_id:run.scan_id,roster_hash:run.roster_hash,target_wallets:run.accounts.length,
        requests:0,rows_fetched:0,indexed_wallets:0,pages_read:0,errors:[],transport:run.transport};
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
