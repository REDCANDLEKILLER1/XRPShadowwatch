/* ═══════════════════════════════════════════════════════════════════════════
   2026-08-14 REPORT CORRECTNESS HOTFIX

   Repairs from SW-20260814-FCZVX and verification run SW-20260814-FEUHP:
   1) Section 19 never recommends a wallet already on the shared roster.
   2) Generic XRPL escrow activity is not labelled as Ripple activity.
   3) Public proper nouns and list joins remain readable.
   4) GDELT transport failure is a news-source diagnostic, not an app ERROR,
      and cannot leave source_status.gdelt='OK'.
   5) A first-device scan never prints a zero wallet delta when no baseline exists.
   6) Source footers use the full news pool so XRP headlines are not displaced by
      unrelated BTC/ETH backfill merely because top_headlines was capped early.

   Read-only. No auto-add. No XRPL mutation.
   ═══════════════════════════════════════════════════════════════════════════ */
(function () {
  'use strict';

  var PATCH_VERSION = '2026.08.14.2';
  var gdeltTransportFailed = false;

  function watched(addr) {
    if (!addr) return false;
    try { if (typeof KNOWN !== 'undefined' && KNOWN && KNOWN[addr]) return true; } catch (_) {}
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

  function baseline(pack) {
    try { if (typeof deltaBaseline === 'function') return deltaBaseline(pack || {}); } catch (_) {}
    var p = pack || {};
    var ws = Array.isArray(p.wallets) && p.wallets.length ? p.wallets : (Array.isArray(p.wallet_results) ? p.wallet_results : []);
    var checked = ws.filter(function (w) { return w && (w.status === 'CHECKED' || w.status == null); });
    var measured = checked.filter(function (w) { return w.prev_balance_xrp !== null && w.prev_balance_xrp !== undefined; });
    return { none: checked.length > 0 && measured.length === 0, partial: measured.length > 0 && measured.length < checked.length,
             measured: measured.length, checked: checked.length };
  }

  function cleanText(text) {
    return String(text == null ? '' : text)
      .replace(/\bmorgan Stanley\b/g, 'Morgan Stanley')
      .replace(/\+\s+\+(\d+\s+more)/g, '+$1');
  }

  function repairBaselineText(text, pack) {
    var out = cleanText(text);
    var db = baseline(pack);
    if (!db.none) return out;
    out = out.replace(/Net watchlist balance delta:\s*[^\n]+/g,
      'Net watchlist balance delta: NOT MEASURABLE — no prior balance baseline on this device');
    out = out.replace(/NET_WATCHLIST_DELTA_XRP=[^\n]+/g,
      'NET_WATCHLIST_DELTA_XRP=NOT_MEASURABLE');
    out = out.replace(/Price is soft, but wallet deltas are not dead\. The next tell is whether inflows continue or reverse into exchange-side sell pressure\./g,
      'Price is soft; wallet balance direction is not measurable on this first scan. The next tell is whether the next pass establishes a directional balance change.');
    out = out.replace(/and the wallet board was relatively quiet\./g,
      'and wallet balance direction is not measurable on this device yet.');
    return out;
  }

  function gdeltHistory() {
    try {
      if (typeof getNewsDoctorHistory !== 'function') return null;
      var h = getNewsDoctorHistory() || {};
      return h.GDELT || h.gdelt || null;
    } catch (_) { return null; }
  }

  function gdeltFailedNow() {
    if (gdeltTransportFailed) return true;
    try {
      var d = (typeof state !== 'undefined' && state.newsDiagnostics && state.newsDiagnostics.providers) ? state.newsDiagnostics.providers.GDELT : null;
      if (d && (d.transport_ok === false || /FAILED|HTTP_ERROR|TRANSPORT_FAILED/i.test(String(d.overall_status || d.status || d.failure_class || '')))) return true;
    } catch (_) {}
    var h = gdeltHistory();
    return !!(h && Number(h.consecutive_failures || 0) > 0);
  }

  try {
    var BR = window.SHADOW_BUILDER_RECS;
    if (BR && !BR._sw20260814Deduped) {
      var origAdd = typeof BR.add === 'function' ? BR.add.bind(BR) : null;
      var origGetAll = typeof BR.getAll === 'function' ? BR.getAll.bind(BR) : null;
      var origExport = typeof BR.exportJSON === 'function' ? BR.exportJSON.bind(BR) : null;
      if (origAdd) BR.add = function (rec) { return (rec && watched(rec.address)) ? false : origAdd(rec); };
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
        } finally { EC.cards = all; }
      };
      BR2._sw20260814Deduped = true;
    }
  } catch (_) {}

  function neutralizeEscrowText(text) {
    return cleanText(text)
      .replace(/Ripple escrow movement detected\. This is treasury \/ supply movement, not a buy, sell, or trade signal\./g,
        'XRPL escrow activity detected. Escrow creation or release is on-ledger movement, not by itself a buy, sell, or trade signal.')
      .replace(/No Ripple escrow unlocks or locks detected/g, 'No XRPL escrow unlocks or locks detected');
  }

  try {
    if (typeof buildEscrowWatchSection === 'function' && !buildEscrowWatchSection._sw20260814Wrapped) {
      var origEscrowSection = buildEscrowWatchSection;
      buildEscrowWatchSection = function () { return neutralizeEscrowText(origEscrowSection.apply(this, arguments)); };
      buildEscrowWatchSection._sw20260814Wrapped = true;
    }
  } catch (_) {}

  try {
    if (typeof buildEscrowNarrative === 'function' && !buildEscrowNarrative._sw20260814Wrapped) {
      var origEscrowNarrative = buildEscrowNarrative;
      buildEscrowNarrative = function () { return neutralizeEscrowText(origEscrowNarrative.apply(this, arguments)); };
      buildEscrowNarrative._sw20260814Wrapped = true;
    }
  } catch (_) {}

  try {
    if (typeof window._humanizePublicText === 'function' && !window._humanizePublicText._sw20260814Wrapped) {
      var origHumanize = window._humanizePublicText;
      window._humanizePublicText = function () { return cleanText(origHumanize.apply(this, arguments)); };
      window._humanizePublicText._sw20260814Wrapped = true;
    }
  } catch (_) {}

  try {
    if (typeof buildMorningStoryText === 'function' && !buildMorningStoryText._sw20260814Wrapped) {
      var origMorningStory = buildMorningStoryText;
      buildMorningStoryText = function (pack) { return repairBaselineText(origMorningStory.apply(this, arguments), pack); };
      buildMorningStoryText._sw20260814Wrapped = true;
    }
  } catch (_) {}

  try {
    if (typeof elog === 'function' && !elog._sw20260814GdeltWrapped) {
      var origElog = elog;
      elog = function (label, err) {
        var s = String(label || '');
        if (/^GDELT failed:/i.test(s)) {
          gdeltTransportFailed = true;
          try { if (typeof log === 'function') log('NEWS SOURCE DEGRADED: ' + s + (err ? ': ' + (err.message || err) : '')); } catch (_) {}
          return;
        }
        return origElog.apply(this, arguments);
      };
      elog._sw20260814GdeltWrapped = true;
    }
  } catch (_) {}

  try {
    if (typeof fetchGdelt === 'function' && !fetchGdelt._sw20260814Wrapped) {
      var origFetchGdelt = fetchGdelt;
      fetchGdelt = async function () {
        gdeltTransportFailed = false;
        var out = await origFetchGdelt.apply(this, arguments);
        if (gdeltTransportFailed) throw new Error('GDELT transport failed; see News Source Strategy');
        return out;
      };
      fetchGdelt._sw20260814Wrapped = true;
      // Audit finding C: expose the wrapped original under the repo-wide name so
      // unwrap-and-inspect tooling reaches the real implementation, not this shim.
      fetchGdelt._original = origFetchGdelt._original || origFetchGdelt;
    }
  } catch (_) {}

  try {
    if (typeof _routerSourceLimits === 'function' && !_routerSourceLimits._sw20260814Wrapped) {
      var origRouterLimits = _routerSourceLimits;
      _routerSourceLimits = function () {
        var out = origRouterLimits.apply(this, arguments) || [];
        if (gdeltFailedNow() && out.length === 1 && /every configured source answered/i.test(String(out[0]))) {
          return ['GDELT: unavailable this run; external news coverage is partial, while RSS/Google News remain usable.'];
        }
        return out;
      };
      _routerSourceLimits._sw20260814Wrapped = true;
    }
  } catch (_) {}

  try {
    if (typeof buildNewsRouteDiagnostics === 'function' && !buildNewsRouteDiagnostics._sw20260814Wrapped) {
      var origNewsDiag = buildNewsRouteDiagnostics;
      buildNewsRouteDiagnostics = function () {
        var out = origNewsDiag.apply(this, arguments);
        try {
          var ps = out && out.providers ? out.providers : {};
          var g = ps.GDELT || ps.gdelt;
          if (g && g.transport_ok === false) out.degraded = true;
        } catch (_) {}
        return out;
      };
      buildNewsRouteDiagnostics._sw20260814Wrapped = true;
    }
  } catch (_) {}

  try {
    if (typeof buildPublicReport === 'function' && !buildPublicReport._sw20260814Wrapped) {
      var origPublic = buildPublicReport;
      buildPublicReport = function (pack) { return repairBaselineText(origPublic.apply(this, arguments), pack); };
      buildPublicReport._sw20260814Wrapped = true;
    }
  } catch (_) {}

  try {
    if (typeof buildMasterPaste === 'function' && !buildMasterPaste._sw20260814Wrapped) {
      var origMaster = buildMasterPaste;
      buildMasterPaste = function (pack) { return repairBaselineText(origMaster.apply(this, arguments), pack); };
      buildMasterPaste._sw20260814Wrapped = true;
    }
  } catch (_) {}

  try {
    if (typeof verdictSection === 'function' && !verdictSection._sw20260814Wrapped) {
      var origVerdict = verdictSection;
      verdictSection = function (pack) {
        var out = origVerdict.apply(this, arguments);
        if (baseline(pack).none && Array.isArray(out) && out.length > 1) {
          out[1] = String(out[1]).replace(/\.\s+.*$/,
            '. Price direction is measured; wallet balance direction is not measurable on this first scan. The next pass establishes the balance baseline.');
        }
        return out;
      };
      verdictSection._sw20260814Wrapped = true;
    }
  } catch (_) {}

  try {
    if (typeof missionDebrief === 'function' && !missionDebrief._sw20260814Wrapped) {
      var origDebrief = missionDebrief;
      missionDebrief = function (buckets, pack) {
        if (!baseline(pack).none) return cleanText(origDebrief.apply(this, arguments));
        var p = pack || {};
        var d = p.xrp_delta_24h_pct;
        var pq = d == null ? 'unmeasured' : d < -1 ? 'soft' : d > 1 ? 'firm' : 'flat';
        var lt = Array.isArray(p.large_transfers) ? p.large_transfers.length : 0;
        var sv = Number(p.shadow_volume_xrp || 0);
        var s = 'Plain talk: XRP price is ' + pq + '. Wallet balance direction is not measurable on this device yet.';
        if (lt > 0) s += ' Activity was not quiet: ' + lt + ' transfers above threshold moved ' + (typeof fmt === 'function' ? fmt(sv, 0) : Math.round(sv).toLocaleString()) + ' XRP.';
        s += Number(p.xrpl_evm_dex_volume_24h_usd || 0) > 100000 ? ' The EVM bridge saw active flow.' : ' The EVM bridge stayed quiet.';
        return cleanText(s);
      };
      missionDebrief._sw20260814Wrapped = true;
    }
  } catch (_) {}

  try {
    if (typeof buildXRPMainReport === 'function' && !buildXRPMainReport._sw20260814Wrapped) {
      var origMainReport = buildXRPMainReport;
      buildXRPMainReport = function (pack) { return repairBaselineText(origMainReport.apply(this, arguments), pack); };
      buildXRPMainReport._sw20260814Wrapped = true;
    }
  } catch (_) {}

  try {
    if (typeof getNewsSources === 'function' && !getNewsSources._sw20260814Wrapped) {
      var origGetNewsSources = getNewsSources;
      getNewsSources = function (pack) {
        try {
          var p = pack || (typeof state !== 'undefined' ? state.pack : null) || {};
          var ni = p.news_intel || (typeof state !== 'undefined' ? state.newsIntel : null) || {};
          if (Array.isArray(ni.items) && ni.items.length) return ni.items;
        } catch (_) {}
        return origGetNewsSources.apply(this, arguments);
      };
      getNewsSources._sw20260814Wrapped = true;
      try { window.getNewsSources = getNewsSources; } catch (_) {}
    }
  } catch (_) {}

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
          for (var i = 0; i < WATCHLIST.length; i++) if (WATCHLIST[i] && WATCHLIST[i].address === addr) WATCHLIST[i].cat = cats[addr];
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
    gdelt_status_guard: true,
    first_scan_delta_guard: true,
    source_pool_guard: true,
    expected_effective_watch_count: (function () {
      try { return window.SW_HVT_ROSTER && window.SW_HVT_ROSTER.targets ? window.SW_HVT_ROSTER.targets.length : null; }
      catch (_) { return null; }
    })()
  };
})();
