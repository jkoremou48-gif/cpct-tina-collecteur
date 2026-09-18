// Service worker — CPCT-TINA Collecteur
// Stratégie : réseau d'abord (toujours la dernière version),
// copie en cache utilisée seulement si le téléphone est hors ligne.
// Pour forcer une mise à jour chez tout le monde, changez le numéro de version ci-dessous.

const CACHE = 'tina-collecteur-v1';
const FICHIERS = [
  './',
  './index.html',
  './manifest.json',
  './icon-192.png',
  './icon-512.png'
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE)
      .then((cache) => Promise.all(FICHIERS.map((f) => cache.add(f).catch(() => {}))))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((cles) => Promise.all(cles.filter((c) => c !== CACHE).map((c) => caches.delete(c))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const req = event.request;

  // On ne touche ni aux envois de données, ni à Firebase / CDN (autres domaines)
  if (req.method !== 'GET') return;
  if (new URL(req.url).origin !== self.location.origin) return;

  event.respondWith(
    fetch(req, { cache: 'no-cache' })
      .then((reponse) => {
        if (reponse && reponse.ok) {
          const copie = reponse.clone();
          caches.open(CACHE).then((c) => c.put(req, copie));
        }
        return reponse;
      })
      .catch(() =>
        caches.match(req).then((enCache) => enCache || caches.match('./index.html'))
      )
  );
});
