// Service worker Minimarket Marín — v3
// Objetivo: permitir instalación como app SIN cachear el HTML.
// El index.html SIEMPRE se baja fresco de la red, así cualquier
// cambio (token, código) entra de inmediato al recargar.
const CACHE = 'marin-v3';

self.addEventListener('install', e => { self.skipWaiting(); });

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys().then(keys => Promise.all(
      keys.filter(k => k !== CACHE).map(k => caches.delete(k))
    )).then(() => self.clients.claim())
  );
});

// Red primero SIEMPRE. Nada de servir HTML viejo desde caché.
self.addEventListener('fetch', e => {
  e.respondWith(fetch(e.request).catch(() => caches.match(e.request)));
});
