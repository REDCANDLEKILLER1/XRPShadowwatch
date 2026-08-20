'use strict';
const fs = require('fs');
const vm = require('vm');
const assert = require('assert');

const gateSrc = fs.readFileSync(process.argv[2] || 'src/brief/40-hard-preseal-completion-gate-20260820.js', 'utf8');

function makeClassList() {
  const set = new Set();
  return { add: (...xs) => xs.forEach(x => set.add(x)), remove: (...xs) => xs.forEach(x => set.delete(x)), contains: x => set.has(x), _set: set };
}
function makePack(overrides = {}) {
  const proof = Array.from({ length: 251 }, (_, i) => ({
    address: 'r' + i,
    status: 'COMPLETE',
    pages_scanned: 1,
    boundary_reached: true,
    history_exhausted: false,
    error: null
  }));
  return Object.assign({
    tx_scan_coverage: { target_wallets: 251, complete_wallets: 251, failed_wallets: 0, truncated_wallets: 0, full_window_complete: true },
    tx_scan_proof: proof,
    scan_link_lost: false,
    wallets_checked: 251,
    wallets_failed: 0,
    wallets_invalid: 0,
    wallets: Array.from({ length: 251 }, () => ({ status: 'CHECKED' })),
    tx_24h_count: 74440,
    total_tx_xrp: 900030000,
    active_wallets: 131,
    shadow_volume_xrp: 444280000,
    large_transfers: [{ amount: 200000000 }, { amount: 144280000 }, { amount: 100000000 }],
    receiver_followthrough: [],
    validation: { errs: [], warn: [], pass: [] }
  }, overrides);
}

function harness(packFactory, opts = {}) {
  const events = [];
  const logs = [];
  const els = new Map();
  const classList = makeClassList();
  const doc = {
    body: { classList },
    getElementById(id) {
      if (!els.has(id)) els.set(id, { textContent: '' });
      return els.get(id);
    }
  };
  let dailyCalls = 0;
  let sealCalls = 0;
  const bus = {
    emit(type, payload) { events.push({ type, payload }); return true; },
    on() {}
  };

  const ctx = {
    console,
    Number, Math, String, Array, RegExp, Object, Date, Promise,
    setInterval: () => { throw new Error('install retry should not be needed in harness'); },
    clearInterval: () => {},
    document: doc,
    SHADOW_EVENT_BUS: bus,
    state: { txScanCoverage: null, linkLostDuringScan: false, seal: { stale: true }, morningStoryReport: 'stale' },
    log: x => logs.push(String(x)),
    shadowSay: () => {},
    PUBLIC_REPORT_PIPELINE_V1: { enabled: () => true },
    _SW_REPORT_MODE: 'CLEAN report (V1 pipeline)',
    SW_DAILY_GATE: {
      gateDelivery(text) { dailyCalls++; return text; }
    },
    scanWallets: async () => {},
    escrowBackfill: async () => { if (opts.escrowThrows) throw new Error('escrow unavailable'); },
    scanReceivers: async () => {},
    scanAmmIntel: async () => {},
    scanOffers: async () => {},
    runRelatedOfferScan: async () => {},
    buildIntelBrief: () => 'intel',
    updatePatternMemory: () => {},
    attachNewsHealthToPack: () => {},
    buildXRPMainReport: () => 'Main report verified forensic artifact '.repeat(3),
    buildEvidenceSeal: async () => { sealCalls++; return { report_id: 'SW-TEST' }; },
    buildShadowWatchTotalFile: () => 'TOTAL REPORT valid',
    downloadShadowWatchTotalFile: () => ({ ok: true, filename: 'report.txt', chars: 123 }),
    downloadAllReports: async () => ({ downloaded: 5, skipped: 0 })
  };
  ctx.window = ctx;

  ctx.run = async function () {
    const p = packFactory();
    ctx.state.txScanCoverage = p.tx_scan_coverage;
    ctx.state.pack = p;
    try {
      await ctx.scanWallets();
      try { await ctx.escrowBackfill(); } catch (_) {}
      await Promise.all([
        ctx.scanReceivers().catch(() => {}),
        ctx.scanAmmIntel().catch(() => {}),
        ctx.scanOffers().catch(() => {})
      ]);
      try { await ctx.runRelatedOfferScan(); } catch (_) {}
      try { ctx.updatePatternMemory(p); } catch (_) {}
      try { ctx.attachNewsHealthToPack(p); } catch (_) {}
      try { ctx.buildIntelBrief(p); } catch (_) {}
      ctx.state.morningStoryReport = opts.story || 'Morning Story verified forensic artifact '.repeat(3);
      ctx.state.morningStoryReport = ctx.SW_DAILY_GATE.gateDelivery(ctx.state.morningStoryReport, p);
      try {
        await ctx.buildEvidenceSeal(
          p,
          opts.publicReport || 'Public report verified forensic artifact '.repeat(3),
          opts.bundle || 'Evidence bundle verified forensic artifact '.repeat(3)
        );
      } catch (_) {}
      // Mimic the existing legacy lifecycle wrapper's post-run completion emit.
      ctx.SHADOW_EVENT_BUS.emit('shadow.wallet.scan.completed', {});
      ctx.SHADOW_EVENT_BUS.emit('shadow.scan.completed', {});
    } finally {}
  };

  vm.createContext(ctx);
  vm.runInContext(gateSrc, ctx, { filename: '40-hard-preseal-completion-gate-20260820.js' });
  return {
    ctx, events, logs, els,
    counts: () => ({ dailyCalls, sealCalls })
  };
}

