(function () {
  'use strict';
  // Only these Brief stores migrate. Never patch Storage or touch other apps.
  var keys = ['shadowDiscoveryInbox','shadowDiscoveryHistory','shadowDiscoverySettings','shadowwatch_blackbox_v34'];
  var cache = Object.create(null), revision = Object.create(null), db, chain = Promise.resolve();
  keys.forEach(function (key) { revision[key]=0; try { cache[key]=localStorage.getItem(key); } catch (_) { cache[key]=null; } });
  function transaction(mode, operation) {
    return new Promise(function (resolve,reject) {
      var tx=db.transaction('values',mode), result;
      var timer=setTimeout(function () { try { tx.abort(); } catch (_) {} reject(Error('HISTORY_STORAGE_TIMEOUT')); },4000);
      tx.oncomplete=function () { clearTimeout(timer); resolve(result); };
      tx.onabort=tx.onerror=function () { clearTimeout(timer); reject(tx.error || Error('HISTORY_STORAGE_FAILED')); };
      var request=operation(tx.objectStore('values'));
      request.onsuccess=function () { result=request.result; };
    });
  }
  async function persist(key,value) {
    await transaction('readwrite',function (s) { return s.put({key:key,value:value}); });
    var checked=await transaction('readonly',function (s) { return s.get(key); });
    if (!checked || checked.value!==value) throw Error('HISTORY_STORAGE_VERIFY_FAILED');
    // Free localStorage only after the exact data is durably read back.
    try { if (localStorage.getItem(key)===value) localStorage.removeItem(key); } catch (_) {}
  }
  var ready = new Promise(function (resolve,reject) {
    var request=indexedDB.open('SW_BRIEF_HISTORY_V1',1);
    var settled=false;
    var timer=setTimeout(function () { settled=true; reject(Error('HISTORY_STORAGE_OPEN_TIMEOUT')); },4000);
    request.onupgradeneeded=function () { request.result.createObjectStore('values',{keyPath:'key'}); };
    request.onsuccess=function () { clearTimeout(timer); if(settled){request.result.close();return;} settled=true; db=request.result; resolve(); };
    request.onerror=request.onblocked=function () { clearTimeout(timer); settled=true; reject(request.error || Error('HISTORY_STORAGE_UNAVAILABLE')); };
  }).then(async function () {
    for (var key of keys) {
      var row=await transaction('readonly',function (s) { return s.get(key); });
      if (revision[key]) continue;
      if (cache[key]!==null) await persist(key,cache[key]);
      else if (row) cache[key]=row.value;
    }
    return true;
  }).catch(function (error) { console.warn('[history-storage]',error.message); return false; });
  function read(key) {
    if (keys.indexOf(key)<0) throw Error('UNSUPPORTED_HISTORY_KEY');
    return cache[key];
  }
  function write(key,value) {
    if (keys.indexOf(key)<0) throw Error('UNSUPPORTED_HISTORY_KEY');
    cache[key]=String(value); revision[key]++;
    chain=chain.catch(function () {}).then(async function () {
      await ready;
      if (!db) { localStorage.setItem(key,value); return; }
      await persist(key,String(value));
    });
    return chain;
  }
  function remove(key) {
    if (keys.indexOf(key)<0) throw Error('UNSUPPORTED_HISTORY_KEY');
    cache[key]=null; revision[key]++;
    chain=chain.catch(function () {}).then(async function () {
      await ready;
      if(db) await transaction('readwrite',function(s){return s.delete(key);});
      localStorage.removeItem(key);
    });
    return chain;
  }
  window.SW_HISTORY_STORAGE={ready:ready,read:read,write:write,remove:remove,flush:function(){return chain;}};
})();
