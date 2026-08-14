/* ═══════════════════════════════════════════════════════════════════════════
   2026-08-14 REPORT CORRECTNESS HOTFIX

   Narrow final-layer repairs from SW-20260814-FCZVX:
   1) Section 19 must never recommend a wallet already on the shared roster.
   2) Generic XRPL escrow activity must not be labelled as Ripple activity.
   3) Preserve proper-noun capitalization for Morgan Stanley.
   4) A known GDELT recovery/probe failure belongs in news diagnostics, not the
      application ERROR LOG, and raw source_status must not say OK after failure.

   Read-only. No auto-add. No XRPL mutation. Loaded last by brief-console.html.
   ═══════════════════════════════════════════════════════════════════════════ */
(function () {
  'use strict';

  var PATCH_VERSION = '2026.08.14.1';
  var GDELT_SUPPRESS_THRESHOLD = 10;

  function watched(addr) {
    if (!addr) return false;
    try {
      if (typeof KNOWN !== 'undefined' && KNOWN && KNOWN[addr]) return true;
    } catch (_) {}
    try {
      var R = window.SW_HVT_ROSTER;
      if (R && Array.isArray(R.targets)) {
        for (var i = 0; i < R.targets.length; i++) {
          if (R.targets[i] && R.targets[i].address === addr) return true;
        }
      }
    } catch (_) {}
    return false;
  }

  function filterRecommendations(list) {
    return (Array.isArray(list) ? list : []).filter(function (r) {
      return r && r.address && !watched(r.address);
    });
  }

  // ── 1. SECTION 19 / BUILDER RECOMMENDATIONS ───────────────────────────────
  // Keep evidence cards and discovery memory intact. Only the builder ACTION
  // lane is deduped against what the two apps already watch.
  try {
    var BR = window.SHADOW_BUILDER_RECS;
    if (BR && !BR._sw20260814Deduped) {
      var origAdd = typeof BR.add === 'function' ? BR.add.bind(BR) : null;
      var origGetAll = typeof BR.getAll === 'function' ? BR.getAll.bind(BR) : null;
      var origExport = typeof BR.exportJSON === 'function' ? BR.exportJSON.bind(BR) : null;

      if (origAdd) {
        BR.add = function (rec) {
          if (rec && watched(rec.address)) return false;
          return origAdd(rec);
        };
      }
      if (origGetAll) {
        BR.getAll = function () { return filterRecommendations(origGetAll()); };
        BR.size = function () { return BR.getAll().length; };
      }
      if (origExport) {
        BR.exportJSON = function () {
          var out = origExport() || {};
          out.recommendations = filterRecommendations(out.recommendations);
          out.count = out.recommendations.length;
          out.watched_dedupe = true;
          out.dedupe_rule = 'already watched addresses are evidence, not ADD recommendations';
          return out;
        };
      }
      BR._sw20260814Deduped = true;
    }
  } catch (_) {}

  // V2 Section 19 reads helper evidence cards directly. Filter only while it
  // renders so known-wallet evidence remains available to every other subsystem.
  try {
    var BR2 = window.SHADOW_BUILDER_RECS_V2;
    if (BR2 && typeof BR2.buildSection19Text === 'function' && !BR2._sw20260814Deduped) {
      var origBuild19 = BR2.buildSection19Text.bind(BR2);
      BR2.buildSection19Text = function (pack) {
        var EC = window.SHADOW_EVIDENCE_COLLECTOR;
        if (!EC || !Array.isArray(EC.cards)) return origBuild19(pack);
        var all = EC.cards;
        try {
          EC.cards = all.filter(function (c) { return c && c.address && !watched(c.address); });
          return origBuild19(pack);
        } finally {
          EC.cards = all;
        }
      };
      BR2._sw20260814Deduped = true;
    }
  } catch (_) {}

  // ── 2. ESCROW ATTRIBUTION ────────────────────────────────────────────────
  // EscrowCreate/EscrowFinish are XRPL transaction types. They are not Ripple
  // events unless provenance separately establishes a Ripple-owned participant.
  function neutralizeEscrowText(text) {
    return String(text == null ? '' : text)
      .replace(/Ripple escrow movement detected\. This is treasury \/ supply movement, not a buy, sell, or trade signal\./g,
        'XRPL escrow activity detected. Escrow creation or release is on-ledger movement, not by itself a buy, sell, or trade signal.')
      .replace(/No Ripple escrow unlocks or locks detected/g,
        'No XRPL escrow unlocks or locks detected');
  }

  try {
    if (typeof buildEscrowWatchSection === 'function' && !buildEscrowWatchSection._sw20260814Wrapped) {
      var origEscrowSection = buildEscrowWatchSection;
      buildEscrowWatchSection = function () {
        return neutralizeEscrowText(origEscrowSection.apply(this, arguments));
      };
      buildEscrowWatchSection._sw20260814Wrapped = true;
    }
  } catch (_) {}

  try {
    if (typeof buildEscrowNarrative === 'function' && !buildEscrowNarrative._sw20260814Wrapped) {
      var origEscrowNarrative = buildEscrowNarrative;
      buildEscrowNarrative = function () {
        return neutralizeEscrowText(origEscrowNarrative.apply(this, arguments));
      };
      buildEscrowNarrative._sw20260814Wrapped = true;
    }
  } catch (_) {}

  // ── 3. PUBLIC PROPER-NOUN CLEANUP ────────────────────────────────────────
  function fixProperNouns(text) {
    return String(text == null ? '' : text).replace(/\bmorgan Stanley\b/g, 'Morgan Stanley');
  }

  try {
    if (typeof window._humanizePublicText === 'function' && !window._humanizePublicText._sw20260814Wrapped) {
      var origHumanize = window._humanizePublicText;
      window._humanizePublicText = function (text) {
        return fixProperNouns(origHumanize.apply(this, arguments));
      };
      window._humanizePublicText._sw20260814Wrapped = true;
    }
  } catch (_) {}

  // Some morning-story wrappers hold their own reference to the prior final
  // pass, so fix the final returned story as well.
  try {
    if (typeof buildMorningStoryText === 'function' && !buildMorningStoryText._sw20260814ProperNounWrapped) {
      var origMorningStory = buildMorningStoryText;
      buildMorningStoryText = function () {
        return fixProperNouns(origMorningStory.apply(this, arguments));
      };
      buildMorningStoryText._sw20260814ProperNounWrapped = true;
    }
  } catch (_) {}

  // ── 4. GDELT: DIAGNOSTIC DEGRADATION, NOT APP FAILURE ────────────────────
  function gdeltHistory() {
    try {
      if (typeof getNewsDoctorHistory !== 'function') return null;
      var h = getNewsDoctorHistory() || {};
      return h.GDELT || h.gdelt || null;
    } catch (_) { return null; }
  }

  function gdeltKnownBad() {
    var r = gdeltHistory();
    return !!(r && Number(r.consecutive_failures || 0) >= GDELT_SUPPRESS_THRESHOLD);
  }

  try {
    if (typeof elog === 'function' && !elog._sw20260814Wrapped) {
      var origElog = elog;
      elog = function (label, err) {
        var s = String(label || '');
        if (/^GDELT failed:/i.test(s) && gdeltKnownBad()) {
          try {
            if (typeof log === 'function') {
              log('NEWS SOURCE DEGRADED: ' + s + (err ? ': ' + (err.message || err) : ''));
            }
          } catch (_) {}
          return;
        }
        return origElog.apply(this, arguments);
      };
      elog._sw20260814Wrapped = true;
    }
  } catch (_) {}

  // fetchGdelt catches its own error and returns [], which makes Promise.allSettled
  // look fulfilled and historically allowed source_status.gdelt='OK'. Correct the
  // exported status from the News Doctor's actual transport history.
  try {
    if (typeof fetchNewsIntel === 'function' && !fetchNewsIntel._sw20260814Wrapped) {
      var origFetchNewsIntel = fetchNewsIntel;
      fetchNewsIntel = async function () {
        var out = await origFetchNewsIntel.apply(this, arguments);
        try {
          var intel = out || (typeof state !== 'undefined' && state.newsIntel) || null;
          var rec = gdeltHistory();
          var fails = rec ? Number(rec.consecutive_failures || 0) : 0;
          var hasGdeltItems = !!(intel && Array.isArray(intel.items) && intel.items.some(function (it) {
            var src = String((it && (it.source || it.domain)) || '').toLowerCase();
            return src.indexOf('gdelt') >= 0;
          }));
          if (intel && intel.source_status && !hasGdeltItems && fails > 0 &&
              String(intel.source_status.gdelt || '').toUpperCase() === 'OK') {
            intel.source_status.gdelt = 'FAILED';
            intel.source_status_correction = intel.source_status_correction || {};
            intel.source_status_correction.gdelt = 'News Doctor records ' + fails + ' consecutive transport failure(s); empty fulfilled promise is not success.';
          }
          if (typeof state !== 'undefined' && state.newsIntel && intel) state.newsIntel = intel;
        } catch (_) {}
        return out;
      };
      fetchNewsIntel._sw20260814Wrapped = true;
    }
  } catch (_) {}

  // The shared roster has these four as HVT to remain app-neutral. Give the
  // Report's in-memory rows their more specific behavioral category after core
  // has built KNOWN, without making any identity claim.
  try {
    var cats = {
      'rpY7bZBkA98P8zds5LdBktAKj9ifekPdkE': 'discovered_whale',
      'rU5NDVnQ6nHBvD33en6HjWipY67PJ7hcXG': 'discovered_whale',
      'rsnXj9TDwt49XxCM64YrTEnSzwcY4awZnn': 'discovered_receiver',
      'rw1xqK3TvKCZcdTcHGp6b2Q8dELnCCGFvT': 'discovered_receiver'
    };
    Object.keys(cats).forEach(function (addr) {
      try {
        if (typeof KNOWN !== 'undefined' && KNOWN && KNOWN[addr]) KNOWN[addr].cat = cats[addr];
        if (typeof WATCHLIST !== 'undefined' && Array.isArray(WATCHLIST)) {
          for (var i = 0; i < WATCHLIST.length; i++) {
            if (WATCHLIST[i] && WATCHLIST[i].address === addr) WATCHLIST[i].cat = cats[addr];
          }
        }
      } catch (_) {}
    });
  } catch (_) {}

  window.SW_REPORT_HOTFIX_20260814 = {
    version: PATCH_VERSION,
    read_only: true,
    wallet_recommendation_dedupe: true,
    escrow_attribution_guard: true,
    proper_noun_guard: true,
    gdelt_error_lane_guard: true,
    expected_effective_watch_count: (function () {
      try { return window.SW_HVT_ROSTER && window.SW_HVT_ROSTER.targets ? window.SW_HVT_ROSTER.targets.length : null; }
      catch (_) { return null; }
    })()
  };
})();
