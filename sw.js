const CACHE_NAME = 'glass-planner-v1';
const urlsToCache = [
  './',
  './index.html',
  './namaz.html',
  './notlar.html',
  './ingilizce.html',
  './kitap1.html',
  './yatirim1.html',
  './manifest.json',
  './app-icon.png',
  './splash-screen.png'
];

// Yükleme (Install)
self.addEventListener('install', event => {
  self.skipWaiting(); // Beklemeden aktif ol
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then(cache => {
        return cache.addAll(urlsToCache);
      })
  );
});

// Aktifleştirme (Activate)
self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys().then(cacheNames => {
      return Promise.all(
        cacheNames.map(cacheName => {
           if (cacheName !== CACHE_NAME) {
             return caches.delete(cacheName);
           }
        })
      );
    })
  );
  self.clients.claim(); // Tüm sayfaların kontrolünü hemen al
});

// Fetch (İstek Yakalama) - NETWORK FIRST STRATEJİSİ
self.addEventListener('fetch', event => {
  event.respondWith(
    fetch(event.request)
      .then(response => {
        // İnternet var: Cevabı al, klonla ve cache'e kaydet (güncelle)
        if (!response || response.status !== 200) {
          return response;
        }
        const responseToCache = response.clone();
        caches.open(CACHE_NAME)
          .then(cache => {
            cache.put(event.request, responseToCache);
          });
        return response;
      })
      .catch(() => {
        // İnternet yok: Cache'den dön
        return caches.match(event.request);
      })
  );
});