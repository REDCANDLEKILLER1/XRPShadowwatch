/* ═══════════════════════════════════════════════════════════════════
   SHADOW WATCH — PUBLIC RIPPLE ESCROW REPORT LAYER
   2026-08-16

   Presentation only. Keeps the validated current Ripple escrow position in
   both the General Public Morning Report and the structured daily report.
   Re-wraps if a later legacy presentation script replaces either builder.
   Never publishes a partial current-position sum as a complete figure.
   ═══════════════════════════════════════════════════════════════════ */
(function () {
  'use strict';

  var VERSION = '2026.08.16.2';
  var HEADING = 'Escrow Watch';

  function stateRef() {
    try { if (typeof state !== 'undefined' && state) return state; } catch (_) {}
    try { if (window.__SHADOWWATCH_STATE__) return window.__SHADOWWATCH_STATE__; } catch (_) {}
    try { if (window.state) return window.state; } catch (_) { return null; }
    return null;
  }
  function registry() { try { return window.SW_RIPPLE_ESCROW_REGISTRY || null; } catch (_) { return null; } }
  function isRippleOwner(address) {
    var r = registry();
    return !!(address && r && r.by_address && r.by_address[address]);
  }
  function lookbackMs() {
    try { if (typeof escrowLookbackMs === 'function') return Number(escrowLookbackMs()) || 0; } catch (_) {}
    try { if (typeof window.escrowLookbackMs === 'function') return Number(window.escrowLookbackMs()) || 0; } catch (_) {}
    var day = new Date().getUTCDay();
    return ((day === 6 || day === 0 || day === 1) ? 96 : 36) * 3600000;
  }
  function recentRipple() {
    var s = stateRef();
    var rows = s && Array.isArray(s.escrow) ? s.escrow : [];
    var ms = lookbackMs(), cutoff = Date.now() - ms;
    var releases = 0, locks = 0, released = 0, locked = 0;
    rows.forEach(function (e) {
      if (!e || Number(e.ts || 0) < cutoff || !isRippleOwner(e.owner)) return;
      if (e.type === 'UNLOCK') { releases++; released += Number(e.xrp || 0); }
      else if (e.type === 'LOCK') { locks++; locked += Number(e.xrp || 0); }
    });
    return { lookback_h:Math.round(ms/3600000), releases:releases, locks:locks, released_xrp:released, locked_xrp:locked };
  }
  // ── NON-RIPPLE ESCROW, GROUPED BY OWNER ──────────────────────────────────
  // The Morning Story reported ONLY Ripple's recent activity, so on
  // SW-20260831-4VF0C it said "Last 96h: 0 releases · 0 new locks" while four
  // EscrowCreates totalling 40M XRP happened on a non-Ripple owner
  // (rfkXSaCZKTg1EZzec2rLDyrWHxRVJdtVXj, labelled "Flare Core Vault"). Ripple's
  // 0/0 was true; the report was not, because a listener hears "nothing was
  // locked". The structured report already separated these correctly — only the
  // Morning Story collapsed them.
  //
  // Grouped by OWNER, because "owner wallets" and "escrow ledger objects" are
  // different measurements and had been blurring into each other.
  function ownerName(addr) {
    try {
      if (typeof _swWho === 'function') return _swWho(addr, null, { bare: true });
    } catch (_) {}
    var a = String(addr || '');
    return a.length > 14 ? (a.slice(0, 6) + '\u2026' + a.slice(-4)) : (a || 'an unidentified owner');
  }
  function recentOther() {
    var s = stateRef();
    var rows = s && Array.isArray(s.escrow) ? s.escrow : [];
    var ms = lookbackMs(), cutoff = Date.now() - ms;
    var byOwner = {};
    rows.forEach(function (e) {
      if (!e || Number(e.ts || 0) < cutoff || isRippleOwner(e.owner)) return;
      var k = String(e.owner || 'unknown');
      if (!byOwner[k]) byOwner[k] = { owner: k, releases: 0, locks: 0, released: 0, locked: 0 };
      var g = byOwner[k];
      if (e.type === 'UNLOCK') { g.releases++; g.released += Number(e.xrp || 0); }
      else if (e.type === 'LOCK') { g.locks++; g.locked += Number(e.xrp || 0); }
    });
    var groups = Object.keys(byOwner).map(function (k) { return byOwner[k]; })
      .filter(function (g) { return g.locks || g.releases; })
      .sort(function (a, b) { return (b.locked + b.released) - (a.locked + a.released); });
    return {
      lookback_h: Math.round(ms / 3600000),
      groups: groups,
      owners: groups.length,
      releases: groups.reduce(function (x, g) { return x + g.releases; }, 0),
      locks:    groups.reduce(function (x, g) { return x + g.locks; }, 0),
      released_xrp: groups.reduce(function (x, g) { return x + g.released; }, 0),
      locked_xrp:   groups.reduce(function (x, g) { return x + g.locked; }, 0)
    };
  }

  function position() {
    var s = stateRef();
    try {
      if (s && s.rippleEscrowPosition) return s.rippleEscrowPosition;
      var api = window.SW_RIPPLE_ESCROW_POSITION_20260816;
      if (api && typeof api.get === 'function') return api.get();
    } catch (_) {}
    return null;
  }
  function compactXrp(n) {
    n = Number(n || 0);
    if (n >= 1e9) return (n / 1e9).toFixed(2) + 'B';
    if (n >= 1e6) return (n / 1e6).toFixed(2) + 'M';
    if (n >= 1e3) return (n / 1e3).toFixed(1) + 'K';
    return Math.round(n).toLocaleString();
  }

  function positionSentence() {
    var p = position();
    if (p && p.complete && p.locked_xrp != null) {
      return 'Ripple escrow: ' + compactXrp(p.locked_xrp) + ' XRP locked now across ' + Number(p.active_objects || 0).toLocaleString() + ' active validated-ledger escrow objects · coverage ' + Number(p.answered_owners || 0) + '/' + Number(p.expected_owners || 20) + ' public owners.';
    }
    if (p && (p.status === 'PARTIAL' || p.status === 'FAILED')) {
      return 'Ripple escrow: current-position verification incomplete this run (' + Number(p.answered_owners || 0) + '/' + Number(p.expected_owners || 20) + ' public owners); locked amount withheld rather than publishing a partial total.';
    }
    return 'Ripple escrow: current locked inventory was not verified in time for this report; locked amount withheld.';
  }
  function sectionText() {
    var r = recentRipple();
    var o = recentOther();
    var lines = [
      HEADING,
      '────────────',
      positionSentence(),
      // "Last 96h" alone read as the whole ledger's escrow activity. Say whose.
      'Ripple, last ' + r.lookback_h + 'h: ' + r.releases + ' release' + (r.releases === 1 ? '' : 's') +
        ' · ' + r.locks + ' new lock' + (r.locks === 1 ? '' : 's') + '.'
    ];
    if (o.groups.length) {
      lines.push('Other XRPL escrow, last ' + o.lookback_h + 'h: ' +
        o.locks + ' new lock' + (o.locks === 1 ? '' : 's') +
        (o.locked_xrp ? ' totalling ' + compactXrp(o.locked_xrp) + ' XRP' : '') +
        ' · ' + o.releases + ' release' + (o.releases === 1 ? '' : 's') +
        (o.released_xrp ? ' totalling ' + compactXrp(o.released_xrp) + ' XRP' : '') +
        ', across ' + o.owners + ' owner wallet' + (o.owners === 1 ? '' : 's') + '.');
      o.groups.slice(0, 3).forEach(function (g) {
        lines.push('• ' + ownerName(g.owner) + ': ' +
          (g.locks ? g.locks + ' lock' + (g.locks === 1 ? '' : 's') + ' ' + compactXrp(g.locked) + ' XRP' : '') +
          (g.locks && g.releases ? ' · ' : '') +
          (g.releases ? g.releases + ' release' + (g.releases === 1 ? '' : 's') + ' ' + compactXrp(g.released) + ' XRP' : ''));
      });
    } else {
      lines.push('Other XRPL escrow, last ' + o.lookback_h + 'h: none detected in scanned scope.');
    }
    // Three separate measurements that had been blurring together, plus the
    // scope limit: this is the escrow this scan observed, not the whole XRPL.
    lines.push('Ripple and non-Ripple escrow are separate. Active escrow objects are ledger objects, not owner wallets. Scope is escrow observed by this scan, not every escrow on the XRPL.');
    return lines.join('\n');
  }

  function injectStory(text) {
    var out = String(text || '');
    if (!out) return out;
    // Refresh an older injected Escrow Watch block instead of duplicating it.
    // Must match the block this module CURRENTLY emits, or a re-inject appends a
    // second Escrow Watch instead of refreshing the first.
    var existing = /\nEscrow Watch\n────────────\n[\s\S]*?(?:Current locked inventory and recent escrow activity are separate measurements\.|not every escrow on the XRPL\.)\n?/;
    if (existing.test(out)) return out.replace(existing, '\n' + sectionText() + '\n');
    var block = '\n\n' + sectionText() + '\n';
    var anchors = ['\nUnder the Surface\n', '\nWhat To Watch Next\n', '\nVerdict\n', '\nLEDGER DIAGNOSTICS\n'];
    for (var i = 0; i < anchors.length; i++) {
      var at = out.indexOf(anchors[i]);
      if (at >= 0) return out.slice(0, at) + block + out.slice(at);
    }
    return out + block;
  }

  function structuredPositionBlock() {
    var p = position();
    var lines = ['RIPPLE ESCROW — CURRENT POSITION'];
    if (p && p.complete && p.locked_xrp != null) {
      lines.push('- XRP locked now: ' + compactXrp(p.locked_xrp) + ' XRP');
      lines.push('- Active escrow objects: ' + Number(p.active_objects || 0).toLocaleString());
      lines.push('- Coverage: ' + Number(p.answered_owners || 0) + '/' + Number(p.expected_owners || 20) + ' published Ripple escrow owners');
      lines.push('- Validated ledger: ' + (p.ledger_index || 'verified')); 
    } else if (p) {
      lines.push('- Current locked inventory: WITHHELD — verification incomplete (' + Number(p.answered_owners || 0) + '/' + Number(p.expected_owners || 20) + ' owners)');
    } else {
      lines.push('- Current locked inventory: NOT AVAILABLE THIS RUN');
    }
    lines.push('- Recent activity below remains separate and must not be read as current inventory.');
    return lines.join('\n');
  }

  function injectStructured(text) {
    var out = String(text || '');
    if (!out) return out;
    var block = structuredPositionBlock();
    var re = /RIPPLE ESCROW — CURRENT POSITION\n(?:-[^\n]*\n?){1,6}/;
    if (re.test(out)) return out.replace(re, block + '\n');
    var anchor = 'ESCROWS — COFFEE & CRYPTO\n';
    if (out.indexOf(anchor) >= 0) return out.replace(anchor, anchor + '\n' + block + '\n\n');
    return out;
  }

  function currentStoryBuilder() {
    try { return window.buildMorningStoryText || (typeof buildMorningStoryText === 'function' ? buildMorningStoryText : null); } catch (_) { return null; }
  }
  function currentStructuredBuilder() {
    try { return window.buildXRPMainReport || (typeof buildXRPMainReport === 'function' ? buildXRPMainReport : null); } catch (_) { return null; }
  }
  function installStory() {
    var original = currentStoryBuilder();
    if (typeof original !== 'function') return false;
    if (original._swPublicEscrowStory20260816) return true;
    var wrapped = function () {
      var out = original.apply(this, arguments);
      try { return injectStory(out); } catch (_) { return out; }
    };
    wrapped._swPublicEscrowStory20260816 = true;
    wrapped._swOriginal = original;
    wrapped._original = original._original || original;
    try { window.buildMorningStoryText = wrapped; } catch (_) {}
    try { buildMorningStoryText = wrapped; } catch (_) {}
    return true;
  }
  function installStructured() {
    var original = currentStructuredBuilder();
    if (typeof original !== 'function') return false;
    if (original._swPublicEscrowStructured20260816) return true;
    var wrapped = function () {
      var out = original.apply(this, arguments);
      try { return injectStructured(out); } catch (_) { return out; }
    };
    wrapped._swPublicEscrowStructured20260816 = true;
    wrapped._swOriginal = original;
    wrapped._original = original._original || original;
    try { window.buildXRPMainReport = wrapped; } catch (_) {}
    try { buildXRPMainReport = wrapped; } catch (_) {}
    return true;
  }
  function install() { return { story:installStory(), structured:installStructured() }; }

  install();
  // Legacy files continue to wrap these builders late in page startup. Re-check
  // throughout startup/scan so the final active function, not merely an older
  // wrapper in the chain, carries the escrow layer.
  var tries = 0;
  var timer = setInterval(function () {
    tries++;
    install();
    if (tries > 3600) clearInterval(timer);
  }, 100);
  try {
    var bus = window.SHADOW_EVENT_BUS;
    if (bus && typeof bus.on === 'function') {
      bus.on('shadow.scan.started', install);
      bus.on('shadow.report.building', install);
      bus.on('shadow.report.sealed', install);
    }
  } catch (_) {}

  window.SW_PUBLIC_ESCROW_STORY_20260816 = {
    installed:true,
    version:VERSION,
    presentation_only:true,
    inject:injectStory,
    injectStructured:injectStructured,
    section:sectionText,
    positionBlock:structuredPositionBlock,
    reinstall:install
  };
})();
