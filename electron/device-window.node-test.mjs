import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import test from "node:test";

const require = createRequire(import.meta.url);
const { DEVICE_WINDOW_PARTITION, deviceLinkPage, deviceTailnet, deviceUnreachablePage, deviceWindowTitle, deviceWindowUrl, openOrFocus, tailnetFromStatus, watchDeviceLoad } = require("./device-window.cjs");

class FakeWindow extends EventEmitter {
  destroyed = false;
  minimized = false;
  focused = 0;
  isDestroyed() {
    return this.destroyed;
  }
  isMinimized() {
    return this.minimized;
  }
  restore() {
    this.minimized = false;
  }
  focus() {
    this.focused += 1;
  }
  close() {
    this.destroyed = true;
    this.emit("closed");
  }
}

class FakeWebContents extends EventEmitter {
  destroyed = false;
  crashed = false;
  url = "";
  loads = [];
  isDestroyed() {
    return this.destroyed;
  }
  isCrashed() {
    return this.crashed;
  }
  getURL() {
    return this.url;
  }
  loadURL(target) {
    this.loads.push(target);
    return Promise.resolve();
  }
}

const URL_ = "https://home.tail396477.ts.net/";

function watched() {
  const webContents = new FakeWebContents();
  const logs = [];
  const timers = { tick: null, cleared: 0 };
  const deferred = [];
  const watch = watchDeviceLoad(webContents, {
    host: "home.tail396477.ts.net",
    url: URL_,
    failurePage: "data:failure",
    log: (line) => logs.push(line),
    setInterval: (fn) => (timers.tick = fn),
    clearInterval: () => {
      timers.tick = null;
      timers.cleared += 1;
    },
    defer: (fn) => deferred.push(fn),
  });
  return { webContents, logs, timers, watch, deferred };
}

test("shows the unreachable page and logs the host once on a failed load", () => {
  const { webContents, logs, timers } = watched();
  webContents.emit("did-fail-load", {}, -105, "ERR_NAME_NOT_RESOLVED", `${URL_}remote?key=${"a".repeat(64)}`, true);
  assert.deepEqual(webContents.loads, ["data:failure"]);
  assert.deepEqual(logs, ["device window home.tail396477.ts.net: did-fail-load -105 ERR_NAME_NOT_RESOLVED"]);
  timers.tick();
  webContents.emit("did-fail-load", {}, -105, "ERR_NAME_NOT_RESOLVED", URL_, true);
  assert.equal(logs.length, 1);
  assert.deepEqual(webContents.loads, ["data:failure", URL_, "data:failure"]);
});

test("ignores aborted, subframe and failure page loads", () => {
  const { webContents, logs } = watched();
  webContents.emit("did-fail-load", {}, -3, "ERR_ABORTED", URL_, true);
  webContents.emit("did-fail-load", {}, -105, "ERR_NAME_NOT_RESOLVED", URL_, false);
  webContents.emit("did-fail-load", {}, -2, "FAILED", "data:failure", true);
  webContents.emit("render-process-gone", {}, { reason: "clean-exit" });
  assert.deepEqual(webContents.loads, []);
  assert.deepEqual(logs, []);
});

test("shows the unreachable page when the PC page crashes or hangs", () => {
  for (const [event, details, line] of [
    ["render-process-gone", { reason: "crashed" }, "render-process-gone crashed"],
    ["unresponsive", undefined, "unresponsive"],
  ]) {
    const { webContents, logs, deferred } = watched();
    webContents.emit(event, {}, details);
    if (event === "render-process-gone") {
      assert.deepEqual(webContents.loads, []);
      deferred.shift()();
    }
    assert.deepEqual(webContents.loads, ["data:failure"]);
    assert.deepEqual(logs, [`device window home.tail396477.ts.net: ${line}`]);
  }
});

