import assert from "node:assert/strict";
import test from "node:test";

import { EventEmitter } from "node:events";

import { callQuitAndInstall, completeQuitAfterCleanup } from "./app-quit.mjs";

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
