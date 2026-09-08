(function(){
  'use strict';
  var active=0, queue=[], metrics=null;
  function slot(){return new Promise(function(resolve){queue.push(resolve);pump();});}
  function pump(){if(active>=2||!queue.length)return;active++;queue.shift()(function(){active--;pump();});pump();}
  async function call(action,input,write){
    var params=Object.assign({action:action},input||{});
    var response=await fetch('/api/evidence'+(write?'':'?'+new URLSearchParams(params)),write?{
      method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(params),cache:'no-store'
    }:{cache:'no-store'});
    var data;try{data=await response.json();}catch(_){throw new Error('EVIDENCE_STORE_UNAVAILABLE');}
    if(!response.ok)throw new Error(data.error||'EVIDENCE_REQUEST_FAILED');
    return data;
  }
  window.SW_EVIDENCE_INDEX={
    begin:async function(windowRange,accounts){
      var run=await call('begin',{start_ms:windowRange.startMs,end_ms:windowRange.endMs,accounts:accounts},true);
      metrics={scan_id:run.scan_id,roster_hash:run.roster_hash,target_wallets:run.accounts.length,
        requests:0,rows_fetched:0,indexed_wallets:0,pages_read:0,errors:[],transport:run.transport};
      return run;
    },
    metrics:function(){return metrics;},
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
        metrics.indexed_wallets++;
        if(typeof log==='function')log('Evidence index '+address+': '+acquired.mode+', '+rows.length+' retained rows, '+(acquired.requests||0)+' XRPL reads');
        return {rows:rows,proof:proof};
      }catch(e){metrics.errors.push({address:address,error:e.message});throw e;}
      finally{release();}
    }
  };
})();
