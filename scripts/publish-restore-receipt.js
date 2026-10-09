'use strict';
// Worker-only: a logged restore result is insufficient. Reverify the actual
// downloaded/restored directory and canonical source before publishing proof.
const fs=require('fs'),path=require('path');
const B=require('../src/db/master-backup'),A=require('../src/db/github-archive'),Store=require('../src/db/github-store'),Receipt=require('../src/db/backup-receipt');
const LATEST='evidence/backup/latest.json';
async function publish(restored,result,deps={}){
 const target=A.evidenceWriteTarget(deps.env),gh=deps.gh||A.client(target.token,target.repo,deps.fetch||fetch);
 if(result?.restore_verified!==true||result.independent_readback_verified!==true)throw Error('BACKUP_INDEPENDENT_RESTORE_REQUIRED');
 const checked=B.verify(restored,result.source_commit,result.manifest_sha256);
 const manifest=JSON.parse(fs.readFileSync(path.join(restored,'manifest.json'),'utf8'));
 const source=await gh('GET','/git/commits/'+checked.source_commit);
 if(source.tree.sha!==manifest.source_tree)throw Error('BACKUP_SOURCE_TREE_NOT_CANONICAL');
 const now=deps.now?deps.now():Date.now();
 const receipt={schema:'shadowwatch-independent-restore/1',verified_at:new Date(now).toISOString(),source_commit:checked.source_commit,source_tree:manifest.source_tree,
  evidence_anchor_close:checked.anchor_close,manifest_sha256:checked.manifest_sha256,restore_verified:true,independent_readback_verified:true,
  destination_uri:Receipt.destination(result.destination_uri),destination_verification:'R2_DOWNLOADED_AND_ISOLATED_RESTORE',files:checked.files,bytes:checked.bytes};
 if(!Receipt.status(receipt,now).independent_restore_verified)throw Error('BACKUP_RECEIPT_NOT_RECENT');
 const text=JSON.stringify(receipt,null,2)+'\n';
 const read=deps.readFile||Store.readFile,commit=deps.commitFiles||A.commitFiles;
 for(let attempt=0;attempt<3;attempt++){
  const ref=await gh('GET','/git/ref/heads/'+target.branch);
  const raw=await read(gh,target.branch,LATEST,ref.object.sha);
  if(raw){
   let old;try{old=JSON.parse(raw);}catch(_){throw Error('BACKUP_RECEIPT_UNREADABLE');}
   // An older backup cannot displace proof of a more recent evidence anchor.
   if(Date.parse(old.evidence_anchor_close)>Date.parse(receipt.evidence_anchor_close))return{published:false,reason:'NEWER_RESTORE_RECEIPT_PRESENT'};
   if(Date.parse(old.evidence_anchor_close)===Date.parse(receipt.evidence_anchor_close)&&Date.parse(old.verified_at)>now)return{published:false,reason:'NEWER_RESTORE_RECEIPT_PRESENT'};
  }
  let written;
  try{written=await commit(gh,target.branch,ref.object.sha,{[LATEST]:text},'backup: independently downloaded R2 copy passed isolated restore');}
  catch(e){if(e.refConflict&&attempt<2)continue;throw e;}
  // Read the exact committed receipt, not an unpinned moving pointer.
  if(await read(gh,target.branch,LATEST,written.commit_sha)!==text)throw Error('BACKUP_RECEIPT_READBACK_MISMATCH');
  return{published:true,receipt_commit:written.commit_sha,manifest_sha256:receipt.manifest_sha256};
 }
 throw Error('BACKUP_RECEIPT_PUBLICATION_CONFLICT');
}
module.exports={publish,LATEST};
