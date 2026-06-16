
    (function(){
      var _loaded = false;
      window.exitBriefFullscreen = function(){ try { switchView('live'); } catch(e){} };
      window.loadBriefConsole = function(){
        try {
          var vb = document.getElementById('view-brief');
          if (vb && vb.parentNode !== document.body) document.body.appendChild(vb);
        } catch(e){}
        if (_loaded) return;
        _loaded = true;
        try {
          var b64 = window.__BRIEF_CONSOLE_B64 || '';
          var bin = atob(b64);
          var n = bin.length;
          var bytes = new Uint8Array(n);
          for (var i = 0; i < n; i++) bytes[i] = bin.charCodeAt(i);
          var blob = new Blob([bytes], { type: 'text/html' });
          var url = URL.createObjectURL(blob);
          var frame = document.getElementById('brief-frame');
          if (frame) frame.src = url;
        } catch (e) {
          _loaded = false;
          try { console.error('[BRIEF] load failed:', e); } catch(_){}
          var f = document.getElementById('brief-frame');
          if (f) {
            f.outerHTML = '<div style="color:#00ff00;font-family:monospace;padding:24px;text-align:center;line-height:1.6;">BRIEF CONSOLE FAILED TO LOAD<br><span style="color:#066;font-size:11px;">' + (e && e.message || '') + '</span></div>';
          }
        }
      };
    })();
    