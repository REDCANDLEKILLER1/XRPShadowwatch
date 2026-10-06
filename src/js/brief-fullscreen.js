(function () {
  'use strict';
  var loaded = false, timer = null, attempt = 0;
  window.exitBriefFullscreen = function () { try { switchView('home'); } catch (_) {} };
  function clearNotice() {
    var notice = document.getElementById('brief-load-notice');
    if (notice) notice.remove();
  }
  function showRecovery() {
    loaded = false;
    if (document.getElementById('brief-load-notice')) return;
    var panel = document.getElementById('view-brief');
    if (!panel) return;
    var notice = document.createElement('div');
    notice.id = 'brief-load-notice';
    notice.style.cssText = 'position:absolute;inset:80px 12px auto;z-index:10;background:#001100;color:#00ff00;border:1px solid #00ff00;padding:20px;font-family:monospace;text-align:center;';
    var message = document.createElement('p');
    message.textContent = 'The report console has not loaded. Retry, or open it directly.';
    var retry = document.createElement('button');
    retry.textContent = 'Retry report console';
    retry.style.cssText = 'padding:12px;margin:8px;color:#00ff00;background:#000;border:1px solid #00ff00;';
    retry.onclick = function () { loaded = false; window.loadBriefConsole(); };
    var direct = document.createElement('a');
    direct.textContent = 'Open report directly';
    direct.href = '/brief-console.html';
    direct.style.cssText = 'display:inline-block;padding:12px;color:#00ff00;';
    notice.append(message, retry, direct);
    panel.appendChild(notice);
  }
  window.loadBriefConsole = function () {
    var panel = document.getElementById('view-brief');
    if (panel && panel.parentNode !== document.body) document.body.appendChild(panel);
    if (loaded) return;
    var frame = document.getElementById('brief-frame');
    if (!frame) return;
    loaded = true;
    clearNotice();
    clearInterval(timer);
    var ours = document.getElementById('brief-exit');
    if (ours) ours.style.display = '';
    var started = Date.now(), id = ++attempt;
    function check() {
      if (id !== attempt) return;
      var theirs;
      try { theirs = frame.contentDocument && frame.contentDocument.querySelector('.sw-hbtn.sw-exit'); } catch (_) {}
      if (theirs) {
        loaded = true;
        clearNotice();
        if (ours) ours.style.display = 'none';
        clearInterval(timer);
      } else if (Date.now() - started >= 20000) {
        // Keep checking: a late successful load may still replace the notice.
        showRecovery();
        if (Date.now() - started >= 60000) clearInterval(timer);
      }
    }
    frame.onload = check;
    frame.onerror = showRecovery;
    timer = setInterval(check, 250);
    // Root-relative also works when the shell is entered on a nested route.
    frame.src = '/brief-console.html' + (id > 1 ? '?viewer_retry=' + id : '');
  };
})();
