'use strict';
const assert=require('assert/strict');
const fs=require('fs');
const A=require('../src/db/github-archive');

function response(status,data){return {status,ok:status>=200&&status<300,json:async()=>data};}
function fakeGithub(){
  let seq=0;const blobs=new Map(),trees=new Map(),commits=new Map(),refs={main:'c0'};
  trees.set('t0',{});commits.set('c0',{sha:'c0',tree:{sha:'t0'},parents:[]});
  async function fetch(url,options={}){
    await new Promise(r=>setTimeout(r,Math.floor(Math.random()*3)));
    const method=options.method||'GET',path=new URL(url).pathname.replace('/repos/'+A.REPO,'');
    const body=options.body?JSON.parse(options.body):{};
    if(method==='GET'&&path==='')return response(200,{default_branch:'main'});
    let m=path.match(/^\/git\/ref\/heads\/(.+)$/);
    if(method==='GET'&&m)return refs[m[1]]?response(200,{object:{sha:refs[m[1]]}}):response(404,{message:'Not Found'});
    if(method==='POST'&&path==='/git/refs'){
      const branch=body.ref.replace('refs/heads/','');if(refs[branch])return response(422,{message:'exists'});refs[branch]=body.sha;return response(201,{object:{sha:body.sha}});
    }
    m=path.match(/^\/git\/commits\/(.+)$/);if(method==='GET'&&m)return response(200,commits.get(m[1]));
    if(method==='POST'&&path==='/git/blobs'){const sha='b'+(++seq);blobs.set(sha,Buffer.from(body.content,'base64').toString('utf8'));return response(201,{sha});}
    if(method==='POST'&&path==='/git/trees'){
      const sha='t'+(++seq),base={...(trees.get(body.base_tree)||{})};for(const e of body.tree)base[e.path]=e.sha;trees.set(sha,base);return response(201,{sha});
    }
    if(method==='POST'&&path==='/git/commits'){const sha='c'+(++seq);commits.set(sha,{sha,tree:{sha:body.tree},parents:body.parents});return response(201,{sha});}
    m=path.match(/^\/git\/refs\/heads\/(.+)$/);
    if(method==='PATCH'&&m){const commit=commits.get(body.sha),branch=m[1];if(!commit||commit.parents[0]!==refs[branch])return response(422,{message:'not fast forward'});refs[branch]=body.sha;return response(200,{object:{sha:body.sha}});}
    m=path.match(/^\/contents\/(.+)$/);
    if(method==='GET'&&m){const branch=new URL(url).searchParams.get('ref'),tree=trees.get(commits.get(refs[branch]).tree.sha),filePath=decodeURIComponent(m[1]);
      const blob=tree[filePath];return blob?response(200,{sha:blob,content:Buffer.from(blobs.get(blob)).toString('base64')}):response(404,{message:'Not Found'});}
    return response(500,{message:'unhandled '+method+' '+path});
  }
  return {fetch,refs,commits,trees,blobs,file(path,branch=A.BRANCH){const c=commits.get(refs[branch]),b=trees.get(c.tree.sha)[path];return b?blobs.get(b):null;}};
}
const complete={evidence_scan_id:'idx-00000000-0000-4000-8000-000000000000',generated_at:'2026-09-09T12:00:00.000Z',
  roster_hash:'roster-canonical',target_wallets:255,transaction_windows_proved:255,failed:0,truncated:0,unproven:0,
  validated_anchor_ledger:106856269,transactions_in_window:48421,new_observations:876,xrpl_requests:266,
  stored_history_reused:true,coverage_complete:true};
const input={report_id:'SW-20260909-Z60GN',scan_id:'SC-ABC123',evidence_scan_id:complete.evidence_scan_id,
  generated_at:'2026-09-09T12:05:00.000Z',morning_report:'Exact Morning Report\n255/255\n',
  morning_hash:A.sha('Exact Morning Report\n255/255\n'),public_hash:'a'.repeat(32),full_hash:'b'.repeat(32)};
