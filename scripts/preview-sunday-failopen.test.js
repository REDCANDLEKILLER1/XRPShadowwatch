#!/usr/bin/env node
'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.resolve(__dirname, '..');
const delta = require(path.join(ROOT, 'api/delta.js'));
const SRC17 = fs.readFileSync(path.join(ROOT, 'src/brief/17-report-scan-tuning-20260816.js'), 'utf8');
const SRC45 = fs.readFileSync(path.join(ROOT, 'src/brief/45-delta-evidence-index-20260911.js'), 'utf8');
const SRC48 = fs.readFileSync(path.join(ROOT, 'src/brief/48-coordination-render-20260923.js'), 'utf8');
const SRC49 = fs.readFileSync(path.join(ROOT, 'src/brief/49-preview-sunday-failopen-20260927.js'), 'utf8');

let passed = 0;
async function test(name, fn) {
  await fn();
  passed++;
  console.log('ok  ' + name);
}

function fakeState(wallets) {
  return {
    state_version: 7,
    state_sha256: 'abc',
    anchor_ledger: 107257672,
    anchor_close: '2026-09-27T00:27:00.000Z',
    wallets: wallets.map(address => ({
      address,
      last_proven_ledger: 107257672,
      reconciliation: 'MATCH'
    }))
  };
}

function domStub() {
  const nodes = Object.create(null);
  return {
    body: { classList: { add() {}, remove() {} } },
    getElementById(id) {
      if (!nodes[id]) nodes[id] = { textContent: '', classList: { add() {}, remove() {} } };
      return nodes[id];
    },
    _nodes: nodes
  };
}

