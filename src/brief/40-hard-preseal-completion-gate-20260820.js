/* ═══════════════════════════════════════════════════════════════════════════
   SHADOWWATCH HARD PRE-SEAL COMPLETION GATE — 2026-08-20

   Fail-closed finalization only. A scan may be sealed/published only when the
   required XRPL evidence contracts completed. Incomplete runs remain available
   for debug inspection but cannot become a Morning Report, TOTAL REPORT, daily
   archive entry, or shadow.report.sealed event.

   READ-ONLY. No signing, submit, trading, payout, scanner thresholds, account_tx
   pagination, evidence scoring, discovery scoring, or ledger mutation changes.
   ═══════════════════════════════════════════════════════════════════════════ */
(function () {
  'use strict';

  var VERSION = '2026.08.20.1';
  var REQUIRED = [
    'wallet_history',
    'escrow',
    'receiver_followthrough',
    'amm_dex',
    'offers',
    'related_offers',
    'intelligence_assembly',
    'pattern_memory',
    'news_router'
  ];
  var tracker = { active: false, phases: {}, failure: null, installed: false };

  function stateRef() {
    try { return (typeof state !== 'undefined' && state) ? state : null; } catch (_) { return null; }
  }

  function resetTracker() {
    tracker.active = true;
    tracker.failure = null;
    tracker.phases = {};
    REQUIRED.forEach(function (name) { tracker.phases[name] = 'PENDING'; });
    var s = stateRef();
    if (s) {
      s._hardPreSealFailure = null;
      s._lastRunIncomplete = null;
      s._hardPreSealPhaseStatus = tracker.phases;
      // Never let a failed new run inherit a prior run's seal/public story.
      s.seal = null;
      s.evidenceCapsule = null;
      s.morningStoryReport = '';
    }
    clearSealUi();
  }

  function mark(name, status) {
    if (!tracker.active || REQUIRED.indexOf(name) < 0) return;
    tracker.phases[name] = status || 'COMPLETE';
  }

  function finiteNonNegative(v) {
    return typeof v === 'number' && Number.isFinite(v) && v >= 0;
  }

  function coverageFrom(pack) {
    var s = stateRef();
    var c = (pack && pack.tx_scan_coverage) || (s && s.txScanCoverage) || {};
    var target = Number(c.target_wallets);
    var complete = Number(c.complete_wallets);
    var failed = Number(c.failed_wallets);
    var truncated = Number(c.truncated_wallets);
    return {
      target_wallets: Number.isFinite(target) ? target : 0,
      complete_wallets: Number.isFinite(complete) ? complete : 0,
      failed_wallets: Number.isFinite(failed) ? failed : 0,
      truncated_wallets: Number.isFinite(truncated) ? truncated : 0,
      raw_target_valid: Number.isFinite(target) && target > 0,
      raw_complete_valid: Number.isFinite(complete),
      raw_failed_valid: Number.isFinite(failed),
      raw_truncated_valid: Number.isFinite(truncated),
      full_window_complete: c.full_window_complete === true
    };
  }

  function validate(pack, artifacts, options) {
    var p = pack || {};
    var a = artifacts || {};
    var opt = options || {};
    var reasons = [];
    var cov = coverageFrom(p);
    var s = stateRef();

    if (!cov.full_window_complete) reasons.push('transaction window is not proven complete');
    if (!cov.raw_target_valid) reasons.push('transaction coverage target is missing');
    if (!cov.raw_complete_valid || cov.complete_wallets !== cov.target_wallets)
      reasons.push('transaction coverage is ' + cov.complete_wallets + '/' + cov.target_wallets);
    if (!cov.raw_failed_valid || cov.failed_wallets !== 0)
      reasons.push(cov.failed_wallets + ' transaction wallet scan(s) failed');
    if (!cov.raw_truncated_valid || cov.truncated_wallets !== 0)
      reasons.push(cov.truncated_wallets + ' transaction wallet scan(s) truncated');

    if (Number(p.wallets_failed) !== 0) reasons.push(Number(p.wallets_failed) + ' watched wallet balance scan(s) failed');
    if (Number(p.wallets_invalid) !== 0) reasons.push(Number(p.wallets_invalid) + ' watched wallet address(es) invalid');
    if (cov.raw_target_valid && Number(p.wallets_checked) !== cov.target_wallets)
      reasons.push('wallet/transaction coverage mismatch: ' + Number(p.wallets_checked) + ' checked vs ' + cov.target_wallets + ' transaction targets');

    var linkLost = !!p.scan_link_lost;
    try { linkLost = linkLost || !!(s && s.linkLostDuringScan); } catch (_) {}
    if (linkLost) reasons.push('XRPL link loss remained unresolved during the scan');

    if (opt.requirePhases !== false) {
      REQUIRED.forEach(function (name) {
        if (tracker.phases[name] !== 'COMPLETE')
          reasons.push('mandatory phase incomplete: ' + name + ' (' + (tracker.phases[name] || 'MISSING') + ')');
      });
    }

    ['wallets_checked', 'tx_24h_count', 'total_tx_xrp', 'shadow_volume_xrp', 'active_wallets'].forEach(function (key) {
      if (!finiteNonNegative(p[key])) reasons.push('mandatory metric missing/invalid: ' + key);
    });
    if (!Array.isArray(p.wallets)) reasons.push('mandatory evidence missing: wallets');
    if (!Array.isArray(p.large_transfers)) reasons.push('mandatory evidence missing: large_transfers');
    if (!Array.isArray(p.receiver_followthrough)) reasons.push('mandatory evidence missing: receiver_followthrough');
    if (!Array.isArray(p.tx_scan_proof)) {
      reasons.push('transaction-window proof list is missing');
    } else {
      if (cov.raw_target_valid && p.tx_scan_proof.length !== cov.target_wallets)
        reasons.push('transaction-window proof count does not match target');
      p.tx_scan_proof.forEach(function (proof) {
        if (!proof || proof.status !== 'COMPLETE' || (!proof.boundary_reached && !proof.history_exhausted))
          reasons.push('transaction-window proof contains an unproven wallet');
      });
    }
    if (!p.validation || !Array.isArray(p.validation.errs)) reasons.push('validation contract missing');
    else if (p.validation.errs.length) reasons.push('validation errors: ' + p.validation.errs.join('; '));

    // Shadow Volume must reconcile to the canonical large-transfer evidence.
    // A genuine zero-activity run remains valid.
    if (Array.isArray(p.large_transfers) && finiteNonNegative(p.shadow_volume_xrp)) {
      var sum = 0, invalidAmount = false;
      p.large_transfers.forEach(function (row) {
        var amount = Number(row && row.amount);
        if (!Number.isFinite(amount) || amount < 0) invalidAmount = true;
        else sum += amount;
      });
      if (invalidAmount) reasons.push('large-transfer evidence contains a non-numeric amount');
      else if (Math.abs(sum - p.shadow_volume_xrp) > 0.001)
        reasons.push('Shadow Volume does not reconcile with large-transfer evidence');
    }

    Object.keys(a).forEach(function (key) {
      var text = String(a[key] == null ? '' : a[key]);
      if (text.trim().length < 40) reasons.push('required report artifact missing/too short: ' + key);
      if (/\b(?:undefined|NaN)\b/.test(text)) reasons.push('placeholder leaked into ' + key);
    });

    var story = String(a.morningStory || '');
    if (story) {
      if (/public narrative engine could not assemble a publishable report/i.test(story) ||
          /Audit blocked today['’]s public report/i.test(story)) {
        reasons.push('Morning Story audit fell back instead of producing a publishable report');
      }
      try {
        var pipe = window.PUBLIC_REPORT_PIPELINE_V1;
        var enabled = pipe && typeof pipe.enabled === 'function' ? pipe.enabled() : false;
        var mode = String(window._SW_REPORT_MODE || '');
        if (enabled && !/^CLEAN report/i.test(mode))
          reasons.push('Morning Story pipeline audit did not finish CLEAN (' + (mode || 'no mode') + ')');
      } catch (_) {}
    }

    return {
      pass: reasons.length === 0,
      code: reasons.length ? 'INCOMPLETE_SCAN' : 'COMPLETE',
      reasons: reasons,
      coverage: {
        target_wallets: cov.target_wallets,
        complete_wallets: cov.complete_wallets,
        failed_wallets: cov.failed_wallets,
        truncated_wallets: cov.truncated_wallets,
        full_window_complete: cov.full_window_complete
      },
      phases: Object.assign({}, tracker.phases)
    };
  }

  function setFailure(result) {
    tracker.failure = result;
    var s = stateRef();
    if (s) {
      s._hardPreSealFailure = result;
      s._lastRunIncomplete = result;
      s.seal = null;
      s.evidenceCapsule = null;
      s.morningStoryReport = '';
    }
    return result;
  }

  function makeError(result) {
    var e = new Error('INCOMPLETE_SCAN: ' + (result.reasons || []).join(' | '));
    e.code = 'INCOMPLETE_SCAN';
    e.completion = result;
    return e;
  }

  function userMessage(result) {
    var c = (result && result.coverage) || {};
    var coverageProblem = (result && result.reasons || []).some(function (x) {
      return /transaction window|transaction coverage|wallet scan|link loss/i.test(String(x));
    });
    return 'Scan incomplete — ' + Number(c.complete_wallets || 0) + '/' + Number(c.target_wallets || 0) +
      ' wallets verified. Report not generated.' + (coverageProblem ? ' Reconnect and run again.' : ' Resolve the incomplete evidence phase and run again.');
  }

  function clearSealUi() {
    try {
      ['sealReportId','sealScanId','sealCharCount','sealPublicHash','sealFullHash','sealMasterHash','sealJson'].forEach(function (id) {
        var el = document.getElementById(id); if (el) el.textContent = '';
      });
      var mini = document.getElementById('hudSealMini');
      if (mini) mini.textContent = 'NOT SEALED';
    } catch (_) {}
  }

  function applyIncompleteUi(result) {
    var s = stateRef();
    if (s) {
      s.seal = null;
      s.evidenceCapsule = null;
      s.morningStoryReport = '';
    }
    var msg = userMessage(result);
    clearSealUi();
    try {
      document.body.classList.remove('sealed', 'building', 'scanning');
      document.body.classList.add('error', 'incomplete');
    } catch (_) {}
    try {
      ['mainReport', 'agentBox', 'masterPaste', 'bundleBox', 'briefBox'].forEach(function (id) {
        var el = document.getElementById(id); if (el) el.textContent = '';
      });
      var report = document.getElementById('report4k');
      if (report) report.textContent = msg + '\n\nCompletion gate:\n- ' + (result.reasons || []).join('\n- ');
    } catch (_) {}
    try { if (typeof shadowSay === 'function') shadowSay(msg, 'ERROR', 0); } catch (_) {}
    try { if (typeof log === 'function') log('INCOMPLETE_SCAN: ' + (result.reasons || []).join(' | ')); } catch (_) {}
    return msg;
  }

  function wrapAsync(name, phase) {
    var fn = null;
    try { fn = window[name]; } catch (_) {}
    if (typeof fn !== 'function') return false;
    if (fn._swHardPreSealPhase20260820) return true;
    var wrapped = async function () {
      if (tracker.active) mark(phase, 'RUNNING');
      try {
        var out = await fn.apply(this, arguments);
        if (tracker.active) mark(phase, 'COMPLETE');
        return out;
      } catch (e) {
        if (tracker.active) mark(phase, 'FAILED: ' + (e && e.message ? e.message : String(e)));
        throw e;
      }
    };
    wrapped._swHardPreSealPhase20260820 = true;
    wrapped._swOriginal = fn;
    try { window[name] = wrapped; } catch (_) { return false; }
    return true;
  }

  function wrapSync(name, phase) {
    var fn = null;
    try { fn = window[name]; } catch (_) {}
    if (typeof fn !== 'function') return false;
    if (fn._swHardPreSealPhase20260820) return true;
    var wrapped = function () {
      if (tracker.active) mark(phase, 'RUNNING');
      try {
        var out = fn.apply(this, arguments);
        if (tracker.active) mark(phase, 'COMPLETE');
        return out;
      } catch (e) {
        if (tracker.active) mark(phase, 'FAILED: ' + (e && e.message ? e.message : String(e)));
        throw e;
      }
    };
    wrapped._swHardPreSealPhase20260820 = true;
    wrapped._swOriginal = fn;
    try { window[name] = wrapped; } catch (_) { return false; }
    return true;
  }

  function installPhaseHooks() {
    var ok = true;
    ok = wrapAsync('scanWallets', 'wallet_history') && ok;
    ok = wrapAsync('escrowBackfill', 'escrow') && ok;
    ok = wrapAsync('scanReceivers', 'receiver_followthrough') && ok;
    ok = wrapAsync('scanAmmIntel', 'amm_dex') && ok;
    ok = wrapAsync('scanOffers', 'offers') && ok;
    ok = wrapAsync('runRelatedOfferScan', 'related_offers') && ok;
    ok = wrapSync('buildIntelBrief', 'intelligence_assembly') && ok;
    ok = wrapSync('updatePatternMemory', 'pattern_memory') && ok;
    ok = wrapSync('attachNewsHealthToPack', 'news_router') && ok;
    return ok;
  }

  function installDailyGateGuard() {
    try {
      var gate = window.SW_DAILY_GATE;
      if (!gate || typeof gate.gateDelivery !== 'function') return false;
      if (gate.gateDelivery._swHardPreSeal20260820) return true;
      var original = gate.gateDelivery;
      gate.gateDelivery = function (text, pack) {
        var result = validate(pack, { morningStory: String(text || '') }, { requirePhases: true });
        if (!result.pass) {
          setFailure(result);
          // Return the candidate unchanged so the existing run can continue to
          // the hard seal boundary; critically, do NOT call the archival gate.
          return String(text || '');
        }
        return original.apply(this, arguments);
      };
      gate.gateDelivery._swHardPreSeal20260820 = true;
      gate.gateDelivery._swOriginal = original;
      return true;
    } catch (_) { return false; }
  }

  function installSealGuard() {
    var fn = null;
    try { fn = window.buildEvidenceSeal; } catch (_) {}
    if (typeof fn !== 'function') return false;
    if (fn._swHardPreSeal20260820) return true;
    var wrapped = async function (pack, report, bundle) {
      var s = stateRef();
      var mainReport = '';
      try { if (typeof buildXRPMainReport === 'function') mainReport = String(buildXRPMainReport(pack) || ''); } catch (_) {}
      var result = tracker.failure || validate(pack, {
        morningStory: String((s && s.morningStoryReport) || ''),
        publicReport: String(report || ''),
        mainReport: mainReport,
        bundle: String(bundle || '')
      }, { requirePhases: true });
      if (!result.pass) {
        setFailure(result);
        throw makeError(result);
      }
      return await fn.apply(this, arguments);
    };
    wrapped._swHardPreSeal20260820 = true;
    wrapped._swOriginal = fn;
    try { window.buildEvidenceSeal = wrapped; } catch (_) { return false; }
    try { buildEvidenceSeal = wrapped; } catch (_) {}
    return true;
  }

  function installEventGuard() {
    try {
      var bus = window.SHADOW_EVENT_BUS;
      if (!bus || typeof bus.emit !== 'function') return false;
      if (bus.emit._swHardPreSeal20260820) return true;
      var original = bus.emit;
      bus.emit = function (type, payload) {
        var s = stateRef();
        var failed = !!tracker.failure || !!(s && s._hardPreSealFailure);
        var bodyError = false;
        try { bodyError = document.body.classList.contains('error'); } catch (_) {}
        if ((failed || bodyError) && (type === 'shadow.scan.completed' || type === 'shadow.wallet.scan.completed' || type === 'shadow.report.sealed')) {
          return false;
        }
        return original.apply(this, arguments);
      };
      bus.emit._swHardPreSeal20260820 = true;
      bus.emit._swOriginal = original;
      return true;
    } catch (_) { return false; }
  }

  function installRunGuard() {
    var fn = null;
    try { fn = window.run; } catch (_) {}
    if (typeof fn !== 'function') return false;
    if (fn._swHardPreSeal20260820) return true;
    var wrapped = async function () {
      resetTracker();
      try {
        var out = await fn.apply(this, arguments);
        if (tracker.failure) {
          applyIncompleteUi(tracker.failure);
          try {
            var bus = window.SHADOW_EVENT_BUS;
            if (bus && typeof bus.emit === 'function') bus.emit('shadow.scan.incomplete', { completion: tracker.failure, ts: Date.now() });
          } catch (_) {}
        }
        return out;
      } finally {
        tracker.active = false;
      }
    };
    wrapped._swHardPreSeal20260820 = true;
    wrapped._swOriginal = fn;
    try { window.run = wrapped; } catch (_) { return false; }
    try { run = wrapped; } catch (_) {}
    return true;
  }

  function blockPublicExportsWhenIncomplete() {
    function blocked() {
      var s = stateRef();
      return !!tracker.failure || !!(s && s._hardPreSealFailure);
    }
    try {
      if (typeof window.downloadShadowWatchTotalFile === 'function' && !window.downloadShadowWatchTotalFile._swHardPreSeal20260820) {
        var dl = window.downloadShadowWatchTotalFile;
        var wrappedDl = function () {
          if (blocked()) {
            try { if (typeof log === 'function') log('TOTAL REPORT blocked — scan is INCOMPLETE / NOT SEALED. TOTAL DEBUG remains available.'); } catch (_) {}
            return { ok: false, code: 'INCOMPLETE_SCAN', filename: null, chars: 0 };
          }
          return dl.apply(this, arguments);
        };
        wrappedDl._swHardPreSeal20260820 = true;
        wrappedDl._swOriginal = dl;
        window.downloadShadowWatchTotalFile = wrappedDl;
        try { downloadShadowWatchTotalFile = wrappedDl; } catch (_) {}
      }
    } catch (_) {}

    try {
      if (typeof window.buildShadowWatchTotalFile === 'function' && !window.buildShadowWatchTotalFile._swHardPreSeal20260820) {
        var build = window.buildShadowWatchTotalFile;
        var wrappedBuild = function () {
          if (blocked()) return 'INCOMPLETE_SCAN — TOTAL REPORT NOT GENERATED. Use TOTAL DEBUG for diagnostic evidence.';
          return build.apply(this, arguments);
        };
        wrappedBuild._swHardPreSeal20260820 = true;
        wrappedBuild._swOriginal = build;
        window.buildShadowWatchTotalFile = wrappedBuild;
        try { buildShadowWatchTotalFile = wrappedBuild; } catch (_) {}
      }
    } catch (_) {}

    try {
      if (typeof window.downloadAllReports === 'function' && !window.downloadAllReports._swHardPreSeal20260820) {
        var all = window.downloadAllReports;
        var wrappedAll = async function () {
          if (blocked()) return { downloaded: 0, skipped: 0, code: 'INCOMPLETE_SCAN' };
          return await all.apply(this, arguments);
        };
        wrappedAll._swHardPreSeal20260820 = true;
        wrappedAll._swOriginal = all;
        window.downloadAllReports = wrappedAll;
        try { downloadAllReports = wrappedAll; } catch (_) {}
      }
    } catch (_) {}
  }

  function install() {
    var phases = installPhaseHooks();
    var daily = installDailyGateGuard();
    var seal = installSealGuard();
    var events = installEventGuard();
    var runOk = installRunGuard();
    blockPublicExportsWhenIncomplete();
    tracker.installed = !!(phases && daily && seal && events && runOk);
    return tracker.installed;
  }

  window.SW_HARD_PRESEAL_COMPLETION_GATE_20260820 = {
    version: VERSION,
    read_only: true,
    fail_closed: true,
    incomplete_is_sealed: false,
    changes_account_tx: false,
    changes_scanner_thresholds: false,
    changes_evidence_scoring: false,
    changes_discovery_scoring: false,
    validate: validate,
    getState: function () {
      return { active: tracker.active, phases: Object.assign({}, tracker.phases), failure: tracker.failure, installed: tracker.installed };
    },
    install: install
  };

  if (!install()) {
    var tries = 0;
    var timer = setInterval(function () {
      tries++;
      if (install() || tries >= 40) clearInterval(timer);
    }, 100);
  }
})();
