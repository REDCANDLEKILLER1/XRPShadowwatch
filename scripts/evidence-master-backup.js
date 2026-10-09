#!/usr/bin/env node
'use strict';
const B=require('../src/db/master-backup');
(async()=>{
 const [command,...args]=process.argv.slice(2);const option=k=>{const i=args.indexOf(k);return i<0?null:args[i+1];};
 let result;
 if(command==='backup'&&option('--out'))result=await B.backup(option('--out'),{onProgress:(done,total)=>{if(done===total||done%25===0)console.log('Copied '+done+'/'+total+' files');}});
 else if(command==='verify'&&option('--in'))result=B.verify(option('--in'),option('--commit'),option('--manifest-sha'));
 else if(command==='restore'&&option('--in')&&option('--out'))result=B.restore(option('--in'),option('--out'),option('--commit'),option('--manifest-sha'));
 else if(command==='attest-restore'&&option('--in')&&option('--downloaded-from')&&option('--commit')){
  const fs=require('fs'),path=require('path'),A=require('../src/db/github-archive');
  const destination=require('../src/db/backup-receipt').destination(option('--downloaded-from'));
  const restored=path.resolve(option('--in')+'-restore-check');
  const checked=B.restore(option('--in'),restored,option('--commit'),option('--manifest-sha'));
  const target=A.evidenceWriteTarget();const gh=A.client(target.token,target.repo,fetch);
  const manifest=JSON.parse(fs.readFileSync(path.join(option('--in'),'manifest.json'),'utf8'));
  const source=await gh('GET','/git/commits/'+checked.source_commit);
  if(source.tree.sha!==manifest.source_tree)throw Error('BACKUP_SOURCE_TREE_NOT_CANONICAL');
  const ref=await gh('GET','/git/ref/heads/'+target.branch);
  const receipt={schema:'shadowwatch-independent-restore/1',verified_at:new Date().toISOString(),source_commit:checked.source_commit,evidence_anchor_close:checked.anchor_close,manifest_sha256:checked.manifest_sha256,restore_verified:true,destination_uri:destination,destination_verification:'OPERATOR_DOWNLOADED_AND_RESTORED',files:checked.files,bytes:checked.bytes};
  const written=await A.commitFiles(gh,target.branch,ref.object.sha,{'evidence/backup/latest.json':JSON.stringify(receipt,null,2)+'\n'},'backup: operator-downloaded copy passed isolated restore');
  result={...receipt,receipt_commit:written.commit_sha};
 }
 else throw Error('Usage: evidence-master-backup.js backup --out NEW_DIRECTORY | verify --in DIRECTORY [--commit SHA] | restore --in DIRECTORY --out NEW_DIRECTORY [--commit SHA]');
 console.log(JSON.stringify(result,null,2));
})().catch(e=>{console.error(e.message);process.exitCode=1;});
