(function() {
  'use strict';
  var V = 'v3.33h-hotfix2';

  /* ──────────────────────────────────────────────────────────────────
     FIX 1 — Strip PATTERN MEMORY section from public morning story
     The section runs from the "PATTERN MEMORY" header to the next
     ALL-CAPS section header (DISCOVERY / WATCH NEXT / CONFIDENCE FRAME
     / VERDICT / SOURCES) or end of body.
     ────────────────────────────────────────────────────────────────── */
  function _stripPatternMemory(text) {
    if (!text || typeof text !== 'string') return text;
    // Match PATTERN MEMORY header (optionally preceded by blank lines) up to
    // the next section header. Section headers are ALL CAPS lines on their
    // own, usually preceded by a blank line.
    // We anchor on a known set of subsequent section names to avoid eating
    // unrelated content if formatting drifts.
    var re = /\n+PATTERN MEMORY\b[\s\S]*?(?=\n+(?:DISCOVERY|WATCH NEXT|CONFIDENCE FRAME|VERDICT|REAL NEWS|MARKET SNAPSHOT|LEDGER STORY|SOURCES|THE DAILY PRAYER|THE DAILY SCRIPTURE|\u26A0\uFE0F|\uD83D\uDE4F|\uD83D\uDCD6)\b|$)/;
    if (re.test(text)) {
      return text.replace(re, '\n');
    }
    return text;
  }

  /* ──────────────────────────────────────────────────────────────────
     FIX 2 — Drop inline URL lines from REAL NEWS bullets
     v333h's news block prints:
        • Title — framing.
          https://example.com/article
     The bottom SOURCES block already lists the same URLs as clickable
     anchors. Strip the indented URL line under each bullet, keep title.
     ────────────────────────────────────────────────────────────────── */
  function _stripInlineNewsUrls(text) {
    if (!text || typeof text !== 'string') return text;
    // Find the REAL NEWS block and operate within it only
    // Bound it by next ALL-CAPS section header or end
    var newsRe = /(REAL NEWS\b[\s\S]*?)(?=\n+(?:PATTERN MEMORY|DISCOVERY|WATCH NEXT|CONFIDENCE FRAME|VERDICT|SOURCES|THE DAILY PRAYER|THE DAILY SCRIPTURE|\u26A0\uFE0F|\uD83D\uDE4F|\uD83D\uDCD6)\b|$)/;
    if (!newsRe.test(text)) return text;
    return text.replace(newsRe, function(match) {
      // Remove any line that is purely whitespace + a URL (the indented URL line under each bullet)
      // Match: optional leading whitespace, optional indent, then http(s)://...
      return match
        .replace(/\n[ \t]+https?:\/\/[^\s]+/g, '')  // indented URL under bullet
        .replace(/\n[ \t]*\n[ \t]*\n+/g, '\n\n');    // collapse triple blanks
    });
  }

  /* ──────────────────────────────────────────────────────────────────
     Apply both cleanups in one wrapper
     ────────────────────────────────────────────────────────────────── */
  function _cleanMorningText(text) {
    var out = text;
    try { out = _stripPatternMemory(out); } catch (e) {
      try { console.warn('[SW-'+V+'] pattern strip failed:', e.message); } catch(_){}
    }
    try { out = _stripInlineNewsUrls(out); } catch (e) {
      try { console.warn('[SW-'+V+'] inline url strip failed:', e.message); } catch(_){}
    }
    return out;
  }

  function _wrapBuildMorningText() {
    if (typeof window.buildMorningStoryText !== 'function') return false;
    if (window.buildMorningStoryText._v333hHotfix2Wrapped) return true;
    var prev = window.buildMorningStoryText;
    var wrapped = function(pack) {
      var raw;
      try { raw = prev(pack); } catch (e) { return prev(pack); }
      if (!raw) return raw;
      try { return _cleanMorningText(raw); }
      catch (e) {
        try { console.warn('[SW-'+V+'] cleanup failed, returning raw:', e.message); } catch(_){}
        return raw;
      }
    };
    wrapped._v333hHotfix2Wrapped = true;
    wrapped._original = prev._original || prev;
    window.buildMorningStoryText = wrapped;
    try { console.log('[SW-'+V+'] buildMorningStoryText cleanup wrapped'); } catch(_){}
    return true;
  }

  /* ──────────────────────────────────────────────────────────────────
     Boot — retry, then re-wrap if other wrappers chain after us
     ────────────────────────────────────────────────────────────────── */
  function bootWithRetry() {
    var tries = 0;
    var iv = setInterval(function() {
      tries++;
      if (typeof window.buildMorningStoryText === 'function') {
        _wrapBuildMorningText();
        // Re-wrap after a beat in case any other layer chains
        setTimeout(function() {
          if (!window.buildMorningStoryText._v333hHotfix2Wrapped) _wrapBuildMorningText();
        }, 1800);
        clearInterval(iv);
        try { console.log('[SW-'+V+'] '+V+' loaded'); } catch(_){}
      } else if (tries >= 40) {
        clearInterval(iv);
        try { console.warn('[SW-'+V+'] buildMorningStoryText not found'); } catch(_){}
      }
    }, 400);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', bootWithRetry);
  } else {
    bootWithRetry();
  }

  window.SW_V333H_HOTFIX2 = {
    version: V,
    stripPatternMemory: _stripPatternMemory,
    stripInlineNewsUrls: _stripInlineNewsUrls,
    clean: _cleanMorningText,
    rewrap: _wrapBuildMorningText
  };
})();
