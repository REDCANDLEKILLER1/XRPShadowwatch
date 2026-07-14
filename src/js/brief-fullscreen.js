
    (function(){
      var _loaded = false;
      // Leaving Shadow Watch returns to HOME / Mission Control (the main screen),
      // not the live XRPL stream.
      window.exitBriefFullscreen = function(){ try { switchView('home'); } catch(e){} };
      window.loadBriefConsole = function(){
        try {
          var vb = document.getElementById('view-brief');
          if (vb && vb.parentNode !== document.body) document.body.appendChild(vb);
        } catch(e){}
        if (_loaded) return;
        _loaded = true;
        try {
          // Brief Console (XRPMAN SHADOW WATCH v3.31) is now a real file loaded
          // directly into the iframe, instead of a base64 Blob decoded at runtime.
          var frame = document.getElementById('brief-frame');
          if (frame) frame.src = './brief-console.html';
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
