import assert from "node:assert/strict";
import test from "node:test";
import os from "node:os";
import { createTerminalHost, terminalEnvironment, terminalReadyTimeoutMs, trustedTerminalSender } from "./terminal-host.mjs";

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

test("restart keeps the old session when replacement startup fails", async () => {
  const children = [];
  const owner = { id: 1, mainFrame: {}, send() {} };
  const event = { sender: owner, senderFrame: owner.mainFrame };
  const host = createTerminalHost({
    authorize() {}, resolveCwd: async () => os.tmpdir(), platform: "linux", env: { SHELL: "/bin/sh" },
    loadPty: () => ({ spawn: () => {
      if (children.length > 0) throw new Error("spawn failed");
      const child = { killed: false, onData() {}, onExit() {}, ready: Promise.resolve(), write() {}, resize() {}, kill() { this.killed = true; } };
      children.push(child);
      return child;
    } }),
  });
  const first = await host.open(event, { botId: "spawn-failure", cols: 80, rows: 24 });
  await assert.rejects(host.open(event, { botId: "spawn-failure", cols: 80, rows: 24, restart: true }), /spawn failed/);
  assert.equal(children[0].killed, false);
  assert.equal((await host.open(event, { botId: "spawn-failure", cols: 80, rows: 24 })).id, first.id);
  assert.equal(children.length, 1);
});

test("does not expose a session before its worker is ready", async () => {
  let resolveReady;
  const ready = new Promise((resolve) => { resolveReady = resolve; });
  const child = { onData() {}, onExit() {}, ready, write() {}, resize() {}, kill() {} };
  const owner = { id: 1, mainFrame: {}, send() {} };
  const event = { sender: owner, senderFrame: owner.mainFrame };
  const host = createTerminalHost({
    authorize() {}, resolveCwd: async () => os.tmpdir(), platform: "linux", env: { SHELL: "/bin/sh" },
    loadPty: () => ({ spawn: () => child }),
  });
  const opening = host.open(event, { botId: "ready", cols: 80, rows: 24 });
  await new Promise((resolve) => setImmediate(resolve));
  let settled = false;
  void opening.finally(() => { settled = true; });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(settled, false);
  resolveReady();
  const session = await opening;
  assert.equal(session.id.length > 0, true);
});

test("gives a cold Windows worker a longer readiness grace period", () => {
  assert.equal(terminalReadyTimeoutMs("win32"), 15_000);
  assert.equal(terminalReadyTimeoutMs("linux"), 5_000);
});

test("emits one terminal attention event for a bell or exit", async () => {
  const f = fixture();
  const session = await f.host.open(f.event, f.input);
  f.children[0].data("\x07");
  f.children[0].exit({ exitCode: 0 });
  const attention = f.events.filter(([channel]) => channel === "terminal:attention");
  assert.deepEqual(attention, [["terminal:attention", { id: session.id, botId: "bot-1", reason: "bell" }]]);
});

test("waits for the old worker shutdown acknowledgement before replacing it", async () => {
  let releaseKill;
  const killAck = new Promise((resolve) => { releaseKill = resolve; });
  const children = [];
  const makeChild = (kill = () => {}) => ({ onData() {}, onExit() {}, ready: Promise.resolve(), write() {}, resize() {}, kill });
  const owner = { id: 1, mainFrame: {}, send() {} };
  const event = { sender: owner, senderFrame: owner.mainFrame };
  const host = createTerminalHost({
    authorize() {}, resolveCwd: async () => os.tmpdir(), platform: "linux", env: { SHELL: "/bin/sh" },
    loadPty: () => ({ spawn: () => {
      const child = makeChild(children.length === 0 ? () => { children[0].killed = true; return killAck; } : undefined);
      child.killed = false;
      children.push(child);
      return child;
    } }),
  });
  const first = await host.open(event, { botId: "shutdown-ack", cols: 80, rows: 24 });
  let settled = false;
  const replacement = host.open(event, { botId: "shutdown-ack", cols: 80, rows: 24, restart: true }).finally(() => { settled = true; });
  for (let attempt = 0; attempt < 20 && children.length < 2; attempt += 1) await new Promise((resolve) => setImmediate(resolve));
  assert.equal(children.length, 2);
  assert.equal(children[0].killed, true);
  assert.equal(settled, false);
  releaseKill();
  const next = await replacement;
  assert.notEqual(next.id, first.id);
});

