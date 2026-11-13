const CACHE_NAME = "dfr:v4";
const PRECACHE_ASSETS = [
  "/",
  "/favicon.svg",
  "/favicon.png",
  "/manifest.webmanifest",
  // NOTE: apple-touch-icon.png and the manifest icons (icon-192/icon-512) were
  // removed from the precache (~29KB saved on every first visit): the browser
  // fetches them in its OWN context at add-to-homescreen / install-prompt time,
  // which never consults this service worker's cache — precaching them was pure
  // dead weight.
];
// NOTE: fonts are intentionally NOT precached. Vite emits them content-hashed
// under /assets/, so the v1 "/assets/fonts/<name>.woff2" paths never existed —
// every one of them 404'd and the all-or-nothing addAll() aborted "install",
// which silently broke SW registration and PWA install on every device. Fonts
// still load via styles.css (font-display: swap) + HTTP cache.

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => {
      // Cache each URL individually: a single failed request must never abort
      // the whole install again (see the v1 incident note above).
      return Promise.all(PRECACHE_ASSETS.map((url) => cache.add(url).catch(() => undefined)));
    }),
  );
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((cacheNames) => {
      return Promise.all(
        cacheNames.map((name) => {
          if (name !== CACHE_NAME) {
            return caches.delete(name);
          }
        }),
      );
    }),
  );
  event.waitUntil(self.clients.claim());
});

self.addEventListener("fetch", (event) => {
  if (event.request.method !== "GET") return;

  // Navigations (HTML documents) go network-first so installed PWA users always
  // receive the latest deploy; the precached "/" only serves as offline fallback.
  if (event.request.mode === "navigate") {
    event.respondWith(
      fetch(event.request)
        .catch(() => caches.match(event.request))
        .then((response) => response || caches.match("/")),
    );
    return;
  }

  event.respondWith(
    caches.match(event.request).then((cachedResponse) => {
      return cachedResponse || fetch(event.request);
    }),
  );
});
