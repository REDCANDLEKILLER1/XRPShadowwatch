/* ═══════════════════════════════════════════════════════════════════════════
   LIVE CANONICAL WATCHLIST PROMOTION — 2026-09-09

   Report-only, read-only XRPL behavior:
   1) Load committed canonical promotions into the browser watch roster.
   2) After a SUCCESSFULLY SEALED report, auto-promote only the decision the
      Auto Wallet Finder already made: recommended_action === "ADD" and the
      address is not already watched. REVIEW and MONITOR never auto-promote.
   3) Promotion is best-effort and server-side. Failure can never invalidate,
      alter, or rerun the sealed ledger report.
   4) Failed rescans preserve the prior sealed report/state instead of replacing
      it with a failed partial run.
   5) Morning-story candidate wording reports canonical ADD/REVIEW/MONITOR
      counts so it cannot disagree with the structured Suggested Wallets export.

   NO XRPL signing, submit, trading, payout, trustline, offer, or other write.
   ═══════════════════════════════════════════════════════════════════════════ */
(function () {
  'use strict';

  var VERSION = '2026.09.09.1';
  var PROMOTION_FILE = '/src/shared/watchlist-promotions.json';
  var processedReports = Object.create(null);
  var loadPromise = null;

  function logSafe(msg) {
    try { if (typeof log === 'function') log('[watchlist promotion] ' + msg); } catch (_) {}
  }
  function errorSafe(where, err) {
    try { if (typeof elog === 'function') elog('watchlist promotion: ' + where, err); } catch (_) {}
  }
  function validAddress(a) {
    return typeof a === 'string' && /^r[1-9A-HJ-NP-Za-km-z]{24,34}$/.test(a);
  }
  function normalizePromotion(raw) {
    if (!raw || !validAddress(raw.address)) return null;
    var short = raw.address.slice(0, 8);
    return {
      address: raw.address,
      label: (typeof raw.label === 'string' && raw.label.trim()) ? raw.label.trim() : ('AUTO_WATCH_' + short),
      cat: (typeof raw.cat === 'string' && raw.cat.trim()) ? raw.cat.trim() : 'discovered_unknown_highval',
      source_report: raw.source_report || null,
      source_scan: raw.source_scan || null
    };
  }

  function mergePromotion(raw) {
    var p = normalizePromotion(raw);
    if (!p) return false;
    var a = p.address;
    var added = false;

    try {
      if (typeof WATCHLIST !== 'undefined' && Array.isArray(WATCHLIST) &&
          !WATCHLIST.some(function (w) { return w && w.address === a; })) {
        WATCHLIST.push({ label: p.label, address: a, cat: p.cat });
        added = true;
      }
    } catch (_) {}

    try {
      if (typeof KNOWN !== 'undefined' && KNOWN) {
        if (!KNOWN[a]) KNOWN[a] = { label: p.label, address: a, cat: p.cat };
        else if (!KNOWN[a].cat) KNOWN[a].cat = p.cat;
      }
    } catch (_) {}

    try {
      var R = window.SW_HVT_ROSTER;
      if (R && Array.isArray(R.targets) && !R.targets.some(function (t) { return t && t.address === a; })) {
        R.targets.push({
          address: a,
          label: p.label,
          handle: p.label,
          type: 'HVT',
          cat: p.cat,
          identified: false,
          confidence: null,
          expected_xrp: null,
          expected_source: null,
          sources: ['report']
        });
        if (R.stats) {
          R.stats.total = R.targets.length;
          if (typeof R.stats.from_report_only === 'number') R.stats.from_report_only += 1;
        }
      }
    } catch (_) {}

    return added;
  }

  async function loadCommittedPromotions() {
    if (loadPromise) return loadPromise;
    loadPromise = (async function () {
      try {
        var response = await fetch(PROMOTION_FILE + '?v=' + Date.now(), { cache: 'no-store', credentials: 'same-origin' });
        if (!response.ok) throw new Error('promotion roster HTTP ' + response.status);
        var rows = await response.json();
        if (!Array.isArray(rows)) throw new Error('promotion roster is not an array');
        var n = 0;
        rows.forEach(function (row) { if (mergePromotion(row)) n++; });
        if (n) logSafe('loaded ' + n + ' committed wallet promotion(s).');
        return { ok: true, loaded: rows.length, added: n };
      } catch (e) {
        errorSafe('load committed roster', e);
        return { ok: false, loaded: 0, added: 0, error: String(e && e.message || e) };
      }
    })();
    return loadPromise;
  }

  function resolveSeal(data) {
    var d = data && data.payload ? data.payload : (data || {});
    var eventSeal = (d && d.seal) || {};
    var s = {};
    try { s = (typeof state !== 'undefined' && state.seal) || {}; } catch (_) {}
    var p = {};
    try { p = (typeof state !== 'undefined' && state.pack) || {}; } catch (_) {}
    return {
      report_id: d.report_id || eventSeal.report_id || s.report_id || p.report_id || null,
      scan_id: d.scan_id || eventSeal.scan_id || s.scan_id || p.scan_id || null
    };
  }

  function canonicalAdditions() {
    try {
      var F = window.AUTO_WALLET_FINDER;
      var p = (typeof state !== 'undefined' && state.pack) || {};
      if (!F || typeof F.buildSuggestedWatchlistAdditions !== 'function') return [];
      return (F.buildSuggestedWatchlistAdditions(p) || []).filter(function (c) {
        return c && c.recommended_action === 'ADD' && c.is_already_watched === false && validAddress(c.address);
      });
    } catch (e) {
      errorSafe('read canonical additions', e);
      return [];
    }
  }

  async function postPromotion(seal, candidate) {
    var response = await fetch('/api/watchlist-promote', {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ report_id: seal.report_id, scan_id: seal.scan_id, address: candidate.address })
    });
    var body = await response.json().catch(function () { return {}; });
    if (!response.ok) throw new Error(body.error || ('promotion HTTP ' + response.status));
    if (body.status !== 'PROMOTED' && body.status !== 'ALREADY_PROMOTED') {
      throw new Error('unexpected promotion status: ' + String(body.status || 'missing'));
    }
    return body;
  }

  async function promoteCanonicalAdds(data) {
    var seal = resolveSeal(data);
    if (!/^SW-\d{8}-[A-Z0-9]{5}$/.test(seal.report_id || '') || !/^SC-[A-Z0-9]+$/.test(seal.scan_id || '')) {
      return { attempted: false, reason: 'sealed report identifiers unavailable', results: [] };
    }
    var reportKey = seal.report_id + '|' + seal.scan_id;
    if (processedReports[reportKey]) return processedReports[reportKey];

    var work = (async function () {
      var additions = canonicalAdditions();
      var results = [];
      for (var i = 0; i < additions.length; i++) {
        var c = additions[i];
        try {
          var r = await postPromotion(seal, c);
          // Do not inject the new address into WATCHLIST on this deployment.
          // The server-side canonical roster is built from the committed file
          // present in the deployment. Adding it client-side before Vercel has
          // deployed the promotion commit would make the next scan send an
          // address the current server roster does not yet know and cause a
          // ROSTER_MISMATCH. The following deployment/run loads it normally.
          try {
            if (window.AUTO_WALLET_FINDER && typeof window.AUTO_WALLET_FINDER.markCandidateReviewed === 'function') {
              window.AUTO_WALLET_FINDER.markCandidateReviewed(c.address, 'ADDED');
            }
          } catch (_) {}
          results.push({ address: c.address, status: r.status, commit_sha: r.commit_sha || null });
          logSafe((r.status === 'PROMOTED' ? 'promoted ' : 'already promoted ') + c.address);
        } catch (e) {
          results.push({ address: c.address, status: 'FAILED', error: String(e && e.message || e) });
          errorSafe('promote ' + c.address, e);
        }
      }
      return { attempted: additions.length > 0, report_id: seal.report_id, scan_id: seal.scan_id, results: results };
    })();

    // Cache the promise immediately so repeated seal events cannot race duplicate writes.
    processedReports[reportKey] = work;
    return work;
  }

  function installExportTruth() {
    var F = window.AUTO_WALLET_FINDER;
    if (!F || F._swLivePromotionTruth20260909) return !!F;

    if (typeof F.exportSuggestedWalletsTXT === 'function') {
      var txt = F.exportSuggestedWalletsTXT;
      F.exportSuggestedWalletsTXT = function () {
        var out = String(txt.apply(this, arguments) || '');
        out = out.replace(
          /SAFETY: All entries below are suggestions only\.\s*\nNo watchlist mutations occur automatically\.\s*\nReview each entry\. Use Add-Reviewed action to confirm\./,
          'SAFETY: Canonical ADD entries auto-promote to the permanent watched roster after a successful seal.\nREVIEW and MONITOR entries never auto-promote.\nNo XRPL write, signing, submit, trading, or payout behavior is involved.'
        );
        return out;
      };
    }

    if (typeof F.exportSuggestedWalletsJSON === 'function') {
      var json = F.exportSuggestedWalletsJSON;
      F.exportSuggestedWalletsJSON = function () {
        var out = json.apply(this, arguments) || {};
        out.safety = Object.assign({}, out.safety || {}, {
          permanent_additions_require_review: true,
          manual_second_review_required: false,
          review_basis: 'canonical recommended_action ADD',
          labels_are_suggestions_only: true,
          no_auto_add: false,
          canonical_additions_auto_promote: true,
          review_monitor_auto_promote: false,
          auto_add_rule: 'recommended_action === ADD && is_already_watched === false'
        });
        return out;
      };
    }

    F._swLivePromotionTruth20260909 = true;
    return true;
  }

  function candidateCountLine() {
    var F = window.AUTO_WALLET_FINDER;
    if (!F || typeof F.buildSuggestedWatchlistAdditions !== 'function') return null;
    var p = (typeof state !== 'undefined' && state.pack) || {};
    var list = F.buildSuggestedWatchlistAdditions(p) || [];
    var fresh = list.filter(function (c) { return c && c.seen_this_scan === true; }).length;
    var counts = { ADD: 0, REVIEW: 0, MONITOR: 0 };
    list.forEach(function (c) {
      var a = c && c.recommended_action;
      if (Object.prototype.hasOwnProperty.call(counts, a)) counts[a]++;
    });
    var watched = null;
    try { watched = (typeof WATCHLIST !== 'undefined' && Array.isArray(WATCHLIST)) ? WATCHLIST.length : null; } catch (_) {}
    return 'In the discovery queue right now: ' + list.length + ' flagged candidates — ' + fresh +
      ' found this scan; ' + counts.ADD + ' marked ADD, ' + counts.REVIEW + ' REVIEW, ' + counts.MONITOR +
      ' MONITOR' + (watched == null ? '' : '; separate from the ' + watched + ' wallets on the permanent watch list');
  }

  function installMorningCountTruth() {
    var fn = window.buildMorningStoryText;
    if (typeof fn !== 'function') return false;
    if (fn._swLivePromotionCounts20260909) return true;
    var wrapped = function () {
      var out = String(fn.apply(this, arguments) || '');
      try {
        var line = candidateCountLine();
        if (line) {
          out = out.replace(
            /In the discovery queue right now:\s*\d+\s+flagged candidates\s*—\s*\d+\s+found this scan,\s*\d+\s+recommended for review,\s*separate from the\s*\d+\s+wallets on the permanent watch list/,
            line
          );
        }
      } catch (e) { errorSafe('morning candidate wording', e); }
      return out;
    };
    wrapped._swLivePromotionCounts20260909 = true;
    wrapped._swOriginal = fn;
    window.buildMorningStoryText = wrapped;
    return true;
  }

  var STATE_RESTORE_KEYS = [
    'wallets','txs','flags','large','frags','receivers','pack','newsIntel','walletProfiles','clusters','riskScore',
    'ammIntel','intelBrief','offers','floorAnalysis','blackbox','coordination','discovery','discoveryInbox','richlistUniverse',
    'holderDominance','behavioralClusters','dailyTone','relatedOffers','txScanCoverage','seal','morningStoryReport',
    'structuredReport','newsDiagnostics','newsHealth','patternMemory','walletMemory'
  ];
  var DOM_RESTORE_IDS = [
    'bundleBox','flagsBox','report4k','mainReport','agentBox','masterPaste','briefBox','sealJson',
    'sealReportId','sealScanId','sealPublicHash','sealFullHash','sealMasterHash'
  ];

  function captureStableReport() {
    var hasStable = false;
    try { hasStable = !!(state && state.pack && (state.seal || document.body.classList.contains('sealed'))); } catch (_) {}
    if (!hasStable) return null;
    var snap = { state: {}, dom: {}, bodySealed: false };
    STATE_RESTORE_KEYS.forEach(function (k) {
      try { if (Object.prototype.hasOwnProperty.call(state, k)) snap.state[k] = state[k]; } catch (_) {}
    });
    DOM_RESTORE_IDS.forEach(function (id) {
      try {
        var el = document.getElementById(id);
        if (el) snap.dom[id] = el.textContent;
      } catch (_) {}
    });
    try { snap.bodySealed = document.body.classList.contains('sealed'); } catch (_) {}
    return snap;
  }

  function restoreStableReport(snap) {
    if (!snap) return false;
    STATE_RESTORE_KEYS.forEach(function (k) {
      try { if (Object.prototype.hasOwnProperty.call(snap.state, k)) state[k] = snap.state[k]; } catch (_) {}
    });
    DOM_RESTORE_IDS.forEach(function (id) {
      try {
        if (!Object.prototype.hasOwnProperty.call(snap.dom, id)) return;
        var el = document.getElementById(id);
        if (el) el.textContent = snap.dom[id];
      } catch (_) {}
    });
    try {
      document.body.classList.remove('scanning','building','error');
      document.body.classList.add('sealed');
    } catch (_) {}
    try { if (typeof window.renderDashboardV1 === 'function') window.renderDashboardV1(); } catch (_) {}
    logSafe('rescan failed; prior sealed report/state restored. Failure remains in the error log.');
    return true;
  }

  function installFailedRescanPreservation() {
    var fn = window.run;
    if (typeof fn !== 'function') return false;
    var btn = null;
    try { btn = document.getElementById('scanBtn'); } catch (_) {}
    if (fn._swPreservePriorSeal20260909) {
      // Later historical patches sometimes rebind #scanBtn.onclick after they
      // replace run(). Keep the actual click path on the protected wrapper.
      try {
        if (btn && typeof btn.onclick === 'function' && !btn.onclick._swPreservePriorSeal20260909) btn.onclick = fn;
      } catch (_) {}
      return true;
    }
    var wrapped = async function () {
      try { await loadCommittedPromotions(); } catch (_) {}
      var snap = captureStableReport();
      var out;
      try { out = await fn.apply(this, arguments); }
      finally {
        try {
          if (snap && document.body.classList.contains('error')) restoreStableReport(snap);
        } catch (e) { errorSafe('restore failed rescan', e); }
      }
      return out;
    };
    wrapped._swPreservePriorSeal20260909 = true;
    wrapped._swOriginal = fn;
    wrapped._original = fn._original || fn;
    window.run = wrapped;
    try { if (btn) btn.onclick = wrapped; } catch (_) {}
    return true;
  }

  function installSealHook() {
    try {
      var B = window.SHADOW_EVENT_BUS;
      if (!B || typeof B.on !== 'function') return false;
      if (window.__SW_LIVE_PROMOTION_SEAL_HOOK_20260909) return true;
      window.__SW_LIVE_PROMOTION_SEAL_HOOK_20260909 = true;
      B.on('shadow.report.sealed', function (data) {
        // buildEvidenceSeal can emit before the final report UI has finished.
        // Wait for the run's final SEALED state; if the run later errors, do
        // nothing. GitHub/network work never enters the report critical path.
        var attempts = 0;
        (function waitForSuccessfulRun() {
          attempts++;
          try {
            if (document.body.classList.contains('error')) return;
            if (document.body.classList.contains('sealed')) {
              promoteCanonicalAdds(data).catch(function (e) { errorSafe('seal promotion', e); });
              return;
            }
          } catch (_) {}
          if (attempts < 40) setTimeout(waitForSuccessfulRun, 250);
        })();
      });
      return true;
    } catch (_) { return false; }
  }

  function install() {
    installExportTruth();
    installMorningCountTruth();
    installFailedRescanPreservation();
    installSealHook();
  }

  // Load committed promotions before the operator can reasonably start the next
  // scan, and keep the runtime hooks installed even if a historical late patch
  // replaces run/buildMorningStoryText during boot.
  loadCommittedPromotions().catch(function () {});
  install();
  var tries = 0;
  var timer = setInterval(function () {
    tries++;
    install();
    if (tries >= 60) clearInterval(timer);
  }, 250);

  window.SW_LIVE_WATCHLIST_PROMOTION = {
    version: VERSION,
    read_only_xrpl: true,
    promotion_file: PROMOTION_FILE,
    loadCommittedPromotions: loadCommittedPromotions,
    mergePromotion: mergePromotion,
    canonicalAdditions: canonicalAdditions,
    promoteCanonicalAdds: promoteCanonicalAdds,
    candidateCountLine: candidateCountLine,
    captureStableReport: captureStableReport,
    restoreStableReport: restoreStableReport,
    install: install
  };
})();
