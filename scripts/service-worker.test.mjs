import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { runInNewContext } from "node:vm";
import { describe, expect, it } from "vitest";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SOURCE = readFileSync(join(ROOT, "public/sw.js"), "utf8");
const RELAY = "abcdefghijklmnop.wink.test";

/** Runs public/sw.js for one origin with a fake cache and network. */
function worker(hostname, network = () => Promise.reject(new TypeError("Failed to fetch"))) {
  const listeners = {};
  const cache = new Map();
  const self = {
    location: { hostname, origin: `https://${hostname}` },
    addEventListener: (type, listener) => {
      listeners[type] = listener;
    },
    registration: { showNotification: async () => {} },
    clients: { matchAll: async () => [], openWindow: async () => {} },
  };
  const caches = {
    open: async () => ({ add: async (request) => cache.set(request.url, `cached ${request.url}`) }),
    match: async (url) => cache.get(url),
  };
  class Request {
    constructor(url) {
      this.url = url;
    }
  }
  runInNewContext(SOURCE, { self, caches, fetch: network, Request, Response: { error: () => "browser error" }, URL });
  return { listeners, cache };
}

async function install(listeners) {
  let done;
  listeners.install({ waitUntil: (promise) => (done = promise) });
  await done;
}

function load(listeners, mode) {
  let answer = null;
  listeners.fetch({ request: { mode }, respondWith: (promise) => (answer = promise) });
  return answer;
}

describe("service worker", () => {
  it("stays push-only on tailnet and local origins", () => {
    for (const host of ["home.tail396477.ts.net", "abcdefghijklmnop.tail396477.ts.net", "127.0.0.1", "localhost"]) {
      expect(Object.keys(worker(host).listeners).sort(), host).toEqual(["notificationclick", "push"]);
    }
  });

  it("caches only the offline page on a relay origin", async () => {
    const { listeners, cache } = worker(RELAY);
    expect(Object.keys(listeners).sort()).toEqual(["fetch", "install", "notificationclick", "push"]);
    await install(listeners);
    expect([...cache.keys()]).toEqual(["/offline.html"]);
  });

  it("answers a failed page load with the offline page and leaves other requests alone", async () => {
    const { listeners } = worker(RELAY);
    await install(listeners);
    expect(await load(listeners, "navigate")).toBe("cached /offline.html");
    for (const mode of ["cors", "same-origin", "no-cors"]) expect(load(listeners, mode)).toBeNull();
  });

  it("lets a reachable PC answer the page load itself", async () => {
    const { listeners } = worker(RELAY, async () => "live page");
    await install(listeners);
    expect(await load(listeners, "navigate")).toBe("live page");
  });
});
