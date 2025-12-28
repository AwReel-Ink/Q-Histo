const CACHE_NAME = 'qhisto-v1';
const ASSETS_TO_CACHE = [
  '/',
  '/index.html',
  '/style.css',
  '/app.js',
  '/icons/icon-192.png',
  '/icons/icon-512.png'
];

// Installation du Service Worker
self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then((cache) => {
        console.log('📦 Cache ouvert');
        return cache.addAll(ASSETS_TO_CACHE);
      })
  );
  self.skipWaiting();
});

// Activation du Service Worker
self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((cacheNames) => {
      return Promise.all(
        cacheNames.map((cacheName) => {
          if (cacheName !== CACHE_NAME) {
            console.log('🗑️ Suppression ancien cache:', cacheName);
            return caches.delete(cacheName);
          }
        })
      );
    })
  );
  self.clients.claim();
});

// Stratégie Cache First (Network Fallback)
self.addEventListener('fetch', (event) => {
  event.respondWith(
    caches.match(event.request)
      .then((response) => {
        // Retourne du cache si disponible
        if (response) {
          return response;
        }
        
        // Sinon, récupère depuis le réseau
        return fetch(event.request).then((response) => {
          // Ne pas mettre en cache les requêtes non-GET
          if (event.request.method !== 'GET') {
            return response;
          }

          // Clone la réponse
          const responseToCache = response.clone();

          caches.open(CACHE_NAME)
            .then((cache) => {
              cache.put(event.request, responseToCache);
            });

          return response;
        });
      })
      .catch(() => {
        // Page offline basique si pas de réseau
        return new Response(
          `<!DOCTYPE html>
          <html>
          <head>
            <title>Q'Histo - Hors ligne</title>
            <style>
              body {
                font-family: Arial, sans-serif;
                display: flex;
                justify-content: center;
                align-items: center;
                height: 100vh;
                margin: 0;
                background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
                color: white;
                text-align: center;
              }
              h1 { font-size: 2em; margin-bottom: 1em; }
              p { font-size: 1.2em; }
            </style>
          </head>
          <body>
            <div>
              <h1>📵 Mode hors ligne</h1>
              <p>Q'Histo n'est pas disponible sans connexion.</p>
              <p>Reconnectez-vous pour accéder à vos recettes.</p>
            </div>
          </body>
          </html>`,
          {
            headers: { 'Content-Type': 'text/html' }
          }
        );
      })
  );
});
