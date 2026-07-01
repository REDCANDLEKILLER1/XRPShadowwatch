/* XRPMAN Shadow Watch — SELF-RETIRING service worker (de-cache mode).
   Caching is intentionally OFF while the app is under active development so
   every deploy is fetched fresh (no stale "deployed but still old" state).
   This worker clears all caches, unregisters itself, and reloads open tabs.
   A caching/offline worker can be reintroduced later once things stabilize. */
self.addEventListener('install', function () { self.skipWaiting(); });

self.addEventListener('activate', function (e) {
  e.waitUntil((async function () {
    try {
      const keys = await caches.keys();
      await Promise.all(keys.map(function (k) { return caches.delete(k); }));
    } catch (_) {}
    try { await self.registration.unregister(); } catch (_) {}
    try {
      const cs = await self.clients.matchAll({ type: 'window' });
      cs.forEach(function (c) { try { c.navigate(c.url); } catch (_) {} });
    } catch (_) {}
  })());
});
/* No fetch handler → the browser always goes straight to the network. */
