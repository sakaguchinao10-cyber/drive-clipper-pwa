// DriveNotes サービスワーカー
// ・アプリ本体だけをキャッシュ（ノートのデータはキャッシュしない）
// ・Android の「共有」から送られた内容（共有ターゲット）を一時保管して登録画面へ渡す
const VERSION = 'drivenotes-v6';
const SHARE_CACHE = 'drivenotes-share';
const SHELL = ['./', 'index.html', 'style.css', 'app.js', 'config.js', 'manifest.webmanifest',
  'icon-192.png', 'icon-512.png', 'lib/marked.min.js', 'lib/purify.min.js'];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(VERSION).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys()
    .then((keys) => Promise.all(keys.filter((k) => k !== VERSION && k !== SHARE_CACHE).map((k) => caches.delete(k))))
    .then(() => self.clients.claim()));
});

async function receiveShare(request) {
  const scope = self.registration.scope;
  try {
    const form = await request.formData();
    await caches.delete(SHARE_CACHE); // 前回分は捨てる
    const cache = await caches.open(SHARE_CACHE);
    const files = form.getAll('files').filter((f) => f && typeof f !== 'string' && f.size > 0);
    const meta = { title: form.get('title') || '', text: form.get('text') || '', url: form.get('url') || '', count: files.length, at: Date.now() };
    await cache.put(new URL('share/meta', scope).href, new Response(JSON.stringify(meta), { headers: { 'content-type': 'application/json' } }));
    for (const [i, f] of files.entries()) {
      await cache.put(new URL(`share/file/${i}`, scope).href, new Response(f, {
        headers: { 'content-type': f.type || 'application/octet-stream', 'x-file-name': encodeURIComponent(f.name || `file${i + 1}`) },
      }));
    }
    return Response.redirect(new URL('./#/new?shared=1', scope).href, 303);
  } catch {
    return Response.redirect(new URL('./#/new?shared=error', scope).href, 303);
  }
}

self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (e.request.method === 'POST' && url.origin === self.location.origin && url.pathname.endsWith('/share-target')) {
    e.respondWith(receiveShare(e.request));
    return;
  }
  if (e.request.method !== 'GET' || url.origin !== self.location.origin) return; // Google API・ログインは素通し
  // 通信優先、オフライン時はキャッシュ
  e.respondWith(fetch(e.request).then((res) => {
    if (res.ok) { const copy = res.clone(); caches.open(VERSION).then((c) => c.put(e.request, copy)); }
    return res;
  }).catch(() => caches.match(e.request, { ignoreSearch: true }).then((r) => r || caches.match('index.html'))));
});
