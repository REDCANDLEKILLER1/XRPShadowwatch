'use strict';
const assert = require('assert');
const { EventEmitter } = require('events');
const { streamStoredReportRequest } = require('../api/delta');
function response() {
  const res = new EventEmitter();
  res.lines = []; res.headers = {}; res.headersSent = false;
  res.setHeader = (k,v) => { assert(!res.headersSent); res.headers[k] = v; };
  res.write = text => { res.headersSent = true; res.lines.push(JSON.parse(text)); };
  res.end = () => { res.writableEnded = true; };
  return res;
}
const wait = ms => new Promise(resolve=>setTimeout(resolve,ms));
(async()=>{
  const res = response(); let finish;
  const blocked = new Promise(resolve=>{finish=resolve;});
  const job = streamStoredReportRequest(res, {}, {heartbeatMs:10,readReport:async(input,deps)=>{
    deps.onReportProgress({phase:'verifying',files_verified:1,files_total:3});
    await blocked;
    return {stored_checkpoint:true,events:[{hash:'verified'}]};
  }});
  assert(res.headersSent,'first progress must flush before the read resolves');
  assert.equal(res.lines[0].phase,'checkpoint');
  await wait(45);
  assert(res.lines.some(l=>l.t==='heartbeat'),'blocked I/O still sends heartbeats');
  assert(!res.lines.some(l=>l.t==='done'||l.t==='events'),'pending evidence is never reported as success');
  assert.equal(res.lines.filter(l=>l.files_verified).length,1,'heartbeats do not advance verified counts');
  finish(); await job;
  assert.equal(res.lines.at(-1).t,'done');
  assert.equal(res.lines.at(-1).events_streamed,1);
  const length=res.lines.length; await wait(30); assert.equal(res.lines.length,length,'completion clears heartbeat');

  const failure=response();
  await streamStoredReportRequest(failure, {}, {readReport:async()=>{throw new Error('EVIDENCE_SHARD_HASH_MISMATCH');}});
  assert.equal(failure.lines.at(-1).t,'error');
  assert.equal(failure.lines.at(-1).xrpl_fallback_allowed,false);
  assert(!failure.lines.some(l=>l.t==='done'));
  assert(failure.writableEnded);

  const disconnected=response(); let release;
  const pending=new Promise(resolve=>{release=resolve;});
  const abandoned=streamStoredReportRequest(disconnected, {}, {heartbeatMs:10,readReport:async()=>{await pending;return {events:[]};}});
  disconnected.emit('close');
  const before=disconnected.lines.length; await wait(30); release(); await abandoned;
  assert.equal(disconnected.lines.length,before,'disconnect clears heartbeat and prevents final writes');
  console.log('PASS early progress, live heartbeat, verified completion, fail-closed stream errors, disconnect cleanup');
})().catch(e=>{console.error(e);process.exit(1);});
