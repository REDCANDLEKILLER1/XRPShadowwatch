/* ═══════════════════════════════════════════════════════════════════
   RIPPLE ESCROW POSITION — 2026-08-16
   Read-only Report scanner layer.

   Separates:
     • CURRENT POSITION: validated Escrow ledger objects owned by Ripple's
       20 published public escrow wallets.
     • RECENT ACTIVITY: EscrowCreate/EscrowFinish history for those owners.

   No signing, submit, trading, watchlist mutation, or remote writes.
   ═══════════════════════════════════════════════════════════════════ */
(function () {
  'use strict';
  var VERSION = '2026.08.16.1';
  var REGISTRY_SRC = '/src/shared/ripple-escrow-registry.js?v=20260816.1';

  function registry() { return window.SW_RIPPLE_ESCROW_REGISTRY || null; }
  function loadRegistry(done) {
    if (registry()) { done(registry()); return; }
    var old = document.querySelector('script[data-sw-ripple-escrow-registry]');
    if (old) { old.addEventListener('load', function () { done(registry()); }, { once:true }); return; }
    var s = document.createElement('script');
    s.src = REGISTRY_SRC; s.async = false; s.setAttribute('data-sw-ripple-escrow-registry','2026.08.16.1');
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
    for (var n=0; n<Math.min(limit, items.length); n++) jobs.push(run());
    await Promise.all(jobs);
  }

  function install(reg) {
    if (!reg || !Array.isArray(reg.addresses) || !reg.addresses.length) return;
    if (window.SW_RIPPLE_ESCROW_POSITION_20260816 && window.SW_RIPPLE_ESCROW_POSITION_20260816.installed) return;

    var addresses = reg.addresses.slice();
    var lastPosition = null;

    async function fetchObjectsFor(ws, address, objectMap) {
      var marker = null, ledger = null;
      do {
        var req = { command:'account_objects', account:address, type:'escrow', ledger_index:'validated', limit:400 };
        if (marker) req.marker = marker;
        var res = await xrpl(ws, req);
        if (res && res.ledger_index) ledger = res.ledger_index;
        (res && res.account_objects || []).forEach(function (o, i) {
          if (!o || (o.LedgerEntryType && o.LedgerEntryType !== 'Escrow')) return;
          var key = o.index || o.LedgerIndex || o.Index || [address,o.Sequence,o.Amount,o.FinishAfter,i].join(':');
          objectMap[key] = o;
        });
        marker = res && res.marker || null;
      } while (marker);
      return ledger;
    }

    async function fetchRecentFor(ws, address, byHash) {
      var res = await xrpl(ws, { command:'account_tx', account:address, ledger_index_min:-1, ledger_index_max:-1, limit:40, forward:false });
      for (var i=0; i<(res.transactions || []).length; i++) {
        var e = parseEscrowItem(res.transactions[i]);
        if (e && e.hash && !byHash[e.hash]) byHash[e.hash] = e;
      }
    }

    async function scanRippleEscrow(ws, byHash) {
      var objectMap = {}, ownerDone = {}, objectFailures = [], recentFailures = [], validatedLedger = null;
      await mapPool(addresses, 5, async function (address) {
        var results = await Promise.allSettled([
          fetchObjectsFor(ws, address, objectMap),
          fetchRecentFor(ws, address, byHash)
        ]);
        if (results[0].status === 'fulfilled') {
          ownerDone[address] = true;
          if (results[0].value) validatedLedger = results[0].value;
        } else objectFailures.push(address);
        if (results[1].status === 'rejected') recentFailures.push(address);
      });

      var locked = 0, active = 0, nonXrp = 0;
      Object.keys(objectMap).forEach(function (k) {
        var amt = amountXrp(objectMap[k]);
        if (amt == null) { nonXrp++; return; }
        locked += amt; active++;
      });
      var answered = Object.keys(ownerDone).length;
      var complete = answered === addresses.length && objectFailures.length === 0;
      lastPosition = {
        version: VERSION,
        source: 'validated XRPL account_objects over Ripple public escrow owner registry',
        registry_version: reg.version || null,
        expected_owners: addresses.length,
        answered_owners: answered,
        failed_owners: objectFailures.length,
        failed_addresses: objectFailures.slice(),
        recent_history_failed_owners: recentFailures.length,
        active_objects: active,
        non_xrp_objects: nonXrp,
        locked_xrp: complete ? locked : null,
        observed_locked_xrp_partial: locked,
        complete: complete,
        status: complete ? 'COMPLETE' : 'PARTIAL',
        ledger_index: validatedLedger,
        checked_at: new Date().toISOString()
      };
      try { state.rippleEscrowPosition = lastPosition; } catch (_) {}
      return lastPosition;
    }

    // Replace the old sequential 4-account-ish backfill with one bounded,
    // parallel read-only pass across all 20 published Ripple escrow owners.
    // Other XRPL escrow events already exposed by watched-wallet state.txs are
    // preserved through escrowFromTxs(byHash).
    try {
      escrowWallets = function () { return addresses.slice(); };
      escrowBackfill = async function (ws) {
        var byHash = {};
        loadEscrowHistory().forEach(function (e) { if (e && e.hash) byHash[e.hash] = e; });
        escrowFromTxs(byHash);
        try {
          var pos = await scanRippleEscrow(ws, byHash);
          log('Ripple escrow position: ' + (pos.complete ? (pos.locked_xrp.toLocaleString(undefined,{maximumFractionDigits:0}) + ' XRP · ' + pos.active_objects + ' active object(s) · 20/20 owners') : ('PARTIAL · ' + pos.answered_owners + '/' + pos.expected_owners + ' owners'));
        } catch (e) {
          lastPosition = { version:VERSION, source:'validated XRPL account_objects', expected_owners:addresses.length, answered_owners:0, failed_owners:addresses.length, failed_addresses:addresses.slice(), active_objects:0, locked_xrp:null, observed_locked_xrp_partial:0, complete:false, status:'FAILED', ledger_index:null, checked_at:new Date().toISOString(), error:String(e && e.message || e) };
          try { state.rippleEscrowPosition = lastPosition; } catch (_) {}
          log('Ripple escrow current-position check failed: ' + String(e && e.message || e));
        }
        var all = Object.values(byHash).sort(function (a,b) { return (b.ts||0) - (a.ts||0); });
        state.escrow = all;
        saveEscrowHistory(all);
        log('Escrow backfill: ' + all.length + ' event(s) in 30d history.');
      };
    } catch (e) {
      try { console.warn('[SW] Ripple escrow position install failed', e); } catch (_) {}
    }

    window.SW_RIPPLE_ESCROW_POSITION_20260816 = {
      installed: true,
      version: VERSION,
      registry_count: addresses.length,
      read_only: true,
      get: function () { try { return state.rippleEscrowPosition || lastPosition; } catch (_) { return lastPosition; } },
      scan: scanRippleEscrow
    };
  }

  loadRegistry(install);
})();
