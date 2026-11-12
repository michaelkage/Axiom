const CACHE = 'axiom-shell-v4';
const SHELL = ['/', '/index.html', '/manifest.webmanifest', '/axiom.svg', '/skills/registry.json'];

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
  const requestUrl = new URL(request.url);
  if (request.method === 'POST' && requestUrl.origin === self.location.origin && requestUrl.pathname === '/share') {
    event.respondWith((async () => {
      try {
        const form = await request.formData();
        const payload = {
          id: (self.crypto?.randomUUID?.() || String(Date.now()) + Math.random()),
          createdAt: Date.now(),
          title: String(form.get('title') || '').slice(0, 500),
          text: String(form.get('text') || '').slice(0, 20000),
          url: String(form.get('url') || '').slice(0, 4000),
          files: form.getAll('files').filter(file => file && typeof file === 'object' && typeof file.size === 'number' && file.size > 0 && file.size <= 5 * 1024 * 1024).slice(0, 8)
        };
        await new Promise((resolve, reject) => {
          const open = indexedDB.open('axiom-share-target', 1);
          open.onupgradeneeded = () => {
            if (!open.result.objectStoreNames.contains('payloads')) open.result.createObjectStore('payloads', { keyPath: 'id' });
          };
          open.onerror = () => reject(open.error || new Error('Share storage unavailable'));
          open.onsuccess = () => {
            const database = open.result;
            const transaction = database.transaction('payloads', 'readwrite');
            transaction.objectStore('payloads').put(payload);
            transaction.oncomplete = () => { database.close(); resolve(); };
            transaction.onerror = () => { database.close(); reject(transaction.error || new Error('Share storage failed')); };
            transaction.onabort = () => { database.close(); reject(transaction.error || new Error('Share storage aborted')); };
          };
        });
        return Response.redirect(new URL('/?shared=1', self.location.origin), 303);
      } catch (error) {
        return Response.redirect(new URL('/?shareError=1', self.location.origin), 303);
      }
    })());
    return;
  }
  if (request.method !== 'GET' || new URL(request.url).origin !== self.location.origin) return;

  const url = new URL(request.url);
  const isNavigation = request.mode === 'navigate';
  const isStaticAsset = url.pathname === '/index.html' ||
    url.pathname === '/manifest.webmanifest' ||
    url.pathname === '/axiom.svg' ||
    url.pathname === '/skills/registry.json' ||
    url.pathname.startsWith('/assets/');

  // Leave API and other dynamic GET requests to the network; caching them can
  // replay stale data or accidentally persist responses containing secrets.
  if (!isNavigation && !isStaticAsset) return;

  if (isNavigation) {
    event.respondWith((async () => {
      try {
        const response = await fetch(request);
        if (response.ok) {
          const cache = await caches.open(CACHE);
          await cache.put('/index.html', response.clone());
        }
        return response;
      } catch {
        return (await caches.match('/index.html')) || Response.error();
      }
    })());
    return;
  }

  event.respondWith((async () => {
    const cached = await caches.match(request);
    if (cached) return cached;
    const response = await fetch(request);
    if (response.ok) {
      const cache = await caches.open(CACHE);
      await cache.put(request, response.clone());
    }
    return response;
  })());
});
