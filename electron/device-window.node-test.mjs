import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import test from "node:test";

const require = createRequire(import.meta.url);
const { DEVICE_WINDOW_PARTITION, deviceLinkPage, deviceTailnet, deviceWindowTitle, deviceWindowUrl, openOrFocus, tailnetFromStatus } = require("./device-window.cjs");

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
  assert.equal(deviceWindowTitle("Home", "home.ts.net"), "Orbit - Home");
  assert.equal(deviceWindowTitle("  ", "home.ts.net"), "Orbit - home.ts.net");
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
});
