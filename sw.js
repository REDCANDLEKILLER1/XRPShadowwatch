/* XRPMAN Shadow Watch — service worker (app shell cache for installable PWA).
   Bump CACHE on every deploy so clients pick up new assets. */
const CACHE = 'shadowwatch-v2';
const SHELL = [
  '/', '/index.html',
  '/src/css/styles.css',
  '/src/js/app.js',
  '/src/js/brief-fullscreen.js',
  '/src/js/boot-greeter.js',
  '/src/js/boot-scanner.js',
  '/src/js/risk.js',
  '/src/js/pwa.js',
  '/brief-console.html',
  '/manifest.webmanifest',
  '/src/assets/icon-192.png',
  '/src/assets/icon-512.png',
  '/src/assets/icon-180.png',
  '/src/assets/icon.svg'
];

self.addEventListener('install', (e) => {
  // Precache the shell; install even if a single asset fails (runtime cache fills the gap).
  e.waitUntil(
    caches.open(CACHE)
      .then((c) => Promise.allSettled(SHELL.map((u) => c.add(u))))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;             // never touch POST etc.
  let url;
  try { url = new URL(req.url); } catch (_) { return; }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return;

  // Stale-while-revalidate: serve cache fast, refresh same-origin in background.
  e.respondWith(
    caches.match(req).then((cached) => {
      const net = fetch(req).then((res) => {
        if (res && res.status === 200 && url.origin === location.origin) {
          const copy = res.clone();
          caches.open(CACHE).then((c) => c.put(req, copy));
        }
        return res;
      }).catch(() => cached);
      return cached || net;
    })
  );
});
