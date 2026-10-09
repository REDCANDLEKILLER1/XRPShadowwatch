'use strict';
const A=require('./github-archive');
const Store=require('./github-store');
const GIB=1024**3;
// Operational thresholds, not claims about a provider's hard quota.
const POLICY={warning_bytes:5*GIB,critical_bytes:8*GIB,backup_max_age_hours:24};
function inventory(tree){
 if(!tree||tree.truncated||!Array.isArray(tree.tree))throw Error('STORAGE_INVENTORY_INCOMPLETE');
 let bytes=0,files=0,max=0;const groups={};
 for(const e of tree.tree){
  if(e.type==='tree')continue;
  if(e.type!=='blob'||e.mode!=='100644'||!Number.isSafeInteger(e.size)||e.size<0)throw Error('STORAGE_UNSUPPORTED_ENTRY');
  files++;bytes+=e.size;max=Math.max(max,e.size);
  const key=e.path.startsWith('evidence/state/')?'checkpoints':e.path.startsWith('evidence/runs/')?'run_records':e.path.startsWith('evidence/')?'ledger_evidence':'other';
  groups[key]=(groups[key]||0)+e.size;
 }
 return{current_files:files,current_file_bytes:bytes,largest_file_bytes:max,groups};
}
async function health(deps={}){
 const target=A.evidenceTarget(deps.env);const gh=deps.gh||A.client(target.token,target.repo,deps.fetch||fetch);
 const ref=await gh('GET','/git/ref/heads/'+target.branch);
 const commit=await gh('GET','/git/commits/'+ref.object.sha);
 const [meta,tree,loaded]=await Promise.all([gh('GET',''),gh('GET','/git/trees/'+commit.tree.sha+'?recursive=1'),Store.readState({...deps,gh,ref:ref.object.sha})]);
 if(!Number.isSafeInteger(meta.size)||meta.size<0)throw Error('STORAGE_REPOSITORY_SIZE_UNKNOWN');
 let receipt=null;try{const raw=await Store.readFile(gh,target.branch,'evidence/backup/latest.json',ref.object.sha);receipt=raw&&JSON.parse(raw);}catch(_){}
 const backup=require('./backup-receipt').status(receipt,deps.now?deps.now():Date.now());
 const stats=inventory(tree);const repositoryBytes=meta.size*1024;
 const level=repositoryBytes>=POLICY.critical_bytes?'CRITICAL':repositoryBytes>=POLICY.warning_bytes?'WARNING':'OK';
 return{schema:'shadowwatch-storage-health/1',checked_at:new Date(deps.now?deps.now():Date.now()).toISOString(),
  source_commit:ref.object.sha,source_tree:commit.tree.sha,repository_bytes:repositoryBytes,
  repository_size_is_approximate:true,capacity_status:level,thresholds:{...POLICY},...stats,
  checkpoint:{verified:!!loaded.state,state_version:loaded.state?.state_version||null,wallets:loaded.state?.wallet_count||0,anchor_ledger:loaded.state?.anchor_ledger||null},
  backup,
  deletion_enabled:false,automatic_rollover_enabled:false,
  notes:['Repository size includes accumulated Git storage; deleting current files does not erase history.',
   'A GitHub copy is not an independent provider backup. Verify an offsite copy and isolated restore before retirement.',
   'Thresholds are operational warning levels, not a provider storage quota.']};
}
module.exports={POLICY,inventory,health};
