/* ═══════════════════════════════════════════════════════════════════
   SHADOW WATCH REPORT — MOBILE BACKGROUND SCAN SURVIVAL
   2026-08-24

   Android/iOS browsers may suspend a background tab and tear down WebSockets.
   A transient suspension must not be converted into 251 wallet failures.

   This layer is deliberately narrow:
   - only active Report scans are affected;
   - only read-only XRPL RPC calls are wrapped;
   - when hidden, the next ledger read parks until the page is executable again;
   - a read that fails during a background episode is retried after foreground
     reconnection before the caller is allowed to mark that wallet failed;
   - genuine foreground/network failures still propagate unchanged.

   This is scan-survival, not a claim that mobile browsers execute continuously
   while suspended. A future server-side durable runner can replace the pause.
   ═══════════════════════════════════════════════════════════════════ */
(function () {
  'use strict';

  var originalXrpl = null;
  try { if (typeof xrpl === 'function') originalXrpl = xrpl; } catch (_) {}
  if (!originalXrpl || originalXrpl._swBackgroundSurvival20260824) return;

  var backgroundEpoch = 0;
  var recoveryPending = false;
  var hiddenAt = null;
  var recoveryResetEpoch = -1;

  function scanState() {
    try { if (typeof state !== 'undefined' && state) return state; } catch (_) {}
    try { return window.__SHADOWWATCH_STATE__ || window.state || null; } catch (_) { return null; }
  }

  function isScanning() {
    var s = scanState();
    return !!(s && s.scanning === true);
  }

  function isHidden() {
    try { return document.visibilityState === 'hidden' || document.hidden === true; }
    catch (_) { return false; }
  }

  function note(msg) {
    try { if (typeof log === 'function') log(msg); else console.log('[SW-BG]', msg); }
    catch (_) {}
  }

  function markPaused(on) {
    var s = scanState();
    if (!s) return;
    try {
      s.background_scan_paused = !!on;
      s.background_scan_epoch = backgroundEpoch;
      s.background_scan_hidden_at = hiddenAt;
    } catch (_) {}
  }

  function waitForForeground() {
    if (!isHidden()) return Promise.resolve();
    return new Promise(function (resolve) {
      var done = false;
      function finish() {
        if (done || isHidden()) return;
        done = true;
        try { document.removeEventListener('visibilitychange', finish); } catch (_) {}
        try { window.removeEventListener('pageshow', finish); } catch (_) {}
        try { window.removeEventListener('focus', finish); } catch (_) {}
        resolve();
      }
      try { document.addEventListener('visibilitychange', finish); } catch (_) {}
      try { window.addEventListener('pageshow', finish); } catch (_) {}
      try { window.addEventListener('focus', finish); } catch (_) {}
    });
  }

  function prepareForegroundReconnect(epoch) {
    if (recoveryResetEpoch === epoch) return;
    recoveryResetEpoch = epoch;
    var s = scanState();
    if (!s) return;
    try {
      if (s._sock && s._sock.readyState !== 1) s._sock = null;
      s._reconnectFails = 0;
      // A reconnect promise created while the page was being suspended may have
      // already failed. Drop only that stale coordination state; the first
      // foreground retry will create the one shared reconnect used by all eight
      // parallel wallet workers.
      s._reconnecting = null;
    } catch (_) {}
  }

  function restoreFalseLinkLossIfBackgroundOnly(previousLost, previousAt) {
    if (previousLost) return;
    var s = scanState();
    if (!s) return;
    try {
      s.linkLostDuringScan = false;
      s.linkLostAt = previousAt || null;
    } catch (_) {}
  }

  function onVisibilityChange() {
    if (!isScanning()) return;
    if (isHidden()) {
      backgroundEpoch++;
      recoveryPending = true;
      hiddenAt = new Date().toISOString();
      markPaused(true);
      note('Report moved to background; ledger scan parked until foreground instead of failing wallets.');
    } else if (recoveryPending) {
      markPaused(true);
      note('Report foreground restored; reconnecting XRPL and resuming the parked ledger scan.');
    }
  }

  try { document.addEventListener('visibilitychange', onVisibilityChange); } catch (_) {}
  try { window.addEventListener('pageshow', onVisibilityChange); } catch (_) {}

  var wrapped = async function (ws, cmd) {
    var s = scanState();
    var previousLost = !!(s && s.linkLostDuringScan);
    var previousAt = s && s.linkLostAt || null;
    var startEpoch = backgroundEpoch;

    if (isScanning() && isHidden()) {
      recoveryPending = true;
      await waitForForeground();
      prepareForegroundReconnect(backgroundEpoch);
      ws = null;
    }

    try {
      var first = await originalXrpl(ws, cmd);
      if (recoveryPending && !isHidden()) {
        recoveryPending = false;
        markPaused(false);
      }
      return first;
    } catch (err) {
      var backgroundRelated = isScanning() &&
        (isHidden() || recoveryPending || backgroundEpoch !== startEpoch);
      if (!backgroundRelated) throw err;

      await waitForForeground();
      prepareForegroundReconnect(backgroundEpoch);

      try {
        // Read-only RPC replay. The Report never submits/signs transactions, and
        // retrying account_info/account_tx/ledger/offer reads is side-effect free.
        var retried = await originalXrpl(null, cmd);
        restoreFalseLinkLossIfBackgroundOnly(previousLost, previousAt);
        recoveryPending = false;
        markPaused(false);
        note('Background XRPL read recovered; scan resumed without converting suspension into a failed wallet.');
        return retried;
      } catch (retryErr) {
        // Foreground retry also failed. This is now a genuine connection failure;
        // keep the core engine's existing integrity guard and error semantics.
        recoveryPending = false;
        markPaused(false);
        throw retryErr;
      }
    }
  };

  wrapped._swBackgroundSurvival20260824 = true;
  wrapped._original = originalXrpl._original || originalXrpl;
  wrapped._swOriginal = originalXrpl;

  try { xrpl = wrapped; } catch (_) {}
  try { window.SW_REPORT_BACKGROUND_SURVIVAL = {
    version: '2026.08.24.1',
    mode: 'pause-reconnect-retry',
    getState: function () {
      return {
        scanning: isScanning(), hidden: isHidden(), epoch: backgroundEpoch,
        recovery_pending: recoveryPending, hidden_at: hiddenAt
      };
    }
  }; } catch (_) {}
})();
