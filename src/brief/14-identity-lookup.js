/* ═══════════════════════════════════════════════════════════════════════════
   IDENTITY LOOKUP — resolve wallet identities from a public labeller

   Why this exists: the report can only NAME a wallet that appears in the shared
   identity registry (src/shared/wallet-identities.js). That registry is hand
   maintained, so 79 of 149 watched wallets are described by behaviour only. Every
   attempt to fill the gap by hand or by inference has failed the same way —
   "this wallet received funds from Binance" is not "this wallet is Binance".

   The only honest source is a public labeller. XRPScan publishes account names;
   api.xrpscan.com is already on the api/proxy.js allowlist and the app already
   fetches its richlist. So the app asks, at scan time, and takes the answer.

   RULES THIS MODULE HOLDS TO
   1. It NEVER overwrites an existing registry entry. Empty slots only.
      A lookup that disagrees with a committed entry is recorded as a CONFLICT
      for the operator to settle — not silently applied. The operator decides
      who wins, not whichever code ran last.
   2. It NEVER invents. No inference, no counterparty reasoning, no clustering.
      A wallet with no published name stays unidentified, which is a valid and
      useful answer.
   3. It is COMPLETELY optional at runtime. Every path is wrapped; if the network,
      the proxy or the endpoint is unavailable the app behaves exactly as it does
      today. A scan can never fail because of this module.
   4. It writes NOTHING to the repo. Results live in localStorage and are applied
      to the in-memory registry. Promotion into the committed file is a deliberate
      operator act via exportResolvedIdentities().
   ═══════════════════════════════════════════════════════════════════════════ */
