(function() {
  'use strict';
  var V = 'v3.33h-hotfix1';

  /* ──────────────────────────────────────────────────────────────────
     FIX 1 — Neutralize the boot-time wallet merge
     v3.33h's _softMergeIntoWatchlist was pushing 3 addresses into
     state.watched at load, which made the scanner try to fetch them
     and stall at 8%. We undo any in-memory addition and block the
     merge from running on subsequent boots.
     ────────────────────────────────────────────────────────────────── */
  function _undoWalletMerge() {
    // Mark the merge as already done so v333h's boot won't re-run it
    window._v333hMerged = true;

    var addedAddrs = (window.SW_WALLET_ADDS || []).map(function(w) { return w.address; });
    if (!addedAddrs.length) return;

    function strip(arr) {
      if (!Array.isArray(arr)) return 0;
      var removed = 0;
      for (var i = arr.length - 1; i >= 0; i--) {
        var entry = arr[i] || {};
        if (entry.source === 'v333h_auto_add' ||
            entry.source === 'v333g_auto_add') {
          arr.splice(i, 1);
          removed++;
        }
      }
      return removed;
    }
    var total = 0;
    total += strip(window.KNOWN);
    total += strip(window.WATCHED_WALLETS);
    if (window.state) {
      total += strip(window.state.watched);
      total += strip(window.state.knownWallets);
    }
    try { console.log('[SW-'+V+'] reverted boot-time wallet adds: '+total); } catch(_){}
  }

  /* ──────────────────────────────────────────────────────────────────
     FIX 2A — Patch extractReportSummary to read from #cmdReportBody
     The real DOM target. Without this the share extracts placeholder.
     ────────────────────────────────────────────────────────────────── */
  function _patchExtractor() {
    if (!window.SW_SHARE || typeof window.SW_SHARE.extract !== 'function') return false;
    if (window.SW_SHARE.extract._v333hPatched) return true;

    var originalExtract = window.SW_SHARE.extract;

    function _clean(s) { return (s || '').replace(/\s+/g, ' ').trim(); }
    function _today() {
      var d = new Date();
      return d.toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' });
    }

    function patchedExtract() {
      // Try the real DOM source first — #cmdReportBody
      var body = document.getElementById('cmdReportBody');
      if (body) {
        var raw = _clean(body.textContent || body.innerText || '');
        // Skip placeholder content
        var isPlaceholder = /press\s+run\s+shadow\s+watch/i.test(raw) ||
                            /run a scan to populate/i.test(raw) ||
                            raw.length < 200;
        if (!isPlaceholder && raw.length > 200) {
          var summary = {
            title: 'SHADOWWATCH MORNING BRIEF',
            date: _today(),
            bullets: [],
            headline: null,
            flagged: null,
            raw: raw.slice(0, 2000)
          };
          // Pull 3-4 sentences for bullets — favor lines starting with •
          var bulletLines = (body.textContent || '').split(/\n/)
            .map(function(l) { return _clean(l); })
            .filter(function(l) { return /^[\u2022\-•]\s+/.test(l) && l.length > 15 && l.length < 180; })
            .slice(0, 4);
          if (bulletLines.length) {
            summary.bullets = bulletLines.map(function(b) {
              return b.replace(/^[\u2022\-•]\s+/, '').slice(0, 140);
            });
          } else {
            // Fall back to first 3 substantial sentences
            var sentences = raw.split(/(?<=[.!?])\s+/)
              .filter(function(s) { return s.length > 25 && s.length < 200; });
            summary.bullets = sentences.slice(0, 3);
          }
          if (!summary.bullets.length) {
            summary.bullets = ['Report ready. Tap COPY to grab full text.'];
          }
          return summary;
        }
      }
      // Fall back to the original extractor (handles all the other selector paths)
      return originalExtract();
    }
    patchedExtract._v333hPatched = true;
    patchedExtract._original = originalExtract;
    window.SW_SHARE.extract = patchedExtract;
    try { console.log('[SW-'+V+'] share extractor patched (#cmdReportBody first)'); } catch(_){}
    return true;
  }

  /* ──────────────────────────────────────────────────────────────────
     FIX 2B — Mount SHARE TO X inline in .cmd-report-actions
     Next to Copy + Download. Hide the floating corner pill (CSS above).
     ────────────────────────────────────────────────────────────────── */
  function _mountInlineShareButton() {
    var actions = document.querySelector('#cmdReportPane .cmd-report-actions');
    if (!actions) return false;
    if (document.getElementById('cmdShareXBtn')) return true;

    var btn = document.createElement('button');
    btn.id = 'cmdShareXBtn';
    btn.type = 'button';
    btn.innerHTML = '<span class="x-glyph">𝕏</span> SHARE TO X';
    btn.title = 'Share today\u2019s morning brief to X';
    btn.addEventListener('click', function(e) {
      e.preventDefault();
      // Re-patch the extractor in case SW_SHARE loaded after us
      _patchExtractor();
      if (window.SW_SHARE && typeof window.SW_SHARE.show === 'function') {
        window.SW_SHARE.show();
      } else if (window.SW_SHARE && typeof window.SW_SHARE.shareToX === 'function') {
        window.SW_SHARE.shareToX();
      } else {
        try { console.warn('[SW-'+V+'] SW_SHARE API not ready'); } catch(_){}
        alert('Share module not yet loaded — try again in a moment.');
      }
    });

    // Insert between Download and Report Desk so order is: Copy | Download | Share to X | Report Desk
    var downloadBtn = actions.querySelector('#cmdDownloadReportBtn');
    if (downloadBtn && downloadBtn.nextSibling) {
      actions.insertBefore(btn, downloadBtn.nextSibling);
    } else {
      actions.appendChild(btn);
    }
    try { console.log('[SW-'+V+'] inline SHARE TO X button mounted on report card'); } catch(_){}
    return true;
  }

  /* ──────────────────────────────────────────────────────────────────
     Boot — retry until #cmdReportPane and SW_SHARE both exist
     ────────────────────────────────────────────────────────────────── */
  function boot() {
    _undoWalletMerge();
    _patchExtractor();
    _mountInlineShareButton();
  }

  function bootWithRetry() {
    var tries = 0;
    var iv = setInterval(function() {
      tries++;
      var paneReady = !!document.querySelector('#cmdReportPane .cmd-report-actions');
      var shareReady = window.SW_SHARE && typeof window.SW_SHARE.show === 'function';
      // Run undo immediately, mount when DOM ready, patch when both ready
      if (tries === 1) _undoWalletMerge();
      if (paneReady) _mountInlineShareButton();
      if (shareReady) _patchExtractor();
      if (paneReady && shareReady) {
        try { console.log('[SW-'+V+'] '+V+' fully loaded'); } catch(_){}
        clearInterval(iv);
      } else if (tries >= 40) {
        clearInterval(iv);
        if (!paneReady) try { console.warn('[SW-'+V+'] report pane not found'); } catch(_){}
        if (!shareReady) try { console.warn('[SW-'+V+'] SW_SHARE not ready — share button will retry on click'); } catch(_){}
      }
    }, 400);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', bootWithRetry);
  } else {
    bootWithRetry();
  }

  window.SW_V333H_HOTFIX1 = {
    version: V,
    undoMerge: _undoWalletMerge,
    patchExtractor: _patchExtractor,
    mountButton: _mountInlineShareButton
  };
})();
