/**
 * PixelAnnex Service Worker
 * =========================
 * Caches static assets (HTML, topojson, fonts) for fast reloads.
 *
 * Strategy: stale-while-revalidate for HTML, cache-first for static assets.
 * Bypasses cache entirely for /api/* and ws:// connections.
 *
 * Version bumped per release so old caches get cleared automatically.
 */

const CACHE_VERSION = 'pixelannex-v2026-05-30-v90b';
const STATIC_ASSETS = [
  '/',
  '/index.html',
  '/countries-10m.json',
  '/favicon.ico',
];

// ── Install: pre-cache static assets ─────────────────────────────
self.addEventListener('install', (event) => {
  console.log('[SW] Installing', CACHE_VERSION);
  event.waitUntil(
    caches.open(CACHE_VERSION).then((cache) => {
      // Cache assets individually so one 404 doesn't fail the whole install
      return Promise.all(
        STATIC_ASSETS.map((url) =>
          cache.add(url).catch((err) => {
            console.warn('[SW] Failed to cache', url, err.message);
          })
        )
      );
    }).then(() => self.skipWaiting())
  );
});

// ── Activate: clean up old caches ────────────────────────────────
self.addEventListener('activate', (event) => {
  console.log('[SW] Activating', CACHE_VERSION);
  event.waitUntil(
    caches.keys().then((names) =>
      Promise.all(
        names
          .filter((n) => n.startsWith('pixelannex-') && n !== CACHE_VERSION)
          .map((n) => {
            console.log('[SW] Deleting old cache', n);
            return caches.delete(n);
          })
      )
    ).then(() => self.clients.claim())
  );
});

// ── Fetch: serve from cache when possible ────────────────────────
self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);

  // Never cache API calls, WebSockets, OAuth callbacks, sensitive paths
  if (
    url.pathname.startsWith('/api/') ||
    url.pathname.startsWith('/auth/') ||
    url.pathname.startsWith('/ws') ||
    event.request.method !== 'GET'
  ) {
    return; // bypass — let browser handle it normally
  }

  // HTML pages: network-first (fresh content) with cache fallback
  if (event.request.mode === 'navigate' || url.pathname.endsWith('.html') || url.pathname === '/') {
    event.respondWith(
      fetch(event.request)
        .then((resp) => {
          // Only cache successful responses
          if (resp && resp.status === 200) {
            const clone = resp.clone();
            caches.open(CACHE_VERSION).then((c) => c.put(event.request, clone));
          }
          return resp;
        })
        .catch(() => caches.match(event.request))
    );
    return;
  }

  // Static assets (topojson, fonts, etc.): cache-first
  event.respondWith(
    caches.match(event.request).then((cached) => {
      if (cached) return cached;
      return fetch(event.request).then((resp) => {
        if (resp && resp.status === 200) {
          const clone = resp.clone();
          caches.open(CACHE_VERSION).then((c) => c.put(event.request, clone));
        }
        return resp;
      });
    })
  );
});