test("a restart requested during startup uses its explicit target", async () => {
  let releaseFolder;
  const folder = new Promise((resolve) => { releaseFolder = resolve; });
  const children = [];
  const owner = { id: 1, mainFrame: {}, send() {} };
  const event = { sender: owner, senderFrame: owner.mainFrame };
  const host = createTerminalHost({
    authorize() {},
    resolveCwd: async () => { await folder; return os.tmpdir(); },
    platform: "linux", env: { SHELL: "/bin/sh" },
    loadPty: () => ({ spawn: () => {
      const child = { onData() {}, onExit() {}, ready: Promise.resolve(), write() {}, resize() {}, kill() {} };
      children.push(child);
      return child;
    } }),
  });
  const opening = host.open(event, { botId: "startup-restart", cols: 80, rows: 24 });
  const restart = host.open(event, { botId: "startup-restart", cols: 80, rows: 24, restart: true, cwd: process.cwd(), projectCwd: process.cwd() });
  releaseFolder();
  const session = await restart;
  assert.equal(session.cwd, process.cwd());
  assert.equal(session.launchProject, process.cwd());
  assert.equal((await opening).id, session.id);
  assert.equal(children.length, 1);
});

test("turns a synchronous EBADF write failure into an exited terminal", async () => {
  const events = [];
  const owner = { id: 1, mainFrame: {}, send: (...args) => events.push(args) };
  const event = { sender: owner, senderFrame: owner.mainFrame };
  const child = { onData() {}, onExit() {}, ready: Promise.resolve(), write() { throw Object.assign(new Error("EBADF"), { code: "EBADF" }); }, resize() {}, kill() { this.killed = true; } };
  const host = createTerminalHost({
    authorize() {}, resolveCwd: async () => os.tmpdir(), platform: "linux", env: { SHELL: "/bin/sh" },
    loadPty: () => ({ spawn: () => child }),
  });
  const session = await host.open(event, { botId: "ebadf", cols: 80, rows: 24 });
  assert.throws(() => host.write(event, session.id, "x"), /EBADF/);
  assert.deepEqual(events.map(([channel, value]) => [channel, value.message ?? value.exitCode ?? value.reason]), [
    ["terminal:attention", "error"], ["terminal:error", "EBADF"], ["terminal:exit", 1],
  ]);
  assert.equal(child.killed, true);
});

test("turns an asynchronous PTY write failure into an exited terminal", async () => {
  const events = [];
  const owner = { id: 1, mainFrame: {}, send: (...args) => events.push(args) };
  const event = { sender: owner, senderFrame: owner.mainFrame };
  const child = { onData() {}, onExit() {}, ready: Promise.resolve(), write: async () => { throw new Error("EBADF"); }, resize() {}, kill() { this.killed = true; } };
  const host = createTerminalHost({
    authorize() {}, resolveCwd: async () => os.tmpdir(), platform: "linux", env: { SHELL: "/bin/sh" },
    loadPty: () => ({ spawn: () => child }),
  });
  const session = await host.open(event, { botId: "async-ebadf", cols: 80, rows: 24 });
  await assert.rejects(host.write(event, session.id, "x"), /EBADF/);
  assert.deepEqual(events.map(([channel, value]) => [channel, value.message ?? value.exitCode ?? value.reason]), [
    ["terminal:attention", "error"], ["terminal:error", "EBADF"], ["terminal:exit", 1],
  ]);
  assert.equal(child.killed, true);
});
