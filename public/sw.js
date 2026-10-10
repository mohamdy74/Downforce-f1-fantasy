// DOWNFORCE — minimal service worker for offline app shell + install prompt.
// Bump CACHE_VERSION to bust old caches after a deploy.
const CACHE_VERSION = "v1";
const SHELL_CACHE = `downforce-shell-${CACHE_VERSION}`;

// App shell: the assets needed to render the first screen.
// Hashed JS/CSS bundles are added dynamically on first load via `install`.
const SHELL_URLS = ["/", "/manifest.webmanifest", "/favicon.svg"];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(SHELL_CACHE).then((cache) => cache.addAll(SHELL_URLS)),
  );
  // Activate immediately — don't wait for old tabs to close.
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  // Purge old cache versions.
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(
        keys
          .filter((k) => k.startsWith("downforce-") && k !== SHELL_CACHE)
          .map((k) => caches.delete(k)),
      ),
    ),
  );
  self.clients.claim();
});

self.addEventListener("fetch", (event) => {
  const { request } = event;

  // Only handle GET requests with http(s) scheme.
  if (request.method !== "GET" || !request.url.startsWith("http")) return;

  const url = new URL(request.url);

  // API / Supabase calls: always network, never cache.
  if (
    url.pathname.startsWith("/api/") ||
    url.hostname.includes("supabase")
  ) {
    return;
  }

  // Hashed assets (JS/CSS/fonts with content hash in filename):
  // cache-first, they never change.
  if (/\.[a-f0-9]{8,}\.(js|css|woff2)$/.test(url.pathname)) {
    event.respondWith(
      caches.match(request).then(
        (cached) =>
          cached ||
          fetch(request).then((res) => {
            const clone = res.clone();
            caches.open(SHELL_CACHE).then((c) => c.put(request, clone));
            return res;
          }),
      ),
    );
    return;
  }

  // Navigation requests (HTML pages): network-first, fall back to cached shell.
  if (request.mode === "navigate") {
    event.respondWith(
      fetch(request).catch(() => caches.match("/") || caches.match(request)),
    );
    return;
  }

  // Everything else (images, etc): stale-while-revalidate.
  event.respondWith(
    caches.match(request).then((cached) => {
      const fetching = fetch(request)
        .then((res) => {
          const clone = res.clone();
          caches.open(SHELL_CACHE).then((c) => c.put(request, clone));
          return res;
        })
        .catch(() => cached);
      return cached || fetching;
    }),
  );
});
