/* ═══════════════════════════════════════════════════════════════════════════
   PUBLIC MORNING REPORT 4K GOVERNOR — 2026-08-17

   Publication-only guard for platforms with a 4,000-character field limit.
   Full TOTAL REPORT / TOTAL DEBUG / evidence data remain untouched.

   Policy:
   - preserve ledger figures, escrow, flow bands, verdict, diagnostics,
     prayer/scripture and source attribution;
   - remove duplicate/internal presentation text before touching evidence;
   - target <= 3,900 characters to leave a small posting margin;
   - never change scanner, scoring, lookback, concurrency or XRPL requests.
   ═══════════════════════════════════════════════════════════════════════════ */
(function () {
  'use strict';

  var VERSION = '2026.08.17.1';
  var HARD_LIMIT = 4000;
  var TARGET = 3900;

  function normalizeBlankLines(text) {
    return String(text || '').replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
  }

  function removeSection(text, heading, nextHeading) {
    var s = String(text || '');
    var startNeedle = '\n' + heading + '\n';
    var start = s.indexOf(startNeedle);
    if (start < 0) return s;
    var end = s.indexOf('\n' + nextHeading + '\n', start + startNeedle.length);
    if (end < 0) return s;
    return s.slice(0, start) + '\n' + s.slice(end + 1);
  }

  function stripDuplicateNewsUsed(text) {
    return String(text || '').replace(/\n{2,}NEWS USED:\n[\s\S]*$/i, '').trimEnd();
  }

  function stripDecorativeRules(text) {
    return String(text || '').replace(/^[\u2500-\u257F\u2550\u2551\u2501]{3,}\s*$/gm, '');
  }

  function limitSources(text, maxEntries) {
    var s = String(text || '');
    var m = /\nSources\n/i.exec(s);
    if (!m) return s;
    var headEnd = m.index + m[0].length;
    var prefix = s.slice(0, headEnd);
    var rest = s.slice(headEnd).split('\n');
    var kept = [];
    var count = 0;
    for (var i = 0; i < rest.length; i++) {
      var line = rest[i];
      if (/^\[\d+\]\s/.test(line)) {
        count++;
        if (count <= maxEntries) kept.push(line);
      } else if (count <= maxEntries && line.trim()) {
        kept.push(line);
      }
    }
    return prefix + kept.join('\n');
  }

  function compactSourceDomains(text) {
    var s = String(text || '');
    var m = /\nSources\n/i.exec(s);
    if (!m) return s;
    var head = s.slice(0, m.index).trimEnd();
    var urls = s.slice(m.index).match(/https?:\/\/[^\s]+/g) || [];
    var domains = [];
    urls.forEach(function (u) {
      try {
        var d = new URL(u).hostname.replace(/^www\./, '');
        if (domains.indexOf(d) < 0) domains.push(d);
      } catch (_) {}
    });
    return head + (domains.length ? '\n\nSources: ' + domains.slice(0, 3).join(' · ') : '');
  }

  function trimNarrativeFallback(text) {
    var s = String(text || '');
    if (s.length <= TARGET) return s;
    var marker = '\nLEDGER DIAGNOSTICS\n';
    var at = s.indexOf(marker);
    if (at < 0) return s.slice(0, TARGET - 1).trimEnd() + '…';

    var tail = s.slice(at);
    var maxHead = TARGET - tail.length - 2;
    if (maxHead < 400) return s.slice(0, TARGET - 1).trimEnd() + '…';
    var head = s.slice(0, maxHead);
    var cut = Math.max(head.lastIndexOf('\n\n'), head.lastIndexOf('. '));
    if (cut > Math.floor(maxHead * 0.65)) head = head.slice(0, cut + (head.charAt(cut) === '.' ? 1 : 0));
    return head.trimEnd() + '\n…\n' + tail.trimStart();
  }

  function govern(text) {
    var original = String(text || '');
    if (original.length <= TARGET) return original;

    var out = stripDuplicateNewsUsed(original);
    out = stripDecorativeRules(out);
    out = removeSection(out, 'How to Read It', 'What To Watch Next');
    out = removeSection(out, 'What Mattered Most', 'Evidence');
    out = normalizeBlankLines(out);

    if (out.length > TARGET) out = normalizeBlankLines(limitSources(out, 2));
    if (out.length > TARGET) out = normalizeBlankLines(removeSection(out, 'What To Watch Next', 'Verdict'));
    if (out.length > TARGET) out = normalizeBlankLines(compactSourceDomains(out));
    if (out.length > TARGET) out = normalizeBlankLines(trimNarrativeFallback(out));
    if (out.length > HARD_LIMIT) out = out.slice(0, HARD_LIMIT - 1).trimEnd() + '…';
    return out;
  }

  function install() {
    var fn = null;
    try { fn = window.buildMorningStoryText || (typeof buildMorningStoryText === 'function' ? buildMorningStoryText : null); } catch (_) {}
    if (typeof fn !== 'function') return false;
    if (fn._swPublic4kGovernor20260817) return true;

    var wrapped = function (pack) {
      var full = fn.apply(this, arguments);
      var safe = govern(full);
      try {
        var p = pack || ((typeof state !== 'undefined' && state && state.pack) ? state.pack : null);
        if (p) {
          p.public_morning_chars_full = String(full || '').length;
          p.public_morning_chars_4k = String(safe || '').length;
          p.public_morning_4k_compacted = String(full || '').length !== String(safe || '').length;
        }
      } catch (_) {}
      return safe;
    };
    wrapped._swPublic4kGovernor20260817 = true;
    wrapped._swOriginal = fn;

    try { window.buildMorningStoryText = wrapped; } catch (_) {}
    try { buildMorningStoryText = wrapped; } catch (_) {}

    window.SW_PUBLIC_MORNING_4K_20260817 = {
      version: VERSION,
      hard_limit: HARD_LIMIT,
      target: TARGET,
      govern: govern,
      publication_only: true,
      total_report_untouched: true,
      total_debug_untouched: true,
      scanner_untouched: true,
      scoring_untouched: true,
      lookback_untouched: true,
      concurrency_untouched: true
    };
    return true;
  }

  if (!install()) {
    var tries = 0;
    var timer = setInterval(function () {
      tries++;
      if (install() || tries >= 40) clearInterval(timer);
    }, 100);
  }
})();
