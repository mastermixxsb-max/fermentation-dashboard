const CACHE = 'ferm-v4.2';
const ASSETS = ['./', './index.html', './manifest.json', './icon-192.png', './icon-512.png'];

// Install — predcachiramo asete
self.addEventListener('install', e => {
  e.waitUntil(
    caches.open(CACHE).then(c => c.addAll(ASSETS))
  );
  self.skipWaiting(); // aktiviraj odmah, ne čekaj da se stara verzija zatvori
});

// Activate — briši stare cacheove
self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys().then(keys =>
      Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)))
    )
  );
  self.clients.claim(); // preuzmi kontrolu nad svim tabovima odmah
});

// Fetch — Network First strategija
// Uvijek pokušaj mrežu → ako offline, serviraj iz cachea
self.addEventListener('fetch', e => {
  // Preskoči non-GET zahtjeve i Firebase/Telegram API pozive
  if (e.request.method !== 'GET') return;
  const url = e.request.url;
  if (url.includes('firebasedatabase.app') || url.includes('api.telegram.org') || url.includes('fonts.googleapis.com')) return;

  e.respondWith(
    fetch(e.request)
      .then(response => {
        // Spremi svježi odgovor u cache
        if (response && response.status === 200) {
          const clone = response.clone();
          caches.open(CACHE).then(c => c.put(e.request, clone));
        }
        return response;
      })
      .catch(() => caches.match(e.request)) // offline fallback
  );
});
