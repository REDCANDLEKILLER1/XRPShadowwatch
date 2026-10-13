'use strict';
// Staged object-store backend. No migration, deletion, or enablement is automatic.
// One CAS publishes detail, aggregates, proof and journal ownership together.
const crypto = require('crypto');
const zlib = require('zlib');
const State = require('./evidence-state');
const Journal = require('./run-journal');
const PREFIX = 'bounded/v1/';
const ROOT = PREFIX + 'root.json';
const SCHEMA = 'shadowwatch-bounded-store/1';
const DAY = 86400000;
const DEFAULT_BUDGETS = Object.freeze({active:512*1024*1024, total:2*1024*1024*1024, root:16*1024*1024});
const sha = b => crypto.createHash('sha256').update(b).digest('hex');
const bytes = v => Buffer.from(JSON.stringify(v));
const clone = v => JSON.parse(JSON.stringify(v));
const fail = message => { throw new Error(message); };
function dayMs(day) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day) || new Date(day).toISOString().slice(0,10)!==day) fail('BOUNDED_DAY_INVALID');
  return Date.parse(day);
}
const dayOfPath = p => { const m=/^evidence\/(\d{4})\/(\d{2})\/(\d{2})\//.exec(p); return m ? m.slice(1).join('-') : null; };
const kindOfPath = p => { const m=/\/(events|participants|payloads)\./.exec(p); return m && m[1]; };
const idOf = (kind,row) => kind==='participants' ? [row.tx_hash,row.address,row.role].join('|') : row.hash;
function validateRoot(root) {
  if (!root || root.schema!==SCHEMA || !root.state || !State.verify(root.state).ok ||
      !/^[a-f0-9]{40}$/.test(root.legacy_ref || '') || !root.days || !root.frozen || !root.files || !root.budgets) fail('BOUNDED_ROOT_INVALID');
  for (const k of ['active','total','root']) if (!Number.isSafeInteger(root.budgets[k]) || root.budgets[k]<=0) fail('BOUNDED_BUDGET_INVALID');
  return root;
}
function createStore(provider, options={}) {
  const legacy=options.legacy;
  const staged=new Map(); // uploadBlob is local staging: no provider write before capacity gate.
  async function readObject(ref) {
    const b=await provider.get(ref.key);
    if (!b || b.length!==ref.size || sha(b)!==ref.sha256) fail('BOUNDED_OBJECT_UNVERIFIED: '+ref.key);
    return b;
  }
  async function load(d={}) {
    if (d.ref && String(d.ref).startsWith('bounded:')) {
      const digest=String(d.ref).slice(8);
      if (!/^[a-f0-9]{64}$/.test(digest)) fail('BOUNDED_REF_INVALID');
      const b=await provider.get(PREFIX+'snapshots/'+digest+'.json');
      if (!b || sha(b)!==digest) fail('BOUNDED_SNAPSHOT_UNVERIFIED');
      return {root:validateRoot(JSON.parse(b)), etag:null, ref:d.ref};
    }
    if(d.ref)fail('BOUNDED_REF_INVALID');
    const v=await provider.getVersioned(ROOT);
    if (!v) fail('BOUNDED_BOOTSTRAP_REQUIRED');
    const root=validateRoot(JSON.parse(v.bytes));
    if(root.pending&&!root.pending.previous_ref)fail('BOUNDED_BOOTSTRAP_IN_PROGRESS');
    return {root,etag:v.etag,ref:root.pending?.previous_ref||'bounded:'+sha(v.bytes)};
  }
  function stageObject(pending,b,category='objects') {
    b=Buffer.isBuffer(b)?b:Buffer.from(b); const digest=sha(b);
    const ref={key:PREFIX+category+'/'+digest,sha256:digest,size:b.length};
    pending.set(ref.key,b); return ref;
  }
  // Preflight the whole transition before even immutable puts. total is an
  // intentionally conservative lifetime allocation budget, not a claim that
  // unpublished/orphan objects are free. Failed writes require reconciliation.
  async function publish(prior,next,pending,etag) {
    delete next.pending;
    let active=0;
    const activeKeys=new Set();
    for (const manifest of Object.values(next.days)) for (const s of manifest.shards) activeKeys.add(s.object.key);
    for (const s of next.journal?.row_shards || []) activeKeys.add(next.files[s.path].key);
    const sizes=new Map(Object.values(next.files).map(r=>[r.key,r.size]));
    for (const m of Object.values(next.days)) for(const s of m.shards) sizes.set(s.object.key,s.object.size);
    for (const key of activeKeys) active+=sizes.get(key)||0;
    next.active_bytes=active;
    for (const b of pending.values()) if (b.length>provider.maxObjectBytes) fail('BOUNDED_OBJECT_TOO_LARGE');
    const identity={...next};delete identity.revision;delete identity.allocated_bytes;
    const operationId=sha(bytes(identity));
    let reserved=prior,writeETag=etag;
    if(prior?.pending) {
      if(prior.pending.operation_id!==operationId)fail('BOUNDED_PENDING_WRITE_REQUIRES_RECOVERY');
      next.allocated_bytes=prior.allocated_bytes;
      next.revision=prior.revision+1;
    } else {
      next.revision=(prior?.revision||0)+2;
      // Charge every planned object and both new root encodings before any
      // immutable upload. Conservative overhead covers JSON integer growth.
      const charge=[...pending.values()].reduce((n,b)=>n+b.length,0)+bytes(next).length+bytes(prior||next).length+4096;
      next.allocated_bytes=(prior?.allocated_bytes||0)+charge;
      reserved=clone(prior||next);
      reserved.allocated_bytes=next.allocated_bytes;
      reserved.revision=(prior?.revision||0)+1;
      reserved.pending={operation_id:operationId,previous_ref:prior?'bounded:'+sha(bytes(prior)):null};
    }
    const packed=bytes(next),reservation=bytes(reserved);
    if(active>next.budgets.active || next.allocated_bytes>next.budgets.total ||
       packed.length>next.budgets.root || packed.length>provider.maxObjectBytes ||
       reservation.length>next.budgets.root || reservation.length>provider.maxObjectBytes) fail('BOUNDED_CAPACITY_REFUSED');
    // CAS #1 durably reserves capacity. Readers still see the prior checkpoint,
    // pinned snapshot and journal. A failed or uncertain upload cannot lose its
    // charge. Different work refuses until the exact operation is recovered.
    if(!prior?.pending)writeETag=await provider.compareAndSwap(ROOT,etag,reservation);
    for(const [key,b] of pending) await provider.putImmutable(key,b);
    const digest=sha(packed);
    await provider.putImmutable(PREFIX+'snapshots/'+digest+'.json',packed);
    // CAS #2 is the publication point: all evidence/proof/rollup ownership lands.
    await provider.compareAndSwap(ROOT,writeETag,packed);
    return {root:next,ref:'bounded:'+digest};
  }
  function legacyDeps(root,d={}) { const {boundedStore,store,gh,loaded_state,...rest}=d; return {...rest,env:{...(d.env||process.env),SHADOWWATCH_BOUNDED_STORAGE_MODE:'off'},ref:root.legacy_ref}; }
  async function fileAt(path,root,d={}) {
    // Legacy Git restore receipts cover only their named Git snapshot. Never
    // reuse one to qualify this backend or admit additional wallets.
    if(path==='evidence/backup/latest.json')return null;
    if(path==='evidence/state/latest.json') return Buffer.from(State.serialize(root.state));
    if(path==='evidence/runs/resume/latest.json') return root.journal?Buffer.from(Journal.serialize(root.journal)):null;
    if(root.files[path]) return readObject(root.files[path]);
    if(!legacy) fail('BOUNDED_LEGACY_READER_REQUIRED');
    const ld=legacyDeps(root,d), A=require('./github-archive'),t=A.evidenceTarget(ld.env);
    return legacy.readBytes(ld.gh||A.client(t.token,t.repo,ld.fetch||fetch),t.branch,path,root.legacy_ref);
  }
  async function readState(d={}) {const {root}=await load(d);return {state:clone(root.state),missing:false,branch:'bounded'};}
  async function readPinnedState(d={}) {
    const snap=await load(d);
    const gh=async(method,url)=>{
      if(method!=='GET' || !url.startsWith('/contents/')) fail('BOUNDED_COMPAT_READ_ONLY');
      const b=await fileAt(url.slice(10).split('?')[0],snap.root,d);
      return b===null?null:{content:b.toString('base64'),encoding:'base64',size:b.length};
    };
    return {state:clone(snap.root.state),missing:false,branch:'bounded',ref:snap.ref,gh};
  }
  async function resolveStateAtOrBefore(target,d={}) {
    if(!Number.isFinite(Number(target))) fail('INVALID_BASELINE_TIME');
    const {root,ref}=await load(d);let current=root.state,walked=0;
    while(current) {
      if(Date.parse(current.anchor_close)<=Number(target)) return {state:current,states_walked:walked,branch:'bounded',ref};
      if(current.state_version<=1) break;
      const b=await fileAt('evidence/state/history/'+String(current.state_version-1).padStart(8,'0')+'.json',root,d);
      if(!b) fail('BOUNDED_BASELINE_HISTORY_MISSING');
      const previous=JSON.parse(b);
      if(!State.verify(current,previous).ok) fail('BOUNDED_BASELINE_CHAIN_INVALID');
      current=previous;walked++;
    }
    return {state:null,states_walked:walked,branch:'bounded',ref,reason:'NO_CHECKPOINT_AT_OR_BEFORE_WINDOW'};
  }
  async function manifestFor(day,root,d={}) {
    dayMs(day);
    if(root.days[day]) return root.days[day];
    if(root.frozen[day]) return JSON.parse(await readObject(root.frozen[day]));
    if(day>=root.cutover_day) fail('EVIDENCE_DAY_MANIFEST_MISSING: '+day);
    if(!legacy) fail('BOUNDED_LEGACY_READER_REQUIRED');
    const result=await legacy.resolveDayManifests([day],legacyDeps(root,d));
    return {legacy:true,...result.byDay[day]};
  }
  async function resolveDayManifests(days,d={}) {
    const {root,ref}=await load(d),byDay={};
    for(const day of days) {
      const m=await manifestFor(day,root,d);
      byDay[day]=m.legacy?m:{state_version:m.state_version,state_sha256:m.state_sha256,shards:Object.fromEntries(m.shards.map(s=>[s.path,s])),bounded:true};
    }
    const baseline=Number.isFinite(d.baseline_ms)?await resolveStateAtOrBefore(d.baseline_ms,{...d,ref}):null;
    return {byDay,state:clone(root.state),ref,branch:'bounded',states_walked:baseline?.states_walked||0,baseline_state:baseline?.state||null,
      baseline_unavailable_reason:baseline&&!baseline.state?baseline.reason:null};
  }
  async function readManifest(m,kind,d,root) {
    if(m.legacy) {
      const day=m.day;
      return (await legacy.readDays([day],legacyDeps(root,d),kind,{requireManifest:true,manifest:{[day]:m},ref:root.legacy_ref})).events;
    }
    const rows=new Map();
    for(const s of m.shards.filter(s=>s.kind===kind)) {
      const b=await readObject(s.object);
      if(sha(b)!==s.sha256) fail('BOUNDED_SHARD_HASH_MISMATCH');
      const parsed=zlib.gunzipSync(b).toString('utf8').split('\n').filter(Boolean).map(line=>JSON.parse(line));
      if(parsed.length!==s.rows) fail('BOUNDED_SHARD_ROW_COUNT');
      for(const row of parsed) {
        const id=idOf(kind,row);if(!id) fail('BOUNDED_ROW_ID_MISSING');
        // New batches replace an existing event only when commitRun checked an
        // explicit expected-hash correction. Inners are ordinary stored rows.
        if(!rows.has(id)||s.corrections?.includes(id)) rows.set(id,row);
      }
    }
    return [...rows.values()];
  }
  async function readDays(days,d={},kind='events',opts={}) {
    if(!['events','participants','payloads'].includes(kind)) kind='events';
    const {root}=await load({...d,ref:opts.ref||d.ref});
    const out={events:[],lines:[],files:[],missing:[],verified:[]};
    for(const day of days) {
      const m=await manifestFor(day,root,d);m.day=day;
      const rows=await readManifest(m,kind,d,root);
      if(opts.lines) out.lines.push(...rows.map(r=>JSON.stringify(r)));else out.events.push(...rows);
      if(!m.legacy) for(const s of m.shards.filter(s=>s.kind===kind)) {out.files.push(s.path);out.verified.push({path:s.path,sha256:s.sha256,state_version:m.state_version});try{d.onReportProgress?.({phase:'shard',day,kind});}catch(_){} }
    }
    return out; // nothing delivered until every segment has verified
  }
  async function uploadBlob(b) {b=Buffer.from(b);const digest=sha(b);staged.set(digest,b);return {blob_sha:digest,size:b.length};}
  function payloadOfFile(value) {if(Buffer.isBuffer(value))return value;if(value?.blob_sha&&staged.has(value.blob_sha))return staged.get(value.blob_sha);fail('BOUNDED_UNSTAGED_BLOB');}
  async function commitRun(run,d={}) {
    if(!/^SW-\d{8}-[A-Z0-9]{5}$/.test(run.report_id||''))fail('BOUNDED_REPORT_ID_INVALID');
    const {root,etag,ref:currentRef}=await load();
    const inputDigest=sha(bytes({...run,files:undefined}));
    if(root.last_run?.report_id===run.report_id) {
      if(root.last_run.input_digest!==inputDigest) fail('BOUNDED_REPLAY_CONFLICT');
      return {status:'COMMITTED',branch:'bounded',commit_sha:currentRef,state_version:root.state.state_version,state_sha256:root.state.state_sha256,replayed:true};
    }
    const replayRef=root.files['evidence/runs/'+run.report_id+'.json'];
    if(replayRef) {const replay=JSON.parse(await readObject(replayRef));if(replay.input_digest!==inputDigest)fail('BOUNDED_REPLAY_CONFLICT');const snapshotRef=root.state_snapshots?.[replay.state_sha256];if(!snapshotRef)fail('BOUNDED_REPLAY_SNAPSHOT_MISSING');return {status:'COMMITTED',branch:'bounded',commit_sha:snapshotRef,state_version:replay.state_version,state_sha256:replay.state_sha256,replayed:true};}
    const state=State.advance(root.state,run),next=clone(root),pending=new Map();next.state=state;
    next.state_snapshots={...(root.state_snapshots||{}),[root.state.state_sha256]:currentRef};
    const resolvedFlags=new Set();
    const changes=new Map();
    for(const s of run.evidence_shards||[]) {
      const day=dayOfPath(s.path),kind=kindOfPath(s.path);
      if(!day||!kind) fail('BOUNDED_SHARD_PATH_INVALID');dayMs(day);
      if(day<root.cutover_day||root.frozen[day]) fail('ARCHIVE_OLDER_DAY_REVISION: '+day);
      const b=payloadOfFile(run.files[s.path]);
      if(sha(b)!==s.sha256) fail('BOUNDED_SHARD_HASH_MISMATCH');
      if(s.path.split('/').at(-1)!==kind+'.'+s.sha256+'.ndjson.gz')fail('BOUNDED_CONTENT_PATH_REQUIRED');
      const rows=zlib.gunzipSync(b).toString().split('\n').filter(Boolean).map(JSON.parse);
      if(rows.length!==s.rows) fail('BOUNDED_SHARD_ROW_COUNT');
      for(const row of rows) {if(!idOf(kind,row))fail('BOUNDED_ROW_ID_MISSING');if(kind==='events'&&String(row.close_time).slice(0,10)!==day)fail('BOUNDED_EVENT_DAY_MISMATCH');}
      if(day>state.anchor_close.slice(0,10))fail('BOUNDED_FUTURE_DAY');
      if(!changes.has(day))changes.set(day,[]);
      const object=stageObject(pending,b);
      changes.get(day).push({...s,kind,object,corrections:[]});
    }
    // Make proven empty days explicit, including all calendar days crossed by
    // an acquisition. This prevents 'no manifest' being mistaken for zero.
    for(let t=Math.max(dayMs(root.cutover_day),Date.parse(root.state.anchor_close.slice(0,10)));t<=Date.parse(state.anchor_close.slice(0,10));t+=DAY) {
      const day=new Date(t).toISOString().slice(0,10);if(!changes.has(day)&&!next.days[day]&&!next.frozen[day])changes.set(day,[]);if(!next.days[day]&&!next.frozen[day])next.days[day]={shards:[],state_version:state.state_version,state_sha256:state.state_sha256};
    }
    for(const [day,shards] of changes) {
      const old=next.days[day]||{shards:[]};
      // Same hash observed through another wallet is one transaction. Divergent
      // event/payload requires an explicit optimistic correction, never a
      // silent first/last-writer replacement.
      for(const kind of ['events','participants','payloads']) {
        const incoming=new Map();
        const existing=new Map();
        for(const part of old.shards.filter(s=>s.kind===kind)) {
          const b=await readObject(part.object);
          for(const line of zlib.gunzipSync(b).toString().split('\n')) if(line) {
            const row=JSON.parse(line),id=idOf(kind,row);if(!existing.has(id)||part.corrections?.includes(id))existing.set(id,sha(bytes(row)));
          }
        }
        for(const s of shards.filter(s=>s.kind===kind)) {
          const rows=zlib.gunzipSync(pending.get(s.object.key)).toString().split('\n').filter(Boolean).map(JSON.parse);
          for(const row of rows) {
            const id=idOf(kind,row),digest=sha(bytes(row));
            if(incoming.has(id)&&incoming.get(id)!==digest)fail('BOUNDED_DIVERGENT_BATCH_DUPLICATE');
            incoming.set(id,digest);
            const was=existing.get(id);
            if(was&&was!==sha(bytes(row))) {
              if(run.corrections?.[kind+':'+id]!==was) fail('BOUNDED_ROW_REVISION_REQUIRES_EXPECTED_HASH');
              s.corrections.push(id);
            }
          }
        }
      }
      const seen=new Set(old.shards.map(s=>s.path));
      next.days[day]={shards:[...old.shards,...shards.filter(s=>!seen.has(s.path))],state_version:state.state_version,state_sha256:state.state_sha256};
      // Read staged objects locally while deriving the replacement rollup.
      const readPending=async ref=>pending.has(ref.key)?pending.get(ref.key):readObject(ref);
      const canonical={};
      const wantedPayloads=new Set([...(run.flagged_hashes||[]).map(f=>typeof f==='string'?f:f.hash),...Object.keys(next.flags)]);
      for(const kind of ['events','participants','payloads']) {
        const rows=new Map();
        for(const s of next.days[day].shards.filter(s=>s.kind===kind)) for(const row of zlib.gunzipSync(await readPending(s.object)).toString().split('\n').filter(Boolean).map(JSON.parse)) {
          const id=idOf(kind,row);if(kind==='payloads'&&!wantedPayloads.has(id))continue;if(!rows.has(id)||s.corrections.includes(id))rows.set(id,row);
        }
        canonical[kind]=[...rows.values()];
      }
      const roles={};for(const p of canonical.participants) {const key=p.address+'|'+p.role;roles[key]=(roles[key]||0)+1;}
      const typeCounts={};for(const e of canonical.events)typeCounts[e.tx_type||'unknown']=(typeCounts[e.tx_type||'unknown']||0)+1;
      const summary={day,observed_transactions:canonical.events.length,participant_observations:canonical.participants.length,type_counts:typeCounts,wallet_role_counts:roles,
        coverage_cutoff:root.coverage_cutoff,anchor_ledger:state.anchor_ledger,anchor_close:state.anchor_close,state_sha256:state.state_sha256};
      next.daily[day]=stageObject(pending,bytes(summary),'permanent');
      for(const flag of [...(run.flagged_hashes||[]),...canonical.events.filter(e=>next.flags[e.hash]).map(e=>e.hash)]) {
        const hash=typeof flag==='string'?flag:flag.hash;
        const event=canonical.events.find(e=>e.hash===hash);if(!event)continue;
        const payload=canonical.payloads.find(p=>p.hash===hash);if(!payload)fail('BOUNDED_FLAG_PAYLOAD_MISSING');
        resolvedFlags.add(hash);
        const previousFlag=next.flags[hash]?JSON.parse(await (pending.has(next.flags[hash].key)?pending.get(next.flags[hash].key):readObject(next.flags[hash]))):null;
        const record={hash,event,payload,participants:canonical.participants.filter(p=>p.tx_hash===hash),reason:typeof flag==='object'?flag.reason:previousFlag?.reason||null,
          parent_batch_id:payload.raw_tx?.ParentBatchID||event.ParentBatchID||null,state_sha256:state.state_sha256};
        next.flags[hash]=stageObject(pending,bytes(record),'permanent');
      }
    }
    for(const flag of run.flagged_hashes||[])if(!resolvedFlags.has(typeof flag==='string'?flag:flag.hash))fail('BOUNDED_FLAG_NOT_IN_CHANGED_DAY');
    const history='evidence/state/history/'+String(state.state_version).padStart(8,'0')+'.json';
    next.files[history]=stageObject(pending,Buffer.from(State.serialize(state)),'permanent');
    next.files['evidence/runs/'+run.report_id+'.json']=stageObject(pending,bytes({input_digest:inputDigest,report_id:run.report_id,scan_id:run.scan_id||null,anchor_ledger:state.anchor_ledger,anchor_close:state.anchor_close,
      state_version:state.state_version,state_sha256:state.state_sha256,target_wallets:run.target_wallets,complete_wallets:run.complete_wallets,balance_contradictions:0,evidence_shards:state.evidence_shards}),'permanent');
    if(run.journal&&next.journal?.report_id===run.journal.report_id) {for(const s of next.journal.row_shards||[])delete next.files[s.path];next.journal=null;}
    // Hold the full working set while a different run remains incomplete.
    // Once clear, retain seven COMPLETE UTC days plus the current partial day.
    if(!next.journal) {
      const cutoff=Date.parse(state.anchor_close.slice(0,10))-7*DAY;
      for(const day of Object.keys(next.days))if(dayMs(day)<cutoff) {
        next.frozen[day]=stageObject(pending,bytes(next.days[day]),'permanent');delete next.days[day];
      }
    }
    next.last_run={report_id:run.report_id,input_digest:inputDigest};
    const committed=await publish(root,next,pending,etag);staged.clear();
    return {status:'COMMITTED',branch:'bounded',commit_sha:committed.ref,state_version:state.state_version,state_sha256:state.state_sha256,files_written:pending.size,bytes_written:[...pending.values()].reduce((n,b)=>n+b.length,0),retry_count:0};
  }
  async function readJournal(d={}) {const {root}=await load(d);return {journal:clone(root.journal),missing:!root.journal,branch:'bounded'};}
  async function appendJournal(journal,segment,d={}) {
    const {root,etag}=await load(),next=clone(root),pending=new Map();let base=root.journal;
    if(base&&base.report_id!==journal.report_id)fail('JOURNAL_OWNED_BY_ANOTHER_RUN');
    if(!base)base=Journal.begin(journal);
    const reanchor=journal.anchor_ledger>base.anchor_ledger?{anchor_ledger:journal.anchor_ledger,anchor_close:journal.anchor_close}:undefined;
    const done=reanchor?new Set():Journal.doneAddresses(base);
    const b=zlib.gzipSync(Buffer.from((segment.rows||[]).map(JSON.stringify).join('\n')+((segment.rows||[]).length?'\n':'')));
    const path='evidence/runs/resume/'+journal.report_id+'-'+sha(b)+'.ndjson.gz';
    const shards=segment.rows?.length?[{path,sha256:sha(b),rows:segment.rows.length}]:[];
    next.journal=Journal.record(base,{wallets:(segment.wallets||[]).filter(w=>!done.has(w.address)),row_shards:shards,reanchor});
    if(shards.length)next.files[path]=stageObject(pending,b);
    const written=await publish(root,next,pending,etag);return {journal:next.journal,commit_sha:written.ref};
  }
  async function clearJournal(journal) {
    const {root,etag}=await load();if(!root.journal||root.journal.report_id!==journal?.report_id)return {cleared:false};
    const next=clone(root);for(const s of next.journal.row_shards||[])delete next.files[s.path];next.journal=null;
    const written=await publish(root,next,new Map(),etag);return {cleared:true,commit_sha:written.ref};
  }
  async function readJournalRowsEach(journal,d,onRow) {
    const {root}=await load();let count=0;
    for(const s of journal.row_shards||[]) {
      const ref=root.files[s.path];if(!ref)fail('JOURNAL_ROWS_UNREADABLE');const b=await readObject(ref);
      if(sha(b)!==s.sha256)fail('JOURNAL_ROWS_UNVERIFIED');
      const rows=zlib.gunzipSync(b).toString().split('\n').filter(Boolean).map(JSON.parse);
      if(rows.length!==s.rows)fail('JOURNAL_ROWS_UNVERIFIED');
      for(const row of rows){await onRow(row);count++;}
    }
    return count;
  }
  async function readJournalRows(journal,d={}) {const rows=[];await readJournalRowsEach(journal,d,r=>rows.push(r));return rows;}
  async function missingJournalShards(journal) {
    const {root}=await load(),missing=[];
    for(const s of journal.row_shards||[])if(!root.files[s.path])missing.push(s.path);else await readObject(root.files[s.path]);
    return missing;
  }
  async function readDaily(day,d={}) {const {root}=await load(d);if(!root.daily[day])fail('BOUNDED_ROLLUP_UNAVAILABLE');return JSON.parse(await readObject(root.daily[day]));}
  async function readFlag(hash,d={}) {const {root}=await load(d);if(!root.flags[hash])return null;return JSON.parse(await readObject(root.flags[hash]));}
  async function seedGenesis(){fail('BOUNDED_EXPLICIT_BOOTSTRAP_REQUIRED');}
  return {isBounded:()=>true,readState,readPinnedState,resolveStateAtOrBefore,resolveDayManifests,readDays,commitRun,uploadBlob,readJournal,appendJournal,clearJournal,readJournalRowsEach,readJournalRows,missingJournalShards,readDaily,readFlag,seedGenesis,
    inspect:async()=>clone((await load()).root), _publish:publish};
}
async function bootstrap(provider,state,options={}) {
  if(!State.verify(state).ok)fail('BOUNDED_BOOTSTRAP_STATE_UNVERIFIED');
  if(!/^[a-f0-9]{40}$/.test(options.legacyRef||''))fail('BOUNDED_LEGACY_PIN_REQUIRED');
  // The cutover day is imported as a whole from the pinned canonical reader.
  // Even an exact-midnight anchor can contain events, so never infer emptiness.
  const cutoverDay=options.cutoverDay;
  if(!cutoverDay || state.anchor_close.slice(0,10)!==cutoverDay)fail('BOUNDED_CUTOVER_DAY_INVALID');
  dayMs(cutoverDay);
  if(!options.legacy)fail('BOUNDED_VERIFIED_CUTOVER_READER_REQUIRED');
  const {boundedStore,store:injectedStore,loaded_state,...sourceDeps}=options.legacyDeps||{};
  const ld={...sourceDeps,env:{...(sourceDeps.env||process.env),SHADOWWATCH_BOUNDED_STORAGE_MODE:'off'},ref:options.legacyRef};
  const pinned=await options.legacy.readPinnedState(ld);
  if(pinned.ref!==options.legacyRef||!pinned.state||!State.verify(pinned.state).ok||pinned.state.state_sha256!==state.state_sha256)fail('BOUNDED_CUTOVER_STATE_NOT_AT_PIN');
  ld.loaded_state=pinned.state;
  const source=await options.legacy.resolveDayManifests([cutoverDay],ld);
  const sourceDay=source.byDay?.[cutoverDay];
  if(!sourceDay||source.ref!==options.legacyRef||source.state?.state_sha256!==state.state_sha256)fail('BOUNDED_CUTOVER_SOURCE_MISMATCH');
  const root={schema:SCHEMA,state:clone(state),legacy_ref:options.legacyRef,cutover_day:cutoverDay,
    coverage_cutoff:{anchor_ledger:state.anchor_ledger,anchor_close:state.anchor_close,wallets:state.wallets.map(w=>({address:w.address,history_from_ledger:w.history_from_ledger,last_proven_ledger:w.last_proven_ledger,balance_drops:w.balance_drops}))},
    days:{},frozen:{},files:{},daily:{},flags:{},state_snapshots:{},journal:null,last_run:null,active_bytes:0,allocated_bytes:0,budgets:{...DEFAULT_BUDGETS,...options.budgets}};
  validateRoot(root);
  if(await provider.getVersioned(ROOT))fail('BOUNDED_ALREADY_BOOTSTRAPPED');
  const store=createStore(provider,options),pending=new Map();
  root.days[cutoverDay]={shards:[],state_version:state.state_version,state_sha256:state.state_sha256,imported_from:options.legacyRef};
  const imported={};
  for(const kind of ['events','participants','payloads']) {
    const result=await options.legacy.readDays([cutoverDay],ld,kind,{requireManifest:true,manifest:source.byDay,ref:options.legacyRef});
    const rows=result.events;
    if(!Array.isArray(rows))fail('BOUNDED_CUTOVER_ROWS_INVALID');
    if(kind!=='payloads')imported[kind]=rows;
    if(!rows.length)continue;
    const X=require('./evidence-export');
    for(const piece of X.shard(rows,'unused',8*1024*1024)) {
      const packed=zlib.gzipSync(Buffer.from(piece.text)),digest=sha(packed),key=PREFIX+'objects/'+digest;
      const path='evidence/'+cutoverDay.replaceAll('-','/')+'/'+kind+'.'+digest+'.ndjson.gz';
      pending.set(key,packed);root.days[cutoverDay].shards.push({path,sha256:digest,rows:piece.records.length,kind,object:{key,sha256:digest,size:packed.length},corrections:[]});
    }
  }

  const typeCounts={},roles={};
  for(const e of imported.events||[])typeCounts[e.tx_type||'unknown']=(typeCounts[e.tx_type||'unknown']||0)+1;
  for(const p of imported.participants||[]){const id=p.address+'|'+p.role;roles[id]=(roles[id]||0)+1;}
  const summary=bytes({day:cutoverDay,observed_transactions:(imported.events||[]).length,participant_observations:(imported.participants||[]).length,type_counts:typeCounts,wallet_role_counts:roles,coverage_cutoff:root.coverage_cutoff,anchor_ledger:state.anchor_ledger,anchor_close:state.anchor_close,state_sha256:state.state_sha256});
  const sk=PREFIX+'permanent/'+sha(summary);pending.set(sk,summary);root.daily[cutoverDay]={key:sk,sha256:sha(summary),size:summary.length};
  const b=Buffer.from(State.serialize(state)),digest=sha(b),key=PREFIX+'permanent/'+digest;
  root.files['evidence/state/history/'+String(state.state_version).padStart(8,'0')+'.json']={key,sha256:digest,size:b.length};pending.set(key,b);
  await store._publish(null,root,pending,null);return store;
}
const runtimeCache=new Map();
function runtime(deps={},options={}) {
  if(deps.boundedStore)return deps.boundedStore;
  const env=deps.env||process.env,mode=env.SHADOWWATCH_BOUNDED_STORAGE_MODE;
  if(!mode||mode==='off')return null;
  if(mode!=='r2')fail('BOUNDED_MODE_INVALID');
  if(env.VERCEL_ENV==='production'||env.NODE_ENV==='production')fail('BOUNDED_PRODUCTION_CUTOVER_NOT_QUALIFIED');
  // Cache only within one immutable environment object; never move an injected
  // test provider or prior environment's credentials into a different caller.
  if(!runtimeCache.has(env)) {
    const provider=require('./bounded-object-provider').createR2Provider({env});
    runtimeCache.set(env,createStore(provider,options));
  }
  return runtimeCache.get(env);
}
module.exports={SCHEMA,PREFIX,ROOT,DEFAULT_BUDGETS,createStore,bootstrap,runtime,sha,dayMs};
