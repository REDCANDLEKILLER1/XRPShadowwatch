/* ═══════════════════════════════════════════════════════════════════════════
   SHADOWWATCH PHASE PROGRESS RUNTIME VISIBILITY — 2026-08-20

   Presentation/observability bridge only. Reuses the existing ShadowWatch
   progress engine and its real lifecycle callbacks. It does not alter scanner
   logic, XRPL requests, evidence/discovery decisions, report output, or the
   existing overall progress percentage.
   ═══════════════════════════════════════════════════════════════════════════ */
(function () {
  'use strict';

  var VERSION = '2026.08.20.1';
  var ORDER = [
    'INIT',
    'NEWS_COLLECTION',
    'EVIDENCE_ACQUISITION',
    'WALLET_SNAPSHOT',
    'WALLET_HISTORY_SCAN',
    'TRANSACTION_ANALYSIS',
    'NEXT_HOP_TRACING',
    'DISCOVERY_SCORING',
    'REPORT_GENERATION',
    'EXPORT_SEALING',
    'COMPLETE',
    'INCOMPLETE'
  ];
  var LABEL = {
    INIT: 'Initialization',
    NEWS_COLLECTION: 'News Collection / Router',
    // The delta walk against the evidence store. It runs BEFORE the wallet
    // snapshot and is the longest phase of a cold morning — several minutes —
    // so without its own name the panel showed Wallet Snapshot as completed
    // AND running for the whole of it.
    EVIDENCE_ACQUISITION: 'Evidence Acquisition',
    WALLET_SNAPSHOT: 'Wallet Snapshot',
    WALLET_HISTORY_SCAN: 'Wallet History Scan',
    TRANSACTION_ANALYSIS: 'Transaction Analysis',
    NEXT_HOP_TRACING: 'Next-Hop Tracing',
    DISCOVERY_SCORING: 'Discovery Scoring',
    REPORT_GENERATION: 'Report Generation',
    EXPORT_SEALING: 'Export Sealing',
    COMPLETE: 'Complete',
    INCOMPLETE: 'Report ready — incomplete acquisition'
  };

  var runtime = {
    phase: 'INIT',
    pct: null,
    detail: '',
    completed: [],
    history: [],
    scanActive: false
  };

  function clampPct(v) {
    v = Number(v);
    if (!isFinite(v)) return 0;
    return Math.max(0, Math.min(100, Math.round(v)));
  }

  function remember(name) {
    if (!name || name === 'COMPLETE') return;
    if (runtime.completed.indexOf(name) < 0) runtime.completed.push(name);
  }

  function resetRuntime() {
    runtime.phase = 'INIT';
    runtime.pct = null;
    runtime.detail = '';
    runtime.completed = [];
    runtime.history = [];
    runtime.scanActive = true;
    render();
  }

  // A phase with no fraction behind it reports null, and null renders as a dash
  // rather than as "0%". Those are different claims: one says the phase has not
  // started, the other says nobody is counting. Most phases here have no
  // counter at all — only the wallet passes and the evidence walk do — and
  // printing 0% for the rest made a working run look stalled.
  function pctText(v) { return (v === null || v === undefined) ? '—' : v + '%'; }

  function setPhase(name, pct, detail) {
    if (/^(COMPLETE|EXPORT_SEALING)$/.test(name) && typeof state !== 'undefined' && state.pack &&
        state.pack.tx_scan_coverage && (state.pack.tx_scan_coverage.full_window_complete !== true ||
        state.pack.wallets_checked !== state.pack.watchlist_total || state.pack.wallets_failed)) {
      name = 'INCOMPLETE'; pct = 0; detail = 'Review transaction coverage and acquisition errors';
    }
    if (ORDER.indexOf(name) < 0) return false;
    if (runtime.phase !== name) {
      if (runtime.scanActive) remember(runtime.phase);
      runtime.phase = name;
      runtime.pct = null;
      runtime.detail = '';
      runtime.history.push({ phase: name, at: new Date().toISOString() });
      // A phase that is RUNNING is not a phase that is finished. Re-entering
      // one left it in both lists, so the panel read
      //   Completed: ... ✓ Wallet Snapshot      Running: → Wallet Snapshot
      // which is two contradictory claims about the same phase.
      var done = runtime.completed.indexOf(name);
      if (done >= 0) runtime.completed.splice(done, 1);
    }
    if (pct != null) runtime.pct = clampPct(pct);
    if (detail != null) runtime.detail = String(detail);
    if (name === 'COMPLETE') {
      runtime.pct = 100;
      runtime.scanActive = false;
    }
    if (name === 'INCOMPLETE') { runtime.pct = null; runtime.scanActive = false; }
    try {
      if (window.XAI_SCAN_PROGRESS) {
        window.XAI_SCAN_PROGRESS.runtimePhase = name;
        window.XAI_SCAN_PROGRESS.runtimePhaseLabel = LABEL[name];
        window.XAI_SCAN_PROGRESS.runtimePhasePct = runtime.pct;
      }
    } catch (_) {}
    render();
    return true;
  }

  function styleOnce() {
    try {
      if (document.getElementById('swPhaseRuntimeStyle')) return;
      var st = document.createElement('style');
      st.id = 'swPhaseRuntimeStyle';
      st.textContent =
        '#swPhaseRuntime{margin:8px 0 2px;padding:8px 9px;border:1px solid rgba(0,217,255,.22);border-radius:7px;background:rgba(0,217,255,.025)}' +
        '#swPhaseRuntime .swpr-head{display:flex;align-items:center;justify-content:space-between;gap:8px;font:700 9px Rajdhani,sans-serif;letter-spacing:.12em;text-transform:uppercase;color:#7C8C86}' +
        '#swPhaseRuntime .swpr-phase{margin-top:3px;font:700 12px Rajdhani,sans-serif;letter-spacing:.08em;color:#00D9FF}' +
        '#swPhaseRuntime .swpr-bar{height:7px;margin:6px 0;background:#141B1F;border-radius:5px;overflow:hidden}' +
        '#swPhaseRuntimeFill{height:100%;width:0;background:#00D9FF;transition:width .18s linear}' +
        '#swPhaseRuntime .swpr-meta{font:600 8px Share Tech Mono,monospace;line-height:1.45;color:#7C8C86;white-space:normal}' +
        '#swPhaseRuntime .swpr-run{color:#E6F1EA}' +
        '#xaiPhaseRuntime{margin-top:7px;padding-top:7px;border-top:1px solid rgba(0,217,255,.18);font:600 9px Share Tech Mono,monospace;color:#7C8C86}' +
        '#xaiPhaseRuntime b{color:#00D9FF}';
      (document.head || document.documentElement).appendChild(st);
    } catch (_) {}
  }

  function ensureUi() {
    styleOnce();
    try {
      if (!document.getElementById('swPhaseRuntime')) {
        var seg = document.getElementById('swSegBar');
        if (seg && seg.parentNode) {
          var box = document.createElement('div');
          box.id = 'swPhaseRuntime';
          box.innerHTML =
            '<div class="swpr-head"><span>CURRENT PHASE</span><span id="swPhaseRuntimePct">0%</span></div>' +
            '<div class="swpr-phase" id="swPhaseRuntimeLabel">Initialization</div>' +
            '<div class="swpr-bar"><div id="swPhaseRuntimeFill"></div></div>' +
            '<div class="swpr-meta" id="swPhaseRuntimeCompleted">Completed: —</div>' +
            '<div class="swpr-meta swpr-run" id="swPhaseRuntimeRunning">Running: → Initialization</div>';
          seg.parentNode.insertBefore(box, seg.nextSibling);
        }
      }
    } catch (_) {}
    try {
      if (!document.getElementById('xaiPhaseRuntime')) {
        var mission = document.getElementById('xaiMissionProgress');
        if (mission) {
          var compact = document.createElement('div');
          compact.id = 'xaiPhaseRuntime';
          compact.innerHTML = 'CURRENT PHASE: <b id="xaiPhaseRuntimeLabel">Initialization</b> · <span id="xaiPhaseRuntimePct">0%</span>';
          mission.appendChild(compact);
        }
      }
    } catch (_) {}
  }

  function setText(id, value) {
    try { var el = document.getElementById(id); if (el) el.textContent = value; } catch (_) {}
  }

  function render() {
    ensureUi();
    var label = LABEL[runtime.phase] || runtime.phase;
    var detail = runtime.detail ? ' · ' + runtime.detail : '';
    setText('swPhaseRuntimeLabel', label + detail);
    setText('swPhaseRuntimePct', runtime.phase === 'INCOMPLETE' ? '—' : pctText(runtime.pct));
    setText('swPhaseRuntimeCompleted', 'Completed: ' + (runtime.completed.length ? runtime.completed.map(function (p) { return '✓ ' + LABEL[p]; }).join(' · ') : '—'));
    setText('swPhaseRuntimeRunning', /^(COMPLETE|INCOMPLETE)$/.test(runtime.phase) ? 'Running: —' : 'Running: → ' + label);
    setText('xaiPhaseRuntimeLabel', label);
    setText('xaiPhaseRuntimePct', runtime.phase === 'INCOMPLETE' ? '—' : pctText(runtime.pct));
    try { var fill = document.getElementById('swPhaseRuntimeFill');
      if (fill) fill.style.width = (runtime.pct === null || runtime.pct === undefined ? 0 : runtime.pct) + '%'; } catch (_) {}
  }

  function phaseFromShadowSay(rawPhase) {
    var p = String(rawPhase || '').toUpperCase();
    if (/^(BOOT|INIT|MARKET|WAITING|SCANNING)$/.test(p)) return 'INIT';
    if (/^(WALLETS|BALANCES|LEDGER)$/.test(p)) return 'WALLET_SNAPSHOT';
    if (p === 'TX_SCAN') return 'WALLET_HISTORY_SCAN';
    if (/^(TX|ANALYSIS)$/.test(p)) return 'TRANSACTION_ANALYSIS';
    if (/^(ESCROW|FLOW)$/.test(p)) return 'NEXT_HOP_TRACING';
    if (/^(OFFERS|AMM|DEX|MEMORY|PATTERN|DISCOVERY)$/.test(p)) return 'DISCOVERY_SCORING';
    if (/^(SEAL|BUILDING)$/.test(p)) return 'REPORT_GENERATION';
    if (p === 'SEALED') return 'EXPORT_SEALING';
    if (/^(DONE|READY)$/.test(p)) return 'COMPLETE';
    if (p === 'INCOMPLETE') return 'INCOMPLETE';
    return null;
  }

  function installFunctionBridges() {
    try {
      var originalSay = window.shadowSay || (typeof shadowSay === 'function' ? shadowSay : null);
      if (typeof originalSay === 'function' && !originalSay._swPhaseRuntime20260820) {
        var wrappedSay = function (status, phase, pctVal) {
          var out = originalSay.apply(this, arguments);
          var semantic = phaseFromShadowSay(phase);
          if (semantic) {
            if (semantic === 'INIT' && (!runtime.scanActive || runtime.phase === 'COMPLETE')) resetRuntime();
            // null, NOT 0. Passing 0 here re-zeroed the phase percentage on
            // every shadowSay — which fires constantly — so the sub-bar under
            // CURRENT PHASE sat at 0% for the whole run even for the two
            // phases that DO report a fraction. setPhase already resets the
            // percentage when the phase genuinely changes, so preserving it
            // here loses nothing and stops the stomping.
            setPhase(semantic, semantic === 'COMPLETE' ? 100 : null, status || '');
          }
          return out;
        };
        wrappedSay._swPhaseRuntime20260820 = true;
        wrappedSay._swOriginal = originalSay;
        wrappedSay._original = originalSay._original || originalSay;
        try { window.shadowSay = wrappedSay; } catch (_) {}
        try { shadowSay = wrappedSay; } catch (_) {}
      }
    } catch (_) {}

    try {
      var originalProgress = window.shadowProgress || (typeof shadowProgress === 'function' ? shadowProgress : null);
      if (typeof originalProgress === 'function' && !originalProgress._swPhaseRuntime20260820) {
        var wrappedProgress = function (phaseStart, phaseEnd, fraction) {
          var out = originalProgress.apply(this, arguments);
          // Whatever phase is actually running. This was pinned to two phase
          // names, so a fraction reported during any other one was discarded
          // and that phase showed 0% however far through it was.
          if (runtime.scanActive && !/^(COMPLETE|INCOMPLETE)$/.test(runtime.phase) &&
              isFinite(Number(fraction))) {
            setPhase(runtime.phase, clampPct(Number(fraction) * 100));
          }
          return out;
        };
        wrappedProgress._swPhaseRuntime20260820 = true;
        wrappedProgress._swOriginal = originalProgress;
        wrappedProgress._original = originalProgress._original || originalProgress;
        try { window.shadowProgress = wrappedProgress; } catch (_) {}
        try { shadowProgress = wrappedProgress; } catch (_) {}
      }
    } catch (_) {}
  }

  function bindBus() {
    try {
      var bus = window.SHADOW_EVENT_BUS;
      if (!bus || typeof bus.on !== 'function' || bus._swPhaseRuntime20260820) return false;
      bus._swPhaseRuntime20260820 = true;
      bus.on('shadow.scan.started', function () { resetRuntime(); setPhase('INIT', 0); });
      bus.on('shadow.balance.snapshot.started', function () { setPhase('WALLET_SNAPSHOT', 0); });
      bus.on('shadow.balance.snapshot.completed', function () { setPhase('WALLET_SNAPSHOT', 100); });
      bus.on('shadow.wallet.scan.started', function () {
        if (runtime.phase === 'INIT') setPhase('WALLET_SNAPSHOT', 0);
      });
      bus.on('shadow.wallet.scan.progress', function (ev) {
        var p = (ev && ev.payload) || {};
        if (p.total) setPhase('WALLET_HISTORY_SCAN', (Number(p.checked || 0) / Number(p.total)) * 100, p.checked + '/' + p.total + ' wallets');
      });
      bus.on('shadow.balance.changed', function () { if (runtime.phase === 'WALLET_HISTORY_SCAN') setPhase('TRANSACTION_ANALYSIS', 0); });
      bus.on('shadow.wallet.large_transfer', function () { if (runtime.phase === 'WALLET_HISTORY_SCAN') setPhase('TRANSACTION_ANALYSIS', 0); });
      bus.on('shadow.receiver.forwarded', function () { setPhase('NEXT_HOP_TRACING', Math.max(runtime.phase === 'NEXT_HOP_TRACING' ? runtime.pct : 0, 50)); });
      bus.on('shadow.receiver.held', function () { setPhase('NEXT_HOP_TRACING', Math.max(runtime.phase === 'NEXT_HOP_TRACING' ? runtime.pct : 0, 50)); });
      bus.on('shadow.news.lookup.started', function () { setPhase('NEWS_COLLECTION', 0); });
      bus.on('shadow.news.evidence_led', function () { setPhase('NEWS_COLLECTION', 100); });
      bus.on('shadow.news.degraded', function () { setPhase('NEWS_COLLECTION', 100); });
      bus.on('shadow.wallet.discovered', function () { setPhase('DISCOVERY_SCORING', Math.max(runtime.phase === 'DISCOVERY_SCORING' ? runtime.pct : 0, 50)); });
      bus.on('shadow.candidate.promoted', function () { setPhase('DISCOVERY_SCORING', Math.max(runtime.phase === 'DISCOVERY_SCORING' ? runtime.pct : 0, 75)); });
      bus.on('shadow.candidate.ignored', function () { setPhase('DISCOVERY_SCORING', Math.max(runtime.phase === 'DISCOVERY_SCORING' ? runtime.pct : 0, 75)); });
      bus.on('shadow.report.building', function () { setPhase('REPORT_GENERATION', 0); });
      bus.on('shadow.report.sealed', function () { setPhase('EXPORT_SEALING', 100); });
      return true;
    } catch (_) { return false; }
  }

  function installNarratorBridge() {
    try {
      var nar = window.XAI_PROGRESS_NARRATOR;
      if (!nar || typeof nar.updateProgress !== 'function' || nar.updateProgress._swPhaseRuntime20260820) return false;
      var original = nar.updateProgress;
      nar.updateProgress = function (payload) {
        var out = original.apply(this, arguments);
        try {
          if (payload && payload.phase === 'DONE') setPhase('COMPLETE', 100);
          else if (payload && payload.phase === 'INCOMPLETE') setPhase('INCOMPLETE', 0);
          else if (payload && payload.phase === 'SEALED') setPhase('EXPORT_SEALING', 100);
        } catch (_) {}
        render();
        return out;
      };
      nar.updateProgress._swPhaseRuntime20260820 = true;
      nar.updateProgress._swOriginal = original;
      nar.updateProgress._original = original._original || original;
      return true;
    } catch (_) { return false; }
  }

  function install() {
    ensureUi();
    installFunctionBridges();
    bindBus();
    installNarratorBridge();
    render();
    return true;
  }

  window.SW_PHASE_PROGRESS_RUNTIME_20260820 = {
    version: VERSION,
    read_only: true,
    creates_progress_engine: false,
    changes_overall_progress: false,
    scanner_changed: false,
    evidence_changed: false,
    discovery_decisions_changed: false,
    install: install,
    setPhase: setPhase,
    getState: function () {
      return {
        phase: runtime.phase,
        pct: runtime.pct,
        detail: runtime.detail,
        completed: runtime.completed.slice(),
        history: runtime.history.slice(),
        scanActive: runtime.scanActive
      };
    }
  };

  install();
})();
