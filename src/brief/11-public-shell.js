(function(){
  'use strict';

  /* ── CONFIG ──────────────────────────────────────────────── */
  var SHELL_V  = 'PUBLIC_SHELL_v1';
  var EGG_NEED = 9;
  var EGG_WIN  = 30000; // 30 seconds

  /* ── STATE ───────────────────────────────────────────────── */
  var _devUnlocked = false;
  var _eggClicks   = [];
  var _eggAttached = false;
  var _obsActive   = false;

  /* ── HIDE / RESTORE ──────────────────────────────────────── */
  function _hide(el) {
    if (!el || el._swHidden) return;
    el._swOrigDisplay    = el.style.display;
    el._swOrigVisibility = el.style.visibility;
    el._swOrigPointer    = el.style.pointerEvents;
    el.style.display        = 'none';
    el.style.visibility     = 'hidden';
    el.style.pointerEvents  = 'none';
    el.setAttribute('aria-hidden', 'true');
    el.setAttribute('tabindex', '-1');
    el.classList.add('sw-pub-hide');
    el._swHidden = true;
  }

  function _restore(el) {
    if (!el || !el._swHidden) return;
    el.style.display       = el._swOrigDisplay    || '';
    el.style.visibility    = el._swOrigVisibility || '';
    el.style.pointerEvents = el._swOrigPointer    || '';
    el.removeAttribute('aria-hidden');
    el.removeAttribute('tabindex');
    el.classList.remove('sw-pub-hide');
    el._swHidden = false;
  }

  /* ── EASTER EGG REVEAL ───────────────────────────────────── */
  function _revealAll() {
    _devUnlocked = true;

    // Disable the shell stylesheet — restores everything hidden by CSS
    var sheet = document.getElementById('sw-public-shell-css');
    if (sheet) sheet.disabled = true;

    // Restore nav
    var nav = document.getElementById('screenNav');
    if (nav) {
      nav.style.cssText = '';
      nav.removeAttribute('aria-hidden');
    }

    // Restore #screen-command children (inline styles set by JS)
    var cmdScreen = document.getElementById('screen-command');
    if (cmdScreen) {
      Array.prototype.forEach.call(cmdScreen.children, function(c) {
        c.style.display = c.style.visibility = c.style.pointerEvents =
        c.style.position = c.style.width = c.style.height =
        c.style.overflow = c.style.clip = '';
        c.classList.remove('sw-pub-hide');
      });
    }

    // Restore all sw-pub-hide elements
    document.querySelectorAll('.sw-pub-hide').forEach(function(el) { _restore(el); });

    // Re-enable body scroll
    document.documentElement.style.overflow = '';
    document.body.style.overflow = '';

    try { console.log('[' + SHELL_V + '] Dev unlocked via easter egg.'); } catch(_){}
  }

  /* ── EASTER EGG — attached to robot avatar ───────────────── */
  function _attachEgg() {
    if (_eggAttached || _devUnlocked) return;
    // Target: the XRPMan AI robot avatar image (#xaiAvatarShell)
    var avatar = document.getElementById('xaiAvatarShell');
    if (!avatar) return;
    _eggAttached = true;

    // Use touchend on mobile (avoids text-selection / copy callout)
    // Fall back to click on desktop
    function _tap(e) {
      if (_devUnlocked) return;
      e.preventDefault();
      e.stopPropagation();
      var now = Date.now();
      _eggClicks.push(now);
      _eggClicks = _eggClicks.filter(function(t) { return (now - t) < EGG_WIN; });
      if (_eggClicks.length >= EGG_NEED) {
        _eggClicks = [];
        _revealAll();
      }
    }

    avatar.addEventListener('touchend',  _tap, { passive: false });
    avatar.addEventListener('click',     _tap);
    // Block context menu on long-press
    avatar.addEventListener('contextmenu', function(e){ e.preventDefault(); });
  }

  /* ── APPLY RESTRICTIONS ──────────────────────────────────── */
  function _apply() {
    if (_devUnlocked) return;

    // Belt-and-suspenders: also hide via JS in case CSS is overridden
    var HIDE_CMDS = ['review-wallets','copy-morning','download-morning',
                     'download-total','download-debug','open-system','voice'];
    var room = document.getElementById('xaiCommandButtons');
    if (room) {
      HIDE_CMDS.forEach(function(cmd) {
        var btn = room.querySelector('[data-xai-cmd="' + cmd + '"]');
        if (btn) _hide(btn);
      });
    }

    // Hide report copy/download buttons
    ['cmdCopyReportBtn','cmdDownloadReportBtn'].forEach(function(id) {
      var el = document.getElementById(id);
      if (el) _hide(el);
    });

    // Sweep .cmd-report-actions: hide copy/download, keep Share
    var actions = document.querySelector('#cmdReportPane .cmd-report-actions');
    if (actions) {
      actions.querySelectorAll('button, a').forEach(function(btn) {
        if (btn.id === 'cmdShareXBtn') return;
        var txt = (btn.textContent || '').toUpperCase();
        if (txt.indexOf('COPY') !== -1 || txt.indexOf('DOWNLOAD') !== -1 ||
            txt.indexOf('📋') !== -1 || txt.indexOf('⬇') !== -1) {
          _hide(btn);
        }
      });
    }

    _attachEgg();
  }

  /* ── MUTATION OBSERVER ───────────────────────────────────── */
  function _startObs() {
    if (_obsActive) return;
    var t = document.getElementById('screen-command') || document.body;
    new MutationObserver(function(){ _apply(); }).observe(t, {childList:true,subtree:true});
    _obsActive = true;
  }

  /* ── BOOT ────────────────────────────────────────────────── */
  function _boot() {
    _apply();
    _startObs();
    var n = 0;
    var iv = setInterval(function(){
      _apply();
      if (++n >= 30) clearInterval(iv);
    }, 500);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', _boot);
  } else {
    _boot();
  }

  window.SW_PUBLIC_SHELL = { version: SHELL_V, unlocked: function(){ return _devUnlocked; } };
})();
