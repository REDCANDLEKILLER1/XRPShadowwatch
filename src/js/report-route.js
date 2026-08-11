
    /* ── /report — a shareable address for the daily brief ──────────────────────
       shadowwatch.xyz/report opens the report the operator can hand to anyone,
       with no explanation attached.

       It is a REWRITE, not a second page: /report serves index.html, so a visitor
       gets the whole app — the real brief console in its iframe, the nav bar, the
       branding, every feature — and can tap HOME straight into the rest of it.
       There is no cut-down "share view" to keep in sync with the real one, which
       is the only version of this that cannot drift out of date.

       Two directions:
         · arriving AT /report      → boot straight into the brief
         · opening the brief in-app → the address bar becomes /report, so the link
                                      to share is just the URL you are already on

       Everything here is wrapped: if any of it throws, the app boots exactly as it
       did before this file existed. */
    (function () {
      'use strict';

      var PATH = '/report';
      var _home = null;                 // where we came from, to restore on exit
      var _syncing = false;             // guard against pushState ↔ popstate loops

      function onReportPath() {
        try {
          var p = (location.pathname || '').replace(/\/+$/, '') || '/';
          return p.toLowerCase() === PATH;
        } catch (_) { return false; }
      }

      function openBrief(autoRun) {
        try {
          if (typeof switchView === 'function') switchView('brief');
          if (typeof loadBriefConsole === 'function') loadBriefConsole();
          if (autoRun) runScanWhenReady();
        } catch (_) {}
      }

      // A visitor handed this link lands on the console the operator uses, which
      // opens IDLE and waits for RUN SHADOW WATCH — a button a stranger has no
      // reason to know to press. On the deep link we press it for them, so the
      // link delivers a report rather than a control panel.
      //
      // Deliberately the FULL console and not the stripped /ladyk reader: that
      // one says "no music, no graphics — just the report", and the whole point
      // of a link you hand out is that it shows the real thing.
      //
      // Runs once. The daily gate (src/brief/12-daily-gate.js) means a repeat
      // visit the same day replays the sealed report instead of re-scanning, and
      // the scan is the visitor's own browser talking to the ledger — a hundred
      // readers is a hundred independent page loads, not a hundred hits on us.
      function runScanWhenReady() {
        var fired = false, tries = 0;
        var t = setInterval(function () {
          if (fired || ++tries > 60) { clearInterval(t); return; }
          try {
            var frame = document.getElementById('brief-frame');
            var doc = frame && frame.contentDocument;
            var btn = doc && doc.getElementById('scanBtn');
            // Readiness is the HANDLER being bound, not the button being
            // visible. #scanBtn ships display:none — the cockpit draws its own
            // RUN SCAN on top and forwards to it — so waiting for it to become
            // visible waits forever. .click() fires onclick on a hidden element
            // just fine; what we must not do is click before the engine has
            // attached anything to it.
            if (btn && !btn.disabled && typeof btn.onclick === 'function') {
              fired = true; clearInterval(t);
              btn.click();
            }
          } catch (_) { /* frame not ready yet */ }
        }, 250);
      }

      // ── URL follows the view ────────────────────────────────────────────────
      // Wrapped rather than edited into switchView, the same non-invasive pattern
      // boot-greeter.js uses: the view logic keeps working untouched even if this
      // wrap is removed.
      function installUrlSync() {
        if (typeof window.switchView !== 'function' || window.switchView.__reportRoute) return false;
        var orig = window.switchView;
        window.switchView = function (id) {
          var r = orig.apply(this, arguments);
          if (!_syncing) {
            try {
              if (id === 'brief' && !onReportPath()) {
                _home = location.pathname + location.search;
                history.pushState({ swView: 'brief' }, '', PATH);
              } else if (id !== 'brief' && onReportPath()) {
                history.pushState({ swView: id }, '', _home || '/');
              }
            } catch (_) {}
          }
          return r;
        };
        window.switchView.__reportRoute = true;
        window.switchView.__original = orig;
        return true;
      }

      // Back/forward must do the obvious thing: back out of /report returns to
      // wherever the visitor was, and forward into it reopens the brief.
      window.addEventListener('popstate', function () {
        _syncing = true;
        try {
          if (onReportPath()) openBrief();
          else if (typeof switchView === 'function') {
            var vb = document.getElementById('view-brief');
            if (vb && vb.classList.contains('active')) switchView('home');
          }
        } catch (_) {}
        _syncing = false;
      });

      // ── arriving at /report ─────────────────────────────────────────────────
      // A visitor handed this link did not come for a lock screen or a first-run
      // walkthrough. The boot scanner still PLAYS — it is the app's signature and
      // takes under two seconds — it just runs itself instead of waiting for a
      // thumb that a stranger has no reason to know to hold. The tutorial is
      // suppressed for this visit only, in memory: nothing is written to storage,
      // so their next normal visit still gets the full first-run experience.
      function bootIntoReport() {
        try {
          _home = '/';

          // suppress the first-run tutorial for THIS page load only
          try {
            if (typeof window.checkTutorial === 'function' && !window.checkTutorial.__reportRoute) {
              var origCheck = window.checkTutorial;
              window.checkTutorial = function () { /* deep link: straight to the report */ };
              window.checkTutorial.__reportRoute = true;
              window.checkTutorial.__original = origCheck;
            }
          } catch (_) {}

          // run the biometric boot for them, then open the brief
          var pad = document.getElementById('thumb-scan');
          if (pad) {
            try { pad.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true })); }
            catch (_) { try { pad.click(); } catch (__) {} }
          }

          // finishBoot() fades the splash on its own timer; wait for it rather
          // than racing it, and fall back to opening regardless if it never fires
          // (a blocked asset must not cost the visitor the report).
          var tries = 0;
          var t = setInterval(function () {
            var sp = document.getElementById('splash-screen');
            var done = !sp || sp.dataset.done === '1' || sp.style.display === 'none';
            if (done || ++tries > 40) { clearInterval(t); openBrief(true); }
          }, 150);
        } catch (_) {
          openBrief(true);
        }
      }

      function init() {
        installUrlSync();
        if (onReportPath()) {
          history.replaceState({ swView: 'brief' }, '', PATH);
          bootIntoReport();
        }
      }

      // app.js defines switchView at parse time and this file loads after it, but
      // wait for DOM ready anyway so #thumb-scan and #view-brief exist.
      if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
      else init();

      window.SW_REPORT_ROUTE = {
        path: PATH,
        isActive: onReportPath,
        open: function (autoRun) { openBrief(!!autoRun); },
        shareUrl: function () { return location.origin + PATH; }
      };
    })();
