const CACHE = 'axiom-shell-v2';
const SHELL = ['/', '/index.html', '/manifest.webmanifest', '/axiom.svg'];

self.addEventListener('install', event => {
  event.waitUntil(caches.open(CACHE).then(cache => cache.addAll(SHELL)));
});

self.addEventListener('activate', event => {
  event.waitUntil(caches.keys().then(keys =>
    Promise.all(keys.filter(key => key !== CACHE).map(key => caches.delete(key)))
  ));
});

self.addEventListener('fetch', event => {
  const request = event.request;
  if (request.method !== 'GET' || new URL(request.url).origin !== self.location.origin) return;

  const url = new URL(request.url);
  const isNavigation = request.mode === 'navigate';
  const isStaticAsset = url.pathname === '/index.html' ||
    url.pathname === '/manifest.webmanifest' ||
    url.pathname === '/axiom.svg' ||
    url.pathname.startsWith('/assets/');

  // Leave API and other dynamic GET requests to the network; caching them can
  // replay stale data or accidentally persist responses containing secrets.
  if (!isNavigation && !isStaticAsset) return;

  if (isNavigation) {
    event.respondWith(fetch(request).then(response => {
      if (response.ok) {
        const copy = response.clone();
        caches.open(CACHE).then(cache => cache.put('/index.html', copy));
      }
      return response;
    }).catch(() => caches.match('/index.html')));
    return;
  }

  event.respondWith(caches.match(request).then(cached => cached || fetch(request).then(response => {
    if (response.ok) {
      const copy = response.clone();
      caches.open(CACHE).then(cache => cache.put(request, copy));
    }
    return response;
  })));
});
