'use strict';
const assert=require('assert/strict');
const C=require('../src/db/coverage');
const roster=require('../src/db/roster');
const db=require('../src/db/connection');
const E=require('../src/db/evidence');
const handler=require('../api/evidence');
const {Reader,refusal,retryMs}=require('../src/db/xrpl-reader');
async function main(){
  const txBoundary=db.transaction;
  try{
    db.transaction=async()=>{throw new Error('WRITE_BOUNDARY_REACHED');};
    const original={hash:'A'.repeat(64),raw_tx:{Amount:'9007199254740993',TransactionType:'Payment'},
      raw_meta:{TransactionResult:'tesSUCCESS',AffectedNodes:[{ModifiedNode:{FinalFields:{Balance:'7'}}}]}};
    for(const field of ['raw_tx','raw_meta']){
      const rival=JSON.parse(JSON.stringify(original));
      if(field==='raw_tx') rival.raw_tx.Amount='9007199254740994';
      else rival.raw_meta.AffectedNodes[0].ModifiedNode.FinalFields.Balance='8';
      await assert.rejects(()=>E.persist({},'unused',[original,rival],{},{}),/CONFLICTING_TRANSACTION_SIGHTINGS/);
    }
    const reordered={...original,raw_tx:{TransactionType:'Payment',Amount:'9007199254740993'}};
    await assert.rejects(()=>E.persist({},'unused',[original,reordered],{},{}),/WRITE_BOUNDARY_REACHED/);
    console.log('PASS raw transaction and equal-node-count metadata conflicts are refused before writes; key order is harmless');
  }finally{db.transaction=txBoundary;}
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
  const prior={scan_coverage_from:100,scan_coverage_through:200,
    scan_coverage_from_close:close,scan_coverage_through_close:new Date(close.getTime()+400000)};
  const checkRange=(from,through)=>C.checkpointAdvance({coverage:prior,anchorLedger:250,
    proof:{status:'COMPLETE',range_bound_proven:true,from_ledger:from,through_ledger:through,
      from_close_ms:close.getTime()+(from-100)*4000,through_close_ms:close.getTime()+(through-100)*4000}});
  assert.equal(checkRange(50,98).reason,'PROOF_RANGE_NOT_CONTIGUOUS');
  assert.equal(checkRange(202,250).reason,'PROOF_RANGE_NOT_CONTIGUOUS');
  assert.equal(checkRange(50,99).reason,'NO_FORWARD_PROGRESS');
  assert.equal(checkRange(50,100).reason,'NO_FORWARD_PROGRESS');
  assert.equal(checkRange(201,250).advance,true);
  console.log('PASS disjoint ranges are refused on both sides while adjacent/overlapping ranges remain valid');
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
  const retentionReader=new Reader();let retentionCalls=0;
  retentionReader.epoch=1;retentionReader.connect=async()=>{};
  retentionReader.request=async function(){
    retentionCalls++;
    if(retentionCalls===1){this.epoch++;throw new Error('XRPL_TRANSPORT_CHANGED');}
    return {info:{complete_ledgers:'100-300'}};
  };
  assert.deepEqual(await retentionReader.retainedRange(200),[[100,300]]);
  assert.equal(retentionReader.retention.epoch,2);
  await retentionReader.retainedRange(250);assert.equal(retentionCalls,2,'same socket reuses its verified range');
  retentionReader.epoch++;await retentionReader.retainedRange(250);
  assert.equal(retentionCalls,3,'replacement socket re-proves retained history');
  await retentionReader.retainedRange(400);assert.equal(retentionCalls,4,'new anchor refreshes an older retained ceiling');
  console.log('PASS a connection change during retention verification retries and never inherits another socket’s proof');
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
    db.setExecutor(async()=>({rows:[]}));
    E.catchUp=async(id,address,reader)=>{
      reader.stats.actual_endpoint='wss://xrplcluster.com';reader.stats.transport_epoch=4;
      reader.stats.first_failure={reason:'XRPL_TRANSPORT_CHANGED',endpoint:'wss://xrplcluster.com'};
      throw new Error('XRPL_TRANSPORT_CHANGED');
    };
    const failed=await invoke({body:{action:'catchup',scan_id:id,address:selected.accounts[0]}});
    assert.equal(failed.code,503);assert.equal(failed.body.transport.actual_endpoint,'wss://xrplcluster.com');
    assert.equal(failed.body.transport.transport_epoch,4);
    assert.equal(failed.body.transport.first_failure.reason,'XRPL_TRANSPORT_CHANGED');
    db.setExecutor(null);
  }finally{db.isConfigured=originalConfigured;E.catchUp=originalCatchup;}
  console.log('PASS API accepts a wallet request, never caller evidence or a caller checkpoint');
  const vm=require('vm'),fs=require('fs'),path=require('path');
  const run={scan_id:'idx-test',accounts:['wallet-a','wallet-b'],anchor_ledger:100,anchor_close_ms:100000,roster_hash:'test-roster'};
  const transport={actual_endpoint:'wss://xrplcluster.com',transport_epoch:4,requests:1};
  const sandbox={window:{},URLSearchParams,AbortController,setTimeout,clearTimeout,fetch:async(url,options)=>{
    const p=options.method?JSON.parse(options.body):Object.fromEntries(new URLSearchParams(url.split('?')[1]));
    let data,ok=true;
    if(p.action==='begin')data=run;
    if(p.action==='catchup'&&p.address==='wallet-a')data={mode:'EDGE_ONLY',fetch_from_ledger:91,fetch_to_ledger:100,requests:1,transport};
    if(p.action==='catchup'&&p.address==='wallet-b'){ok=false;data={error:'XRPL_TRANSPORT_CHANGED',transport};}
    if(p.action==='read')data={available:true,scan_id:run.scan_id,roster_hash:run.roster_hash,transactions:[{hash:'actual-retained-row'}],
      proof:{status:'COMPLETE',anchor_ledger:100,source:'NEON_VERIFIED_INDEX',proven_reason:'SERVER_RETAINED_RANGE_PROVEN',from_ledger:10,through_ledger:100},next:null};
    return {ok,json:async()=>data};
  }};
  vm.runInNewContext(fs.readFileSync(path.join(__dirname,'../src/brief/42-evidence-index.js'),'utf8'),sandbox);
  const index=sandbox.window.SW_EVIDENCE_INDEX;await index.begin({startMs:1000,endMs:100000},run.accounts);
  const result=await index.readWallet(run,'wallet-a');
  assert.equal(result.proof.from_ledger,10);assert.equal(result.proof.edge_fetch_from_ledger,91);
  assert.equal(result.proof.edge_fetch_to_ledger,100);assert.equal(result.proof.xrpl_requests,1);
  assert.equal(result.proof.index_rows_returned,1);assert.equal(result.proof.actual_endpoint,transport.actual_endpoint);
  await assert.rejects(()=>index.readWallet(run,'wallet-b'),e=>e.message==='XRPL_TRANSPORT_CHANGED'&&e.transport.transport_epoch===4);
  assert.equal(index.metrics().errors[0].transport.actual_endpoint,transport.actual_endpoint);
  console.log('PASS real client bridge preserves retained range, edge requests and failed endpoint diagnostics');
  console.log('ALL EVIDENCE BOUNDARY CHECKS PASS');
}
main().catch(e=>{console.error(e);process.exitCode=1;});
