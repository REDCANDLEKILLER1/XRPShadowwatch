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

  function persistBriefSnapshot(snapshot) {
    var saved = readJson(BRIEF_BLACKBOX);
    if (!Array.isArray(saved)) saved = [];
    if (snapshot && typeof snapshot === 'object') {
      saved.push(snapshot);
      if (saved.length > 30) saved = saved.slice(saved.length - 30);
      localStorage.setItem(BRIEF_BLACKBOX, JSON.stringify(saved));
    }
    return saved;
  }

  function refreshCoordination(saved, p) {
    saved = Array.isArray(saved) ? saved : readBriefHistory();
    if (typeof state === 'object' && state) {
      state.blackbox = saved;
      if (typeof detectCoordination === 'function') {
        state.coordination = detectCoordination(saved);
        // Contract: the count is the persisted v34 array length, regardless of
        // any legacy detector default/warm-up behavior.
        if (!state.coordination || typeof state.coordination !== 'object') state.coordination = {};
        state.coordination.snapshots_analyzed = saved.length;
        if (p) p.coordination = state.coordination;
      }
    }
    return saved;
  }

  if (typeof saveBlackboxSnapshot === 'function') {
    var origSave = saveBlackboxSnapshot;
    saveBlackboxSnapshot = function (p) {
      var before = readBriefHistory().length;
      origSave(p);
      var saved = readBriefHistory();

      // Some live save paths write only Outer/legacy boxes. If v34 did not
      // advance, persist this Brief snapshot here. Never count Outer as Brief.
      if (saved.length <= before && p && typeof p === 'object') {
        saved = persistBriefSnapshot(p);
      }
      refreshCoordination(saved, p);
    };
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
    version: '2026.09.23.2',
    probe: probe,
    readBriefHistory: readBriefHistory,
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
