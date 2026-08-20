/* ═══════════════════════════════════════════════════════════════════════════
   NA2TM ACCEPTANCE CLEANUP — 2026-08-20

   Small late-runtime cleanup from the combined PR #28 acceptance run:
   1) Permanently promote the one wallet SW-20260820-NA2TM marked ADD.
   2) Repair two presentation-only text artifacts exposed by that run.

   XRPL behavior remains read-only. No scanner, evidence, discovery scoring,
   transaction math, signing, submit, trading, or payout behavior is changed.
   ═══════════════════════════════════════════════════════════════════════════ */
(function () {
  'use strict';

  var VERSION = '2026.08.20.1';
  var PROMOTION = {
    address: 'rDT9vb8Jd9USHfWFh5nEhpwfJD3DbjXn88',
    label: 'LARGE_RECV_rDT9vb',
    cat: 'discovered_receiver',
    source_report: 'SW-20260820-NA2TM'
  };

  function promoteWallet() {
    var a = PROMOTION.address;
    try {
      var already = (typeof WATCHLIST !== 'undefined' && Array.isArray(WATCHLIST))
        ? WATCHLIST.some(function (w) { return w && w.address === a; }) : false;
      if (!already && typeof addDiscoveredWallet === 'function') {
        addDiscoveredWallet(a, PROMOTION.label, null, PROMOTION.cat);
      } else if (!already && typeof WATCHLIST !== 'undefined' && Array.isArray(WATCHLIST)) {
        WATCHLIST.push({ label: PROMOTION.label, address: a, cat: PROMOTION.cat });
      }
      if (typeof KNOWN !== 'undefined' && KNOWN) {
        if (!KNOWN[a]) KNOWN[a] = { label: PROMOTION.label, address: a, cat: PROMOTION.cat };
        else KNOWN[a].cat = PROMOTION.cat;
      }
    } catch (_) {}

    try {
      var R = window.SW_HVT_ROSTER;
      if (R && Array.isArray(R.targets) && !R.targets.some(function (t) { return t && t.address === a; })) {
        R.targets.push({
          address: a,
          label: PROMOTION.label,
          handle: PROMOTION.label,
          type: 'HVT',
          cat: PROMOTION.cat,
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
    return true;
  }

  function cleanStoryText(text) {
    var out = String(text == null ? '' : text);
    out = out.replace(
      'Transfer classifications are ; movement does not prove intent.',
      'These classifications describe observed movement only; they do not prove intent.'
    );
    out = out.replace(/, and why Is XRP\b/g, ', and Why Is XRP');
    return out;
  }

  function installStoryCleanup() {
    var fn = null;
    try { fn = window.buildMorningStoryText; } catch (_) {}
    if (typeof fn !== 'function') return false;
    if (fn._swNa2tmAcceptance20260820) return true;

    var wrapped = function () {
      return cleanStoryText(fn.apply(this, arguments));
    };
    wrapped._swNa2tmAcceptance20260820 = true;
    wrapped._swOriginal = fn;
    try { window.buildMorningStoryText = wrapped; } catch (_) { return false; }
    return true;
  }

  promoteWallet();
  installStoryCleanup();

  // The V1 pipeline installs asynchronously. Re-assert this tiny final wrapper
  // if a later hook replaces buildMorningStoryText during boot.
  var tries = 0;
  var timer = setInterval(function () {
    tries++;
    promoteWallet();
    installStoryCleanup();
    if (tries >= 40) clearInterval(timer);
  }, 200);

  window.SW_NA2TM_ACCEPTANCE_20260820 = {
    version: VERSION,
    read_only: true,
    promoted_address: PROMOTION.address,
    source_report: PROMOTION.source_report,
    scanner_changed: false,
    evidence_changed: false,
    discovery_scoring_changed: false,
    cleanStoryText: cleanStoryText,
    promoteWallet: promoteWallet
  };
})();
