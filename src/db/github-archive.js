'use strict';
const crypto=require('crypto');
const E=require('./evidence');

const BRANCH='shadowwatch-report-archive';
const REPO='REDCANDLEKILLER1/XRPShadowwatch';
const MAX_REPORT_BYTES=512*1024;
const ALLOWED=new Set(['report_id','scan_id','evidence_scan_id','generated_at','morning_report','morning_hash','public_hash','full_hash']);
const sha=text=>crypto.createHash('sha256').update(String(text),'utf8').digest('hex');
const json=value=>JSON.stringify(value,null,2)+'\n';
const b64=text=>Buffer.from(text,'utf8').toString('base64');

function validate(input){
  if(!input||typeof input!=='object'||Array.isArray(input))throw new Error('INVALID_ARCHIVE_REQUEST');
  for(const key of Object.keys(input))if(!ALLOWED.has(key))throw new Error('ARCHIVE_FIELD_NOT_ALLOWED: '+key);
  if(!/^SW-\d{8}-[A-Z0-9]{5}$/.test(input.report_id||''))throw new Error('INVALID_REPORT_ID');
  if(!/^SC-[A-Z0-9]+$/.test(input.scan_id||''))throw new Error('INVALID_SCAN_ID');
  if(!/^idx-[a-f0-9-]{36}$/.test(input.evidence_scan_id||''))throw new Error('INVALID_EVIDENCE_SCAN_ID');
  if(typeof input.morning_report!=='string'||!input.morning_report.trim())throw new Error('MORNING_REPORT_REQUIRED');
  if(Buffer.byteLength(input.morning_report,'utf8')>MAX_REPORT_BYTES)throw new Error('ARCHIVE_PAYLOAD_TOO_LARGE');
  if(!/^[a-f0-9]{64}$/.test(input.morning_hash||'')||sha(input.morning_report)!==input.morning_hash)throw new Error('MORNING_REPORT_HASH_MISMATCH');
  if(!/^[a-f0-9]{32}$/.test(input.public_hash||'')||!/^[a-f0-9]{32}$/.test(input.full_hash||''))throw new Error('INVALID_SEAL_HASH');
  return input;
}

function client(token,repo,fetchImpl){
  const base='https://api.github.com/repos/'+repo;
  return async function(method,path,body,allow404){
    const response=await fetchImpl(base+path,{method,headers:{Accept:'application/vnd.github+json',
      Authorization:'Bearer '+token,'X-GitHub-Api-Version':'2022-11-28','Content-Type':'application/json'},
      body:body===undefined?undefined:JSON.stringify(body)});
    if(allow404&&response.status===404)return null;
    const data=await response.json().catch(()=>({}));
    if(!response.ok){const error=new Error('GITHUB_ARCHIVE_HTTP_'+response.status+': '+String(data.message||'request failed'));error.status=response.status;throw error;}
    return data;
  };
}

