#!/usr/bin/env node
'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const zlib = require('zlib');

const ROOT = path.join(__dirname, '..');
const Store = require(path.join(ROOT, 'src/db/github-store.js'));
const State = require(path.join(ROOT, 'src/db/evidence-state.js'));
const DeltaApi = require(path.join(ROOT, 'api/delta.js'));

let pass = 0, fail = 0;
function check(name, fn) {
  try { fn(); pass++; console.log('  PASS  ' + name); }
  catch (e) { fail++; console.log('  FAIL  ' + name + ' -> ' + e.message); }
}
async function checkAsync(name, fn) {
  try { await fn(); pass++; console.log('  PASS  ' + name); }
  catch (e) { fail++; console.log('  FAIL  ' + name + ' -> ' + e.message); }
}
async function refused(fn) {
  try { await fn(); return null; } catch (e) { return String(e && e.message || e); }
}

async function main() {
  const apiSrc = fs.readFileSync(path.join(ROOT, 'api/delta.js'), 'utf8');
  const layer45 = fs.readFileSync(path.join(ROOT, 'src/brief/45-delta-evidence-index-20260911.js'), 'utf8');
  const layer46 = fs.readFileSync(path.join(ROOT, 'src/brief/46-stored-evidence-client-20260927.js'), 'utf8');
  const acquisition = fs.readFileSync(path.join(ROOT, 'src/db/delta-acquisition.js'), 'utf8');
  const html = fs.readFileSync(path.join(ROOT, 'brief-console.html'), 'utf8');

  console.log('\n1. RUN is a reader, not a watched-wallet acquisition trigger');
  const beginAt = layer45.indexOf('begin: function (windowRange, accounts)');
  const metricsAt = layer45.indexOf('metrics: function ()', beginAt);
  const beginSrc = layer45.slice(beginAt, metricsAt);
  check('begin uses the GET-only stored report reader', () => {
    assert(/getStoredReport\(windowRange, reportId, 3\)/.test(beginSrc));
    assert(!/postWithRetry\(\s*['"]run/.test(beginSrc));
  });
  check('stored report is allowed only on the GET action list', () => {
    assert(/req\.method === ['"]GET['"] \? \[['"]state['"], ['"]health['"], ['"]report['"]\]/.test(apiSrc));
    assert(/input\.action === ['"]report['"]/.test(apiSrc));
  });
  check('large stored windows use GET streaming instead of one buffered JSON body', () => {
    assert(/stream:\s*['"]1['"]/.test(layer45));
    assert(/application\/x-ndjson/.test(apiSrc));
    assert(/t:\s*['"]events['"]/.test(apiSrc));
    const chunks = DeltaApi.streamStoredReport(null, {events:Array.from({length:1601}, (_, i) => ({hash:String(i)}))}, 750)
      .filter(line => line.t === 'events');
    assert.deepEqual(chunks.map(line => line.events.length), [750,750,101]);
  });
  check('the stored response reports zero acquisition XRPL reads', () => {
    assert(/xrpl_requests:\s*0/.test(apiSrc));
    assert(/stored_checkpoint:\s*true/.test(apiSrc));
  });

  console.log('\n2. the report hot path excludes raw forensic payloads');
  const rwAt = acquisition.indexOf('async function readReportWindow');
  const rwEnd = acquisition.indexOf('module.exports', rwAt);
  const readWindowSrc = acquisition.slice(rwAt, rwEnd);
  check('report window reads events and participants, not payloads', () => {
    assert(/Store\.readDays\(days, d, undefined/.test(readWindowSrc));
    assert(/Store\.readDays\(days, d, ['"]participants['"]/.test(readWindowSrc));
    assert(!/['"]payloads['"]/.test(readWindowSrc));
  });
  check('the API projects events through slim before crossing the wire', () => {
    assert(/events:\s*assembled\.events\.map\(slim\)/.test(apiSrc));
    const slimAt = apiSrc.indexOf('function slim');
    const slimEnd = apiSrc.indexOf('\n}', slimAt);
    const slimSrc = apiSrc.slice(slimAt, slimEnd + 2);
    assert(!/raw_tx|raw_meta/.test(slimSrc));
  });

  console.log('\n3. day shards are refused unless their committed hash matches');
  const day = '2026-09-27';
  const eventPath = 'evidence/2026/09/27/events.ndjson.gz';
  const participantPath = 'evidence/2026/09/27/participants.ndjson.gz';
  const eventPacked = zlib.gzipSync(Buffer.from('{"hash":"A","close_time":"2026-09-27T01:00:00.000Z"}\n'));
  const participantPacked = zlib.gzipSync(Buffer.from('{"tx_hash":"A","address":"rWatched","role":"observed_via"}\n'));
  const files = new Map([[eventPath,eventPacked],[participantPath,participantPacked]]);
  const gh = async (method, p, body, allow404) => {
    if (method !== 'GET' || !p.startsWith('/contents/')) throw new Error('UNEXPECTED_GH_CALL ' + method + ' ' + p);
    const name = decodeURIComponent(p.slice('/contents/'.length).split('?')[0]);
    if (!files.has(name)) { if (allow404) return null; throw new Error('404'); }
    const bytes = files.get(name);
    return { content: bytes.toString('base64'), encoding:'base64', size:bytes.length, sha:'blob-'+name };
  };
  const manifest = {
    [day]: {
      state_version:105,
      shards:{
        [eventPath]:{ path:eventPath, sha256:State.sha256(eventPacked), rows:1 },
        [participantPath]:{ path:participantPath, sha256:State.sha256(participantPacked), rows:1 }
      }
    }
  };
  const ENV = { SHADOWWATCH_EVIDENCE_TOKEN:'test-token' };
  await checkAsync('a matching event shard is accepted and marked verified', async () => {
    const r = await Store.readDays([day], {env:ENV,gh}, undefined,
      {manifest,requireManifest:true});
    assert.equal(r.events.length,1);
    assert.equal(r.verified.length,1);
    assert.equal(r.verified[0].sha256,State.sha256(eventPacked));
  });
  await checkAsync('a matching provenance shard is accepted and marked verified', async () => {
    const r = await Store.readDays([day], {env:ENV,gh}, 'participants',
      {manifest,requireManifest:true});
    assert.equal(r.events.length,1);
    assert.equal(r.verified.length,1);
  });
  await checkAsync('a bad committed hash refuses the whole read', async () => {
    const bad = JSON.parse(JSON.stringify(manifest));
    bad[day].shards[eventPath].sha256 = '0'.repeat(64);
    const msg = await refused(() => Store.readDays([day], {env:ENV,gh}, undefined,
      {manifest:bad,requireManifest:true}));
    assert(/EVIDENCE_SHARD_HASH_MISMATCH/.test(msg),msg);
  });
  await checkAsync('a missing manifest refuses the day instead of treating it as quiet', async () => {
    const msg = await refused(() => Store.readDays([day], {env:ENV,gh}, undefined,
      {manifest:{},requireManifest:true}));
    assert(/EVIDENCE_DAY_MANIFEST_MISSING/.test(msg),msg);
  });

  console.log('\n3b. older report days resolve through the verified state-history chain');
  const baseState = State.genesis([{ address:'rWatched', scan_coverage_through:100 }], {
    anchor_ledger:100, anchor_close:'2026-09-25T00:00:00.000Z'
  });
  const day26Path = 'evidence/2026/09/26/events.ndjson.gz';
  const day27Path = 'evidence/2026/09/27/events.ndjson.gz';
  const s2 = State.advance(baseState, {
    report_id:'SW-20260926-AAAAA', scan_id:'s2', sealed_at:'2026-09-26T01:00:00.000Z',
    anchor_ledger:200, anchor_close:'2026-09-26T01:00:00.000Z',
    target_wallets:1, complete_wallets:1, balance_contradictions:0,
    evidence_shards:[{path:day26Path,sha256:'1'.repeat(64),rows:1}],
    wallets:[{address:'rWatched',last_proven_ledger:200,balance_drops:'1000000',
      balance_ledger:200,reconciliation:'RECONCILED'}]
  });
  const s3 = State.advance(s2, {
    report_id:'SW-20260927-BBBBB', scan_id:'s3', sealed_at:'2026-09-27T01:00:00.000Z',
    anchor_ledger:300, anchor_close:'2026-09-27T01:00:00.000Z',
    target_wallets:1, complete_wallets:1, balance_contradictions:0,
    evidence_shards:[{path:day27Path,sha256:'2'.repeat(64),rows:1}],
    wallets:[{address:'rWatched',last_proven_ledger:300,balance_drops:'2000000',
      balance_ledger:300,reconciliation:'RECONCILED'}]
  });
  const stateFiles = new Map([
    [Store.STATE_PATH, State.serialize(s3)],
    [Store.historyPath(2), State.serialize(s2)],
    [Store.historyPath(1), State.serialize(baseState)]
  ]);
  const stateGh = async (method,p,body,allow404) => {
    if (method === 'GET' && /^\/git\/ref\/heads\//.test(p)) return {object:{sha:'snapshot-head'}};
    if (method === 'GET' && p.startsWith('/contents/')) {
      const name = decodeURIComponent(p.slice('/contents/'.length).split('?')[0]);
      if (!stateFiles.has(name)) { if (allow404) return null; throw new Error('404'); }
      const raw = Buffer.from(stateFiles.get(name),'utf8');
      return {content:raw.toString('base64'),encoding:'base64',size:raw.length,sha:'blob-'+name};
    }
    throw new Error('UNEXPECTED_STATE_GH_CALL ' + method + ' ' + p);
  };
  await checkAsync('resolver finds each day at the state version that last wrote it', async () => {
    const r = await Store.resolveDayManifests(['2026-09-26','2026-09-27'],{env:ENV,gh:stateGh});
    assert.equal(r.ref,'snapshot-head');
    assert.equal(r.byDay['2026-09-27'].state_version,3);
    assert.equal(r.byDay['2026-09-26'].state_version,2);
    assert.equal(r.byDay['2026-09-26'].shards[day26Path].sha256,'1'.repeat(64));
  });

  console.log('\n4. the post-core fence never re-crawls a watched wallet');
  let networkCalls = 0;
  const elements = {};
  const stageParent = { insertBefore(el) { elements[el.id] = el; } };
  const stage = { parentNode: stageParent };
  const document = {
    hidden:false, visibilityState:'visible',
    getElementById(id) { if (id === 'screenStage') return stage; return elements[id] || null; },
    createElement() { return { id:'', style:{}, dataset:{}, textContent:'',
      setAttribute(){}, parentNode:null }; },
    body:{ firstChild:null, insertBefore(el){ elements[el.id] = el; } }
  };
  const listeners = {};
  let offerCalls = 0, relatedOfferCalls = 0, scanCalls = 0;
  const ctx = {
    console, Promise, Error, Date, Number, String, Array, Object,
    document,
    window:null,
    state:{reportId:null,offers:[{old:true}],relatedOffers:[{old:true}]},
    getTxWindow:() => ({startMs:1,endMs:2}),
    getActiveWatchlist:() => [{address:'rWatched'}],
    xrpl:async (ws, req) => { networkCalls++; return { live:true, request:req }; },
    scanOffers:async () => { offerCalls++; return 7; },
    runRelatedOfferScan:async () => { relatedOfferCalls++; return [{live:true}]; },
    scanWallets:async () => { scanCalls++; return 'live-scan'; }
  };
  ctx.window = ctx;
  ctx.addEventListener = (name, fn) => { listeners[name] = fn; };
  ctx.SW_EVIDENCE_INDEX = {
    storedActive() { return true; },
    prefetch() { return Promise.resolve({scan_id:'stored'}); },
    freshness() { return {
      status:'CURRENT', evidence_time:'2026-09-27T18:07:20.000Z',
      anchor_ledger:107275618, state_version:105,
      next_slot_start:'2026-09-27T20:00:00.000Z',
      next_slot_end:'2026-09-27T20:59:59.999Z', schedule_precision:'HOUR_BUCKET'
    }; },
    checkpointWallet(address) {
      return address === 'rWatched'
        ? { address, balance_drops:'12345000000', balance_ledger:107275618, proven:true }
        : null;
    }
  };
  vm.createContext(ctx);
  vm.runInContext(layer46, ctx, {filename:'46-stored-evidence-client-20260927.js'});

  await checkAsync('watched account_info is answered from the checkpoint with no network call', async () => {
    networkCalls = 0;
    const r = await ctx.xrpl(null,{command:'account_info',account:'rWatched'});
    assert.equal(networkCalls,0);
    assert.equal(r.account_data.Balance,'12345000000');
    assert.equal(r.ledger_index,107275618);
    assert.equal(r.stored_evidence,true);
  });
  await checkAsync('watched account_tx is fenced locally even if another layer tries it', async () => {
    networkCalls = 0;
    const msg = await refused(() => ctx.xrpl(null,{command:'account_tx',account:'rWatched'}));
    assert.equal(networkCalls,0);
    assert(/WATCHED_ACCOUNT_TX_NETWORK_FENCED/.test(msg),msg);
  });
  await checkAsync('targeted non-roster enrichment can still use live XRPL', async () => {
    networkCalls = 0;
    const r = await ctx.xrpl(null,{command:'account_info',account:'rUnknown'});
    assert.equal(networkCalls,1);
    assert.equal(r.live,true);
  });

  await checkAsync('stored RUN skips the 423 watched-wallet offer sweep', async () => {
    offerCalls = 0; ctx.state.offers = [{old:true}];
    const r = await ctx.scanOffers();
    assert.equal(offerCalls,0);
    assert.equal(r,0);
    assert.deepEqual(ctx.state.offers,[]);
  });
  await checkAsync('stored RUN skips related-offer phone sweep', async () => {
    relatedOfferCalls = 0; ctx.state.relatedOffers = [{old:true}];
    const r = await ctx.runRelatedOfferScan();
    assert.equal(relatedOfferCalls,0);
    assert.deepEqual(r,[]);
    assert.deepEqual(ctx.state.relatedOffers,[]);
  });
  await checkAsync('stored preflight failure stops before the legacy scanner can run', async () => {
    scanCalls = 0; ctx.state.reportId = 'SW-TEST-PREFLIGHT';
    ctx.SW_EVIDENCE_INDEX.prefetch = () => Promise.reject(new Error('STORE_DOWN'));
    const msg = await refused(() => ctx.scanWallets());
    assert.equal(scanCalls,0);
    assert(/STORE_DOWN/.test(msg),msg);
    ctx.state.reportId = null;
  });

  console.log('\n5. freshness is visible and names the checkpoint rather than device time');
  check('the client layer is loaded after core', () => {
    const coreAt = html.indexOf('/src/brief/02-core.js');
    const fenceAt = html.indexOf('/src/brief/46-stored-evidence-client-20260927.js');
    assert(coreAt > -1 && fenceAt > coreAt);
  });
  check('the freshness header carries anchor, ledger, state, next slot and last-good status', () => {
    ctx.SW_STORED_EVIDENCE_CLIENT_20260927.renderFreshness({
      status:'LAST_GOOD_RECOVERY_PENDING',
      last_good_after_fail:true,
      stale:true,
      evidence_time:'2026-09-27T18:07:20.000Z',
      anchor_ledger:107275618,
      state_version:105,
      next_slot_start:'2026-09-27T20:00:00.000Z',
      next_slot_end:'2026-09-27T20:59:59.999Z'
    });
    const text = elements.swEvidenceFreshness.textContent;
    assert(/LAST GOOD/.test(text),text);
    assert(/Ledger 107275618/.test(text),text);
    assert(/State v105/.test(text),text);
    assert(/Next collection window/.test(text),text);
  });

  check('freshness is injected into Morning/Structured text without replacing the report', () => {
    const out = ctx.SW_STORED_EVIDENCE_CLIENT_20260927.addFreshnessToText(
      'SHADOW WATCH\nSeptember 28, 2026\n\nExecutive Summary\nkept body');
    assert(/EVIDENCE FRESHNESS/.test(out),out);
    assert(/ledger 107275618/.test(out),out);
    assert(/Executive Summary\nkept body/.test(out),out);
  });

  console.log('\n6. scheduler timing is presented as an hour bucket, not a fake exact minute');
  check('next slot uses the current two-hour UTC hour buckets', () => {
    const slot = DeltaApi.nextScheduledSlot('2026-09-27T18:07:20.000Z',
      Date.parse('2026-09-27T18:30:00.000Z'));
    assert.equal(slot.start,'2026-09-27T20:00:00.000Z');
    assert.equal(slot.end,'2026-09-27T20:59:59.999Z');
    assert.equal(slot.precision,'HOUR_BUCKET');
    assert.equal(slot.overdue,false);
  });

  console.log('\n7. requested wall-clock windows are capped to the verified anchor');
  check('a request past the anchor is capped and its overshoot is explicit', () => {
    const start = Date.parse('2026-09-28T08:00:00.000Z');
    const end = Date.parse('2026-09-28T13:00:00.000Z');
    const cap = DeltaApi.capWindowToAnchor(start,end,'2026-09-28T12:17:00.000Z');
    assert.equal(cap.effective_end_ms,Date.parse('2026-09-28T12:17:00.000Z'));
    assert.equal(cap.capped,true);
    assert.equal(cap.overshoot_ms,43*60*1000);
  });
  check('a window beginning after the anchor is refused, not rendered quiet', () => {
    assert.throws(() => DeltaApi.capWindowToAnchor(
      Date.parse('2026-09-28T12:18:00.000Z'),
      Date.parse('2026-09-28T13:00:00.000Z'),
      '2026-09-28T12:17:00.000Z'), /WINDOW_BEYOND_SNAPSHOT/);
  });

  console.log('\n8. streamed NDJSON is event-equivalent to the compact JSON body');
  check('meta/events/done reassemble to exactly the original event count', () => {
    const events = Array.from({length:1601},(_,i)=>({hash:'H'+i,ledger_index:1000+i}));
    const body = {source:'STORED_VERIFIED_EVIDENCE',state_version:105,
      anchor_ledger:107292386,events,window:{in_window:events.length}};
    const lines = DeltaApi.streamStoredReport(null,body,750);
    const rebuilt = [];
    lines.filter(x=>x.t==='events').forEach(x=>rebuilt.push(...x.events));
    const done = lines[lines.length-1];
    assert.equal(lines[0].events_count,events.length);
    assert.equal(done.t,'done');
    assert.equal(done.events_streamed,events.length);
    assert.equal(rebuilt.length,events.length);
    assert.deepEqual(rebuilt,events);
    assert.equal(done.events,undefined);
  });

  console.log('\n9. store-backed net flow has a checkpoint baseline, not a device baseline');
  check('the server response carries baseline balance fields and baseline checkpoint metadata', () => {
    assert(/baseline_balance_drops/.test(apiSrc));
    assert(/balance_baseline/.test(apiSrc));
    assert(/baseline_ms\s*:\s*startMs/.test(apiSrc));
    assert(/baseline_state/.test(apiSrc));
  });
  check('layer 17 prefers the stored baseline over the local snapshot', () => {
    const l17 = fs.readFileSync(path.join(ROOT,'src/brief/17-report-scan-tuning-20260816.js'),'utf8');
    assert(/balance_baseline_by_address/.test(l17));
    assert(/storeBaseline\s*\?\s*storeBaseline\[w\.address\]/.test(l17));
  });

  console.log('\n10. preview stays read-capable while writes remain guarded elsewhere');
  check('the GET report path contains no acquisition call', () => {
    const reportAt = apiSrc.indexOf("if (input.action === 'report')");
    const stateAt = apiSrc.indexOf("if (input.action === 'health'", reportAt);
    const reportSrc = apiSrc.slice(reportAt,stateAt);
    assert(/storedReport\(input/.test(reportSrc));
    assert(!/D\.acquire|acquireReader|commitRun|seedGenesis/.test(reportSrc));
  });
  check('the stored reader announces that XRPL fallback is forbidden on failure', () => {
    assert(/xrpl_fallback_allowed:\s*false/.test(apiSrc));
  });

  console.log('\n' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail ? 1 : 0);
}
main().catch(e => { console.error(e); process.exit(1); });
