'use strict';
// Read-only retirement planning. No delete method, storage writes, policy
// activation, or evidence mutation exists in this module.
const crypto=require('crypto');
const State=require('./evidence-state');
const PREFIX='bounded/v1/',ROOT=PREFIX+'root.json',DAY=86400000;
const hash=b=>crypto.createHash('sha256').update(b).digest('hex');
const fail=message=>{throw Error(message);};
function keyOfRef(value) {
 if(typeof value!=='string'||!/^bounded:[a-f0-9]{64}$/.test(value))fail('RETENTION_SNAPSHOT_REF_INVALID');
 return PREFIX+'snapshots/'+value.slice(8)+'.json';
}
function rootReferences(root) {
 if(!root||root.schema!=='shadowwatch-bounded-store/1'||!State.verify(root.state).ok)fail('RETENTION_ROOT_INVALID');
 const refs=[];
 const object=ref=>{
  if(!ref||typeof ref.key!=='string'||!ref.key.startsWith(PREFIX)||!/^[a-f0-9]{64}$/.test(ref.sha256)||!Number.isSafeInteger(ref.size)||ref.size<0)fail('RETENTION_OBJECT_REF_INVALID');
  refs.push({key:ref.key,sha256:ref.sha256,size:ref.size});
 };
 for(const group of ['files','daily','flags','frozen']) {
  if(!root[group]||typeof root[group]!=='object'||Array.isArray(root[group]))fail('RETENTION_ROOT_INVALID');
  for(const ref of Object.values(root[group]))object(ref);
 }
 if(!root.days||typeof root.days!=='object')fail('RETENTION_ROOT_INVALID');
 for(const day of Object.values(root.days)) {
  if(!Array.isArray(day.shards))fail('RETENTION_DAY_INVALID');
  for(const shard of day.shards)object(shard.object);
 }
 for(const ref of Object.values(root.state_snapshots||{}))refs.push({key:keyOfRef(ref)});
 if(root.pending?.previous_ref)refs.push({key:keyOfRef(root.pending.previous_ref)});
 return refs;
}
function frozenReferences(value) {
 if(!value||!Array.isArray(value.shards)||!Number.isSafeInteger(value.state_version)||!/^[a-f0-9]{64}$/.test(value.state_sha256||''))fail('RETENTION_FROZEN_MANIFEST_INVALID');
 return value.shards.map(s=>{
  const ref=s.object;
  if(!ref||typeof ref.key!=='string'||!ref.key.startsWith(PREFIX)||!/^[a-f0-9]{64}$/.test(ref.sha256||'')||!Number.isSafeInteger(ref.size)||ref.size<0)fail('RETENTION_OBJECT_REF_INVALID');
  return {key:ref.key,sha256:ref.sha256,size:ref.size};
 });
}
// Only schema-owned reference fields are traversed. Arbitrary ledger payload
// JSON is untrusted data and cannot create retention roots or fake references.
async function reachability(root,entries,read) {
 const Backup=require('./bounded-backup');
 const byKey=new Map(entries.map(e=>[e.key,e])),reasons=new Map();
 if(byKey.size!==entries.length)fail('RETENTION_DUPLICATE_KEY');
 const queue=[],proofKeys=new Set();
 const protect=(key,reason)=>{
  if(!byKey.has(key))fail('RETENTION_REFERENCED_OBJECT_MISSING: '+key);
  if(!reasons.has(key))reasons.set(key,new Set());
  reasons.get(key).add(reason);
 };
 const readChecked=async key=>{
  const e=byKey.get(key);if(!e)fail('RETENTION_REFERENCED_OBJECT_MISSING: '+key);
  const b=await read(key);
  if(!Buffer.isBuffer(b)||b.length!==e.size||hash(b)!==e.sha256)fail('RETENTION_OBJECT_UNVERIFIED: '+key);
  return b;
 };
 const addRoot=(value,label)=>{
  for(const ref of rootReferences(value)) {
   protect(ref.key,label);
   const e=byKey.get(ref.key);
   if(ref.sha256&&(e.sha256!==ref.sha256||e.size!==ref.size))fail('RETENTION_REFERENCE_MISMATCH');
  }
  for(const ref of Object.values(value.frozen))queue.push(ref.key);
  for(const [path,ref] of Object.entries(value.files))if(/^evidence\/state\/history\/\d{8,}\.json$/.test(path)||/^evidence\/runs\/SW-\d{8}-[A-Z0-9]{5}\.json$/.test(path))proofKeys.add(ref.key);
 };
 protect(ROOT,'CURRENT_ROOT');addRoot(root,'CURRENT_CHECKPOINT_OR_JOURNAL');
 const bootstrapPaths=Object.keys(root.files).filter(path=>/^evidence\/state\/history\/\d{8,}\.json$/.test(path))
  .sort((a,b)=>Number(a.split('/').at(-1).slice(0,-5))-Number(b.split('/').at(-1).slice(0,-5)));
 if(!bootstrapPaths.length)fail('RETENTION_BOOTSTRAP_STATE_MISSING');
 const bootstrap=JSON.parse(await readChecked(root.files[bootstrapPaths[0]].key));
 if(!State.verify(bootstrap).ok)fail('RETENTION_BOOTSTRAP_STATE_INVALID');
 const boundary={state_version:bootstrap.state_version,state_sha256:bootstrap.state_sha256,cutover_day:root.cutover_day};
 // Every snapshot is still a valid user-facing immutable report pin. No
 // retention policy is allowed to pretend these references expire themselves.
 for(const e of entries)if(e.key.startsWith(PREFIX+'snapshots/')) {
  protect(e.key,'HISTORICAL_SNAPSHOT');
  let snapshot;try{snapshot=JSON.parse(await readChecked(e.key));}catch(error){fail('RETENTION_SNAPSHOT_UNREADABLE: '+error.message);}
  addRoot(snapshot,'HISTORICAL_SNAPSHOT');
 }
 // Permanent frozen manifests remain read routes even if a root no longer
 // names them. Traverse their schema-owned shard edges before classifying.
 for(const e of entries)if(e.key.startsWith(PREFIX+'permanent/')) {
  protect(e.key,'PERMANENT_EVIDENCE');
  const value=JSON.parse(await readChecked(e.key));
  if(Array.isArray(value.shards))queue.push(e.key);
  proofKeys.add(e.key);
 }
 for(const key of proofKeys) {
  const value=JSON.parse(await readChecked(key));
  for(const ref of Backup.proofReferences(value,boundary)||[]) {
   protect(ref.key,'PERMANENT_PROOF_DEPENDENCY');
   if(byKey.get(ref.key).sha256!==ref.sha256)fail('RETENTION_REFERENCE_MISMATCH');
  }
 }
 const seen=new Set();
 while(queue.length) {
  const key=queue.shift();if(seen.has(key))continue;seen.add(key);
  let value;try{value=JSON.parse(await readChecked(key));}catch(error){fail('RETENTION_FROZEN_MANIFEST_UNREADABLE: '+error.message);}
  for(const ref of frozenReferences(value)) {
   protect(ref.key,'FROZEN_ARCHIVE_READ_ROUTE');const e=byKey.get(ref.key);
   if(e.sha256!==ref.sha256||e.size!==ref.size)fail('RETENTION_REFERENCE_MISMATCH');
  }
 }
 // Permanent objects stay protected even if an older immutable revision is
 // no longer reached by today's root (flags/proofs/rollups have no expiry).
 for(const e of entries)if(e.key.startsWith(PREFIX+'permanent/'))protect(e.key,'PERMANENT_EVIDENCE');
 return {reasons,readChecked};
}
async function planRetention(sourceProvider,recoveryProvider,options={}) {
 const Backup=require('./bounded-backup');
 if(!options.sourceIdentity||!options.recoveryIdentity)fail('RETENTION_IDENTITIES_REQUIRED');
 // Never accept a JSON receipt as proof of current source/destination contents.
 // Both inventories and every byte are read in this invocation.
 const manifest=await Backup.capture(sourceProvider,{sourceIdentity:options.sourceIdentity});
 const receipt=await Backup.verifyRestore(manifest,recoveryProvider,{recoveryIdentity:options.recoveryIdentity});
 const rootVersion=await sourceProvider.getVersioned(ROOT);
 if(!rootVersion||!Buffer.isBuffer(rootVersion.bytes)||hash(rootVersion.bytes)!==manifest.root.sha256)fail('RETENTION_SOURCE_CHANGED');
 const root=JSON.parse(rootVersion.bytes);
 if(root.pending)fail('RETENTION_PENDING_OPERATION_HOLD');
 const now=options.now===undefined?Date.now():options.now;
 if(!Number.isFinite(now)||now<Date.parse(root.state.anchor_close))fail('RETENTION_CLOCK_INVALID');
 const cutoff=Date.parse(root.state.anchor_close.slice(0,10))-7*DAY;
 const protectedObjects=await reachability(root,manifest.inventory.objects,key=>sourceProvider.get(key));
 const entries=manifest.inventory.objects.map(entry=>{
  const reasons=[...(protectedObjects.reasons.get(entry.key)||[])];
  if(root.journal)reasons.push('INCOMPLETE_RUN_HOLD');
  if(!entry.key.startsWith(PREFIX+'objects/'))reasons.push('NON_DETAIL_OBJECT');
  if(!entry.last_modified||!Number.isFinite(Date.parse(entry.last_modified)))reasons.push('OBJECT_AGE_UNKNOWN');
  else if(Date.parse(entry.last_modified)>=cutoff)reasons.push('WITHIN_SEVEN_COMPLETE_UTC_DAYS');
  return {key:entry.key,size:entry.size,sha256:entry.sha256,last_modified:entry.last_modified||null,
   disposition:reasons.length?'HOLD':'REVIEW_CANDIDATE',reasons:reasons.sort(),
   ...(reasons.length?{}:{requires:['fresh-reachability-recheck','explicit-deletion-approval','version-aware-physical-inventory']})};
 });
 // Concurrent publication or partial inventory invalidates the entire plan;
 // no earlier eligibility result escapes after a late provider failure.
 const after=await Backup.capture(sourceProvider,{sourceIdentity:options.sourceIdentity});
 if(after.root.sha256!==manifest.root.sha256||after.inventory.sha256!==manifest.inventory.sha256)fail('RETENTION_SOURCE_CHANGED');
 const candidates=entries.filter(e=>e.disposition==='REVIEW_CANDIDATE');
 const body={schema:'shadowwatch-bounded-retention-plan/1',source:manifest.source,recovery:receipt.recovery,
  source_manifest_sha256:manifest.manifest_sha256,restore_receipt_sha256:receipt.receipt_sha256,
  source_root_sha256:manifest.root.sha256,source_revision:manifest.root.revision,state_sha256:manifest.root.state_sha256,
  policy:{complete_utc_days:7,anchor_close:root.state.anchor_close,cutoff_utc:new Date(cutoff).toISOString(),historical_snapshots:'all-protected',permanent_records:'all-protected'},
  inventory_scope:'current-keys-only-excludes-historical-versions-and-billing-overhead',
  entries,totals:{current_key_bytes:manifest.inventory.total_bytes,current_key_count:entries.length,
   review_candidate_count:candidates.length,review_candidate_bytes:candidates.reduce((n,e)=>n+e.size,0)},
  generated_at:new Date(now).toISOString(),gc_enabled:false,deletion_authorized:false,capacity_relief_applied:false,
  qualification:'read-only-review-plan-not-production-or-deletion-approval'};
 return {...body,plan_sha256:Backup.digest(body)};
}
module.exports={PREFIX,ROOT,DAY,hash,keyOfRef,rootReferences,frozenReferences,reachability,planRetention};
