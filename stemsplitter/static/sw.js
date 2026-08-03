// Stem Splitter — Service Worker
// Strategy:
//   • App shell (HTML, CSS, JS) → Network first, cache fallback
//   • Static assets (/static/) → Cache first, network fallback + cache update
//   • API / upload / stems    → Network only (never cache)

const CACHE = 'stemsplitter-shell-v1';

const SHELL = [
  '/',
  '/static/css/tailwind.css',
];

// Paths that must never be served from cache
const NETWORK_ONLY = [
  '/api/',
  '/upload',
  '/split',
  '/stems/',
  '/job/',
  '/logout',
  '/login',
  '/oauth',
  '/admin',
  '/pitch/',
];

// ── Install: pre-cache the app shell ─────────────────────────────────────────
self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE).then((cache) => cache.addAll(SHELL))
  );
  // Take over immediately — don't wait for old tabs to close
  self.skipWaiting();
});

// ── Activate: purge old caches ────────────────────────────────────────────────
self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))
    )
  );
  self.clients.claim();
});

// ── Fetch ─────────────────────────────────────────────────────────────────────
self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') return; // POST/PUT/DELETE — don't intercept

  const url = new URL(request.url);

  // Never cache API calls, auth routes, or media files
  if (NETWORK_ONLY.some((p) => url.pathname.startsWith(p))) return;

  // Static assets — cache first, update in background
  if (url.pathname.startsWith('/static/')) {
    event.respondWith(
      caches.open(CACHE).then(async (cache) => {
        const cached = await cache.match(request);
        const networkFetch = fetch(request).then((response) => {
          if (response.ok) cache.put(request, response.clone());
          return response;
        });
        return cached || networkFetch;
      })
    );
    return;
  }

  // HTML pages — network first, cached shell as fallback (works offline)
  if (request.headers.get('accept')?.includes('text/html')) {
    event.respondWith(
      fetch(request).catch(() => caches.match('/'))
    );
    return;
  }
});