test("retries every 10 s for 2 min, then stops", () => {
  const { webContents, timers } = watched();
  webContents.emit("did-fail-load", {}, -118, "ERR_CONNECTION_TIMED_OUT", URL_, true);
  let retries = 0;
  while (timers.tick) {
    timers.tick();
    retries += 1;
  }
  assert.equal(retries, 12);
  assert.equal(webContents.loads.filter((load) => load === URL_).length, 12);
});

test("a successful load stops retrying and a later failure logs again", () => {
  const { webContents, logs, timers } = watched();
  webContents.emit("did-fail-load", {}, -105, "ERR_NAME_NOT_RESOLVED", URL_, true);
  webContents.emit("did-navigate", {}, "data:failure");
  assert.ok(timers.tick);
  webContents.emit("did-navigate", {}, URL_);
  assert.equal(timers.tick, null);
  webContents.emit("unresponsive");
  assert.equal(logs.length, 2);
  assert.ok(timers.tick);
});

test("stops retrying when the PC asks to link this device", () => {
  const { webContents, timers } = watched();
  webContents.emit("did-fail-load", {}, -105, "ERR_NAME_NOT_RESOLVED", URL_, true);
  webContents.emit("did-navigate", {}, "data:failure");
  timers.tick();
  webContents.emit("did-navigate", {}, "data:link");
  assert.equal(timers.tick, null);
});

test("stops retrying when the window closes", () => {
  const { webContents, timers } = watched();
  webContents.emit("unresponsive");
  webContents.emit("destroyed");
  assert.equal(timers.tick, null);
});

test("reopening a failed or blank PC window reloads it", () => {
  const { webContents, watch } = watched();
  webContents.url = URL_;
  watch.reloadIfStuck();
  assert.deepEqual(webContents.loads, []);
  webContents.url = "";
  watch.reloadIfStuck();
  assert.deepEqual(webContents.loads, [URL_]);
  webContents.url = URL_;
  webContents.crashed = true;
  watch.reloadIfStuck();
  webContents.crashed = false;
  webContents.emit("unresponsive");
  webContents.url = "data:failure";
  watch.reloadIfStuck();
  assert.deepEqual(webContents.loads, [URL_, URL_, "data:failure", URL_]);
});

test("opening an open PC window runs its refresh", () => {
  const windows = new Map();
  const refreshed = [];
  const first = openOrFocus(windows, "https://home.ts.net", () => new FakeWindow(), (win) => refreshed.push(win));
  assert.deepEqual(refreshed, []);
  openOrFocus(windows, "https://home.ts.net", () => new FakeWindow(), (win) => refreshed.push(win));
  assert.deepEqual(refreshed, [first]);
});

test("unreachable page retries only the PC's own origin", () => {
  const page = decodeURIComponent(deviceUnreachablePage({ host: "home.ts.net", title: "t", heading: "<b>", retry: "Retry" }));
  assert.ok(page.startsWith("data:text/html"));
  assert.ok(page.includes('const host="home.ts.net"'));
  assert.ok(page.includes('location.assign("https://"+host+"/")'));
  assert.ok(page.includes("&lt;b&gt;"));
  assert.equal(page.includes("key"), false);
});

test("opens a PC over HTTPS on its tailnet host only", () => {
  const tailnet = deviceTailnet("laptop.tail396477.ts.net");
  assert.equal(deviceWindowUrl(" Home.tail396477.ts.net ", tailnet).toString(), "https://home.tail396477.ts.net/");
  assert.equal(deviceWindowUrl("work.tail396477.ts.net", tailnet).toString(), "https://work.tail396477.ts.net/");
  for (const bad of ["", "localhost", "home.ts.net/evil", "user@home.ts.net", "home.ts.net:8799", "javascript:alert(1)", "example.com", "ts.net.example.com", "ts.net", 42]) {
    assert.throws(() => deviceWindowUrl(bad, tailnet), /invalid/);
  }
});

