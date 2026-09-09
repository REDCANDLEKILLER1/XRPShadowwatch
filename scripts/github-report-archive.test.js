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
  console.log('ALL GITHUB REPORT ARCHIVE CHECKS PASS');
}
main().catch(e=>{console.error(e);process.exitCode=1;});
