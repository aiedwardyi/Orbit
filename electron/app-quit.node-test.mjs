import assert from "node:assert/strict";
import test from "node:test";

import { EventEmitter } from "node:events";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";

import { callQuitAndInstall, completeQuitAfterCleanup } from "./app-quit.mjs";

function quitFixture(pendingUpdateInstall = true) {
  const calls = [];
  const timers = [];
  let releaseDispose;
  const disposed = new Promise((resolve) => { releaseDispose = resolve; });
  const app = new EventEmitter();
  app.quit = () => calls.push("quit");
  const source = readFileSync(new URL("./main.mjs", import.meta.url), "utf8");
  const cleanup = source.slice(source.indexOf("const CUA_STOP_TIMEOUT_MS ="));
  assert.ok(cleanup.startsWith("const CUA_STOP_TIMEOUT_MS ="));
  runInNewContext(cleanup, {
    app, process: { once() {} }, closeGuard: { leave() {} }, keepAwake: { stop() {} }, nativeActions: {}, stopRecorder() {},
    errorReports: { stop() {} },
    BrowserWindow: { getAllWindows: () => [0, 1, 2].map((id) => ({ isDestroyed: () => id === 2, hide: () => calls.push(`hide-${id}`) })) },
    terminalHost: { dispose() { calls.push("dispose"); return disposed; } }, browserSurface: null, serverProc: null,
    stopUtilityChild: async () => {}, stopCua: async () => {}, browserHost: null, terminalBridge: { close: async () => {} }, stopDesktopCompanion: async () => {},
    consumePendingUpdateInstall: () => pendingUpdateInstall, applyPendingUpdateInstall: () => { calls.push("install"); return true; }, completeQuitAfterCleanup,
    setTimeout(callback, ms) { timers.push({ callback, ms }); return { unref() {} }; },
  });
  const quit = () => app.emit("before-quit", { preventDefault() {} });
  return { calls, timers, quit, releaseDispose };
}

for (const pendingUpdateInstall of [true, false]) {
  test(`main waits for terminal disposal before ${pendingUpdateInstall ? "install" : "quit"}`, async () => {
    const f = quitFixture(pendingUpdateInstall);
    f.quit();
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(f.calls.includes("install") || f.calls.includes("quit"), false);
    f.releaseDispose();
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(f.calls.at(-1), pendingUpdateInstall ? "install" : "quit");
  });
}

test("main hides all live windows before waiting for terminal disposal", () => {
  const f = quitFixture();
  f.quit();
  assert.deepEqual(f.calls.slice(0, 3), ["hide-0", "hide-1", "dispose"]);
});

test("main waits for disposal until the existing 2.5 second cleanup cap", async () => {
  const f = quitFixture();
  f.quit();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(f.calls.includes("install"), false);
  assert.equal(f.timers.length, 1);
  assert.equal(f.timers[0].ms, 2500);
  f.timers[0].callback();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(f.calls.at(-1), "install");
});

test("applies a pending update install after cleanup instead of a plain quit", () => {
  const calls = [];
  const result = completeQuitAfterCleanup({
    pendingUpdateInstall: true,
    quitAndInstall: () => calls.push("install"),
    quit: () => calls.push("quit"),
  });
  assert.equal(result, "install");
  assert.deepEqual(calls, ["install"]);
});

test("plain quit after cleanup does not start the installer", () => {
  const calls = [];
  const result = completeQuitAfterCleanup({
    pendingUpdateInstall: false,
    quitAndInstall: () => calls.push("install"),
    quit: () => calls.push("quit"),
  });
  assert.equal(result, "quit");
  assert.deepEqual(calls, ["quit"]);
});

test("falls back to quit when quitAndInstall throws", () => {
  const calls = [];
  const result = completeQuitAfterCleanup({
    pendingUpdateInstall: true,
    quitAndInstall: () => {
      calls.push("install");
      throw new Error("staging failed");
    },
    quit: () => calls.push("quit"),
  });
  assert.equal(result, "quit");
  assert.deepEqual(calls, ["install", "quit"]);
});

test("falls back to quit when quitAndInstall reports that install did not start", () => {
  const calls = [];
  const result = completeQuitAfterCleanup({
    pendingUpdateInstall: true,
    quitAndInstall: () => {
      calls.push("install");
      return false;
    },
    quit: () => calls.push("quit"),
  });
  assert.equal(result, "quit");
  assert.deepEqual(calls, ["install", "quit"]);
});

test("callQuitAndInstall returns true when the updater starts the installer", () => {
  const updater = new EventEmitter();
  updater.quitAndInstall = () => {};
  assert.equal(callQuitAndInstall(updater), true);
});

test("callQuitAndInstall returns false when the updater emits error without throwing", () => {
  const updater = new EventEmitter();
  updater.quitAndInstall = () => {
    updater.emit("error", new Error("No update filepath provided, can't quit and install"));
  };
  assert.equal(callQuitAndInstall(updater), false);
});

test("callQuitAndInstall rethrows a synchronous throw so cleanup can still quit", () => {
  const updater = new EventEmitter();
  updater.quitAndInstall = () => {
    throw new Error("staging failed");
  };
  assert.throws(() => callQuitAndInstall(updater), { message: "staging failed" });
});
