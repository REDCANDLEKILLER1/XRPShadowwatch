/* PWA glue: register the service worker and offer an install affordance. */
(function () {
  'use strict';

  if ('serviceWorker' in navigator) {
    window.addEventListener('load', function () {
      navigator.serviceWorker.register('/sw.js').catch(function (e) {
        console.warn('[pwa] SW registration failed', e);
      });
    });
    // When a new service worker takes control (new deploy), reload once so the
    // page runs the latest code instead of a stale cached bundle.
    var _reloaded = false;
    navigator.serviceWorker.addEventListener('controllerchange', function () {
      if (_reloaded) return; _reloaded = true;
      window.location.reload();
    });
  }

  var deferred = null;

  window.addEventListener('beforeinstallprompt', function (e) {
    e.preventDefault();        // suppress the mini-infobar; we provide our own button
    deferred = e;
    showInstall();
  });
  window.addEventListener('appinstalled', function () { deferred = null; hideInstall(); });

  function showInstall() {
    if (document.getElementById('pwa-install')) return;
    var b = document.createElement('button');
    b.id = 'pwa-install';
    b.textContent = '⊕ INSTALL APP';
    b.style.cssText = 'position:fixed;left:50%;transform:translateX(-50%);bottom:18px;z-index:9999;' +
      'background:#001100;color:#00ff00;border:1px solid #00ff00;border-radius:24px;padding:10px 18px;' +
      'font-family:"Orbitron",sans-serif;font-size:12px;letter-spacing:1px;cursor:pointer;' +
      'box-shadow:0 0 18px rgba(0,255,0,0.4);';
    b.addEventListener('click', function () {
      if (!deferred) return;
      deferred.prompt();
      deferred.userChoice.finally(function () { deferred = null; hideInstall(); });
    });
    document.body.appendChild(b);
    setTimeout(hideInstall, 12000); // show briefly, don't nag
  }
  function hideInstall() { var b = document.getElementById('pwa-install'); if (b) b.remove(); }
})();
