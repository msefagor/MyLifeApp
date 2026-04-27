const CACHE_NAME = 'glass-planner-v8';
const urlsToCache = [
  './',
  './index.html',
  './namaz.html',
  './notlar.html',
  './ingilizce.html',
  './kitap1.html',
  './yatirim1.html',
  './devam.html',
  './tabela.html',
  './db-sync.js',
  './sureler.json',
  './db.json',
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
        // addAll, herhangi bir kaynak başarısız olursa tüm install'ı patlatır.
        // Tek tek ekleyip eksik dosyalar nedeniyle SW'nin install'ını çökertmemek için
        // her dosyayı ayrı ayrı eklemeyi deniyoruz.
        return Promise.all(
          urlsToCache.map(url =>
            cache.add(url).catch(err => {
              console.warn('SW: cache eklenemedi:', url, err);
            })
          )
        );
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
    }).then(() => self.clients.claim()) // Tüm sayfaların kontrolünü hemen al
  );
});

// Fetch (İstek Yakalama) - NETWORK FIRST STRATEJİSİ + güvenli fallback
self.addEventListener('fetch', event => {
  // Sadece GET isteklerini ve aynı kaynaklı http(s) isteklerini ele al
  if (event.request.method !== 'GET') return;
  const url = new URL(event.request.url);
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return;

  event.respondWith(
    fetch(event.request)
      .then(response => {
        // İnternet var: Cevabı al, klonla ve cache'e kaydet (güncelle)
        if (!response || response.status !== 200 || response.type !== 'basic') {
          return response;
        }
        const responseToCache = response.clone();
        caches.open(CACHE_NAME)
          .then(cache => {
            cache.put(event.request, responseToCache);
          })
          .catch(() => {});
        return response;
      })
      .catch(async () => {
        // İnternet yok / ağ hatası: Önce tam URL ile cache, yoksa pathname ile cache, yoksa index.html
        const cached = await caches.match(event.request);
        if (cached) return cached;

        // Query string'i atıp tekrar dene (ör. devam.html?date=2026-04-25 → devam.html)
        const noQuery = new Request(url.origin + url.pathname);
        const cachedNoQuery = await caches.match(noQuery);
        if (cachedNoQuery) return cachedNoQuery;

        // Navigasyon (HTML) isteğiyse en azından ana sayfayı dön
        if (event.request.mode === 'navigate') {
          const fallback = await caches.match('./index.html');
          if (fallback) return fallback;
        }
        return new Response('Çevrimdışı: kaynak bulunamadı', {
          status: 503, statusText: 'Service Unavailable',
          headers: { 'Content-Type': 'text/plain; charset=utf-8' }
        });
      })
  );
});
