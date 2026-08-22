/* SHADOW WATCH — RIPPLE ESCROW TERMINOLOGY CORRECTION — 2026-08-19
   Presentation-only. Keeps escrow math untouched while removing language that
   could make escrow objects look like wallets or metadata registry addresses
   look like currently active/publicized escrow wallets. */
(function () {
  'use strict';

  var VERSION = '2026.08.19.1';

  function clarify(text) {
    return String(text || '')
      .replace(/coverage\s+(\d+)\/(\d+)\s+public owners\.?/gi,
        'registry check $1/$2 known Ripple-labeled addresses.')
      .replace(/\((\d+)\/(\d+)\s+public owners\)/gi,
        '($1/$2 known Ripple-labeled registry addresses checked)')
      .replace(/- Coverage:\s+(\d+)\/(\d+)\s+published Ripple escrow owners/gi,
        '- Registry check: $1/$2 known Ripple-labeled escrow addresses queried')
      .replace(/verification incomplete \((\d+)\/(\d+)\s+owners\)/gi,
        'verification incomplete ($1/$2 known Ripple-labeled registry addresses checked)');
  }

  function currentStoryBuilder() {
    try { return window.buildMorningStoryText || (typeof buildMorningStoryText === 'function' ? buildMorningStoryText : null); }
    catch (_) { return null; }
  }

  function currentStructuredBuilder() {
    try { return window.buildXRPMainReport || (typeof buildXRPMainReport === 'function' ? buildXRPMainReport : null); }
    catch (_) { return null; }
  }

  function wrapStory() {
    var original = currentStoryBuilder();
    if (typeof original !== 'function') return false;
    if (original._swEscrowTerminology20260819) return true;
    var wrapped = function () {
      var out = original.apply(this, arguments);
      try { return clarify(out); } catch (_) { return out; }
    };
    wrapped._swEscrowTerminology20260819 = true;
    wrapped._swOriginal = original;
    wrapped._original = original._original || original;
    try { window.buildMorningStoryText = wrapped; } catch (_) {}
    try { buildMorningStoryText = wrapped; } catch (_) {}
    return true;
  }

  function wrapStructured() {
    var original = currentStructuredBuilder();
    if (typeof original !== 'function') return false;
    if (original._swEscrowTerminology20260819) return true;
    var wrapped = function () {
      var out = original.apply(this, arguments);
      try { return clarify(out); } catch (_) { return out; }
    };
    wrapped._swEscrowTerminology20260819 = true;
    wrapped._swOriginal = original;
    wrapped._original = original._original || original;
    try { window.buildXRPMainReport = wrapped; } catch (_) {}
    try { buildXRPMainReport = wrapped; } catch (_) {}
    return true;
  }

  function install() {
    return { story:wrapStory(), structured:wrapStructured() };
  }

  install();
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

  window.SW_ESCROW_TERMINOLOGY_20260819 = {
    version:VERSION,
    presentation_only:true,
    escrow_math_untouched:true,
    clarify:clarify,
    reinstall:install
  };
})();
