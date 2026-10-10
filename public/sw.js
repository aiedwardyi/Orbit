// Push worker. On a relay origin it also answers a page load that cannot reach the PC with
// offline.html; nothing else is cached, so the app shell never goes stale after an update.
const OFFLINE_CACHE = "wink-offline-v1";
const OFFLINE_URL = "/offline.html";
const RELAY_ORIGIN = /^[a-z2-7]{16}\./.test(self.location.hostname) && !self.location.hostname.endsWith(".ts.net");

if (RELAY_ORIGIN) {
  self.addEventListener("install", (event) => {
    event.waitUntil(caches.open(OFFLINE_CACHE).then((cache) => cache.add(new Request(OFFLINE_URL, { cache: "reload" }))));
  });

  self.addEventListener("fetch", (event) => {
    if (event.request.mode !== "navigate") return;
    event.respondWith(fetch(event.request).catch(async () => (await caches.match(OFFLINE_URL)) ?? Response.error()));
  });
}

self.addEventListener("push", (event) => {
  let data = {};
  try {
    data = event.data ? event.data.json() : {};
  } catch {
    // Malformed payloads still owe the user a visible notification.
  }
  event.waitUntil(
    self.registration.showNotification(data.title || "Wink", {
      body: data.body || "",
      tag: data.tag,
      renotify: Boolean(data.tag),
      vibrate: [200, 100, 200],
      icon: data.icon || "/app-icon-192.png?v=2",
      badge: "/app-icon-192.png?v=2",
      data: { url: data.url || "/" },
    }),
  );
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const url = new URL(event.notification.data?.url || "/", self.location.origin).href;
  event.waitUntil(
    self.clients.matchAll({ type: "window", includeUncontrolled: true }).then(async (windows) => {
      const open = windows.find((client) => new URL(client.url).origin === self.location.origin);
      if (!open) return self.clients.openWindow(url);
      await open.focus();
      open.postMessage({ type: "orbit-open", url });
    }),
  );
});
