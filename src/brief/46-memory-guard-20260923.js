/* 46-memory-guard-20260923.js
 * Patch 1 — Brief memory guard.
 * Classic script. Loads last. Does not edit 02-core.js.
 *
 * Defect this closes:
 *   Coordination printed "Need 5+ snapshots. Current: 0." on SW-20260923-JK10O
 *   while the same run later logged "BLACK_BOX: snapshot saved (3/30)".
 *   detectCoordination ran against an empty in-memory array; the store
 *   already had rows, or received them on save after the report text was built.
 *
 * Rules (docs/CONTRACT.md):
 *   - Brief coordination reads shadowwatch_blackbox_v34.
 *   - Empty in-memory history re-reads the store.
 *   - Empty persist must not overwrite a non-empty store.
 *   - After save, coordination is recomputed from the saved store.
 */
(function shadowMemoryGuard() {
  'use strict';

  var BRIEF_BLACKBOX = 'shadowwatch_blackbox_v34';
  var OUTER_BLACKBOX = 'XRPMAN_BLACKBOX_V2';
  var LEGACY_SNAPSHOT = 'shadowwatch_snapshot_v30';
  var PATTERN_KEY = 'SHADOW_WATCH_PATTERN_MEMORY_V1';
  var MAX_BRIEF_SNAPSHOTS = 30;
  var MAX_BRIEF_BYTES = 200 * 1024;
  var MAX_LARGE_TRANSFERS = 24;

  function looksLikeBriefSnapshots(arr) {
    if (!Array.isArray(arr) || !arr.length) return false;
    var first = arr[0];
    if (!first || typeof first !== 'object') return false;
    return Array.isArray(first.large_transfers) ||
      Array.isArray(first.wallets) ||
      Array.isArray(first.offers) ||
      typeof first.ts === 'number' ||
      typeof first.date === 'string';
  }

  function readJson(key) {
    try {
      var raw = localStorage.getItem(key);
      if (!raw) return null;
      return JSON.parse(raw);
    } catch (_) {
      return null;
    }
  }

  function readBriefHistory() {
    var primary = readJson(BRIEF_BLACKBOX);
    if (looksLikeBriefSnapshots(primary)) return primary;
    // Brief coordination has one owner: v34. Do not silently promote the
    // Outer/legacy stores into Brief history; those are separate contracts.
    if (Array.isArray(primary)) return primary;
    return [];
  }

  function probe() {
    function count(key) {
      var v = readJson(key);
      if (Array.isArray(v)) return v.length;
      if (v && Array.isArray(v.snapshots)) return v.snapshots.length;
      return v == null ? null : 0;
    }
    return {
      brief_blackbox_v34: count(BRIEF_BLACKBOX),
      outer_blackbox_v2: count(OUTER_BLACKBOX),
      legacy_snapshot_v30: count(LEGACY_SNAPSHOT),
      pattern_memory_snapshots: (function () {
        var v = readJson(PATTERN_KEY);
        return v && Array.isArray(v.snapshots) ? v.snapshots.length : null;
      })()
    };
  }

  function guardedLoad() {
    var fromOrig = [];
    try {
      if (typeof loadBlackboxHistory === 'function') {
        fromOrig = loadBlackboxHistory() || [];
      }
    } catch (_) {}
    if (looksLikeBriefSnapshots(fromOrig) || (Array.isArray(fromOrig) && fromOrig.length)) {
      return fromOrig;
    }
    return readBriefHistory();
  }

  if (typeof loadBlackboxHistory === 'function') {
    var origLoad = loadBlackboxHistory;
    loadBlackboxHistory = function () {
      var rows = origLoad();
      if (Array.isArray(rows) && rows.length) return rows;
      return readBriefHistory();
    };
  }

  if (typeof detectCoordination === 'function') {
    var origDetect = detectCoordination;
    detectCoordination = function (history) {
      var h = history;
      if (!Array.isArray(h) || !h.length) h = guardedLoad();
      return origDetect(h);
    };
  }

  function _num(v) {
    var n = Number(v);
    return Number.isFinite(n) ? n : 0;
  }

  function compactBriefSnapshot(p) {
    p = (p && typeof p === 'object') ? p : {};
    var transfers = Array.isArray(p.large_transfers) ? p.large_transfers.slice() : [];
    transfers.sort(function (a, b) { return _num(b && b.amount) - _num(a && a.amount); });
    transfers = transfers.slice(0, MAX_LARGE_TRANSFERS).map(function (t) {
      return {
        from: t && t.from || '',
        to: t && t.to || '',
        sender_label: t && t.sender_label || '',
        receiver_label: t && t.receiver_label || '',
        amount: _num(t && t.amount),
        classification: t && t.classification || '',
        hash: t && t.hash || '',
        date: t && t.date || ''
      };
    });

    var walletCount = Array.isArray(p.wallet_results) ? p.wallet_results.length :
      (Array.isArray(p.wallets) ? p.wallets.length : _num(p.wallets_checked || p.watchlist_total));
    var txCount = Array.isArray(p.txs) ? p.txs.length : _num(p.tx_24h_count || p.transactions);
    var offerCount = 0;
    try {
      if (Array.isArray(p.offers)) offerCount = p.offers.length;
      else if (typeof state === 'object' && state && Array.isArray(state.offers)) offerCount = state.offers.length;
    } catch (_) {}
    var discoveryCount = Array.isArray(p.discovery_inbox) ? p.discovery_inbox.length : 0;

    return {
      schema: 'shadowwatch-brief-snapshot/1',
      ts: _num(p.ts) || Date.now(),
      date: p.date || '',
      report_id: p.report_id || (p.seal && p.seal.report_id) || '',
      scan_id: p.scan_id || '',
      data_as_of_utc: p.data_as_of_utc || '',
      counts: {
        wallets: walletCount,
        transactions: txCount,
        large_transfers: Array.isArray(p.large_transfers) ? p.large_transfers.length : transfers.length,
        offers: offerCount,
        discovery: discoveryCount
      },
      large_transfers: transfers
    };
  }

  function snapshotKey(s) {
    if (!s || typeof s !== 'object') return '';
    return s.report_id || s.scan_id ||
      ((s.date || '') + '|' + (s.data_as_of_utc || '') + '|' + String(s.ts || ''));
  }

  function jsonBytes(text) {
    try {
      if (typeof TextEncoder !== 'undefined') return new TextEncoder().encode(text).length;
    } catch (_) {}
    return String(text || '').length;
  }

  function fitHistory(rows) {
    var out = (Array.isArray(rows) ? rows : []).slice(-MAX_BRIEF_SNAPSHOTS);
    var text = JSON.stringify(out);
    while (out.length > 1 && jsonBytes(text) > MAX_BRIEF_BYTES) {
      out.shift();
      text = JSON.stringify(out);
    }
    return { rows: out, text: text, bytes: jsonBytes(text) };
  }

  function persistBriefSnapshot(snapshot) {
    var prior = readJson(BRIEF_BLACKBOX);
    if (!Array.isArray(prior)) prior = [];

    // Migrate any old/full snapshots at the write boundary. A prior build may
    // already have stored wallets/offers or, via the old guard fallback, the
    // entire live pack. None of that is allowed back into v34.
    var saved = prior.map(compactBriefSnapshot);
    if (snapshot && typeof snapshot === 'object') {
      var compact = compactBriefSnapshot(snapshot);
      var key = snapshotKey(compact);
      var replaced = false;
      for (var i = saved.length - 1; i >= 0; i--) {
        if (key && snapshotKey(saved[i]) === key) {
          saved[i] = compact;
          replaced = true;
          break;
        }
      }
      if (!replaced) saved.push(compact);
    }

    var fitted = fitHistory(saved);
    localStorage.setItem(BRIEF_BLACKBOX, fitted.text);
    try {
      if (typeof log === 'function') {
        log('BLACK_BOX: snapshot saved (' + fitted.rows.length + '/' + MAX_BRIEF_SNAPSHOTS +
          ') · ' + fitted.bytes + ' bytes');
      }
    } catch (_) {}
    return fitted.rows;
  }

  function coordinationUnavailable(saved, err) {
    return {
      pairs: [],
      snapshots_analyzed: Array.isArray(saved) ? saved.length : 0,
      unavailable: true,
      reason: 'COORDINATION_UNAVAILABLE',
      summary: 'COORDINATION_UNAVAILABLE' + (err && err.message ? ': ' + err.message : '')
    };
  }

  function refreshCoordination(saved, p) {
    saved = Array.isArray(saved) ? saved : readBriefHistory();
    var coord = null;
    try {
      coord = (typeof detectCoordination === 'function')
        ? detectCoordination(saved)
        : coordinationUnavailable(saved, new Error('detector unavailable'));
    } catch (e) {
      coord = coordinationUnavailable(saved, e);
      try {
        if (typeof log === 'function') log('COORDINATION_UNAVAILABLE: ' + (e && e.message || e));
      } catch (_) {}
    }
    if (!coord || typeof coord !== 'object') coord = coordinationUnavailable(saved);
    coord.snapshots_analyzed = saved.length;

    try {
      if (typeof state === 'object' && state) {
        state.blackbox = saved;
        state.coordination = coord;
      }
    } catch (_) {}
    if (p && typeof p === 'object') p.coordination = coord;
    return coord;
  }

  if (typeof saveBlackboxSnapshot === 'function') {
    var origSave = saveBlackboxSnapshot;
    saveBlackboxSnapshot = function (p) {
      // Do NOT call the legacy saver. It serializes wallet/offers arrays and
      // the old guard could fall back to persisting the entire live pack.
      // This wrapper is now the only v34 writer and is deliberately compact.
      var saved;
      try {
        saved = persistBriefSnapshot(p);
      } catch (e) {
        saved = readBriefHistory();
        try {
          if (typeof log === 'function') log('BLACK_BOX compact save unavailable: ' + (e && e.message || e));
        } catch (_) {}
      }
      refreshCoordination(saved, p);
      return saved;
    };
    saveBlackboxSnapshot._swCompactMemory = true;
    saveBlackboxSnapshot._original = origSave;
  }

  function guardedSetItem(origSet, thisArg, key, value) {
    if (key === BRIEF_BLACKBOX) {
      try {
        var incoming = JSON.parse(String(value));
        var existing = readJson(BRIEF_BLACKBOX);
        if (Array.isArray(incoming) && incoming.length === 0 &&
            Array.isArray(existing) && existing.length > 0) {
          try {
            if (typeof log === 'function') {
              log('BLACK_BOX guard: refused empty overwrite of ' + existing.length + ' snapshot(s).');
            }
          } catch (_) {}
          return;
        }
        if (Array.isArray(incoming)) {
          var normalized = fitHistory(incoming.map(compactBriefSnapshot));
          value = normalized.text;
        }
      } catch (_) {}
    }
    return origSet.call(thisArg, key, value);
  }

  if (typeof localStorage !== 'undefined' && localStorage.setItem && !localStorage.__swMemoryGuard) {
    var origLocalSet = localStorage.setItem.bind(localStorage);
    localStorage.setItem = function (key, value) {
      return guardedSetItem(origLocalSet, localStorage, key, value);
    };
    localStorage.__swMemoryGuard = true;
  }

  if (typeof Storage !== 'undefined' && Storage.prototype && !Storage.prototype.__swMemoryGuard) {
    var origProtoSet = Storage.prototype.setItem;
    Storage.prototype.setItem = function (key, value) {
      return guardedSetItem(origProtoSet, this, key, value);
    };
    Storage.prototype.__swMemoryGuard = true;
  }

  window.SW_MEMORY_GUARD = {
    version: '2026.09.26.1',
    probe: probe,
    readBriefHistory: readBriefHistory,
    compactBriefSnapshot: compactBriefSnapshot,
    persistBriefSnapshot: persistBriefSnapshot,
    refreshCoordination: refreshCoordination,
    fitHistory: fitHistory,
    limits: {
      snapshots: MAX_BRIEF_SNAPSHOTS,
      bytes: MAX_BRIEF_BYTES,
      large_transfers: MAX_LARGE_TRANSFERS
    },
    keys: {
      BRIEF_BLACKBOX: BRIEF_BLACKBOX,
      OUTER_BLACKBOX: OUTER_BLACKBOX,
      PATTERN_KEY: PATTERN_KEY
    }
  };

  try {
    if (typeof log === 'function') log('[memory-guard] installed');
  } catch (_) {}
})();

(function loadPreviewFenceFromMemoryGuard() {
  try {
    if (document.querySelector('script[data-sw-preview-fence]')) return;
    var g = document.createElement('script');
    g.src = '/src/brief/47-preview-no-direct-xrpl-20260923.js';
    g.async = false;
    g.setAttribute('data-sw-preview-fence', '2026-09-23.1');
    document.body.appendChild(g);
  } catch (_) {}
})();


(function loadCoordinationRenderPatch() {
  try {
    if (document.querySelector('script[data-sw-coordination-render]')) return;
    var g = document.createElement('script');
    g.src = '/src/brief/48-coordination-render-20260923.js';
    g.async = false;
    g.setAttribute('data-sw-coordination-render', '2026-09-23.1');
    document.body.appendChild(g);
  } catch (_) {}
})();
