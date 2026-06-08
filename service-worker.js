// ════════════════════════════════════════════════════════════════════
//  service-worker.js — PWA オフラインキャッシュ
//  戦略: Cache First（キャッシュ優先）
//  ※ Tone.js (CDN) はクロスオリジンのためキャッシュ対象外
// ════════════════════════════════════════════════════════════════════

const CACHE_NAME = 'motion-vertex-v2';

const PRECACHE_URLS = [
  './',
  './index.html',
  './camera.js',
  './paths.js',
  './audio.js',
  './visual.js',
  './ui.js',
  './manifest.json',
  './icon.svg',
];

// ── インストール: 全ファイルをキャッシュに追加 ──
self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then(cache => cache.addAll(PRECACHE_URLS))
      .then(() => self.skipWaiting())
  );
});

// ── アクティベート: 古いキャッシュを削除 ──
self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys()
      .then(keys => Promise.all(
        keys
          .filter(key => key !== CACHE_NAME)
          .map(key => caches.delete(key))
      ))
      .then(() => self.clients.claim())
  );
});

// ── フェッチ: キャッシュ優先、なければネットワーク ──
self.addEventListener('fetch', event => {
  // 同一オリジンのリクエストのみ処理
  if (!event.request.url.startsWith(self.location.origin)) return;

  event.respondWith(
    caches.match(event.request).then(cached => {
      if (cached) return cached;

      return fetch(event.request).then(response => {
        // 有効なレスポンスのみキャッシュに保存
        if (!response || response.status !== 200 || response.type === 'opaque')
          return response;
        const clone = response.clone();
        caches.open(CACHE_NAME).then(cache => cache.put(event.request, clone));
        return response;
      }).catch(() => {
        // オフライン時: index.html にフォールバック
        if (event.request.mode === 'navigate')
          return caches.match('./index.html');
      });
    })
  );
});