async function archiveReport(raw,deps={}){
  const input=validate(raw),env=deps.env||process.env;
  const token=env.SHADOWWATCH_GITHUB_ARCHIVE_TOKEN;
  if(!token)throw new Error('GITHUB_ARCHIVE_NOT_CONFIGURED');
  const repo=env.SHADOWWATCH_GITHUB_ARCHIVE_REPOSITORY||REPO;
  const branch=env.SHADOWWATCH_GITHUB_ARCHIVE_BRANCH||BRANCH;
  if(repo!==REPO||branch!==BRANCH)throw new Error('GITHUB_ARCHIVE_TARGET_REFUSED');
  const facts=await (deps.archiveFacts||E.archiveFacts)(input.evidence_scan_id);
  if(!facts||!facts.target_wallets)throw new Error('ARCHIVE_RUN_NOT_FOUND');
  const reportHash=sha(input.morning_report);
  const evidenceHash=sha(json(facts));
  // Directory date and canonical run facts come from Neon, never from a
  // caller-selected path or date. The seal timestamp is retained separately.
  const generatedAt=facts.generated_at;
  const date=/^\d{4}-\d{2}-\d{2}/.test(generatedAt)?generatedAt.slice(0,10):new Date().toISOString().slice(0,10);
  const root='reports/'+date.replace(/-/g,'/')+'/'+input.report_id;
  const receipt={report_id:input.report_id,scan_id:input.scan_id,...facts,sealed_at:input.generated_at||null,
    production_sha:env.VERCEL_GIT_COMMIT_SHA||null,
    report_hash:reportHash,evidence_hash:evidenceHash,seal_public_hash:input.public_hash,seal_evidence_hash:input.full_hash,archive_branch:branch};
  const summary={report_id:receipt.report_id,generated_at:receipt.generated_at,coverage_complete:receipt.coverage_complete,
    target_wallets:receipt.target_wallets,transaction_windows_proved:receipt.transaction_windows_proved,
    validated_anchor_ledger:receipt.validated_anchor_ledger,transactions_in_window:receipt.transactions_in_window,
    new_observations:receipt.new_observations,xrpl_requests:receipt.xrpl_requests,report_hash:reportHash};
  const files={[root+'/receipt.json']:json(receipt),[root+'/morning-report.txt']:input.morning_report,
    [root+'/summary.json']:json(summary)};
  const fetchImpl=deps.fetch||fetch,gh=client(token,repo,fetchImpl);
  let ref=await gh('GET','/git/ref/heads/'+branch,undefined,true);
  if(!ref){
    const metadata=await gh('GET','');
    const source=await gh('GET','/git/ref/heads/'+metadata.default_branch);
    try{ref=await gh('POST','/git/refs',{ref:'refs/heads/'+branch,sha:source.object.sha});}
    catch(e){if(e.status!==422)throw e;ref=await gh('GET','/git/ref/heads/'+branch);}
  }
  for(let attempt=0;attempt<4;attempt++){
    ref=await gh('GET','/git/ref/heads/'+branch);
    const existing=await gh('GET','/contents/'+root+'/receipt.json?ref='+encodeURIComponent(branch),undefined,true);
    if(existing){
      const prior=JSON.parse(Buffer.from(existing.content||'','base64').toString('utf8'));
      if(prior.report_hash===reportHash&&prior.evidence_hash===evidenceHash)
        return {attempted:true,status:'ALREADY_ARCHIVED',report_id:input.report_id,branch,commit_sha:null,
          archive_path:root,files_written:0,bytes_written:0,retry_count:attempt};
      const conflict=new Error('ARCHIVE_CONFLICT');conflict.code='ARCHIVE_CONFLICT';throw conflict;
    }
    const dayRoot='reports/'+date.replace(/-/g,'/');
    const indexFile=await gh('GET','/contents/'+dayRoot+'/index.json?ref='+encodeURIComponent(branch),undefined,true);
    let index=[];
    if(indexFile){try{index=JSON.parse(Buffer.from(indexFile.content||'','base64').toString('utf8'));}catch(_){throw new Error('ARCHIVE_INDEX_INVALID');}}
    index=Array.isArray(index)?index:[];
    if(!index.some(row=>row.report_id===input.report_id))index.push({report_id:input.report_id,generated_at:generatedAt,
      coverage_complete:facts.coverage_complete,anchor:facts.validated_anchor_ledger,transactions:facts.transactions_in_window,report_hash:reportHash});
    files[dayRoot+'/index.json']=json(index.sort((a,b)=>String(a.report_id).localeCompare(String(b.report_id))));
    const commit=await gh('GET','/git/commits/'+ref.object.sha);
    const entries=[];
    for(const [path,content] of Object.entries(files)){
      const blob=await gh('POST','/git/blobs',{content:b64(content),encoding:'base64'});
      entries.push({path,mode:'100644',type:'blob',sha:blob.sha});
    }
    const tree=await gh('POST','/git/trees',{base_tree:commit.tree.sha,tree:entries});
    const made=await gh('POST','/git/commits',{message:'report: '+input.report_id+' — '+facts.transaction_windows_proved+'/'+facts.target_wallets+
      ' — ledger '+facts.validated_anchor_ledger,tree:tree.sha,parents:[ref.object.sha]});
    try{
      await gh('PATCH','/git/refs/heads/'+branch,{sha:made.sha,force:false});
      return {attempted:true,status:'ARCHIVED',report_id:input.report_id,branch,commit_sha:made.sha,archived_at:new Date().toISOString(),
        archive_path:root,files_written:Object.keys(files).length,bytes_written:Object.values(files).reduce((n,s)=>n+Buffer.byteLength(s),0),retry_count:attempt};
    }catch(e){if(e.status!==422||attempt===3)throw e;}
  }
  throw new Error('GITHUB_ARCHIVE_RETRY_EXHAUSTED');
}

module.exports={archiveReport,validate,sha,BRANCH,REPO,MAX_REPORT_BYTES};
