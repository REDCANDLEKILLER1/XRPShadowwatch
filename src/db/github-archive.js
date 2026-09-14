'use strict';
const crypto=require('crypto');
const E=require('./evidence');

const BRANCH='shadowwatch-report-archive';
const REPO='REDCANDLEKILLER1/XRPShadowwatch';
// The evidence store is a SEPARATE private repository. Keeping daily delta
// shards out of the application repo means the code repo's history is not
// dragged along by every clone and every CI run, and it lets the two carry
// different access. Pinned exactly like the report archive, and refused the
// same way if an environment tries to redirect it.
const EVIDENCE_REPO='REDCANDLEKILLER1/SHADOWWATCH_EVIDENCE_REPO-REDCANDLEKILLER1-XRPShadowwatch-evidence';
const EVIDENCE_BRANCH='main';
const MAX_REPORT_BYTES=512*1024;
const ALLOWED=new Set(['report_id','scan_id','evidence_scan_id','generated_at','morning_report','morning_hash','public_hash','full_hash']);
const sha=text=>crypto.createHash('sha256').update(String(text),'utf8').digest('hex');
const json=value=>JSON.stringify(value,null,2)+'\n';
const b64=text=>Buffer.from(text,'utf8').toString('base64');

const IDX_RUN=/^idx-[a-f0-9-]{36}$/;   // a Neon acquisition run
const GH_RUN=/^gh-\d+$/;               // a GitHub-backed run, named for its anchor

// ── THE RECEIPT'S FACTS COME FROM THE CHECKPOINT, NOT FROM THE CALLER ──────
//
// The Neon path read them out of the database for exactly this reason: a caller
// who could state its own coverage could archive a receipt saying it proved
// four hundred wallets when it proved six. The GitHub path has to hold the same
// line, so the facts are read back out of the committed state — which is
// hash-verified on the way in by readState() — and the caller supplies nothing
// but the report text and its own seal hashes.
//
// It also checks that the state's sealed run NAMES THIS REPORT. Without that a
// report could be archived against whatever checkpoint happened to be current,
// borrowing another run's coverage for its own receipt.
async function archiveFactsFromEvidence(runId,deps={}){
  // Required lazily: github-store requires this module, and a top-level require
  // back into it would be a cycle. By call time both are loaded.
  const Store=deps.store||require('./github-store');
  // readState answers {state, missing, branch} and verifies the state's own
  // hash before returning it — so a tampered checkpoint cannot become a
  // receipt's facts.
  const read=await Store.readState({env:deps.env,gh:deps.gh,fetch:deps.fetch});
  const state=read&&read.state;
  if(!state)throw new Error('ARCHIVE_EVIDENCE_STATE_MISSING');
  const anchor=Number(state.anchor_ledger);
  if(runId!=='gh-'+anchor)
    throw new Error('ARCHIVE_RUN_NOT_CURRENT: '+runId+' but the checkpoint stands at gh-'+anchor);
  const run=state.sealed_run||{};
  const target=Number(run.target_wallets)||0,proved=Number(run.complete_wallets)||0;
  return {
    report_id:run.report_id||null,
    scan_id:run.scan_id||null,
    evidence_scan_id:runId,
    evidence_source:'GITHUB_EVIDENCE_STORE',
    state_version:Number(state.state_version)||null,
    state_sha256:state.state_sha256||null,
    // The instant the evidence describes, which is what dates the receipt.
    // Never a clock read here and never a date the caller chose.
    generated_at:state.anchor_close||null,
    validated_anchor_ledger:anchor,
    target_wallets:target,
    transaction_windows_proved:proved,
    coverage_complete:target>0&&proved===target&&Number(run.balance_contradictions||0)===0,
    // What the checkpoint actually holds. Deliberately NOT called
    // "transactions in window": the report's window spans the days it covers
    // and is assembled separately, while this is every row the store has
    // committed. Naming the second as the first would overstate the receipt.
    evidence_rows_committed:(state.evidence_shards||[])
      .reduce((n,shard)=>n+(Number(shard.rows)||0),0),
    evidence_shards:(state.evidence_shards||[]).length,
    wallet_count:Number(state.wallet_count)||target,
    // Not derivable from a checkpoint, and not accepted from the caller, so
    // they are absent rather than guessed.
    transactions_in_window:null,
    new_observations:null,
    xrpl_requests:null
  };
}

