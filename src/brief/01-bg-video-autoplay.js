/* Genesis pre-core persistence checkpoint.
   This runs before 02-core.js, so it can preserve the browser's existing
   Report memory before any scan/startup code mutates it. Memory-only capture:
   no localStorage writes, no network calls, no scanner changes. */
(function(){
  'use strict';
  try {
    if (window.SW_GENESIS_PRECORE_20260816) return;

    function secretName(k){
      return /^(seed|secret|private_?key|privatekey|mnemonic|passphrase|password|access_?token|auth_?token|bearer)$/i.test(String(k || ''));
    }
    function fnvString(str){
      str=String(str==null?'':str);
      var h=2166136261;
      for(var i=0;i<str.length;i++){ h^=str.charCodeAt(i); h=Math.imul(h,16777619); }
      return ('00000000'+(h>>>0).toString(16)).slice(-8)+':'+str.length;
    }
    function snap(store){
      var rows=[];
      if(!store) return rows;
      try{
        var keys=[];
        for(var i=0;i<store.length;i++) keys.push(store.key(i));
        keys.filter(Boolean).sort().forEach(function(key){
          var raw=null;
          try{ raw=store.getItem(key); }catch(_){}
          rows.push({
            key:key,
            bytes_utf16_approx:raw==null?0:raw.length*2,
            fingerprint:fnvString(raw||''),
            value_raw:secretName(key)?'[REDACTED_BY_GENESIS_CAPTURE]':raw
          });
        });
      }catch(e){ rows.push({key:'[STORAGE_READ_FAILED]',error:String(e&&e.message||e)}); }
      return rows;
    }

    window.SW_GENESIS_PRECORE_20260816={
      version:'2026.08.16.3',
      captured_at:new Date().toISOString(),
      capture_point:'01-bg-video-autoplay.js before 02-core.js',
      read_only:true,
      local_storage:snap((function(){try{return localStorage;}catch(_){return null;}})()),
      session_storage:snap((function(){try{return sessionStorage;}catch(_){return null;}})())
    };
  }catch(_){}
})();

(function(){
  var v=document.getElementById('swBgVideo'); if(!v) return;
  v.muted=true; v.defaultMuted=true;
  function kick(){ try{ var p=v.play(); if(p&&p.catch) p.catch(function(){}); }catch(_){} }
  kick();
  window.addEventListener('load', kick);
  ['pointerdown','touchstart','click','visibilitychange'].forEach(function(ev){
    document.addEventListener(ev, kick, {passive:true});
  });
})();
