/* ═══ KVM DOOR SYSTEMS — Service Worker (cache-bust patch) ═══
 * Version is stamped server-side at request time. Each new deploy =
 * new file content = browser installs new worker = new cache.
 *
 * Strategy:
 *   - Network-first for HTML and the API (always try fresh, fall back to cache)
 *   - Cache-first for static assets (CSS/JS/images/icons)
 *   - All caches scoped to APP_VERSION so old caches get pruned on activation
 */

const APP_VERSION = '__APP_VERSION__';
const CACHE_NAME = 'kvm-portal-' + APP_VERSION;

// Precache list — fetched once on install for offline support.
// We keep this small and conservative; everything else is cached on demand.
const PRECACHE_URLS = [
  '/',
  '/css/style.css?v=' + APP_VERSION,
  '/js/app.js?v=' + APP_VERSION,
  '/manifest.json'
];

// Install: precache the shell so the app works offline after first load
self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then(async (cache) => {
      // Try to precache; ignore failures so install doesn't block
      await Promise.allSettled(
        PRECACHE_URLS.map(url => cache.add(url).catch(() => null))
      );
      // Don't auto-activate — we want the user to finish their current navigation
      // before swapping. (Phase 1 cache-bust patch: option C — reload-on-next-nav.)
      // self.skipWaiting() is intentionally NOT called.
    })
  );
});

// Activate: clean up old caches from previous deploys
self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then(keys =>
      Promise.all(
        keys.filter(k => k.startsWith('kvm-portal-') && k !== CACHE_NAME)
            .map(k => caches.delete(k))
      )
    ).then(() => self.clients.claim())
  );
});

// Fetch handler — choose strategy based on request type
self.addEventListener('fetch', (event) => {
  const req = event.request;
  const url = new URL(req.url);

  // Only handle same-origin requests
  if (url.origin !== self.location.origin) return;

  // Don't cache or intercept POST/PUT/DELETE/PATCH — let them through to network
  if (req.method !== 'GET') return;

  // Don't cache the version-check endpoint — always fresh
  if (url.pathname === '/api/app-version') return;

  // Don't cache other API calls — always fresh, but allow falling back to cache when offline
  if (url.pathname.startsWith('/api/')) {
    event.respondWith(networkFirstNoCache(req));
    return;
  }

  // For HTML (root or any non-asset path), use network-first so new versions land fast
  if (req.mode === 'navigate' || req.headers.get('accept')?.includes('text/html')) {
    event.respondWith(networkFirstWithCache(req));
    return;
  }

  // For static assets, cache-first (these are versioned via ?v=APP_VERSION so safe)
  event.respondWith(cacheFirst(req));
});

// Network-first, fallback to cache (for HTML)
async function networkFirstWithCache(req) {
  try {
    const fresh = await fetch(req);
    if (fresh && fresh.ok) {
      const cache = await caches.open(CACHE_NAME);
      cache.put(req, fresh.clone()).catch(() => {});
    }
    return fresh;
  } catch (e) {
    const cached = await caches.match(req);
    if (cached) return cached;
    // Last-resort offline page (just return the root if cached)
    const root = await caches.match('/');
    if (root) return root;
    return new Response('Offline. Please reconnect to load this page.', {
      status: 503,
      headers: { 'Content-Type': 'text/plain' }
    });
  }
}

// Network-first, no caching (for API)
async function networkFirstNoCache(req) {
  try {
    return await fetch(req);
  } catch (e) {
    // No cache for API — return a 503 so app.js can show offline state
    return new Response(
      JSON.stringify({ error: 'Offline. Cannot reach server.' }),
      { status: 503, headers: { 'Content-Type': 'application/json' } }
    );
  }
}

// Cache-first, fallback to network (for static assets)
async function cacheFirst(req) {
  const cached = await caches.match(req);
  if (cached) return cached;
  try {
    const fresh = await fetch(req);
    if (fresh && fresh.ok) {
      const cache = await caches.open(CACHE_NAME);
      cache.put(req, fresh.clone()).catch(() => {});
    }
    return fresh;
  } catch (e) {
    return new Response('', { status: 503 });
  }
}

// Allow the page to ask the worker to skipWaiting (used when user clicks
// the "next nav" trigger in the app)
self.addEventListener('message', (event) => {
  if (event.data && event.data.type === 'SKIP_WAITING') {
    self.skipWaiting();
  }
});
