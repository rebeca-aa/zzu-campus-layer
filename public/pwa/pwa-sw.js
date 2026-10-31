/* 校园信息层 PWA service worker
   设计原则：**不缓存**业务资源，只做「离线兜底 + 极简壳缓存」。
   原因：壳里长期不关，凡是缓存优先都会出现「部署了但拿不到 / 拿到半套」，
   最终表现就是白屏；宁可离线时报错，也不要拿着旧 chunk 装新页面。 */

const SHELL = 'campus-layer-shell-v9';
const SHELL_FILES = ['./index.html'];

self.addEventListener('install', (e) => {
  /* 这里不再 skipWaiting：新 worker 装好后停在 waiting，
     等页面弹「新版本已就绪」，用户点更新时才接管。 */
  e.waitUntil(caches.open(SHELL).then((c) => c.addAll(SHELL_FILES)).catch(() => undefined));
});

self.addEventListener('message', (e) => {
  if (e.data && e.data.type === 'SKIP_WAITING') self.skipWaiting();
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== SHELL).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return; // 接口/第三方一律放行

  e.respondWith(
    fetch(req).catch(async () => {
      // 网络挂了：文档回退到壳，其它资源尽量回缓存，最后给一个可读的错误
      const hit = await caches.match(req);
      if (hit) return hit;
      if (req.mode === 'navigate') {
        const shell = await caches.match('./index.html');
        if (shell) return shell;
      }
      return new Response('离线且没有缓存：' + req.url, {
        status: 503,
        headers: { 'content-type': 'text/plain; charset=utf-8' },
      });
    }),
  );
});
