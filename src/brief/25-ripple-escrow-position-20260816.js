/* ═══════════════════════════════════════════════════════════════════
   RIPPLE ESCROW POSITION — 2026-08-17
   Read-only Report scanner layer.

   CURRENT POSITION is intentionally isolated from the Report's busy scan
   websocket. A short-lived read-only XRPL connection queries validated Escrow
   objects owned by Ripple's 20 published public escrow wallets. Recent escrow
   activity still comes from the normal Report pipeline.

   No signing, submit, trading, watchlist mutation, or remote writes.
   ═══════════════════════════════════════════════════════════════════ */
(function () {
  'use strict';

  var VERSION = '2026.08.17.2';
  var REGISTRY_SRC = '/src/shared/ripple-escrow-registry.js?v=20260816.2';
  var SERVERS = ['wss://xrplcluster.com', 'wss://s1.ripple.com', 'wss://s2.ripple.com'];
  var CONNECT_TIMEOUT_MS = 6500;
  var RPC_TIMEOUT_MS = 8500;
  var POSITION_BUDGET_MS = 12000; // Never let current-position enrichment hold the Report open indefinitely.
  var CONCURRENCY = 5;

  function registry() { return window.SW_RIPPLE_ESCROW_REGISTRY || null; }

  function loadRegistry(done) {
    if (registry()) { done(registry()); return; }
    var old = document.querySelector('script[data-sw-ripple-escrow-registry]');
    if (old) {
      old.addEventListener('load', function () { done(registry()); }, { once:true });
      return;
    }
    var s = document.createElement('script');
    s.src = REGISTRY_SRC;
    s.async = false;
    s.setAttribute('data-sw-ripple-escrow-registry', '2026.08.16.2');
    s.addEventListener('load', function () { done(registry()); }, { once:true });
    (document.head || document.documentElement).appendChild(s);
  }

  function amountXrp(o) {
    if (!o || typeof o.Amount !== 'string' || !/^\d+$/.test(o.Amount)) return null;
    return Number(o.Amount) / 1e6;
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

  function connect(server, timeoutMs) {
    return new Promise(function (resolve, reject) {
      var settled = false;
      var ws;
      var wait = Math.max(250, Math.min(CONNECT_TIMEOUT_MS, Number(timeoutMs) || CONNECT_TIMEOUT_MS));
      var timer = setTimeout(function () {
        if (settled) return;
        settled = true;
        try { if (ws) ws.close(); } catch (_) {}
        reject(new Error('connect timeout'));
      }, wait);
      try {
        ws = new WebSocket(server);
      } catch (e) {
        clearTimeout(timer);
        reject(e);
        return;
      }
      ws.onopen = function () {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(ws);
      };
      ws.onerror = function () {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        reject(new Error('websocket error'));
      };
      ws.onclose = function () {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        reject(new Error('socket closed before open'));
      };
    });
  }

  function rpc(ws, command, timeoutMs) {
    return new Promise(function (resolve, reject) {
      var id = 'swrep_pos_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2);
      var done = false;
      var wait = Math.max(250, Math.min(RPC_TIMEOUT_MS, Number(timeoutMs) || RPC_TIMEOUT_MS));
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

  function install(reg) {
    if (!reg || !Array.isArray(reg.addresses) || !reg.addresses.length) return;
    if (window.SW_RIPPLE_ESCROW_POSITION_20260816 &&
        window.SW_RIPPLE_ESCROW_POSITION_20260816.installed &&
        window.SW_RIPPLE_ESCROW_POSITION_20260816.version === VERSION) return;

    var addresses = reg.addresses.slice();
    var lastPosition = null;
    var currentJob = null;
    var originalEscrowBackfill = null;
    try { originalEscrowBackfill = escrowBackfill; } catch (_) {}

    function remaining(deadline) {
      return Math.max(0, Number(deadline || 0) - Date.now());
    }

    async function fetchObjectsFor(ws, address, objectMap, deadline) {
      var marker = null;
      var ledger = null;
      do {
        var left = remaining(deadline);
        if (left <= 0) throw new Error('position budget exceeded');
        var req = { command:'account_objects', account:address, type:'escrow', ledger_index:'validated', limit:400 };
        if (marker) req.marker = marker;
        var res = await rpc(ws, req, left);
        if (res && res.ledger_index) ledger = res.ledger_index;
        (res && res.account_objects || []).forEach(function (o, i) {
          if (!o || (o.LedgerEntryType && o.LedgerEntryType !== 'Escrow')) return;
          // account_objects can include objects where this wallet is only the
          // destination. Ripple CURRENT POSITION counts owner objects only.
          if (!o.Account || String(o.Account) !== String(address)) return;
          var key = o.index || o.LedgerIndex || o.Index ||
            [address, o.Sequence, o.Amount, o.FinishAfter, i].join(':');
          objectMap[key] = o;
        });
        marker = res && res.marker || null;
      } while (marker);
      return ledger;
    }

    async function attemptServer(server, deadline) {
      var ws = null;
      var objectMap = {};
      var ownerDone = {};
      var failures = [];
      var validatedLedger = null;
      var started = Date.now();
      try {
        var left = remaining(deadline);
        if (left <= 0) throw new Error('position budget exceeded');
        ws = await connect(server, left);
        await mapPool(addresses, CONCURRENCY, async function (address) {
          if (remaining(deadline) <= 0) {
            failures.push({ address:address, error:'position budget exceeded' });
            return;
          }
          try {
            var ledger = await fetchObjectsFor(ws, address, objectMap, deadline);
            ownerDone[address] = true;
            if (ledger) validatedLedger = ledger;
          } catch (e) {
            failures.push({ address:address, error:String(e && e.message || e) });
          }
        });
      } finally {
        try { if (ws) ws.close(); } catch (_) {}
      }

      // FOUR DIFFERENT NUMBERS, NAMED FOR WHAT THEY MEASURE.
      //   addresses.length  registry addresses we asked about        (20)
      //   answered          how many of those RPCs came back         (20)
      //   active            escrow OBJECTS holding XRP               (100)
      //   activeOwners      DISTINCT owners holding >=1 such object  (8)
      // The first three existed; the fourth did not, and `answered` was being
      // rendered with the noun "owners" — an RPC-success count dressed as an
      // ownership fact. o.Account is already on every stored object (the
      // owner-only filter above just proved it equals the queried address), so
      // the real owner count costs no extra RPC.
      var locked = 0, active = 0, nonXrp = 0;
      var ownersWithEscrow = {};
      Object.keys(objectMap).forEach(function (k) {
        var o = objectMap[k];
        var amt = amountXrp(o);
        if (amt == null) { nonXrp++; return; }
        locked += amt;
        active++;
        if (o && o.Account) ownersWithEscrow[String(o.Account)] = true;
      });
      var answered = Object.keys(ownerDone).length;
      return {
        server:server,
        answered:answered,
        failures:failures,
        locked:locked,
        active:active,
        activeOwners:Object.keys(ownersWithEscrow).length,
        nonXrp:nonXrp,
        ledger:validatedLedger,
        duration_ms:Date.now() - started,
        complete:answered === addresses.length && failures.length === 0
      };
    }

    async function scanCurrentPosition() {
      if (currentJob) return currentJob;
      currentJob = (async function () {
        var started = Date.now();
        var deadline = started + POSITION_BUDGET_MS;
        var attempts = [];
        var best = null;

        for (var i = 0; i < SERVERS.length; i++) {
          if (remaining(deadline) <= 0) break;
          try {
            var result = await attemptServer(SERVERS[i], deadline);
            attempts.push({ server:result.server, answered_owners:result.answered, failed_owners:result.failures.length, duration_ms:result.duration_ms });
            if (!best || result.answered > best.answered) best = result;
            if (result.complete) { best = result; break; }
          } catch (e) {
            attempts.push({ server:SERVERS[i], answered_owners:0, failed_owners:addresses.length, error:String(e && e.message || e) });
          }
        }

        if (!best) best = { server:null, answered:0, failures:addresses.map(function (a) { return { address:a, error:'position budget expired before completion' }; }), locked:0, active:0, nonXrp:0, ledger:null, complete:false };
        var complete = !!best.complete;
        lastPosition = {
          version:VERSION,
          source:'validated XRPL account_objects via isolated read-only connection; Ripple public escrow registry; owner-only Escrow.Account filter',
          registry_version:reg.version || null,
          // Legacy names kept so existing consumers do not break; the
          // unambiguous names are the ones the canonical model reads.
          expected_owners:addresses.length,
          answered_owners:best.answered,
          registry_addresses_checked:addresses.length,
          rpc_responses_received:best.answered,
          failed_owners:complete ? 0 : Math.max(0, addresses.length - best.answered),
          failed_addresses:complete ? [] : best.failures.map(function (f) { return f.address; }),
          active_objects:best.active,
          // Distinct registry owners actually holding at least one XRP escrow
          // object right now. NOT the same as either count above.
          active_escrow_owners:(best.activeOwners != null ? best.activeOwners : null),
          non_xrp_objects:best.nonXrp,
          locked_xrp:complete ? best.locked : null,
          observed_locked_xrp_partial:best.locked,
          complete:complete,
          status:complete ? 'COMPLETE' : (best.answered ? 'PARTIAL' : 'FAILED'),
          ledger_index:best.ledger,
          transport:best.server,
          attempts:attempts,
          budget_ms:POSITION_BUDGET_MS,
          budget_exhausted:Date.now() >= deadline && !complete,
          duration_ms:Date.now() - started,
          checked_at:new Date().toISOString()
        };
        try { state.rippleEscrowPosition = lastPosition; } catch (_) {}
        try {
          log('Ripple escrow current position: ' + (complete
            ? (lastPosition.locked_xrp.toLocaleString(undefined,{maximumFractionDigits:0}) + ' XRP · ' +
               lastPosition.active_objects + ' active object(s) · ' +
               (lastPosition.active_escrow_owners != null ? lastPosition.active_escrow_owners : '?') + ' owner(s) holding · ' +
               lastPosition.rpc_responses_received + '/' + lastPosition.registry_addresses_checked +
               ' registry addresses answered · isolated XRPL')
            : (lastPosition.status + ' · ' + lastPosition.answered_owners + '/' + lastPosition.expected_owners + ' owners · amount withheld · ' + lastPosition.duration_ms + 'ms ceiling')));
        } catch (_) {}
        return lastPosition;
      })();
      try { return await currentJob; }
      finally { currentJob = null; }
    }

    // Preserve the normal Report escrow-event backfill exactly as-is. CURRENT
    // POSITION is still awaited, but it now has a strict total budget so it can
    // never hold the report at ~78–80% for minutes. If the 20-owner inventory
    // cannot be fully verified inside the budget, the amount is withheld and
    // the report continues with recent escrow activity intact.
    try {
      escrowWallets = function () { return addresses.slice(); };
      escrowBackfill = async function (ws) {
        var eventJob = (typeof originalEscrowBackfill === 'function')
          ? Promise.resolve().then(function () { return originalEscrowBackfill(ws); })
          : Promise.resolve();
        var positionJob = scanCurrentPosition();
        var settled = await Promise.allSettled([eventJob, positionJob]);
        if (settled[0].status === 'rejected') throw settled[0].reason;
        // Position failures are represented in lastPosition and never converted
        // into a fake zero/partial locked amount.
        return settled[1].status === 'fulfilled' ? settled[1].value : null;
      };
    } catch (e) {
      try { console.warn('[SW] Ripple escrow position install failed', e); } catch (_) {}
    }

    window.SW_RIPPLE_ESCROW_POSITION_20260816 = {
      installed:true,
      version:VERSION,
      registry_count:addresses.length,
      read_only:true,
      isolated_transport:true,
      position_budget_ms:POSITION_BUDGET_MS,
      get:function () {
        try { return state.rippleEscrowPosition || lastPosition; } catch (_) { return lastPosition; }
      },
      scan:scanCurrentPosition,
      pending:function () { return !!currentJob; }
    };
  }

  loadRegistry(install);
})();
