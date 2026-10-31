// Push worker. An open the network has not answered in SHELL_WAIT_MS gets the last app page and its
// hashed assets; every network answer refreshes that copy. On a relay origin a page load that
// cannot reach the PC at all gets offline.html.
const OFFLINE_CACHE = "wink-offline-v1";
const OFFLINE_URL = "/offline.html";
const SHELL_CACHE = "wink-shell-v1";
const SHELL_URL = "/";
const SHELL_WAIT_MS = 500;
const SHELL_ENTRY = /<script\b[^>]*\bsrc="\/assets\/index-[\w-]+\.js"/;
const SHELL_ASSET = /\b(?:src|href)="(\/assets\/[^"?#]+)"/g;
const RELAY_ORIGIN = /^[a-z2-7]{16}\./.test(self.location.hostname) && !self.location.hostname.endsWith(".ts.net");

let keeping = Promise.resolve();

async function storeShell(response) {
  if (response.redirected || response.type === "opaqueredirect" || (response.status >= 300 && response.status < 500)) {
    await caches.delete(SHELL_CACHE);
    return;
  }
  if (!response.ok) return;
  const html = await response.text();
  if (!SHELL_ENTRY.test(html)) return;
  const assets = new Set(Array.from(html.matchAll(SHELL_ASSET), (match) => match[1]));
  const cache = await caches.open(SHELL_CACHE);
  const missing = [];
  for (const asset of assets) if (!(await cache.match(asset))) missing.push(asset);
  // The page goes in only after every file it names, so a cached page never asks for one the cache lacks.
  await cache.addAll(missing);
  await cache.put(SHELL_URL, new Response(html, { headers: { "content-type": "text/html; charset=utf-8" } }));
  for (const key of await cache.keys()) {
    const path = new URL(key.url).pathname;
    if (path !== SHELL_URL && !assets.has(path)) await cache.delete(key);
  }
}

function keepShell(response) {
  keeping = keeping.then(() => storeShell(response)).catch(() => {});
  return keeping;
}

async function cachedShell() {
  return (await caches.open(SHELL_CACHE)).match(SHELL_URL);
}

function offline() {
  return RELAY_ORIGIN ? caches.match(OFFLINE_URL).then((page) => page ?? Response.error()) : Response.error();
}

async function navigate(event, app) {
  const network = Promise.resolve(event.preloadResponse).then((preloaded) => preloaded ?? fetch(event.request));
  if (!app) return network.catch(offline);
  // Attached before anything hands the response on, so the copy is taken before the page reads the body.
  event.waitUntil(network.then((response) => keepShell(response.clone()), () => {}));
  const slow = await Promise.race([
    network.then(() => false, () => false),
    new Promise((resolve) => setTimeout(resolve, SHELL_WAIT_MS, true)),
  ]);
  return (slow && (await cachedShell())) || network.catch(offline);
}

async function shellAsset(request) {
  return (await (await caches.open(SHELL_CACHE)).match(request.url)) ?? fetch(request);
}

self.addEventListener("install", (event) => {
  self.skipWaiting();
  event.waitUntil(
    Promise.all([
      RELAY_ORIGIN && caches.open(OFFLINE_CACHE).then((cache) => cache.add(new Request(OFFLINE_URL, { cache: "reload" }))),
      fetch(SHELL_URL, { cache: "no-store" }).then(keepShell, () => {}),
    ]),
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(self.registration.navigationPreload?.enable());
});

self.addEventListener("fetch", (event) => {
  const { request } = event;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;
  const app = url.pathname === SHELL_URL;
  if (request.mode === "navigate") {
    if (app || RELAY_ORIGIN) event.respondWith(navigate(event, app));
  } else if (request.method === "GET" && url.pathname.startsWith("/assets/")) {
    event.respondWith(shellAsset(request));
  }
});

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

// The tap's time rides along so the page can time its open from the tap itself.
function withClickTime(url, t0) {
  const next = new URL(url);
  next.searchParams.set("t0", String(t0));
  return next.href;
}

self.addEventListener("notificationclick", (event) => {
  const t0 = Date.now();
  event.notification.close();
  const url = new URL(event.notification.data?.url || "/", self.location.origin).href;
  event.waitUntil(
    self.clients.matchAll({ type: "window", includeUncontrolled: true }).then(async (windows) => {
      const open = windows.find((client) => new URL(client.url).origin === self.location.origin);
      if (!open) return self.clients.openWindow(withClickTime(url, t0));
      await open.focus();
      open.postMessage({ type: "orbit-open", url, t0 });
    }),
  );
});
