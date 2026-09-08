/* ═══════════════════════════════════════════════════════════════════
   v3.33e-command-dialogue-strip-fix1
   ═══════════════════════════════════════════════════════════════════ */
(function() {
  'use strict';

  var V333E_VERSION = 'v3.33e-command-dialogue-strip-fix1';

  /* ─── State ───────────────────────────────────────────────── */
  var _typingTimer = null;
  var _queue = [];
  var _currentText = '';
  var _holdTimer = null;
  var _isTyping = false;

  /* ─── Public API ──────────────────────────────────────────── */
  function xaiClearDialogue() {
    if (_typingTimer) { clearInterval(_typingTimer); _typingTimer = null; }
    if (_holdTimer)   { clearTimeout(_holdTimer); _holdTimer = null; }
    var el = document.getElementById('xaiTypedLine');
    if (el) el.textContent = '';
    _currentText = '';
    _isTyping = false;
    _hideCursor();
    xaiSetSpeaking(false);
  }
  function xaiSetSpeaking(active) {
    var screen = document.querySelector('.xai-dialogue-screen');
    if (screen) screen.setAttribute('data-speaking', active ? 'true' : 'false');
    var shell = document.getElementById('xaiAvatarShell');
    if (shell) {
      if (active) shell.classList.add('xai-speaking');
      else        shell.classList.remove('xai-speaking');
    }
  }
  function _showCursor() {
    var c = document.querySelector('.xai-dialogue-screen .xai-cursor');
    if (c) c.classList.remove('hidden');
  }
  function _hideCursor() {
    var c = document.querySelector('.xai-dialogue-screen .xai-cursor');
    if (c) c.classList.add('hidden');
  }
  function xaiTypeLine(text, options) {
    options = options || {};
    var el = document.getElementById('xaiTypedLine');
    if (!el || !text) return;
    if (_typingTimer) { clearInterval(_typingTimer); _typingTimer = null; }
    if (_holdTimer)   { clearTimeout(_holdTimer); _holdTimer = null; }
    var clean = String(text).slice(0, 280);
    _currentText = clean;
    _isTyping = true;
    el.textContent = '';
    _showCursor();
    xaiSetSpeaking(true);
    var i = 0;
    var stepMs = options.stepMs || 28;
    _typingTimer = setInterval(function() {
      if (_currentText !== clean) {
        clearInterval(_typingTimer); _typingTimer = null; return;
      }
      i++;
      el.textContent = clean.slice(0, i);
      if (i >= clean.length) {
        clearInterval(_typingTimer); _typingTimer = null;
        _isTyping = false;
        var holdMs = options.holdMs || 3500;
        _holdTimer = setTimeout(function() {
          _holdTimer = null;
          if (_queue.length) {
            var next = _queue.shift();
            xaiTypeLine(next.text, next.options || {});
          } else {
            xaiClearDialogue();
          }
        }, holdMs);
      }
    }, stepMs);
  }
  function xaiQueueDialogue(text, phase) {
    if (!text) return;
    if (_isTyping || _holdTimer || _typingTimer) {
      _queue.push({ text: text, options: { phase: phase } });
      if (_queue.length > 6) _queue = _queue.slice(-6);
    } else {
      xaiTypeLine(text, { phase: phase });
    }
  }
  if (typeof window !== 'undefined') {
    window.xaiTypeLine      = xaiTypeLine;
    window.xaiClearDialogue = xaiClearDialogue;
    window.xaiSetSpeaking   = xaiSetSpeaking;
    window.xaiQueueDialogue = xaiQueueDialogue;
  }

  /* ─── DOM build — compact horizontal strip ──────────────── */
  function _v333e_buildLayout() {
    var room = document.getElementById('xrpmanAiCommandRoom');
    if (!room || room._v333eBuilt) return;
    var robot = document.getElementById('xaiAvatarShell');
    if (!robot) return;

    // ── Title stack (top header)
    var titleStack = document.createElement('div');
    titleStack.className = 'xai-title-stack';
    titleStack.innerHTML =
      '<div class="xai-syslabel">XRPMAN AI INTELLIGENCE SYSTEM</div>' +
      '<div class="xai-title-present">XRPMAN PRESENTS</div>' +
      '<div class="xai-title-rck">REDCANDLEKILLER</div>' +
      '<div class="xai-title-shadow">SHADOWWATCH</div>';

    // ── Compact horizontal AI strip
    var dialogue = document.createElement('div');
    dialogue.className = 'xai-dialogue-screen';
    dialogue.setAttribute('data-speaking', 'false');
    dialogue.innerHTML =
      // Avatar slot — round, green-bordered, with status dot
      '<div class="xai-speaker-avatar" id="xaiSpeakerAvatar">' +
        '<div id="xaiAvatarSlot" style="display:flex;align-items:center;justify-content:center;width:100%;height:100%;"></div>' +
        '<div class="xai-status-dot"></div>' +
      '</div>' +
      // Middle text column
      '<div class="xai-dialogue-copy">' +
        '<div class="xai-speaker-name-row">' +
          '<span class="xai-speaker-label">XRPMAN AI</span>' +
          '<span class="xai-online-label">· ASSISTANT ONLINE</span>' +
        '</div>' +
        '<div class="xai-typed-row">' +
          '<span id="xaiTypedLine"></span>' +
          '<span class="xai-cursor hidden"></span>' +
        '</div>' +
      '</div>' +
      // Skip / next button on the far right
      '<button type="button" class="xai-skip-btn" id="xaiSkipBtn" title="Next message" aria-label="Skip to next line">' +
        '<svg viewBox="0 0 24 24" aria-hidden="true">' +
          '<path d="M5 4 L15 12 L5 20 Z M16 4 L19 4 L19 20 L16 20 Z"/>' +
        '</svg>' +
      '</button>';

    // ── FX layer
    var fx = document.createElement('div');
    fx.className = 'swe-fx';
    fx.innerHTML =
      '<div class="swe-fx-pulse"></div>' +
      '<div class="swe-fx-bolt b1"></div>' +
      '<div class="swe-fx-bolt b2"></div>' +
      '<div class="swe-fx-bolt b3"></div>';

    room.insertBefore(fx, room.firstChild);
    room.insertBefore(dialogue, room.firstChild);
    room.insertBefore(titleStack, room.firstChild);

    // Re-parent the robot into the avatar slot
    var slot = document.getElementById('xaiAvatarSlot');
    if (slot && robot) {
      slot.appendChild(robot);
      robot.style.display = '';
    }

    // Wire the skip button — advance the queue or replay a phase line
    var skipBtn = document.getElementById('xaiSkipBtn');
    if (skipBtn) {
      skipBtn.addEventListener('click', function() {
        if (_queue.length) {
          // Cancel current typing and jump to next queued
          if (_typingTimer) { clearInterval(_typingTimer); _typingTimer = null; }
          if (_holdTimer)   { clearTimeout(_holdTimer); _holdTimer = null; }
          var next = _queue.shift();
          xaiTypeLine(next.text, next.options || {});
        } else {
          // Idle skip — speak a random tactical line
          var idlePool = [
            'Ledger network stable. Awaiting orders.',
            'Standing by for the next scan.',
            'All systems nominal, Commander.',
            'Pattern memory ready. Evidence buffer clear.',
            'Watchlist green. Ready when you are.'
          ];
          xaiQueueDialogue(idlePool[Math.floor(Math.random() * idlePool.length)], 'IDLE');
        }
      });
    }

    room._v333eBuilt = true;
    try { console.log('[SW-v333e] Compact AI strip built'); } catch (_) {}
  }

  /* ─── Lifecycle dialogue ─────────────────────────────────── */
  var V333E_DIALOGUE = {
    SCAN_START:     'ShadowWatch is live. Initializing ledger sweep.',
    BALANCE_CHECK:  'Wallet grid connected. Reading balances across the watchlist.',
    FLOW:           'Tracking large transfers and receiver follow-through.',
    COUNTERPARTY:   'Counterparty graph forming. Checking cluster behavior.',
    NEWS:           'Public context scan active. Ledger evidence stays primary.',
    NEWS_STRONG:    'Evidence-led headlines cleared. Folding context into the report.',
    NEWS_DEGRADED:  'Signal degraded. Preserving evidence, marking the weak source.',
    DISCOVERY:      'Discovery loop active. Logging candidate wallets for review.',
    REPORT:         'Building Morning Story and evidence package.',
    SEAL:           'Sealing report. Hashes and exports are being prepared.',
    DONE:           'Scan complete. ShadowWatch report is ready.',
    ERROR:          'Signal degraded. Preserving evidence and marking the weak source.'
  };

  function _v333e_bindLifecycle() {
    if (window._v333eLifecycleBound) return;
    var bus = window.SHADOW_EVENT_BUS;
    if (!bus || typeof bus.on !== 'function') return;
    bus.on('shadow.scan.started',             function() { xaiQueueDialogue(V333E_DIALOGUE.SCAN_START,    'SCAN_START'); });
    bus.on('shadow.wallet.scan.started',      function() { xaiQueueDialogue(V333E_DIALOGUE.BALANCE_CHECK, 'BALANCE_CHECK'); });
    bus.on('shadow.balance.snapshot.started', function() { xaiQueueDialogue(V333E_DIALOGUE.BALANCE_CHECK, 'BALANCE_CHECK'); });
    bus.on('shadow.wallet.scan.completed',    function() { xaiQueueDialogue(V333E_DIALOGUE.FLOW,          'FLOW'); });
    bus.on('shadow.flow.analysis.started',    function() { xaiQueueDialogue(V333E_DIALOGUE.FLOW,          'FLOW'); });
    bus.on('shadow.receivers.scanned',        function() { xaiQueueDialogue(V333E_DIALOGUE.COUNTERPARTY,  'COUNTERPARTY'); });
    bus.on('shadow.news.lookup.started',      function() { xaiQueueDialogue(V333E_DIALOGUE.NEWS,          'NEWS'); });
    bus.on('shadow.news.evidence_led',        function() { xaiQueueDialogue(V333E_DIALOGUE.NEWS_STRONG,   'NEWS_STRONG'); });
    bus.on('shadow.news.degraded',            function() { xaiQueueDialogue(V333E_DIALOGUE.NEWS_DEGRADED, 'NEWS_DEGRADED'); });
    bus.on('shadow.candidate.promoted',       function() { xaiQueueDialogue(V333E_DIALOGUE.DISCOVERY,     'DISCOVERY'); });
    bus.on('shadow.report.building',          function() { xaiQueueDialogue(V333E_DIALOGUE.REPORT,        'REPORT'); });
    bus.on('shadow.report.sealed',            function() { xaiQueueDialogue(V333E_DIALOGUE.SEAL,          'SEAL'); });
    bus.on('shadow.scan.completed',           function() { xaiQueueDialogue(V333E_DIALOGUE.DONE,          'DONE'); });
    bus.on('shadow.error.scan_failed',        function() { xaiQueueDialogue(V333E_DIALOGUE.ERROR,         'ERROR'); });
    window._v333eLifecycleBound = true;
    try { console.log('[SW-v333e] Lifecycle dialogue bound'); } catch (_) {}
  }

  function _v333e_stampVersion() {
    try {
      var hudV = document.getElementById('hudVersion');
      if (hudV) hudV.textContent = V333E_VERSION;
      document.querySelectorAll('.dev-title').forEach(function(el) {
        if (/SHADOW WATCH v3\.3[23]/i.test(el.textContent)) {
          el.textContent = el.textContent.replace(
            /v3\.3[23][a-z]?-[a-z0-9-]+/g, V333E_VERSION);
        }
      });
    } catch (_) {}
  }

  function _v333e_boot() {
    _v333e_buildLayout();
    _v333e_bindLifecycle();
    _v333e_stampVersion();
    xaiClearDialogue();
  }

  function _v333e_start() {
    var tries = 0, max = 14;
    var iv = setInterval(function() {
      tries++;
      var room  = document.getElementById('xrpmanAiCommandRoom');
      var robot = document.getElementById('xaiAvatarShell');
      if (room && robot) {
        _v333e_boot();
        setTimeout(_v333e_buildLayout, 600);
        clearInterval(iv);
      } else if (tries >= max) {
        clearInterval(iv);
        try { console.warn('[SW-v333e] Gave up waiting for command room'); } catch (_) {}
      }
    }, 450);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', function() {
      setTimeout(_v333e_start, 300);
    });
  } else {
    setTimeout(_v333e_start, 300);
  }

  if (typeof window !== 'undefined') {
    window.SW_V333E = {
      version: V333E_VERSION,
      rebuild: _v333e_boot,
      buildLayout: _v333e_buildLayout,
      bindLifecycle: _v333e_bindLifecycle,
      DIALOGUE: V333E_DIALOGUE,
      typeLine: xaiTypeLine,
      clear: xaiClearDialogue,
      setSpeaking: xaiSetSpeaking,
      queue: xaiQueueDialogue
    };
  }

})();
