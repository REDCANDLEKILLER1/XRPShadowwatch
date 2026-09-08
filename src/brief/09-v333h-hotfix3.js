(function() {
  'use strict';
  var V = 'v3.33h-hotfix3';

  /* ──────────────────────────────────────────────────────────────────
     FIX 1 — Kill the floating share pill (#swSharePill)
     CSS hides it; JS removes it from DOM entirely and watches for
     re-mounts. v333f's bindLifecycle sets data-ready on the pill —
     if we removed it, that no-ops safely.
     ────────────────────────────────────────────────────────────────── */
  function _killFloatingPill() {
    var pill = document.getElementById('swSharePill');
    if (pill && pill.parentNode) {
      pill.parentNode.removeChild(pill);
      try { console.log('[SW-'+V+'] removed floating #swSharePill'); } catch(_){}
      return true;
    }
    return false;
  }

  function _watchForPillRemount() {
    if (window._v333hHF3PillObs) return;
    // Observe document.body for added nodes — if #swSharePill comes back, nuke it
    var obs = new MutationObserver(function(muts) {
      for (var i = 0; i < muts.length; i++) {
        var m = muts[i];
        for (var j = 0; j < m.addedNodes.length; j++) {
          var node = m.addedNodes[j];
          if (node && node.id === 'swSharePill') {
            try { node.parentNode.removeChild(node); } catch(_){}
            try { console.log('[SW-'+V+'] killed re-mounted #swSharePill'); } catch(_){}
          }
        }
      }
    });
    if (document.body) {
      obs.observe(document.body, { childList: true });
      window._v333hHF3PillObs = obs;
    }
  }

  /* ──────────────────────────────────────────────────────────────────
     FIX 2 — Populate share modal textarea from #cmdReportBody
     v333f's modal uses a local-closure extractor. Instead of fighting
     the closure, we wait for the modal to open then overwrite its
     textarea with text we build from the real report DOM.
     ────────────────────────────────────────────────────────────────── */
  function _todayStr() {
    var d = new Date();
    return d.toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' });
  }

  function _clean(s) { return (s || '').replace(/\s+/g, ' ').trim(); }

  function _extractFromCmdReportBody() {
    var body = document.getElementById('cmdReportBody');
    if (!body) return null;
    var fullText = body.textContent || body.innerText || '';
    if (!fullText || fullText.length < 200) return null;
    // Reject placeholder
    if (/press\s+run\s+shadow\s+watch/i.test(fullText)) return null;
    if (/run a scan to populate/i.test(fullText)) return null;

    // Parse bullets — lines starting with • are gold
    var rawLines = fullText.split(/\n/);
    var bullets = [];
    rawLines.forEach(function(l) {
      var t = _clean(l);
      if (/^[\u2022\-•]\s+/.test(t) && t.length > 15 && t.length < 200) {
        bullets.push(t.replace(/^[\u2022\-•]\s+/, '').slice(0, 160));
      }
    });
    // If we got nothing, fall back to substantial sentences
    if (!bullets.length) {
      var sentences = _clean(fullText).split(/(?<=[.!?])\s+/);
      bullets = sentences.filter(function(s) {
        return s.length > 30 && s.length < 200 &&
               !/^[A-Z\s\d\u26A0\u2728\u2705]+$/.test(s) &&  // skip header-only lines
               !/^https?:\/\//i.test(s);
      }).slice(0, 4);
    }
    bullets = bullets.slice(0, 4);

    // Try to detect a verdict / risk line for the headline
    var headline = null;
    var verdictMatch = fullText.match(/Risk:\s*(\d+)\s*\/\s*100[^.\n]*/i);
    if (verdictMatch) headline = verdictMatch[0].trim();
    if (!headline) {
      var pm = fullText.match(/\bXRP\s+Price:?\s*[~$]?\$?[\d.,]+/i);
      if (pm) headline = pm[0].trim();
    }

    return { bullets: bullets, headline: headline };
  }

  function _buildXText(extracted, mode) {
    var date = _todayStr();
    var bullets = (extracted && extracted.bullets) || [];
    var headline = extracted && extracted.headline;
    var lines = [];

    lines.push('\uD83D\uDFE2 SHADOWWATCH \u00B7 MORNING BRIEF');
    lines.push(date);
    lines.push('');

    if (headline) {
      lines.push('\u25B8 ' + headline);
      lines.push('');
    }

    var maxBullets = mode === 'short' ? 2 : 4;
    bullets.slice(0, maxBullets).forEach(function(b) {
      lines.push('\u25B8 ' + b);
    });

    lines.push('');
    lines.push('\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501');
    lines.push('@xrpman  \u00B7  #XRPL  #XRP  #XMEME  #SHADOWWATCH');

    var out = lines.join('\n');

    // If long mode is still too long for X, trim
    if (mode === 'short' && out.length > 280) {
      out = out.slice(0, 270) + '\u2026';
    }
    return out;
  }

  function _populateShareModal(mode) {
    var ta = document.getElementById('swsmText');
    if (!ta) return false;
    var extracted = _extractFromCmdReportBody();
    if (!extracted || !extracted.bullets.length) {
      ta.value = 'No sealed report yet. Run a scan and try SHARE TO X after the report appears.';
      // Update char counter if present
      var counter = document.getElementById('swsmCount');
      if (counter) counter.textContent = ta.value.length + ' chars';
      return false;
    }
    var text = _buildXText(extracted, mode || 'long');
    ta.value = text;
    // Update char counter to match
    var counter = document.getElementById('swsmCount');
    if (counter) counter.textContent = text.length + ' chars';
    try { console.log('[SW-'+V+'] modal textarea populated ('+text.length+' chars)'); } catch(_){}
    return true;
  }

  /* ──────────────────────────────────────────────────────────────────
     Inline-button click handler — wraps SW_SHARE.show() so the modal
     gets the right content. Replaces the click handler installed by
     hotfix1 by overwriting it.
     ────────────────────────────────────────────────────────────────── */
  function _rebindInlineShareButton() {
    var btn = document.getElementById('cmdShareXBtn');
    if (!btn) return false;
    if (btn._v333hHF3Bound) return true;
    // Replace via clone to drop the old listener cleanly
    var clone = btn.cloneNode(true);
    btn.parentNode.replaceChild(clone, btn);
    btn = clone;

    btn.addEventListener('click', function(e) {
      e.preventDefault();
      if (window.SW_SHARE && typeof window.SW_SHARE.show === 'function') {
        try { window.SW_SHARE.show(); } catch (err) {
          try { console.warn('[SW-'+V+'] SW_SHARE.show failed:', err.message); } catch(_){}
        }
        // Wait two frames for the modal to mount, then overwrite the textarea
        requestAnimationFrame(function() {
          requestAnimationFrame(function() {
            _populateShareModal('long');
          });
        });
      } else {
        alert('Share module not loaded yet — wait a moment then try again.');
      }
    });
    btn._v333hHF3Bound = true;
    try { console.log('[SW-'+V+'] inline SHARE TO X re-bound to use #cmdReportBody'); } catch(_){}
    return true;
  }

  /* ──────────────────────────────────────────────────────────────────
     Also hook the modal's AUTO-FILL and 280-MODE buttons so they read
     from #cmdReportBody too (those bind to local closure too).
     ────────────────────────────────────────────────────────────────── */
  function _rebindModalToolButtons() {
    var refresh = document.getElementById('swsmRefresh');
    var shortBtn = document.getElementById('swsmShort');
    if (refresh && !refresh._v333hHF3Bound) {
      refresh.addEventListener('click', function() {
        // Let v333f run first, then overwrite
        requestAnimationFrame(function() { _populateShareModal('long'); });
      }, true); // capture phase, runs before v333f's handler
      refresh._v333hHF3Bound = true;
    }
    if (shortBtn && !shortBtn._v333hHF3Bound) {
      shortBtn.addEventListener('click', function() {
        requestAnimationFrame(function() { _populateShareModal('short'); });
      }, true);
      shortBtn._v333hHF3Bound = true;
    }
  }

  /* ──────────────────────────────────────────────────────────────────
     Boot
     ────────────────────────────────────────────────────────────────── */
  function boot() {
    _killFloatingPill();
    _watchForPillRemount();
    _rebindInlineShareButton();
    _rebindModalToolButtons();
  }

  function bootWithRetry() {
    var tries = 0;
    var iv = setInterval(function() {
      tries++;
      _killFloatingPill();
      _watchForPillRemount();
      _rebindInlineShareButton();
      _rebindModalToolButtons();
      if (tries >= 30) {
        clearInterval(iv);
        try { console.log('[SW-'+V+'] '+V+' boot complete'); } catch(_){}
      }
    }, 500);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', bootWithRetry);
  } else {
    bootWithRetry();
  }

  window.SW_V333H_HOTFIX3 = {
    version: V,
    extractFromBody: _extractFromCmdReportBody,
    buildXText: _buildXText,
    populateModal: _populateShareModal,
    killPill: _killFloatingPill,
    rebindShare: _rebindInlineShareButton
  };
})();
