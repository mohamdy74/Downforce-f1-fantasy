const CACHE_NAME = "downforce-v2";

self.addEventListener("install", () => {
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(self.clients.claim());
});

self.addEventListener("push", (event) => {
  if (!event.data) return;
  let data = {};
  try {
    data = event.data.json();
  } catch {
    data = { title: "DOWNFORCE", body: event.data.text(), url: "/predict" };
  }

  const title = data.title || "DOWNFORCE — Race Reminder";
  const options = {
    body: data.body || "Lock in your picks before the race starts!",
    icon: "/favicon.png",
    badge: "/favicon.png",
    tag: data.tag || "downforce-reminder",
    renotify: true,
    requireInteraction: true,
    vibrate: [200, 100, 200],
    data: { url: data.url || "/predict" },
  };

  event.waitUntil(self.registration.showNotification(title, options));
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const targetUrl = (event.notification.data && event.notification.data.url) || "/predict";

  event.waitUntil(
    self.clients.matchAll({ type: "window", includeUncontrolled: true }).then((clientList) => {
      for (const client of clientList) {
        if ("focus" in client) {
          client.navigate(targetUrl);
          return client.focus();
        }
      }
      if (self.clients.openWindow) {
        return self.clients.openWindow(targetUrl);
      }
    })
  );
});
