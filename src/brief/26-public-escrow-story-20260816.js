/* ═══════════════════════════════════════════════════════════════════
   SHADOW WATCH — PUBLIC RIPPLE ESCROW STORY LAYER
   2026-08-16

   Presentation only. Adds the validated current Ripple escrow position and
   recent Ripple escrow activity to the General Public Morning Report.
   Never substitutes a partial current-position sum for a complete figure.
   No scanner, XRPL-write, watchlist, signing, or trading behavior changes.
   ═══════════════════════════════════════════════════════════════════ */
(function () {
  'use strict';

  var VERSION = '2026.08.16.1';
  var HEADING = 'Escrow Watch';

  function stateRef() {
    try { if (typeof state !== 'undefined' && state) return state; } catch (_) {}
    try { if (window.__SHADOWWATCH_STATE__) return window.__SHADOWWATCH_STATE__; } catch (_) {}
    try { if (window.state) return window.state; } catch (_) {}
    return null;
  }

  function registry() {
    try { return window.SW_RIPPLE_ESCROW_REGISTRY || null; } catch (_) { return null; }
  }

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
    var ms = lookbackMs();
    var cutoff = Date.now() - ms;
    var releases = 0, locks = 0, released = 0, locked = 0;
    rows.forEach(function (e) {
      if (!e || Number(e.ts || 0) < cutoff || !isRippleOwner(e.owner)) return;
      if (e.type === 'UNLOCK') { releases++; released += Number(e.xrp || 0); }
      else if (e.type === 'LOCK') { locks++; locked += Number(e.xrp || 0); }
    });
    return { lookback_h: Math.round(ms / 3600000), releases: releases, locks: locks, released_xrp: released, locked_xrp: locked };
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

  function sectionText() {
    var p = position();
    var r = recentRipple();
    var lines = [HEADING, '────────────'];

    if (p && p.complete && p.locked_xrp != null) {
      lines.push('Ripple escrow: ' + compactXrp(p.locked_xrp) + ' XRP locked now across ' + Number(p.active_objects || 0).toLocaleString() + ' active validated-ledger escrow objects · coverage ' + Number(p.answered_owners || 0) + '/' + Number(p.expected_owners || 20) + ' public owners.');
    } else if (p && (p.status === 'PARTIAL' || p.status === 'FAILED')) {
      lines.push('Ripple escrow: current-position verification incomplete this run (' + Number(p.answered_owners || 0) + '/' + Number(p.expected_owners || 20) + ' public owners); locked amount withheld rather than publishing a partial total.');
    } else {
      lines.push('Ripple escrow: current locked inventory was not verified in time for this report; locked amount withheld.');
    }

    lines.push('Last ' + r.lookback_h + 'h: ' + r.releases + ' release' + (r.releases === 1 ? '' : 's') + ' · ' + r.locks + ' new lock' + (r.locks === 1 ? '' : 's') + '.');
    lines.push('Current locked inventory and recent escrow activity are separate measurements.');
    return lines.join('\n');
  }

  function inject(text) {
    text = String(text || '');
    if (!text || text.indexOf('\n' + HEADING + '\n') >= 0 || text.indexOf(HEADING + '\n────────────') >= 0) return text;

    var block = '\n\n' + sectionText() + '\n';
    var anchors = ['\nUnder the Surface\n', '\nWhat To Watch Next\n', '\nVerdict\n', '\nLEDGER DIAGNOSTICS\n'];
    for (var i = 0; i < anchors.length; i++) {
      var at = text.indexOf(anchors[i]);
      if (at >= 0) return text.slice(0, at) + block + text.slice(at);
    }
    return text + block;
  }

  function install() {
    if (window.SW_PUBLIC_ESCROW_STORY_20260816 && window.SW_PUBLIC_ESCROW_STORY_20260816.installed) return true;
    if (typeof window.buildMorningStoryText !== 'function' && typeof buildMorningStoryText !== 'function') return false;

    var original = null;
    try { original = window.buildMorningStoryText || buildMorningStoryText; } catch (_) {}
    if (typeof original !== 'function') return false;
    if (original._swPublicEscrowStory20260816) return true;

    var wrapped = function () {
      var out = original.apply(this, arguments);
      try { return inject(out); } catch (_) { return out; }
    };
    wrapped._swPublicEscrowStory20260816 = true;
    wrapped._swPublicLayers20260816 = original._swPublicLayers20260816 === true;
    wrapped._swOriginal = original;

    try { window.buildMorningStoryText = wrapped; } catch (_) {}
    try { buildMorningStoryText = wrapped; } catch (_) {}

    window.SW_PUBLIC_ESCROW_STORY_20260816 = {
      installed: true,
      version: VERSION,
      presentation_only: true,
      inject: inject,
      section: sectionText
    };
    return true;
  }

  if (!install()) {
    var tries = 0;
    var timer = setInterval(function () {
      tries++;
      if (install() || tries > 120) clearInterval(timer);
    }, 100);
  }
})();
