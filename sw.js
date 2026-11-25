/* Golfimbul service worker.
   The page is always fetched fresh when there is a connection (network first), so a new deploy shows up on the next open.
   The cached copy is only used when the network fails or is too slow — on the course with no signal.
   Nothing under /api/ is ever cached: players' data never sits in this cache. */
const CACHE = 'golfimbul-v1';
const SHELL = ['/', '/manifest.webmanifest', '/icons/icon-192.png', '/icons/icon-512.png', '/icons/apple-touch-icon.png'];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(SHELL)).catch(() => {}).then(() => self.skipWaiting()));
});
self.addEventListener('activate', e => {
  e.waitUntil(caches.keys().then(ks => Promise.all(ks.filter(k => k !== CACHE).map(k => caches.delete(k)))).then(() => self.clients.claim()));
});

function fresh(req, key, ms) {
  return caches.open(CACHE).then(cache => {
    const net = fetch(req).then(res => { if (res && res.ok && res.type === 'basic') cache.put(key, res.clone()); return res; });
    if (!ms) return net.catch(() => cache.match(key));
    /* slow connection: fall back to the saved copy after ms, but keep updating it in the background */
    return cache.match(key).then(hit => {
      if (!hit) return net;
      return Promise.race([net.catch(() => hit), new Promise(r => setTimeout(() => r(hit), ms))]);
    });
  });
}

self.addEventListener('fetch', e => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;
  if (url.pathname.startsWith('/api/')) return;                 // never cached
  if (req.mode === 'navigate') {
    const app = url.pathname === '/' || url.pathname === '/index.html' || url.pathname === '/index';
    e.respondWith(fresh(req, app ? '/' : url.pathname, 4000).then(r => r || caches.match('/')));
    return;
  }
  e.respondWith(fresh(req, url.pathname).then(r => r || Response.error()));
});