(function () {
  'use strict';

  var STORE   = 'SW_IDENTITY_LOOKUP_V1';
  var TTL_MS  = 7 * 24 * 60 * 60 * 1000;   // re-ask about a wallet weekly at most
  var BATCH   = 6;                          // concurrent per-address requests
  var GAP_MS  = 350;                        // pause between batches — be a good citizen
  var TIMEOUT = 9000;

  var _state = { resolved: {}, misses: {}, conflicts: [], lastRun: 0, running: false };

  function _log(m) { try { if (typeof log === 'function') log('[identity] ' + m); } catch (_) {} }
  function _now() { return Date.now(); }

  function _load() {
    try {
      var raw = localStorage.getItem(STORE); if (!raw) return;
      var d = JSON.parse(raw);
      if (d && typeof d === 'object') {
        _state.resolved = d.resolved || {};
        _state.misses   = d.misses   || {};
        _state.lastRun  = d.lastRun  || 0;
      }
    } catch (_) {}
  }
  function _save() {
    try {
      localStorage.setItem(STORE, JSON.stringify({
        resolved: _state.resolved, misses: _state.misses, lastRun: _state.lastRun
      }));
    } catch (_) {}
  }

  function _registry() {
    try { return (typeof window !== 'undefined' && window.SW_WALLET_IDENTITIES) || null; }
    catch (_) { return null; }
  }

  function _watchedAddresses() {
    try {
      if (typeof KNOWN !== 'undefined' && KNOWN) return Object.keys(KNOWN);
      if (typeof WATCHLIST !== 'undefined' && WATCHLIST) return WATCHLIST.map(function (w) { return w.address; });
    } catch (_) {}
    return [];
  }

  function _extractName(j) {
    if (!j || typeof j !== 'object') return null;
    var cands = [
      j.accountName, j.account_name, j.name, j.nameObj,
      (j.account && j.account.name), (j.data && j.data.name)
    ];
    for (var i = 0; i < cands.length; i++) {
      var c = cands[i];
      if (!c) continue;
      var nm = (typeof c === 'string') ? c : (c.name || c.username || c.desc || null);
      if (typeof nm !== 'string') continue;
      nm = nm.trim();
      if (!nm) continue;
      if (/^r[1-9A-HJ-NP-Za-km-z]{24,34}$/.test(nm)) continue;
      if (nm.length > 60) continue;
      var verified = !!(c && (c.verified === true || c.twitter));
      var domain   = (c && (c.domain || c.desc)) || null;
      return { name: nm, verified: verified, domain: (typeof domain === 'string' ? domain : null) };
    }
    return null;
  }

  function _typeFor(nm) {
    var s = String(nm || '').toLowerCase();
    if (/ripple/.test(s)) return 'RIPPLE';
    if (/binance|coinbase|kraken|bitstamp|bitfinex|upbit|bithumb|bybit|okx|huobi|gate|mexc|bitso|kucoin|crypto\.com|gemini|bitrue|coinone|bitbank|coincheck/.test(s)) return 'EXCH';
    return 'HVT';
  }

  async function _fetchOne(addr) {
    var url = 'https://api.xrpscan.com/api/v1/account/' + encodeURIComponent(addr);
    var got = await proxyFetch(url, TIMEOUT);
    var j = await got.response.json();
    return _extractName(j);
  }

  async function run(opts) {
    opts = opts || {};
    if (_state.running) { _log('already running'); return _summary(); }
    var R = _registry();
    if (!R) { _log('registry not loaded — nothing to fill'); return _summary(); }
    if (typeof proxyFetch !== 'function') { _log('proxyFetch unavailable — skipped'); return _summary(); }

    _load();
    _state.running = true;
    _state.conflicts = [];
    try {
      var now = _now();
      var todo = _watchedAddresses().filter(function (a) {
        if (!a) return false;
        if (R[a]) return false;
        if (_state.resolved[a]) return false;
        if (!opts.force && _state.misses[a] && (now - _state.misses[a]) < TTL_MS) return false;
        return true;
      });
      if (opts.limit) todo = todo.slice(0, opts.limit);
      if (!todo.length) { _log('nothing to look up'); return _summary(); }

      _log('looking up ' + todo.length + ' unidentified wallet(s) via XRPScan');
      var found = 0, missed = 0, failed = 0;

      for (var i = 0; i < todo.length; i += BATCH) {
        var slice = todo.slice(i, i + BATCH);
        var results = await Promise.all(slice.map(function (a) {
          return _fetchOne(a).then(function (r) { return { a: a, r: r }; })
                             .catch(function (e) { return { a: a, err: e }; });
        }));
        results.forEach(function (x) {
          if (x.err) { failed++; return; }
          if (x.r && x.r.name) {
            _state.resolved[x.a] = {
              name: x.r.name,
              type: _typeFor(x.r.name),
              confidence: 'PUBLIC_SOURCE',
              source: 'xrpscan:/api/v1/account' + (x.r.verified ? ' (verified)' : ''),
              domain: x.r.domain || null,
              resolved_at: new Date().toISOString()
            };
            found++;
          } else {
            _state.misses[x.a] = _now();
            missed++;
          }
        });
        if (i + BATCH < todo.length) await new Promise(function (r) { setTimeout(r, GAP_MS); });
      }

      _state.lastRun = _now();
      _save();
      apply();
      _log('resolved ' + found + ' · no published name ' + missed + ' · request failures ' + failed);
      try {
        if (window.SHADOW_EVENT_BUS && window.SHADOW_EVENT_BUS.emit)
          window.SHADOW_EVENT_BUS.emit('shadow.identity.resolved', { found: found, missed: missed, failed: failed });
      } catch (_) {}
      _state.running = false;
      return _summary();
    } catch (e) {
      _log('lookup failed: ' + (e && e.message));
      _state.running = false;
      return _summary();
    } finally { _state.running = false; }
  }

  function apply() {
    var R = _registry(); if (!R) return 0;
    var n = 0;
    Object.keys(_state.resolved).forEach(function (a) {
      var got = _state.resolved[a];
      if (!R[a]) { R[a] = got; n++; return; }
      if (R[a].name !== got.name) {
        _state.conflicts.push({ address: a, committed: R[a].name, committed_confidence: R[a].confidence,
                                looked_up: got.name, source: got.source });
      }
    });
    if (n) { try { if (typeof _labelCacheClear === 'function') _labelCacheClear(); } catch (_) {} }
    return n;
  }

  function _summary() {
    return {
      resolved_count: Object.keys(_state.resolved).length,
      no_published_name: Object.keys(_state.misses).length,
      conflicts: _state.conflicts.slice(),
      last_run: _state.lastRun ? new Date(_state.lastRun).toISOString() : null,
      running: _state.running
    };
  }

  function exportResolvedIdentities() {
    var out = {
      generated_at: new Date().toISOString(),
      note: 'Resolved from XRPScan published account names. Empty registry slots only — nothing here overwrote a committed entry.',
      registry_entries: {},
      conflicts_for_operator: _state.conflicts.slice(),
      addresses_with_no_published_name: Object.keys(_state.misses)
    };
    Object.keys(_state.resolved).forEach(function (a) {
      var r = _state.resolved[a];
      out.registry_entries[a] = { name: r.name, type: r.type, confidence: r.confidence, source: r.source };
    });
    return out;
  }
  function downloadResolvedIdentities() {
    try {
      var base = (typeof shadowFileBase === 'function') ? shadowFileBase('ResolvedIdentities') : 'ShadowWatch_ResolvedIdentities';
      if (typeof downloadJsonFile === 'function') downloadJsonFile(base + '.json', exportResolvedIdentities());
    } catch (e) { try { if (typeof elog === 'function') elog('downloadResolvedIdentities', e); } catch (_) {} }
  }

  _load();
  try { apply(); } catch (_) {}

  try {
    if (window.SHADOW_EVENT_BUS && typeof window.SHADOW_EVENT_BUS.on === 'function') {
      window.SHADOW_EVENT_BUS.on('shadow.report.sealed', function (data) {
        try {
          var d = (data && data.payload) ? data.payload : data;
          if (!d || (!d.scan_id && !d.report_id && !d.date)) return;
          setTimeout(function () { try { run({ limit: 40 }); } catch (_) {} }, 4000);
        } catch (_) {}
      });
    }
  } catch (_) {}

  window.SW_IDENTITY_LOOKUP = {
    run: run,
    apply: apply,
    stats: _summary,
    exportResolvedIdentities: exportResolvedIdentities,
    download: downloadResolvedIdentities,
    _clearCache: function () { try { localStorage.removeItem(STORE); } catch (_) {}
                               _state = { resolved: {}, misses: {}, conflicts: [], lastRun: 0, running: false }; }
  };
})();

