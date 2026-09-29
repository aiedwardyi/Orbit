// Push-only worker. No fetch handler and no caching, so the app shell never goes stale after an update.
self.addEventListener("push", (event) => {
  let data = {};
  try {
    data = event.data ? event.data.json() : {};
  } catch {
    // Malformed payloads still owe the user a visible notification.
  }
  event.waitUntil(
    self.registration.showNotification(data.title || "Orbit", {
      body: data.body || "",
      tag: data.tag,
      renotify: Boolean(data.tag),
      vibrate: [200, 100, 200],
      icon: "/app-icon-192.png",
      badge: "/app-icon-192.png",
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
