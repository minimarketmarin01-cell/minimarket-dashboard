// Service worker Minimarket Marín — v5 (ícono oficial "Marín Finanzas")
// - Permite instalar como app.
// - NUNCA cachea el HTML (siempre fresco, así el token/código nuevo entra al recargar).
// - NUNCA intercepta la llamada a Apps Script ni nada de otro dominio
//   (si lo hiciera, rompería la carga de datos por el redirect de Google).
const CACHE = 'marin-v5';

self.addEventListener('install', e => { self.skipWaiting(); });

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys().then(keys => Promise.all(
      keys.filter(k => k !== CACHE).map(k => caches.delete(k))
    )).then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', e => {
  const url = new URL(e.request.url);
  // Solo intervenir en la navegación del PROPIO sitio (para bajar HTML fresco).
  // Todo lo demás (Apps Script, CDNs, imágenes) pasa directo sin tocarlo.
  if (e.request.mode === 'navigate' && url.origin === location.origin) {
    e.respondWith(fetch(e.request).catch(() => caches.match('./index.html')));
  }
  // Sin respondWith en el resto => el navegador maneja la petición normalmente.
});
