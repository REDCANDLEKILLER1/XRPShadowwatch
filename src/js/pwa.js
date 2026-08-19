/* PWA glue: register the service worker and offer an install affordance. */
(function () {
  'use strict';

  // DE-CACHE MODE: we no longer register a caching service worker (it kept
  // serving stale code during active development). Instead, force any worker a
  // user already has to re-check /sw.js — which is now a self-retiring worker
  // that clears caches and unregisters. We do NOT register a new one, so there
  // is no reload loop.
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.getRegistrations()
      .then(function (regs) { regs.forEach(function (r) { try { r.update(); } catch (e) {} }); })
      .catch(function () {});
  }

  var deferred = null;

  window.addEventListener('beforeinstallprompt', function (e) {
    e.preventDefault();        // suppress the mini-infobar; we provide our own button
    deferred = e;
    showInstall();
  });
  window.addEventListener('appinstalled', function () { deferred = null; hideInstall(); });

  function showInstall() {
    if (document.getElementById('pwa-install')) return;
    var b = document.createElement('button');
    b.id = 'pwa-install';
    b.textContent = '⊕ INSTALL APP';
    b.style.cssText = 'position:fixed;left:50%;transform:translateX(-50%);bottom:18px;z-index:9999;' +
      'background:#001100;color:#00ff00;border:1px solid #00ff00;border-radius:24px;padding:10px 18px;' +
      'font-family:"Orbitron",sans-serif;font-size:12px;letter-spacing:1px;cursor:pointer;' +
      'box-shadow:0 0 18px rgba(0,255,0,0.4);';
    b.addEventListener('click', function () {
      if (!deferred) return;
      deferred.prompt();
      deferred.userChoice.finally(function () { deferred = null; hideInstall(); });
    });
    document.body.appendChild(b);
    setTimeout(hideInstall, 12000); // show briefly, don't nag
  }
  function hideInstall() { var b = document.getElementById('pwa-install'); if (b) b.remove(); }
})();

/* ═══════════════════════════════════════════════════════════════════
   SHADOW WATCH MAIN APP — VERIFIED LIVE UPLINK
   2026-08-17

   The legacy live app marked a WebSocket ACTIVE as soon as TCP/WebSocket opened.
   That is not proof the XRPL subscription is actually producing ledger data.
   LIVE, BUBBLE MAP, GRAPH/HISTORY, HVT balance reads, risk and escrow helpers all
   share this socket, so an open-but-silent stream makes the whole main app look
   dead at once.

   This layer keeps app.js's existing message router intact and only hardens the
   transport boundary:
     • explicitly subscribe with XRPL API v1 (the shape app.js was written for),
     • accept API v2 tx_json transaction notifications too,
     • do not display ACTIVE until the subscription/ledger actually responds,
     • rotate to the next configured XRPL server if no ledger data arrives,
     • preserve every existing id-based response route in app.js.

   Read-only. No signing, submit, trading, scanner or report logic is touched.
   ═══════════════════════════════════════════════════════════════════ */
