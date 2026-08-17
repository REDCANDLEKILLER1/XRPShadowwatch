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

  // Registry access — the shared file defines window.SW_WALLET_IDENTITIES.
  function _registry() {
    try { return (typeof window !== 'undefined' && window.SW_WALLET_IDENTITIES) || null; }
    catch (_) { return null; }
  }

  // Every watched address, from the watchlist the scanner actually uses.
  function _watchedAddresses() {
    try {
      if (typeof KNOWN !== 'undefined' && KNOWN) return Object.keys(KNOWN);
      if (typeof WATCHLIST !== 'undefined' && WATCHLIST) return WATCHLIST.map(function (w) { return w.address; });
    } catch (_) {}
    return [];
  }

  // XRPScan account payloads have carried the name under several shapes over the
  // years. Read them all, and accept ONLY a real name string — never a domain or
  // a bare address, which would look like an identity without being one.
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
      if (/^r[1-9A-HJ-NP-Za-km-z]{24,34}$/.test(nm)) continue;   // an address is not a name
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

  /* Resolve identities for watched wallets that do not have one.
     opts.force  — ignore the TTL and re-ask about everything
     opts.limit  — cap how many addresses to try in this run          */
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
        if (R[a]) return false;                                     // rule 1: empty slots only
        if (_state.resolved[a]) return false;                       // already have an answer
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
          if (x.err) { failed++; return; }                          // transient — do not cache a failure as a miss
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
            _state.misses[x.a] = _now();                            // no published name — remember, retry after TTL
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
      // Clear BEFORE snapshotting: _summary() is evaluated while computing the
      // return value, i.e. before finally runs, so a summary taken here would
      // report running:true on a run that has finished.
      _state.running = false;
      return _summary();
    } catch (e) {
      _log('lookup failed: ' + (e && e.message));
      _state.running = false;
      return _summary();
    } finally { _state.running = false; }
  }

  /* Merge resolved names into the in-memory registry. Empty slots only; a
     disagreement with a committed entry becomes a conflict record, never an
     overwrite. */
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

  /* Operator hand-off: everything the lookup found, in the exact shape of the
     committed registry, ready to paste into src/shared/wallet-identities.js.
     Conflicts are listed separately for the operator to settle. */
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
  // Re-apply anything already cached as soon as the page loads, so a wallet
  // resolved yesterday is named in today's report without waiting for a lookup.
  try { apply(); } catch (_) {}

  // Run after the report seals — same reasoning as the helper pool: enrichment
  // must not be able to influence the report it is enriching. Guarded so a
  // missing bus, a test-runner event or a failed request changes nothing.
  try {
    if (window.SHADOW_EVENT_BUS && typeof window.SHADOW_EVENT_BUS.on === 'function') {
      window.SHADOW_EVENT_BUS.on('shadow.report.sealed', function (data) {
        try {
          var d = (data && data.payload) ? data.payload : data;
          var seal = d && d.seal ? d.seal : null;
          if (!d || (!(d.scan_id || d.report_id || d.date) &&
                     !(seal && (seal.scan_id || seal.report_id || seal.date)))) return; // ignore test emissions
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


/* ═══════════════════════════════════════════════════════════════════════════
   P5N3V HOTFIX OVERLAY — 2026-08-17
   Small runtime overlay for defects proven by SW-20260817-P5N3V.
   Kept here rather than replacing the 1.7 MB core file so the patch remains
   reviewable and reversible as a single small source change.

   Fixes:
   • permanently includes the one scanner-promoted receiver in the watch set;
   • stops receiver balance / sampled tx_count from being counted as new flow;
   • starts GO2 helper jobs for the real nested evidence-seal event shape;
   • makes TOTAL DEBUG use the upgraded GO2 debug renderer for sections 15/17/19.
   ═══════════════════════════════════════════════════════════════════════════ */
(function () {
  'use strict';

  // 1) Scanner-reviewed promotion. Behavioral label only; no ownership claim.
  try {
    var promotedAddress = 'rDHyd2wTXnoT1MTvCigLGpm8o7WdhE5mGi';
    if (typeof WATCHLIST !== 'undefined' && typeof KNOWN !== 'undefined' && !KNOWN[promotedAddress]) {
      var promoted = {
        label: 'LARGE_RECV_rDHyd2',
        address: promotedAddress,
        cat: 'discovered_receiver'
      };
      WATCHLIST.push(promoted);
      KNOWN[promotedAddress] = promoted;
    }
  } catch (_) {}

  // 2) Discovery accounting: receiver_followthrough.balance_xrp is a balance
  // snapshot and receiver_followthrough.tx_count is a sampling statistic. The
  // core collector used to add both on top of the already-counted inbound flow.
  try {
    if (typeof collectDiscoveryCandidates === 'function' && !collectDiscoveryCandidates._p5n3vFixed) {
      var _p5n3vCollect = collectDiscoveryCandidates;
      var _wrappedCollect = function (pack) {
        var source = pack || ((typeof state !== 'undefined' && state.pack) ? state.pack : {}) || {};
        var follow = Array.isArray(source.receiver_followthrough) ? source.receiver_followthrough : null;
        if (!follow || !follow.length) return _p5n3vCollect(source);
        var clean = Object.assign({}, source, {
          receiver_followthrough: follow.map(function (r) {
            return Object.assign({}, r || {}, { balance_xrp: 0, tx_count: 0 });
          })
        });
        return _p5n3vCollect(clean);
      };
      _wrappedCollect._p5n3vFixed = true;
      _wrappedCollect._original = _p5n3vCollect;
      collectDiscoveryCandidates = _wrappedCollect;
    }
  } catch (_) {}

  // 3) GO2 helper launch: buildEvidenceSeal emits { seal, ts }, so report/scan
  // identity is normally nested under payload.seal. The legacy listener only
  // checked payload directly and silently rejected every real sealed report.
  try {
    var _lastHelperSeal = null;
    if (window.SHADOW_EVENT_BUS && typeof window.SHADOW_EVENT_BUS.on === 'function') {
      window.SHADOW_EVENT_BUS.on('shadow.report.sealed', function (data) {
        try {
          var d = (data && data.payload) ? data.payload : data;
          var seal = d && d.seal ? d.seal : null;
          if (!seal || !(seal.scan_id || seal.report_id || seal.date)) return;
          var sealKey = seal.scan_id || seal.report_id || seal.date;
          if (_lastHelperSeal === sealKey) return;
          _lastHelperSeal = sealKey;
          var HP = window.SHADOW_HELPER_POOL;
          var FLAGS = window.SHADOW_SYSTEM_FLAGS;
          if (!HP || !FLAGS || !FLAGS.helperPool || !HP.enabled || typeof HP.assignJobs !== 'function') return;
          var activePack = (typeof state !== 'undefined' && state.pack) ? state.pack : d;
          setTimeout(function () { try { HP.assignJobs(activePack); } catch (_) {} }, 2000);
        } catch (_) {}
      });
    }
  } catch (_) {}

  // 4) TOTAL DEBUG only: use the upgraded debug renderer when present. The
  // clean TOTAL REPORT remains untouched.
  try {
    if (typeof buildShadowWatchDebugFile === 'function' &&
        typeof _TOTAL_DEBUG_SECTIONS !== 'undefined' &&
        !buildShadowWatchDebugFile._p5n3vFixed) {
      var _p5n3vBuildDebug = function () {
        var sections = _TOTAL_DEBUG_SECTIONS;
        var modeLabel = 'TOTAL DEBUG FILE';
        var divider = '============================================================';
        var reportId = (typeof state !== 'undefined' && state.pack && (state.pack.report_id || state.pack.scan_id)) ||
                       (typeof state !== 'undefined' && state.seal && state.seal.report_id) ||
                       (typeof state !== 'undefined' && state.lastReportId) || 'unknown';
        var generatedAt = new Date().toISOString();
        var lines = [];
        lines.push(divider);
        lines.push('XRPMAN // SHADOW WATCH — ' + modeLabel);
        lines.push('Powered by XMΣMΣ');
        lines.push(divider);
        lines.push('Report ID:    ' + reportId);
        lines.push('Generated:    ' + generatedAt);
        lines.push('App Version:  ' + (typeof APP_VERSION !== 'undefined' ? APP_VERSION : 'unknown'));
        lines.push('');
        lines.push('Shadow Watch needs two export modes: multi-file archive style for local');
        lines.push('records, and one total TXT handoff file for mobile/ChatGPT sharing.');
        lines.push('');
        lines.push('Sections (in order):');
        sections.forEach(function (s) { lines.push('  ' + s.num + ' — ' + s.label); });
        lines.push('');
        lines.push(divider);
        lines.push('');
        sections.forEach(function (s) {
          lines.push(divider);
          lines.push('SECTION ' + s.num + ' — ' + s.label);
          lines.push(divider);
          lines.push('');
          var text = '', ok = false;
          try {
            var resolver = (typeof window.buildDebugSectionContent === 'function')
              ? window.buildDebugSectionContent
              : ((typeof _resolveReportSource === 'function') ? _resolveReportSource : null);
            var src = resolver ? resolver(s.kind, (typeof state !== 'undefined' ? (state.pack || {}) : {})) : null;
            if (src && src.ok && src.text) {
              text = String(src.text).trim();
              ok = text.length > 0;
            }
          } catch (_) {}
          lines.push(ok ? text : '[EMPTY / NOT GENERATED THIS RUN]');
          lines.push('');
          lines.push('');
        });
        lines.push(divider);
        lines.push('END OF ' + modeLabel);
        lines.push('Report ID: ' + reportId);
        lines.push('Generated: ' + generatedAt);
        lines.push(divider);
        return lines.join('\n');
      };
      _p5n3vBuildDebug._p5n3vFixed = true;
      buildShadowWatchDebugFile = _p5n3vBuildDebug;
    }
  } catch (_) {}
})();