const env={SHADOWWATCH_GITHUB_ARCHIVE_TOKEN:'server-only',VERCEL_GIT_COMMIT_SHA:'production-sha'};
async function main(){
  const gh=fakeGithub();let factsCalls=0;const archiveFacts=async()=>{factsCalls++;return complete;};
  const first=await A.archiveReport(input,{env,fetch:gh.fetch,archiveFacts});
  assert.equal(first.status,'ARCHIVED');assert.equal(first.branch,A.BRANCH);assert.equal(first.files_written,4);assert.equal(gh.refs.main,'c0');
  const root='reports/2026/09/09/'+input.report_id;
  const receipt=JSON.parse(gh.file(root+'/receipt.json'));
  assert.equal(receipt.transaction_windows_proved,255);assert.equal(receipt.new_observations,876);assert.equal(receipt.roster_hash,'roster-canonical');
  assert.equal(receipt.report_hash,A.sha(input.morning_report));assert.equal(gh.file(root+'/morning-report.txt'),input.morning_report);
  console.log('PASS complete 255/255 archives exact report and canonical receipt on archive branch only');
  const duplicate=await A.archiveReport(input,{env,fetch:gh.fetch,archiveFacts});assert.equal(duplicate.status,'ALREADY_ARCHIVED');
  await assert.rejects(()=>A.archiveReport({...input,morning_report:'changed',morning_hash:A.sha('changed')},{env,fetch:gh.fetch,archiveFacts}),/ARCHIVE_CONFLICT/);
  console.log('PASS duplicate is idempotent and same ID with different hash conflicts');
  const incomplete={...complete,transaction_windows_proved:253,failed:2,coverage_complete:false};
  const secondInput={...input,report_id:'SW-20260909-FAIL1',scan_id:'SC-DEF456'};
  const second=await A.archiveReport(secondInput,{env,fetch:gh.fetch,archiveFacts:async()=>incomplete});assert.equal(second.status,'ARCHIVED');
  assert.equal(JSON.parse(gh.file('reports/2026/09/09/'+secondInput.report_id+'/receipt.json')).coverage_complete,false);
  console.log('PASS archive layer can preserve an honestly sealed incomplete historical run');
  await assert.rejects(()=>A.archiveReport({...input,report_id:'unknown'},{env,fetch:gh.fetch,archiveFacts}),/INVALID_REPORT_ID/);
  await assert.rejects(()=>A.archiveReport({...input,path:'main.js'},{env,fetch:gh.fetch,archiveFacts}),/ARCHIVE_FIELD_NOT_ALLOWED/);
  await assert.rejects(()=>A.archiveReport({...input,content:'arbitrary'},{env,fetch:gh.fetch,archiveFacts}),/ARCHIVE_FIELD_NOT_ALLOWED/);
  const oversized='x'.repeat(A.MAX_REPORT_BYTES+1);
  await assert.rejects(()=>A.archiveReport({...input,morning_report:oversized,morning_hash:A.sha(oversized)},{env,fetch:gh.fetch,archiveFacts}),/ARCHIVE_PAYLOAD_TOO_LARGE/);
  assert.equal(fs.readFileSync(require.resolve('../src/brief/42-evidence-index.js'),'utf8').includes('GITHUB_ARCHIVE_TOKEN'),false);
  console.log('PASS unknown runs, arbitrary paths/content, oversized payloads and browser token exposure are refused');
  const retryGh=fakeGithub();let fail=true,calls=0;
  const flaky=async(...args)=>{calls++;if(fail){fail=false;throw new Error('GitHub unavailable');}return retryGh.fetch(...args);};
  await assert.rejects(()=>A.archiveReport({...input,report_id:'SW-20260909-RETRY'},{env,fetch:flaky,archiveFacts}),/GitHub unavailable/);
  const retried=await A.archiveReport({...input,report_id:'SW-20260909-RETRY'},{env,fetch:retryGh.fetch,archiveFacts});assert.equal(retried.status,'ARCHIVED');
  console.log('PASS GitHub failure is retryable through the archive layer without XRPL acquisition');
  const concurrentGh=fakeGithub();
  const one={...input,report_id:'SW-20260909-CONC1'},two={...input,report_id:'SW-20260909-CONC2'};
  const both=await Promise.all([A.archiveReport(one,{env,fetch:concurrentGh.fetch,archiveFacts}),A.archiveReport(two,{env,fetch:concurrentGh.fetch,archiveFacts})]);
  assert.ok(both.every(x=>x.status==='ARCHIVED'));const idx=JSON.parse(concurrentGh.file('reports/2026/09/09/index.json'));
  assert.ok(idx.some(x=>x.report_id===one.report_id)&&idx.some(x=>x.report_id===two.report_id));
  console.log('PASS simultaneous archives retain both reports through bounded non-fast-forward retry');
  assert.ok(factsCalls>=3);assert.ok(first.bytes_written<600*1024);

  // ── A GITHUB-BACKED RUN CAN BE ARCHIVED AT ALL ──────────────────────────
  //
  // Every report produced since the delta migration identifies its acquisition
  // as `gh-<anchor>`, and this layer accepted only Neon's `idx-<uuid>`. The
  // live SW-20260914-FSO32 receipt failed with INVALID_EVIDENCE_SCAN_ID — a
  // complete, sealed, correct report that archived nothing.
  //
  // No injected archiveFacts here: the point is the REAL selection between the
  // two stores and the REAL derivation from committed evidence. The facts come
  // out of a state read through github-store, hash-verified on the way in.
  const State=require('../src/db/evidence-state');
  const Store=require('../src/db/github-store');
  const ANCHOR=106982842;
  const WALLETS=['rAlice','rBob','rCarol'];
  const ghState=State.advance(
    State.genesis(WALLETS.map(a=>({address:a,scan_coverage_through:ANCHOR-500})),
      {anchor_ledger:ANCHOR-500,anchor_close:'2026-09-14T00:00:00.000Z'}),
    {report_id:'SW-20260914-FSO32',scan_id:null,sealed_at:null,
     anchor_ledger:ANCHOR,anchor_close:'2026-09-14T15:43:40.000Z',
     target_wallets:3,complete_wallets:3,balance_contradictions:0,
     evidence_shards:[{path:'evidence/2026/09/14/events.ndjson.gz',sha256:'c'.repeat(64),rows:41782}],
     wallets:WALLETS.map(a=>({address:a,last_proven_ledger:ANCHOR,
       balance_drops:'1000000',balance_ledger:ANCHOR,reconciliation:'RECONCILED'}))});
  // An evidence store holding what commitRun really writes: latest.json, an
  // immutable per-version history copy, and a per-report run manifest.
  const evidenceFiles={};
  const publish=(state,reportId)=>{
    evidenceFiles[Store.STATE_PATH]=State.serialize(state);
    evidenceFiles[Store.historyPath(state.state_version)]=State.serialize(state);
    evidenceFiles[Store.runPath(reportId)]=JSON.stringify({
      report_id:reportId,scan_id:state.sealed_run.scan_id||null,
      anchor_ledger:state.anchor_ledger,anchor_close:state.anchor_close,
      target_wallets:state.sealed_run.target_wallets,
      complete_wallets:state.sealed_run.complete_wallets,
      balance_contradictions:0,admitted_wallets:[],
      state_version:state.state_version,state_sha256:state.state_sha256,
      evidence_shards:state.evidence_shards,sealed_at:null});
  };
  publish(ghState,'SW-20260914-FSO32');
  const evidenceGh=async(method,path)=>{
    if(method==='GET'&&/^\/contents\//.test(path)){
      const file=decodeURIComponent(path.slice('/contents/'.length).split('?')[0]);
      if(!(file in evidenceFiles))return null;
      const buf=Buffer.from(evidenceFiles[file],'utf8');
      return {sha:'s1',size:buf.length,encoding:'base64',content:buf.toString('base64')};
    }
    if(method==='GET'&&/^\/git\/ref\/heads\//.test(path))return {object:{sha:'c0'}};
    return {};
  };
  const ghFacts=await A.archiveFactsFromEvidence('gh-'+ANCHOR,'SW-20260914-FSO32',
    {env:{SHADOWWATCH_EVIDENCE_TOKEN:'t'},gh:evidenceGh});
  assert.equal(ghFacts.report_id,'SW-20260914-FSO32');
  assert.equal(ghFacts.validated_anchor_ledger,ANCHOR);
  assert.equal(ghFacts.transaction_windows_proved,3);
  assert.equal(ghFacts.coverage_complete,true);
  assert.equal(ghFacts.generated_at,'2026-09-14T15:43:40.000Z');
  assert.equal(ghFacts.evidence_source,'GITHUB_EVIDENCE_STORE');
  assert.equal(ghFacts.evidence_rows_committed,41782);
  // Named honestly: the checkpoint holds committed rows, not the report's
  // window, and the receipt must not pass one off as the other.
  assert.equal(ghFacts.transactions_in_window,null);
  console.log('PASS a GitHub-backed run derives its receipt facts from committed evidence');

  const ghArchiveGh=fakeGithub();
  const ghInput={report_id:'SW-20260914-FSO32',scan_id:'SC-FSO32',evidence_scan_id:'gh-'+ANCHOR,
    generated_at:'2026-09-14T15:52:48.000Z',morning_report:'Coffee & Crypto\n408/408\n',
    morning_hash:A.sha('Coffee & Crypto\n408/408\n'),public_hash:'c'.repeat(32),full_hash:'d'.repeat(32)};
  const ghArchived=await A.archiveReport(ghInput,
    {env:{...env,SHADOWWATCH_EVIDENCE_TOKEN:'t'},fetch:ghArchiveGh.fetch,gh:evidenceGh});
  assert.equal(ghArchived.status,'ARCHIVED');
  // Dated by the evidence, not by the caller's generated_at.
  const ghRoot='reports/2026/09/14/SW-20260914-FSO32';
  assert.equal(ghArchived.archive_path,ghRoot);
  const ghReceipt=JSON.parse(ghArchiveGh.file(ghRoot+'/receipt.json'));
  assert.equal(ghReceipt.evidence_source,'GITHUB_EVIDENCE_STORE');
  assert.equal(ghReceipt.transaction_windows_proved,3);
  assert.equal(ghReceipt.state_sha256,ghState.state_sha256);
  assert.equal(ghArchiveGh.file(ghRoot+'/morning-report.txt'),ghInput.morning_report);
  const ghIndex=JSON.parse(ghArchiveGh.file('reports/2026/09/14/index.json'));
  assert.ok(ghIndex.some(r=>r.report_id==='SW-20260914-FSO32'));
  console.log('PASS a GitHub-backed report writes its receipt, report and day index');

  // ── THE REPAIRED SCAN ID SURVIVES ───────────────────────────────────────
  // A GitHub-backed run carries scan_id:null — the public SC- id is repaired in
  // the browser after acquisition. Spreading the facts over the validated id
  // wrote that null straight into the receipt and the day index.
  assert.equal(ghReceipt.scan_id,'SC-FSO32');
  // Asserted DIRECTLY. The first version of this line read
  //   ghIndex.find(...).scan_id || 'SC-FSO32'
  // which supplies the expected value when the field is missing — so it passed
  // over a day index that carried no scan id at all, which is exactly what
  // production was doing. A fallback inside an assertion is not an assertion.
  const ghRow=ghIndex.find(r=>r.report_id==='SW-20260914-FSO32');
  assert.equal(ghRow.scan_id,'SC-FSO32');
  assert.ok('scan_id' in ghRow,'the day index row must carry the field, not merely not contradict it');
  console.log('PASS the repaired scan id survives into the receipt rather than being nulled');

  // ── A COMMITTED REPORT STAYS ARCHIVABLE AFTER THE CHECKPOINT MOVES ──────
  // Reading latest.json made yesterday's report unarchivable the moment
  // today's advanced the pointer — and archive-retry is an operator action
  // taken later, while single-flight is still open and runs can overlap.
  const SECOND=ANCHOR+4000;
  const secondState=State.advance(ghState,{report_id:'SW-20260915-NEXT1',scan_id:null,sealed_at:null,
    anchor_ledger:SECOND,anchor_close:'2026-09-15T06:00:00.000Z',
    target_wallets:3,complete_wallets:3,balance_contradictions:0,
    evidence_shards:[{path:'evidence/2026/09/15/events.ndjson.gz',sha256:'e'.repeat(64),rows:900}],
    wallets:WALLETS.map(a=>({address:a,last_proven_ledger:SECOND,
      balance_drops:'1000000',balance_ledger:SECOND,reconciliation:'RECONCILED'}))});
  publish(secondState,'SW-20260915-NEXT1');       // latest.json now points at v5
  const laterFacts=await A.archiveFactsFromEvidence('gh-'+ANCHOR,'SW-20260914-FSO32',
    {env:{SHADOWWATCH_EVIDENCE_TOKEN:'t'},gh:evidenceGh});
  assert.equal(laterFacts.validated_anchor_ledger,ANCHOR);
  assert.equal(laterFacts.state_version,ghState.state_version);
  assert.equal(laterFacts.report_id,'SW-20260914-FSO32');
  const retryGh2=fakeGithub();
  const reArchived=await A.archiveReport(ghInput,
    {env:{...env,SHADOWWATCH_EVIDENCE_TOKEN:'t'},fetch:retryGh2.fetch,gh:evidenceGh});
  assert.equal(reArchived.status,'ARCHIVED');
  assert.equal(JSON.parse(retryGh2.file(ghRoot+'/receipt.json')).validated_anchor_ledger,ANCHOR);
  console.log('PASS a committed report still archives after a later run advances the checkpoint');

  // A report that never committed has no run manifest, and is refused whatever
  // the checkpoint currently says.
  await assert.rejects(()=>A.archiveReport({...ghInput,report_id:'SW-20260914-OTHER'},
    {env:{...env,SHADOWWATCH_EVIDENCE_TOKEN:'t'},fetch:fakeGithub().fetch,gh:evidenceGh}),
    /ARCHIVE_RUN_NOT_COMMITTED/);
  // A run id that is not the anchor this report sealed is refused.
  await assert.rejects(()=>A.archiveFactsFromEvidence('gh-999999999','SW-20260914-FSO32',
    {env:{SHADOWWATCH_EVIDENCE_TOKEN:'t'},gh:evidenceGh}),/ARCHIVE_RUN_ANCHOR_MISMATCH/);
  // A history file that is not the state the manifest recorded is refused
  // rather than believed — the manifest's hash is the authority.
  //
  // The tamper has to be one that ONLY the hash check can catch, or the test
  // proves nothing about it: a state naming a different report is caught by the
  // report-id check, and an unsealed edit is caught by verify(). So this is a
  // properly re-sealed state, internally consistent, naming the right report,
  // differing from the manifest by one cosmetic field — and therefore by its
  // hash, which is the whole point of recording it.
  const keep=evidenceFiles[Store.historyPath(ghState.state_version)];
  const resealed=State.seal({...JSON.parse(keep),anchor_close:'2026-09-14T15:43:41.000Z'});
  assert.notEqual(resealed.state_sha256,ghState.state_sha256);
  assert.equal(resealed.sealed_run.report_id,'SW-20260914-FSO32');
  assert.ok(State.verify(resealed).ok,'the tampered state must still be internally valid');
  evidenceFiles[Store.historyPath(ghState.state_version)]=JSON.stringify(resealed,null,2)+'\n';
  await assert.rejects(()=>A.archiveFactsFromEvidence('gh-'+ANCHOR,'SW-20260914-FSO32',
    {env:{SHADOWWATCH_EVIDENCE_TOKEN:'t'},gh:evidenceGh}),
    /ARCHIVE_STATE_HISTORY_MISMATCH/);
  evidenceFiles[Store.historyPath(ghState.state_version)]=keep;
  // The legacy identity still validates, so old receipts keep working.
  assert.ok(A.IDX_RUN.test(complete.evidence_scan_id));
  await assert.rejects(()=>A.archiveReport({...input,evidence_scan_id:'nonsense'},
    {env,fetch:gh.fetch,archiveFacts}),/INVALID_EVIDENCE_SCAN_ID/);
  console.log('PASS an unsealed report, a stale run and a nonsense identity are all refused');

  console.log('ALL GITHUB REPORT ARCHIVE CHECKS PASS');
}
main().catch(e=>{console.error(e);process.exitCode=1;});
