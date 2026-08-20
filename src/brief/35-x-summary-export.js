/* ═══════════════════════════════════════════════════════════════════════════
   X SUMMARY EXPORT — presentation-only compressed public export

   Keeps full forensic/debug exports untouched. Builds a dedicated <=4,000
   character X/Twitter summary and binds it to the existing SHARE TO X surface.
   ═══════════════════════════════════════════════════════════════════════════ */
(function () {
  'use strict';

  var VERSION = 'X_SUMMARY_EXPORT_v2';
  var HARD_LIMIT = 4000;
  var TARGET_BODY = 3820;

  function clean(text) {
    return String(text || '')
      .replace(/[ \t]+\n/g, '\n')
      .replace(/\n{3,}/g, '\n\n')
      .trim();
  }

  function compact(text, max) {
    var s = clean(text);
    if (!max || s.length <= max) return s;

    var lines = s.split('\n').map(function (x) { return x.trim(); }).filter(Boolean);
    var out = [];
    var used = 0;
    for (var i = 0; i < lines.length; i++) {
      var line = lines[i];
      if (used + line.length + (out.length ? 1 : 0) <= max) {
        out.push(line);
        used += line.length + (out.length > 1 ? 1 : 0);
      } else {
        break;
      }
    }
    if (out.length) return out.join('\n');

    var words = s.split(/\s+/);
    var short = '';
    for (var j = 0; j < words.length; j++) {
      var next = short ? short + ' ' + words[j] : words[j];
      if (next.length > max) break;
      short = next;
    }
    return short || s;
  }

  function section(text, startRx, endRx) {
    var s = String(text || '');
    var m = startRx.exec(s);
    if (!m) return '';
    var start = m.index + m[0].length;
    var tail = s.slice(start);
    var e = endRx ? endRx.exec(tail) : null;
    var body = e ? tail.slice(0, e.index) : tail;
    body = body.replace(/^\s*[─━═_\-]{3,}\s*\n?/m, '');
    return clean(body);
  }

  function branding(text) {
    var s = String(text || '');
    var cut = s.search(/\n(?:Executive Summary|1\.\s*EXECUTIVE SUMMARY)\s*\n/i);
    if (cut < 0) cut = Math.min(s.length, 500);
    return compact(s.slice(0, cut), 300);
  }

  function executive(text) {
    return compact(section(text,
      /(?:^|\n)(?:Executive Summary|1\.\s*EXECUTIVE SUMMARY)\s*\n/i,
      /\n(?:What Mattered Most|ESCROWS|2\.\s*LEDGER DIAGNOSTICS|Evidence|Under the Surface)\s*\n/i), 330);
  }

  function largeMoves(text) {
    var direct = section(text,
      /(?:^|\n)(?:9\.\s*LARGE MOVES|LARGE MOVES|Largest XRP Movements)\s*\n/i,
      /\n(?:10\.|RECEIVER FOLLOWTHROUGH|11\.|COORDINATION MEMORY|Evidence|Verdict)\s*\n/i);
    if (direct) return compact(direct, 440);

    var evidence = section(text,
      /(?:^|\n)Evidence\s*\n/i,
      /\n(?:Under the Surface|How to Read It|What To Watch Next|Verdict|LEDGER DIAGNOSTICS)\s*\n/i);
    var candidates = (evidence || String(text || '')).split(/(?<=[.!?])\s+|\n+/).filter(function (x) {
      return /\b\d+(?:\.\d+)?\s*(?:K|M|B)?\s*XRP\b/i.test(x) &&
             /(moved|transfer|reached|→|sent|received)/i.test(x);
    }).slice(0, 4);
    return compact(candidates.join('\n'), 440);
  }

  function evidenceHighlights(text) {
    return compact(section(text,
      /(?:^|\n)Evidence\s*\n/i,
      /\n(?:Under the Surface|How to Read It|What To Watch Next|Verdict|LEDGER DIAGNOSTICS)\s*\n/i), 380);
  }

  function stats(text) {
    var lines = String(text || '').split('\n').map(function (x) { return x.trim(); });
    var keep = lines.filter(function (line) {
      return /(Watched wallets:|Watched activity|Shadow volume|Net watched flow)/i.test(line);
    });
    return compact(keep.slice(0, 5).join('\n'), 330);
  }

  function verdict(text) {
    var v = section(text,
      /(?:^|\n)(?:Verdict|6\.\s*THE VERDICT)\s*\n/i,
      /\n(?:LEDGER DIAGNOSTICS|7\.|LIMIT ORDER|🙏|MISSION DEBRIEF|Sources)\s*\n/i);
    var risk = (String(text || '').match(/(?:Risk:\s*)?\d+\s*\/\s*100[^\n.]*/i) || [])[0] || '';
    return compact((risk ? risk + '\n' : '') + v, 310);
  }

  function disclaimer(text) {
    var m = String(text || '').match(/[^\n]*(?:not financial advice|financial advice)[^\n]*/i);
    return compact(m ? m[0] : 'Not financial advice. XRP-only forensic watch.', 110);
  }

  function prayer(text) {
    return compact(section(text,
      /(?:^|\n)🙏\s*THE DAILY PRAYER\s*\n/i,
      /\n(?:📖\s*THE DAILY SCRIPTURE|Sources|Escrow Watch)\s*\n/i), 230);
  }

  function scripture(text) {
    return compact(section(text,
      /(?:^|\n)📖\s*THE DAILY SCRIPTURE\s*\n/i,
      /\n(?:Sources|Escrow Watch|⚠️|I'm XRPMan)\s*\n/i), 280);
  }

  function sources(text) {
    var s = String(text || '');
    var urls = s.match(/https?:\/\/[^\s]+/g) || [];
    var out = [];
    for (var i = 0; i < urls.length && out.length < 3; i++) {
      var u = urls[i].replace(/[),.;]+$/, '');
      if (u.length <= 180 && out.indexOf(u) < 0) out.push(u);
    }
    if (out.length) return compact(out.join('\n'), 360);

    var inline = s.match(/Sources:\s*[^\n]+/i);
    return compact(inline ? inline[0].replace(/^Sources:\s*/i, '') : '', 220);
  }

  function coverageWarning(text, pack) {
    var s = String(text || '');
    var m = s.match(/[^\n]*(?:TX WINDOW:\s*INCOMPLETE|Transaction-window coverage incomplete)[^\n]*/i);
    if (m) return compact(m[0], 180);

    var c = pack && pack.tx_scan_coverage;
    if (c && c.full_window_complete === false) {
      return compact('⚠️ TX WINDOW: INCOMPLETE — ' +
        Number(c.complete_wallets || 0) + '/' + Number(c.target_wallets || 0) +
        ' complete; ' + Number(c.failed_wallets || 0) + ' failed; ' +
        Number(c.truncated_wallets || 0) + ' truncated. Zero-result claims are not definitive.', 180);
    }
    return '';
  }

  function optionalEscrow(text) {
    return compact(section(text,
      /(?:^|\n)Escrow Watch\s*\n/i,
      /\nSources\s*\n/i), 260);
  }

  function pushSection(parts, heading, body) {
    body = clean(body);
    if (!body) return;
    parts.push(heading + '\n' + body);
  }

  function finalize(body) {
    var cleanBody = clean(body);
    var count = 0;
    for (var i = 0; i < 12; i++) {
      var out = 'X EXPORT\nCharacters: ' + count + ' / 4000\n\n' + cleanBody;
      var actual = out.length;
      if (actual === count) {
        if (actual > HARD_LIMIT) throw new Error('X_SUMMARY_EXPORT exceeds 4000 characters');
        return out;
      }
      count = actual;
    }
    throw new Error('X_SUMMARY_EXPORT counter did not stabilize');
  }

  function buildXSummaryExport(source, pack) {
    var s = clean(source);
    if (!s) throw new Error('X_SUMMARY_EXPORT requires report text');

    var required = [];
    pushSection(required, 'SHADOW WATCH', branding(s));
    pushSection(required, 'Executive Summary', executive(s));
    pushSection(required, 'Largest XRP Movements', largeMoves(s));
    pushSection(required, 'Evidence Highlights', evidenceHighlights(s));
    pushSection(required, 'Watched Wallets / Shadow Volume', stats(s));
    pushSection(required, 'Coverage', coverageWarning(s, pack));
    pushSection(required, 'Verdict / Risk', verdict(s));
    pushSection(required, 'Disclaimer', disclaimer(s));
    pushSection(required, '🙏 THE DAILY PRAYER', prayer(s));
    pushSection(required, '📖 THE DAILY SCRIPTURE', scripture(s));
    pushSection(required, 'Sources', sources(s));

    var body = clean(required.join('\n\n'));

    // Priority 3 content (candidate lists, JSON, richlist, internal diagnostics,
    // repeated explanations) is intentionally not admitted to the X renderer.
    // Priority 2 escrow may be included only when all required content already fits.
    var escrow = optionalEscrow(s);
    if (escrow) {
      var withEscrow = body + '\n\nEscrow Watch\n' + escrow;
      try {
        var test = finalize(withEscrow);
        if (test.length <= 3900) body = withEscrow;
      } catch (_) {}
    }

    // Section-level budget guard. Required sections have already been compacted
    // individually, so this should only reject pathological input rather than
    // blindly slicing required content.
    if (body.length > TARGET_BODY) {
      throw new Error('X_SUMMARY_EXPORT required sections exceed safe body budget');
    }

    return finalize(body);
  }

  function resolvePack() {
    try { return (typeof state !== 'undefined' && state && state.pack) ? state.pack : null; } catch (_) { return null; }
  }

  function resolveSource() {
    try {
      if (typeof state !== 'undefined' && state && state.morningStoryReport && String(state.morningStoryReport).length > 200) {
        return String(state.morningStoryReport);
      }
    } catch (_) {}
    try {
      var body = document.getElementById('cmdReportBody');
      var text = body && (body.textContent || body.innerText || '');
      if (text && text.length > 200) return text;
    } catch (_) {}
    try {
      if (window.SHADOW_EXPORTS && typeof window.SHADOW_EXPORTS.buildPublicTextReport === 'function') {
        return String(window.SHADOW_EXPORTS.buildPublicTextReport() || '');
      }
    } catch (_) {}
    return '';
  }

  function installExportSurface() {
    var api = window.SHADOW_EXPORTS || (window.SHADOW_EXPORTS = {});
    api.buildXSummaryText = function (source) {
      return buildXSummaryExport(source || resolveSource(), resolvePack());
    };
    api.exportXSummary = function (source) {
      var text = api.buildXSummaryText(source);
      try {
        if (typeof copySafe === 'function') copySafe(text, 'X Summary Export');
        else if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(text);
      } catch (_) {}
      return { ok: true, text: text, characters: text.length, limit: HARD_LIMIT };
    };
    return true;
  }

  function populateShareModal() {
    var ta = document.getElementById('swsmText');
    if (!ta) return false;
    try {
      var text = buildXSummaryExport(resolveSource(), resolvePack());
      ta.value = text;
      var counter = document.getElementById('swsmCount');
      if (counter) counter.textContent = text.length + ' / 4000 chars';
      return true;
    } catch (e) {
      try { console.warn('[SW-' + VERSION + '] X summary build failed:', e.message); } catch (_) {}
      return false;
    }
  }

  function bindShareButton() {
    var btn = document.getElementById('cmdShareXBtn');
    if (!btn || btn._swXSummaryV2Bound) return !!btn;

    var clone = btn.cloneNode(true);
    btn.parentNode.replaceChild(clone, btn);
    btn = clone;
    btn._swXSummaryV2Bound = true;
    btn.addEventListener('click', function (e) {
      e.preventDefault();
      if (window.SW_SHARE && typeof window.SW_SHARE.show === 'function') {
        try { window.SW_SHARE.show(); } catch (_) {}
        requestAnimationFrame(function () {
          requestAnimationFrame(populateShareModal);
        });
      } else {
        try {
          var result = window.SHADOW_EXPORTS.exportXSummary();
          if (result && result.ok && typeof log === 'function') log('X Summary copied (' + result.characters + '/4000 chars).');
        } catch (_) {}
      }
    });
    return true;
  }

  function install() {
    installExportSurface();
    bindShareButton();
    var tries = 0;
    var timer = setInterval(function () {
      tries++;
      installExportSurface();
      bindShareButton();
      if (tries >= 20) clearInterval(timer);
    }, 250);
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', install);
  else install();

  window.SW_X_SUMMARY_EXPORT = {
    version: VERSION,
    hard_limit: HARD_LIMIT,
    build: buildXSummaryExport,
    populateShareModal: populateShareModal,
    presentation_only: true,
    full_report_untouched: true,
    debug_export_untouched: true,
    scanner_untouched: true,
    evidence_engine_untouched: true,
    discovery_engine_untouched: true,
    read_only: true
  };
})();