test("refuses a public Funnel host on another tailnet", () => {
  const tailnet = deviceTailnet("laptop.tail396477.ts.net");
  for (const bad of ["attacker.other-tailnet.ts.net", "tail396477.ts.net", "a.b.tail396477.ts.net", "home.tail396477.ts.net.evil.ts.net"]) {
    assert.throws(() => deviceWindowUrl(bad, tailnet), /invalid/);
  }
});

test("fails closed without this PC's tailnet", () => {
  for (const local of [undefined, "", "laptop", "tail396477.ts.net", "laptop.example.com"]) {
    assert.equal(deviceTailnet(local), "");
  }
  assert.throws(() => deviceWindowUrl("home.tail396477.ts.net", ""), /invalid/);
});

test("reads the tailnet from tailscale status", () => {
  const status = (Self) => JSON.stringify({ Self });
  assert.equal(tailnetFromStatus(status({ DNSName: "home.tail396477.ts.net." })), "tail396477.ts.net");
  assert.equal(tailnetFromStatus(status({ DNSName: "home.tail396477.ts.net" })), "tail396477.ts.net");
  for (const bad of [status(undefined), status({}), status({ DNSName: 42 }), status({ DNSName: "home.example.com." }), status({ DNSName: "home." }), "null", "{not json", "", undefined]) {
    assert.equal(tailnetFromStatus(bad), "");
  }
});

test("titles the window with the PC name", () => {
  assert.equal(deviceWindowTitle("Home", "home.ts.net"), "Wink - Home");
  assert.equal(deviceWindowTitle("  ", "home.ts.net"), "Wink - home.ts.net");
});

test("focuses an open PC window instead of opening a second", () => {
  const windows = new Map();
  let created = 0;
  const create = () => {
    created += 1;
    return new FakeWindow();
  };
  const first = openOrFocus(windows, "https://home.ts.net", create);
  first.minimized = true;
  assert.equal(openOrFocus(windows, "https://home.ts.net", create), first);
  assert.equal(created, 1);
  assert.equal(first.focused, 1);
  assert.equal(first.minimized, false);
  openOrFocus(windows, "https://work.ts.net", create);
  assert.equal(created, 2);
});

test("reopens after the PC window closes", () => {
  const windows = new Map();
  const first = openOrFocus(windows, "https://home.ts.net", () => new FakeWindow());
  first.close();
  assert.equal(windows.size, 0);
  const second = openOrFocus(windows, "https://home.ts.net", () => new FakeWindow());
  assert.notEqual(second, first);
});

test("link page only navigates to the PC's own handshake", () => {
  const page = decodeURIComponent(
    deviceLinkPage({ host: "home.ts.net", title: "t", heading: "<b>", help: "h", placeholder: "p", submit: "s", invalid: "i" }),
  );
  assert.ok(page.startsWith("data:text/html"));
  assert.ok(page.includes('const host="home.ts.net"'));
  assert.ok(page.includes('"https://"+host+"/remote?key="+key'));
  assert.ok(page.includes("&lt;b&gt;"));
});

test("main process sandboxes PC windows without the app preload", () => {
  const main = readFileSync(new URL("./main.mjs", import.meta.url), "utf8");
  const open = main.slice(main.indexOf("function openDeviceWindow"), main.indexOf("function ensureDesktopWorkspace"));
  assert.ok(DEVICE_WINDOW_PARTITION.startsWith("persist:"));
  assert.ok(open.includes("partition: DEVICE_WINDOW_PARTITION"));
  assert.ok(open.includes("sandbox: true"));
  assert.ok(open.includes("nodeIntegration: false"));
  assert.ok(open.includes("contextIsolation: true"));
  assert.equal(open.includes("preload"), false);
  assert.equal(open.includes("appAuthorization"), false);
  assert.ok(open.includes("watchDeviceLoad(win.webContents"));
  assert.ok(open.includes("host: url.hostname"));
  assert.ok(open.includes("reloadIfStuck()"));
});
