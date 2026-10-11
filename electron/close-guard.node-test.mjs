import assert from "node:assert/strict";
import test, { mock } from "node:test";

import { closePrompt, createCloseGuard } from "./close-guard.mjs";

function fixture({ workers = 0, bot = false, answer = true, platform = "win32" } = {}) {
  const state = { workers, bot, answer, prompts: [], closes: 0, prevented: 0, release: null, order: [] };
  const guard = createCloseGuard({
    platform,
    workerCount: () => state.workers,
    botBusy: () => state.bot,
    reveal: () => state.order.push("reveal"),
    confirm: (prompt) => {
      state.order.push("confirm");
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

test("a cancelled shutdown re-arms the prompt, a real one stays off", async (t) => {
  t.after(() => mock.timers.reset());
  mock.timers.enable({ apis: ["setTimeout"] });
  const cancelled = fixture({ workers: 1, answer: false });
  cancelled.guard.leaveBriefly();
  assert.equal(await cancelled.close(), "close");
  assert.equal(cancelled.state.prompts.length, 0);
  mock.timers.tick(60_000);
  assert.equal(await cancelled.close(), "keep");
  assert.equal(cancelled.state.prompts.length, 1);

  const real = fixture({ workers: 1 });
  real.guard.leaveBriefly();
  real.guard.leave();
  mock.timers.tick(60_000);
  assert.equal(await real.close(), "close");
  assert.equal(real.state.prompts.length, 0);
});

test("a brief leave never undoes a permanent one", async (t) => {
  t.after(() => mock.timers.reset());
  mock.timers.enable({ apis: ["setTimeout"] });
  const f = fixture({ workers: 1 });
  f.guard.leave();
  f.guard.leaveBriefly();
  mock.timers.tick(60_000);
  assert.equal(await f.close(), "close");
  assert.equal(f.state.prompts.length, 0);
});

test("the window is brought forward before the dialog opens", async () => {
  const f = fixture({ workers: 1, answer: false });
  await f.close();
  assert.deepEqual(f.state.order, ["reveal", "confirm"]);
});

test("nothing is revealed when no dialog is needed", async () => {
  const f = fixture();
  await f.close();
  assert.deepEqual(f.state.order, []);
});

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
