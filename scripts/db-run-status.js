'use strict';
const db=require('../src/db/connection');
async function main(){
  const q=db.getExecutor();
  const runs=await q(`SELECT r.scan_id,r.anchor_ledger,r.started_at,r.target_wallets,
    count(*) FILTER(WHERE w.status='COMPLETE')::integer AS proved,
    count(*) FILTER(WHERE w.status='FAILED')::integer AS failed,
    count(*) FILTER(WHERE w.status='PENDING')::integer AS pending,
    sum(COALESCE((w.metrics->>'requests')::integer,0))::integer AS requests,
    sum(COALESCE((w.metrics->>'rows_fetched')::integer,0))::integer AS rows_fetched
    FROM scan_runs r JOIN scan_wallets w USING(scan_id)
    GROUP BY r.scan_id ORDER BY r.started_at DESC LIMIT 4`);
  console.log(JSON.stringify(runs.rows,null,2));
  console.log(JSON.stringify((await q("SELECT scan_id,address,error FROM scan_wallets WHERE status='FAILED' ORDER BY updated_at DESC LIMIT 5")).rows));
  console.log(JSON.stringify((await q('SELECT count(*)::integer AS unique_transactions FROM transactions')).rows[0]));
}
main().catch(e=>{console.error(e.message);process.exitCode=1;}).finally(()=>db.close());
