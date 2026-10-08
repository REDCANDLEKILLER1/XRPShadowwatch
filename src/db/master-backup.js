'use strict';
const crypto=require('crypto'),fs=require('fs'),path=require('path'),zlib=require('zlib');
const A=require('./github-archive'),Store=require('./github-store'),State=require('./evidence-state'),H=require('./storage-health');
const SCHEMA='shadowwatch-master-backup/1';
const sha256=b=>crypto.createHash('sha256').update(b).digest('hex');
const blobSha=b=>crypto.createHash('sha1').update(Buffer.from('blob '+b.length+'\0')).update(b).digest('hex');
function treeSha(entries){
 const root=new Map();
 for(const e of entries){let tree=root;const parts=relative(e.path).split('/');for(const name of parts.slice(0,-1)){if(!tree.has(name))tree.set(name,new Map());tree=tree.get(name);if(!(tree instanceof Map))throw Error('BACKUP_TREE_COLLISION');}if(tree.has(parts.at(-1)))throw Error('BACKUP_TREE_COLLISION');tree.set(parts.at(-1),e.git_blob_sha);}
 function digest(tree){const rows=[...tree].sort((a,b)=>Buffer.compare(Buffer.from(a[0]+(a[1] instanceof Map?'/':'')),Buffer.from(b[0]+(b[1] instanceof Map?'/':''))));
  const bytes=Buffer.concat(rows.map(([name,v])=>Buffer.concat([Buffer.from((v instanceof Map?'40000':'100644')+' '+name+'\0'),Buffer.from(v instanceof Map?digest(v):v,'hex')])));
  return crypto.createHash('sha1').update(Buffer.from('tree '+bytes.length+'\0')).update(bytes).digest('hex');
 }return digest(root);
}
function relative(p){if(typeof p!=='string'||!p||p.includes('\\')||p.split('/').some(v=>!v||v==='.'||v==='..')||path.isAbsolute(p)||p==='manifest.json')throw Error('BACKUP_PATH_REFUSED');return p;}
function file(root,p){return path.join(root,relative(p));}
function seal(m){const copy={...m};delete copy.manifest_sha256;return sha256(JSON.stringify(copy));}
function newDirectory(root){fs.mkdirSync(root,{recursive:false});}
function checkFile(root,e){
 const p=file(root,e.path),stat=fs.lstatSync(p);if(!stat.isFile()||stat.isSymbolicLink())throw Error('BACKUP_FILE_REFUSED');
 // Reject symlink ancestors too: restore never follows a path outside the source.
 let parent=path.dirname(p);while(parent!==root){if(fs.lstatSync(parent).isSymbolicLink())throw Error('BACKUP_SYMLINK_REFUSED');parent=path.dirname(parent);}
 const b=fs.readFileSync(p);if(b.length!==e.bytes||sha256(b)!==e.sha256||blobSha(b)!==e.git_blob_sha)throw Error('BACKUP_FILE_MISMATCH: '+e.path);return b;
}
function verify(root,expectedCommit,expectedManifest){
 root=path.resolve(root);if(fs.lstatSync(root).isSymbolicLink())throw Error('BACKUP_SYMLINK_REFUSED');
 const manifestFile=path.join(root,'manifest.json');if(fs.lstatSync(manifestFile).isSymbolicLink())throw Error('BACKUP_SYMLINK_REFUSED');
 const m=JSON.parse(fs.readFileSync(manifestFile,'utf8'));
 if(m.schema!==SCHEMA||m.manifest_sha256!==seal(m)||!Array.isArray(m.files)||!m.files.length||!/^[a-f0-9]{40}$/.test(m.source_commit)||m.source_repository!==A.EVIDENCE_REPO)throw Error('BACKUP_MANIFEST_INVALID');
 if(expectedManifest&&m.manifest_sha256!==expectedManifest)throw Error('BACKUP_MANIFEST_SEAL_MISMATCH');
 if(expectedCommit&&m.source_commit!==expectedCommit)throw Error('BACKUP_SOURCE_COMMIT_MISMATCH');
 const seen=new Set();let bytes=0;
 for(const e of m.files){relative(e.path);if(seen.has(e.path))throw Error('BACKUP_DUPLICATE_PATH');seen.add(e.path);checkFile(root,e);bytes+=e.bytes;}
 if(treeSha(m.files)!==m.source_tree)throw Error('BACKUP_SOURCE_TREE_MISMATCH');
 if(bytes!==m.total_bytes||seen.size!==m.file_count)throw Error('BACKUP_COUNTS_MISMATCH');
 const latest=JSON.parse(fs.readFileSync(file(root,Store.STATE_PATH),'utf8'));let current=latest,walked=0;const dayManifests=new Map();
 while(current){
  const own=State.verify(current);if(!own.ok)throw Error('BACKUP_STATE_INVALID');walked++;
  // Use the storage module's canonical path; the state chain must survive restore.
  const canonical=Store.historyPath(current.state_version);
  const days=new Map();
  for(const e of current.evidence_shards||[]){const day=(e.path.match(/^evidence\/(\d{4}\/\d{2}\/\d{2})\//)||[])[1];if(day){if(!days.has(day))days.set(day,[]);days.get(day).push(e);}}
  for(const [day,shards] of days)if(!dayManifests.has(day))dayManifests.set(day,shards);
  if(!seen.has(canonical))throw Error('BACKUP_STATE_HISTORY_MISSING');
  if(fs.readFileSync(file(root,canonical),'utf8')!==State.serialize(current))throw Error('BACKUP_STATE_HISTORY_MISMATCH');
  if(Number(current.state_version)<=1)break;
  const prevPath=Store.historyPath(Number(current.state_version)-1);if(!seen.has(prevPath))throw Error('BACKUP_STATE_HISTORY_MISSING');
  const previous=JSON.parse(fs.readFileSync(file(root,prevPath),'utf8'));const verdict=State.verify(current,previous);if(!verdict.ok)throw Error('BACKUP_STATE_CHAIN_INVALID');current=previous;
 }
 for(const shards of dayManifests.values())for(const e of shards){
  if(!seen.has(e.path))throw Error('BACKUP_EVIDENCE_SHARD_MISSING');
  const text=zlib.gunzipSync(fs.readFileSync(file(root,e.path))).toString('utf8');
  if(sha256(text)!==e.sha256||text.split('\n').filter(Boolean).length!==e.rows)throw Error('BACKUP_EVIDENCE_SHARD_MISMATCH');
 }
 return{verified:true,source_commit:m.source_commit,files:m.file_count,bytes,checkpoint_versions:walked,anchor_close:latest.anchor_close,state_version:latest.state_version,manifest_sha256:m.manifest_sha256};
}
async function backup(root,deps={}){
 root=path.resolve(root);const target=A.evidenceTarget(deps.env),gh=deps.gh||A.client(target.token,target.repo,deps.fetch||fetch);
 const ref=await gh('GET','/git/ref/heads/'+target.branch),commit=await gh('GET','/git/commits/'+ref.object.sha);
 const tree=await gh('GET','/git/trees/'+commit.tree.sha+'?recursive=1');H.inventory(tree);
 // Immutable source ref; one file at a time bounds memory. No source writes or deletions.
 newDirectory(root);const entries=[];
 for(const e of tree.tree.filter(e=>e.type==='blob').sort((a,b)=>a.path.localeCompare(b.path))){
  relative(e.path);const data=await Store.readBytes(gh,target.branch,e.path,ref.object.sha);
  if(!data||data.length!==e.size||blobSha(data)!==e.sha)throw Error('BACKUP_SOURCE_BLOB_MISMATCH: '+e.path);
  const p=file(root,e.path);fs.mkdirSync(path.dirname(p),{recursive:true});fs.writeFileSync(p,data,{flag:'wx'});
  entries.push({path:e.path,bytes:data.length,sha256:sha256(data),git_blob_sha:e.sha});
  if(deps.onProgress)deps.onProgress(entries.length,tree.tree.filter(e=>e.type==='blob').length,e.path);
 }
 const m={schema:SCHEMA,created_at:new Date().toISOString(),source_repository:target.repo,source_commit:ref.object.sha,source_tree:commit.tree.sha,file_count:entries.length,total_bytes:entries.reduce((n,e)=>n+e.bytes,0),files:entries};
 m.manifest_sha256=seal(m);fs.writeFileSync(path.join(root,'manifest.json'),JSON.stringify(m,null,2)+'\n',{flag:'wx'});
 return verify(root,ref.object.sha);
}
function restore(source,destination,expectedCommit,expectedManifest){
 const receipt=verify(source,expectedCommit,expectedManifest);source=path.resolve(source);destination=path.resolve(destination);newDirectory(destination);
 const m=JSON.parse(fs.readFileSync(path.join(source,'manifest.json'),'utf8'));
 for(const e of m.files){const p=file(destination,e.path);fs.mkdirSync(path.dirname(p),{recursive:true});fs.writeFileSync(p,checkFile(source,e),{flag:'wx'});}
 fs.copyFileSync(path.join(source,'manifest.json'),path.join(destination,'manifest.json'),fs.constants.COPYFILE_EXCL);
 const restored=verify(destination,receipt.source_commit);return{...restored,restore_verified:true};
}
module.exports={SCHEMA,sha256,blobSha,treeSha,relative,seal,backup,verify,restore};
