/* Brief storage guard. Coordination is resolved by core before rendering.
 * No detector/renderer/save wrappers, no Outer-history adoption, no fetch hook.
 */
(function shadowMemoryGuard() {
  'use strict';
  if (window.SW_MEMORY_GUARD) return;
  var KEY = 'shadowwatch_blackbox_v34';
  var storage;
  try { storage = localStorage; } catch (_) { return; }
  function read(key) {
    try { return JSON.parse(storage.getItem(key)); } catch (_) { return null; }
  }
  function count(key) {
    var v = read(key);
    return Array.isArray(v) ? v.length : (v && Array.isArray(v.snapshots) ? v.snapshots.length : 0);
  }
  if (typeof Storage !== 'undefined' && Storage.prototype) {
    var nativeSet = Storage.prototype.setItem;
    Storage.prototype.setItem = function (key, value) {
      if (this === storage && String(key) === KEY) {
        var incoming;
        try { incoming = JSON.parse(String(value)); } catch (_) {}
        if (Array.isArray(incoming) && !incoming.length && count(KEY)) {
          try { log('BLACK_BOX guard: refused empty overwrite.'); } catch (_) {}
          return;
        }
      }
      return nativeSet.call(this, key, value);
    };
  }
  window.SW_MEMORY_GUARD = {
    version: '2026.09.23.3',
    readBriefHistory: function () { return loadBlackboxHistory(); },
    probe: function () {
      return {
        brief_blackbox_v34: count(KEY), outer_blackbox_v2: count('XRPMAN_BLACKBOX_V2'),
        legacy_snapshot_v30: count('shadowwatch_snapshot_v30'),
        pattern_memory_snapshots: count('SHADOW_WATCH_PATTERN_MEMORY_V1')
      };
    }
  };
  try { log('[memory-guard] installed'); } catch (_) {}
})();
