// Changer ce numéro n'est plus obligatoire à chaque mise à jour :
// les fichiers sont d'abord demandés au réseau, le cache ne sert qu'hors ligne.
const CACHE_NAME = 'qhisto-v3';

// Chemins relatifs : fonctionne aussi bien à la racine que sous /Q-Histo/
const ASSETS_TO_CACHE = [
  './',
  './index.html',
  './style.css',
  './app.js',
  './sync-maison.js',
  './manifest.json',
  './icons/icon-192.png',
  './icons/icon-512.png'
];

const NETWORK_TIMEOUT = 4000;

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(ASSETS_TO_CACHE))
  );
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((names) => Promise.all(
      names.filter((name) => name !== CACHE_NAME).map((name) => caches.delete(name))
    ))
  );
  self.clients.claim();
});

// Réseau d'abord (pour toujours avoir la dernière version), cache si hors ligne ou trop lent
self.addEventListener('fetch', (event) => {
  const request = event.request;
  if (request.method !== 'GET' || new URL(request.url).origin !== self.location.origin) return;
  event.respondWith(networkFirst(event, request));
});

async function networkFirst(event, request) {
  const cache = await caches.open(CACHE_NAME);

  const network = fetch(request).then((response) => {
    if (response.ok) cache.put(request, response.clone());
    return response;
  });
  event.waitUntil(network.catch(() => {}));

  const timeout = new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), NETWORK_TIMEOUT));

  try {
    return await Promise.race([network, timeout]);
  } catch (error) {
    const cached = await cache.match(request, { ignoreSearch: true });
    if (cached) return cached;
    if (request.mode === 'navigate') {
      const index = await cache.match('./index.html');
      if (index) return index;
    }
    try {
      return await network;
    } catch (e) {
      return new Response('Q\'Histo est hors ligne.', {
        status: 503,
        headers: { 'Content-Type': 'text/plain; charset=utf-8' }
      });
    }
  }
}