// Deterministic report-runtime wiring for the tx-window completeness layer.
// brief-console.html loads this file directly after 13-debug-overlay.js, so
// script 17 is now loaded from a guaranteed report entrypoint rather than only
// as a later side effect of the historical 15 → 16 chain.
(function () {
  try {
    function loadHistoricalRepairChain() {
      var s = document.createElement('script');
      s.src = '/src/brief/15-report-hotfix-20260814.js';
      s.async = false;
      s.setAttribute('data-sw-hotfix', '2026-08-14.2');
      s.onload = function () {
        try {
          var e = document.createElement('script');
          e.src = '/src/brief/16-escrow-categories-20260814.js';
          e.async = false;
          e.setAttribute('data-sw-escrow-categories', '2026-08-14.1');
          document.body.appendChild(e);
        } catch (_) {}
      };
      document.body.appendChild(s);
    }

    if (window.SW_REPORT_SCAN_TUNING_20260816) {
      loadHistoricalRepairChain();
      return;
    }

    var tx = document.createElement('script');
    tx.src = '/src/brief/17-report-scan-tuning-20260816.js';
    tx.async = false;
    tx.setAttribute('data-sw-report-scan-tuning', '2026-08-19.1');
    tx.onload = loadHistoricalRepairChain;
    tx.onerror = loadHistoricalRepairChain;
    document.body.appendChild(tx);
  } catch (_) {}
})();