async function run() {
  // Complete YK8JW-shaped run seals, archives, and can export.
  let h = harness(() => makePack());
  await h.ctx.run();
  assert.strictEqual(h.counts().dailyCalls, 1);
  assert.strictEqual(h.counts().sealCalls, 1);
  assert(h.events.some(e => e.type === 'shadow.scan.completed'));
  assert(!h.events.some(e => e.type === 'shadow.scan.incomplete'));
  assert.strictEqual(h.ctx.SW_HARD_PRESEAL_COMPLETION_GATE_20260820.getState().failure, null);
  assert.strictEqual(h.ctx.downloadShadowWatchTotalFile().ok, true);

  // 180/251 cannot archive or seal, cannot emit completed, and cannot export TOTAL REPORT.
  h = harness(() => makePack({
    tx_scan_coverage: { target_wallets: 251, complete_wallets: 180, failed_wallets: 0, truncated_wallets: 0, full_window_complete: false },
    tx_scan_proof: Array.from({ length: 180 }, () => ({ status: 'COMPLETE', boundary_reached: true, history_exhausted: false })),
    wallets_checked: 180
  }));
  await h.ctx.run();
  assert.strictEqual(h.counts().dailyCalls, 0);
  assert.strictEqual(h.counts().sealCalls, 0);
  assert(!h.events.some(e => e.type === 'shadow.scan.completed'));
  assert(h.events.some(e => e.type === 'shadow.scan.incomplete'));
  assert.strictEqual(h.ctx.downloadShadowWatchTotalFile().ok, false);
  assert(/TOTAL REPORT NOT GENERATED/.test(h.ctx.buildShadowWatchTotalFile()));
  assert(/Scan incomplete — 180\/251 wallets verified/.test(h.els.get('report4k').textContent));
  assert.strictEqual(h.ctx.state.morningStoryReport, '');
  assert.strictEqual(h.ctx.state.seal, null);

  // A swallowed mandatory phase error is still caught by the finalizer.
  h = harness(() => makePack(), { escrowThrows: true });
  await h.ctx.run();
  assert.strictEqual(h.counts().dailyCalls, 0);
  assert.strictEqual(h.counts().sealCalls, 0);
  assert(h.ctx.SW_HARD_PRESEAL_COMPLETION_GATE_20260820.getState().failure.reasons.some(x => /mandatory phase incomplete: escrow/.test(x)));

  // Aggregate coverage cannot claim COMPLETE if a per-wallet proof is unproven.
  h = harness(() => {
    const p = makePack();
    p.tx_scan_proof[17] = { status: 'TRUNCATED', boundary_reached: false, history_exhausted: false };
    return p;
  });
  await h.ctx.run();
  assert.strictEqual(h.counts().sealCalls, 0);
  assert(h.ctx.SW_HARD_PRESEAL_COMPLETION_GATE_20260820.getState().failure.reasons.some(x => /unproven wallet/.test(x)));

  // Link-loss state is fatal even if aggregate counts look complete.
  h = harness(() => makePack({ scan_link_lost: true }));
  await h.ctx.run();
  assert.strictEqual(h.counts().sealCalls, 0);
  assert(h.ctx.SW_HARD_PRESEAL_COMPLETION_GATE_20260820.getState().failure.reasons.some(x => /link loss/.test(x)));

  // KGMT/public narrative fallback is not sealable.
  h = harness(() => makePack(), {
    story: "Today's scan completed. The public narrative engine could not assemble a publishable report from the available evidence. ".repeat(2)
  });
  await h.ctx.run();
  assert.strictEqual(h.counts().sealCalls, 0);
  assert(h.ctx.SW_HARD_PRESEAL_COMPLETION_GATE_20260820.getState().failure.reasons.some(x => /Morning Story audit fell back/.test(x)));

  // Missing/NaN mandatory metrics and evidence mismatch are fatal.
  h = harness(() => makePack({ total_tx_xrp: NaN }));
  await h.ctx.run();
  assert.strictEqual(h.counts().sealCalls, 0);
  assert(h.ctx.SW_HARD_PRESEAL_COMPLETION_GATE_20260820.getState().failure.reasons.some(x => /total_tx_xrp/.test(x)));

  h = harness(() => makePack({ shadow_volume_xrp: 444280001 }));
  await h.ctx.run();
  assert.strictEqual(h.counts().sealCalls, 0);
  assert(h.ctx.SW_HARD_PRESEAL_COMPLETION_GATE_20260820.getState().failure.reasons.some(x => /does not reconcile/.test(x)));

  // A legitimate zero-activity scan remains sealable.
  h = harness(() => makePack({ shadow_volume_xrp: 0, large_transfers: [], tx_24h_count: 0, total_tx_xrp: 0, active_wallets: 0 }));
  await h.ctx.run();
  assert.strictEqual(h.counts().dailyCalls, 1);
  assert.strictEqual(h.counts().sealCalls, 1);

  // Placeholder text cannot be sealed.
  h = harness(() => makePack(), { bundle: 'Evidence bundle contains undefined placeholder '.repeat(3) });
  await h.ctx.run();
  assert.strictEqual(h.counts().sealCalls, 0);
  assert(h.ctx.SW_HARD_PRESEAL_COMPLETION_GATE_20260820.getState().failure.reasons.some(x => /placeholder leaked into bundle/.test(x)));

  console.log('hard pre-seal runtime gate: 9 scenarios PASS');
}

run().catch(err => { console.error(err); process.exit(1); });
