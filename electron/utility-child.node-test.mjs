import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";

import { UTILITY_SHUTDOWN_TYPE, stopUtilityChild } from "./utility-child.mjs";

function fakeChild({ postMessage, kill } = {}) {
  const child = new EventEmitter();
  child.messages = [];
  child.kills = 0;
  child.postMessage = (message) => {
    if (typeof postMessage === "function") return postMessage(message);
    child.messages.push(message);
  };
  child.kill = () => {
    child.kills += 1;
    if (typeof kill === "function") return kill();
  };
  return child;
}

test("asks the utility child to stop before any hard kill", async () => {
  const child = fakeChild();
  const pending = stopUtilityChild(child, { timeoutMs: 5_000 });
  assert.deepEqual(child.messages, [{ type: UTILITY_SHUTDOWN_TYPE }]);
  assert.equal(child.kills, 0);
  child.emit("exit", 0);
  assert.equal(await pending, "exited");
  assert.equal(child.kills, 0);
});

test("force-kills a child that ignores the graceful stop", async () => {
  const child = fakeChild();
  const pending = stopUtilityChild(child, { timeoutMs: 10 });
  assert.equal(await pending, "forced");
  assert.equal(child.kills, 1);
});

test("falls back to kill when postMessage cannot be delivered", async () => {
  const child = fakeChild({
    postMessage() {
      throw new Error("port closed");
    },
  });
  assert.equal(await stopUtilityChild(child, { timeoutMs: 5_000 }), "forced");
  assert.equal(child.kills, 1);
});

test("is a no-op when there is no child", async () => {
  assert.equal(await stopUtilityChild(null), "absent");
  assert.equal(await stopUtilityChild(undefined), "absent");
});

test("the harness listens for the same shutdown type Electron posts", async () => {
  const { readFileSync } = await import("node:fs");
  const { fileURLToPath } = await import("node:url");
  const { dirname, join } = await import("node:path");
  const server = readFileSync(
    join(dirname(fileURLToPath(import.meta.url)), "..", "server", "utility-parent.ts"),
    "utf8",
  );
  assert.match(server, new RegExp(`"${UTILITY_SHUTDOWN_TYPE}"`));
});
