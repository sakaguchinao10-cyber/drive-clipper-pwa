const CACHE_NAME = 'driveclipper-v1';
const ASSETS = [
  '/drive-clipper-pwa/',
  '/drive-clipper-pwa/index.html',
  '/drive-clipper-pwa/manifest.webmanifest',
];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE_NAME).then(c => c.addAll(ASSETS)));
  self.skipWaiting();
});

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys().then(keys =>
      Promise.all(keys.filter(k => k !== CACHE_NAME).map(k => caches.delete(k)))
    )
  );
  self.clients.claim();
});

self.addEventListener('fetch', e => {
  // Share Target GETリクエストはネットワーク優先
  if (e.request.url.includes('?')) {
    e.respondWith(fetch(e.request).catch(() => caches.match('/drive-clipper-pwa/index.html')));
    return;
  }
  // その他はキャッシュ優先
  e.respondWith(
    caches.match(e.request).then(r => r || fetch(e.request))
  );
});
