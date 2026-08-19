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
    return [
      HEADING,
      '────────────',
      positionSentence(),
      'Last ' + r.lookback_h + 'h: ' + r.releases + ' release' + (r.releases === 1 ? '' : 's') + ' · ' + r.locks + ' new lock' + (r.locks === 1 ? '' : 's') + '.',
      'Current locked inventory and recent escrow activity are separate measurements.'
    ].join('\n');
  }

  function injectStory(text) {
    var out = String(text || '');
    if (!out) return out;
    // Refresh an older injected Escrow Watch block instead of duplicating it.
    var existing = /\nEscrow Watch\n────────────\n[\s\S]*?Current locked inventory and recent escrow activity are separate measurements\.\n?/;
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
