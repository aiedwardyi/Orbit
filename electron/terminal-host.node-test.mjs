import assert from "node:assert/strict";
import test from "node:test";
import os from "node:os";
import { createTerminalHost, terminalEnvironment, trustedTerminalSender } from "./terminal-host.mjs";

function fixture() {
  const events = [];
  const owner = { id: 1, mainFrame: { url: "http://127.0.0.1:8799/" }, getURL: () => "http://127.0.0.1:8799/", isDestroyed: () => false, send: (...args) => events.push(args) };
  const event = { sender: owner, senderFrame: owner.mainFrame };
  const children = [];
  const host = createTerminalHost({
    authorize: (caller) => { if (!trustedTerminalSender(caller, owner, "http://127.0.0.1:8799")) throw new Error("Untrusted"); },
    resolveCwd: async () => os.tmpdir(),
    platform: "linux",
    env: { SHELL: "/bin/sh" },
    loadPty: () => ({ spawn: () => {
      const child = { writes: [], sizes: [], killed: false, onData(cb) { this.data = cb; }, onExit(cb) { this.exit = cb; }, write(data) { this.writes.push(data); }, resize(...size) { this.sizes.push(size); }, kill() { this.killed = true; } };
      children.push(child);
      return child;
    } }),
  });
  return { host, event, owner, children, events, input: { botId: "bot-1", cols: 80, rows: 24 } };
}

test("rejects iframe, foreign window and navigated renderer on every action", async () => {
  const f = fixture();
  const session = await f.host.open(f.event, f.input);
  for (const event of [{ ...f.event, senderFrame: { url: f.owner.mainFrame.url } }, { ...f.event, sender: {} }]) {
    await assert.rejects(f.host.open(event, f.input), /Untrusted/);
    assert.throws(() => f.host.write(event, session.id, "x"), /Untrusted/);
    assert.throws(() => f.host.resize(event, session.id, 80, 24), /Untrusted/);
  }
  f.owner.mainFrame.url = "https://example.com";
  assert.throws(() => f.host.write(f.event, session.id, "x"), /Untrusted/);
  f.children[0].data("secret");
  assert.equal(f.events.length, 0);
});

test("concurrent opens share one shell and reopening replays bounded sequenced output", async () => {
  const f = fixture();
  const [first, second] = await Promise.all([f.host.open(f.event, f.input), f.host.open(f.event, f.input)]);
  assert.equal(first.id, second.id);
  assert.equal(f.children.length, 1);
  f.children[0].data("x".repeat(300000));
  f.children[0].data("tail");
  const replay = await f.host.open(f.event, f.input);
  assert.equal(replay.output.length, 256 * 1024);
  assert.ok(replay.output.endsWith("tail"));
  assert.equal(replay.seq, 2);
  assert.equal(f.events[1][1].seq, 2);
  assert.equal(f.children[0].killed, false);
});

test("validates writes, dimensions, ownership and explicit restart", async () => {
  const f = fixture();
  const first = await f.host.open(f.event, f.input);
  assert.throws(() => f.host.write(f.event, "wrong", "x"), /Unknown/);
  assert.throws(() => f.host.write(f.event, first.id, "x".repeat(65537)), /Invalid/);
  assert.throws(() => f.host.resize(f.event, first.id, Infinity, 24), /Invalid/);
  f.host.write(f.event, first.id, "git status\r");
  assert.deepEqual(f.children[0].writes, ["git status\r"]);
  // Explicit restart replaces a live session (Restart here).
  const replaced = await f.host.open(f.event, { ...f.input, restart: true });
  assert.notEqual(replaced.id, first.id);
  assert.equal(f.children[0].killed, true);
  assert.equal(f.children.length, 2);
  f.children[1].exit({ exitCode: 7 });
  assert.equal((await f.host.open(f.event, f.input)).exitCode, 7);
  assert.throws(() => f.host.write(f.event, replaced.id, "x"), /exited/);
  const next = await f.host.open(f.event, { ...f.input, restart: true });
  assert.notEqual(next.id, replaced.id);
  f.host.dispose();
  assert.equal(f.children[1].killed, false);
  assert.equal(f.children[2].killed, true);
  await assert.rejects(f.host.open(f.event, f.input), /shutting down/);
});