(async () => {
  await test('preview server marks missing stored days WINDOW_BEYOND_SNAPSHOT', async () => {
    const accounts = ['rA', 'rB'];
    const body = await delta.buildPreviewReadOnlyRun({
      report_id: 'SW-T',
      window_start_ms: Date.parse('2026-09-24T12:00:00Z'),
      window_end_ms: Date.parse('2026-09-27T01:00:00Z')
    }, {
      readState: async () => ({ state: fakeState(accounts) }),
      selectRoster: () => ({ accounts }),
      readReportWindow: async () => ({
        events: [{ hash: 'H1', ledger_index: 1, close_time: '2026-09-26T12:00:00Z' }],
        days: ['2026-09-24','2026-09-25','2026-09-26'],
        in_window: 1,
        from_stored: 1,
        days_without_shards: ['2026-09-24'],
        unattributed: 0,
        attributed_derived_only: 0,
        provenance: 'RECORDED'
      })
    });
    assert.strictEqual(body.reason, 'WINDOW_BEYOND_SNAPSHOT');
    assert.strictEqual(body.preview_read_only, true);
    assert.strictEqual(body.live_acquisition_disabled, true);
    assert.strictEqual(body.xrpl_requests, 0);
    assert.strictEqual(body.window.partial, true);
    assert.strictEqual(body.window.partial_reason, 'WINDOW_BEYOND_SNAPSHOT');
  });

  await test('preview evidence API exposes server proof snapshot', async () => {
    assert(SRC45.includes('currentRunEvidence: function ()'));
    assert(SRC45.includes('preview_read_only: run.preview_read_only === true'));
    assert(SRC45.includes('live_acquisition_disabled: run.live_acquisition_disabled === true'));
  });

  await test('layer 17 keeps preview server proof separate from balance status', async () => {
    assert(SRC17.includes('function previewEvidenceSnapshot()'));
    assert(SRC17.includes('ULDLY did exactly that (418/418 -> 0/418)'));
    assert(SRC17.includes("source: 'GITHUB_EVIDENCE_STORE'"));
    assert(SRC17.includes("unproven_reason: beyond ? 'WINDOW_BEYOND_SNAPSHOT'"));
    assert(SRC17.includes('(_exactIndexedWindow || _previewHasAccount)'));
  });

  await test('partial preview seal does not qualify for v34 persistence', async () => {
    assert(SRC48.includes("!(p.partial_report && p.partial_report.persist_brief_memory === false)"));
  });

  await test('60h WINDOW_BEYOND_SNAPSHOT skips live account_info immediately', async () => {
    const document = domStub();
    const state = { failedPack: null, seal: null };
    let nativeXrplCalls = 0;
    let beginCalls = 0;
    const api = {
      begin: async () => { beginCalls++; return { scan_id:'preview-1' }; },
      metrics: () => ({
        scan_id:'preview-1', target_wallets:418, indexed_wallets:418,
        preview_read_only:true, live_acquisition_disabled:true,
        reason:'WINDOW_BEYOND_SNAPSHOT',
        report_window:{ from:'2026-09-24T12:00:00Z', to:'2026-09-27T00:00:00Z',
          partial:true, partial_reason:'WINDOW_BEYOND_SNAPSHOT',
          days_without_shards:['2026-09-24'] }
      })
    };
    const sandbox = {
      window:null, state, document, console, Date, Promise, Error,
      getTxWindow: () => ({ hours:60 }),
      SW_EVIDENCE_INDEX: api,
      xrpl: async () => { nativeXrplCalls++; return {}; },
      scanWallets: async () => {},
      run: async () => {},
      log() {}
    };
    sandbox.window = sandbox;
    vm.createContext(sandbox);
    vm.runInContext(SRC49, sandbox);
    await sandbox.SW_EVIDENCE_INDEX.begin({});
    await assert.rejects(
      sandbox.xrpl({}, { command:'account_info', account:'rA' }),
      /PREVIEW_WINDOW_BEYOND_SNAPSHOT_BALANCE_SKIPPED/
    );
    assert.strictEqual(nativeXrplCalls, 0);
    assert.strictEqual(beginCalls, 1);
    await sandbox.xrpl({}, { command:'account_tx', account:'rA' });
    assert.strictEqual(nativeXrplCalls, 1, 'only account_info is skipped by this guard');
  });

  await test('healthy 60h stored window still permits bounded current balance reads', async () => {
    const document = domStub();
    const state = { failedPack: null, seal: null };
    let nativeXrplCalls = 0;
    const api = {
      begin: async () => ({ scan_id:'preview-healthy' }),
      metrics: () => ({
        scan_id:'preview-healthy', target_wallets:418, indexed_wallets:418,
        preview_read_only:true, live_acquisition_disabled:true,
        reason:'PREVIEW_READ_ONLY_SNAPSHOT',
        report_window:{ from:'2026-09-24T12:00:00Z', to:'2026-09-27T00:00:00Z',
          days_without_shards:[] }
      })
    };
    const sandbox = {
      window:null, state, document, console, Date, Promise, Error,
      getTxWindow: () => ({ hours:60 }),
      SW_EVIDENCE_INDEX: api,
      xrpl: async () => { nativeXrplCalls++; return { account_data:{ Balance:'1000000' } }; },
      scanWallets: async () => {},
      run: async () => {},
      log() {}
    };
    sandbox.window = sandbox;
    vm.createContext(sandbox);
    vm.runInContext(SRC49, sandbox);
    await sandbox.SW_EVIDENCE_INDEX.begin({});
    const result = await sandbox.xrpl({}, { command:'account_info', account:'rA' });
    assert(result && result.account_data);
    assert.strictEqual(nativeXrplCalls, 1);
    assert.strictEqual(sandbox.SW_PREVIEW_SUNDAY_FAILOPEN_20260927.long_window_balance_budget_ms, 45000);
  });

  await test('ULDLY shape seals partial ledger-only instead of leaving sections empty', async () => {
    const document = domStub();
    let saveCalls = 0;
    const pack = {
      watchlist_total: 2,
      wallets_checked: 1,
      wallets_failed: 1,
      wallet_results: [
        { address:'rA', status:'CHECKED', delta_xrp:100 },
        { address:'rB', status:'FAILED', delta_xrp:null }
      ],
      tx_scan_coverage: {
        target_wallets:2, complete_wallets:2, failed_wallets:0,
        truncated_wallets:0, unproven_wallets:0, anchor_ok:true,
        full_window_complete:true
      }
    };
    const state = { failedPack:null, seal:null, wallets:pack.wallet_results, newsIntel:null };
    const api = {
      begin: async () => ({ scan_id:'preview-1' }),
      metrics: () => ({
        scan_id:'preview-1', target_wallets:2, indexed_wallets:2,
        preview_read_only:true, live_acquisition_disabled:true,
        reason:'PREVIEW_READ_ONLY_SNAPSHOT',
        report_window:{ from:'2026-09-24T12:00:00Z', to:'2026-09-27T00:00:00Z',
          days_without_shards:[] }
      })
    };
    const sandbox = {
      window:null, state, document, console, Date, Promise, Error, JSON,
      SW_EVIDENCE_INDEX:api,
      getTxWindow:()=>({hours:60}),
      xrpl:async()=>({}),
      scanWallets:async()=>{},
      run:async()=>{ state.failedPack=pack; state.seal=null; },
      buildIntelBrief:()=> 'Net outflow of 100 XRP across 2 watched wallets',
      buildPublicReport:()=> '• Net watched flow: 100 XRP outward',
      buildXRPMainReport:()=> 'Tracked. Watched wallets are net accumulating — about 100 XRP moved inward.',
      finalizeReportPresentation:x=>x,
      canonicalMorningStory:()=> 'while the tracked wallet board gained 100 XRP net versus the local snapshot.',
      buildBundle:(p,seal)=> JSON.stringify({partial:p.partial_report,seal:seal||null}),
      buildEvidenceSeal:async(p,report)=> {
        assert(report.includes('PARTIAL LEDGER-ONLY REPORT'));
        state.seal={report_id:'SW-PARTIAL',scan_id:'SC-PARTIAL'};
        return state.seal;
      },
      buildMasterPaste:()=> 'MASTER',
      saveBlackboxSnapshot:()=>{ saveCalls++; },
      shadowSay(){}, log(){}, elog(){}
    };
    sandbox.window=sandbox;
    vm.createContext(sandbox);
    vm.runInContext(SRC49,sandbox);
    await sandbox.run();

    assert(state.seal, 'partial report must seal');
    assert.strictEqual(state.pack.partial_report.ledger_only, true);
    assert.strictEqual(state.pack.partial_report.persist_brief_memory, false);
    assert.strictEqual(saveCalls, 0, 'partial seal must not advance v34');
    assert(document._nodes.report4k.textContent.includes('PARTIAL LEDGER-ONLY REPORT'));
    assert(document._nodes.mainReport.textContent.includes('Full-board net balance flow WITHHELD'));
  });

  console.log('\n' + passed + ' preview Sunday fail-open tests passed');
})().catch(err => {
  console.error(err && err.stack || err);
  process.exit(1);
});
