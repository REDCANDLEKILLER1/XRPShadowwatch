'use strict';
const assert=require('assert/strict');
const C=require('../src/db/coverage');
const roster=require('../src/db/roster');
const db=require('../src/db/connection');
const E=require('../src/db/evidence');
const handler=require('../api/evidence');
const {Reader,refusal,retryMs}=require('../src/db/xrpl-reader');
async function main(){
  const selected=roster.select();
  assert.equal(selected.accounts.length,255);
  assert.equal(selected.hash,roster.identity([...selected.accounts].reverse()));
  assert.throws(()=>roster.select([...selected.accounts,'rUnknown']),/ROSTER_MISMATCH/);
  assert.throws(()=>roster.select([selected.accounts[0],selected.accounts[0]]),/ROSTER_MISMATCH/);
  console.log('PASS canonical roster identity covers the exact 255 accounts');
  const close=new Date('2026-09-08T00:00:00Z');
  const row=C.normalizeCoverage({scan_coverage_from_close:close,scan_coverage_through_close:close.toISOString(),evidence_retained_from_close:null});
  assert.equal(row.scan_coverage_from_close_ms,close.getTime());
  assert.equal(row.scan_coverage_through_close_ms,close.getTime());
  assert.equal(row.evidence_retained_from_close_ms,null);
  assert.equal(C.normalizeCoverage({scan_coverage_from_close:'bad'}).scan_coverage_from_close_ms,null);
  console.log('PASS raw PostgreSQL timestamps normalize without manufacturing time');
  const advance=C.checkpointAdvance({coverage:null,anchorLedger:110000000,proof:{status:'COMPLETE',range_bound_proven:true,
    from_ledger:109999000,through_ledger:110000000,from_close_ms:close.getTime(),through_close_ms:close.getTime()+10000,rows_stored:0}});
  assert.equal(advance.advance,true);assert.equal(advance.reason,'EMPTY_RANGE_EXHAUSTED');
  assert.equal(advance.next_from,109999000);assert.equal(advance.next_from_close_ms,close.getTime());
  console.log('PASS an independently observed empty ledger range advances without a transaction floor');
  const proof={status:'COMPLETE',source:'NEON_VERIFIED_INDEX',run_id:'idx-test',anchor_ledger:110000000,
    request_bounded:true,transport_consistent:true,range_bound_proven:true,range_exhausted:true,
    edge_fetch_complete:true,covers_window_start:true,response_validated:true,response_ledger_index_max:110000000};
  const args={anchorOk:true,anchorLedger:110000000,runId:'idx-test',windowBoundedByAnchor:true,proof};
  assert.equal(C.coverageProven(args).proven,true);
  for(const name of ['request_bounded','transport_consistent','edge_fetch_complete','covers_window_start','range_exhausted','response_validated'])
    assert.equal(C.coverageProven({...args,proof:{...proof,[name]:false}}).proven,false,name);
  assert.equal(C.coverageProven({...args,runId:'another-run'}).proven,false);
  assert.equal(C.coverageProven({...args,proof:{...proof,status:'FAILED'}}).proven,false);
  console.log('PASS indexed coverage requires every run, range, retention and edge proof');
  for(const e of [{code:'slowDown'},{code:'tooBusy'},{message:'rate limit: units quota (2000 per 10s) exhausted'}])assert.equal(refusal(e),true);
  assert.equal(refusal({code:'invalidParams'}),false);
  assert.equal(retryMs({retry_after_ms:999999999}),999999999);
  await assert.rejects(()=>new Reader().request({command:'submit'}),/METHOD_NOT_ALLOWED/);
  console.log('PASS explicit overload keeps its retry signal; transaction submission is rejected');
  async function invoke(req){
    const out={headers:{},code:200};
    const res={setHeader:(k,v)=>out.headers[k]=v,status:n=>{out.code=n;return res;},json:b=>{out.body=b;return out;}};
    await handler({method:'POST',headers:{host:'shadowwatch.xyz',origin:'https://shadowwatch.xyz'},...req},res);return out;
  }
  const originalConfigured=db.isConfigured,originalCatchup=E.catchUp;
  db.isConfigured=()=>true;
  try{
    const denied=await invoke({body:{action:'rpc',url:'http://127.0.0.1',command:'submit'}});
    assert.equal(denied.code,400);assert.match(denied.headers['Cache-Control'],/no-store/);
    assert.equal((await invoke({headers:{host:'shadowwatch.xyz',origin:'https://untrusted.example'},body:{action:'begin'}})).code,403);
    let received;
    E.catchUp=async(id,address,reader)=>{received={id,address,reader};return {ok:true};};
    const id='idx-00000000-0000-4000-8000-000000000000';
    await invoke({body:{action:'catchup',scan_id:id,address:selected.accounts[0],proof:{status:'COMPLETE'},anchor_ledger:999999999,transactions:[{fake:true}]}});
    assert.equal(received.id,id);assert.equal(received.address,selected.accounts[0]);assert.ok(received.reader instanceof Reader);
    assert.equal(received.reader.proof,undefined);
  }finally{db.isConfigured=originalConfigured;E.catchUp=originalCatchup;}
  console.log('PASS API accepts a wallet request, never caller evidence or a caller checkpoint');
  console.log('ALL EVIDENCE BOUNDARY CHECKS PASS');
}
main().catch(e=>{console.error(e);process.exitCode=1;});
