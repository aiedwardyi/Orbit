import assert from "node:assert/strict";
import test from "node:test";

import { closePrompt, createCloseGuard } from "./close-guard.mjs";

function fixture({ workers = 0, bot = false, answer = true, platform = "win32" } = {}) {
  const state = { workers, bot, answer, prompts: [], closes: 0, prevented: 0, release: null };
  const guard = createCloseGuard({
    platform,
    workerCount: () => state.workers,
    botBusy: () => state.bot,
    confirm: (prompt) => {
      state.prompts.push(prompt);
      if (state.hold) return new Promise((resolve) => (state.release = resolve));
      return Promise.resolve(state.answer);
    },
  });
  const event = () => ({ preventDefault: () => state.prevented++ });
  const close = () => guard.handleClose(event(), () => {
    state.closes++;
    void guard.handleClose(event(), () => {});
  });
  return { guard, state, close };
}

test("nothing running closes with no dialog", async () => {
  const f = fixture();
  assert.equal(await f.close(), "close");
  assert.equal(f.state.prompts.length, 0);
  assert.equal(f.state.prevented, 0);
});

test("a live worker pane asks and holds the close", async () => {
  const f = fixture({ workers: 2, answer: false });
  assert.equal(await f.close(), "keep");
  assert.deepEqual(f.state.prompts, [{ key: "close.workerMany", vars: { count: 2 } }]);
  assert.equal(f.state.prevented, 1);
});

test("a busy bot asks", async () => {
  const f = fixture({ bot: true, answer: false });
  assert.equal(await f.close(), "keep");
  assert.deepEqual(f.state.prompts, [{ key: "close.bot" }]);
});

test("Cancel keeps the window and asks again next time", async () => {
  const f = fixture({ workers: 1, answer: false });
  assert.equal(await f.close(), "keep");
  assert.equal(await f.close(), "keep");
  assert.equal(f.state.closes, 0);
  assert.equal(f.state.prompts.length, 2);
});

test("Close closes the window once, without a second dialog", async () => {
  const f = fixture({ workers: 1, answer: true });
  assert.equal(await f.close(), "close");
  assert.equal(f.state.closes, 1);
  assert.equal(f.state.prompts.length, 1);
});

test("a second close while the dialog is open does nothing", async () => {
  const f = fixture({ bot: true });
  f.state.hold = true;
  const first = f.close();
  assert.equal(await f.close(), "ignored");
  assert.equal(f.state.prompts.length, 1);
  assert.equal(f.state.prevented, 2);
  f.state.release(false);
  assert.equal(await first, "keep");
  assert.equal(f.state.prompts.length, 1);
});

for (const path of ["update install", "start fresh", "signal quit", "shutdown or sign-out"]) {
  test(`${path} never asks`, async () => {
    const f = fixture({ workers: 3, bot: true });
    f.guard.leave();
    assert.equal(await f.close(), "close");
    assert.equal(f.state.prompts.length, 0);
    assert.equal(f.state.prevented, 0);
  });
}

test("macOS never asks because closing the window does not quit", async () => {
  const f = fixture({ workers: 3, bot: true, platform: "darwin" });
  assert.equal(await f.close(), "close");
  assert.equal(f.state.prompts.length, 0);
});

test("prompt copy keys follow what is running", () => {
  assert.equal(closePrompt({ workers: 0, botBusy: false }), null);
  assert.deepEqual(closePrompt({ workers: 1, botBusy: false }), { key: "close.workerOne" });
  assert.deepEqual(closePrompt({ workers: 4, botBusy: false }), { key: "close.workerMany", vars: { count: 4 } });
  assert.deepEqual(closePrompt({ workers: 0, botBusy: true }), { key: "close.bot" });
  assert.deepEqual(closePrompt({ workers: 1, botBusy: true }), { key: "close.both" });
});