function validate(input){
  if(!input||typeof input!=='object'||Array.isArray(input))throw new Error('INVALID_ARCHIVE_REQUEST');
  for(const key of Object.keys(input))if(!ALLOWED.has(key))throw new Error('ARCHIVE_FIELD_NOT_ALLOWED: '+key);
  if(!/^SW-\d{8}-[A-Z0-9]{5}$/.test(input.report_id||''))throw new Error('INVALID_REPORT_ID');
  if(!/^SC-[A-Z0-9]+$/.test(input.scan_id||''))throw new Error('INVALID_SCAN_ID');
  // TWO run identities, because there are two evidence stores and one of them
  // is being retired. `idx-<uuid>` is a Neon acquisition run; `gh-<ledger>` is
  // a GitHub-backed one, named for the anchor it proved. Every report produced
  // since the delta migration carries the second shape, and this line rejecting
  // it is why the live SW-20260914-FSO32 receipt failed with
  // INVALID_EVIDENCE_SCAN_ID — every new run archived nothing at all.
  //
  // The legacy pattern is not loosened to admit the new one; they are separate
  // and each is exact.
  if(!GH_RUN.test(input.evidence_scan_id||'')&&!IDX_RUN.test(input.evidence_scan_id||''))
    throw new Error('INVALID_EVIDENCE_SCAN_ID');
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

// ── One fast-forward commit ────────────────────────────────────────────────
// Factored out because the evidence export commits through the same branch and
// the same token, and two implementations of "write files to the archive"
// would drift. Files may be strings (UTF-8) or Buffers: the report path writes
// text, the export path writes gzip shards.
//
// A 422 on the ref PATCH means someone else moved the branch first, and it is
// the ONLY failure the caller may retry — so it is tagged rather than left for
// the caller to infer from a status code that other calls could also produce.
// Blob uploads are INDEPENDENT of each other — each one is a content-addressed
// write that names nothing else — so they have no reason to queue. Uploading 21
// shards one at a time turned a commit into a long series of round trips, each
// one waiting out the last. The tree, the commit and the ref update stay
// strictly ordered below, because those genuinely depend on what came before.
const BLOB_CONCURRENCY=6;
async function commitFiles(gh,branch,parentSha,files,message,onProgress){
  const commit=await gh('GET','/git/commits/'+parentSha);
  const list=Object.entries(files);
  const entries=new Array(list.length);
  let cursor=0,done=0;
  const worker=async()=>{
    for(;;){
      const i=cursor++;
      if(i>=list.length)return;
      const [filePath,content]=list[i];
      // A null value REMOVES the path. Git's tree API reads sha:null as a
      // deletion, which is how a run clears its resume journal in the very same
      // commit that lands the evidence rather than in a second one that might
      // never happen.
      if(content===null){entries[i]={path:filePath,mode:'100644',type:'blob',sha:null};}
      else{
        const buffer=Buffer.isBuffer(content)?content:Buffer.from(content,'utf8');
        const blob=await gh('POST','/git/blobs',{content:buffer.toString('base64'),encoding:'base64'});
        entries[i]={path:filePath,mode:'100644',type:'blob',sha:blob.sha};
      }
      if(typeof onProgress==='function')onProgress(++done,list.length,filePath);
    }
  };
  await Promise.all(Array.from({length:Math.min(BLOB_CONCURRENCY,list.length||1)},worker));
  const tree=await gh('POST','/git/trees',{base_tree:commit.tree.sha,tree:entries});
  const made=await gh('POST','/git/commits',{message,tree:tree.sha,parents:[parentSha]});
  try{await gh('PATCH','/git/refs/heads/'+branch,{sha:made.sha,force:false});}
  catch(e){if(e.status===422)e.refConflict=true;throw e;}
  return {commit_sha:made.sha,files_written:entries.length,
    files_removed:entries.filter(e=>e.sha===null).length,
    bytes_written:Object.values(files).reduce((n,c)=>n+(c===null?0:(Buffer.isBuffer(c)?c.length:Buffer.byteLength(c,'utf8'))),0)};
}

// Resolve the archive branch, creating it from the default branch the first
// time. Shared for the same reason commitFiles is.
async function archiveRef(gh,branch){
  let ref=await gh('GET','/git/ref/heads/'+branch,undefined,true);
  if(ref)return ref;
  const metadata=await gh('GET','');
  const source=await gh('GET','/git/ref/heads/'+metadata.default_branch);
  try{return await gh('POST','/git/refs',{ref:'refs/heads/'+branch,sha:source.object.sha});}
  catch(e){if(e.status!==422)throw e;return await gh('GET','/git/ref/heads/'+branch);}
}

// The evidence store's pinned target. Its own token when one is configured,
// because a fine-grained token for the evidence repo need not — and probably
// should not — also carry write access to the application repo. Falls back to
// the archive token, since one fine-grained token CAN legitimately be scoped to
// both; a missing token is refused rather than guessed at.
function evidenceTarget(env){
  const e=env||process.env;
  const token=e.SHADOWWATCH_EVIDENCE_TOKEN||e.SHADOWWATCH_GITHUB_ARCHIVE_TOKEN;
  if(!token)throw new Error('EVIDENCE_STORE_NOT_CONFIGURED: set SHADOWWATCH_EVIDENCE_TOKEN');
  const repo=e.SHADOWWATCH_EVIDENCE_REPOSITORY||EVIDENCE_REPO;
  const branch=e.SHADOWWATCH_EVIDENCE_BRANCH||EVIDENCE_BRANCH;
  if(repo!==EVIDENCE_REPO||branch!==EVIDENCE_BRANCH)throw new Error('EVIDENCE_TARGET_REFUSED');
  return {token,repo,branch};
}

// READING the sealed receipts. Same pinned repository and branch as
// archiveTarget, but either token is accepted: a fine-grained token that can
// see both repositories is the normal setup, and requiring the archive
// variable specifically meant an operator had to configure two secrets to do
// one read. Writing still goes through archiveTarget, which is unchanged.
function archiveReadTarget(env){
  const e=env||process.env;
  const token=e.SHADOWWATCH_GITHUB_ARCHIVE_TOKEN||e.SHADOWWATCH_EVIDENCE_TOKEN;
  if(!token)throw new Error('GITHUB_ARCHIVE_NOT_CONFIGURED');
  const repo=e.SHADOWWATCH_GITHUB_ARCHIVE_REPOSITORY||REPO;
  const branch=e.SHADOWWATCH_GITHUB_ARCHIVE_BRANCH||BRANCH;
  if(repo!==REPO||branch!==BRANCH)throw new Error('GITHUB_ARCHIVE_TARGET_REFUSED');
  return {token,repo,branch};
}

// The pinned target, refused if an environment tries to redirect it. Shared so
// the export cannot be pointed somewhere the report archive would not go.
function archiveTarget(env){
  const token=env.SHADOWWATCH_GITHUB_ARCHIVE_TOKEN;
  if(!token)throw new Error('GITHUB_ARCHIVE_NOT_CONFIGURED');
  const repo=env.SHADOWWATCH_GITHUB_ARCHIVE_REPOSITORY||REPO;
  const branch=env.SHADOWWATCH_GITHUB_ARCHIVE_BRANCH||BRANCH;
  if(repo!==REPO||branch!==BRANCH)throw new Error('GITHUB_ARCHIVE_TARGET_REFUSED');
  return {token,repo,branch};
}

async function archiveReport(raw,deps={}){
  const input=validate(raw),env=deps.env||process.env;
  const {token,repo,branch}=archiveTarget(env);
  // Whichever store proved this run answers for it. A gh- run never reaches
  // Neon, which is what keeps the runtime free of it.
  const facts=deps.archiveFacts
    ? await deps.archiveFacts(input.evidence_scan_id)
    : (GH_RUN.test(input.evidence_scan_id)
        ? await archiveFactsFromEvidence(input.evidence_scan_id,deps)
        : await E.archiveFacts(input.evidence_scan_id));
  if(!facts||!facts.target_wallets)throw new Error('ARCHIVE_RUN_NOT_FOUND');
  // The receipt must describe the run that committed THIS report. Archiving a
  // report against a checkpoint sealed by a different one would hand it
  // coverage it never earned.
  if(facts.report_id&&facts.report_id!==input.report_id)
    throw new Error('ARCHIVE_REPORT_NOT_IN_STATE: checkpoint was sealed by '+facts.report_id);
  // An INCOMPLETE run is still archived, with coverage_complete:false written
  // into its receipt. That is deliberate and predates this change: refusing it
  // would delete the record of a morning that did not finish, which is the
  // opposite of what an evidence archive is for. What may be CLAIMED is the
  // seal's business, and the seal already refuses without coverage. A run that
  // never committed is a different matter, and the check above is what catches
  // it — the checkpoint does not name the report.
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
  let ref=await archiveRef(gh,branch);
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
    try{
      const written=await commitFiles(gh,branch,ref.object.sha,files,
        'report: '+input.report_id+' — '+facts.transaction_windows_proved+'/'+facts.target_wallets+
        ' — ledger '+facts.validated_anchor_ledger);
      return {attempted:true,status:'ARCHIVED',report_id:input.report_id,branch,commit_sha:written.commit_sha,archived_at:new Date().toISOString(),
        archive_path:root,files_written:written.files_written,bytes_written:written.bytes_written,retry_count:attempt};
    }catch(e){if(!e.refConflict||attempt===3)throw e;}
  }
  throw new Error('GITHUB_ARCHIVE_RETRY_EXHAUSTED');
}

module.exports={archiveReport,validate,sha,client,commitFiles,archiveRef,archiveTarget,archiveReadTarget,evidenceTarget,
  archiveFactsFromEvidence,IDX_RUN,GH_RUN,
  BRANCH,REPO,EVIDENCE_BRANCH,EVIDENCE_REPO,MAX_REPORT_BYTES};
