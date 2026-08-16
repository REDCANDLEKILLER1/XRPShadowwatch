/* Shadow Watch Genesis Master Capture — 2026-08-16.
   Read-only forensic export layer. Captures persistent/report state before and
   after one normal Report run and produces one master TXT handoff file.
   No XRPL calls, pagination, concurrency, lookback, scoring, wallet mutation,
   signing, submit, trading, or remote writes are introduced here. */
(function () {
  'use strict';

  var VERSION = '2026.08.16.1';
  if (window.SW_GENESIS_MASTER_20260816 && window.SW_GENESIS_MASTER_20260816.installed) return;

  var ctl = {
    installed: true,
    version: VERSION,
    armed: false,
    before: null,
    after: null,
    last_document: null,
    bus_hooked: false,
    before_quality: 'UNSET'
  };

  function iso() { return new Date().toISOString(); }
  function stateRef() {
    try { if (typeof state !== 'undefined' && state) return state; } catch (_) {}
    try { if (window.__SHADOWWATCH_STATE__) return window.__SHADOWWATCH_STATE__; } catch (_) {}
    try { if (window.state) return window.state; } catch (_) {}
    return null;
  }
  function scanning() {
    var s = stateRef();
    return !!(s && s.scanning === true);
  }
  function countOf(v) {
    if (Array.isArray(v) || typeof v === 'string') return v.length;
    if (v && typeof v === 'object') {
      try { return Object.keys(v).length; } catch (_) { return null; }
    }
    return null;
  }
  function typeOf(v) {
    if (v === null) return 'null';
    if (Array.isArray(v)) return 'array';
    if (v instanceof Date) return 'date';
    if (v instanceof Map) return 'map';
    if (v instanceof Set) return 'set';
    return typeof v;
  }
  function secretName(k) {
    return /^(seed|secret|private_?key|privatekey|mnemonic|passphrase|password|access_?token|auth_?token|bearer)$/i.test(String(k || ''));
  }

  function safeCopy(value, depth, seen, keyName) {
    depth = depth || 0;
    seen = seen || new WeakSet();
    if (secretName(keyName)) return '[REDACTED_BY_GENESIS_CAPTURE]';
    if (value == null || typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') return value;
    if (typeof value === 'bigint') return String(value);
    if (typeof value === 'function') return '[FUNCTION ' + (value.name || 'anonymous') + ']';
    if (typeof value === 'symbol') return String(value);
    if (depth > 16) return '[MAX_DEPTH]';
    try {
      if (typeof Node !== 'undefined' && value instanceof Node) return '[DOM_NODE]';
    } catch (_) {}
    try {
      if (value instanceof Date) return value.toISOString();
      if (value instanceof Error) return { name: value.name, message: value.message, stack: value.stack || null };
      if (value instanceof Map) {
        var mo = {};
        value.forEach(function (v, k) { mo[String(k)] = safeCopy(v, depth + 1, seen, String(k)); });
        return mo;
      }
      if (value instanceof Set) return Array.from(value).map(function (v) { return safeCopy(v, depth + 1, seen, 'set_item'); });
      if (ArrayBuffer.isView && ArrayBuffer.isView(value)) return Array.from(value);
    } catch (_) {}
    if (typeof value === 'object') {
      try {
        if (seen.has(value)) return '[CIRCULAR]';
        seen.add(value);
      } catch (_) {}
      if (Array.isArray(value)) {
        return value.map(function (v) { return safeCopy(v, depth + 1, seen, 'array_item'); });
      }
      var out = {};
      try {
        Object.keys(value).forEach(function (k) {
          try { out[k] = safeCopy(value[k], depth + 1, seen, k); }
          catch (e) { out[k] = '[UNREADABLE: ' + String(e && e.message || e) + ']'; }
        });
      } catch (e) {
        return '[UNREADABLE_OBJECT: ' + String(e && e.message || e) + ']';
      }
      return out;
    }
    try { return String(value); } catch (_) { return '[UNSERIALIZABLE]'; }
  }

  function parseStored(raw, key) {
    if (secretName(key)) return '[REDACTED_BY_GENESIS_CAPTURE]';
    if (raw == null) return null;
    try { return safeCopy(JSON.parse(raw), 0, new WeakSet(), key); }
    catch (_) { return raw; }
  }

  function readStorage(store) {
    var rows = [];
    if (!store) return rows;
    try {
      var keys = [];
      for (var i = 0; i < store.length; i++) keys.push(store.key(i));
      keys.filter(Boolean).sort().forEach(function (key) {
        var raw = null;
        try { raw = store.getItem(key); } catch (_) {}
        rows.push({
          key: key,
          bytes_utf16_approx: raw == null ? 0 : raw.length * 2,
          value: parseStored(raw, key)
        });
      });
    } catch (e) {
      rows.push({ key: '[STORAGE_READ_FAILED]', error: String(e && e.message || e) });
    }
    return rows;
  }

  function stateInventory(s) {
    var out = [];
    if (!s || typeof s !== 'object') return out;
    try {
      Object.keys(s).sort().forEach(function (k) {
        var v = null;
        try { v = s[k]; } catch (_) {}
        out.push({ key: k, type: typeOf(v), count: countOf(v) });
      });
    } catch (_) {}
    return out;
  }

  var PERSIST_RE = /(memory|history|journal|bloom|decision|coordination|pattern|snapshot|discovery|follow|escrow|offer|watch|hvt|roster|baseline|intel|candidate|black.?box|health|timing|perf)/i;
  function persistentState(s) {
    var out = {};
    if (!s || typeof s !== 'object') return out;
    try {
      Object.keys(s).sort().forEach(function (k) {
        if (!PERSIST_RE.test(k)) return;
        try { out[k] = safeCopy(s[k], 0, new WeakSet(), k); } catch (_) {}
      });
    } catch (_) {}
    return out;
  }

  function customGlobals() {
    var out = {};
    var re = /^(SW_|SHADOW_|XAI_|HVT_|XRPL_|MORNING_|PUBLIC_|REPORT_|NEWS_)/;
    try {
      Object.keys(window).sort().forEach(function (k) {
        if (!re.test(k) && !PERSIST_RE.test(k)) return;
        if (['localStorage','sessionStorage'].indexOf(k) >= 0) return;
        var v;
        try { v = window[k]; } catch (_) { return; }
        if (typeof v === 'function') {
          out[k] = '[FUNCTION ' + (v.name || k) + ']';
          return;
        }
        try { out[k] = safeCopy(v, 0, new WeakSet(), k); } catch (_) {}
      });
    } catch (_) {}
    return out;
  }

  function metaFromState(s) {
    var p = s && s.pack && typeof s.pack === 'object' ? s.pack : {};
    return {
      report_id: p.report_id || s && (s.reportId || s.report_id) || null,
      scan_id: p.scan_id || s && (s.scanId || s.scan_id) || null,
      app_version: p.version || s && s.version || null,
      tx_count: s && Array.isArray(s.txs) ? s.txs.length : null,
      large_count: s && Array.isArray(s.large) ? s.large.length : null,
      discovery_count: s && Array.isArray(s.discoveryInbox) ? s.discoveryInbox.length : null
    };
  }

  function snapshot(kind, includeFullState) {
    var s = stateRef();
    var snap = {
      kind: kind,
      captured_at: iso(),
      page_visibility: (function(){ try { return document.visibilityState || 'unknown'; } catch (_) { return 'unknown'; } })(),
      scanning: !!(s && s.scanning),
      location: (function(){ try { return String(location.href); } catch (_) { return null; } })(),
      state_meta: metaFromState(s),
      state_inventory: stateInventory(s),
      persistent_state: persistentState(s),
      local_storage: readStorage((function(){ try { return localStorage; } catch (_) { return null; } })()),
      session_storage: readStorage((function(){ try { return sessionStorage; } catch (_) { return null; } })()),
      custom_globals: customGlobals()
    };
    if (includeFullState) {
      try { snap.state_full = safeCopy(s, 0, new WeakSet(), 'state'); }
      catch (e) { snap.state_full = { capture_error: String(e && e.message || e) }; }
      try {
        if (typeof window.buildShadowWatchDebugFile === 'function') {
          snap.existing_total_debug = String(window.buildShadowWatchDebugFile() || '');
        }
      } catch (e) {
        snap.existing_total_debug = '[BUILD FAILED: ' + String(e && e.message || e) + ']';
      }
    }
    return snap;
  }

  function storageMap(rows) {
    var m = {};
    (rows || []).forEach(function (r) { if (r && r.key) m[r.key] = r; });
    return m;
  }
  function simpleFingerprint(v) {
    var str;
    try { str = JSON.stringify(v); } catch (_) { str = String(v); }
    var h = 2166136261;
    for (var i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 16777619); }
    return ('00000000' + (h >>> 0).toString(16)).slice(-8) + ':' + str.length;
  }
  function storageDiff(aRows, bRows) {
    var a = storageMap(aRows), b = storageMap(bRows), keys = {};
    Object.keys(a).forEach(function (k) { keys[k] = 1; });
    Object.keys(b).forEach(function (k) { keys[k] = 1; });
    var out = [];
    Object.keys(keys).sort().forEach(function (k) {
      var av = a[k] ? a[k].value : undefined;
      var bv = b[k] ? b[k].value : undefined;
      var af = a[k] ? simpleFingerprint(av) : null;
      var bf = b[k] ? simpleFingerprint(bv) : null;
      if (af === bf) return;
      out.push({ key: k, change: !a[k] ? 'ADDED' : !b[k] ? 'REMOVED' : 'CHANGED', before: af, after: bf });
    });
    return out;
  }

  var STORE_PROBES = [
    ['black_box_history', /black.?box/i],
    ['coordination_memory', /coordination/i],
    ['pattern_memory', /pattern/i],
    ['shadow_journal', /journal/i],
    ['decision_trace', /decision/i],
    ['bloom_queue', /bloom/i],
    ['balance_memory', /(balance.*(memory|baseline|snapshot)|(memory|baseline|snapshot).*balance)/i],
    ['discovery_history', /(discovery|candidate)/i],
    ['receiver_followthrough', /(receiver|followthrough|follow_through)/i],
    ['escrow_history', /escrow/i],
    ['offer_memory', /offer/i],
    ['news_health_history', /(news.*health|source.*health|health.*news)/i],
    ['timing_performance_history', /(timing|perf|long.?task|lag)/i],
    ['watchlist_roster', /(watchlist|hvt|roster)/i]
  ];

  function storeManifest(snap) {
    var names = [];
    (snap.local_storage || []).forEach(function (r) { names.push('localStorage.' + r.key); });
    (snap.session_storage || []).forEach(function (r) { names.push('sessionStorage.' + r.key); });
    Object.keys(snap.persistent_state || {}).forEach(function (k) { names.push('state.' + k); });
    Object.keys(snap.custom_globals || {}).forEach(function (k) { names.push('window.' + k); });
    return STORE_PROBES.map(function (p) {
      var hits = names.filter(function (n) { return p[1].test(n); });
      var nonEmpty = hits.filter(function (name) {
        var bits = name.split('.'), root = bits.shift(), key = bits.join('.'), v;
        try {
          if (root === 'state') v = snap.persistent_state[key];
          else if (root === 'window') v = snap.custom_globals[key];
          else {
            var rows = root === 'localStorage' ? snap.local_storage : snap.session_storage;
            var row = rows.find(function (r) { return r.key === key; });
            v = row && row.value;
          }
        } catch (_) {}
        var c = countOf(v);
        return v != null && v !== '' && c !== 0;
      });
      return {
        store: p[0],
        status: hits.length ? (nonEmpty.length ? 'FOUND' : 'EMPTY') : 'NOT_EXPOSED',
        sources: hits
      };
    });
  }

  function dedupeIndex(s) {
    s = s || {};
    function uniqHashes(rows) {
      var set = new Set();
      (rows || []).forEach(function (r) { var h = r && (r.hash || r.tx_hash || r.txid); if (h) set.add(String(h)); });
      return Array.from(set);
    }
    function uniqAddresses(rows) {
      var set = new Set();
      (rows || []).forEach(function (r) { var a = r && (r.address || r.wallet || r.account); if (a) set.add(String(a)); });
      return Array.from(set);
    }
    return {
      tx_hashes: uniqHashes(Array.isArray(s.txs) ? s.txs : []),
      large_transfer_hashes: uniqHashes(Array.isArray(s.large) ? s.large : []),
      discovery_addresses: uniqAddresses(Array.isArray(s.discoveryInbox) ? s.discoveryInbox : []),
      note: 'Use these fingerprints to prevent overlapping reports from becoming duplicate historical evidence.'
    };
  }

  function arm(reason) {
    if (scanning()) {
      ctl.before = snapshot('BEFORE_PARTIAL_ACTIVE_SCAN', false);
      ctl.before_quality = 'PARTIAL_ACTIVE_SCAN';
    } else {
      ctl.before = snapshot('BEFORE', false);
      ctl.before_quality = 'CLEAN_PRE_SCAN';
    }
    ctl.after = null;
    ctl.last_document = null;
    ctl.armed = true;
    ctl.armed_at = iso();
    ctl.arm_reason = reason || 'manual_or_page_load';
    renderStatus();
  }

  function captureAfter(reason) {
    ctl.after = snapshot('AFTER', true);
    ctl.captured_after_at = iso();
    ctl.after_reason = reason || 'report_sealed';
    ctl.armed = false;
    ctl.last_document = buildDocument();
    renderStatus();
    return ctl.after;
  }

  function buildDocument() {
    var s = stateRef();
    var before = ctl.before || snapshot('BEFORE_MISSING', false);
    var after = ctl.after || snapshot('AFTER_ON_DEMAND', true);
    var meta = metaFromState(s);
    return {
      shadow_watch_genesis_master: {
        schema: 'SW_GENESIS_MASTER_V1',
        capture_version: VERSION,
        generated_at: iso(),
        purpose: 'Seed a future shared Shadow Watch intelligence/history repository from one fresh, provenance-preserving Report capture.',
        scope: 'SHADOW WATCH REPORT APP ONLY — does not silently mix the separate Live App.',
        safety: {
          read_only: true,
          scanner_network_calls_changed: false,
          xrpl_writes: false,
          signing: false,
          trading: false,
          remote_repository_write: false,
          obvious_secret_fields_redacted: true
        },
        provenance: meta,
        before_snapshot_quality: ctl.before_quality,
        arm_reason: ctl.arm_reason || null,
        after_reason: ctl.after_reason || null
      },
      store_manifest_before: storeManifest(before),
      store_manifest_after: storeManifest(after),
      persistence_diff: {
        local_storage: storageDiff(before.local_storage, after.local_storage),
        session_storage: storageDiff(before.session_storage, after.session_storage)
      },
      dedupe_index: dedupeIndex(s),
      before_snapshot: before,
      after_snapshot: after
    };
  }

  function fileText(doc) {
    var meta = doc && doc.shadow_watch_genesis_master || {};
    var p = meta.provenance || {};
    var head = [
      '============================================================',
      'XRPMAN // SHADOW WATCH — GENESIS MASTER CAPTURE',
      'Powered by XMΣMΣ',
      '============================================================',
      'Schema:      ' + (meta.schema || 'SW_GENESIS_MASTER_V1'),
      'Generated:   ' + (meta.generated_at || iso()),
      'Report ID:   ' + (p.report_id || 'unknown'),
      'Scan ID:     ' + (p.scan_id || 'unknown'),
      'Before:      ' + (meta.before_snapshot_quality || 'unknown'),
      '',
      'This is a read-only forensic state capture for building Shadow Memory.',
      'It contains BEFORE/AFTER persistence, state inventory, hidden memory lanes,',
      'current scan state, store status, provenance, and dedupe fingerprints.',
      '============================================================',
      '',
      'GENESIS MASTER JSON',
      '============================================================',
      ''
    ].join('\n');
    return head + JSON.stringify(doc, null, 2) + '\n';
  }

  function download() {
    if (!ctl.after) {
      if (scanning()) return;
      captureAfter('manual_download_capture');
    }
    var doc = ctl.last_document || buildDocument();
    ctl.last_document = doc;
    var text = fileText(doc);
    var p = doc.shadow_watch_genesis_master.provenance || {};
    var day = iso().slice(0, 10);
    var id = String(p.scan_id || p.report_id || 'UNSEALED').replace(/[^A-Za-z0-9_-]/g, '');
    var name = 'ShadowWatch_GENESIS_MASTER_' + id + '_' + day + '.txt';
    try {
      var blob = new Blob([text], { type: 'text/plain;charset=utf-8' });
      var url = URL.createObjectURL(blob);
      var a = document.createElement('a');
      a.href = url;
      a.download = name;
      a.style.display = 'none';
      document.body.appendChild(a);
      a.click();
      setTimeout(function () { try { URL.revokeObjectURL(url); a.remove(); } catch (_) {} }, 1000);
    } catch (e) {
      try { console.error('[SW-GENESIS] download failed', e); } catch (_) {}
    }
  }

  var ui = { wrap: null, btn: null, status: null };
  function renderStatus() {
    if (!ui.btn || !ui.status) return;
    if (ctl.after) {
      ui.status.textContent = 'READY · BEFORE + AFTER CAPTURED';
      ui.btn.textContent = 'DOWNLOAD GENESIS MASTER';
      ui.btn.disabled = false;
      return;
    }
    if (scanning()) {
      ui.status.textContent = 'CAPTURING · RUN IN PROGRESS';
      ui.btn.textContent = 'GENESIS CAPTURE RUNNING';
      ui.btn.disabled = true;
      return;
    }
    ui.status.textContent = ctl.before_quality === 'CLEAN_PRE_SCAN' ? 'ARMED · RUN NORMAL REPORT' : 'RE-ARM BEFORE NEXT RUN';
    ui.btn.textContent = ctl.before_quality === 'CLEAN_PRE_SCAN' ? 'GENESIS ARMED' : 'RE-ARM GENESIS';
    ui.btn.disabled = ctl.before_quality === 'CLEAN_PRE_SCAN';
  }

  function mountUI() {
    if (document.getElementById('swGenesisMasterCapture')) return;
    var wrap = document.createElement('div');
    wrap.id = 'swGenesisMasterCapture';
    wrap.style.cssText = 'position:fixed;right:12px;bottom:78px;z-index:99989;background:#050a08;border:1px solid rgba(0,255,0,.55);border-radius:9px;padding:8px;box-shadow:0 0 18px rgba(0,255,0,.12);font-family:Rajdhani,Arial,sans-serif;max-width:230px';
    var status = document.createElement('div');
    status.style.cssText = 'font-size:9px;letter-spacing:.11em;color:#8fa69a;margin-bottom:6px;text-align:center';
    var btn = document.createElement('button');
    btn.type = 'button';
    btn.style.cssText = 'width:100%;border:1px solid #00ff00;background:#07120b;color:#00ff00;border-radius:6px;padding:8px 10px;font-weight:800;font-size:10px;letter-spacing:.08em;cursor:pointer';
    btn.addEventListener('click', function () {
      if (ctl.after) return download();
      if (!scanning()) arm('manual_rearm');
    });
    wrap.appendChild(status);
    wrap.appendChild(btn);
    document.body.appendChild(wrap);
    ui.wrap = wrap; ui.btn = btn; ui.status = status;
    renderStatus();
  }

  function hookBus() {
    if (ctl.bus_hooked) return true;
    var bus = null;
    try { bus = window.SHADOW_EVENT_BUS; } catch (_) {}
    if (!bus || typeof bus.on !== 'function') return false;
    ctl.bus_hooked = true;
    try {
      bus.on('shadow.scan.started', function () {
        if (ctl.after || !ctl.before || ctl.before_quality !== 'CLEAN_PRE_SCAN') arm('scan_started_auto_arm');
        renderStatus();
      });
      bus.on('shadow.report.sealed', function () { setTimeout(function () { captureAfter('shadow.report.sealed'); }, 0); });
      bus.on('shadow.error.scan_failed', function () { renderStatus(); });
    } catch (_) {}
    return true;
  }

  // Capture as early as this layer is loaded. 03-news-timer-hotfix loads this
  // before the later helper/hotfix chain so normal fresh-page runs get a clean
  // pre-scan persistence snapshot rather than a mid-run reconstruction.
  arm('early_page_load');

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', mountUI);
  else mountUI();

  var tries = 0;
  var hookTimer = setInterval(function () {
    tries++;
    if (hookBus() || tries > 240) clearInterval(hookTimer);
  }, 250);

  window.SW_GENESIS_MASTER_20260816 = ctl;
  ctl.arm = arm;
  ctl.captureAfter = captureAfter;
  ctl.buildDocument = buildDocument;
  ctl.download = download;
  ctl.snapshotNow = function () { return snapshot('MANUAL', true); };
})();
