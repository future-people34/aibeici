/* 爱背词 Service Worker —— 让 PWA 可安装、可离线打开 */
const VERSION = 'aibeici-v1';
const SHELL = `${VERSION}-shell`;
const RUNTIME = `${VERSION}-runtime`;

self.addEventListener('install', (event) => {
  event.waitUntil(
    (async () => {
      const cache = await caches.open(SHELL);
      await cache.addAll(['/', '/manifest.webmanifest']).catch(() => {});
      await self.skipWaiting();
    })(),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      const keys = await caches.keys();
      await Promise.all(keys.filter((k) => !k.startsWith(VERSION)).map((k) => caches.delete(k)));
      await self.clients.claim();
    })(),
  );
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;

  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;
  if (url.pathname.startsWith('/api/')) return;

  // 页面导航：网络优先，离线时回退到缓存的首页
  if (req.mode === 'navigate') {
    event.respondWith(
      (async () => {
        try {
          const fresh = await fetch(req);
          const cache = await caches.open(SHELL);
          cache.put('/', fresh.clone());
          return fresh;
        } catch {
          const cache = await caches.open(SHELL);
          return (
            (await cache.match('/')) ||
            new Response('<h1>离线</h1><p>请联网后重新打开爱背词。</p>', {
              headers: { 'content-type': 'text/html; charset=utf-8' },
            })
          );
        }
      })(),
    );
    return;
  }

  // 静态资源：缓存优先 + 后台更新
  event.respondWith(
    (async () => {
      const cache = await caches.open(RUNTIME);
      const hit = await cache.match(req);
      const network = fetch(req)
        .then((res) => {
          if (res.ok) cache.put(req, res.clone());
          return res;
        })
        .catch(() => null);
      return hit || (await network) || new Response('', { status: 504 });
    })(),
  );
});
