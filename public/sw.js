const CACHE_NAME = "dfr:v2";
const PRECACHE_ASSETS = [
  "/",
  "/favicon.svg",
  "/favicon.png",
  "/apple-touch-icon.png",
  "/icon-192.png",
  "/icon-512.png",
  "/manifest.webmanifest",
];
// NOTE: fonts are intentionally NOT precached. Vite emits them content-hashed
// under /assets/, so the v1 "/assets/fonts/<name>.woff2" paths never existed —
// every one of them 404'd and the all-or-nothing addAll() aborted "install",
// which silently broke SW registration, PWA install AND push subscriptions on
// every device. Fonts still load via styles.css (font-display: swap) + HTTP cache.

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

self.addEventListener("push", (event) => {
  let data = {
    title: "DOWNFORCE — Race Control",
    body: "Lock in your predictions before the deadline!",
    tag: "downforce-alert",
    url: "/predict",
  };

  if (event.data) {
    try {
      const parsed = event.data.json();
      data = { ...data, ...parsed };
    } catch {
      try {
        data.body = event.data.text() || data.body;
      } catch {}
    }
  }

  const options = {
    body: data.body,
    icon: "/favicon.png",
    badge: "/favicon.png",
    tag: data.tag || "downforce-alert",
    renotify: true,
    requireInteraction: false,
    vibrate: [200, 100, 200],
    data: { url: data.url || "/predict" },
  };

  event.waitUntil(self.registration.showNotification(data.title, options));
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const targetUrl = (event.notification.data && event.notification.data.url) || "/predict";

  event.waitUntil(
    self.clients.matchAll({ type: "window", includeUncontrolled: true }).then((clientList) => {
      for (const client of clientList) {
        if ("focus" in client) {
          client.navigate(targetUrl).catch(() => {});
          return client.focus();
        }
      }
      if (self.clients.openWindow) {
        return self.clients.openWindow(targetUrl);
      }
    }),
  );
});
