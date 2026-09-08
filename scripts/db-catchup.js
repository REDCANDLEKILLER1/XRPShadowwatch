'use strict';
const fs=require('fs');
const E=require('../src/db/evidence');
const db=require('../src/db/connection');
async function main(){
  const hours=Number(process.env.SW_WINDOW_HOURS||24);
  const reader=new E.Reader();
  try{
    const prior=process.env.SW_RESUME_RUN?await E.getRun(process.env.SW_RESUME_RUN):null;
    const run=prior?{scan_id:prior.scan_id,accounts:prior.roster_accounts}:await E.begin({start_ms:Date.now()-hours*3600000,end_ms:Date.now()},reader);
    console.log(JSON.stringify({event:prior?'resume':'begin',...run,accounts:run.accounts.length}));
    fs.writeFileSync('../active-index-run.json',JSON.stringify(run,null,2));
    for(let i=0;i<run.accounts.length;i++){
      const address=run.accounts[i];reader.deadline=Date.now()+240000;
      try{
        let result,segments=0;
        do{
          reader.deadline=Date.now()+240000;
          result=await E.catchUp(run.scan_id,address,reader);
          console.log(JSON.stringify({wallet:i+1,total:run.accounts.length,...result,transport:undefined}));
          if(result.pending&&++segments>=4)throw Object.assign(new Error('WALLET_RECOVERY_BUDGET_REACHED'),{pending:true});
        }while(result.pending);
      }catch(e){
        console.log(JSON.stringify({wallet:i+1,address,error:e.message,pending:!!e.pending}));
        await db.getExecutor()(`UPDATE scan_wallets SET status=$3,error=$4 WHERE scan_id=$1 AND address=$2`,[run.scan_id,address,e.pending?'PENDING':'FAILED',e.message]);
        if(e.pending) break;
      }
    }
    const summary=await E.summary(run.scan_id);
    fs.writeFileSync('../index-run-result.json',JSON.stringify(summary,null,2));
    console.log(JSON.stringify({...summary,wallets:undefined}));
  }finally{reader.close();await db.close();}
}
main().catch(e=>{console.error(e.stack);process.exitCode=1;});
