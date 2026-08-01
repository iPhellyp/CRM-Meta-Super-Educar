const CACHE_PREFIX = 'crm-meta-public-';
const CACHE_NAME = `${CACHE_PREFIX}v11`;
const PUBLIC_ASSETS = [
  '/app.css?v=11',
  '/app.js?v=11',
  '/manifest.webmanifest',
  '/offline.html',
  '/icons/app-icon-192.png',
  '/icons/app-icon-512.png',
  '/icons/app-icon-maskable-512.png',
  '/icons/app-icon.svg',
  '/icons/app-icon-maskable.svg',
];
const PUBLIC_PATHS = new Set(PUBLIC_ASSETS.map((asset) => new URL(asset, self.location.origin).pathname));

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(CACHE_NAME).then((cache) => cache.addAll(PUBLIC_ASSETS)));
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) => Promise.all(
      keys
        .filter((key) => key.startsWith(CACHE_PREFIX) && key !== CACHE_NAME)
        .map((key) => caches.delete(key)),
    )),
  );
});

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;

  if (request.mode === 'navigate') {
    event.respondWith(
      fetch(request).catch(() => caches.match('/offline.html')),
    );
    return;
  }

  if (!PUBLIC_PATHS.has(url.pathname)) return;
  event.respondWith(
    caches.match(request).then((cached) => cached || fetch(request)),
  );
});

self.addEventListener('message', (event) => {
  if (event.data?.type === 'SKIP_WAITING') {
    self.skipWaiting();
    return;
  }
  if (event.data?.type === 'CLEAR_APP_CACHES') {
    event.waitUntil(
      caches.keys().then((keys) => Promise.all(
        keys.filter((key) => key.startsWith(CACHE_PREFIX)).map((key) => caches.delete(key)),
      )),
    );
  }
});
