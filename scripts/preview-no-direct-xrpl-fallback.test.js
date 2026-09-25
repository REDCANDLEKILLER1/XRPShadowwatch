#!/usr/bin/env node
'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const delta = require('../api/delta');

function response() {
  return {
    statusCode: 200,
    body: null,
    headers: {},
    chunks: [],
    setHeader(k,v){ this.headers[k]=v; },
    status(code){ this.statusCode=code; return this; },
    json(value){ this.body=value; return this; },
    write(value){ this.chunks.push(String(value)); return true; },
    end(value){ if (value !== undefined) this.chunks.push(String(value)); this.body=this.chunks.join(''); return this; }
  };
}

(async () => {
  const state = {
    state_version: 30,
    state_sha256: 'a'.repeat(64),
    anchor_ledger: 107158879,
    anchor_close: '2026-09-22T12:25:41.000Z',
    wallet_count: 2,
    wallets: [
      { address:'rA', last_proven_ledger:107158879, reconciliation:'MATCH' },
      { address:'rB', last_proven_ledger:107158879, reconciliation:'MATCH' }
    ]
  };
  const storedEvent = {
    hash:'H1', ledger_index:107158800, close_time:'2026-09-22T12:00:00.000Z',
    tx_type:'Payment', tx_result:'tesSUCCESS', validated:true,
    from_account:'rA', to_account:'rOUT', amount_drops:'2500000',
    currency:'XRP', observed_via:['rA']
  };

  const run = await delta.buildPreviewReadOnlyRun({
    action:'run',
    report_id:'SW-20260923-ABCDE',
    window_start_ms:Date.parse('2026-09-21T12:25:41Z'),
    window_end_ms:Date.parse('2026-09-22T13:25:41Z')
  }, {
    readState: async () => ({ state, missing:false, branch:'main' }),
    selectRoster: () => ({ accounts:['rA','rB'], hash:'roster' }),
    readReportWindow: async input => {
      assert.equal(input.rows.length, 0, 'preview must not add newly crawled XRPL rows');
      assert.equal(input.window_end_ms, Date.parse(state.anchor_close),
        'preview window must cap to stored checkpoint');
      return {
        events:[storedEvent],
        days:['2026-09-21','2026-09-22'],
        in_window:1, from_stored:1, from_this_run:0,
        days_without_shards:[], unattributed:0,
        attributed_derived_only:0, provenance:'OBSERVED'
      };
    }
  });

  assert.equal(run.preview_read_only, true);
  assert.equal(run.live_acquisition_disabled, true);
  assert.equal(run.committed, false);
  assert.equal(run.reason, 'PREVIEW_READ_ONLY_SNAPSHOT');
  assert.equal(run.xrpl_requests, 0);
  assert.equal(run.target_wallets, 2);
  assert.equal(run.complete_wallets, 2);
  assert.equal(run.wallets.every(w => w.proven), true);
  assert.equal(run.events.length, 1);
  assert.equal(run.events[0].hash, 'H1');
  assert.equal(run.window.capped_to_checkpoint, true);
  assert.equal(run.window.to, state.anchor_close);
  assert.equal(run.freshness.claimed_beyond_checkpoint_ms, 60 * 60 * 1000);

  // A roster wallet not in the checkpoint is never invented as proved.
  const partial = await delta.buildPreviewReadOnlyRun({
    action:'run',
    report_id:'SW-20260923-ABCDE',
    window_start_ms:Date.parse('2026-09-21T12:25:41Z'),
    window_end_ms:Date.parse('2026-09-22T12:25:41Z')
  }, {
    readState: async () => ({ state, missing:false, branch:'main' }),
    selectRoster: () => ({ accounts:['rA','rB','rC'], hash:'roster2' }),
    readReportWindow: async () => ({
      events:[], days:['2026-09-21','2026-09-22'], in_window:0,
      from_stored:0, from_this_run:0, days_without_shards:[],
      unattributed:0, attributed_derived_only:0, provenance:'OBSERVED'
    })
  });
  assert.equal(partial.target_wallets, 3);
  assert.equal(partial.complete_wallets, 2);
  assert.equal(partial.wallets.find(w => w.address === 'rC').proven, false);

  // Source-order guard: preview snapshot is served before acquireReader(), so
  // a preview cannot accidentally open XRPL before deciding to stay read-only.
  const api = fs.readFileSync(path.join(__dirname, '../api/delta.js'), 'utf8');
  const previewAt = api.indexOf("return await respondPreviewReadOnly(res, input)");
  const readerAt = api.indexOf("reader = acquireReader()", previewAt);
  assert(previewAt > -1, 'preview read-only response path missing');
  assert(readerAt > previewAt, 'XRPL reader must be acquired only after preview path has returned');

  // Browser behavior: only an unavailable STORED snapshot is terminal.
  // Successful preview snapshots never reach this catch at all.
  const core = fs.readFileSync(path.join(__dirname, '../src/brief/02-core.js'), 'utf8');
  const catchAt = core.indexOf("var _previewReadOnlyUnavailable=/PREVIEW_READ_ONLY_SNAPSHOT_UNAVAILABLE|EVIDENCE_WRITE_REFUSED_NON_PRODUCTION/");
  const throwAt = core.indexOf("throw _previewErr;", catchAt);
  const fallbackAt = core.indexOf("log('Evidence index unavailable — direct XRPL acquisition:", catchAt);
  const directAt = core.indexOf("state.anchorAttempts.push({ source:'DIRECT_XRPL'", catchAt);
  assert(catchAt > -1, 'preview snapshot-unavailable guard missing');
  assert(throwAt > catchAt, 'unavailable snapshot must fail closed');
  assert(fallbackAt > throwAt, 'ordinary fallback remains after preview-only terminal branch');
  assert(directAt > fallbackAt, 'direct XRPL path is downstream of the preview fail-closed branch');
  assert(!core.includes('PREVIEW_READ_ONLY_NO_ACQUISITION'));

  // Production remains unchanged by preview policy.
  const savedEnv = process.env.VERCEL_ENV;
  try {
    process.env.VERCEL_ENV = 'production';
    const prod = response();
    await delta({
      method:'POST',
      headers:{},
      body:{ action:'run', report_id:'BAD-ID' }
    }, prod);
    assert.equal(prod.statusCode, 400);
    assert.equal(prod.body.error, 'INVALID_REPORT_ID');
  } finally {
    if (savedEnv === undefined) delete process.env.VERCEL_ENV;
    else process.env.VERCEL_ENV = savedEnv;
  }

  console.log('ALL PREVIEW READ-ONLY SNAPSHOT CHECKS PASS');
})().catch(e => { console.error(e && e.stack ? e.stack : String(e)); process.exit(1); });
