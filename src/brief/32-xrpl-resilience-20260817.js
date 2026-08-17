/* ═══════════════════════════════════════════════════════════════════════════
   XRPL TRANSPORT + RIPPLE ESCROW RESILIENCE — 2026-08-17

   Evidence-backed repair for SW-20260817-Q5S3W.
   That run completed 241/241 wallet reads, then all three configured WebSocket
   transports failed during reconnect. Offers/next-hop were skipped and the
   isolated Ripple escrow position scan ended 0/20.

   This layer is read-only. It does not alter scanner lookback, pagination,
   scoring, wallet classification, watchlist membership, transaction filters,
   ledger math, signing, submit, or trading behavior.
   ═══════════════════════════════════════════════════════════════════════════ */
(function () {
  'use strict';

  var VERSION = '2026.08.17.1';
  var HONEY = 'wss://honeycluster.io/';
  var CONNECT_ATTEMPT_MS = 6000;
  var MAIN_RECONNECT_BUDGET_MS = 30000;
  var ESCROW_SERVER_BUDGET_MS = 10000;
  var ESCROW_TOTAL_BUDGET_MS = 32000;
  var ESCROW_CONCURRENCY = 5;

  function logMsg(msg) {
    try { if (typeof log === 'function') log(msg); } catch (_) {}
  }
  function errMsg(label, err) {
    try { if (typeof elog === 'function') elog(label, err); } catch (_) {}
  }
  function uniq(xs) {
    var out = [];
    (xs || []).forEach(function (x) {
      if (x && out.indexOf(x) < 0) out.push(x);
    });
    return out;
  }
  function remaining(deadline) { return Math.max(0, deadline - Date.now()); }
  function delay(ms) { return new Promise(function (resolve) { setTimeout(resolve, ms); }); }

  function connectOne(server, timeoutMs) {
    return new Promise(function (resolve, reject) {
      var ws = null, done = false;
      var wait = Math.max(500, Math.min(CONNECT_ATTEMPT_MS, Number(timeoutMs) || CONNECT_ATTEMPT_MS));
      var timer = setTimeout(function () {
        if (done) return;
        done = true;
        try { if (ws) ws.close(); } catch (_) {}
        reject(new Error('connect timeout ' + server));
      }, wait);
      function finish(err, value) {
        if (done) return;
        done = true;
        clearTimeout(timer);
        if (err) reject(err); else resolve(value);
      }
      try {
        ws = new WebSocket(server);
        ws.onopen = function () { finish(null, ws); };
        ws.onerror = function () { finish(new Error('ws error ' + server)); };
        ws.onclose = function () { if (!done) finish(new Error('socket closed before open ' + server)); };
      } catch (e) { finish(e); }
    });
  }

  try {
    if (typeof connectXRPL === 'function' && !connectXRPL._swResilience20260817) {
      var originalConnectXRPL = connectXRPL;
      var resilientConnectXRPL = async function () {
        var preferred = null;
        try {
          var el = (typeof $ === 'function') ? $('xrplServer') : document.getElementById('xrplServer');
          preferred = el && el.value;
        } catch (_) {}
        var base = [];
        try { if (typeof XRPL_SERVERS !== 'undefined' && Array.isArray(XRPL_SERVERS)) base = XRPL_SERVERS.slice(); } catch (_) {}
        var servers = uniq([preferred, HONEY].concat(base).concat([
          'wss://xrplcluster.com', 'wss://s1.ripple.com', 'wss://s2.ripple.com'
        ]));
        var deadline = Date.now() + MAIN_RECONNECT_BUDGET_MS;
        var rounds = 0;
        var lastErr = null;
        while (remaining(deadline) > 500 && rounds < 2) {
          rounds++;
          for (var i = 0; i < servers.length; i++) {
            var left = remaining(deadline);
            if (left <= 500) break;
            var server = servers[i];
            try {
              var ws = await connectOne(server, Math.min(CONNECT_ATTEMPT_MS, left));
              logMsg('XRPL connected: ' + server + (rounds > 1 ? ' · retry round ' + rounds : ''));
              try {
                window.SW_XRPL_RESILIENCE_20260817.last_transport = server;
                window.SW_XRPL_RESILIENCE_20260817.last_connect_at = new Date().toISOString();
              } catch (_) {}
              return ws;
            } catch (e) {
              lastErr = e;
              errMsg('XRPL resilient server failed, trying next: ' + server, e);
            }
          }
          if (rounds < 2 && remaining(deadline) > 1000) await delay(650);
        }
        throw new Error('All XRPL servers failed' + (lastErr && lastErr.message ? ': ' + lastErr.message : ''));
      };
      resilientConnectXRPL._swResilience20260817 = true;
      resilientConnectXRPL._swOriginal = originalConnectXRPL;
      try { connectXRPL = resilientConnectXRPL; } catch (_) {}
      try { window.connectXRPL = resilientConnectXRPL; } catch (_) {}
    }
  } catch (_) {}

  function rpc(ws, command, timeoutMs) {
    return new Promise(function (resolve, reject) {
      var id = 'sw_res_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2);
      var done = false;
      var wait = Math.max(500, Number(timeoutMs) || 5000);
      var timer = setTimeout(function () { finish(new Error('timeout ' + command.command)); }, wait);
      function cleanup() {
        clearTimeout(timer);
        try { ws.removeEventListener('message', onMessage); } catch (_) {}
        try { ws.removeEventListener('close', onClose); } catch (_) {}
      }
      function finish(err, value) {
        if (done) return;
        done = true;
        cleanup();
        if (err) reject(err); else resolve(value);
      }
      function onClose() { finish(new Error('socket closed')); }
      function onMessage(ev) {
        var d;
        try { d = JSON.parse(ev.data); } catch (_) { return; }
        if (!d || String(d.id || '') !== id) return;
        if (d.status === 'error' || d.error || (d.result && d.result.error)) {
          finish(new Error(d.error_message || d.error || (d.result && d.result.error_message) || 'XRPL error'));
          return;
        }
        finish(null, d.result || {});
      }
      try {
        ws.addEventListener('message', onMessage);
        ws.addEventListener('close', onClose);
        ws.send(JSON.stringify(Object.assign({}, command, { id:id })));
      } catch (e) { finish(e); }
    });
  }

  async function mapPool(items, limit, worker) {
    var next = 0;
    async function run() {
      while (true) {
        var i = next++;
        if (i >= items.length) return;
        await worker(items[i], i);
      }
    }
    var jobs = [];
    for (var n = 0; n < Math.min(limit, items.length); n++) jobs.push(run());
    await Promise.all(jobs);
  }

  function amountXrp(o) {
    if (!o || typeof o.Amount !== 'string' || !/^\d+$/.test(o.Amount)) return null;
    return Number(o.Amount) / 1e6;
  }

  async function scanEscrowServer(server, addresses, globalDeadline) {
    var serverDeadline = Math.min(globalDeadline, Date.now() + ESCROW_SERVER_BUDGET_MS);
    var ws = null, objectMap = {}, ownerDone = {}, failures = [], ledger = null;
    var started = Date.now();
    try {
      var left = remaining(serverDeadline);
      if (left <= 500) throw new Error('server budget exhausted before connect');
      ws = await connectOne(server, Math.min(CONNECT_ATTEMPT_MS, left));
      await mapPool(addresses, ESCROW_CONCURRENCY, async function (address) {
        if (remaining(serverDeadline) <= 500) {
          failures.push({ address:address, error:'server budget exceeded' });
          return;
        }
        try {
          var marker = null;
          do {
            var req = { command:'account_objects', account:address, type:'escrow', ledger_index:'validated', limit:400 };
            if (marker) req.marker = marker;
            var res = await rpc(ws, req, Math.max(500, remaining(serverDeadline)));
            if (res && res.ledger_index) ledger = res.ledger_index;
            (res && res.account_objects || []).forEach(function (o, idx) {
              if (!o || (o.LedgerEntryType && o.LedgerEntryType !== 'Escrow')) return;
              if (!o.Account || String(o.Account) !== String(address)) return;
              var key = o.index || o.LedgerIndex || o.Index || [address, o.Sequence, o.Amount, o.FinishAfter, idx].join(':');
              objectMap[key] = o;
            });
            marker = res && res.marker || null;
          } while (marker && remaining(serverDeadline) > 500);
          if (marker) throw new Error('pagination cut by server budget');
          ownerDone[address] = true;
        } catch (e) {
          failures.push({ address:address, error:String(e && e.message || e) });
        }
      });
    } finally {
      try { if (ws) ws.close(); } catch (_) {}
    }
    var locked = 0, active = 0, nonXrp = 0;
    Object.keys(objectMap).forEach(function (k) {
      var amt = amountXrp(objectMap[k]);
      if (amt == null) { nonXrp++; return; }
      locked += amt; active++;
    });
    var answered = Object.keys(ownerDone).length;
    return {
      server:server,
      answered:answered,
      failures:failures,
      locked:locked,
      active:active,
      nonXrp:nonXrp,
      ledger:ledger,
      duration_ms:Date.now() - started,
      complete:answered === addresses.length && failures.length === 0
    };
  }

  var escrowRetryJob = null;
  async function resilientEscrowPosition() {
    if (escrowRetryJob) return escrowRetryJob;
    escrowRetryJob = (async function () {
      var reg = window.SW_RIPPLE_ESCROW_REGISTRY;
      var addresses = reg && Array.isArray(reg.addresses) ? reg.addresses.slice() : [];
      if (!addresses.length) return null;
      var started = Date.now();
      var deadline = started + ESCROW_TOTAL_BUDGET_MS;
      var servers = uniq([HONEY, 'wss://xrplcluster.com', 'wss://s1.ripple.com', 'wss://s2.ripple.com']);
      var attempts = [], best = null;
      for (var i = 0; i < servers.length && remaining(deadline) > 500; i++) {
        try {
          var r = await scanEscrowServer(servers[i], addresses, deadline);
          attempts.push({ server:r.server, answered_owners:r.answered, failed_owners:r.failures.length, duration_ms:r.duration_ms });
          if (!best || r.answered > best.answered) best = r;
          if (r.complete) { best = r; break; }
        } catch (e) {
          attempts.push({ server:servers[i], answered_owners:0, failed_owners:addresses.length, error:String(e && e.message || e) });
        }
      }
      if (!best || !best.complete) {
        logMsg('Ripple escrow resilience retry incomplete: ' + (best ? best.answered : 0) + '/' + addresses.length + ' owners.');
        return null;
      }
      var position = {
        version:VERSION,
        source:'validated XRPL account_objects via isolated resilient read-only connection; Ripple public escrow registry; owner-only Escrow.Account filter',
        registry_version:reg.version || null,
        expected_owners:addresses.length,
        answered_owners:best.answered,
        failed_owners:0,
        failed_addresses:[],
        active_objects:best.active,
        non_xrp_objects:best.nonXrp,
        locked_xrp:best.locked,
        observed_locked_xrp_partial:best.locked,
        complete:true,
        status:'COMPLETE',
        ledger_index:best.ledger,
        transport:best.server,
        attempts:attempts,
        resilience_retry:true,
        duration_ms:Date.now() - started,
        checked_at:new Date().toISOString()
      };
      try { state.rippleEscrowPosition = position; } catch (_) {}
      try { window.SW_XRPL_RESILIENCE_20260817.last_escrow_transport = best.server; } catch (_) {}
      logMsg('Ripple escrow resilience retry complete: ' + best.locked.toLocaleString(undefined,{maximumFractionDigits:0}) +
        ' XRP · ' + best.active + ' active object(s) · ' + best.answered + '/' + addresses.length + ' owners · ' + best.server);
      return position;
    })();
    try { return await escrowRetryJob; }
    finally { escrowRetryJob = null; }
  }

  try {
    if (typeof escrowBackfill === 'function' && !escrowBackfill._swResilience20260817) {
      var originalEscrowBackfill = escrowBackfill;
      var resilientEscrowBackfill = async function (ws) {
        var result = await originalEscrowBackfill(ws);
        var pos = null;
        try { pos = state && state.rippleEscrowPosition; } catch (_) {}
        if (!pos || !pos.complete) {
          try { await resilientEscrowPosition(); } catch (e) { errMsg('Ripple escrow resilience retry', e); }
        }
        try { return (state && state.rippleEscrowPosition) || result; } catch (_) { return result; }
      };
      resilientEscrowBackfill._swResilience20260817 = true;
      resilientEscrowBackfill._swOriginal = originalEscrowBackfill;
      try { escrowBackfill = resilientEscrowBackfill; } catch (_) {}
      try { window.escrowBackfill = resilientEscrowBackfill; } catch (_) {}
    }
  } catch (_) {}

  window.SW_XRPL_RESILIENCE_20260817 = {
    version:VERSION,
    read_only:true,
    honeycluster_fallback:true,
    main_reconnect_budget_ms:MAIN_RECONNECT_BUDGET_MS,
    escrow_server_budget_ms:ESCROW_SERVER_BUDGET_MS,
    escrow_total_budget_ms:ESCROW_TOTAL_BUDGET_MS,
    escrow_retry:resilientEscrowPosition,
    scanner_math_untouched:true,
    lookback_untouched:true,
    pagination_policy_untouched:true,
    scoring_untouched:true,
    watchlist_untouched:true,
    no_auto_add:true,
    no_signing:true,
    no_submit:true,
    no_trading:true,
    last_transport:null,
    last_connect_at:null,
    last_escrow_transport:null
  };
})();
