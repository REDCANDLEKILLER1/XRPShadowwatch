/* PWA glue: register the service worker and offer an install affordance. */
(function () {
  'use strict';

  // DE-CACHE MODE: we no longer register a caching service worker (it kept
  // serving stale code during active development). Instead, force any worker a
  // user already has to re-check /sw.js — which is now a self-retiring worker
  // that clears caches and unregisters. We do NOT register a new one, so there
  // is no reload loop.
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.getRegistrations()
      .then(function (regs) { regs.forEach(function (r) { try { r.update(); } catch (e) {} }); })
      .catch(function () {});
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
