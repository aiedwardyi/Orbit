import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { runInNewContext } from "node:vm";
import { describe, expect, it } from "vitest";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SOURCE = readFileSync(join(ROOT, "public/sw.js"), "utf8");
const RELAY = "abcdefghijklmnop.wink.test";

/** Runs public/sw.js for one origin with a fake cache and network. */
function worker(hostname, network = () => Promise.reject(new TypeError("Failed to fetch")), windows = []) {
  const listeners = {};
  const cache = new Map();
  const shown = [];
  const opened = [];
  const self = {
    location: { hostname, origin: `https://${hostname}` },
    addEventListener: (type, listener) => {
      listeners[type] = listener;
    },
    registration: { showNotification: async (title, options) => shown.push({ title, options }) },
    clients: { matchAll: async () => windows, openWindow: async (url) => opened.push(url) },
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
  const now = 1_800_000_000_000;
  runInNewContext(SOURCE, { self, caches, fetch: network, Request, Response: { error: () => "browser error" }, URL, Date: { now: () => now } });
  return { listeners, cache, shown, opened, now };
}

async function push(listeners, data) {
  let done;
  listeners.push({ data: { json: () => data }, waitUntil: (promise) => (done = promise) });
  await done;
}

async function install(listeners) {
  let done;
  listeners.install({ waitUntil: (promise) => (done = promise) });
  await done;
}

async function click(listeners, url) {
  let done;
  listeners.notificationclick({ notification: { data: { url }, close: () => {} }, waitUntil: (promise) => (done = promise) });
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

  it("shows the sending bot's icon and keeps the app icon as the badge", async () => {
    const { listeners, shown } = worker("home.tail396477.ts.net");
    await push(listeners, { title: "Scout has a question", body: "which branch?", tag: "openmausbot:b", url: "/", icon: "/notify-icons/pill-orange.png" });
    await push(listeners, { title: "Wink", body: "older server" });
    expect(shown.map(({ options }) => options.icon)).toEqual(["/notify-icons/pill-orange.png", "/app-icon-192.png?v=2"]);
    expect(shown.map(({ options }) => options.badge)).toEqual(["/app-icon-192.png?v=2", "/app-icon-192.png?v=2"]);
  });

  it("adds the tap time to the url when it opens a window", async () => {
    const { listeners, opened, now } = worker("home.tail396477.ts.net");
    await click(listeners, "/?bot=b1&thread=t-new");
    await click(listeners, undefined);
    expect(opened).toEqual([
      `https://home.tail396477.ts.net/?bot=b1&thread=t-new&t0=${now}`,
      `https://home.tail396477.ts.net/?t0=${now}`,
    ]);
  });

  it("sends the tap time with the target to an open window", async () => {
    const posted = [];
    const page = { url: "https://home.tail396477.ts.net/", focus: async () => {}, postMessage: (message) => posted.push(message) };
    const { listeners, opened, now } = worker("home.tail396477.ts.net", undefined, [page]);
    await click(listeners, "/?bot=b1&thread=t-new");
    expect(opened).toEqual([]);
    expect(posted).toEqual([{ type: "orbit-open", url: "https://home.tail396477.ts.net/?bot=b1&thread=t-new", t0: now }]);
  });

  it("lets a reachable PC answer the page load itself", async () => {
    const { listeners } = worker(RELAY, async () => "live page");
    await install(listeners);
    expect(await load(listeners, "navigate")).toBe("live page");
  });
});
