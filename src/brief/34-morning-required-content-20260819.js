/* SHADOW WATCH — MORNING REQUIRED CONTENT GUARD — 2026-08-19
   Presentation-only repair for Issue #19.
   Restores the real daily prayer and scripture in the public Morning Story
   whenever the underlying daily-tone data is available. Scanner, pagination,
   evidence, risk scoring, XRPL calls and watchlist behavior are untouched. */
(function () {
  'use strict';

  var VERSION = '2026.08.19.1';

  function currentTone(pack) {
    var tone = null;
    try {
      if (typeof state !== 'undefined' && state && state.dailyTone) tone = state.dailyTone;
    } catch (_) {}
    if (tone && tone.prayer && tone.scripture && tone.scripture.ref && tone.scripture.text) return tone;

    try {
      if (typeof buildDailyTone === 'function') tone = buildDailyTone(pack || {});
    } catch (_) {}
    return tone || null;
  }

  function validTone(tone) {
    return !!(tone && tone.prayer && tone.scripture && tone.scripture.ref && tone.scripture.text);
  }

  function replacePrayer(out, prayer) {
    var section = /(🙏 THE DAILY PRAYER\s*\n(?:[─━═]+\s*\n)?)([\s\S]*?)(?=\n📖 THE DAILY SCRIPTURE\b)/;
    if (section.test(out)) return out.replace(section, '$1' + prayer + '\n');
    return out.replace(/\[Today[’']s prayer\s*[—-]\s*see dev panel\]/gi, prayer);
  }

  function replaceScripture(out, scripture) {
    var body = scripture.ref + '\n"' + scripture.text + '"';
    var section = /(📖 THE DAILY SCRIPTURE\s*\n(?:[─━═]+\s*\n)?)([\s\S]*?)(?=\nSources\b|\nNEWS USED:|\s*$)/;
    if (section.test(out)) return out.replace(section, '$1' + body + '\n');
    return out.replace(/\[Today[’']s scripture\s*[—-]\s*see dev panel\]/gi, body);
  }

  function insertMissingSections(out, tone) {
    var hasPrayer = /🙏 THE DAILY PRAYER\b/.test(out);
    var hasScripture = /📖 THE DAILY SCRIPTURE\b/.test(out);
    if (hasPrayer && hasScripture) return out;

    var block = '';
    if (!hasPrayer) block += '\n\n🙏 THE DAILY PRAYER\n───────────────────\n' + tone.prayer;
    if (!hasScripture) block += '\n\n📖 THE DAILY SCRIPTURE\n──────────────────────\n' + tone.scripture.ref + '\n"' + tone.scripture.text + '"';

    var sourceAt = out.search(/\nSources\b/);
    if (sourceAt >= 0) return out.slice(0, sourceAt).trimEnd() + block + '\n' + out.slice(sourceAt);
    return out.trimEnd() + block;
  }

  function restore(text, pack) {
    var out = String(text == null ? '' : text);
    var tone = currentTone(pack);
    if (!validTone(tone)) return out;

    out = replacePrayer(out, tone.prayer);
    out = replaceScripture(out, tone.scripture);
    out = insertMissingSections(out, tone);
    return out;
  }

  function install() {
    var original = null;
    try { original = window.buildMorningStoryText || (typeof buildMorningStoryText === 'function' ? buildMorningStoryText : null); } catch (_) {}
    if (typeof original !== 'function') return false;
    if (original._swMorningRequiredContent20260819) return true;

    var wrapped = function (pack) {
      var out = original.apply(this, arguments);
      try { return restore(out, pack); } catch (_) { return out; }
    };
    wrapped._swMorningRequiredContent20260819 = true;
    wrapped._swOriginal = original;

    try { window.buildMorningStoryText = wrapped; } catch (_) {}
    try { buildMorningStoryText = wrapped; } catch (_) {}
    return true;
  }

  install();
  var tries = 0;
  var timer = setInterval(function () {
    tries++;
    if (install() || tries >= 100) clearInterval(timer);
  }, 100);

  try {
    var bus = window.SHADOW_EVENT_BUS;
    if (bus && typeof bus.on === 'function') {
      bus.on('shadow.scan.started', install);
      bus.on('shadow.report.building', install);
      bus.on('shadow.report.sealed', install);
    }
  } catch (_) {}

  window.SW_MORNING_REQUIRED_CONTENT_20260819 = {
    version: VERSION,
    presentation_only: true,
    prayer_required: true,
    scripture_required: true,
    scanner_untouched: true,
    tx_window_untouched: true,
    xrpl_calls_untouched: true,
    evidence_untouched: true,
    risk_score_untouched: true,
    restore: restore,
    reinstall: install
  };
})();
