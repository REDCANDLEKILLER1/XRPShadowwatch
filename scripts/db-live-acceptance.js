'use strict';
const assert=require('assert/strict');
const {randomUUID}=require('crypto');
const db=require('../src/db/connection');
const E=require('../src/db/evidence');
const T=require('../src/db/transactions');
const C=require('../src/db/coverage');
async function main(){
  const read=db.getExecutor();
  const actual=(await read(`SELECT w.scan_id,w.address,w.proof FROM scan_wallets w
    WHERE status='COMPLETE' AND EXISTS(SELECT 1 FROM transaction_accounts a WHERE a.address=w.address AND a.role='observed_via') LIMIT 1`)).rows[0];
  assert.ok(actual,'A real acquired wallet is required');
  const run=await E.getRun(actual.scan_id);
  const evidence=(await read(`SELECT t.* FROM transactions t WHERE ledger_index>=$2 AND ledger_index<=$3 AND
    EXISTS(SELECT 1 FROM transaction_accounts a WHERE a.tx_hash=t.hash AND a.address=$1 AND a.role='observed_via')`,
    [actual.address,actual.proof.from_ledger,actual.proof.through_ledger])).rows;
  const rows=evidence.map(r=>T.rowFromAccountTx({tx_json:r.raw_tx,meta:r.raw_meta,hash:r.hash,ledger_index:Number(r.ledger_index),validated:r.validated},
    {observedVia:actual.address,rosterVersion:run.roster_hash}));
  const namespace='sw_acceptance_'+randomUUID().replace(/-/g,'');
  const transaction=db.transaction;let injected=false;
  try{
    await transaction(async q=>{
      await q('CREATE SCHEMA '+namespace);
      for(const table of ['transactions','transaction_accounts','wallet_coverage','coverage_advances','scan_runs','scan_wallets'])
        await q('CREATE TABLE '+namespace+'.'+table+' (LIKE public.'+table+' INCLUDING ALL)');
      await q('SET LOCAL search_path TO '+namespace+', public');
      await q(`CREATE TRIGGER monotonic BEFORE UPDATE OR DELETE ON wallet_coverage FOR EACH ROW EXECUTE FUNCTION public.wallet_coverage_monotonic()`);
      await q(`CREATE TRIGGER no_truncate BEFORE TRUNCATE ON wallet_coverage FOR EACH STATEMENT EXECUTE FUNCTION public.wallet_coverage_monotonic()`);
      await q(`CREATE TRIGGER prune BEFORE DELETE ON transactions FOR EACH ROW EXECUTE FUNCTION public.invalidate_pruned_evidence()`);
      await q(`INSERT INTO scan_runs SELECT * FROM public.scan_runs WHERE scan_id=$1`,[run.scan_id]);
      await q(`INSERT INTO scan_wallets(scan_id,address) VALUES($1,$2)`,[run.scan_id,actual.address]);
      const ids=new Set();
      db.transaction=async work=>{
        await q('SAVEPOINT evidence_write');
        try{
          const result=await work(async(sql,params)=>{
            ids.add(String((await q('SELECT txid_current() AS id')).rows[0].id));
            if(injected && sql.includes('INSERT INTO coverage_advances'))throw new Error('INJECTED_FAILURE_BEFORE_AUDIT');
            return q(sql,params);
          });
          await q('RELEASE SAVEPOINT evidence_write');return result;
        }catch(e){await q('ROLLBACK TO SAVEPOINT evidence_write');throw e;}
      };
      const metrics={requests:1,rows_fetched:rows.length,fetch_from_ledger:actual.proof.from_ledger};
      injected=true;
      await assert.rejects(()=>E.persist(run,actual.address,rows,actual.proof,metrics),/INJECTED_FAILURE/);
      for(const table of ['transactions','transaction_accounts','wallet_coverage','coverage_advances'])
        assert.equal(Number((await q('SELECT count(*) AS n FROM '+table)).rows[0].n),0,table+' rolled back');
      console.log('PASS actual Neon transaction rolls back evidence, participants, checkpoint and audit together');
      injected=false;await E.persist(run,actual.address,rows,actual.proof,metrics);
      assert.equal(ids.size,1,'All evidence writes share one PostgreSQL transaction');
      const covered=(await q('SELECT * FROM wallet_coverage WHERE address=$1',[actual.address])).rows[0];
      assert.equal(E.decision(run,covered).complete_without_fetch,true,'Raw PostgreSQL timestamps round-trip as servable coverage');
      assert.equal(Number((await q('SELECT count(*) AS n FROM transactions')).rows[0].n),rows.length);
      assert.equal(Number((await q('SELECT count(*) AS n FROM coverage_advances')).rows[0].n),1);
      console.log('PASS real evidence and observed ledger-close pairs produce servable coverage');
      for(const sql of [
        'UPDATE wallet_coverage SET scan_coverage_through=scan_coverage_through-1',
        'UPDATE wallet_coverage SET scan_coverage_through=NULL',
        'DELETE FROM wallet_coverage',
        'TRUNCATE wallet_coverage'
      ]){
        await q('SAVEPOINT guard_test');
        await assert.rejects(()=>q(sql));
        await q('ROLLBACK TO SAVEPOINT guard_test');
      }
      console.log('PASS checkpoint regression, clearing, deletion and truncation are rejected');
      await q('DELETE FROM transactions');
      const pruned=(await q('SELECT * FROM wallet_coverage WHERE address=$1',[actual.address])).rows[0];
      const unavailable=E.decision(run,pruned);
      assert.equal(unavailable.reason,'EVIDENCE_PRUNED');
      assert.equal(C.mayReportQuiet(unavailable,0).quiet,false);
      assert.equal(pruned.scan_coverage_through,covered.scan_coverage_through);
      console.log('PASS pruning retains historical proof and refuses an empty-query all-clear');
      throw new Error('ROLLBACK_ACCEPTANCE_SCHEMA');
    });
  }catch(e){if(e.message!=='ROLLBACK_ACCEPTANCE_SCHEMA')throw e;}
  finally{db.transaction=transaction;}
  assert.equal((await read('SELECT to_regnamespace($1) AS name',[namespace])).rows[0].name,null);
  console.log('PASS acceptance schema rolled back; production evidence preserved');
  console.log('ALL LIVE NEON ACCEPTANCE CHECKS PASS');
}
main().catch(e=>{console.error(e.message);process.exitCode=1;}).finally(()=>db.close());