(function () {
  'use strict';

  var VERSION = '2026.08.17.1';
  var NO_DATA_MS = 14000; // ledger stream should speak well inside this window
  var generation = 0;
  var currentTimer = null;
  var lastReason = null;
  var lastServer = null;
  var streamMessages = 0;
  var txMessages = 0;
  var ledgerMessages = 0;
  var subscribeAcks = 0;
  var failovers = 0;
  var lastStreamAt = null;
  var lastHandlerError = null;

  var originalStart = null;
  try { originalStart = (typeof startXRPL === 'function') ? startXRPL : null; } catch (_) {}
  if (!originalStart) return;
  if (originalStart._swVerifiedUplink20260817) return;

  function statusEl() {
    try { return document.getElementById('status-text'); } catch (_) { return null; }
  }
  function feedEl() {
    try { return document.getElementById('feed'); } catch (_) { return null; }
  }
  function setStatus(text, mode) {
    try {
      var el = statusEl();
      if (!el) return;
      el.innerText = text;
      el.classList.remove('text-yellow-500', 'text-green-500', 'text-red-500');
      if (mode === 'ok') el.classList.add('text-green-500');
      else if (mode === 'bad') el.classList.add('text-red-500');
      else el.classList.add('text-yellow-500');
    } catch (_) {}
  }
  function serverName(url) {
    try { return String(url || '').split('//')[1].split('/')[0].toUpperCase(); }
    catch (_) { return 'XRPL'; }
  }
  function clearNoDataTimer() {
    if (currentTimer) { clearTimeout(currentTimer); currentTimer = null; }
  }
  function showLiveWaiting() {
    try {
      var f = feedEl();
      if (!f) return;
      if (String(f.innerText || '').indexOf('AWAITING') >= 0) {
        f.innerHTML = '<div style="padding:36px 14px;text-align:center;color:#1c6b38;letter-spacing:2px;font-family:\'Share Tech Mono\',monospace;">UPLINK LIVE // WAITING FOR NEXT TRANSACTION...</div>';
      }
    } catch (_) {}
  }
  function markStream(kind, srv) {
    clearNoDataTimer();
    streamMessages++;
    lastStreamAt = new Date().toISOString();
    if (kind === 'tx') txMessages++;
    if (kind === 'ledger') ledgerMessages++;
    try { isConnected = true; } catch (_) {}
    try { lastHeartbeat = Date.now(); } catch (_) {}
    setStatus('ACTIVE [' + serverName(srv) + ']', 'ok');
    if (kind === 'ledger') showLiveWaiting();
  }

  function rotateSilentSocket(ws, myGeneration, reason) {
    if (myGeneration !== generation) return;
    try { if (socket !== ws) return; } catch (_) { return; }
    lastReason = reason || 'silent stream';
    failovers++;
    setStatus('NO LEDGER DATA — REROUTING...', 'warn');
    try {
      ws.onclose = null;
      ws.onerror = null;
      ws.onmessage = null;
      ws.onopen = null;
      ws.close();
    } catch (_) {}
    try { socket = null; } catch (_) {}
    try { currentServerIndex = (currentServerIndex + 1) % XRPL_SERVERS.length; } catch (_) {}
    setTimeout(function () {
      if (myGeneration !== generation) return;
      try { startXRPL(); } catch (_) {}
    }, 700);
  }

  function patchSocket(ws, myGeneration) {
    if (!ws || ws._swVerifiedUplink20260817) return;
    ws._swVerifiedUplink20260817 = true;

    var oldMessage = ws.onmessage;
    var oldClose = ws.onclose;
    var oldError = ws.onerror;
    var srv = '';
    try { srv = XRPL_SERVERS[currentServerIndex]; } catch (_) {}
    lastServer = srv || null;

    function armNoData() {
      clearNoDataTimer();
      currentTimer = setTimeout(function () {
        rotateSilentSocket(ws, myGeneration, 'no ledger/transaction stream within ' + NO_DATA_MS + 'ms');
      }, NO_DATA_MS);
    }

    // Do not call app.js's old onopen: it declared ACTIVE before receiving any
    // subscription acknowledgement or ledger message. Send the same subscription
    // explicitly as API v1 and prove the stream before showing ACTIVE.
    ws.onopen = function () {
      if (myGeneration !== generation) return;
      try { lastHeartbeat = Date.now(); } catch (_) {}
      setStatus('UPLINK [' + serverName(srv) + '] — SUBSCRIBING...', 'warn');
      armNoData();
      try {
        ws.send(JSON.stringify({
          id: 'sw_live_sub_' + myGeneration,
          command: 'subscribe',
          api_version: 1,
          streams: ['transactions', 'ledger']
        }));
      } catch (e) {
        rotateSilentSocket(ws, myGeneration, 'subscribe send failed');
      }
    };

    ws.onmessage = function (event) {
      if (myGeneration !== generation) return;
      var d = null;
      try { d = JSON.parse(event.data); } catch (_) {}

      // Any real server message proves the socket is not transport-dead, but only
      // a successful subscription or stream event graduates the UI to ACTIVE.
      try { lastHeartbeat = Date.now(); } catch (_) {}

      if (d && d.type === 'response' && String(d.id || '').indexOf('sw_live_sub_') === 0) {
        if (d.status === 'success') {
          subscribeAcks++;
          setStatus('SUBSCRIBED [' + serverName(srv) + '] — WAITING FOR LEDGER...', 'warn');
          // Keep the no-data timer armed until an actual ledger/tx event arrives.
        } else {
          rotateSilentSocket(ws, myGeneration, 'XRPL subscribe rejected: ' + (d.error || d.error_message || 'unknown'));
          return;
        }
      }

      // XRPL direct WebSocket defaults to API v1, but normalize API v2 transaction
      // notifications as well so a server/proxy version change cannot blank LIVE.
      var eventForLegacy = event;
      if (d && d.type === 'transaction' && !d.transaction && d.tx_json) {
        var normalized = {};
        Object.keys(d).forEach(function (k) { normalized[k] = d[k]; });
        normalized.transaction = d.tx_json;
        if (!normalized.meta && d.metadata) normalized.meta = d.metadata;
        try {
          if (normalized.hash && !normalized.transaction.hash) normalized.transaction.hash = normalized.hash;
          if (normalized.ledger_index != null && normalized.transaction.ledger_index == null) normalized.transaction.ledger_index = normalized.ledger_index;
        } catch (_) {}
        eventForLegacy = { data: JSON.stringify(normalized) };
        d = normalized;
      }

      if (d && d.type === 'ledgerClosed') markStream('ledger', srv);
      if (d && d.type === 'transaction') markStream('tx', srv);

      // app.js already owns all request-id routing (trace_, hist_, bal_, cvol_,
      // risk_, esc_) plus the transaction processor. Preserve it verbatim.
      if (typeof oldMessage === 'function') {
        try { oldMessage.call(ws, eventForLegacy); }
        catch (e) {
          lastHandlerError = String(e && (e.stack || e.message) || e);
          try { console.error('[ShadowWatch live router]', e); } catch (_) {}
        }
      }
    };

    ws.onerror = function (event) {
      lastReason = 'websocket error';
      setStatus('UPLINK ERROR [' + serverName(srv) + '] — WAITING FOR FAILOVER...', 'warn');
      if (typeof oldError === 'function') { try { oldError.call(ws, event); } catch (_) {} }
    };

    ws.onclose = function (event) {
      clearNoDataTimer();
      if (myGeneration !== generation) return;
      if (typeof oldClose === 'function') {
        try { oldClose.call(ws, event); return; } catch (_) {}
      }
      try { retryConnection(); } catch (_) {}
    };

    // If this layer arrived after app.js already opened the socket, prove the
    // existing connection immediately instead of waiting for another reconnect.
    try {
      if (ws.readyState === WebSocket.OPEN) {
        setStatus('UPLINK [' + serverName(srv) + '] — VERIFYING...', 'warn');
        armNoData();
        ws.send(JSON.stringify({
          id: 'sw_live_sub_' + myGeneration,
          command: 'subscribe',
          api_version: 1,
          streams: ['transactions', 'ledger']
        }));
      }
    } catch (_) {}
  }

  function verifiedStartXRPL() {
    generation++;
    clearNoDataTimer();
    var myGeneration = generation;
    try { originalStart.apply(this, arguments); } catch (e) {
      lastReason = 'legacy start failed: ' + String(e && e.message || e);
      setStatus('UPLINK START FAILED — REROUTING...', 'bad');
      try { retryConnection(); } catch (_) {}
      return;
    }
    try { patchSocket(socket, myGeneration); } catch (e) {
      lastReason = 'socket patch failed: ' + String(e && e.message || e);
    }
  }
  verifiedStartXRPL._swVerifiedUplink20260817 = true;
  verifiedStartXRPL._swOriginal = originalStart;

  try { startXRPL = verifiedStartXRPL; } catch (_) {}
  try { window.startXRPL = verifiedStartXRPL; } catch (_) {}

  // Patch an already-created socket too (normally pwa.js loads before activation,
  // but this makes refresh/route timing deterministic).
  try {
    if (socket) {
      generation++;
      patchSocket(socket, generation);
    }
  } catch (_) {}

  window.SW_LIVE_UPLINK_20260817 = {
    installed: true,
    version: VERSION,
    read_only: true,
    api_v1_subscription: true,
    api_v2_transaction_compatible: true,
    no_data_failover_ms: NO_DATA_MS,
    stats: function () {
      var ready = null;
      try { ready = socket ? socket.readyState : null; } catch (_) {}
      return {
        generation: generation,
        socket_ready_state: ready,
        server: lastServer,
        stream_messages: streamMessages,
        ledger_messages: ledgerMessages,
        transaction_messages: txMessages,
        subscribe_acks: subscribeAcks,
        failovers: failovers,
        last_stream_at: lastStreamAt,
        last_reason: lastReason,
        last_handler_error: lastHandlerError
      };
    }
  };
})();
