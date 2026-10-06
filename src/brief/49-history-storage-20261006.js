(function () {
  'use strict';
  var keys = ['shadowDiscoveryInbox','shadowDiscoveryHistory','shadowDiscoverySettings','shadowwatch_blackbox_v34'];
  var cache = Object.create(null), revision = Object.create(null), chain = Promise.resolve();
  keys.forEach(function (key) { revision[key]=0; try { cache[key]=localStorage.getItem(key); } catch (_) { cache[key]=null; } });
  function transaction(mode, operation) {
    return window.SW_DURABLE_STORAGE.run('SW_BRIEF_HISTORY_V1','values','key',mode,operation);
  }
  async function persist(key,value) {
    await transaction('readwrite',function (s) { return s.put({key:key,value:value}); });
    var checked=await transaction('readonly',function (s) { return s.get(key); });
    if (!checked || checked.value!==value) throw Error('HISTORY_STORAGE_VERIFY_FAILED');
    try { if (localStorage.getItem(key)===value) localStorage.removeItem(key); } catch (_) {}
  }
  var ready = (async function () {
    for (var key of keys) {
      var row=await transaction('readonly',function (s) { return s.get(key); });
      if (revision[key]) continue;
      if (cache[key]!==null) await persist(key,cache[key]);
      else if (row) cache[key]=row.value;
    }
    return true;
  })().catch(function (error) { console.warn('[history-storage]',error.message); return false; });
  function supported(key) { if (keys.indexOf(key)<0) throw Error('UNSUPPORTED_HISTORY_KEY'); }
  function read(key) { supported(key); return cache[key]; }
  function write(key,value) {
    supported(key); value=String(value); cache[key]=value; revision[key]++;
    chain=chain.catch(function () {}).then(async function () {
      await ready;
      try { await persist(key,value); }
      catch (error) {
        // Never clear the existing source on a failed IndexedDB migration.
        window.SW_DURABLE_STORAGE.localWrite(key,value);
      }
    });
    return chain;
  }
  function remove(key) {
    supported(key); cache[key]=null; revision[key]++;
    chain=chain.catch(function () {}).then(async function () {
      await ready;
      // Failed deletion is reported rather than resurrecting old disk data.
      await transaction('readwrite',function(s){return s.delete(key);});
      localStorage.removeItem(key);
    });
    return chain;
  }
  window.SW_HISTORY_STORAGE={ready:ready,read:read,write:write,remove:remove,flush:function(){return chain;}};
})();
