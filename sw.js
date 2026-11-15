/**
 * MIND FORTRESS — Service Worker PWA (Étape 9)
 * Sécurité stricte : les routes /api/* et requêtes non-GET ne sont JAMAIS mises en cache.
 * La version web classique reste 100 % prioritaire (network-first pour index.html).
 */

const CACHE_NAME = "mind-fortress-shell-v1";
const STATIC_ASSETS = [
  "/",
  "/manifest.json",
  "/img/icon-192.png",
  "/img/icon-512.png",
  "/img/icon.svg",
  "/vendor/ValisoaChessLite.js",
  "/vendor/ValisoaChessboard.js",
  "/vendor/ValisoaChessboard.css",
  "/vendor/ValisoaFSRS.js",
  "/vendor/ValisoaFideClock.js",
  "/vendor/ValisoaChesspgnparser.js",
  "/vendor/ValisoaLichess.js",
  "/vendor/ValisoaScoutingOpenings.js",
  "/vendor/ValisoaAnalytics.js"
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches
      .open(CACHE_NAME)
      .then((cache) => cache.addAll(STATIC_ASSETS).catch(() => {}))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k)))
      )
      .then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET") return;

  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;

  // Sécurité : ne jamais intercepter ni mettre en cache /api/* (OAuth, sessions, données privées)
  if (url.pathname.startsWith("/api")) return;

  // Navigation / index.html : Network-First (la version web reste toujours à jour)
  if (req.mode === "navigate" || url.pathname === "/" || url.pathname === "/index.html") {
    event.respondWith(
      fetch(req)
        .then((res) => {
          if (res && res.ok) {
            const copy = res.clone();
            caches.open(CACHE_NAME).then((cache) => cache.put("/", copy)).catch(() => {});
          }
          return res;
        })
        .catch(() => caches.match("/") || caches.match(req))
    );
    return;
  }

  // Ressources statiques (/vendor/*, /img/*, /manifest.json) : Cache-First avec rafraîchissement en arrière-plan
  if (
    url.pathname.startsWith("/vendor/") ||
    url.pathname.startsWith("/img/") ||
    url.pathname === "/manifest.json"
  ) {
    event.respondWith(
      caches.match(req).then((cached) => {
        const networkFetch = fetch(req)
          .then((res) => {
            if (res && res.ok) {
              const copy = res.clone();
              caches.open(CACHE_NAME).then((cache) => cache.put(req, copy)).catch(() => {});
            }
            return res;
          })
          .catch(() => cached);
        return cached || networkFetch;
      })
    );
  }
});
