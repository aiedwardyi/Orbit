import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import test from "node:test";

const require = createRequire(import.meta.url);
const { desktopViewerUrl, desktopViewerWindowOptions, sameDesktopViewerOrigin } = require("./desktop-viewer.cjs");

test("accepts a secret-bearing HTTPS VNC URL", () => {
  const url = desktopViewerUrl("https://desktop.example/vnc.html?_token=secret");
  assert.equal(url.origin, "https://desktop.example");
});

test("accepts Local VM viewers on loopback", () => {
  assert.equal(desktopViewerUrl("http://127.0.0.1:6080/vnc.html#password=x").port, "6080");
  assert.equal(desktopViewerUrl("http://localhost:6080/vnc.html").hostname, "localhost");
});

test("rejects insecure remote and privileged URLs", () => {
  assert.throws(() => desktopViewerUrl("http://desktop.example/vnc.html"), /HTTPS/);
  assert.throws(() => desktopViewerUrl("file:///tmp/vnc.html"), /HTTPS/);
  assert.throws(() => desktopViewerUrl("data:text/html,hello"), /HTTPS/);
});

test("rejects URL user info", () => {
  assert.throws(() => desktopViewerUrl("https://user:password@desktop.example/vnc.html"), /user info/);
});

test("opens as an independent window that cannot cover the app as a sheet", () => {
  const options = desktopViewerWindowOptions();
  assert.equal(Object.hasOwn(options, "parent"), false);
  assert.equal(options.modal, false);
  assert.ok(options.width >= 760);
  assert.ok(options.height >= 520);
});

test("main process does not parent the desktop viewer over the app window", () => {
  const main = readFileSync(new URL("./main.mjs", import.meta.url), "utf8");
  const open = main.slice(main.indexOf("function openDesktopViewer"), main.indexOf("function ensureDesktopWorkspace"));
  assert.equal(open.includes("desktopViewerWindowOptions"), true);
  assert.equal(/parent:\s*owner/.test(open), false);
});

test("allows only same-origin viewer navigation", () => {
  assert.equal(sameDesktopViewerOrigin("https://desktop.example/session", "https://desktop.example"), true);
  assert.equal(sameDesktopViewerOrigin("https://other.example/session", "https://desktop.example"), false);
  assert.equal(sameDesktopViewerOrigin("javascript:alert(1)", "https://desktop.example"), false);
});
