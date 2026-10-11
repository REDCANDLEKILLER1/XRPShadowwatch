'use strict';
// Offline preparation only. No network, catalog publication, deletion or cutover.
const fs=require('fs'),path=require('path');
const B=require('../../src/db/master-backup'),Store=require('../../src/db/github-store');
const SCHEMA='shadowwatch-archive-catalog/1';
const digest=c=>B.sha256(JSON.stringify({schema:c.schema,segments:c.segments}));
const seal=segments=>{const c={schema:SCHEMA,segments};return {...c,sha256:digest(c)};};
function day(s){if(typeof s!=='string'||!/^\d{4}-\d{2}-\d{2}$/.test(s)||!Number.isFinite(Date.parse(s))||new Date(s).toISOString().slice(0,10)!==s)throw Error('ARCHIVE_DAY_INVALID');return Date.parse(s);}
function validate(c,expected){
 if(!expected||c.schema!==SCHEMA||!Array.isArray(c.segments)||c.sha256!==expected||digest(c)!==expected)throw Error('ARCHIVE_CATALOG_UNVERIFIED');
 const ids=new Set();let prev;
 for(const s of c.segments){
  if(!/^[a-z0-9-]+$/.test(s.id)||ids.has(s.id)||day(s.first)>day(s.last)||!Number.isSafeInteger(s.state_version)||s.state_version<1||!Number.isFinite(Date.parse(s.anchor_close))||day(s.last)+86400000>Date.parse(s.anchor_close))throw Error('ARCHIVE_SEGMENT_INVALID');
  for(const k of ['source_commit','source_tree'])if(!/^[a-f0-9]{40}$/.test(s[k]))throw Error('ARCHIVE_SEGMENT_INVALID');
  for(const k of ['manifest_sha256','state_sha256'])if(!/^[a-f0-9]{64}$/.test(s[k]))throw Error('ARCHIVE_SEGMENT_INVALID');
  if(prev&&(day(s.first)!==day(prev.last)+86400000||s.state_version<=prev.state_version))throw Error('ARCHIVE_SEGMENT_BOUNDARY');
  ids.add(s.id);prev=s;
 }return c;
}
function inspect(root,s){
 const proof=B.verify(root,s?.source_commit,s?.manifest_sha256);
 const m=JSON.parse(fs.readFileSync(path.join(root,'manifest.json')));
 const state=JSON.parse(fs.readFileSync(path.join(root,Store.STATE_PATH)));
 if(s&&(m.source_tree!==s.source_tree||state.state_sha256!==s.state_sha256||state.state_version!==s.state_version||state.anchor_close!==s.anchor_close))throw Error('ARCHIVE_SEGMENT_MISMATCH');
 return{proof,m,state};
}
function adapter(root,m){
 const files=new Map(m.files.map(e=>[e.path,e]));
 return{env:{SHADOWWATCH_EVIDENCE_TOKEN:'offline-fixture',VERCEL_ENV:'preview'},ref:m.source_commit,gh:async(method,url)=>{
  if(method!=='GET'||!url.startsWith('/contents/'))throw Error('ARCHIVE_IO_REFUSED');
  const p=url.slice(10).split('?')[0],e=files.get(p);if(!e)return null;
  const b=fs.readFileSync(path.join(root,B.relative(p)));
  if(B.sha256(b)!==e.sha256||B.blobSha(b)!==e.git_blob_sha||b.length!==e.bytes)throw Error('ARCHIVE_FILE_MISMATCH');
  return{content:b.toString('base64'),encoding:'base64',size:b.length};
 }};
}
async function read(root,m,days,kind){
 const deps=adapter(root,m),resolved=await Store.resolveDayManifests(days,deps);
 return Store.readDays(days,deps,kind,{requireManifest:true,manifest:resolved.byDay,ref:m.source_commit});
}
function daysBetween(first,last){const out=[];for(let t=day(first);t<=day(last);t+=86400000){if(out.length>=366)throw Error('ARCHIVE_WINDOW_LIMIT');out.push(new Date(t).toISOString().slice(0,10));}if(!out.length)throw Error('ARCHIVE_WINDOW_INVALID');return out;}
async function append(c,expected,{id,first,last,primary,recovery}){
 validate(c,expected);
 if(fs.realpathSync(primary)===fs.realpathSync(recovery))throw Error('ARCHIVE_RECOVERY_NOT_SEPARATE');
 const a=inspect(primary),b=inspect(recovery,{...a.proof,source_tree:a.m.source_tree,state_sha256:a.state.state_sha256,anchor_close:a.state.anchor_close});
 const s={id,first,last,source_commit:a.proof.source_commit,source_tree:b.m.source_tree,manifest_sha256:a.proof.manifest_sha256,state_version:a.state.state_version,state_sha256:a.state.state_sha256,anchor_close:a.state.anchor_close};
 const existing=c.segments.find(v=>v.id===id);
 if(existing){if(JSON.stringify(existing)!==JSON.stringify(s))throw Error('ARCHIVE_REPLAY_CONFLICT');return c;}
 const next=seal([...c.segments,s]);validate(next,next.sha256);
 const prev=c.segments.at(-1);
 if(prev){const p=path.join(primary,Store.historyPath(prev.state_version));if(JSON.parse(fs.readFileSync(p)).state_sha256!==prev.state_sha256)throw Error('ARCHIVE_ANCESTRY_MISMATCH');}
 // Closed-day policy: reject revisions rather than silently serving an older snapshot.
 // Full backups retain the owning checkpoint, so compare the canonical reader at
 // that checkpoint with the newest checkpoint using the same verified snapshot.
 for(const old of c.segments){
  const historical=JSON.parse(fs.readFileSync(path.join(primary,Store.historyPath(old.state_version))));
  if(historical.state_sha256!==old.state_sha256)throw Error('ARCHIVE_ANCESTRY_MISMATCH');
  const days=daysBetween(old.first,old.last),deps=adapter(primary,a.m);
  const before=await Store.resolveDayManifests(days,{...deps,loaded_state:historical});
  const after=await Store.resolveDayManifests(days,deps);
  const signature=m=>JSON.stringify(Object.values(m.shards).sort((x,y)=>x.path.localeCompare(y.path)));
  for(const d of days)if(signature(before.byDay[d])!==signature(after.byDay[d]))throw Error('ARCHIVE_OLDER_DAY_REVISION: '+d);
 }
 // Require all canonical shard kinds for every owned day, not a synthetic coverage claim.
 const days=daysBetween(first,last);
 for(const kind of ['events','participants','payloads'])await read(primary,a.m,days,kind);
 return next; // Caller retains old catalog until separately approved publication.
}
async function query(c,expected,first,last,locations,kind='events'){
 validate(c,expected);if(!['events','participants','payloads'].includes(kind))throw Error('ARCHIVE_KIND_INVALID');
 const groups=new Map();for(const d of daysBetween(first,last)){const s=c.segments.find(s=>s.first<=d&&s.last>=d);if(!s)throw Error('ARCHIVE_DAY_UNCOVERED');if(!groups.has(s))groups.set(s,[]);groups.get(s).push(d);}
 const result=[];
 for(const [s,days] of groups){let done=false;const errors=[];
  for(const root of locations[s.id]||[]){try{const {m}=inspect(root,s);const rows=await read(root,m,days,kind);result.push({segment:s.id,source_commit:s.source_commit,manifest_sha256:s.manifest_sha256,recovered:errors.length>0,...rows});done=true;break;}catch(e){errors.push(e.message);}}
  if(!done)throw Error('ARCHIVE_SEGMENT_UNAVAILABLE: '+s.id);
 }return result; // Atomic response: never return partial results on failure.
}
module.exports={seal,validate,append,query};