test("needsFolder resolution does not spawn a shell", async () => {
  const events = [];
  const owner = { id: 1, mainFrame: { url: "http://127.0.0.1:8799/" }, getURL: () => "http://127.0.0.1:8799/", isDestroyed: () => false, send: (...args) => events.push(args) };
  const event = { sender: owner, senderFrame: owner.mainFrame };
  const children = [];
  const host = createTerminalHost({
    authorize: (caller) => { if (!trustedTerminalSender(caller, owner, "http://127.0.0.1:8799")) throw new Error("Untrusted"); },
    resolveCwd: async () => ({ needsFolder: true, reason: "explicit-unavailable" }),
    platform: "linux",
    env: { SHELL: "/bin/sh" },
    loadPty: () => ({ spawn: () => { const child = {}; children.push(child); return child; } }),
  });
  const result = await host.open(event, { botId: "bot-1", cols: 80, rows: 24 });
  assert.deepEqual(result, { needsFolder: true, reason: "explicit-unavailable" });
  assert.equal(children.length, 0);
});

test("removes app and provider secrets from the shell environment", () => {
  assert.deepEqual(terminalEnvironment({ PATH: "bin", HOME: "home", OMB_COMMS_TOKEN: "secret", ANTHROPIC_API_KEY: "secret", AWS_SECRET_ACCESS_KEY: "secret", ELECTRON_RUN_AS_NODE: "1", NODE_OPTIONS: "bad", GITHUB_TOKEN: "secret" }), { PATH: "bin", HOME: "home" });
});

test("navigation during folder resolution cannot spawn a shell", async () => {
  const f = fixture();
  const task = f.host.open(f.event, f.input);
  f.owner.mainFrame.url = "https://example.com";
  await assert.rejects(task, /Untrusted/);
  assert.equal(f.children.length, 0);
});

test("shutdown during folder resolution cannot spawn a shell", async () => {
  const f = fixture();
  const task = f.host.open(f.event, f.input);
  f.host.dispose();
  await assert.rejects(task, /shutting down/);
  assert.equal(f.children.length, 0);
});

test("restart keeps the old session when the new folder is unavailable", async () => {
  const events = [];
  const owner = { id: 1, mainFrame: { url: "http://127.0.0.1:8799/" }, getURL: () => "http://127.0.0.1:8799/", isDestroyed: () => false, send: (...args) => events.push(args) };
  const event = { sender: owner, senderFrame: owner.mainFrame };
  const children = [];
  let resolveCalls = 0;
  const host = createTerminalHost({
    authorize: (caller) => { if (!trustedTerminalSender(caller, owner, "http://127.0.0.1:8799")) throw new Error("Untrusted"); },
    resolveCwd: async () => {
      resolveCalls += 1;
      if (resolveCalls === 1) return os.tmpdir();
      return { needsFolder: true, reason: "explicit-unavailable" };
    },
    platform: "linux",
    env: { SHELL: "/bin/sh" },
    loadPty: () => ({ spawn: () => {
      const child = { writes: [], sizes: [], killed: false, onData(cb) { this.data = cb; }, onExit(cb) { this.exit = cb; }, write(data) { this.writes.push(data); }, resize(...size) { this.sizes.push(size); }, kill() { this.killed = true; } };
      children.push(child);
      return child;
    } }),
  });
  const first = await host.open(event, { botId: "bot-1", cols: 80, rows: 24 });
  const blocked = await host.open(event, { botId: "bot-1", cols: 80, rows: 24, restart: true });
  assert.deepEqual(blocked, { needsFolder: true, reason: "explicit-unavailable" });
  assert.equal(children[0].killed, false);
  const resumed = await host.open(event, { botId: "bot-1", cols: 80, rows: 24 });
  assert.equal(resumed.id, first.id);
  assert.equal(children.length, 1);
});
