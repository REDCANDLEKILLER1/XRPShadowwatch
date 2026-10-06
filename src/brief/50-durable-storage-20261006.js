(function () {
  'use strict';
  var connections = Object.create(null);
  function discard(name, entry) {
    if (!entry || connections[name] !== entry) return;
    delete connections[name];
    try { if (entry.db) entry.db.close(); } catch (_) {}
  }
  function open(name, store, keyPath) {
    if (connections[name]) return connections[name].promise;
    var entry = {}; connections[name] = entry;
    entry.promise = new Promise(function (resolve, reject) {
      var request, settled = false;
      var timer = setTimeout(function () { fail(Error('PHONE_STORAGE_OPEN_TIMEOUT')); }, 4000);
      function fail(error) {
        if (settled) return;
        settled = true; clearTimeout(timer); discard(name, entry); reject(error);
      }
      try { request = indexedDB.open(name, 1); } catch (error) { fail(error); return; }
      request.onupgradeneeded = function () {
        if (!request.result.objectStoreNames.contains(store)) request.result.createObjectStore(store, {keyPath:keyPath});
      };
      request.onsuccess = function () {
        if (settled) { request.result.close(); return; }
        settled = true; clearTimeout(timer); entry.db = request.result;
        entry.db.onversionchange = function () { discard(name, entry); };
        entry.db.onclose = function () { discard(name, entry); };
        resolve(entry.db);
      };
      request.onerror = request.onblocked = function () { fail(request.error || Error('PHONE_STORAGE_UNAVAILABLE')); };
    });
    return entry.promise;
  }
  async function run(name, store, keyPath, mode, operation) {
    var pending = open(name, store, keyPath), entry = connections[name];
    var db = await pending;
    return new Promise(function (resolve, reject) {
      var tx, value, settled = false;
      var timer = setTimeout(function () {
        fail(Error('PHONE_STORAGE_TIMEOUT'));
        try { if (tx) tx.abort(); } catch (_) {}
      }, 4000);
      function fail(error) {
        if (settled) return;
        settled = true; clearTimeout(timer); discard(name, entry); reject(error);
      }
      try {
        tx = db.transaction(store, mode);
        tx.oncomplete = function () { if (settled) return; settled = true; clearTimeout(timer); resolve(value); };
        tx.onerror = tx.onabort = function () { fail(tx.error || Error('PHONE_STORAGE_FAILED')); };
        var request = operation(tx.objectStore(store));
        request.onsuccess = function () { value = request.result; };
        request.onerror = function () { fail(request.error || Error('PHONE_STORAGE_FAILED')); };
      } catch (error) { fail(error); }
    });
  }
  function localWrite(key, value) {
    localStorage.setItem(key, value);
    if (localStorage.getItem(key) !== value) throw Error('PHONE_STORAGE_VERIFY_FAILED');
  }
  window.SW_DURABLE_STORAGE = {run:run,localWrite:localWrite};
})();
