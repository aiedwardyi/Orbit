import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import test from "node:test";
import os from "node:os";
import fs from "node:fs";
import path from "node:path";
import { createTerminalHost, createTerminalOutputParser, resolveBotSession, terminalEnvironment, terminalReadyTimeoutMs, trustedTerminalSender, workerShellArgs } from "./terminal-host.mjs";
import { installOrbitMsg, postPaneNote } from "./terminal-mailbox.mjs";
import { spawnTerminalPty } from "./terminal-pty.mjs";

function fixture(options = {}) {
  const events = [];
  const owner = { id: 1, mainFrame: { url: "http://127.0.0.1:8799/" }, getURL: () => "http://127.0.0.1:8799/", isDestroyed: () => false, send: (...args) => events.push(args) };
  const event = { sender: owner, senderFrame: owner.mainFrame };
  const children = [];
  const host = createTerminalHost({
    authorize: (caller) => { if (!trustedTerminalSender(caller, owner, "http://127.0.0.1:8799")) throw new Error("Untrusted"); },
    resolveCwd: async () => os.tmpdir(),
    platform: "linux",
    env: { SHELL: "/bin/sh" },
    loadPty: () => ({ spawn: (shell, args, options) => {
      const child = { pid: 101 + children.length, shell, args, options, writes: [], sizes: [], killed: false, onData(cb) { this.data = cb; }, onExit(cb) { this.exit = cb; }, write(data) { this.writes.push(data); }, resize(...size) { this.sizes.push(size); }, kill() { this.killed = true; } };
      children.push(child);
      return child;
    } }),
    freeMemory: () => 8 * 1024 ** 3,
    setPriority: () => {},
    ...options,
  });
  return { host, event, owner, children, events, input: { botId: "bot-1", cols: 80, rows: 24 } };
}

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

test("dispose stops panes one at a time through their shutdown acknowledgements", async () => {
  const f = fixture();
  const stops = [];
  const releases = [];
  for (let i = 0; i < 3; i++) {
    await f.host.open(f.event, { ...f.input, botId: `bot-${i}` });
    f.children[i].kill = () => { stops.push(i); return new Promise((resolve) => { releases[i] = resolve; }); };
  }
  const disposal = f.host.dispose();
  assert.ok(disposal instanceof Promise);
  assert.equal(f.host.dispose(), disposal);
  for (let i = 0; i < 3; i++) {
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(stops, Array.from({ length: i + 1 }, (_, index) => index));
    releases[i]();
  }
  await disposal;
});

test("dispose waits for worker exit after the shell has already exited", async () => {
  const f = fixture();
  await f.host.open(f.event, f.input);
  let releaseExit;
  f.children[0].exited = new Promise((resolve) => { releaseExit = resolve; });
  f.children[0].exit({ exitCode: 0 });
  let settled = false;
  const disposal = Promise.resolve(f.host.dispose()).then(() => { settled = true; });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(settled, false);
  assert.equal(f.children[0].killed, false);
  releaseExit();
  await disposal;
});

test("dispose waits for the worker of a pane closed just before quit", async () => {
  let owner;
  const f = fixture({ owner: () => owner });
  owner = f.owner;
  await f.host.openForBot("bot-1");
  let releaseExit;
  f.children[0].exited = new Promise((resolve) => { releaseExit = resolve; });
  await f.host.closeBotPanes("bot-1");
  assert.equal(f.children[0].killed, true);
  let settled = false;
  const disposal = Promise.resolve(f.host.dispose()).then(() => { settled = true; });
  await wait(50);
  assert.equal(settled, false);
  releaseExit();
  await disposal;
});

test("dispose bounds each pane at one second without terminating its worker", async () => {
  const f = fixture();
  for (let i = 0; i < 2; i++) await f.host.open(f.event, { ...f.input, botId: `bot-${i}` });
  let terminated = false;
  f.children[0].kill = () => new Promise(() => {});
  f.children[0].terminate = () => { terminated = true; };
  const started = Date.now();
  const disposal = f.host.dispose();
  await wait(650);
  assert.equal(terminated, false);
  assert.equal(f.children[1].killed, false);
  await disposal;
  assert.equal(f.children[1].killed, true);
  assert.ok(Date.now() - started >= 950);
  assert.ok(Date.now() - started < 1500);
  assert.equal(terminated, false);
});

test("dispose bounds all worker exits together at one second", async () => {
  const f = fixture();
  for (let i = 0; i < 3; i++) {
    await f.host.open(f.event, { ...f.input, botId: `bot-${i}` });
    f.children[i].exited = new Promise(() => {});
  }
  const started = Date.now();
  await f.host.dispose();
  assert.ok(Date.now() - started >= 950);
  assert.ok(Date.now() - started < 1500);
});

test("dispose waits for a starting pane before requesting its shutdown", async () => {
  let releaseReady;
  const ready = new Promise((resolve) => { releaseReady = resolve; });
  const child = { ready, killed: false, onData() {}, onExit() {}, write() {}, resize() {}, kill() { this.killed = true; } };
  let spawned;
  const spawning = new Promise((resolve) => { spawned = resolve; });
  const f = fixture({ loadPty: () => ({ spawn() { spawned(); return child; } }) });
  const opening = assert.rejects(f.host.open(f.event, f.input), /shutting down|cancelled/);
  await spawning;
  const disposal = f.host.dispose();
  assert.ok(disposal instanceof Promise);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(child.killed, false);
  releaseReady();
  await Promise.all([opening, disposal]);
  assert.equal(child.killed, true);
});

test("closeBotPanes shares serial shutdown with dispose", async () => {
  let owner;
  const f = fixture({ owner: () => owner });
  owner = f.owner;
  await f.host.openForBot("bot-1");
  await f.host.openForBot("bot-1");
  await f.host.openForBot("bot-2");
  let releaseKill;
  f.children[0].kill = () => new Promise((resolve) => { releaseKill = resolve; });
  const closing = f.host.closeBotPanes("bot-1");
  const disposal = f.host.dispose();
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(f.children.slice(1).map((child) => child.killed), [false, false]);
  releaseKill();
  await Promise.all([closing, disposal]);
  assert.deepEqual(f.children.slice(1).map((child) => child.killed), [true, true]);
});

test("pty exited settles on worker exit after the shell exit notification", async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "quit-pty-"));
  const modulePath = path.join(dir, "pty.cjs");
  fs.writeFileSync(modulePath, 'exports.spawn = () => ({ onData() {}, onExit(listener) { this.exit = listener; }, kill() { setImmediate(() => this.exit({ exitCode: 0 })); } });\n');
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const pty = spawnTerminalPty(modulePath, "fake", [], {});
  t.after(() => pty.kill().catch(() => {}));
  await pty.ready;
  assert.ok(pty.exited instanceof Promise);
  let workerExited = false;
  let shellExited = false;
  void pty.exited.then(() => { workerExited = true; });
  pty.onExit(() => { shellExited = true; assert.equal(workerExited, false); });
  await pty.kill();
  await pty.exited;
  assert.equal(shellExited, true);
  assert.equal(workerExited, true);
});

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

test("reads the parsed screen with a stable generation and no side effects", async () => {
  const f = fixture();
  const session = await f.host.open(f.event, f.input);
  f.children[0].data("hello\x1b[2J\x1b[Hworld\r\nnext");
  const before = f.children[0].writes.length;
  const read = f.host.read(f.event, session.id);
  assert.equal(read.sessionId, session.id);
  assert.equal(read.generation, 1);
  assert.equal(read.cwd, os.tmpdir());
  assert.equal(read.seq, 1);
  assert.match(read.screenText, /^world\nnext/u);
  assert.equal(f.children[0].writes.length, before);
  assert.equal(f.events.some(([channel]) => channel === "terminal:attention"), false);
});

test("readBot binds a snapshot to the bot and confirmed sends reject stale sessions", async () => {
  const f = fixture();
  const session = await f.host.open(f.event, f.input);
  const read = f.host.readBot("bot-1");
  assert.equal(read.sessionId, session.id);
  assert.equal(read.generation, 1);
  assert.throws(() => f.host.sendBot("bot-1", { sessionId: session.id, generation: 0, text: "echo stale\r" }), /stale/);
  assert.throws(() => f.host.sendBot("bot-1", { sessionId: session.id, generation: 1, text: "cancel\x03" }), /Ctrl\+C/);
  f.host.sendBot("bot-1", { sessionId: session.id, generation: 1, text: "echo ok\r" });
  assert.deepEqual(f.children[0].writes, ["echo ok\r"]);
  const replaced = await f.host.open(f.event, { ...f.input, restart: true });
  assert.equal(f.host.readBot("bot-1").generation, 2);
  assert.throws(() => f.host.sendBot("bot-1", { sessionId: session.id, generation: 1, text: "old\r" }), /stale/);
  assert.notEqual(replaced.id, session.id);
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

test("cancels an abandoned open before spawning a shell", async () => {
  let releaseFolder;
  const folder = new Promise((resolve) => { releaseFolder = resolve; });
  const f = fixture();
  const host = createTerminalHost({
    authorize: (caller) => { if (!trustedTerminalSender(caller, f.owner, "http://127.0.0.1:8799")) throw new Error("Untrusted"); },
    resolveCwd: async () => { await folder; return os.tmpdir(); },
    platform: "linux",
    env: { SHELL: "/bin/sh" },
    loadPty: () => ({ spawn: () => { throw new Error("spawned after cancel"); } }),
  });
  const opening = host.open(f.event, f.input);
  assert.equal(host.cancelOpen(f.event, f.input.botId), true);
  releaseFolder();
  await assert.rejects(opening, /cancelled/);
  assert.equal(host.cancelOpen(f.event, f.input.botId), false);
});

test("retires a worker when its open is cancelled during readiness", async () => {
  let releaseReady;
  const ready = new Promise((resolve) => { releaseReady = resolve; });
  let spawnedResolve;
  const spawned = new Promise((resolve) => { spawnedResolve = resolve; });
  const events = [];
  const owner = { id: 1, mainFrame: {}, send: (...args) => events.push(args) };
  const event = { sender: owner, senderFrame: owner.mainFrame };
  const child = { onData() {}, onExit() {}, ready, write() {}, resize() {}, killed: false, kill() { this.killed = true; } };
  const host = createTerminalHost({
    authorize() {},
    resolveCwd: async () => os.tmpdir(),
    platform: "linux",
    env: { SHELL: "/bin/sh" },
    loadPty: () => ({ spawn: () => { spawnedResolve(); return child; } }),
  });
  const opening = host.open(event, { botId: "readiness-cancel", cols: 80, rows: 24 });
  const cancelled = assert.rejects(opening, /cancelled/);
  await spawned;
  assert.equal(host.cancelOpen(event, "readiness-cancel"), true);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(child.killed, false);
  releaseReady();
  await cancelled;
  assert.equal(child.killed, true);
  assert.equal(events.some(([channel]) => channel === "terminal:attention"), false);
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
  f.host.write(f.event, session.id, "command\r");
  f.children[0].data("\x07");
  f.children[0].exit({ exitCode: 0 });
  const attention = f.events.filter(([channel]) => channel === "terminal:attention");
  assert.deepEqual(attention, [["terminal:attention", { id: session.id, botId: "bot-1", reason: "bell" }]]);
});

test("rearms terminal attention after a new command", async () => {
  const f = fixture();
  const session = await f.host.open(f.event, f.input);
  f.host.write(f.event, session.id, "first\r");
  f.children[0].data("\x07");
  f.host.write(f.event, session.id, "next\r");
  f.children[0].data("\x07");
  assert.deepEqual(
    f.events.filter(([channel]) => channel === "terminal:attention"),
    [
      ["terminal:attention", { id: session.id, botId: "bot-1", reason: "bell" }],
      ["terminal:attention", { id: session.id, botId: "bot-1", reason: "bell" }],
    ],
  );
});

test("a confirmed bot send never arms the user's terminal alert", async () => {
  const f = fixture();
  const session = await f.host.open(f.event, f.input);
  f.host.sendBot("bot-1", { sessionId: session.id, generation: 1, text: "first\r" });
  f.children[0].data("\x07");
  assert.equal(f.events.some(([channel]) => channel === "terminal:attention"), false);
  f.host.write(f.event, session.id, "mine\r");
  f.children[0].data("\x07");
  assert.equal(f.events.filter(([channel]) => channel === "terminal:attention").length, 1);
  f.host.dispose();
});

test("keeps OSC title terminators and split ANSI sequences out of attention", async () => {
  const f = fixture({ activityCoalesceMs: 5 });
  const session = await f.host.open(f.event, f.input);
  f.children[0].data("\x1b]0;Orbit");
  f.children[0].data(" terminal\x07\x1b[31");
  f.children[0].data("m\x1b[?25l");
  await wait(15);
  assert.equal(f.events.some(([channel]) => channel === "terminal:attention"), false);
  f.host.write(f.event, session.id, "claude\r");
  f.children[0].data("response without a bell");
  await wait(15);
  assert.equal(f.events.filter(([channel]) => channel === "terminal:attention").at(-1)?.[1].reason, "activity");
  f.host.dispose();
});

test("does not notify for an initial prompt, replay, or resize before a command", async () => {
  const f = fixture({ activityCoalesceMs: 5 });
  const session = await f.host.open(f.event, f.input);
  f.children[0].data("PS C:\\workspace> \x07");
  await wait(15);
  f.host.resize(f.event, session.id, 100, 30);
  const replay = await f.host.open(f.event, f.input);
  assert.equal(replay.id, session.id);
  await wait(15);
  assert.equal(f.events.some(([channel]) => channel === "terminal:attention"), false);
  f.host.dispose();
});

test("reports delayed ordinary text without requiring a BEL or a new Enter", async () => {
  const f = fixture({ activityCoalesceMs: 5 });
  const session = await f.host.open(f.event, f.input);
  f.host.write(f.event, session.id, "claude\r");
  f.children[0].data("delayed response");
  await wait(15);
  assert.deepEqual(f.events.filter(([channel]) => channel === "terminal:attention").map(([, value]) => value), [
    { id: session.id, botId: "bot-1", reason: "activity" },
  ]);
  f.host.dispose();
});

test("coalesces output, suppresses input echo and rearms after acknowledgement cooldown", async () => {
  let clock = 1_000;
  const f = fixture({ activityCoalesceMs: 5, attentionCooldownMs: 3_000, now: () => clock });
  const session = await f.host.open(f.event, f.input);
  f.host.write(f.event, session.id, "ls\r");
  f.children[0].data("ls\r\n");
  await wait(15);
  assert.equal(f.events.some(([channel]) => channel === "terminal:attention"), false);
  f.children[0].data("first");
  f.children[0].data(" second");
  await wait(15);
  assert.equal(f.events.filter(([channel]) => channel === "terminal:attention").length, 1);
  f.host.acknowledge(f.event, session.id);
  f.children[0].data("during cooldown");
  await wait(15);
  assert.equal(f.events.filter(([channel]) => channel === "terminal:attention").length, 1);
  clock += 3_001;
  f.host.write(f.event, session.id, "next\r");
  f.children[0].data("later output");
  await wait(15);
  assert.equal(f.events.filter(([channel]) => channel === "terminal:attention").length, 2);
  assert.equal(f.events.at(-1)?.[1].reason, "activity");
  f.host.resize(f.event, session.id, 100, 30);
  const replay = await f.host.open(f.event, f.input);
  assert.equal(replay.id, session.id);
  assert.equal(f.events.filter(([channel]) => channel === "terminal:attention").length, 2);
  f.host.dispose();
});

test("waits for a redrawing full-screen app to go quiet before reporting activity", async (t) => {
  const f = fixture({ activityCoalesceMs: 20 });
  const session = await f.host.open(f.event, f.input);
  // Real 10 ms gaps against a 20 ms settle race Windows' ~16 ms timer tick; drive the clock instead.
  t.mock.timers.enable({ apis: ["setTimeout"] });
  f.host.write(f.event, session.id, "\r");
  for (let frame = 0; frame < 5; frame += 1) {
    f.children[0].data(`\x1b[?2026h\x1b[5;1Hworking ${frame}\x1b[?2026l`);
    f.host.write(f.event, session.id, "\x1b[<35;10;5M");
    t.mock.timers.tick(10);
  }
  assert.equal(f.events.some(([channel]) => channel === "terminal:attention"), false);
  t.mock.timers.tick(40);
  assert.deepEqual(f.events.filter(([channel]) => channel === "terminal:attention").map(([, value]) => value.reason), ["activity"]);
  f.host.dispose();
});

test("a later submit still reaches the PTY after a full-screen settle and acknowledgement", async () => {
  let clock = 1_000;
  const f = fixture({ activityCoalesceMs: 5, attentionCooldownMs: 3_000, now: () => clock });
  const session = await f.host.open(f.event, f.input);
  f.host.write(f.event, session.id, "first\r");
  f.children[0].data("\x1b[?1049h\x1b[?2026hdone\x1b[?2026l");
  await wait(15);
  assert.equal(f.events.filter(([channel]) => channel === "terminal:attention").length, 1);
  f.host.acknowledge(f.event, session.id);
  f.host.write(f.event, session.id, "second");
  f.host.write(f.event, session.id, "\r");
  f.host.write(f.event, session.id, "\n");
  assert.deepEqual(f.children[0].writes, ["first\r", "second", "\r", "\n"]);
  f.children[0].data("during cooldown after submit");
  await wait(15);
  assert.equal(f.events.filter(([channel]) => channel === "terminal:attention").length, 2);
  f.host.acknowledge(f.event, session.id);
  f.host.write(f.event, session.id, "\x1b[13u");
  f.children[0].data("kitty submit");
  await wait(15);
  assert.equal(f.events.filter(([channel]) => channel === "terminal:attention").length, 3);
  f.host.dispose();
});

test("reattaching a trimmed full-screen session restores the alt screen and forces a repaint", async () => {
  const f = fixture();
  const session = await f.host.open(f.event, f.input);
  f.children[0].data("\x1b[?1049h");
  f.children[0].data("x".repeat(300000));
  const replay = await f.host.open(f.event, f.input);
  assert.equal(replay.id, session.id);
  assert.ok(replay.output.startsWith("\x1b[?1049h"));
  assert.deepEqual(f.children[0].sizes, [[80, 23], [80, 24]]);
  f.children[0].data("\x1b[?1049l");
  const inline = await f.host.open(f.event, f.input);
  assert.ok(!inline.output.startsWith("\x1b[?1049h"));
  assert.equal(f.children[0].sizes.length, 2);
});

test("snapshots active DEC private modes and clears reset modes", async () => {
  const f = fixture();
  const session = await f.host.open(f.event, f.input);
  f.children[0].data("\x1b[?1049h\x1b[?1000h\x1b[?1006h" + "x".repeat(300000));
  const active = await f.host.open(f.event, f.input);
  assert.equal(active.id, session.id);
  assert.ok(active.output.startsWith("\x1b[?1049h"));
  assert.deepEqual(active.modes, [1000, 1006, 1049]);

  f.children[0].data("\x1b[?1000l");
  const cleared = await f.host.open(f.event, f.input);
  assert.deepEqual(cleared.modes, [1006, 1049]);
  assert.deepEqual(cleared.resetModes, [1000]);
});

test("does not notify for a typed echo before command submission", async () => {
  const f = fixture({ activityCoalesceMs: 5 });
  const session = await f.host.open(f.event, f.input);
  f.host.write(f.event, session.id, "typed");
  f.children[0].data("typed");
  await wait(15);
  assert.equal(f.events.some(([channel]) => channel === "terminal:attention"), false);
  f.host.dispose();
});

test("contains oversized CSI counts without dropping the PTY data event", async () => {
  const f = fixture();
  const session = await f.host.open(f.event, f.input);
  assert.doesNotThrow(() => f.children[0].data("\x1b[200000@safe"));
  assert.equal(f.events.at(-1)?.[0], "terminal:data");
  assert.equal((await f.host.read(f.event, session.id)).seq, 1);
  f.host.dispose();
});

test("exposes the ANSI parser as a stateful split-stream fixture", () => {
  const parser = createTerminalOutputParser();
  assert.deepEqual(parser.consume("\x1b]0;title"), { text: "", bell: false });
  assert.deepEqual(parser.consume("\x07answer"), { text: "answer", bell: false });
  assert.deepEqual(parser.consume("\x07"), { text: "", bell: true });
  assert.deepEqual(parser.consume("\x1b]0;split"), { text: "", bell: false });
  assert.deepEqual(parser.consume("\x1b"), { text: "", bell: false });
  assert.deepEqual(parser.consume("\\response"), { text: "response", bell: false });
});

test("treats pane output forwarded through the owning PTY as provider-neutral activity", async () => {
  const f = fixture({ activityCoalesceMs: 5 });
  const session = await f.host.open(f.event, f.input);
  f.host.write(f.event, session.id, "tmux -CC\r");
  f.children[0].data("%output %1 pane response\r\n");
  await wait(15);
  assert.deepEqual(f.events.filter(([channel]) => channel === "terminal:attention").map(([, value]) => value), [
    { id: session.id, botId: "bot-1", reason: "activity" },
  ]);
  f.host.dispose();
});

test("returns the replacement before the old worker shutdown acknowledgement", async () => {
  let releaseKill;
  const killAck = new Promise((resolve) => { releaseKill = resolve; });
  // open stats the folder on the libuv threadpool before it spawns, so a fixed
  // count of event-loop turns can run out first; wait for the spawn itself
  let secondSpawned;
  const replacementSpawned = new Promise((resolve) => { secondSpawned = resolve; });
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
      if (children.length === 2) secondSpawned();
      return child;
    } }),
  });
  const first = await host.open(event, { botId: "shutdown-ack", cols: 80, rows: 24 });
  let settled = false;
  const replacement = host.open(event, { botId: "shutdown-ack", cols: 80, rows: 24, restart: true }).finally(() => { settled = true; });
  await replacementSpawned;
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(children.length, 2);
  assert.equal(children[0].killed, true);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(settled, true);
  releaseKill();
  const next = await replacement;
  assert.notEqual(next.id, first.id);
});

test("drops delayed output and exit events from a retired session", async () => {
  const f = fixture();
  const first = await f.host.open(f.event, f.input);
  const replacement = await f.host.open(f.event, { ...f.input, restart: true });
  f.events.length = 0;
  f.children[0].data("stale output");
  f.children[0].exit({ exitCode: 7 });
  assert.equal(f.events.some(([channel]) => channel === "terminal:data" || channel === "terminal:exit"), false);
  assert.equal((await f.host.readBot("bot-1")).sessionId, replacement.id);
  assert.notEqual(replacement.id, first.id);
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
    ["terminal:attention", "error"], ["terminal:error", "EBADF"], ["terminal:exit", 1], ["terminal:closed", undefined],
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
    ["terminal:attention", "error"], ["terminal:error", "EBADF"], ["terminal:exit", 1], ["terminal:closed", undefined],
  ]);
  assert.equal(child.killed, true);
});

test("writes X10 mouse reports past column 95 as raw bytes", async () => {
  const f = fixture();
  const session = await f.host.open(f.event, f.input);
  const x10 = `\x1b[M ${String.fromCharCode(132, 133)}`;
  f.host.write(f.event, session.id, x10);
  assert.equal(f.children[0].writes.length, 1);
  const payload = f.children[0].writes[0];
  assert.ok(Buffer.isBuffer(payload), "X10 report must reach the PTY as raw bytes, not a UTF-8 string");
  assert.equal(payload.toString("hex"), Buffer.from(x10, "binary").toString("hex"));
  f.host.dispose();
});

test("X10 mouse reports do not cancel a pending activity timer", async () => {
  const f = fixture({ activityCoalesceMs: 20 });
  const session = await f.host.open(f.event, f.input);
  f.host.write(f.event, session.id, "cmd\r");
  f.children[0].data("working");
  f.host.write(f.event, session.id, `\x1b[M ${String.fromCharCode(132, 133)}`);
  await wait(40);
  const reasons = f.events.filter(([channel]) => channel === "terminal:attention").map(([, value]) => value.reason);
  assert.ok(reasons.includes("activity"), "mouse report cancelled the pending activity timer");
  f.host.dispose();
});

test("X10 mouse reports do not pollute the echo buffer", async () => {
  const f = fixture({ activityCoalesceMs: 10 });
  const session = await f.host.open(f.event, f.input);
  f.host.write(f.event, session.id, "\r");
  f.host.write(f.event, session.id, "\x1b[MXYZ");
  f.children[0].data("XYZ");
  await wait(25);
  const reasons = f.events.filter(([channel]) => channel === "terminal:attention").map(([, value]) => value.reason);
  assert.ok(reasons.includes("activity"), "mouse echo suppressed real output");
  f.host.dispose();
});

test("does not kill a pty before it is ready when open is cancelled", async () => {
  let releaseReady;
  const ready = new Promise((resolve) => { releaseReady = resolve; });
  let spawnedResolve;
  const spawned = new Promise((resolve) => { spawnedResolve = resolve; });
  const events = [];
  const owner = { id: 1, mainFrame: {}, send: (...args) => events.push(args) };
  const event = { sender: owner, senderFrame: owner.mainFrame };
  const child = { onData() {}, onExit() {}, ready, write() {}, resize() {}, killed: false, kill() { this.killed = true; } };
  const host = createTerminalHost({
    authorize() {},
    resolveCwd: async () => os.tmpdir(),
    platform: "linux",
    env: { SHELL: "/bin/sh" },
    loadPty: () => ({ spawn: () => { spawnedResolve(); return child; } }),
  });
  const opening = host.open(event, { botId: "readiness-hold", cols: 80, rows: 24 });
  const cancelled = assert.rejects(opening, /cancelled/);
  await spawned;
  assert.equal(host.cancelOpen(event, "readiness-hold"), true);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(child.killed, false);
  releaseReady();
  await cancelled;
  assert.equal(child.killed, true);
});

test("reopening after a cancelled spawn waits for the first worker to retire", async () => {
  let releaseReady;
  const ready = new Promise((resolve) => { releaseReady = resolve; });
  const children = [];
  const owner = { id: 1, mainFrame: {}, send() {} };
  const event = { sender: owner, senderFrame: owner.mainFrame };
  const host = createTerminalHost({
    authorize() {},
    resolveCwd: async () => os.tmpdir(),
    platform: "linux",
    env: { SHELL: "/bin/sh" },
    loadPty: () => ({ spawn: () => {
      const child = {
        onData() {},
        onExit() {},
        ready: children.length === 0 ? ready : Promise.resolve(),
        write() {},
        resize() {},
        killed: false,
        kill() { this.killed = true; },
      };
      children.push(child);
      return child;
    } }),
  });
  const opening = host.open(event, { botId: "reopen-cancel", cols: 80, rows: 24 });
  const cancelled = assert.rejects(opening, /cancelled/);
  while (children.length === 0) await new Promise((resolve) => setImmediate(resolve));
  assert.equal(host.cancelOpen(event, "reopen-cancel"), true);
  const reopening = host.open(event, { botId: "reopen-cancel", cols: 80, rows: 24 });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(children.length, 1);
  assert.equal(children[0].killed, false);
  releaseReady();
  await cancelled;
  const session = await reopening;
  assert.equal(children.length, 2);
  assert.equal(children[0].killed, true);
  assert.equal(children[1].killed, false);
  assert.ok(session.id);
});

test("openForBot spawns a labeled pane in the bot folder and submits its command", async () => {
  let owner;
  const f = fixture({ owner: () => owner });
  owner = f.owner;
  const pane = await f.host.openForBot("bot-1", { label: "Opus 5.5 | high | ORCH", command: "claude" });
  assert.equal(pane.generation, 1);
  assert.equal(f.children.length, 1);
  assert.deepEqual(f.children[0].writes, ["claude\r"]);
  assert.deepEqual(f.events.find(([channel]) => channel === "terminal:opened"), ["terminal:opened", { id: pane.sessionId, botId: "bot-1", label: "Opus 5.5 | high | ORCH", generation: 1 }]);
  const attached = await f.host.open(f.event, { ...f.input, sessionId: pane.sessionId });
  assert.equal(attached.id, pane.sessionId);
  assert.equal(attached.label, "Opus 5.5 | high | ORCH");
  assert.equal(attached.cwd, os.tmpdir());
});

test("readBot lists every pane and sendBot targets a pane by session id", async () => {
  let owner;
  const f = fixture({ owner: () => owner });
  owner = f.owner;
  const main = await f.host.open(f.event, f.input);
  const pane = await f.host.openForBot("bot-1", { label: "worker" });
  const read = f.host.readBot("bot-1");
  assert.equal(read.sessionId, main.id);
  assert.deepEqual(read.panes.map(({ sessionId, label, main: isMain }) => [sessionId, label, isMain]), [[main.id, null, true], [pane.sessionId, "worker", false]]);
  f.children[1].data("Fermenting…");
  assert.deepEqual(f.host.readBot("bot-1").panes.map((entry) => entry.screenText.trim()), ["", "Fermenting…"]);
  assert.equal(f.host.readBot("bot-1", { sessionId: pane.sessionId }).label, "worker");
  assert.throws(() => f.host.readBot("bot-1", { sessionId: "missing" }), /Unknown terminal/);
  // sendBot keeps its existing "stale" wording for an unresolved id (see the restart case below).
  assert.throws(() => f.host.sendBot("bot-1", { sessionId: "missingmissing", generation: 1, text: "x" }), /stale/);
  f.host.sendBot("bot-1", { sessionId: pane.sessionId, generation: pane.generation, text: "ls\r" });
  assert.deepEqual(f.children[1].writes, ["ls\r"]);
  assert.deepEqual(f.children[0].writes, []);
});

test("panes-only reads return pane metadata without screen text", async (t) => {
  let owner;
  const f = fixture({ owner: () => owner, now: () => 42 });
  owner = f.owner;
  t.after(() => f.host.dispose());
  await f.host.open(f.event, f.input);
  await f.host.openForBot("bot-1", { label: "worker" });
  f.children[0].data("main output\r\n");
  f.children[1].data("worker output\r\n");
  const full = f.host.readBot("bot-1");
  assert.match(full.screenText, /main output/);
  assert.ok(full.screenRuns.length > 0);
  assert.equal(typeof full.recentText, "string");
  assert.deepEqual(f.host.readBot("bot-1", { panesOnly: true }), {
    botId: "bot-1",
    capturedAt: 42,
    panes: full.panes.map(({ screenText: _screenText, ...pane }) => pane),
    closedPanes: [],
  });
});

test("panes-only reads keep the no-terminal state without screen fields", () => {
  const f = fixture({ now: () => 42 });
  assert.deepEqual(f.host.readBot("bot-1", { panesOnly: true }), {
    botId: "bot-1", state: "no-terminal", capturedAt: 42, panes: [], closedPanes: [],
  });
  assert.equal(f.host.readBot("bot-1").screenText, "");
  assert.equal(f.host.readBot("bot-1").recentText, "");
});

test("paneLabels lists each bot's open worker panes, not main terminals or exited panes", async () => {
  let owner;
  const f = fixture({ owner: () => owner });
  owner = f.owner;
  await f.host.open(f.event, f.input);
  const first = await f.host.openForBot("bot-1", { label: "w1" });
  await f.host.openForBot("bot-1", { label: "w2" });
  await f.host.openForBot("bot-2", { label: "other" });
  assert.deepEqual(f.host.paneLabels(), { "bot-1": ["w1", "w2"], "bot-2": ["other"] });
  f.children[3].exit({ exitCode: 0 });
  assert.deepEqual(f.host.paneLabels(), { "bot-1": ["w1", "w2"] });
  await f.host.close(f.event, first.sessionId);
  assert.deepEqual(f.host.paneLabels(), { "bot-1": ["w2"] });
});

test("liveWorkerCount counts open worker panes, not main terminals or exited panes", async () => {
  let owner;
  const f = fixture({ owner: () => owner });
  owner = f.owner;
  assert.equal(f.host.liveWorkerCount(), 0);
  await f.host.open(f.event, f.input);
  assert.equal(f.host.liveWorkerCount(), 0);
  const first = await f.host.openForBot("bot-1", { label: "w1" });
  await f.host.openForBot("bot-2", { label: "w2" });
  assert.equal(f.host.liveWorkerCount(), 2);
  f.children[2].exit({ exitCode: 0 });
  assert.equal(f.host.liveWorkerCount(), 1);
  await f.host.close(f.event, first.sessionId);
  assert.equal(f.host.liveWorkerCount(), 0);
});

test("only bot-spawned panes turn off Claude prompt suggestions", async () => {
  let owner;
  const f = fixture({ owner: () => owner });
  owner = f.owner;
  await f.host.open(f.event, f.input);
  await f.host.openForBot("bot-1", { label: "worker" });
  assert.equal(f.children[0].options.env.CLAUDE_CODE_ENABLE_PROMPT_SUGGESTION, undefined);
  assert.equal(f.children[1].options.env.CLAUDE_CODE_ENABLE_PROMPT_SUGGESTION, "false");
});

test("openForBot caps live panes per bot and rejects bad input", async () => {
  let owner;
  const f = fixture({ owner: () => owner });
  await assert.rejects(f.host.openForBot("bot-1", { label: "x" }), /window is not available/);
  owner = f.owner;
  for (let i = 0; i < 16; i += 1) await f.host.openForBot("bot-1", { label: `w${i}` });
  await assert.rejects(f.host.openForBot("bot-1", { label: "w16" }), /Too many bot terminals \(limit 16\)/);
  await f.host.openForBot("bot-2", { label: "other" });
  await assert.rejects(f.host.openForBot("bot/1", { label: "x" }), /Invalid bot/);
  await assert.rejects(f.host.openForBot("bot-2", { command: "stop\x03" }), /Invalid terminal command/);
  await assert.rejects(f.host.openForBot("bot-2", { label: 7 }), /Invalid terminal label/);
  await assert.rejects(f.host.openForBot("bot-2", { cwd: "relative/dir" }), /unavailable/);
});

test("a pane is reachable only from its own bot and closes on request", async () => {
  let owner;
  const f = fixture({ owner: () => owner });
  owner = f.owner;
  const pane = await f.host.openForBot("bot-1", { label: "worker" });
  await assert.rejects(f.host.open(f.event, { botId: "bot-2", cols: 80, rows: 24, sessionId: pane.sessionId }), /Unknown terminal/);
  assert.throws(() => f.host.sendBot("bot-2", { sessionId: pane.sessionId, generation: 1, text: "x" }), /No active terminal/);
  assert.equal(f.host.readBot("bot-1").label, "worker");
  await f.host.close(f.event, pane.sessionId);
  assert.equal(f.children[0].killed, true);
  assert.equal(f.host.readBot("bot-1").state, "no-terminal");
  const main = await f.host.open(f.event, f.input);
  assert.throws(() => f.host.close(f.event, main.id), /Only bot terminals/);
});

test("attaching a pane ignores restart and preserves its command, label and output", async () => {
  let owner;
  const f = fixture({ owner: () => owner });
  owner = f.owner;
  const pane = await f.host.openForBot("bot-1", { label: "worker", command: "worker-cli" });
  f.children[0].data("working");
  for (const exitCode of [null, 0]) {
    if (exitCode !== null) f.children[0].exit({ exitCode });
    const attached = await f.host.open(f.event, { ...f.input, sessionId: pane.sessionId, restart: true });
    assert.equal(attached.id, pane.sessionId);
    assert.equal(attached.label, "worker");
    assert.equal(attached.output, "working");
    assert.equal(attached.exitCode, exitCode);
    assert.equal(f.children.length, 1);
    assert.equal(f.children[0].killed, false);
    assert.deepEqual(f.children[0].writes, ["worker-cli\r"]);
  }
});

test("closing a pane emits one removal and ignores subsequent output and exit", async () => {
  let owner;
  const f = fixture({ owner: () => owner });
  owner = f.owner;
  const pane = await f.host.openForBot("bot-1", { label: "worker" });
  f.children[0].data("working");
  await f.host.close(f.event, pane.sessionId);
  const before = f.events.length;
  f.children[0].data("late");
  f.children[0].exit({ exitCode: 0 });
  assert.equal(f.events.length, before);
  assert.deepEqual(f.events.filter(([channel]) => channel === "terminal:closed"), [["terminal:closed", { id: pane.sessionId, botId: "bot-1" }]]);
  assert.deepEqual(f.host.readBot("bot-1").panes, []);
});

test("closeForBot retires a bot pane, frees its slot and refuses main or foreign panes", async () => {
  let owner;
  const f = fixture({ owner: () => owner });
  owner = f.owner;
  const main = await f.host.open(f.event, f.input);
  const panes = [];
  for (let i = 0; i < 16; i += 1) panes.push(await f.host.openForBot("bot-1", { label: `w${i}` }));
  await assert.rejects(f.host.openForBot("bot-1", { label: "w16" }), /Too many bot terminals/);
  const other = await f.host.openForBot("bot-2", { label: "other" });
  assert.throws(() => f.host.closeForBot("bot-1", other.sessionId), /Unknown terminal/);
  assert.throws(() => f.host.closeForBot("bot-1", main.id), /Only bot terminals/);
  const closed = await f.host.closeForBot("bot-1", panes[0].sessionId);
  assert.deepEqual(closed, { alreadyClosed: false });
  assert.deepEqual(f.events.find(([channel, value]) => channel === "terminal:closed" && value.id === panes[0].sessionId), ["terminal:closed", { id: panes[0].sessionId, botId: "bot-1" }]);
  assert.equal(f.children[1].killed, true);
  await f.host.openForBot("bot-1", { label: "w8" });
});

test("closeForBot on an already-closed pane succeeds instead of erroring", async () => {
  let owner;
  const f = fixture({ owner: () => owner });
  owner = f.owner;
  const pane = await f.host.openForBot("bot-1", { label: "worker" });
  await f.host.closeForBot("bot-1", pane.sessionId);
  const again = await f.host.closeForBot("bot-1", pane.sessionId);
  assert.deepEqual(again, { alreadyClosed: true });
  // A foreign bot's id is never in this bot's closed history, so it still refuses.
  assert.throws(() => f.host.closeForBot("bot-2", pane.sessionId), /Unknown terminal/);
  // A prefix of an already-closed pane also reports already closed.
  const alsoAgain = await f.host.closeForBot("bot-1", pane.sessionId.slice(0, 8));
  assert.deepEqual(alsoAgain, { alreadyClosed: true });
});

test("readBot lists panes the bot closed itself, never ones the user closed", async () => {
  let owner;
  const f = fixture({ owner: () => owner });
  owner = f.owner;
  const byBot = await f.host.openForBot("bot-1", { label: "w1" });
  const byUser = await f.host.openForBot("bot-1", { label: "w2" });
  const open = await f.host.openForBot("bot-1", { label: "w3" });
  await f.host.closeForBot("bot-1", byBot.sessionId);
  await f.host.close(f.event, byUser.sessionId);
  assert.deepEqual(f.host.readBot("bot-1").closedPanes, [byBot.sessionId]);
  await f.host.closeForBot("bot-1", open.sessionId);
  assert.equal(f.host.readBot("bot-1").state, "no-terminal");
  assert.deepEqual(f.host.readBot("bot-1").closedPanes, [byBot.sessionId, open.sessionId]);
  assert.deepEqual(f.host.readBot("bot-2").closedPanes, []);
});

test("terminal_read, terminal_send and terminal_close accept a unique pane id prefix", async () => {
  let owner;
  const f = fixture({ owner: () => owner });
  owner = f.owner;
  const one = await f.host.openForBot("bot-1", { label: "one" });
  const prefix = one.sessionId.slice(0, 8);
  assert.equal(f.host.readBot("bot-1", { sessionId: prefix }).sessionId, one.sessionId);
  f.host.sendBot("bot-1", { sessionId: prefix, generation: one.generation, text: "ls\r" });
  assert.deepEqual(f.children[0].writes, ["ls\r"]);
  await f.host.closeForBot("bot-1", prefix);
  assert.equal(f.children[0].killed, true);
});

test("resolveBotSession matches a unique prefix, refuses ambiguous or too-short prefixes", () => {
  const live = [{ id: "abcdef123456" }, { id: "abcdef129999" }, { id: "112233445566" }];
  assert.equal(resolveBotSession(live, "112233445566").session, live[2]);
  assert.equal(resolveBotSession(live, "1122334455").session, live[2]);
  assert.equal(resolveBotSession(live, "abcdef123456").session, live[0]);
  assert.deepEqual(resolveBotSession(live, "abcdef12"), { ambiguous: true });
  assert.deepEqual(resolveBotSession(live, "abcdef1"), {});
  assert.deepEqual(resolveBotSession(live, "zzzzzzzz"), {});
});

test("a pane id prefix never matches another bot's pane", async () => {
  let owner;
  const f = fixture({ owner: () => owner });
  owner = f.owner;
  const one = await f.host.openForBot("bot-1", { label: "one" });
  await f.host.openForBot("bot-2", { label: "foreign" });
  assert.throws(() => f.host.readBot("bot-2", { sessionId: one.sessionId.slice(0, 8) }), /Unknown terminal/);
  assert.throws(() => f.host.closeForBot("bot-2", one.sessionId.slice(0, 8)), /Unknown terminal/);
  // sendBot never resolves another bot's pane either; it just keeps its own not-found wording.
  assert.throws(() => f.host.sendBot("bot-2", { sessionId: one.sessionId.slice(0, 8), generation: 1, text: "x" }), /stale/);
});

test("readBot's waitFor returns as soon as the text appears on screen", async () => {
  let owner;
  const f = fixture({ owner: () => owner });
  owner = f.owner;
  const pane = await f.host.openForBot("bot-1", { label: "worker" });
  const waiting = f.host.readBot("bot-1", { sessionId: pane.sessionId, waitFor: "ready>", timeoutMs: 5000 });
  assert.ok(waiting instanceof Promise);
  await wait(20);
  f.children[0].data("booting\r\nready> ");
  const result = await waiting;
  assert.equal(result.waited, "hit");
  assert.match(result.screenText, /ready>/);
});

test("readBot's waitFor times out with the current screen when the text never appears", async () => {
  let owner;
  const f = fixture({ owner: () => owner });
  owner = f.owner;
  const pane = await f.host.openForBot("bot-1", { label: "worker" });
  f.children[0].data("still booting");
  const result = await f.host.readBot("bot-1", { sessionId: pane.sessionId, waitFor: "ready>", timeoutMs: 150 });
  assert.equal(result.waited, "timeout");
  assert.match(result.screenText, /still booting/);
});

test("readBot without waitFor returns a plain snapshot, not a promise", async () => {
  let owner;
  const f = fixture({ owner: () => owner });
  owner = f.owner;
  const pane = await f.host.openForBot("bot-1", { label: "worker" });
  const result = f.host.readBot("bot-1", { sessionId: pane.sessionId });
  assert.ok(!(result instanceof Promise));
  assert.equal(result.sessionId, pane.sessionId);
});

test("openForBot reserves pane slots before resolving the folder", async () => {
  let owner;
  let release;
  const held = new Promise((resolve) => { release = () => resolve(os.tmpdir()); });
  const f = fixture({ owner: () => owner, resolveCwd: () => held });
  owner = f.owner;
  const one = Promise.allSettled(Array.from({ length: 24 }, (_, i) => f.host.openForBot("bot-1", { label: `w${i}` })));
  release();
  const perBot = await one;
  assert.equal(perBot.filter((result) => result.status === "fulfilled").length, 16);
  assert.ok(perBot.filter((result) => result.status === "rejected").every((result) => /Too many bot terminals/.test(result.reason.message)));
  assert.equal(f.children.length, 16);
});

test("40 bot panes across 3 bots and the user's terminals all open with 64 GB free", async () => {
  let owner;
  const f = fixture({ owner: () => owner, freeMemory: () => 64 * 1024 ** 3 });
  owner = f.owner;
  await f.host.open(f.event, f.input);
  for (const [botId, count] of [["bot-1", 14], ["bot-2", 13], ["bot-3", 13]]) {
    for (let i = 0; i < count; i += 1) await f.host.openForBot(botId, { label: `w${i}` });
  }
  await f.host.open(f.event, { ...f.input, botId: "bot-4" });
  assert.equal(f.host.liveWorkerCount(), 40);
  assert.equal(f.children.length, 42);
});

test("openForBot refuses a pane under its engine floor, but main terminals stay ungated", async () => {
  let owner;
  let free = 100 * 1024 ** 2 - 1;
  const f = fixture({ owner: () => owner, freeMemory: () => free });
  owner = f.owner;
  await assert.rejects(f.host.openForBot("bot-1", { label: "w" }), /Not enough free memory for another terminal \(0\.1 GB free, 0\.1 GB needed\)\. Close a finished pane with terminal_close/);
  await f.host.open(f.event, f.input);
  await assert.rejects(f.host.openForBot("bot-1", { label: "w" }), /needed\)\. Open: main 1\. Close a finished pane/);
  free = 100 * 1024 ** 2;
  await f.host.openForBot("bot-1", { label: "w" });
});

test("a refused pane names each bot holding terminals, then the main ones", async () => {
  let owner;
  let free = 8 * 1024 ** 3;
  let names = { "bot-1": "Pokkey", "bot-2": "Wink" };
  let lookups = 0;
  const f = fixture({ owner: () => owner, freeMemory: () => free, botNames: async () => { lookups += 1; if (!names) throw new Error("server down"); return names; } });
  owner = f.owner;
  await f.host.open(f.event, f.input);
  for (const [botId, label] of [["bot-2", "w1"], ["bot-1", "w1"], ["bot-1", "w2"], ["bot-3", "w1"], ["bot-2", "done"]]) await f.host.openForBot(botId, { label });
  f.children.at(-1).exit({ exitCode: 0 });
  assert.equal(lookups, 0);
  free = 0.5 * 1024 ** 3;
  const claude = { label: "w2", command: "claude --model opus 'hi'" };
  await assert.rejects(f.host.openForBot("bot-2", claude), /\(0\.5 GB free, 0\.6 GB needed\)\. Open: Pokkey 2, Wink 1, bot-3 1, main 1\. Close a finished pane with terminal_close\./);
  names = null;
  await assert.rejects(f.host.openForBot("bot-2", claude), /Open: bot-1 2, bot-2 1, bot-3 1, main 1\./);
  assert.equal(lookups, 2);
});

test("worker panes drop to below-normal priority, main terminals stay normal, and a refusal never fails the spawn", async () => {
  let owner;
  const calls = [];
  let refuse = false;
  const f = fixture({ owner: () => owner, setPriority: (...args) => { calls.push(args); if (refuse) throw new Error("EACCES"); } });
  owner = f.owner;
  await f.host.open(f.event, f.input);
  await f.host.openForBot("bot-1", { label: "w1" });
  refuse = true;
  await f.host.openForBot("bot-1", { label: "w2" });
  assert.deepEqual(calls, [[102, os.constants.priority.PRIORITY_BELOW_NORMAL], [103, os.constants.priority.PRIORITY_BELOW_NORMAL]]);
});

test("a pane opens exactly when free memory covers its own floor, as in 1.0.208", async () => {
  let owner;
  let free = 0;
  const f = fixture({ owner: () => owner, freeMemory: () => free });
  owner = f.owner;
  let cases = 0;
  for (const [command, floor] of [["claude --model opus 'hi'", 600], ["codex --model gpt-5 'hi'", 150], ["muse 'hi'", 150], ["grok -m g1 'hi'", 300], [undefined, 100]]) {
    for (let tenths = 1; tenths <= 30; tenths += 1) {
      free = tenths / 10 * 1024 ** 3;
      const open = f.host.openForBot(`bot-${cases}`, { label: "w", command });
      cases += 1;
      if (free >= floor * 1024 ** 2) assert.ok((await open).sessionId, `${command} at ${tenths / 10} GB`);
      else await assert.rejects(open, /Not enough free memory/, `${command} at ${tenths / 10} GB`);
    }
  }
  assert.equal(cases, 150);
});

test("a claude pane opens with 0.7 GB free on an 8 GB PC", async () => {
  let owner;
  const f = fixture({ owner: () => owner, freeMemory: () => 0.7 * 1024 ** 3 });
  owner = f.owner;
  assert.ok((await f.host.openForBot("bot-1", { label: "worker", command: "claude --model opus 'hi'" })).sessionId);
});

test("the gate reads the engine past $env prefixes, paths and extensions", async () => {
  let owner;
  let free = 0.35 * 1024 ** 3;
  const f = fixture({ owner: () => owner, freeMemory: () => free });
  owner = f.owner;
  const agy = await f.host.openForBot("bot-1", { label: "a", command: "$env:AGY_CLI_DISABLE_AUTO_UPDATE='true'; agy --model gemini-4-argon-high -i 'hi'" });
  assert.ok(agy.sessionId);
  await assert.rejects(f.host.openForBot("bot-1", { label: "c", command: "C:\\tools\\Claude.EXE --model opus 'hi'" }), /0\.6 GB needed/);
  free = 0.2 * 1024 ** 3;
  await assert.rejects(f.host.openForBot("bot-1", { label: "g", command: "grok -m g1 --effort high 'hi'" }), /0\.3 GB needed/);
  await assert.rejects(f.host.openForBot("bot-1", { label: "e", command: "echo ok" }), /0\.3 GB needed/);
});

test("the gate reads a quoted engine path with spaces", async () => {
  let owner;
  const f = fixture({ owner: () => owner, freeMemory: () => 0.35 * 1024 ** 3 });
  owner = f.owner;
  await assert.rejects(f.host.openForBot("bot-1", { label: "c", command: "& \"C:\\Program Files\\Claude\\claude.exe\" --model opus 'hi'" }), /0\.6 GB needed/);
  await assert.rejects(f.host.openForBot("bot-1", { label: "s", command: "'C:\\My Tools\\claude.cmd' --model opus 'hi'" }), /0\.6 GB needed/);
});

test("a burst of claude panes at 2 GB free opens every pane up to the per-bot cap", async () => {
  let owner;
  const f = fixture({ owner: () => owner, freeMemory: () => 2 * 1024 ** 3 });
  owner = f.owner;
  const results = await Promise.allSettled(Array.from({ length: 18 }, (_, i) => f.host.openForBot("bot-1", { label: `w${i}`, command: "claude --model opus 'hi'" })));
  assert.deepEqual(results.map((result) => result.status), [...Array(16).fill("fulfilled"), "rejected", "rejected"]);
  assert.ok(results.slice(16).every((result) => /Too many bot terminals/.test(result.reason.message)));
});

test("a failed pane open releases its per-bot slot", async () => {
  let owner;
  const f = fixture({ owner: () => owner });
  owner = f.owner;
  const failed = f.host.openForBot("bot-1", { label: "w", cwd: path.join(os.tmpdir(), "wink-missing-folder") });
  const results = await Promise.allSettled([failed, ...Array.from({ length: 16 }, () => f.host.openForBot("bot-1", { label: "w" }))]);
  assert.deepEqual(results.map((result) => result.status), ["rejected", ...Array(15).fill("fulfilled"), "rejected"]);
  assert.match(results[0].reason.message, /Terminal folder is unavailable/);
  assert.match(results[16].reason.message, /Too many bot terminals/);
  assert.ok((await f.host.openForBot("bot-1", { label: "w" })).sessionId);
  await assert.rejects(f.host.openForBot("bot-1", { label: "w" }), /Too many bot terminals/);
});

test("openForBot submits a command with exactly one Enter", async () => {
  let owner;
  const f = fixture({ owner: () => owner });
  owner = f.owner;
  for (const command of ["echo ok", "echo ok\n", "echo ok\r\n", "echo ok\r"]) await f.host.openForBot("bot-1", { command });
  assert.deepEqual(f.children.map((child) => child.writes), [["echo ok\r"], ["echo ok\r"], ["echo ok\r"], ["echo ok\r"]]);
});

test("a pane the bot spawned never raises the user's terminal alert", async () => {
  let owner;
  const f = fixture({ owner: () => owner, activityCoalesceMs: 5, attentionCooldownMs: 0 });
  owner = f.owner;
  const pane = await f.host.openForBot("bot-1", { label: "worker", command: "claude" });
  f.children[0].data("working\x07");
  await wait(15);
  assert.equal(f.host.attendBot("bot-1", pane.sessionId), false);
  f.children[0].exit({ exitCode: 1 });
  assert.equal(f.events.some(([channel]) => channel === "terminal:attention"), false);
  f.host.dispose();
});

test("a mailbox note still raises the alert on the user's own terminal", async () => {
  let owner;
  const f = fixture({ owner: () => owner, attentionCooldownMs: 0 });
  owner = f.owner;
  const main = await f.host.open(f.event, f.input);
  const attention = () => f.events.filter(([channel]) => channel === "terminal:attention").map(([, value]) => value);
  assert.equal(f.host.attendBot("bot-2", main.id), false);
  assert.equal(f.host.attendBot("bot-1", main.id), true);
  assert.deepEqual(attention(), [{ id: main.id, botId: "bot-1", reason: "activity" }]);
  f.host.acknowledge(f.event, main.id);
  f.children[0].exit({ exitCode: 0 });
  f.host.acknowledge(f.event, main.id);
  assert.equal(f.host.attendBot("bot-1", main.id), false);
  assert.equal(attention().length, 2);
  f.host.dispose();
});

test("exited panes do not hold global slots and reclaiming them emits terminal:closed", async () => {
  let owner;
  const f = fixture({ owner: () => owner });
  owner = f.owner;
  const exited = [];
  for (let i = 0; i < 32; i += 1) {
    exited.push((await f.host.openForBot("bot-1", {})).sessionId);
    f.children[i].exit({ exitCode: 0 });
  }
  const next = await f.host.openForBot("bot-1", {});
  assert.ok(next.sessionId);
  const closed = f.events.filter(([channel]) => channel === "terminal:closed").map(([, value]) => value);
  assert.deepEqual(closed, exited.map((id) => ({ id, botId: "bot-1" })));
  await assert.rejects(f.host.open(f.event, { ...f.input, sessionId: exited[0] }), /Unknown terminal/);
});

function stallFixture({ failures = 0, commandEcho = true, shellIntegration = false, ...options } = {}) {
  let owner;
  let clock = Date.UTC(2026, 9, 4);
  let failing = failures;
  const notes = [];
  const f = fixture({
    owner: () => owner,
    mailbox: async () => ({ url: "http://127.0.0.1:9", token: "secret" }),
    notePane: async (mail, scope, text) => {
      if (failing-- > 0) throw new Error("connect ECONNREFUSED 127.0.0.1:9");
      notes.push({ mail, scope, text });
    },
    stallCheckMs: 5,
    now: () => clock,
    ...options,
  });
  owner = f.owner;
  const openForBot = f.host.openForBot.bind(f.host);
  f.host.openForBot = async (botId, input = {}) => {
    const pane = await openForBot(botId, input);
    if (shellIntegration) {
      const child = f.children.find((child) => child.options.env.ORBIT_PANE === pane.sessionId);
      child.data(finishedMark(pane, 0));
      if (input.command) child.data(startedMark(pane, input.command.split(/\r?\n|\r/)[0]));
    }
    if (commandEcho && input.command) {
      f.children.find((child) => child.options.env.ORBIT_PANE === pane.sessionId).data(`${input.command}\r\n`);
    }
    return pane;
  };
  // Lets the stall check sample the screen before the clock moves.
  const settle = () => wait(25);
  const advance = async (ms) => { clock += ms; await settle(); };
  return { ...f, notes, settle, advance };
}

// Recorded from Claude Code 2.1.306 in a fresh folder; No is selected.
const CLAUDE_FOLDER_TRUST = "\x1b[1t\x1b[c\x1b[?1004h\x1b[?9001h\x1b]0;claude\x1b\\\x1b7\x1b[r\x1b8\x1b[?25h\x1b[?25l\x1b[?2004h\x1b[?2031h\x1b[?1004h\x1b[?9001l\x1b[?9001h\r\n────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────\r\n\x1b[2GAccessing\x1b[12Gworkspace:\r\n\r\n\x1b[2GC:\\Users\\tester\\AppData\\Local\\Temp\\wink-WORKER-TRUST-MENU\\fresh-iieFbG\r\n\r\n\x1b[2GQuick\x1b[8Gsafety\x1b[15Gcheck:\x1b[22GIs\x1b[25Gthis\x1b[30Ga\x1b[32Gproject\x1b[40Gyou\x1b[44Gcreated\x1b[52Gor\x1b[55Gone\x1b[59Gyou\x1b[63Gtrust?\x1b[70G(Like\x1b[76Gyour\x1b[81Gown\x1b[85Gcode,\x1b[91Ga\x1b[93Gwell-known\x1b[104Gopen\x1b[109Gsource\r\n\x1b[2Gproject,\x1b[11Gor\x1b[14Gwork\x1b[19Gfrom\x1b[24Gyour\x1b[29Gteam).\x1b[36GIf\x1b[39Gnot,\x1b[44Gtake\x1b[49Ga\x1b[51Gmoment\x1b[58Gto\x1b[61Greview\x1b[68Gwhat's\x1b[75Gin\x1b[78Gthis\x1b[83Gfolder\x1b[90Gfirst.\r\n\r\n\x1b[2GClaude\x1b[9GCode'll\x1b[17Gbe\x1b[20Gable\x1b[25Gto\x1b[28Gread,\x1b[34Gedit,\x1b[40Gand\x1b[44Gexecute\x1b[52Gfiles\x1b[58Ghere.\r\n\r\n\x1b[2GSecurity\x1b[11Gguide\r\n\r\n\x1b[2G>\x1b[4GNo,\x1b[8Gexit\r\n\x1b[4GYes,\x1b[9GI\x1b[11Gtrust\x1b[17Gthis\x1b[22Gfolder\r\n\r\n\x1b[2GEnter\x1b[8Gto\x1b[11Gconfirm\x1b[19G·\x1b[21GEsc\x1b[25Gto\x1b[28Gcancel\r\n\x1b[1C\x1b[4A\x1b[>0q\x1b[?u\x1b]7501;?\x07\x1b[c";
const CLAUDE_FOLDER_TRUST_YES = "\n────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────\n Accessing workspace:\n\n C:\\Users\\tester\\AppData\\Local\\Temp\\wink-WORKER-TRUST-MENU\\fresh-iieFbG\n\n Quick safety check: Is this a project you created or one you trust? (Like your own code, a well-known open source\n project, or work from your team). If not, take a moment to review what's in this folder first.\n\n Claude Code'll be able to read, edit, and execute files here.\n\n Security guide\n\n   No, exit\n > Yes, I trust this folder\n\n Enter to confirm · Esc to cancel";
const CLAUDE_TRUST_COMMAND = "claude --model opus --dangerously-skip-permissions 'Read card.md and do it.'";

function trustFixture(t, options = {}) {
  t.mock.timers.enable({ apis: ["Date", "setTimeout", "setInterval"], now: Date.UTC(2026, 9, 24) });
  const f = stallFixture({ stallCheckMs: 10_000, now: () => Date.now(), ...options });
  const advance = async (ms) => { t.mock.timers.tick(ms); await Promise.resolve(); };
  return { ...f, settle: () => advance(500), advance };
}

test("Claude folder trust waits for the recorded startup redraw to settle", async (t) => {
  t.mock.timers.enable({ apis: ["Date", "setTimeout", "setInterval"], now: Date.UTC(2026, 9, 24) });
  const recorded = JSON.parse(fs.readFileSync(new URL("./terminal-host.trust.fixture.json", import.meta.url), "utf8"));
  const f = stallFixture({ commandEcho: false, stallCheckMs: 10_000, now: () => Date.now() });
  t.after(() => f.host.dispose());
  await f.host.openForBot("bot-1", { command: CLAUDE_TRUST_COMMAND });
  const child = f.children[0];
  let elapsed = 0;
  for (const entry of recorded.redraw) {
    t.mock.timers.tick(entry.t - elapsed);
    elapsed = entry.t;
    child.data(entry.data);
    await Promise.resolve();
    assert.deepEqual(child.writes, [CLAUDE_TRUST_COMMAND + "\r"]);
  }
  t.mock.timers.tick(499);
  await Promise.resolve();
  assert.equal(child.writes.length, 1);
  t.mock.timers.tick(1);
  await Promise.resolve();
  assert.deepEqual(child.writes, [CLAUDE_TRUST_COMMAND + "\r", "\x1b[B"]);
  child.data(recorded.redraw.find((entry) => entry.data.includes("1B>")).data);
  await Promise.resolve();
  assert.equal(child.writes.length, 2);
  t.mock.timers.tick(500);
  await Promise.resolve();
  assert.deepEqual(child.writes, [CLAUDE_TRUST_COMMAND + "\r", "\x1b[B", "\r"]);
  for (const entry of recorded.redraw) child.data(entry.data);
  t.mock.timers.tick(1_000);
  await Promise.resolve();
  assert.equal(child.writes.length, 3);
});

test("Claude folder trust never confirms a transient Yes selection", async (t) => {
  const recorded = JSON.parse(fs.readFileSync(new URL("./terminal-host.trust.fixture.json", import.meta.url), "utf8"));
  const f = trustFixture(t, { commandEcho: false });
  t.after(() => f.host.dispose());
  await f.host.openForBot("bot-1", { command: CLAUDE_TRUST_COMMAND });
  const child = f.children[0];
  child.data(recorded.redraw[0].data);
  await f.settle();
  child.data(recorded.redraw.find((entry) => entry.data.includes("1B>")).data);
  await f.advance(165);
  child.data(recorded.redraw.at(-1).data);
  await f.advance(1_000);
  assert.deepEqual(child.writes, [CLAUDE_TRUST_COMMAND + "\r", "\x1b[B"]);
});

for (const action of ["busy", "exit", "close", "relaunch"]) {
  test(`Claude folder trust drops pending keys on ${action}`, async (t) => {
    const f = trustFixture(t, { commandEcho: false });
    t.after(() => f.host.dispose());
    const pane = await f.host.openForBot("bot-1", { command: CLAUDE_TRUST_COMMAND });
    const child = f.children[0];
    child.data(CLAUDE_FOLDER_TRUST);
    if (action === "busy") child.data("✻ Reading card… (3s · esc to interrupt)\r\n");
    if (action === "exit") child.exit({ exitCode: 0 });
    if (action === "close") await f.host.closeBotPanes("bot-1");
    if (action === "relaunch") f.host.sendBot("bot-1", { sessionId: pane.sessionId, generation: pane.generation, text: "codex\r" });
    await f.advance(1_000);
    assert.deepEqual(child.writes, action === "relaunch" ? [CLAUDE_TRUST_COMMAND + "\r", "codex\r"] : [CLAUDE_TRUST_COMMAND + "\r"]);
  });
}

test("Claude folder trust answers screen updates within 1.5 seconds without a stall tick", async (t) => {
  t.mock.timers.enable({ apis: ["Date", "setTimeout", "setInterval"], now: Date.UTC(2026, 9, 21) });
  const f = stallFixture({ commandEcho: false, stallCheckMs: 10_000, now: () => Date.now() });
  t.after(() => f.host.dispose());
  await f.host.openForBot("bot-1", { command: CLAUDE_TRUST_COMMAND });
  const child = f.children[0];
  const started = Date.now();
  child.data(CLAUDE_FOLDER_TRUST);
  t.mock.timers.tick(500);
  await Promise.resolve();
  assert.deepEqual(child.writes, [CLAUDE_TRUST_COMMAND + "\r", "\x1b[B"]);
  t.mock.timers.tick(200);
  child.data("\x1b[?u\x1b[c");
  await Promise.resolve();
  assert.equal(child.writes.length, 2);
  const redraw = "\x1b[1D\x1b[4B\r\x1b[1C\x1b[4A \x1b[4GNo, exit\r\x1b[1C\x1b[1B>\x1b[4GYes, I trust this folder\r\n\n\n\x1b[1C\x1b[3A";
  const split = redraw.indexOf(">");
  child.data(redraw.slice(0, split));
  await Promise.resolve();
  assert.equal(child.writes.length, 2);
  t.mock.timers.tick(50);
  child.data(redraw.slice(split));
  t.mock.timers.tick(500);
  await Promise.resolve();
  assert.deepEqual(child.writes, [CLAUDE_TRUST_COMMAND + "\r", "\x1b[B", "\r"]);
  const elapsed = Date.now() - started;
  assert.ok(elapsed < 1_500);
  t.diagnostic(`menu to Enter ${elapsed}ms fixture`);
  child.data("\x1b[2J\x1b[H" + CLAUDE_FOLDER_TRUST);
  t.mock.timers.tick(30_000);
  await Promise.resolve();
  assert.equal(child.writes.length, 3);
});

test("Claude folder trust stops scanning once Claude is working", async (t) => {
  t.mock.timers.enable({ apis: ["Date", "setTimeout", "setInterval"], now: Date.UTC(2026, 9, 21) });
  const f = stallFixture({ commandEcho: false, stallCheckMs: 10_000, now: () => Date.now() });
  t.after(() => f.host.dispose());
  await f.host.openForBot("bot-1", { command: CLAUDE_TRUST_COMMAND });
  const child = f.children[0];
  t.mock.timers.tick(1_000);
  child.data("✻ Reading card… (3s · esc to interrupt)\r\n");
  await Promise.resolve();
  child.data("\x1b[2J\x1b[H" + CLAUDE_FOLDER_TRUST);
  t.mock.timers.tick(500);
  await Promise.resolve();
  assert.deepEqual(child.writes, [CLAUDE_TRUST_COMMAND + "\r"]);
});

test("Claude folder trust re-arms when the pane launches Claude again", async (t) => {
  t.mock.timers.enable({ apis: ["Date", "setTimeout", "setInterval"], now: Date.UTC(2026, 9, 21) });
  const f = stallFixture({ commandEcho: false, stallCheckMs: 10_000, now: () => Date.now() });
  t.after(() => f.host.dispose());
  const pane = await f.host.openForBot("bot-1", { command: CLAUDE_TRUST_COMMAND });
  const child = f.children[0];
  t.mock.timers.tick(1_000);
  child.data("✻ Reading card… (3s · esc to interrupt)\r\n");
  await Promise.resolve();
  child.data("\x1b[2J\x1b[HPS C:\repo> ");
  f.host.sendBot("bot-1", { sessionId: pane.sessionId, generation: pane.generation, text: CLAUDE_TRUST_COMMAND + "\r" });
  child.data("\x1b[2J\x1b[H" + CLAUDE_FOLDER_TRUST);
  t.mock.timers.tick(500);
  await Promise.resolve();
  assert.deepEqual(child.writes.slice(-1), ["\x1b[B"]);
});

for (const [name, prompt] of [
  ["PS prompt", "PS C:\\repo> "],
  ["oh-my-posh prompt", "\x1b[32m repo \x1b[0m ❯ "],
  ["bare > prompt", "> "],
  ["Korean Windows", "Windows PowerShell\r\n모든 권리 보유.\r\nPS C:\\Users\\사용자\\작업> "],
]) {
  test(`Claude folder trust selects Yes once after a ${name}`, async (t) => {
    const f = trustFixture(t, { platform: "win32", commandEcho: false });
    t.after(() => f.host.dispose());
    await f.host.openForBot("bot-1", { label: "A | Opus5.5 | high", command: CLAUDE_TRUST_COMMAND });
    const child = f.children[0];
    child.data(prompt + CLAUDE_TRUST_COMMAND + "\r\n");
    child.data(CLAUDE_FOLDER_TRUST);
    await f.settle();
    assert.deepEqual(child.writes, [CLAUDE_TRUST_COMMAND + "\r", "\x1b[B"]);
    await f.advance(10_000);
    assert.equal(child.writes.length, 2);
    child.data("\x1b[2J\x1b[H" + CLAUDE_FOLDER_TRUST_YES.replaceAll("\n", "\r\n"));
    await f.settle();
    assert.deepEqual(child.writes, [CLAUDE_TRUST_COMMAND + "\r", "\x1b[B", "\r"]);
    child.data("\x1b[2J\x1b[H" + CLAUDE_FOLDER_TRUST);
    await f.advance(30_000);
    assert.equal(child.writes.length, 3);
    assert.equal(f.notes.length, 0);
  });
}

test("Claude folder trust keeps Yes selected and answers each pane independently", async (t) => {
  const f = trustFixture(t);
  t.after(() => f.host.dispose());
  for (let i = 0; i < 2; i++) {
    await f.host.openForBot("bot-1", { label: "A", command: CLAUDE_TRUST_COMMAND });
    f.children[i].data(CLAUDE_FOLDER_TRUST_YES.replaceAll("\n", "\r\n"));
  }
  await f.settle();
  for (const child of f.children) assert.deepEqual(child.writes, [CLAUDE_TRUST_COMMAND + "\r", "\r"]);
});

for (const [name, command] of [
  ["Claude without the permission flag", "claude --model opus 'Read card.md'"],
  ["flag inside the task text", "claude 'Explain --dangerously-skip-permissions please'"],
  ["a similar flag", "claude --dangerously-skip-permissions-extra"],
  ["another engine", "codex --dangerously-skip-permissions"],
  ["a script", "echo claude --dangerously-skip-permissions"],
]) {
  test(`Claude folder trust never answers ${name}`, async (t) => {
    const f = trustFixture(t);
    t.after(() => f.host.dispose());
    await f.host.openForBot("bot-1", { label: "A", command });
    f.children[0].data(CLAUDE_FOLDER_TRUST);
    await f.settle();
    assert.deepEqual(f.children[0].writes, [command + "\r"]);
  });
}

test("Claude folder trust never answers the user's main terminal", async (t) => {
  const f = trustFixture(t);
  t.after(() => f.host.dispose());
  const pane = await f.host.open(f.event, f.input);
  f.host.write(f.event, pane.id, CLAUDE_TRUST_COMMAND + "\r");
  f.children[0].data(CLAUDE_FOLDER_TRUST);
  await f.settle();
  assert.deepEqual(f.children[0].writes, [CLAUDE_TRUST_COMMAND + "\r"]);
});

for (const [name, screen] of [
  ["a shell prompt", "PS C:\\repo> "],
  ["a bare prompt", "> "],
  ["a permission menu", "Allow Bash?\r\n > No, exit\r\n   Yes, I trust this folder\r\n Enter to confirm · Esc to cancel"],
  ["a different heading", CLAUDE_FOLDER_TRUST.replace("Accessing", "Inspecting")],
  ["a different option", CLAUDE_FOLDER_TRUST_YES.replace("Yes, I trust this folder", "Yes, I trust this project")],
  ["a menu followed by an input prompt", CLAUDE_FOLDER_TRUST_YES + "\r\n> "],
]) {
  test(`Claude folder trust ignores ${name} and still handles the real menu`, async (t) => {
    const f = trustFixture(t, { commandEcho: false });
    t.after(() => f.host.dispose());
    await f.host.openForBot("bot-1", { label: "A", command: CLAUDE_TRUST_COMMAND });
    f.children[0].data(screen);
    await f.settle();
    assert.deepEqual(f.children[0].writes, [CLAUDE_TRUST_COMMAND + "\r"]);
    f.children[0].data("\x1b[2J\x1b[H" + CLAUDE_FOLDER_TRUST);
    await f.settle();
    assert.deepEqual(f.children[0].writes, [CLAUDE_TRUST_COMMAND + "\r", "\x1b[B"]);
  });
}

test("Claude folder trust waits for the complete menu", async (t) => {
  const f = trustFixture(t, { commandEcho: false });
  t.after(() => f.host.dispose());
  await f.host.openForBot("bot-1", { label: "A", command: CLAUDE_TRUST_COMMAND });
  const split = CLAUDE_FOLDER_TRUST.indexOf("Enter");
  f.children[0].data(CLAUDE_FOLDER_TRUST.slice(0, split));
  await f.settle();
  assert.equal(f.children[0].writes.length, 1);
  f.children[0].data(CLAUDE_FOLDER_TRUST.slice(split));
  await f.settle();
  assert.deepEqual(f.children[0].writes, [CLAUDE_TRUST_COMMAND + "\r", "\x1b[B"]);
});

const finishedMark = (pane, historyId = 1) => `\x1b]133;D;${pane.sessionId};${historyId}\x07`;
const startedMark = (pane, command) => `\x1b]133;C;${pane.sessionId};${createHash("sha256").update(command.trim()).digest("base64")}\x07`;

test("shell integration only wraps the worker PowerShell", { skip: process.platform !== "win32" }, async (t) => {
  const f = stallFixture({ platform: "win32" });
  t.after(() => f.host.dispose());
  const pane = await f.host.openForBot("bot-1", { label: "SCRIPT" });
  const child = f.children[0];
  assert.ok(child.args.includes("-NoExit"));
  const script = Buffer.from(child.args[child.args.indexOf("-EncodedCommand") + 1], "base64").toString("utf16le");
  assert.ok(script.includes(`133;D;${pane.sessionId}`));
  assert.ok(script.includes("Get-History -Count 1"));
  assert.ok(!script.includes("PSReadLine"));
  await f.host.open(f.event, f.input);
  assert.deepEqual(f.children[1].args, ["-NoLogo"]);
});

for (const [name, shell] of [
  ["PowerShell 5.1", path.join(process.env.SystemRoot || "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe")],
  ["PowerShell 7", path.join(process.env.ProgramFiles || "C:\\Program Files", "PowerShell", "7", "pwsh.exe")],
]) {
  test(`shell markers preserve the existing reader and prompt in ${name}`, { skip: process.platform !== "win32" || !fs.existsSync(shell) }, async () => {
    const args = workerShellArgs("test-pane");
    const hook = Buffer.from(args.at(-1), "base64").toString("utf16le");
    const script = `function global:prompt { "PROMPT:$?" }
function global:PSConsoleHostReadLine { 'echo ok' }
function global:Get-History { [pscustomobject]@{ Id = 7 } }
${hook}
prompt
PSConsoleHostReadLine
Write-Error '' -ErrorAction Ignore
prompt
prompt`;
    const stdout = await new Promise((resolve, reject) => execFile(shell, ["-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(script, "utf16le").toString("base64")], (error, stdout) => error ? reject(error) : resolve(stdout)));
    assert.equal(stdout.split(finishedMark({ sessionId: "test-pane" }, 7)).length - 1, 3);
    assert.ok(stdout.includes(startedMark({ sessionId: "test-pane" }, "echo ok")));
    assert.match(stdout, /echo ok\r?\n/);
    assert.match(stdout, /PROMPT:False/);
    assert.equal(stdout.match(/PROMPT:True/g).length, 2);
  });
}

test("FINISHED fires once per command with the last screen lines", async (t) => {
  const f = stallFixture({ shellIntegration: true, commandEcho: false });
  t.after(() => f.host.dispose());
  const pane = await f.host.openForBot("bot-1", { label: "SCRIPT", command: "pnpm build" });
  await f.advance(10_000);
  assert.equal(f.notes.length, 0);
  f.children[0].data("Tests passed\r\n");
  f.host.attendBot("bot-1", pane.sessionId, "auto", "command done");
  f.children[0].data(finishedMark(pane));
  await f.advance(10_000);
  assert.equal(f.notes.length, 1);
  assert.match(f.notes[0].text, /^FINISHED: command ended without a report\./);
  assert.match(f.notes[0].text, /Last lines:\nTests passed$/);
  await f.advance(600_000);
  assert.equal(f.notes.length, 1);
  f.children[0].data(finishedMark(pane));
  await f.advance(10_000);
  assert.equal(f.notes.length, 1);
  f.host.sendBot("bot-1", { sessionId: pane.sessionId, generation: pane.generation, text: "pnpm build\r" });
  f.children[0].data(startedMark(pane, "pnpm build"));
  f.children[0].data(finishedMark(pane, 2));
  await f.advance(10_000);
  assert.equal(f.notes.length, 2);
});

test("FINISHED tracks each command in a multi-line bot submission", async (t) => {
  const f = stallFixture({ shellIntegration: true });
  t.after(() => f.host.dispose());
  const pane = await f.host.openForBot("bot-1", { label: "SCRIPT", command: "echo setup\npnpm test" });
  f.children[0].data(finishedMark(pane));
  await f.advance(10_000);
  assert.equal(f.notes.length, 1);
  f.children[0].data(startedMark(pane, "pnpm test"));
  f.children[0].data(finishedMark(pane, 2));
  await f.advance(10_000);
  assert.equal(f.notes.length, 2);
});

for (const input of ["\r", " \t\r"]) {
  test(`FINISHED keeps a bot command after empty user input ${JSON.stringify(input)}`, async (t) => {
    const f = stallFixture({ shellIntegration: true });
    t.after(() => f.host.dispose());
    const pane = await f.host.openForBot("bot-1", { label: "SCRIPT" });
    f.host.write(f.event, pane.sessionId, input);
    f.children[0].data(finishedMark(pane, 0));
    f.host.sendBot("bot-1", { ...pane, text: "pnpm build\r" });
    f.children[0].data(startedMark(pane, "pnpm build"));
    f.children[0].data(finishedMark(pane));
    await f.advance(10_000);
    assert.equal(f.notes.length, 1);
  });
}

test("FINISHED keeps a bot command queued before a reported command completes", async (t) => {
  const f = stallFixture({ shellIntegration: true });
  t.after(() => f.host.dispose());
  const pane = await f.host.openForBot("bot-1", { label: "SCRIPT", command: "pnpm build" });
  f.host.attendBot("bot-1", pane.sessionId, "report");
  f.host.sendBot("bot-1", { ...pane, text: "pnpm test\r" });
  f.children[0].data(finishedMark(pane));
  await f.advance(10_000);
  assert.equal(f.notes.length, 0);
  f.children[0].data(startedMark(pane, "pnpm test"));
  f.children[0].data(finishedMark(pane, 2));
  await f.advance(10_000);
  assert.equal(f.notes.length, 1);
});

test("FINISHED is suppressed by a report only for that command", async (t) => {
  const f = stallFixture({ shellIntegration: true });
  t.after(() => f.host.dispose());
  const pane = await f.host.openForBot("bot-1", { label: "SCRIPT", command: "pnpm build" });
  f.host.attendBot("bot-1", pane.sessionId, "report");
  f.children[0].data(finishedMark(pane));
  await f.advance(10_000);
  assert.equal(f.notes.length, 0);
  f.host.sendBot("bot-1", { sessionId: pane.sessionId, generation: pane.generation, text: "pnpm build\r" });
  f.children[0].data(startedMark(pane, "pnpm build"));
  f.children[0].data(finishedMark(pane, 2));
  await f.advance(10_000);
  assert.equal(f.notes.length, 1);
});

test("FINISHED is cleared by a report that lands before delivery", async (t) => {
  const f = stallFixture({ shellIntegration: true });
  t.after(() => f.host.dispose());
  const pane = await f.host.openForBot("bot-1", { label: "SCRIPT", command: "pnpm build" });
  f.children[0].data(finishedMark(pane));
  f.host.attendBot("bot-1", pane.sessionId, "report");
  await f.advance(10_000);
  assert.equal(f.notes.length, 0);
  f.host.sendBot("bot-1", { sessionId: pane.sessionId, generation: pane.generation, text: "pnpm build\r" });
  f.children[0].data(startedMark(pane, "pnpm build"));
  f.children[0].data(finishedMark(pane, 2));
  await f.advance(10_000);
  assert.equal(f.notes.length, 1);
});

test("FINISHED skips a hand-typed command after a bot command reports DONE", async (t) => {
  const f = stallFixture({ shellIntegration: true });
  t.after(() => f.host.dispose());
  const pane = await f.host.openForBot("bot-1", { label: "SCRIPT", command: "pnpm build" });
  f.host.attendBot("bot-1", pane.sessionId, "report");
  f.children[0].data(finishedMark(pane));
  await f.advance(10_000);
  assert.equal(f.notes.length, 0);
  f.host.write(f.event, pane.sessionId, "claude\r");
  f.host.write(f.event, pane.sessionId, "/logout\r");
  f.children[0].data(startedMark(pane, "claude"));
  f.children[0].data(finishedMark(pane, 2));
  await f.advance(10_000);
  assert.equal(f.notes.length, 0);
  f.host.sendBot("bot-1", { sessionId: pane.sessionId, generation: pane.generation, text: "pnpm build\r" });
  f.children[0].data(startedMark(pane, "pnpm build"));
  f.children[0].data(finishedMark(pane, 3));
  await f.advance(10_000);
  assert.equal(f.notes.length, 1);
});

test("FINISHED skips hand-typed commands in an empty bot pane", async (t) => {
  const f = stallFixture({ shellIntegration: true });
  t.after(() => f.host.dispose());
  const pane = await f.host.openForBot("bot-1", { label: "SCRIPT" });
  f.host.write(f.event, pane.sessionId, "claude\r");
  f.children[0].data(startedMark(pane, "claude"));
  f.children[0].data(finishedMark(pane));
  await f.advance(10_000);
  assert.equal(f.notes.length, 0);
});

test("FINISHED keeps a bot command when a person answers its prompt", async (t) => {
  const f = stallFixture({ shellIntegration: true });
  t.after(() => f.host.dispose());
  const pane = await f.host.openForBot("bot-1", { label: "SCRIPT", command: "script.ps1" });
  f.host.write(f.event, pane.sessionId, "yes\r");
  f.children[0].data(finishedMark(pane));
  await f.advance(10_000);
  assert.equal(f.notes.length, 1);
});

for (const reported of [false, true]) {
  test(`FINISHED skips a hand-typed command after a bot answers a running program, reported ${reported}`, async (t) => {
    const f = stallFixture({ shellIntegration: true });
    t.after(() => f.host.dispose());
    const pane = await f.host.openForBot("bot-1", { label: "SCRIPT", command: "script.ps1" });
    f.host.sendBot("bot-1", { ...pane, text: "yes\r" });
    if (reported) f.host.attendBot("bot-1", pane.sessionId, "report");
    f.children[0].data(finishedMark(pane));
    await f.advance(10_000);
    assert.equal(f.notes.length, reported ? 0 : 1);
    f.host.write(f.event, pane.sessionId, "yes\r");
    f.children[0].data(startedMark(pane, "yes"));
    f.children[0].data(finishedMark(pane, 2));
    await f.advance(10_000);
    assert.equal(f.notes.length, reported ? 0 : 1);
    f.host.sendBot("bot-1", { ...pane, text: "pnpm test\r" });
    f.children[0].data(startedMark(pane, "pnpm test"));
    f.children[0].data(finishedMark(pane, 3));
    await f.advance(10_000);
    assert.equal(f.notes.length, reported ? 1 : 2);
  });
}

test("FINISHED keeps a bot command after a person cancels an unsubmitted line", async (t) => {
  const f = stallFixture({ shellIntegration: true });
  t.after(() => f.host.dispose());
  const pane = await f.host.openForBot("bot-1", { label: "SCRIPT" });
  f.host.write(f.event, pane.sessionId, "oops");
  f.host.write(f.event, pane.sessionId, "\x03");
  f.children[0].data(finishedMark(pane, 0));
  f.host.sendBot("bot-1", { ...pane, text: "pnpm test\r" });
  f.children[0].data(startedMark(pane, "pnpm test"));
  f.children[0].data(finishedMark(pane));
  await f.advance(10_000);
  assert.equal(f.notes.length, 1);
});

test("FINISHED never fires for the main terminal", async (t) => {
  const f = stallFixture({ shellIntegration: true });
  t.after(() => f.host.dispose());
  const main = await f.host.open(f.event, f.input);
  f.children[0].data(finishedMark({ sessionId: main.id }));
  await f.advance(10_000);
  assert.equal(f.notes.length, 0);
  const pane = await f.host.openForBot("bot-1", { label: "SCRIPT", command: "pnpm build" });
  f.children[1].data(finishedMark(pane));
  await f.advance(10_000);
  assert.equal(f.notes.length, 1);
});

test("FINISHED skips an explicit read after completion, not background reads", async (t) => {
  const f = stallFixture({ shellIntegration: true });
  t.after(() => f.host.dispose());
  const pane = await f.host.openForBot("bot-1", { label: "SCRIPT", command: "pnpm build" });
  f.children[0].data(finishedMark(pane));
  f.host.readBot("bot-1", { sessionId: pane.sessionId, observe: true });
  await f.advance(10_000);
  assert.equal(f.notes.length, 0);
  f.host.sendBot("bot-1", { sessionId: pane.sessionId, generation: pane.generation, text: "pnpm build\r" });
  f.children[0].data(startedMark(pane, "pnpm build"));
  f.children[0].data(finishedMark(pane, 2));
  f.host.readBot("bot-1", { sessionId: pane.sessionId });
  await f.advance(10_000);
  assert.equal(f.notes.length, 1);
});

test("FINISHED accepts split markers but ignores prompt text and foreign markers", async (t) => {
  const f = stallFixture({ shellIntegration: true });
  t.after(() => f.host.dispose());
  const pane = await f.host.openForBot("bot-1", { label: "SCRIPT", command: "pnpm build" });
  f.children[0].data(`PS C:\\> \r\n\x1b]133;D;foreign\x07\x1b]133;A;${pane.sessionId}\x07`);
  await f.advance(10_000);
  assert.equal(f.notes.length, 0);
  const marker = finishedMark(pane);
  for (const byte of marker) f.children[0].data(byte);
  await f.advance(10_000);
  assert.equal(f.notes.length, 1);
});

test("turn-end note waits 90 seconds and is delivered once", async (t) => {
  const f = stallFixture();
  t.after(() => f.host.dispose());
  const pane = await f.host.openForBot("bot-1", { label: "AGENT", command: "codex go" });
  f.children[0].data("Done\r\n");
  assert.equal(f.host.attendBot("bot-1", pane.sessionId, "auto", "all green"), true);
  await f.advance(89_999);
  assert.equal(f.notes.length, 0);
  await f.advance(1);
  assert.deepEqual(f.notes.map((note) => note.text), ["all green"]);
  await f.advance(600_000);
  assert.equal(f.notes.length, 1);
  f.children[0].data("✻ Working… (1s · esc to interrupt)\r\n");
  f.children[0].data("\x1b[2J\x1b[HDone again\r\n");
  f.host.attendBot("bot-1", pane.sessionId, "auto", "next turn done");
  await f.advance(90_000);
  assert.deepEqual(f.notes.map((note) => note.text), ["all green", "next turn done"]);
});

test("turn-end note is dropped on submitted input and the next idle note works", async (t) => {
  const f = stallFixture();
  t.after(() => f.host.dispose());
  const pane = await f.host.openForBot("bot-1", { label: "AGENT", command: "codex go" });
  f.host.attendBot("bot-1", pane.sessionId, "auto", "still running");
  await f.advance(30_000);
  f.host.write(f.event, pane.sessionId, "continue\r");
  await f.advance(90_000);
  assert.equal(f.notes.length, 0);
  f.host.attendBot("bot-1", pane.sessionId, "auto", "done now");
  await f.advance(90_000);
  assert.deepEqual(f.notes.map((note) => note.text), ["done now"]);
});

test("turn-end note is dropped on a report and the next command can notify", async (t) => {
  const f = stallFixture();
  t.after(() => f.host.dispose());
  const pane = await f.host.openForBot("bot-1", { label: "AGENT", command: "codex go" });
  f.host.attendBot("bot-1", pane.sessionId, "auto", "still running");
  await f.advance(30_000);
  f.host.attendBot("bot-1", pane.sessionId, "report");
  await f.advance(90_000);
  assert.equal(f.notes.length, 0);
  f.host.sendBot("bot-1", { ...pane, text: "next\r" });
  f.host.attendBot("bot-1", pane.sessionId, "auto", "done now");
  await f.advance(90_000);
  assert.deepEqual(f.notes.map((note) => note.text), ["done now"]);
});

for (const busy of ["✻ Working… (1s · esc to interrupt)", "• Working (1s • esc to interrupt)"]) {
  test(`turn-end note is dropped when the agent resumes: ${busy}`, async (t) => {
    const f = stallFixture();
    t.after(() => f.host.dispose());
    const pane = await f.host.openForBot("bot-1", { label: "AGENT", command: "codex go" });
    f.host.attendBot("bot-1", pane.sessionId, "auto", "still running");
    f.children[0].data(busy + "\r\n");
    f.children[0].data("\x1b[2J\x1b[HDone\r\n");
    await f.advance(90_000);
    assert.equal(f.notes.length, 0);
    f.host.attendBot("bot-1", pane.sessionId, "auto", "done now");
    await f.advance(90_000);
    assert.deepEqual(f.notes.map((note) => note.text), ["done now"]);
  });
}

const claudeIdle = (jobs) => `\x1b[2J\x1b[H✻ Brewed for 21s · done 6:26 PM${jobs ? ` · ${jobs} still running` : ""}\r\n${"─".repeat(40)}\r\n> \r\n${"─".repeat(40)}\r\n⏵⏵ bypass permissions on${jobs ? ` · ${jobs}` : ""} · ← for agents\r\n`;
const AGENT_ROWS = [
  "( ) general-purpose  Polling m2-S-lock.txt for lock handoff   1h 18m 55s · ↓ 253.2k tokens",
  "( ) general-purpose  Waiting on HEAVY.lock for m_shift.py      1h 22m 4s · ↓ 253.6k tokens",
];
const claudeAgentWait = (rows = AGENT_ROWS.slice(0, 1)) => `\x1b[2J\x1b[H● Waiting on the measure agent now. It will notify when it's done; then I'll write the\r\n  numbers, clean up and send the report.\r\n\r\n✻ Waiting for 1 background agent to finish\r\n\r\n${"─".repeat(94)}\r\n> \r\n${"─".repeat(94)}\r\n  ◆ Opus 5.5 │ site-motion-3/feat/motion-3\r\n  ▰▰▰▱▱ 60% │ ↑121.5k ↓41 │ 5h: ▰▰▰▱▱ 63% (3h56m) │ 7d: ▰▰▰▱▱ 69% (4h36m) │ 11h41m\r\n  ctx 121k/300k\r\n  ⏵⏵ bypass permissions on · 3 shells\r\n${" ".repeat(54)}new task? /clear to save 121.5k tokens\r\n${" ".repeat(82)}/rc failed\r\n\r\n${rows.length ? "  ● main\r\n" : ""}${rows.map((row) => `  ${row}\r\n`).join("")}`;

for (const jobs of ["1 shell", "2 shells, 1 monitor", "3 monitors", "1 local agent", "2 local agents"]) {
  test(`turn-end note is held while background jobs run, then delivered once: ${jobs}`, async (t) => {
    const f = stallFixture();
    t.after(() => f.host.dispose());
    const pane = await f.host.openForBot("bot-1", { label: "AGENT", command: "claude go" });
    f.children[0].data(claudeIdle(jobs));
    await f.settle();
    f.host.attendBot("bot-1", pane.sessionId, "auto", "waiting on build");
    await f.advance(90_000);
    assert.equal(f.notes.length, 0);
    await f.advance(600_000);
    assert.equal(f.notes.length, 0);
    f.children[0].data(claudeIdle());
    await f.advance(29_999);
    assert.equal(f.notes.length, 0);
    await f.advance(1);
    assert.deepEqual(f.notes.map((note) => note.text), ["waiting on build"]);
    await f.advance(600_000);
    assert.equal(f.notes.length, 1);
  });
}

test("a held turn-end note is dropped when the agent resumes after its jobs finish", async (t) => {
  const f = stallFixture();
  t.after(() => f.host.dispose());
  const pane = await f.host.openForBot("bot-1", { label: "AGENT", command: "claude go" });
  f.children[0].data(claudeIdle("1 shell, 1 monitor"));
  await f.settle();
  f.host.attendBot("bot-1", pane.sessionId, "auto", "waiting on build");
  await f.advance(90_000);
  assert.equal(f.notes.length, 0);
  f.children[0].data(claudeIdle());
  await f.advance(10_000);
  f.children[0].data("✻ Working… (1s · esc to interrupt)\r\n");
  f.children[0].data(claudeIdle());
  await f.advance(90_000);
  assert.equal(f.notes.length, 0);
  f.host.attendBot("bot-1", pane.sessionId, "auto", "build checked");
  await f.advance(90_000);
  assert.deepEqual(f.notes.map((note) => note.text), ["build checked"]);
});

test("a turn-end note held on background jobs goes out once after 30 minutes", async (t) => {
  const f = stallFixture();
  t.after(() => f.host.dispose());
  const pane = await f.host.openForBot("bot-1", { label: "AGENT", command: "claude go" });
  f.children[0].data(claudeIdle("1 shell"));
  await f.settle();
  f.host.attendBot("bot-1", pane.sessionId, "auto", "dev server up");
  await f.advance(90_000);
  assert.equal(f.notes.length, 0);
  await f.advance(30 * 60_000 - 90_000 - 1);
  assert.equal(f.notes.length, 0);
  await f.advance(1);
  assert.deepEqual(f.notes.map((note) => note.text), ["dev server up"]);
  await f.advance(600_000);
  assert.equal(f.notes.length, 1);
});

test("a turn-end note is held while Claude waits on its background agent", async (t) => {
  const f = stallFixture();
  t.after(() => f.host.dispose());
  const pane = await f.host.openForBot("bot-1", { label: "AGENT", command: "claude go" });
  f.children[0].data(claudeAgentWait());
  await f.settle();
  f.host.attendBot("bot-1", pane.sessionId, "auto", "waiting on the measure agent");
  await f.advance(600_000);
  assert.equal(f.notes.length, 0);
  f.children[0].data(claudeIdle());
  await f.advance(30_000);
  assert.deepEqual(f.notes.map((note) => note.text), ["waiting on the measure agent"]);
});

test("background job words in output above the footer do not hold a turn-end note", async (t) => {
  const f = stallFixture();
  t.after(() => f.host.dispose());
  const pane = await f.host.openForBot("bot-1", { label: "AGENT", command: "claude go" });
  f.children[0].data("\x1b[2J\x1b[H⏵⏵ bypass permissions on · 1 shell, 1 monitor · ← for agents\r\nstarted 2 shells\r\n");
  f.children[0].data(claudeIdle().replace("\x1b[2J\x1b[H", ""));
  f.host.attendBot("bot-1", pane.sessionId, "auto", "all green");
  await f.advance(90_000);
  assert.deepEqual(f.notes.map((note) => note.text), ["all green"]);
});

test("a report clears a turn-end note held on background jobs", async (t) => {
  const f = stallFixture();
  t.after(() => f.host.dispose());
  const pane = await f.host.openForBot("bot-1", { label: "AGENT", command: "claude go" });
  f.children[0].data(claudeIdle("1 shell"));
  await f.settle();
  f.host.attendBot("bot-1", pane.sessionId, "auto", "waiting on build");
  await f.advance(90_000);
  f.host.attendBot("bot-1", pane.sessionId, "report");
  await f.advance(600_000);
  f.children[0].data(claudeIdle());
  await f.advance(30 * 60_000);
  assert.equal(f.notes.length, 0);
});

test("a Codex idle screen never holds a turn-end note", async (t) => {
  const f = stallFixture();
  t.after(() => f.host.dispose());
  const pane = await f.host.openForBot("bot-1", { label: "AGENT", command: "codex go" });
  f.children[0].data("\x1b[2J\x1b[H• Ran pnpm dev\r\n  └ 1 shell, 1 monitor\r\n\r\n› Explain this codebase\r\n\r\n  1 background terminal running · /ps to view\r\n  100% context left · ? for shortcuts\r\n");
  f.host.attendBot("bot-1", pane.sessionId, "auto", "all green");
  await f.advance(90_000);
  assert.deepEqual(f.notes.map((note) => note.text), ["all green"]);
});

test("a turn-end note that fails to post goes out on a later check", async (t) => {
  const f = stallFixture({ failures: 1 });
  t.after(() => f.host.dispose());
  const pane = await f.host.openForBot("bot-1", { label: "AGENT", command: "codex go" });
  f.host.attendBot("bot-1", pane.sessionId, "auto", "all green");
  await f.advance(90_000);
  assert.equal(f.notes.length, 0);
  await f.advance(60_000);
  assert.deepEqual(f.notes.map((note) => note.text), ["all green"]);
  await f.advance(600_000);
  assert.equal(f.notes.length, 1);
});

test("a turn-end note that never posts stops after five tries", async (t) => {
  let tries = 0;
  const f = stallFixture({ notePane: async (mail, scope, text) => { if (text === "all green") tries += 1; throw new Error("connect ECONNREFUSED 127.0.0.1:9"); } });
  t.after(() => f.host.dispose());
  const pane = await f.host.openForBot("bot-1", { label: "AGENT", command: "codex go" });
  f.host.attendBot("bot-1", pane.sessionId, "auto", "all green");
  await f.advance(90_000);
  for (let check = 0; check < 10; check += 1) await f.advance(61_000);
  assert.equal(tries, 5);
});

test("a report drops a turn-end note waiting to retry", async (t) => {
  const f = stallFixture({ failures: 1 });
  t.after(() => f.host.dispose());
  const pane = await f.host.openForBot("bot-1", { label: "AGENT", command: "codex go" });
  f.host.attendBot("bot-1", pane.sessionId, "auto", "all green");
  await f.advance(90_000);
  f.host.attendBot("bot-1", pane.sessionId, "report");
  await f.advance(600_000);
  assert.equal(f.notes.length, 0);
});

test("a turn-end note in flight never posts twice, even on a duplicate", async (t) => {
  const posts = [];
  const f = stallFixture({ notePane: (mail, scope, text) => new Promise((resolve) => { posts.push({ text, resolve }); }) });
  t.after(() => f.host.dispose());
  const pane = await f.host.openForBot("bot-1", { label: "AGENT", command: "codex go" });
  f.host.attendBot("bot-1", pane.sessionId, "auto", "all green");
  await f.advance(90_000);
  assert.equal(posts.length, 1);
  f.host.attendBot("bot-1", pane.sessionId, "auto", "all green");
  await f.advance(600_000);
  assert.equal(posts.length, 1);
  posts[0].resolve();
  await f.settle();
  f.host.attendBot("bot-1", pane.sessionId, "auto", "all green");
  await f.advance(600_000);
  assert.equal(posts.length, 1);
});

test("a turn-end note held on background jobs goes out as soon as the pane exits", async (t) => {
  const f = stallFixture();
  t.after(() => f.host.dispose());
  const pane = await f.host.openForBot("bot-1", { label: "AGENT", command: "claude go" });
  f.children[0].data(claudeIdle("1 shell"));
  await f.settle();
  f.host.attendBot("bot-1", pane.sessionId, "auto", "dev server up");
  await f.advance(90_000);
  assert.equal(f.notes.length, 0);
  f.children[0].exit({ exitCode: 0 });
  await f.settle();
  assert.deepEqual(f.notes.map((note) => note.text), ["dev server up"]);
  await f.advance(30 * 60_000);
  assert.equal(f.notes.length, 1);
});

test("a held turn-end note survives its exited pane being reclaimed", async (t) => {
  const f = stallFixture({ failures: 1 });
  t.after(() => f.host.dispose());
  const pane = await f.host.openForBot("bot-1", { label: "AGENT", command: "claude go" });
  f.children[0].data(claudeIdle("1 shell"));
  await f.settle();
  f.host.attendBot("bot-1", pane.sessionId, "auto", "dev server up");
  await f.advance(90_000);
  for (let i = 1; i < 32; i += 1) {
    await f.host.openForBot("bot-1", {});
    f.children[i].exit({ exitCode: 0 });
  }
  f.children[0].exit({ exitCode: 0 });
  await f.settle();
  assert.equal(f.notes.length, 0);
  await f.host.openForBot("bot-1", {});
  assert.ok(f.events.some(([channel, value]) => channel === "terminal:closed" && value.id === pane.sessionId));
  await f.advance(60_000);
  assert.deepEqual(f.notes.map((note) => note.text), ["dev server up"]);
});

test("a closed pane drops a held turn-end note and one waiting to retry after its exit", async (t) => {
  const f = stallFixture({ failures: 1 });
  t.after(() => f.host.dispose());
  const held = await f.host.openForBot("bot-1", { label: "HELD", command: "claude go" });
  const exited = await f.host.openForBot("bot-1", { label: "EXITED", command: "claude go" });
  f.children[0].data(claudeIdle("1 shell"));
  f.children[1].data(claudeIdle("1 shell"));
  await f.settle();
  f.host.attendBot("bot-1", held.sessionId, "auto", "held");
  f.host.attendBot("bot-1", exited.sessionId, "auto", "exited");
  await f.advance(90_000);
  f.children[1].exit({ exitCode: 0 });
  await f.settle();
  await f.host.closeForBot("bot-1", held.sessionId);
  await f.host.closeForBot("bot-1", exited.sessionId);
  f.children[0].exit({ exitCode: 1 });
  await f.advance(30 * 60_000);
  assert.equal(f.notes.length, 0);
});

test("FINISHED that fails to post goes out once on a later check", async (t) => {
  const f = stallFixture({ shellIntegration: true, failures: 1, commandEcho: false });
  t.after(() => f.host.dispose());
  const pane = await f.host.openForBot("bot-1", { label: "SCRIPT", command: "pnpm build" });
  f.children[0].data("Tests passed\r\n");
  f.children[0].data(finishedMark(pane));
  await f.advance(10_000);
  assert.equal(f.notes.length, 0);
  await f.advance(60_000);
  assert.equal(f.notes.length, 1);
  assert.match(f.notes[0].text, /Last lines:\nTests passed$/);
  await f.advance(600_000);
  assert.equal(f.notes.length, 1);
});

test("FINISHED pending when the pane exits is still delivered", async (t) => {
  const f = stallFixture({ shellIntegration: true });
  t.after(() => f.host.dispose());
  const pane = await f.host.openForBot("bot-1", { label: "SCRIPT", command: "pnpm build" });
  f.children[0].data("Tests passed\r\n");
  f.children[0].data(finishedMark(pane));
  f.children[0].exit({ exitCode: 0 });
  await f.settle();
  assert.equal(f.notes.length, 1);
  assert.match(f.notes[0].text, /^FINISHED: /);
  await f.advance(600_000);
  assert.equal(f.notes.length, 1);
});

const DLL_INIT_FAILED = -1073741502;

test("a bot pane whose shell exits nonzero before a report sends one EXITED note", async (t) => {
  const f = stallFixture({ commandEcho: false });
  t.after(() => f.host.dispose());
  await f.host.openForBot("bot-1", { label: "SCRIPT", command: "pnpm build" });
  f.children[0].data("boom\r\n");
  f.children[0].exit({ exitCode: 1 });
  await f.settle();
  assert.deepEqual(f.notes.map((note) => note.text), ["EXITED: pane shell ended with code 1 (0x1) before a report. terminal_read the pane list, then respawn or tell the user. Last lines:\nboom"]);
  await f.advance(600_000);
  assert.equal(f.notes.length, 1);
});

test("EXITED skips the main terminal, a clean exit, a reported pane and a closed pane", async (t) => {
  const f = stallFixture();
  t.after(() => f.host.dispose());
  await f.host.open(f.event, f.input);
  f.children[0].exit({ exitCode: 1 });
  await f.host.openForBot("bot-1", { label: "CLEAN" });
  f.children[1].exit({ exitCode: 0 });
  const reported = await f.host.openForBot("bot-1", { label: "REPORTED" });
  f.host.attendBot("bot-1", reported.sessionId, "report");
  f.children[2].exit({ exitCode: 1 });
  const closed = await f.host.openForBot("bot-1", { label: "CLOSED" });
  await f.host.closeForBot("bot-1", closed.sessionId);
  f.children[3].exit({ exitCode: 1 });
  await f.advance(600_000);
  assert.equal(f.notes.length, 0);
});

test("EXITED that fails to post goes out once on a later check", async (t) => {
  const f = stallFixture({ failures: 1 });
  t.after(() => f.host.dispose());
  await f.host.openForBot("bot-1", { label: "SCRIPT" });
  f.children[0].exit({ exitCode: 2 });
  await f.settle();
  assert.equal(f.notes.length, 0);
  await f.advance(60_000);
  assert.deepEqual(f.notes.map((note) => note.text), ["EXITED: pane shell ended with code 2 (0x2) before a report. terminal_read the pane list, then respawn or tell the user."]);
  await f.advance(600_000);
  assert.equal(f.notes.length, 1);
});

test("a shell that dies in DLL init respawns once in the same pane with its command", async (t) => {
  const f = stallFixture({ commandEcho: false });
  t.after(() => f.host.dispose());
  const pane = await f.host.openForBot("bot-1", { label: "AGENT", command: "codex go" });
  await f.advance(1_000);
  f.children[0].exit({ exitCode: DLL_INIT_FAILED });
  await f.settle();
  assert.equal(f.children.length, 2);
  assert.deepEqual(f.children[1].writes, ["codex go\r"]);
  assert.equal(f.notes.length, 0);
  f.children[1].data("codex ready\r\n");
  const read = f.host.readBot("bot-1", { sessionId: pane.sessionId });
  assert.equal(read.exited, false);
  assert.match(read.screenText, /codex ready/);
  f.children[1].exit({ exitCode: DLL_INIT_FAILED });
  await f.settle();
  assert.equal(f.children.length, 2);
  assert.match(f.notes[0].text, /^EXITED: pane shell ended with code -1073741502 \(0xC0000142\) before a report\./);
  assert.equal(f.notes.length, 1);
});

test("a respawned shell that dies in DLL init again sends EXITED", async (t) => {
  const f = stallFixture({ commandEcho: false });
  t.after(() => f.host.dispose());
  await f.host.openForBot("bot-1", { label: "AGENT", command: "codex go" });
  f.children[0].exit({ exitCode: DLL_INIT_FAILED });
  await f.settle();
  f.children[1].exit({ exitCode: DLL_INIT_FAILED });
  await f.settle();
  assert.equal(f.children.length, 2);
  assert.deepEqual(f.notes.map((note) => note.text), ["EXITED: pane shell ended with code -1073741502 (0xC0000142) before a report. terminal_read the pane list, then respawn or tell the user."]);
});

test("a DLL init exit after output, after five seconds, or another code never respawns", async (t) => {
  const f = stallFixture();
  t.after(() => f.host.dispose());
  await f.host.openForBot("bot-1", { label: "OUTPUT" });
  f.children[0].data("PS C:\\> ");
  f.children[0].exit({ exitCode: DLL_INIT_FAILED });
  await f.host.openForBot("bot-1", { label: "LATE" });
  await f.advance(5_000);
  f.children[1].exit({ exitCode: DLL_INIT_FAILED });
  await f.host.openForBot("bot-1", { label: "OTHER" });
  f.children[2].exit({ exitCode: -1073741819 });
  await f.settle();
  assert.equal(f.children.length, 3);
  assert.equal(f.notes.length, 3);
  assert.ok(f.notes.every((note) => note.text.startsWith("EXITED: ")));
});

function slowRespawnFixture({ slow = (index) => index > 0, ...options } = {}) {
  const children = [];
  let releaseReady;
  let failReady;
  const f = stallFixture({ commandEcho: false, ...options, loadPty: () => ({ spawn: () => {
    const child = { pid: 101 + children.length, writes: [], killed: false, exit() {}, onData(cb) { this.data = cb; }, onExit(cb) { this.exit = cb; }, write(data) { this.writes.push(data); }, resize() {}, kill() { this.killed = true; } };
    if (slow(children.length)) child.ready = new Promise((resolve, reject) => { releaseReady = resolve; failReady = reject; });
    children.push(child);
    return child;
  } }) });
  return { ...f, children, release: () => releaseReady(), fail: () => failReady(new Error("not ready")) };
}

test("a bot send mid-respawn waits for the new shell", async (t) => {
  const f = slowRespawnFixture();
  t.after(() => f.host.dispose());
  const pane = await f.host.openForBot("bot-1", { label: "AGENT", command: "codex go" });
  f.children[0].exit({ exitCode: DLL_INIT_FAILED });
  await f.settle();
  f.host.sendBot("bot-1", { sessionId: pane.sessionId, generation: pane.generation, text: "y\r" });
  assert.deepEqual(f.children[0].writes, ["codex go\r"]);
  f.release();
  await f.settle();
  assert.deepEqual(f.children[1].writes, ["codex go\r", "y\r"]);
});

test("a pane closed mid-respawn kills the new shell and sends no note", async (t) => {
  const f = slowRespawnFixture();
  t.after(() => f.host.dispose());
  const pane = await f.host.openForBot("bot-1", { label: "AGENT", command: "codex go" });
  f.children[0].exit({ exitCode: DLL_INIT_FAILED });
  await f.settle();
  assert.equal(f.children.length, 2);
  await f.host.closeForBot("bot-1", pane.sessionId);
  f.release();
  await f.settle();
  assert.equal(f.children[1].killed, true);
  assert.deepEqual(f.children[1].writes, []);
  await f.advance(600_000);
  assert.equal(f.notes.length, 0);
});

test("a pane closed mid-respawn marks its run ended", async (t) => {
  const runs = [];
  const f = slowRespawnFixture({ paneRuns: { started() {}, reported() {}, ended: (id) => runs.push(["ended", id]), closed: (id) => runs.push(["closed", id]) } });
  t.after(() => f.host.dispose());
  const pane = await f.host.openForBot("bot-1", { label: "AGENT", command: "codex go" });
  f.children[0].exit({ exitCode: DLL_INIT_FAILED });
  await f.settle();
  await f.host.closeForBot("bot-1", pane.sessionId);
  f.release();
  await f.settle();
  assert.deepEqual(runs, [["closed", pane.sessionId], ["ended", pane.sessionId]]);
});

test("a pane closed mid-respawn whose new shell never acks its kill still lets other panes stop", async () => {
  const f = slowRespawnFixture({ slow: (index) => index === 2 });
  const pane = await f.host.openForBot("bot-1", { label: "AGENT", command: "codex go" });
  const other = await f.host.openForBot("bot-1", { label: "OTHER" });
  f.children[0].exit({ exitCode: DLL_INIT_FAILED });
  await f.settle();
  f.children[2].kill = () => new Promise(() => {});
  await f.host.closeForBot("bot-1", pane.sessionId);
  f.release();
  await f.settle();
  const closed = await Promise.race([f.host.closeForBot("bot-1", other.sessionId).then(() => true), wait(1_500).then(() => false)]);
  assert.equal(closed, true);
  assert.equal(f.children[1].killed, true);
  await f.host.dispose();
});

test("a respawned shell that never gets ready is killed and reports its own exit code", async (t) => {
  const f = slowRespawnFixture();
  t.after(() => f.host.dispose());
  await f.host.openForBot("bot-1", { label: "AGENT", command: "codex go" });
  f.children[0].exit({ exitCode: DLL_INIT_FAILED });
  await f.settle();
  f.children[1].exit({ exitCode: 5 });
  f.fail();
  await f.settle();
  assert.equal(f.children[1].killed, true);
  assert.deepEqual(f.notes.map((note) => note.text), ["EXITED: pane shell ended with code 5 (0x5) before a report. terminal_read the pane list, then respawn or tell the user."]);
});

test("a respawned shell that fails ready without exiting reports the first exit code", async (t) => {
  const f = slowRespawnFixture();
  t.after(() => f.host.dispose());
  await f.host.openForBot("bot-1", { label: "AGENT", command: "codex go" });
  f.children[0].exit({ exitCode: DLL_INIT_FAILED });
  await f.settle();
  f.fail();
  await f.settle();
  assert.equal(f.children[1].killed, true);
  assert.match(f.notes[0].text, /^EXITED: pane shell ended with code -1073741502 \(0xC0000142\)/);
});

test("a renderer write mid-respawn waits for the new shell", async (t) => {
  const f = slowRespawnFixture();
  t.after(() => f.host.dispose());
  const pane = await f.host.openForBot("bot-1", { label: "AGENT", command: "codex go" });
  f.children[0].exit({ exitCode: DLL_INIT_FAILED });
  await f.settle();
  f.host.write(f.event, pane.sessionId, "y\r");
  assert.deepEqual(f.children[0].writes, ["codex go\r"]);
  f.release();
  await f.settle();
  assert.deepEqual(f.children[1].writes, ["codex go\r", "y\r"]);
});

test("a reused pane that exits before reporting its new task sends EXITED", async (t) => {
  const f = stallFixture();
  t.after(() => f.host.dispose());
  const pane = await f.host.openForBot("bot-1", { label: "AGENT", command: "codex go" });
  f.host.attendBot("bot-1", pane.sessionId, "report");
  await f.advance(1_000);
  f.host.sendBot("bot-1", { sessionId: pane.sessionId, generation: pane.generation, text: "next task\r" });
  f.children[0].exit({ exitCode: 1 });
  await f.settle();
  assert.equal(f.notes.length, 1);
  assert.match(f.notes[0].text, /^EXITED: pane shell ended with code 1 /);
});

const CODEX_CAPACITY = "■ Selected model is at capacity. Please try a different model.";
const codexCapacityScreen = (output = CODEX_CAPACITY, input = "") => `\x1b[2J\x1b[H${output}\r\n\r\n› ${input}\r\n\r\n  100% context left · ? for shortcuts\x1b[3;${3 + input.length}H`;

test("Codex capacity waits a minute, continues once without a note and leaves other screens alone", async (t) => {
  const f = stallFixture();
  t.after(() => f.host.dispose());
  await f.host.openForBot("bot-1", { label: "W", command: "codex go" });
  const child = f.children[0];
  child.data(codexCapacityScreen());
  await f.settle();
  await f.advance(59_999);
  assert.deepEqual(child.writes, ["codex go\r"]);
  assert.equal(f.notes.length, 0);
  await f.advance(1);
  assert.deepEqual(child.writes, ["codex go\r", "continue\r"]);
  await f.advance(120_000);
  assert.deepEqual(child.writes, ["codex go\r", "continue\r"]);
  assert.equal(f.notes.length, 0);

  for (const [command, screen] of [
    ["claude go", codexCapacityScreen()],
    ["codex go", codexCapacityScreen("■ You've hit your usage limit. Try again later.")],
    ["codex go", codexCapacityScreen(`${CODEX_CAPACITY}\r\nNewer output`)],
    ["codex go", codexCapacityScreen(CODEX_CAPACITY, "unsent text")],
    ["codex go", `${codexCapacityScreen(CODEX_CAPACITY, "delete all files")}\x1b[3;3H`],
    ["codex go", codexCapacityScreen(`${CODEX_CAPACITY}\r\n• Working (esc to interrupt)`)],
    ["codex go", `${CODEX_CAPACITY}\r\n› 1. Switch model\r\n  2. Keep current model\r\n  enter select · esc back`],
    ["codex go", `${codexCapacityScreen()}\x1b[6;1H  enter select · esc back\x1b[3;3H`],
  ]) {
    const other = stallFixture();
    t.after(() => other.host.dispose());
    await other.host.openForBot("bot-1", { label: "W", command });
    other.children[0].data(screen);
    await other.settle();
    await other.advance(60_000);
    assert.deepEqual(other.children[0].writes, [`${command}\r`]);
    assert.equal(other.notes.length, 0);
  }
});

test("Codex capacity leaves input typed before the screen echoes it alone", async (t) => {
  const f = stallFixture();
  t.after(() => f.host.dispose());
  const pane = await f.host.openForBot("bot-1", { label: "W", command: "codex go" });
  const child = f.children[0];
  child.data(codexCapacityScreen());
  await f.settle();
  await f.advance(59_999);
  f.host.write(f.event, pane.sessionId, "please wait");
  await f.advance(60_001);
  assert.deepEqual(child.writes, ["codex go\r", "please wait"]);
});

test("Codex capacity still continues when the error wraps onto two rows", async (t) => {
  for (const wrapped of [
    "■ Selected model is at capacity. Please\r\n  try a different model.",
    "■ Selected model is at capacity. Please t\r\nry a different model.",
    "■ Selected model is at capacity. Please try a diff\r\nerent model.",
  ]) {
    const f = stallFixture();
    t.after(() => f.host.dispose());
    await f.host.openForBot("bot-1", { label: "W", command: "codex go" });
    f.children[0].data(`\x1b[2J\x1b[H${wrapped}\r\n\r\n› \r\n\x1b[4;3H`);
    await f.settle();
    await f.advance(60_000);
    assert.deepEqual(f.children[0].writes, ["codex go\r", "continue\r"]);
  }
});

test("Codex capacity ignores a menu footer printed before the latest output and prompt", async (t) => {
  const f = stallFixture();
  t.after(() => f.host.dispose());
  await f.host.openForBot("bot-1", { label: "W", command: "codex go" });
  f.children[0].data(`${codexCapacityScreen(`enter select · esc back\r\n\r\n${CODEX_CAPACITY}`)}\x1b[5;3H`);
  await f.settle();
  await f.advance(60_000);
  assert.deepEqual(f.children[0].writes, ["codex go\r", "continue\r"]);
  assert.equal(f.notes.length, 0);
});

test("an identical Codex capacity screen returning before the next stall check posts STALLED", async (t) => {
  const f = trustFixture(t);
  t.after(() => f.host.dispose());
  await f.host.openForBot("bot-1", { label: "W", command: "codex go" });
  const child = f.children[0];
  child.data(codexCapacityScreen());
  await f.advance(10_000);
  await f.advance(60_000);
  assert.deepEqual(child.writes, ["codex go\r", "continue\r"]);
  assert.equal(f.notes.length, 0);
  child.data("\x1b[2J\x1b[H• Working (esc to interrupt)");
  child.data(codexCapacityScreen());
  await f.advance(10_000);
  await f.advance(60_000);
  assert.deepEqual(child.writes, ["codex go\r", "continue\r"]);
  assert.equal(f.notes.length, 1);
  assert.match(f.notes[0].text, /^STALLED: /);
  assert.match(f.notes[0].text, /Selected model is at capacity\./);
  await f.advance(600_000);
  assert.equal(f.notes.length, 1);
});

test("a second Codex capacity hit within ten minutes posts STALLED, then the cooldown expires", async (t) => {
  const f = stallFixture();
  t.after(() => f.host.dispose());
  await f.host.openForBot("bot-1", { label: "W", command: "codex go" });
  const child = f.children[0];
  child.data(codexCapacityScreen());
  await f.settle();
  await f.advance(60_000);
  assert.deepEqual(child.writes, ["codex go\r", "continue\r"]);
  assert.equal(f.notes.length, 0);
  child.data("\x1b[2J\x1b[H• Working (esc to interrupt)");
  await f.advance(599_999);
  child.data(codexCapacityScreen());
  await f.settle();
  await f.advance(60_000);
  assert.deepEqual(child.writes, ["codex go\r", "continue\r"]);
  assert.equal(f.notes.length, 1);
  assert.match(f.notes[0].text, /^STALLED: /);
  assert.match(f.notes[0].text, /Selected model is at capacity\./);
  await f.advance(600_000);
  assert.deepEqual(child.writes, ["codex go\r", "continue\r"]);
  assert.equal(f.notes.length, 1);
  child.data("\x1b[2J\x1b[H• Working (esc to interrupt)");
  await f.advance(1_000);
  child.data(codexCapacityScreen());
  await f.settle();
  await f.advance(60_000);
  assert.deepEqual(child.writes, ["codex go\r", "continue\r", "continue\r"]);
  assert.equal(f.notes.length, 1);
});

test("a worker pane that goes quiet without a report sends one stall note with its last lines", async () => {
  const f = stallFixture();
  const pane = await f.host.openForBot("bot-1", { label: "TAP-AUDIT | Astra | high", command: "codex --model gpt-6-astra 'Read card.md and do it.'" });
  f.children[0].data("■ Conversation interrupted. Tell the model what to do differently.\r\n\r\n  Approaching rate limits\r\n  1. Switch to gpt-6-luna\r\n  2. Keep current model\r\n");
  await f.settle();
  await f.advance(119_000);
  assert.equal(f.notes.length, 0);
  await f.advance(2_000);
  assert.equal(f.notes.length, 1);
  assert.deepEqual(f.notes[0].scope, { pane: pane.sessionId, bot: "bot-1", teacher: "bot-1" });
  assert.deepEqual(f.notes[0].mail, { url: "http://127.0.0.1:9", token: "secret" });
  assert.match(f.notes[0].text, /^STALLED: no screen change for 2 min and no report\./);
  assert.match(f.notes[0].text, /differently\.\n {2}Approaching rate limits\n {2}1\. Switch to gpt-6-luna\n {2}2\. Keep current model$/);
  await f.advance(600_000);
  assert.equal(f.notes.length, 1);
});

for (const echo of ["none", "whole", "split"]) {
  test(`a silent wait loop uses the 30-minute stall backstop: echo ${echo}`, async (t) => {
    const f = stallFixture({ commandEcho: false });
    t.after(() => f.host.dispose());
    const command = "$t=(Get-Date).AddMinutes(20); while((Get-Date) -lt $t){Start-Sleep 30}; codex go";
    await f.host.openForBot("bot-1", { label: "WAIT", command });
    if (echo === "whole") f.children[0].data(`PS C:\\work> ${command}\r\n`);
    if (echo === "split") {
      f.children[0].data("PS C:\\work");
      await f.settle();
      f.children[0].data(`> ${command.slice(0, 30)}`);
      await f.settle();
      f.children[0].data(`${command.slice(30)}\r\n`);
    }
    await f.settle();
    await f.advance(120_000);
    assert.deepEqual(f.notes, []);
    await f.advance(28 * 60_000 - 1);
    assert.deepEqual(f.notes, []);
    await f.advance(1);
    assert.equal(f.notes.length, 1);
    assert.match(f.notes[0].text, /^STALLED: no screen change for 30 min/);
    await f.advance(30 * 60_000);
    assert.equal(f.notes.length, 1);
  });
}

for (const [name, prompt, wrapped] of [
  ["posh whole", " Orbit-cards ›  split  ", false],
  ["posh wrapped", " Orbit-cards ›  split  ", true],
  ["bare >", "> ", false],
]) {
  test(`a wait loop ignores the prompt before its command echo: ${name}`, async (t) => {
    const f = stallFixture({ commandEcho: false });
    t.after(() => f.host.dispose());
    const command = "$t=[datetime]'2026-10-21 01:53'; while((Get-Date) -lt $t){Start-Sleep 30}; codex --model gpt-6.1-sol -c model_reasoning_effort=max";
    await f.host.openForBot("bot-1", { label: "WAIT", command });
    f.children[0].data(`${prompt}${wrapped ? command.replace("gpt-6.1", "gpt-6\r\n.1") : command}\r\n`);
    await f.settle();
    await f.advance(120_000);
    assert.deepEqual(f.notes, []);
    await f.advance(28 * 60_000);
    assert.equal(f.notes.length, 1);
    assert.match(f.notes[0].text, /^STALLED: no screen change for 30 min/);
    f.children[0].data("OpenAI Codex\r\n› Explain this codebase\r\n");
    await f.settle();
    await f.advance(120_000);
    assert.equal(f.notes.length, 2);
    assert.match(f.notes[1].text, /^STALLED: no screen change for 2 min/);
  });
}

for (const prompt of [" Orbit-cards ›  split  ", "> "]) {
  test(`a wait loop ignores prompt text and a partial command echo: ${prompt.trim()}`, async (t) => {
    const f = stallFixture({ commandEcho: false });
    t.after(() => f.host.dispose());
    const command = "$t=[datetime]'2026-10-21 01:53'; while((Get-Date) -lt $t){Start-Sleep 30}; codex --model gpt-6.1-sol";
    await f.host.openForBot("bot-1", { label: "WAIT", command });
    f.children[0].data(prompt);
    await f.settle();
    await f.advance(120_000);
    assert.deepEqual(f.notes, []);
    f.children[0].data(command.slice(0, 70));
    await f.settle();
    await f.advance(120_000);
    assert.deepEqual(f.notes, []);
    f.children[0].data(`${command.slice(70)}\r\n`);
    await f.settle();
    await f.advance(120_000);
    assert.deepEqual(f.notes, []);
    f.children[0].data("\x1b[2J\x1b[HOpenAI Codex\r\n› Explain this codebase\r\n");
    await f.settle();
    await f.advance(120_000);
    assert.equal(f.notes.length, 1);
    assert.match(f.notes[0].text, /^STALLED: no screen change for 2 min/);
  });
}

test("a command echo cleared by its first UI in the same chunk keeps the 2-minute stall", async (t) => {
  const f = stallFixture({ commandEcho: false });
  t.after(() => f.host.dispose());
  const command = "Start-Sleep 300; codex go";
  await f.host.openForBot("bot-1", { label: "WAIT", command });
  f.children[0].data(` Orbit-cards › split ${command}\r\n\x1b[2J\x1b[HOpenAI Codex\r\n› Explain this codebase\r\n`);
  await f.settle();
  await f.advance(120_000);
  assert.equal(f.notes.length, 1);
  assert.match(f.notes[0].text, /^STALLED: no screen change for 2 min/);
});

for (const [engine, screen] of [
  ["claude", "Claude Code\r\n❯ \r\n"],
  ["codex", "OpenAI Codex\r\n› Explain this codebase\r\n"],
  ["grok", "grok-4.5 · 32K / 256K\r\n"],
  ["agy", "  ⣽  Reading file...\r\n"],
  ["muse", "muse-2 · ready\r\n"],
]) {
  test(`${engine} keeps the 2-minute stall threshold after its UI appears`, async (t) => {
    const f = stallFixture();
    t.after(() => f.host.dispose());
    await f.host.openForBot("bot-1", { label: "WAIT", command: `Start-Sleep 300; ${engine} go` });
    await f.advance(120_000);
    assert.deepEqual(f.notes, []);
    f.children[0].data(screen);
    await f.settle();
    f.children[0].data("\x1b[2J\x1b[H");
    await f.settle();
    await f.advance(119_999);
    assert.deepEqual(f.notes, []);
    await f.advance(1);
    assert.equal(f.notes.length, 1);
    assert.match(f.notes[0].text, /^STALLED: no screen change for 2 min/);
  });
}

for (const [engine, ellipsis] of [["agy", "..."], ["gemini", "…"]]) {
  test(`${engine} braille busy tails avoid false stalls and still detect a frozen screen`, async (t) => {
    const f = stallFixture();
    t.after(() => f.host.dispose());
    await f.host.openForBot("bot-1", { label: "W", command: `${engine} go` });
    for (let tick = 0; tick < 8; tick += 1) {
      f.children[0].data(`\r\x1b[2K  ${["⣽", "⣻", "⢿", "⡿"][tick % 4]}  Reading file${ellipsis}`);
      await f.settle();
      await f.advance(30_000);
      assert.equal(f.notes.length, 0);
    }
    await f.advance(89_999);
    assert.equal(f.notes.length, 0);
    await f.advance(1);
    assert.equal(f.notes.length, 1);
    assert.match(f.notes[0].text, /^STALLED: no screen change for 2 min/);
    await f.advance(600_000);
    assert.equal(f.notes.length, 1);
  });
}

test("a Claude idle shell footer repeats STALLED twice on a 30/60-minute backoff", async (t) => {
  const f = stallFixture({ notePane: (mail, scope, text) => postPaneNote(mail, scope, text, async (url, init) => {
    const body = JSON.parse(init.body);
    assert.equal(body.kind, "stall");
    f.host.attendBot(scope.bot, scope.pane, body.kind);
    f.notes.push({ text: body.text });
    return new Response("{}");
  }) });
  t.after(() => f.host.dispose());
  await f.host.openForBot("bot-1", { label: "W", command: "claude go" });
  f.children[0].data(claudeIdle("1 shell").replace("Brewed for 21s · done 6:26 PM", "Churned for 3m 5s · done 오전 7:30"));
  await f.settle();
  await f.advance(31 * 60_000);
  assert.equal(f.notes.length, 1);
  assert.match(f.notes[0].text, /^STALLED: /);
  await f.advance(61 * 60_000);
  assert.equal(f.notes.length, 2);
  assert.match(f.notes[1].text, /^STALLED: no screen change for 92 min/);
  await f.advance(61 * 60_000);
  assert.equal(f.notes.length, 3);
  assert.match(f.notes[2].text, /^STALLED: no screen change for 153 min/);
  await f.advance(240 * 60_000);
  assert.equal(f.notes.length, 3);
  f.children[0].data(claudeIdle("1 shell").replace("Brewed", "Checked"));
  await f.settle();
  await f.advance(31 * 60_000);
  assert.equal(f.notes.length, 4);
  await f.advance(31 * 60_000);
  assert.equal(f.notes.length, 5);
  await f.advance(61 * 60_000);
  assert.equal(f.notes.length, 6);
  await f.advance(240 * 60_000);
  assert.equal(f.notes.length, 6);
});

test("a recorded Claude idle pane with a background shell repeats STALLED", async (t) => {
  const recorded = JSON.parse(fs.readFileSync(new URL("../test/fixtures/recorded/claude/idle-background-shell.json", import.meta.url), "utf8"));
  const f = stallFixture();
  t.after(() => f.host.dispose());
  await f.host.openForBot("bot-1", { label: "W", command: "claude go" });
  f.children[0].data(`\x1b[2J\x1b[H${recorded.reply.screen.join("\r\n")}\r\n`);
  await f.settle();
  await f.advance(31 * 60_000);
  assert.equal(f.notes.length, 1);
  assert.match(f.notes[0].text, /^STALLED: /);
  await f.advance(31 * 60_000);
  assert.equal(f.notes.length, 2);
});

test("a stall receipt counts as delivered when the mailbox response is lost", async (t) => {
  const f = stallFixture({ notePane: async (mail, scope, text) => {
    f.notes.push({ text });
    f.host.attendBot(scope.bot, scope.pane, "stall");
    throw new Error("Mailbox post failed: timeout");
  } });
  t.after(() => f.host.dispose());
  await f.host.openForBot("bot-1", { label: "W", command: "claude go" });
  f.children[0].data(claudeIdle("1 shell"));
  await f.settle();
  await f.advance(31 * 60_000);
  assert.equal(f.notes.length, 1);
  await f.advance(5 * 60_000);
  assert.equal(f.notes.length, 1);
  await f.advance(26 * 60_000);
  assert.equal(f.notes.length, 2);
});

test("a stall receipt leaves the watcher armed and a plain note stops its repeats", async (t) => {
  const f = stallFixture();
  t.after(() => f.host.dispose());
  const pane = await f.host.openForBot("bot-1", { label: "W", command: "claude go" });
  f.children[0].data(claudeIdle("1 shell"));
  await f.settle();
  await f.advance(31 * 60_000);
  assert.equal(f.notes.length, 1);
  await f.advance(1_000);
  f.host.attendBot("bot-1", pane.sessionId, "stall");
  await f.advance(30 * 60_000);
  assert.equal(f.notes.length, 2);
  await f.advance(1_000);
  f.host.attendBot("bot-1", pane.sessionId);
  await f.advance(240 * 60_000);
  assert.equal(f.notes.length, 2);
});

test("STALLED reminders wait 30 minutes and then 60 minutes", async (t) => {
  const f = stallFixture();
  t.after(() => f.host.dispose());
  await f.host.openForBot("bot-1", { label: "W", command: "claude go" });
  f.children[0].data(claudeIdle("1 shell"));
  await f.settle();
  await f.advance(31 * 60_000);
  assert.equal(f.notes.length, 1);
  for (const [minutes, count] of [[30, 1], [60, 2]]) {
    await f.advance(minutes * 60_000);
    assert.equal(f.notes.length, count);
    await f.advance(1);
    assert.equal(f.notes.length, count + 1);
  }
});

test("a report stops pending STALLED repeats", async (t) => {
  const f = stallFixture();
  t.after(() => f.host.dispose());
  const pane = await f.host.openForBot("bot-1", { label: "W", command: "claude go" });
  f.children[0].data(claudeIdle("1 shell"));
  await f.settle();
  await f.advance(31 * 60_000);
  assert.equal(f.notes.length, 1);
  f.host.attendBot("bot-1", pane.sessionId, "report");
  await f.advance(240 * 60_000);
  assert.equal(f.notes.length, 1);
});

const stallThrice = async (f) => {
  await f.host.openForBot("bot-1", { label: "W", command: "claude go" });
  f.children[0].data(claudeIdle("1 shell"));
  await f.settle();
  for (const minutes of [31, 31, 61]) await f.advance(minutes * 60_000);
  assert.equal(f.notes.length, 3);
};

test("a worker still stuck 10 minutes after its third STALLED note sends one stalled snag", async (t) => {
  const snags = [];
  const f = stallFixture({ snag: (snag) => snags.push(snag) });
  t.after(() => f.host.dispose());
  await stallThrice(f);
  await f.advance(10 * 60_000 - 1);
  assert.equal(snags.length, 0);
  await f.advance(1);
  assert.equal(snags.length, 1);
  const { tail, ...rest } = snags[0];
  assert.deepEqual(rest, {
    event: "stalled", key: f.children[0].options.env.ORBIT_PANE, bot: "bot-1", worker: "claude", pane: f.children[0].options.env.ORBIT_PANE, label: "W",
    detail: "3 STALLED notes, no screen change or report since", minutes: 133, notes: [["stalled", 102], ["stalled", 71], ["stalled", 10]],
  });
  assert.match(tail, /bypass permissions on/);
  await f.advance(240 * 60_000);
  assert.equal(snags.length, 1);
});

test("a report or a screen change after the third STALLED note sends no snag", async (t) => {
  for (const settle of ["report", "screen"]) {
    const snags = [];
    const f = stallFixture({ snag: (snag) => snags.push(snag) });
    t.after(() => f.host.dispose());
    await stallThrice(f);
    if (settle === "report") f.host.attendBot("bot-1", f.children[0].options.env.ORBIT_PANE, "report");
    else f.children[0].data(claudeIdle("1 shell").replace("Brewed", "Checked"));
    await f.advance(20 * 60_000);
    assert.deepEqual(snags, [], settle);
  }
});

test("a STALLED note that fails five times sends a note-lost snag", async (t) => {
  const snags = [];
  const f = stallFixture({ failures: 99, snag: (snag) => snags.push(snag) });
  t.after(() => f.host.dispose());
  await f.host.openForBot("bot-1", { label: "W", command: "codex --model gpt-6-astra 'go'" });
  f.children[0].data("■ You've hit your usage limit. Try again at 10:14 PM.\r\n");
  await f.settle();
  await f.advance(121_000);
  for (let i = 0; i < 3; i++) await f.advance(61_000);
  assert.equal(snags.length, 0);
  await f.advance(61_000);
  assert.deepEqual(snags.map((snag) => [snag.event, snag.detail, snag.worker]), [["note-lost", "a STALLED note failed 5 times", "codex"]]);
  assert.match(snags[0].tail, /usage limit/);
});

test("a successful retry before signal polling does not send a false note-lost snag", async (t) => {
  const snags = [];
  const f = stallFixture({ snag: (snag) => snags.push(snag) });
  t.after(() => f.host.dispose());
  const pane = await f.host.openForBot("bot-1", { label: "W", command: "claude go" });
  f.children[0].data("\x1b[2J\x1b[H✻ Working… (5s · esc to interrupt)\r\n");
  const signal = f.children[0].options.env.ORBIT_REPORT_SIGNAL;
  fs.writeFileSync(signal, "failed before retry");
  fs.utimesSync(signal, new Date(Date.UTC(2026, 9, 4)), new Date(Date.UTC(2026, 9, 4)));
  f.host.attendBot("bot-1", pane.sessionId, "report");
  await f.advance(1000);
  await f.advance(10 * 60_000);
  assert.deepEqual(snags, []);
});

test("repeated report failures retain the earliest pending deadline", async (t) => {
  const snags = [];
  const f = stallFixture({ snag: (snag) => snags.push(snag) });
  t.after(() => f.host.dispose());
  await f.host.openForBot("bot-1", { label: "W", command: "claude go" });
  f.children[0].data("\x1b[2J\x1b[H✻ Working… (5s · esc to interrupt)\r\n");
  const signal = f.children[0].options.env.ORBIT_REPORT_SIGNAL;
  fs.writeFileSync(signal, "first failure");
  await f.settle();
  await f.advance(9 * 60_000);
  fs.writeFileSync(signal, "second failure");
  await f.settle();
  await f.advance(60_000);
  assert.deepEqual(snags.map((s) => [s.event, s.detail]), [["note-lost", "first failure"]]);
});

test("a delayed signal uses the failure time instead of the polling time", async (t) => {
  const snags = [];
  const f = stallFixture({ snag: (snag) => snags.push(snag) });
  t.after(() => f.host.dispose());
  await f.host.openForBot("bot-1", { label: "W", command: "claude go" });
  f.children[0].data("\x1b[2J\x1b[H✻ Working… (5s · esc to interrupt)\r\n");
  const signal = f.children[0].options.env.ORBIT_REPORT_SIGNAL;
  fs.writeFileSync(signal, "delayed failure");
  const failedAt = new Date(Date.UTC(2026, 9, 4) - 9 * 60_000);
  fs.utimesSync(signal, failedAt, failedAt);
  await f.settle();
  await f.advance(60_000);
  assert.deepEqual(snags.map((s) => [s.event, s.detail]), [["note-lost", "delayed failure"]]);
});

test("a failed report with no later report sends a note-lost snag after 10 minutes", async (t) => {
  for (const reported of [false, true]) {
    const snags = [];
    const f = stallFixture({ snag: (snag) => snags.push(snag) });
    t.after(() => f.host.dispose());
    const pane = await f.host.openForBot("bot-1", { label: "W", command: "claude go" });
    const signal = f.children[0].options.env.ORBIT_REPORT_SIGNAL;
    assert.equal(signal, path.join(os.tmpdir(), `orbit-report-${pane.sessionId}`));
    f.children[0].data("\x1b[2J\x1b[H✻ Working… (5s · esc to interrupt)\r\n");
    fs.writeFileSync(signal, "orbit-msg: Wink did not answer in 10s");
    await f.settle();
    assert.equal(fs.existsSync(signal), false);
    if (reported) f.host.attendBot("bot-1", pane.sessionId, "report");
    await f.advance(10 * 60_000);
    assert.deepEqual(snags.map((snag) => [snag.event, snag.detail]), reported ? [] : [["note-lost", "orbit-msg: Wink did not answer in 10s"]]);
  }
});

for (const jobs of ["1 shell", "2 shells, 1 monitor"]) {
  test(`a Claude running-shell footer stalls after 30 minutes despite status ticks: ${jobs}`, async (t) => {
    const f = stallFixture();
    t.after(() => f.host.dispose());
    await f.host.openForBot("bot-1", { label: "W", command: "claude go" });
    f.children[0].data(`${claudeIdle(jobs)}  96% context left · 12:01 PM\r\n`);
    await f.settle();
    await f.advance(120_000);
    assert.equal(f.notes.length, 0);
    await f.advance(13 * 60_000);
    f.children[0].data(`${claudeIdle(jobs)}  95% context left · 12:16 PM\r\n`);
    await f.settle();
    await f.advance(15 * 60_000 - 1);
    assert.equal(f.notes.length, 0);
    await f.advance(1);
    assert.equal(f.notes.length, 1);
    assert.match(f.notes[0].text, /^STALLED: no screen change for 30 min/);
    f.children[0].data(`${claudeIdle(jobs)}  94% context left · 12:31 PM\r\n`);
    await f.settle();
    await f.advance(30 * 60_000);
    assert.equal(f.notes.length, 1);
    f.children[0].data(claudeIdle().replace("done 6:26 PM", `done 6:26 PM · ${jobs} still running`));
    await f.settle();
    await f.advance(119_999);
    assert.equal(f.notes.length, 1);
    await f.advance(1);
    assert.equal(f.notes.length, 2);
    assert.match(f.notes[1].text, /^STALLED: no screen change for 2 min/);
  });
}

test("a Claude agent row that keeps changing holds the stall note until the screen freezes", async (t) => {
  const f = stallFixture();
  t.after(() => f.host.dispose());
  await f.host.openForBot("bot-1", { label: "W", command: "claude go" });
  for (let step = 0; step < 12; step += 1) {
    f.children[0].data(claudeAgentWait([AGENT_ROWS[step % 2]]));
    await f.settle();
    await f.advance(5 * 60_000);
    assert.equal(f.notes.length, 0);
  }
  await f.advance(25 * 60_000 - 1);
  assert.equal(f.notes.length, 0);
  await f.advance(1);
  assert.equal(f.notes.length, 1);
  assert.match(f.notes[0].text, /^STALLED: no screen change for 30 min/);
});

for (const [name, screen, minutes] of [
  ["a long agent list", claudeAgentWait(Array(6).fill(AGENT_ROWS[0])).replace("Waiting for 1 background agent to finish", "Brewed for 21s · done 10:41 PM"), 30],
  ["its background agent wait", claudeAgentWait([]).replace(" · 3 shells", ""), 30],
  ["an old background agent wait above a finished turn", claudeIdle().replace("✻ Brewed", "✻ Waiting for 1 background agent to finish\r\n\r\n● The measure agent finished; report sent.\r\n\r\n✻ Brewed"), 2],
  ["an old agent list above its input box", claudeAgentWait().replace("Waiting for 1 background agent to finish", "Brewed for 21s · done 10:41 PM") + claudeIdle().replace("\x1b[2J\x1b[H", ""), 2],
  ["an old background agent wait above its input box", claudeAgentWait() + claudeIdle().replace("\x1b[2J\x1b[H", ""), 2],
]) {
  test(`a Claude pane idle on ${name} stalls after ${minutes} min`, async (t) => {
    const f = stallFixture();
    t.after(() => f.host.dispose());
    await f.host.openForBot("bot-1", { label: "W", command: "claude go" });
    f.children[0].data(screen);
    await f.settle();
    await f.advance(minutes * 60_000 - 1);
    assert.equal(f.notes.length, 0);
    await f.advance(1);
    assert.equal(f.notes.length, 1);
    assert.match(f.notes[0].text, new RegExp(`^STALLED: no screen change for ${minutes} min`));
    await f.advance(30 * 60_000);
    assert.equal(f.notes.length, 1);
  });
}

const CLAUDE_LIMIT = "  ⎿  You've hit your session limit · resets 3am (Asia/Seoul)\r\n\r\n  What do you want to do?\r\n  ❯ 1. Stop and wait for limit to reset\r\n    2. Upgrade your plan\r\n";
const CODEX_LIMIT = "■ You’ve hit your usage limit. Upgrade to Pro (https://chatgpt.com/explore/pro), visit https://chatgpt.com/\r\ncodex/settings/usage to purchase more credits or try again at 10:14 PM.\r\n\r\n\r\n  Approaching rate limits\r\n  Switch to gpt-6-luna for lower credit usage?\r\n\r\n\r\n› 1. Switch to gpt-6-luna                   Fast and affordable model for easier tasks.\r\n  2. Keep current model\r\n";
const limitNote = (engine, reset, next = 'Send "continue" after the reset, or move the job to another engine') => new RegExp(`^LIMIT: ${engine} hit its usage limit \\(resets ${reset}\\)\\. Its work so far stays in .+\\. ${next}\\.$`);

for (const [name, command, screen, attended, count] of [
  ["a busy worker", "claude go", "✻ Working… (1s · esc to interrupt)", false, 1],
  ["a WAITING menu", "claude go", "Do you want to proceed?\r\n❯ 1. Yes\r\n  2. No", true, 0],
  ["a usage limit", "claude go", CLAUDE_LIMIT, false, 1],
  ["Codex capacity", "codex go", codexCapacityScreen(), false, 0],
]) {
  test(`STALLED reminders leave ${name} alone`, async (t) => {
    const f = stallFixture();
    t.after(() => f.host.dispose());
    const pane = await f.host.openForBot("bot-1", { label: "W", command });
    f.children[0].data(screen);
    await f.settle();
    if (attended) f.host.attendBot("bot-1", pane.sessionId);
    await f.advance(121_000);
    assert.equal(f.notes.length, count);
    const writes = [...f.children[0].writes];
    await f.advance(240 * 60_000);
    assert.equal(f.notes.length, count);
    assert.deepEqual(f.children[0].writes, writes);
  });
}

test("ordinary Markdown ellipses do not discard a completion note", async (t) => {
  const f = stallFixture();
  t.after(() => f.host.dispose());
  const pane = await f.host.openForBot("bot-1", { label: "W", command: "codex go" });
  f.children[0].data("  * Waiting for input...\r\n");
  f.host.attendBot("bot-1", pane.sessionId, "auto", "all green");
  await f.advance(90_000);
  assert.equal(f.notes.length, 1);
  assert.equal(f.notes[0].text, "all green");
});

test("percentage-only shell progress keeps the worker moving", async (t) => {
  const f = stallFixture();
  t.after(() => f.host.dispose());
  await f.host.openForBot("bot-1", { label: "W", command: "codex go" });
  for (const percent of [12, 13, 14, 15]) {
    f.children[0].data(`\r\x1b[2KDownloading archive ${percent}%`);
    await f.settle();
    await f.advance(70_000);
    assert.equal(f.notes.length, 0);
  }
  await f.advance(50_000);
  assert.equal(f.notes.length, 1);
});

test("a Claude reset excludes an adjacent menu without a blank row", async (t) => {
  const f = stallFixture();
  t.after(() => f.host.dispose());
  await f.host.openForBot("bot-1", { label: "W", command: "claude go" });
  f.children[0].data(CLAUDE_LIMIT.replace("\r\n\r\n", "\r\n"));
  await f.settle();
  await f.advance(120_000);
  assert.equal(f.notes.length, 1);
  assert.match(f.notes[0].text, limitNote("Claude", "3am \\(Asia/Seoul\\)"));
});

for (const [engine, screen, reset, nextReset] of [
  ["claude", CLAUDE_LIMIT, "3am (Asia/Seoul)", "4am (Asia/Seoul)"],
  ["codex", CODEX_LIMIT, "10:14 PM", "11:14 PM"],
]) {
  test(`${engine} selects the newest visible reset`, async (t) => {
    const f = stallFixture();
    t.after(() => f.host.dispose());
    await f.host.openForBot("bot-1", { label: "W", command: `${engine} go` });
    f.children[0].data(screen);
    await f.settle();
    await f.advance(120_000);
    assert.equal(f.notes.length, 1);
    f.children[0].data(screen.replace(reset, nextReset));
    await f.settle();
    await f.advance(120_000);
    assert.equal(f.notes.length, 2);
    assert.ok(f.notes[1].text.includes(`resets ${nextReset}`));
  });
}

test("a limit screen bypasses the live-shell hold", async (t) => {
  const f = stallFixture();
  t.after(() => f.host.dispose());
  await f.host.openForBot("bot-1", { label: "W", command: "claude go" });
  f.children[0].data(`${CLAUDE_LIMIT}\r\n⏵⏵ bypass permissions on · 1 shell · ← for agents\r\n`);
  await f.settle();
  await f.advance(120_000);
  assert.equal(f.notes.length, 1);
  assert.match(f.notes[0].text, /^LIMIT: /);
});

test("resumed output below an old limit stays live and later stalls normally", async (t) => {
  const f = stallFixture();
  t.after(() => f.host.dispose());
  await f.host.openForBot("bot-1", { label: "W", command: "claude go" });
  f.children[0].data(CLAUDE_LIMIT);
  await f.settle();
  for (let step = 0; step < 4; step += 1) {
    await f.advance(60_000);
    assert.equal(f.notes.length, 0);
    f.children[0].data(`● Edited file ${step}\r\n`);
    await f.settle();
  }
  await f.advance(120_000);
  assert.equal(f.notes.length, 1);
  assert.match(f.notes[0].text, /^STALLED: /);
});

test("a Claude usage limit sends one LIMIT note with the reset time as shown", async () => {
  const f = stallFixture();
  const pane = await f.host.openForBot("bot-1", { label: "W", command: "claude --model claude-opus-5-5 'go'" });
  f.children[0].data(CLAUDE_LIMIT);
  await f.settle();
  await f.advance(121_000);
  assert.equal(f.notes.length, 1);
  assert.match(f.notes[0].text, limitNote("Claude", "3am \\(Asia/Seoul\\)"));
  assert.ok(f.notes[0].text.includes(os.tmpdir()));
  assert.equal(f.notes[0].scope.pane, pane.sessionId);
  await f.advance(600_000);
  assert.equal(f.notes.length, 1);
});

test("a Codex usage limit that wraps sends one LIMIT note with the reset time as shown", async () => {
  const f = stallFixture();
  await f.host.openForBot("bot-1", { label: "W", command: "codex --model gpt-6-astra 'go'" });
  f.children[0].data(CODEX_LIMIT);
  await f.settle();
  await f.advance(121_000);
  assert.equal(f.notes.length, 1);
  assert.match(f.notes[0].text, limitNote("Codex", "10:14 PM"));
  await f.advance(600_000);
  assert.equal(f.notes.length, 1);
});

test("a Codex usage limit with its reset on a later line sends a LIMIT note", async () => {
  const f = stallFixture();
  await f.host.openForBot("bot-1", { label: "W", command: "codex --model gpt-6-astra 'go'" });
  f.children[0].data("■ You’ve hit your usage limit. Upgrade to Pro (https://chatgpt.com/explore/pro), visit\r\nhttps://chatgpt.com/codex/settings/usage to purchase more credits or try again at 5:49 AM.\r\n");
  await f.settle();
  await f.advance(121_000);
  assert.match(f.notes[0].text, limitNote("Codex", "5:49 AM"));
});

for (const [name, command, screen] of [
  ["a diff line quoting the Claude sentence", "claude go", "+// Claude example: You've hit your session limit · resets 3pm (Asia/Seoul)\r\n"],
  ["a grep hit quoting the Codex sentence", "claude go", "tests/limits.ts:12: ■ You've hit your usage limit. Upgrade your plan or try again at 5:49 AM.\r\n"],
  ["a chat log line quoting the Claude sentence", "claude go", "User: Yesterday the CLI said You've hit your session limit · resets 3pm (Asia/Seoul)\r\n"],
  ["the Codex limit screen on a Claude pane", "claude go", CODEX_LIMIT],
  ["the Claude limit screen on a Codex pane", "codex go", CLAUDE_LIMIT],
  ["the Claude limit screen on another engine's pane", "gemini go", CLAUDE_LIMIT],
]) {
  test(`${name} sends a STALLED note, not LIMIT`, async () => {
    const f = stallFixture();
    await f.host.openForBot("bot-1", { label: "W", command });
    f.children[0].data(screen);
    await f.settle();
    await f.advance(121_000);
    assert.equal(f.notes.length, 1);
    assert.match(f.notes[0].text, /^STALLED: /);
  });
}

test("a limit screen that only redraws a clock, wraps differently or gets keys sends no second note", async () => {
  const f = stallFixture();
  const pane = await f.host.openForBot("bot-1", { label: "W", command: "codex --model gpt-6-astra 'go'" });
  f.children[0].data(`${CODEX_LIMIT}\r\n  gpt-6-astra high · 12:01 PM\r\n`);
  await f.settle();
  await f.advance(121_000);
  assert.equal(f.notes.length, 1);
  f.children[0].data(`\x1b[2J\x1b[H${CODEX_LIMIT}\r\n  gpt-6-astra high · 12:03 PM\r\n`);
  await f.settle();
  await f.advance(130_000);
  f.host.resize(f.event, pane.sessionId, 50, 24);
  await f.advance(5_000);
  f.children[0].data("\x1b[2J\x1b[H■ You’ve hit your usage limit. Upgrade to Pro\r\n(https://chatgpt.com/explore/pro), visit\r\nhttps://chatgpt.com/codex/settings/usage to\r\npurchase more credits or try again at 10:14 PM.\r\n\r\n\r\n  Approaching rate limits\r\n  Switch to gpt-6-luna for lower credit usage?\r\n\r\n\r\n› 1. Switch to gpt-6-luna\r\n  Fast and affordable model for easier tasks.\r\n  2. Keep current model\r\n\r\n  gpt-6-astra high · 12:05 PM\r\n");
  await f.settle();
  await f.advance(130_000);
  f.host.sendBot("bot-1", { sessionId: pane.sessionId, generation: pane.generation, text: "\r" });
  await f.advance(600_000);
  assert.equal(f.notes.length, 1);
});

for (const [engine, screen, reset, nextReset] of [
  ["claude", CLAUDE_LIMIT, "3am (Asia/Seoul)", "4am (Asia/Seoul)"],
  ["codex", CODEX_LIMIT, "10:14 PM", "11:14 PM"],
]) {
  test(`${engine} LIMIT notes stay once per reset across ticks, resizes and resumed turns`, async (t) => {
    const f = stallFixture();
    t.after(() => f.host.dispose());
    const pane = await f.host.openForBot("bot-1", { label: "W", command: `${engine} go` });
    f.children[0].data(`${screen}\r\n  96% context left\r\n`);
    await f.settle();
    await f.advance(120_000);
    assert.equal(f.notes.length, 1);
    assert.match(f.notes[0].text, /^LIMIT: /);
    f.children[0].data(`\x1b[2J\x1b[H${screen}\r\n  95% context left\r\n`);
    await f.settle();
    await f.advance(120_000);
    assert.equal(f.notes.length, 1);
    for (const cols of [50, 100]) {
      f.host.resize(f.event, pane.sessionId, cols, 24);
      await f.advance(5_000);
      f.children[0].data(`\x1b[2J\x1b[H${screen}\r\n  94% context left\r\n`);
      await f.settle();
      await f.advance(120_000);
      assert.equal(f.notes.length, 1);
    }
    f.host.sendBot("bot-1", { ...pane, text: "continue\r" });
    f.children[0].data("\x1b[2J\x1b[HWorking again\r\n");
    await f.settle();
    await f.advance(10_000);
    f.children[0].data(`\x1b[2J\x1b[H${screen}`);
    await f.settle();
    await f.advance(120_000);
    assert.equal(f.notes.length, 1);
    f.children[0].data(`\x1b[2J\x1b[H${screen.replace(reset, nextReset)}`);
    await f.settle();
    await f.advance(119_999);
    assert.equal(f.notes.length, 1);
    await f.advance(1);
    assert.equal(f.notes.length, 2);
    assert.ok(f.notes[1].text.includes(`resets ${nextReset}`));
    f.children[0].data(`\x1b[2J\x1b[H${screen}`);
    await f.settle();
    await f.advance(120_000);
    assert.equal(f.notes.length, 2);
    await f.host.openForBot("bot-1", { label: "W2", command: `${engine} go` });
    f.children[1].data(screen);
    await f.settle();
    await f.advance(120_000);
    assert.equal(f.notes.length, 3);
    assert.notEqual(f.notes[2].scope.pane, pane.sessionId);
  });
}

test("a limit pane that resumes after continue and stalls again sends a new note", async () => {
  const f = stallFixture();
  const pane = await f.host.openForBot("bot-1", { label: "W", command: "claude --model claude-opus-5-5 'go'" });
  f.children[0].data(CLAUDE_LIMIT);
  await f.settle();
  await f.advance(121_000);
  assert.equal(f.notes.length, 1);
  f.host.sendBot("bot-1", { sessionId: pane.sessionId, generation: pane.generation, text: "continue\r" });
  f.children[0].data("\x1b[2J\x1b[H● Editing src/app.ts\r\n● API Error: 529 overloaded\r\n");
  await f.settle();
  await f.advance(121_000);
  assert.equal(f.notes.length, 2);
  assert.match(f.notes[1].text, /^STALLED: .*API Error: 529 overloaded$/s);
  await f.advance(600_000);
  assert.equal(f.notes.length, 2);
});

const claudeAutoLimit = (usage = "2% (1h12m) │ 7d: ▰▰▰▰▱ 78% (6h52m) │ 2h26m") => `\x1b[2J\x1b[H● Bash(bash /c/Users/mredw/AppData/Local/Temp/wink-USAGE-HOVER/wait-lock.sh 0)\r\n  ⎿  Error: Exit code 1\r\n     NOT YET 20:07:31: lock PASTE-VERIFY 20:07\r\n  ⎿  You've hit your session limit · resets 9:20pm (Asia/Seoul)\r\n● Usage limit reached · continuing automatically at 9:20pm · esc to cancel\r\n✻ Brewed for 48m 48s · done 8:07 PM\r\n${"─".repeat(120)}\r\n> \r\n${"─".repeat(120)}\r\n  ⚠ Usage limit reached · limit resets 9:20pm\r\n    Continuing automatically at 9:20pm · esc to cancel · /usage-credits to continue now\r\n  ◆ Opus 5.5 │ usage-hover/fix/usage-hover${" ".repeat(66)}/rc failed\r\n  ▰▰▰▱▱ 53% │ ↑139.6k ↓163 │ 5h: ▱▱▱▱▱ ${usage}\r\n  ctx 140k/300k\r\n  ⏵⏵ bypass permissions on (shift+tab to cycle)\r\n`;
const CLAUDE_MANUAL_LIMIT = `\x1b[2J\x1b[Hlimit · resets 9:20pm (Asia/Seoul) (error type rate_limit, HTTP 429, request id req_011CgNrEtMBCtkZDv9jx7Xf1, model sent\r\nto the API: claude-opus-5-5)\r\n● Agent "Part C1: polish inventory" failed: Agent terminated early due to an API error: You've hit your session limit ·\r\nresets 9:20pm (Asia/Seoul) (error type rate_limit, HTTP 429, request id req_011CgNrKaAg3LJhMWM4oo2DL, model sent to the\r\nAPI: claude-sonnet-5-5)\r\n  ⎿  You've hit your session limit · resets 9:20pm (Asia/Seoul)\r\n     /usage-credits to finish what you’re working on.\r\n✻ Cogitated for 23m 39s · done 8:14 PM · 1 shell still running\r\n${"─".repeat(120)}\r\n> \r\n${"─".repeat(120)}\r\n  ◆ Fable 5.1 │ oss-audit/HEAD${" ".repeat(85)}/rc\r\n  ▰▰▱▱▱ 39% │ ↑181.6k ↓3.4k │ 5h: ▱▱▱▱▱ 0% (1h4m) │ 7d: ▰▰▰▰▱ 77% (6h44m) │ 23m42s\r\n  ctx 182k/300k\r\n  ⏵⏵ bypass permissions on · 1 shell\r\n`;

for (const [name, screen, next] of [
  ["a Claude limit pause that continues by itself", claudeAutoLimit(), "It resumes by itself at 9:20pm"],
  ["the same pause later in its wait", claudeAutoLimit("0% (20m) │ 7d: ▰▰▰▰▱ 77% (6h) │ 3h18m"), "It resumes by itself at 9:20pm"],
  ["a Claude limit pause that waits for the user", CLAUDE_MANUAL_LIMIT, undefined],
  ["a Claude limit pause over three background agents", `${claudeAutoLimit()}\r\n  ● main\r\n${[...AGENT_ROWS, AGENT_ROWS[0]].map((row) => `  ${row}\r\n`).join("")}`, "It resumes by itself at 9:20pm"],
]) {
  test(`${name} sends one LIMIT note`, async (t) => {
    const f = stallFixture();
    t.after(() => f.host.dispose());
    await f.host.openForBot("bot-1", { label: "W", command: "claude go" });
    f.children[0].data(screen);
    await f.settle();
    await f.advance(120_000);
    assert.equal(f.notes.length, 1);
    assert.match(f.notes[0].text, limitNote("Claude", "9:20pm \\(Asia/Seoul\\)", next));
    await f.advance(30 * 60_000);
    assert.equal(f.notes.length, 1);
  });
}

test("a Claude limit pause sends nothing more when its status line changes", async (t) => {
  const f = stallFixture();
  t.after(() => f.host.dispose());
  await f.host.openForBot("bot-1", { label: "W", command: "claude go" });
  f.children[0].data(claudeAutoLimit());
  await f.settle();
  await f.advance(120_000);
  assert.equal(f.notes.length, 1);
  f.children[0].data(claudeAutoLimit("0% (20m) │ 7d: ▰▰▰▰▱ 77% (6h) │ 3h18m"));
  await f.settle();
  await f.advance(30 * 60_000);
  assert.equal(f.notes.length, 1);
});

test("readBot gives each pane its last screen change as the stall watcher saw it", async (t) => {
  const f = stallFixture();
  t.after(() => f.host.dispose());
  await f.host.openForBot("bot-1", { label: "W", command: "codex --model gpt-6-astra 'go'" });
  f.children[0].data(`${CODEX_LIMIT}\r\n  gpt-6-astra high · 12:01 PM\r\n`);
  await f.settle();
  const limited = f.host.readBot("bot-1");
  assert.equal(limited.panes[0].changedAt, limited.capturedAt);
  await f.advance(121_000);
  assert.equal(f.notes.length, 1);
  f.children[0].data(`\x1b[2J\x1b[H${CODEX_LIMIT}\r\n  gpt-6-astra high · 12:03 PM\r\n`);
  await f.advance(10_000);
  assert.equal(f.host.readBot("bot-1").panes[0].changedAt, limited.capturedAt);
  f.children[0].data("\x1b[2J\x1b[H• Editing src/app.ts\r\n");
  await f.advance(10_000);
  const moved = f.host.readBot("bot-1");
  assert.equal(moved.panes[0].changedAt, moved.capturedAt);
  assert.equal(moved.capturedAt - limited.capturedAt, 141_000);
  assert.equal(f.notes.length, 1);
});

test("a bot input into a limit pause keeps its last screen change and still restarts the stall clock", async (t) => {
  const f = stallFixture();
  t.after(() => f.host.dispose());
  const pane = await f.host.openForBot("bot-1", { label: "W", command: "claude go" });
  const send = (text) => f.host.sendBot("bot-1", { sessionId: pane.sessionId, generation: pane.generation, text });
  f.children[0].data(claudeAutoLimit());
  await f.settle();
  const limited = f.host.readBot("bot-1");
  assert.equal(limited.panes[0].changedAt, limited.capturedAt);
  await f.advance(120_000);
  assert.equal(f.notes.length, 1);
  send("continue\r");
  await f.advance(10_000);
  assert.equal(f.host.readBot("bot-1").panes[0].changedAt, limited.capturedAt);
  f.children[0].data("\x1b[2J\x1b[H● Editing src/app.ts\r\n");
  await f.advance(10_000);
  const moved = f.host.readBot("bot-1");
  assert.equal(moved.panes[0].changedAt, moved.capturedAt);
  await f.advance(60_000);
  send("go on\r");
  await f.advance(120_000 - 1);
  assert.equal(f.host.readBot("bot-1").panes[0].changedAt, moved.capturedAt);
  assert.equal(f.notes.length, 1);
  await f.advance(1);
  assert.equal(f.notes.length, 2);
  assert.match(f.notes[1].text, /^STALLED: /);
});

test("a turn resumed under an old limit box moves its screen and later stalls as STALLED", async (t) => {
  const f = stallFixture();
  t.after(() => f.host.dispose());
  await f.host.openForBot("bot-1", { label: "W", command: "claude go" });
  f.children[0].data(claudeAutoLimit());
  await f.settle();
  await f.advance(120_000);
  assert.equal(f.notes.length, 1);
  f.children[0].data(`● Editing src/app.ts\r\n${"─".repeat(120)}\r\n> \r\n${"─".repeat(120)}\r\n  ⏵⏵ bypass permissions on (shift+tab to cycle)\r\n`);
  await f.advance(10_000);
  const moved = f.host.readBot("bot-1");
  assert.equal(moved.panes[0].changedAt, moved.capturedAt);
  await f.advance(120_000);
  assert.equal(f.notes.length, 2);
  assert.match(f.notes[1].text, /^STALLED: /);
});

test("a worker whose screen keeps changing sends no stall note", async () => {
  const f = stallFixture();
  await f.host.openForBot("bot-1", { label: "W", command: "$env:ORBIT_PANE=$null; & 'C:\\Tools\\claude.cmd' --model claude-sonnet-5-5 'go'" });
  for (let second = 0; second < 600; second += 10) {
    f.children[0].data(`\r✻ Running… (${second}s · esc to interrupt)`);
    await f.settle();
    await f.advance(10_000);
  }
  assert.equal(f.notes.length, 0);
});

test("script panes and engine names inside other commands never send a stall note", async () => {
  const f = stallFixture();
  await f.host.openForBot("bot-1", { label: "VERIFY", command: "pnpm exec vitest run src/claude-launch.test.ts" });
  await f.host.openForBot("bot-1", { label: "LOG", command: "git log --oneline | Select-String codex" });
  f.children[0].data("Tests 12 passed\r\n");
  f.children[1].data("abc1234 fix codex\r\n");
  await f.settle();
  await f.advance(600_000);
  assert.equal(f.notes.length, 0);
});

test("a report or a hook note as the screen settles holds the stall note until the next stop", async () => {
  const f = stallFixture();
  const pane = await f.host.openForBot("bot-1", { label: "W", command: "claude --model claude-opus-5-5 'go'" });
  f.children[0].data("● DONE\r\n");
  await f.settle();
  f.host.attendBot("bot-1", pane.sessionId, "report");
  await f.advance(600_000);
  assert.equal(f.notes.length, 0);
  f.host.sendBot("bot-1", { sessionId: pane.sessionId, generation: pane.generation, text: "Read follow-up.md and do it.\r" });
  f.children[0].data("● Which branch should I use?\r\n");
  await f.settle();
  f.host.attendBot("bot-1", pane.sessionId, "auto");
  await f.advance(600_000);
  assert.equal(f.notes.length, 0);
  f.children[0].data("● API Error: 529 overloaded\r\n");
  await f.settle();
  await f.advance(121_000);
  assert.equal(f.notes.length, 1);
  assert.match(f.notes[0].text, /API Error: 529 overloaded$/);
});

test("a hook note from before the teacher's answer does not hold the next task's stall note", async () => {
  const f = stallFixture();
  const pane = await f.host.openForBot("bot-1", { label: "W", command: "claude --model claude-opus-5-5 'go'" });
  f.children[0].data("Do you want to proceed with this command?\r\n❯ 1. Yes\r\n  2. No\r\n");
  await f.settle();
  f.host.attendBot("bot-1", pane.sessionId);
  await f.advance(10_000);
  f.host.sendBot("bot-1", { sessionId: pane.sessionId, generation: pane.generation, text: "1\r" });
  f.children[0].data("\x1b[2J\x1b[H● Bash(pnpm build)\r\n  ⎿  Running…\r\n");
  await f.settle();
  await f.advance(121_000);
  assert.equal(f.notes.length, 1);
  assert.match(f.notes[0].text, /Running…$/);
});

test("a stall note that fails to post goes out on a later check", async () => {
  const f = stallFixture({ failures: 2 });
  await f.host.openForBot("bot-1", { label: "W", command: "codex --model gpt-6-astra 'go'" });
  f.children[0].data("■ You've hit your usage limit. Try again at 10:14 PM.\r\n");
  await f.settle();
  await f.advance(121_000);
  await f.advance(61_000);
  assert.equal(f.notes.length, 0);
  await f.advance(61_000);
  assert.equal(f.notes.length, 1);
  await f.advance(600_000);
  assert.equal(f.notes.length, 1);
});

test("a prompt redrawn after a resize does not send a stall note after its waiting note", async () => {
  const f = stallFixture();
  const pane = await f.host.openForBot("bot-1", { label: "W", command: "claude --model claude-opus-5-5 'go'" });
  f.children[0].data("Do you want to proceed with this command?\r\n❯ 1. Yes\r\n  2. No\r\n");
  await f.settle();
  f.host.attendBot("bot-1", pane.sessionId);
  await f.advance(40_000);
  f.host.resize(f.event, pane.sessionId, 40, 24);
  f.children[0].data("\x1b[2J\x1b[HDo you want to proceed with\r\nthis command?\r\n❯ 1. Yes\r\n  2. No\r\n");
  await f.settle();
  await f.advance(600_000);
  assert.equal(f.notes.length, 0);
});

test("opening the panel attaches to the pre-started main shell instead of spawning a second", async () => {
  const f = fixture();
  assert.equal(await f.host.prestart(f.event, { botId: "bot-1", cols: 100, rows: 30, projectCwd: null }), true);
  assert.equal(f.children.length, 1);
  assert.deepEqual([f.children[0].options.cols, f.children[0].options.rows], [100, 30]);
  f.children[0].data("PS> ");
  const shown = await f.host.open(f.event, { ...f.input, projectCwd: null });
  assert.equal(f.children.length, 1);
  assert.equal(shown.output, "PS> ");
  f.host.resize(f.event, shown.id, 80, 24);
  assert.deepEqual(f.children[0].sizes, [[80, 24]]);
});

test("an open during a pre-start joins it and claims the shell", async () => {
  const f = fixture({ prestartIdleMs: 20 });
  const [started, shown] = await Promise.all([f.host.prestart(f.event, { botId: "bot-1", cols: 100, rows: 30 }), f.host.open(f.event, f.input)]);
  assert.equal(started, true);
  assert.equal(f.children.length, 1);
  await wait(40);
  assert.equal(f.children[0].killed, false);
  assert.equal(f.host.readBot("bot-1").sessionId, shown.id);
});

test("pre-start skips a bot that already has a main shell, live or exited", async () => {
  const f = fixture();
  await f.host.open(f.event, f.input);
  assert.equal(await f.host.prestart(f.event, { botId: "bot-1", cols: 80, rows: 24 }), false);
  f.children[0].exit({ exitCode: 0 });
  assert.equal(await f.host.prestart(f.event, { botId: "bot-1", cols: 80, rows: 24 }), false);
  assert.equal(f.children.length, 1);
});

test("keeps at most three never-shown pre-starts, retiring the oldest", async () => {
  let clock = 0;
  const f = fixture({ now: () => clock });
  for (const botId of ["bot-1", "bot-2", "bot-3"]) {
    clock += 1;
    await f.host.prestart(f.event, { botId, cols: 80, rows: 24 });
  }
  await f.host.open(f.event, { ...f.input, botId: "bot-2" });
  clock += 1;
  await f.host.prestart(f.event, { botId: "bot-4", cols: 80, rows: 24 });
  assert.deepEqual(f.children.map((child) => child.killed), [false, false, false, false]);
  clock += 1;
  await f.host.prestart(f.event, { botId: "bot-5", cols: 80, rows: 24 });
  assert.deepEqual(f.children.map((child) => child.killed), [true, false, false, false, false]);
  assert.equal(f.host.readBot("bot-1").state, "no-terminal");
  assert.equal(f.host.readBot("bot-2").state, undefined);
});

test("retires a pre-started shell nobody showed in time", async () => {
  const f = fixture({ prestartIdleMs: 20 });
  await f.host.prestart(f.event, { botId: "bot-1", cols: 80, rows: 24 });
  await f.host.prestart(f.event, { botId: "bot-2", cols: 80, rows: 24 });
  await f.host.open(f.event, { ...f.input, botId: "bot-2" });
  await wait(40);
  assert.deepEqual(f.children.map((child) => child.killed), [true, false]);
  assert.equal(f.host.readBot("bot-1").state, "no-terminal");
});

test("a never-shown pre-start raises no alert and a panel unmount cannot cancel it", async () => {
  let releaseFolder;
  const folder = new Promise((resolve) => { releaseFolder = resolve; });
  const f = fixture({ resolveCwd: async () => { await folder; return os.tmpdir(); } });
  const starting = f.host.prestart(f.event, { botId: "bot-1", cols: 80, rows: 24 });
  assert.equal(f.host.cancelOpen(f.event, "bot-1"), false);
  releaseFolder();
  assert.equal(await starting, true);
  f.children[0].data("\x07");
  f.children[0].exit({ exitCode: 1 });
  assert.equal(f.events.some(([channel]) => channel === "terminal:attention"), false);
});

test("pre-start validates its caller and input", async () => {
  const f = fixture();
  await assert.rejects(f.host.prestart({ ...f.event, sender: {} }, { botId: "bot-1", cols: 80, rows: 24 }), /Untrusted/);
  await assert.rejects(f.host.prestart(f.event, { botId: "../x", cols: 80, rows: 24 }), /Invalid bot/);
  await assert.rejects(f.host.prestart(f.event, { botId: "bot-1", cols: 0, rows: 24 }), /Invalid terminal dimensions/);
  assert.equal(f.children.length, 0);
});

test("pre-start never spawns when the folder needs a pick", async () => {
  const f = fixture({ resolveCwd: async () => ({ needsFolder: true }) });
  assert.equal(await f.host.prestart(f.event, { botId: "bot-1", cols: 80, rows: 24 }), false);
  assert.equal(f.children.length, 0);
});

test("a remote open starts the same main shell the host panel attaches to", async () => {
  let owner;
  const f = fixture({ owner: () => owner, prestartIdleMs: 20 });
  owner = f.owner;
  const started = await f.host.openMainForBot("bot-1");
  assert.equal(f.host.readBot("bot-1").sessionId, started.sessionId);
  assert.equal(f.host.readBot("bot-1").panes[0].main, true);
  const shown = await f.host.open(f.event, f.input);
  assert.equal(shown.id, started.sessionId);
  assert.equal(f.children.length, 1);
  assert.equal((await f.host.openMainForBot("bot-1")).sessionId, started.sessionId);
  await wait(40);
  assert.equal(f.children[0].killed, false);
});

test("a remote open attaches to a pre-started shell and keeps it", async () => {
  let owner;
  const f = fixture({ owner: () => owner, prestartIdleMs: 20 });
  owner = f.owner;
  await f.host.prestart(f.event, { botId: "bot-1", cols: 80, rows: 24 });
  await f.host.openMainForBot("bot-1");
  await wait(40);
  assert.equal(f.children.length, 1);
  assert.equal(f.children[0].killed, false);
});

test("a remote open refuses a bad bot, a folder pick or a missing window", async () => {
  let owner = null;
  const f = fixture({ owner: () => owner, resolveCwd: async () => ({ needsFolder: true }) });
  await assert.rejects(f.host.openMainForBot("bot-1"), /not available/);
  owner = f.owner;
  await assert.rejects(f.host.openMainForBot("../x"), /Invalid bot/);
  await assert.rejects(f.host.openMainForBot("bot-1"), /folder is unavailable/);
  assert.equal(f.children.length, 0);
});

const contextScreen = (footer) => `\x1b[2J\x1b[H✻ Worked for 54m 33s · done 12:11 AM\r\n${"─".repeat(40)}\r\n> \r\n${"─".repeat(40)}\r\n${footer}\r\n`;
const contextNotes = (f) => f.notes.map((note) => note.text).filter((text) => text.startsWith("CONTEXT:"));
const NO_SAVE = "It could not get the save line; terminal_read the pane.";
const SAVE_LINE = "Context is getting full. Update your progress file now (done, in flight, left), then continue.";
const busyScreen = (footer, typed = "") => `\x1b[2J\x1b[H✻ Working… (5s · esc to interrupt)\r\n${"─".repeat(40)}\r\n> ${typed}\r\n${"─".repeat(40)}\r\n${footer}\r\n${typed ? `\x1b[${3 + Math.floor((typed.length + 2) / 120)};${(typed.length + 2) % 120 + 1}H` : ""}`;
const idleSaveScreen = (footer, typed = SAVE_LINE) => busyScreen(footer, typed).replace("✻ Working… (5s · esc to interrupt)", "✻ Worked for 5s");

for (const [name, engine, footer, context] of [
  ["Claude near its 500k compact window", "claude", "  ⏵⏵ bypass permissions on · 3% until auto-compact", { left: 3 }],
  ["Claude near a 300k compact window", "claude", "  ⏵⏵ bypass permissions on · 7% until auto-compact", { left: 7 }],
  ["Claude worker status line", "claude", "  ▰▱▱▱▱ 20% │ ↑241.2k\r\n  ctx 241k/300k\r\n  ⏵⏵ bypass permissions on · 5% until auto-compact", { tokens: 241_000, window: 300_000, left: 20 }],
  ["Claude with compaction off", "claude","  Context low (8% remaining) · Run /compact to compact & continue", { left: 8 }],
  ["Claude below its warning, custom status line", "claude", "  ▰▰▰▱▱ 59% │ ↑409.3k ↓444 │ 5h: ▱▱▱▱▱ 0% (1h47m)\r\n  ⏵⏵ bypass permissions on (shift+tab to cycle) · ← for agents", undefined],
  ["Codex footer", "codex", "  100% context left · ? for shortcuts", { left: 100 }],
  ["Codex status line", "codex", "  gpt-6 high · Context 45% left · ~/work", { left: 45 }],
  ["Grok", "grok", "  grok-4.5 · 32K / 256K", { tokens: 32_000, left: 88 }],
  ["Grok's numbers on a Codex screen", "codex", "  grok-4.5 · 32K / 256K", undefined],
  ["Muse", "muse", "  muse-2 · ready", undefined],
]) {
  test(`the pane list carries the context the screen shows: ${name}`, async (t) => {
    const f = stallFixture();
    t.after(() => f.host.dispose());
    await f.host.openMainForBot("bot-1");
    await f.host.openForBot("bot-1", { label: "W", command: `${engine} go` });
    f.children[0].data(contextScreen("  10% context left"));
    f.children[1].data(contextScreen(footer));
    const panes = f.host.readBot("bot-1").panes;
    assert.equal("context" in panes[0], false);
    assert.deepEqual(panes[1].context, context);
  });
}

test("a CONTEXT note goes once per crossing and again after a compaction", async (t) => {
  const f = stallFixture();
  t.after(() => f.host.dispose());
  const pane = await f.host.openForBot("bot-1", { label: "PIXEL | gpt-6 | high", command: "codex go" });
  for (const left of [60, 51]) {
    f.children[0].data(contextScreen(`  ${left}% context left · ? for shortcuts`));
    await f.advance(10_000);
  }
  assert.deepEqual(contextNotes(f), []);
  f.children[0].data(contextScreen("  45% context left · ? for shortcuts"));
  await f.advance(10_000);
  assert.deepEqual(contextNotes(f), [`CONTEXT: PIXEL is at 55% of its window. ${NO_SAVE}`]);
  assert.equal(f.notes.at(-1).scope.pane, pane.sessionId);
  for (const left of [30, 12]) {
    f.children[0].data(contextScreen(`  ${left}% context left · ? for shortcuts`));
    await f.advance(10_000);
  }
  assert.equal(contextNotes(f).length, 1);
  f.children[0].data(contextScreen("  95% context left · ? for shortcuts"));
  await f.advance(10_000);
  f.children[0].data(contextScreen("  48% context left · ? for shortcuts"));
  await f.advance(10_000);
  await f.advance(10_000);
  assert.deepEqual(contextNotes(f).slice(1), [`CONTEXT: PIXEL is at 52% of its window. ${NO_SAVE}`]);
  assert.equal(f.children[0].writes.join(""), "codex go\r");
});

test("a Grok CONTEXT note goes at 200k tokens, not at half its window", async (t) => {
  const f = stallFixture();
  t.after(() => f.host.dispose());
  await f.host.openForBot("bot-1", { label: "GROKKER | grok-4.5 | high", command: "grok go" });
  f.children[0].data(contextScreen("  grok-4.5 · 199K / 256K"));
  await f.advance(10_000);
  assert.deepEqual(contextNotes(f), []);
  f.children[0].data(contextScreen("  grok-4.5 · 213K / 256K"));
  await f.advance(10_000);
  assert.deepEqual(contextNotes(f), [`CONTEXT: GROKKER is at 213k context (83% of its window). ${NO_SAVE}`]);
});

for (const output of ["213K / 256K", "Downloaded 213K / 256K", "Example: grok-4.5 · 213K / 256K"]) {
  test(`a Grok CONTEXT note ignores ordinary output: ${output}`, async (t) => {
    const f = stallFixture();
    t.after(() => f.host.dispose());
    await f.host.openForBot("bot-1", { label: "GROKKER", command: "grok go" });
    f.children[0].data(contextScreen(`  ${output}`));
    await f.advance(10_000);
    assert.deepEqual(contextNotes(f), []);
    assert.equal("context" in f.host.readBot("bot-1").panes[0], false);
  });
}

test("a Claude CONTEXT note waits for its own footer and stays once when it clears", async (t) => {
  const f = stallFixture();
  t.after(() => f.host.dispose());
  await f.host.openForBot("bot-1", { label: "SHOP | claude-opus-5-5 | high", command: "claude go" });
  f.children[0].data(contextScreen("  ⏵⏵ bypass permissions on (shift+tab to cycle) · ← for agents"));
  await f.advance(10_000);
  assert.deepEqual(contextNotes(f), []);
  f.children[0].data(contextScreen("  ⏵⏵ bypass permissions on · 7% until auto-compact"));
  await f.advance(10_000);
  assert.deepEqual(contextNotes(f), [`CONTEXT: SHOP is at 93% of its window. ${NO_SAVE}`]);
  f.children[0].data(contextScreen("  ⏵⏵ bypass permissions on (shift+tab to cycle) · ← for agents"));
  await f.advance(10_000);
  f.children[0].data(contextScreen("  ⏵⏵ bypass permissions on · 6% until auto-compact"));
  await f.advance(10_000);
  assert.equal(contextNotes(f).length, 1);
});

test("a Claude CONTEXT note re-arms after a compact signal", async (t) => {
  const f = stallFixture();
  t.after(() => f.host.dispose());
  const pane = await f.host.openForBot("bot-1", { label: "SHOP", command: "claude go" });
  const signal = path.join(os.tmpdir(), `orbit-compact-${pane.sessionId}`);
  t.after(() => fs.rmSync(signal, { force: true }));
  f.children[0].data(contextScreen("  ⏵⏵ bypass permissions on · 7% until auto-compact"));
  await f.advance(10_000);
  assert.deepEqual(contextNotes(f), [`CONTEXT: SHOP is at 93% of its window. ${NO_SAVE}`]);
  fs.writeFileSync(signal, "");
  f.children[0].data(contextScreen("  ⏵⏵ bypass permissions on (shift+tab to cycle) · ← for agents"));
  await f.advance(10_000);
  assert.equal(contextNotes(f).length, 1);
  f.children[0].data(contextScreen("  ⏵⏵ bypass permissions on · 6% until auto-compact"));
  await f.advance(10_000);
  await f.advance(10_000);
  assert.deepEqual(contextNotes(f).slice(1), [`CONTEXT: SHOP is at 94% of its window. ${NO_SAVE}`]);
  assert.equal(f.children[0].options.env.ORBIT_COMPACT_SIGNAL, signal);
  assert.equal(fs.existsSync(signal), false);
});

test("a Claude CONTEXT note waits for the low footer to clear after a compact signal", async (t) => {
  const f = stallFixture();
  t.after(() => f.host.dispose());
  const pane = await f.host.openForBot("bot-1", { label: "SHOP", command: "claude go" });
  const signal = path.join(os.tmpdir(), `orbit-compact-${pane.sessionId}`);
  t.after(() => fs.rmSync(signal, { force: true }));
  f.children[0].data(contextScreen("  ⏵⏵ bypass permissions on · 7% until auto-compact"));
  await f.advance(10_000);
  assert.equal(contextNotes(f).length, 1);
  fs.writeFileSync(signal, "");
  await f.advance(10_000);
  await f.advance(10_000);
  f.children[0].data("\x1b[HReinjecting the card\r\n");
  await f.advance(10_000);
  assert.equal(contextNotes(f).length, 1);
  f.children[0].data(contextScreen("  ⏵⏵ bypass permissions on (shift+tab to cycle) · ← for agents"));
  await f.advance(10_000);
  f.children[0].data(contextScreen("  ⏵⏵ bypass permissions on · 6% until auto-compact"));
  await f.advance(10_000);
  await f.advance(10_000);
  assert.deepEqual(contextNotes(f), [
    `CONTEXT: SHOP is at 93% of its window. ${NO_SAVE}`,
    `CONTEXT: SHOP is at 94% of its window. ${NO_SAVE}`,
  ]);
});

test("a fresh worker command gets its own CONTEXT note in the same pane", async (t) => {
  const f = stallFixture();
  t.after(() => f.host.dispose());
  const pane = await f.host.openForBot("bot-1", { label: "SHOP", command: "claude go" });
  f.children[0].data(contextScreen("  ⏵⏵ bypass permissions on · 7% until auto-compact"));
  await f.advance(10_000);
  f.host.sendBot("bot-1", { sessionId: pane.sessionId, generation: pane.generation, text: "continue\r" });
  await f.advance(10_000);
  assert.equal(contextNotes(f).length, 1);
  f.children[0].data(finishedMark(pane));
  f.host.sendBot("bot-1", { sessionId: pane.sessionId, generation: pane.generation, text: "claude next\r" });
  f.children[0].data(contextScreen("  ⏵⏵ bypass permissions on · 6% until auto-compact"));
  await f.advance(10_000);
  await f.advance(10_000);
  assert.deepEqual(contextNotes(f), [
    `CONTEXT: SHOP is at 93% of its window. ${NO_SAVE}`,
    `CONTEXT: SHOP is at 94% of its window. ${NO_SAVE}`,
  ]);
  assert.equal(f.children.length, 1);
});

test("a Claude CONTEXT note waits for 80% of its compact window", async (t) => {
  const f = stallFixture();
  t.after(() => f.host.dispose());
  await f.host.openForBot("bot-1", { label: "SHOP", command: "claude go" });
  f.children[0].data(contextScreen("  ctx 210k/300k"));
  await f.advance(10_000);
  assert.deepEqual(contextNotes(f), []);
  f.children[0].data(contextScreen("  ctx 240k/300k"));
  await f.advance(10_000);
  assert.deepEqual(contextNotes(f), [`CONTEXT: SHOP is at 240k of 300k. ${NO_SAVE}`]);
});

test("a busy worker gets the save line once per compaction cycle and the chief no note", async (t) => {
  const f = stallFixture();
  t.after(() => f.host.dispose());
  await f.host.openForBot("bot-1", { label: "SHOP", command: "claude go" });
  f.children[0].data(busyScreen("  ctx 245k/300k"));
  await f.advance(10_000);
  assert.deepEqual(f.children[0].writes.slice(1), [SAVE_LINE]);
  f.children[0].data(busyScreen("  ctx 246k/300k", SAVE_LINE));
  await f.advance(10_000);
  await f.advance(10_000);
  f.children[0].data(busyScreen("  ctx 262k/300k"));
  await f.advance(10_000);
  assert.deepEqual(f.children[0].writes.slice(1), [SAVE_LINE, "\r"]);
  f.children[0].data(busyScreen("  ctx 31k/300k"));
  await f.advance(10_000);
  f.children[0].data(busyScreen("  ctx 250k/300k"));
  await f.advance(10_000);
  assert.deepEqual(f.children[0].writes.slice(1), [SAVE_LINE, "\r", SAVE_LINE]);
  assert.deepEqual(contextNotes(f), []);
});

// Recorded from Claude Code 2.1.309 busy at 120x30, ctx raised to 245k; its live prompt is ">" plus a no-break space.
const CLAUDE_BUSY = "\x1b]0;claude\x1b\\\x1b7\x1b[r\x1b8\x1b[?25h\x1b[?25l\x1b[?2004h\x1b[?2031h\x1b[?1004h\x1b[?9001l\x1b[?9001h\x1b[>0q\x1b[?u\x1b]7501;?\x07\x1b[c\x1b[>4m\x1b[<u\x1b[?1004l\x1b[?1004h\x1b[?2031l\x1b[?2004l\x1b[?2004h\x1b[?2031h\x1b[?1004h\x1b[?9001l\x1b[?9001h\x1b]0;✳ Claude Code\x1b\\\x1b[91m ▐\x1b[40m▛███▛█\x1b[12G\x1b[39m\x1b[49m\x1b[1mClaude\x1b[19GCode\x1b[24G\x1b[22m\x1b[37m\x1b[2mv2.1.309\x1b[22m\x1b[39m\r\n\x1b[91m▝▜\x1b[40m█████\x1b[49m█▀\x1b[12G\x1b[37m\x1b[2mHaiku\x1b[18G5.5\x1b[22G·\x1b[24GClaude\x1b[31GMax\x1b[22m\x1b[39m\r\n\x1b[91m ▝▝\x1b[7G▝▝\x1b[12G\x1b[37m\x1b[2m~\\AppData\\Local\\Temp\\wink-SAVE-LINE\\probe\x1b[22m\x1b[39m\r\n\r\n\r\n\x1b[100m\x1b[37m> \x1b[97mUse the Write tool once to create notes.txt with 1000 lines. Line N reads: line N of 1000, the quick brown fox jumps \x1b[39m \x1b[49m\r\n\x1b[100m  \x1b[97mover the lazy dog. Write every line out in full, no code or scripts. Then reply DONE.\x1b[39m                                 \x1b[49m\r\n\r\n\x1b[91m✢\x1b[3GBoondoggling…\x1b[39m\r\n\r\n\x1b[37m────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────\x1b[39m\r\n>\u00a0\r\n\x1b[37m────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────\x1b[39m\r\n\x1b[3G\x1b[91m⏵⏵\x1b[6Gbypass\x1b[13Gpermissions\x1b[25Gon\x1b[37m\x1b[2m (shift+tab\x1b[39Gto\x1b[42Gcycle)\x1b[49G·\x1b[51G←\x1b[53Gfor\x1b[57Gagents\x1b[101G◐\x1b[103Gmedium\x1b[110G·\x1b[112G/effort\x1b[22m\x1b[39m\r\n\x1b[104G\x1b[93m/rc\x1b[108Gconnecting…\x1b[39m\r\n\x1b[2C\x1b[4A\x1b[?25h\x1b]0;◐ Claude Code\x1b\\\x1b[?25l\x1b[2D\x1b[4B\r\x1b[7A\x1b[91m*\x1b[17G\x1b[37m\x1b[2m(running SessionStart hooks… 0/4 · 0s)\r\x1b[3B>\u00a0\x1b[22m\x1b[39m\r\n\n\n\n\x1b[2C\x1b[4A\x1b[?25h\x1b[>0q\x1b[?u\x1b]7501;?\x07\x1b[c\x1b[?25l\x1b[2D\x1b[4B\r\x1b[7A\x1b[91m✽\x1b[46G\x1b[37m\x1b[2m1\x1b[22m\x1b[39m\r\n\n\n\n\n\n\n\x1b[2C\x1b[4A\x1b[?25h\x1b[?25l\x1b[2D\x1b[4B\r\x1b[16C\x1b[7A\x1b[K\r\n\n\n\n\n\n\n\x1b[2C\x1b[4A\x1b[?25h\x1b[?25l\x1b[2D\x1b[4B\r\x1b[7A\x1b[91m✻\x1b[39m\r\n\n\n\n\n\n\n\x1b[2C\x1b[4A\x1b[?25h\x1b[?25l\x1b[2D\x1b[4B\r\x1b[7A\x1b[91m✶\x1b[39m\r\n\n\n\n\n\n\n\x1b[2C\x1b[4A\x1b[?25h\x1b[?25l\x1b[2D\x1b[4B\r\x1b[2C\x1b[2A\x1b[36m◆ Haiku 5.5\x1b[37m\x1b[2m │ probe\x1b[22m\x1b[39m                                         \r\x1b[2C\x1b[1B\x1b[32m▰▰▰▰▰\x1b[37m\x1b[2m 100% │ 5h: \x1b[22m\x1b[32m▰▰▰▰▱\x1b[37m\x1b[2m \x1b[22m\x1b[32m80%\x1b[37m\x1b[2m (48m) │ 7d: \x1b[22m\x1b[32m▰▰▰▰▱\x1b[37m\x1b[2m \x1b[22m\x1b[32m89%\x1b[37m\x1b[2m (6d5h) │ 1s\x1b[22m\x1b[39m\r\n\x1b[3G\x1b[37m\x1b[2mctx\x1b[7G245k/300k\x1b[22m\x1b[39m\r\n\x1b[3G\x1b[91m⏵⏵\x1b[6Gbypass\x1b[13Gpermissions\x1b[25Gon\x1b[37m\x1b[2m (shift+tab\x1b[39Gto\x1b[42Gcycle)\x1b[49G·\x1b[51G←\x1b[53Gfor\x1b[57Gagents\x1b[22m\x1b[39m\r\n\x1b[2C\x1b[6A\x1b[?25h\x1b[?25l\x1b[2D\x1b[6B\r\x1b[9A\x1b[91m*\r\x1b[103C\x1b[6B\x1b[39m            \x1b[92m/rc\x1b[39m\r\n\n\n\x1b[2C\x1b[6A\x1b[?25h\x1b]0;◑ Claude Code\x1b\\\x1b[?25l\x1b[2D\x1b[6B\r\x1b[9A\x1b[91m✢\x1b[39m\r\n\n\n\n\n\n\n\n\n\x1b[2C\x1b[6A\x1b[?25h\x1b]0;◑ Notes.txt file creation\x1b\\\x1b[?25l\x1b[2D\x1b[6B\r\x1b[9A\x1b[91m·\x1b[39m\r\n\n\n\n\n\n\n\n\n\x1b[2C\x1b[6A\x1b[?25h\x1b[?25l\x1b[2D\x1b[6B\r\x1b[14C\x1b[9A\x1b[93m…\x1b[39m\r\n\n\n\n\n\n\n\n\n\x1b[2C\x1b[6A\x1b[?25h\x1b[?25l\x1b[2D\x1b[6B\r\x1b[9A\x1b[91m✢\x1b[14G\x1b[93mg\x1b[39m\r\n\n\n\n\n\n\n\n\n\x1b[2C\x1b[6A\x1b[?25h\x1b[?25l\x1b[2D\x1b[6B\r\x1b[9A\x1b[91m*\x1b[13G\x1b[93mn\x1b[39m\r\n\n\n\n\n\n\n\n\n\x1b[2C\x1b[6A\x1b[?25h\x1b[?25l\x1b[2D\x1b[6B\r\x1b[9A\x1b[91m✶\x1b[39m\r\n\n\n\n\n\n\n\n\n\x1b[2C\x1b[6A\x1b[?25h\x1b]0;◐ Notes.txt file creation\x1b\\\x1b[?25l\x1b[2D\x1b[6B\r\x1b[9A\x1b[91m✻\x1b[12G\x1b[93mi\x1b[15G\x1b[91m…\x1b[39m\r\n\n\n\n\n\n\n\n\n\x1b[2C\x1b[6A\x1b[?25h\x1b[?25l\x1b[2D\x1b[6B\r\x1b[9A\x1b[91m✽\x1b[11G\x1b[93ml\x1b[14G\x1b[91mg\x1b[39m\r\n\n\n\n\n\n\n\n\n\x1b[2C\x1b[6A\x1b[?25h\x1b[?25l\x1b[2D\x1b[6B\r\x1b[2C\x1b[9A\x1b[91mManifes\x1b[93mtin\x1b[91mg… \x1b[37m\x1b[2m(2s · \x1b[22m\x1b[38;2;153;153;153mthinking\x1b[37m\x1b[2m)\x1b[22m\x1b[39m\r\n\n\n\n\n\n\n\n\n\x1b[2C\x1b[6A\x1b[?25h\x1b[?25l\x1b[2D\x1b[6B\r\x1b[8C\x1b[9A\x1b[93ms\x1b[12G\x1b[91mn\x1b[22G\x1b[38;2;169;169;169mthinking\x1b[39m\r\n\n\n\n\n\n\n\n\n\x1b[2C\x1b[6A\x1b[?25h\x1b[?25l\x1b[2D\x1b[6B\r\x1b[21C\x1b[9A\x1b[38;2;177;177;177mthinking\x1b[39m\r\n\n\n\n\n\n\n\n\n\x1b[2C\x1b[6A\x1b[?25h\x1b[?25l\x1b[2D\x1b[6B\r\x1b[9A\x1b[91m✻\x1b[8G\x1b[93me\x1b[11G\x1b[91mi\x1b[22G\x1b[38;2;181;181;181mthinking\x1b[39m\r\n\n\n\n\n\n\n\n\n\x1b[2C\x1b[6A\x1b[?25h\x1b[?25l\x1b[2D\x1b[6B\r\x1b[21C\x1b[9A\x1b[38;2;185;185;185mthinking\x1b[39m\r\n\n\n\n\n\n\n\n\n\x1b[2C\x1b[6A\x1b[?25h\x1b[?25l\x1b[2D\x1b[6B\r\x1b[9A\x1b[91m✶\x1b[7G\x1b[93mf\x1b[10G\x1b[91mt\x1b[39m\r\n\n\n\n\n\n\n\n\n\x1b[2C\x1b[6A\x1b[?25h\x1b[?25l\x1b[2D\x1b[6B\r\x1b[9A\x1b[91m*\x1b[17G\x1b[37m\x1b[2m3\x1b[22m\x1b[39m\r\n\n\n\n\n\n\n\n\n\x1b[2C\x1b[6A\x1b[?25h\x1b]0;◑ Notes.txt file creation\x1b\\\x1b[?25l\x1b[2D\x1b[6B\r\x1b[9A\x1b[91m✢\x1b[6G\x1b[93mi\x1b[9G\x1b[91ms\x1b[22G\x1b[38;2;181;181;181mthinking\x1b[39m\r\n\n\n\n\n\n\n\n\n\x1b[2C\x1b[6A\x1b[?25h\x1b[?25l\x1b[2D\x1b[6B\r\x1b[9A\x1b[91m·\x1b[5G\x1b[93mn\x1b[8G\x1b[91me\x1b[22G\x1b[38;2;177;177;177mthinking\x1b[39m\r\n\n\n\n\n\n\n\n\n\x1b[2C\x1b[6A\x1b[?25h\x1b[?25l\x1b[2D\x1b[6B\r\x1b[21C\x1b[9A\x1b[38;2;173;173;173mthinking\x1b[39m\r\n\n\n\n\n\n\n\n\n\x1b[2C\x1b[6A\x1b[?25h\x1b[?25l\x1b[2D\x1b[6B\r\x1b[3C\x1b[9A\x1b[93ma\x1b[7G\x1b[91mf\x1b[22G\x1b[38;2;169;169;169mthinking\x1b[39m\r\n\n\n\n\n\n\n\n\n\x1b[2C\x1b[6A\x1b[?25h\x1b[?25l\x1b[2D\x1b[6B\r\x1b[21C\x1b[9A\x1b[38;2;161;161;161mthinking\x1b[39m\r\n\n\n\n\n\n\n\n\n\x1b[2C\x1b[6A\x1b[?25h\x1b[?25l\x1b[2D\x1b[6B\r\x1b[9A\x1b[91m✢\x1b[3G\x1b[93mM\x1b[6G\x1b[91mi\x1b[22G\x1b[37m\x1b[2m↓\x1b[22m\x1b[39m \x1b[37m\x1b[2m25 tokens · \x1b[22m\x1b[38;2;157;157;157mthinking\x1b[37m\x1b[2m)\x1b[22m\x1b[39m\r\n\n\n\n\n\n\n\n\n\x1b[2C\x1b[6A\x1b[?25h\x1b[?25l\x1b[2D\x1b[6B\r\x1b[23C\x1b[9A\x1b[37m\x1b[2m50\x1b[36G\x1b[22m\x1b[38;2;153;153;153mthinking\x1b[39m\r\n\n\n\n\n\n\n\n\n\x1b[2C\x1b[6A\x1b[?25h";
const CLAUDE_SAVE_ECHO = "\x1b[?25l\x1b[2D\x1b[6B\r\x1b[2C\x1b[6AContext\x1b[11Gis\x1b[14Ggetting\x1b[22Gfull.\x1b[28GUpdate\x1b[35Gyour\x1b[40Gprogress\x1b[49Gfile\x1b[54Gnow\x1b[58G(done,\x1b[65Gin\x1b[68Gflight,\x1b[76Gleft),\x1b[83Gthen\x1b[88Gcontinue.\r\x1b[47C\x1b[5B\x1b[K\r\n\x1b[96C\x1b[6A\x1b[?25h";

test("a recorded busy Claude Code pane gets the save line and its Enter and the chief no note", async (t) => {
  const f = stallFixture();
  t.after(() => f.host.dispose());
  await f.host.openForBot("bot-1", { label: "W", command: "claude go" });
  f.children[0].data(CLAUDE_BUSY);
  await f.advance(10_000);
  const paste = `\x1b[200~${SAVE_LINE}\x1b[201~`;
  assert.deepEqual(f.children[0].writes.slice(1), [paste]);
  f.children[0].data(CLAUDE_SAVE_ECHO);
  await f.advance(10_000);
  assert.deepEqual(f.children[0].writes.slice(1), [paste, "\r"]);
  assert.deepEqual(contextNotes(f), []);
});

for (const typed of [false, true]) {
  test(`Claude compacting on its own gets no CONTEXT note: save line typed ${typed}`, async (t) => {
    const f = stallFixture();
    t.after(() => f.host.dispose());
    await f.host.openForBot("bot-1", { label: "W", command: "claude go" });
    if (typed) {
      f.children[0].data(busyScreen("ctx 245k/300k"));
      await f.advance(10_000);
    }
    for (const used of [246, 247, 248]) {
      f.children[0].data(busyScreen(`ctx ${used}k/300k`).replace("✻ Working… (5s", "* Compacting conversation… (30s"));
      await f.advance(10_000);
    }
    f.children[0].data(busyScreen("ctx 31k/300k"));
    await f.advance(10_000);
    assert.deepEqual(f.children[0].writes.slice(1), typed ? [SAVE_LINE] : []);
    assert.deepEqual(contextNotes(f), []);
  });
}

test("a save line left in the input after a compaction gets an Enter, not a second copy", async (t) => {
  const f = stallFixture();
  t.after(() => f.host.dispose());
  await f.host.openForBot("bot-1", { label: "W", command: "claude go" });
  f.children[0].data(busyScreen("ctx 245k/300k"));
  await f.advance(10_000);
  f.children[0].data(busyScreen("ctx 246k/300k", SAVE_LINE));
  await f.advance(10_000);
  f.children[0].data(busyScreen("ctx 31k/300k", SAVE_LINE));
  await f.advance(10_000);
  f.children[0].data(busyScreen("ctx 250k/300k", SAVE_LINE));
  await f.advance(10_000);
  await f.advance(10_000);
  assert.deepEqual(f.children[0].writes.slice(1), [SAVE_LINE, "\r", "\r"]);
  assert.deepEqual(contextNotes(f), []);
});

for (const engine of ["claude", "codex"]) {
  test(`${engine} submits a queued save line once when the pane goes idle`, async (t) => {
    const f = stallFixture();
    t.after(() => f.host.dispose());
    const footer = engine === "claude" ? "ctx 245k/300k" : "Context 40% left";
    await f.host.openForBot("bot-1", { label: "W", command: `${engine} go` });
    f.children[0].data(busyScreen(footer));
    await f.advance(10_000);
    f.children[0].data(idleSaveScreen(footer));
    await f.advance(10_000);
    assert.deepEqual(f.children[0].writes.slice(1), [SAVE_LINE, "\r"]);
    for (let tick = 0; tick < 3; tick += 1) {
      f.children[0].data(idleSaveScreen(footer));
      await f.advance(10_000);
    }
    assert.deepEqual(f.children[0].writes.slice(1), [SAVE_LINE, "\r"]);
    assert.deepEqual(contextNotes(f), []);
  });
}

test("a save line still queued after a busy Enter gets one idle Enter", async (t) => {
  const f = stallFixture();
  t.after(() => f.host.dispose());
  await f.host.openForBot("bot-1", { label: "W", command: "claude go" });
  f.children[0].data(busyScreen("ctx 245k/300k"));
  await f.advance(10_000);
  f.children[0].data(busyScreen("ctx 245k/300k", SAVE_LINE));
  await f.advance(10_000);
  assert.deepEqual(f.children[0].writes.slice(1), [SAVE_LINE, "\r"]);
  f.children[0].data(idleSaveScreen("ctx 245k/300k"));
  await f.advance(10_000);
  await f.advance(10_000);
  assert.deepEqual(f.children[0].writes.slice(1), [SAVE_LINE, "\r", "\r"]);
  assert.deepEqual(contextNotes(f), []);
});

test("an idle save-line Enter rechecks a menu that appears before the write", async (t) => {
  let clock = Date.UTC(2026, 9, 4);
  let onCheck = () => {};
  const f = stallFixture({ now: () => { onCheck(); return clock; } });
  t.after(() => f.host.dispose());
  await f.host.openForBot("bot-1", { label: "W", command: "claude go" });
  f.children[0].data(busyScreen("ctx 245k/300k"));
  clock += 10_000;
  await f.settle();
  f.children[0].data(idleSaveScreen("ctx 245k/300k"));
  onCheck = () => {
    onCheck = () => {};
    queueMicrotask(() => f.children[0].data(idleSaveScreen("❯ 1. Yes\r\n  2. No\r\nctx 245k/300k")));
  };
  clock += 10_000;
  await f.settle();
  assert.deepEqual(f.children[0].writes.slice(1), [SAVE_LINE]);
  clock += 10_000;
  await f.settle();
  assert.deepEqual(f.children[0].writes.slice(1), [SAVE_LINE]);
  assert.equal(contextNotes(f).length, 1);
  f.children[0].data(idleSaveScreen("ctx 245k/300k"));
  clock += 10_000;
  await f.settle();
  assert.deepEqual(f.children[0].writes.slice(1), [SAVE_LINE, "\r"]);
  assert.equal(contextNotes(f).length, 1);
});

for (const compact of [false, true]) {
  test(`a queued save line sends one acknowledged CONTEXT note per crossing: compact ${compact}`, async (t) => {
    const posted = [];
    const f = stallFixture({ notePane: async (mail, scope, text) => {
      if (!text.startsWith("CONTEXT:")) return;
      posted.push(text);
      f.host.attendBot(scope.bot, scope.pane, "note");
      throw new Error("response lost after delivery");
    } });
    t.after(() => f.host.dispose());
    await f.host.openForBot("bot-1", { label: "W", command: "claude go" });
    for (let cycle = 0; cycle < (compact ? 2 : 1); cycle += 1) {
      if (cycle) {
        f.children[0].data(contextScreen("ctx 30k/300k"));
        await f.advance(10_000);
      }
      f.children[0].data(busyScreen("ctx 245k/300k"));
      await f.advance(10_000);
      await f.advance(10_000);
      for (const used of [246, 247, 248, 249, 250]) {
        f.children[0].data(busyScreen(`ctx ${used}k/300k`, SAVE_LINE));
        await f.advance(61_000);
      }
    }
    assert.equal(posted.length, compact ? 2 : 1);
    assert.deepEqual(f.children[0].writes.slice(1), compact ? [SAVE_LINE, SAVE_LINE] : [SAVE_LINE]);
  });
}

test("an undelivered CONTEXT note retries until it reaches the teacher", async (t) => {
  const f = stallFixture({ failures: 2 });
  t.after(() => f.host.dispose());
  await f.host.openForBot("bot-1", { label: "W", command: "claude go" });
  f.children[0].data(contextScreen("ctx 245k/300k"));
  await f.advance(10_000);
  await f.advance(61_000);
  assert.deepEqual(contextNotes(f), []);
  await f.advance(61_000);
  assert.equal(contextNotes(f).length, 1);
  await f.advance(61_000);
  assert.equal(contextNotes(f).length, 1);
});

for (const [name, command, screen, note] of [
  ["an idle prompt", "claude go", contextScreen("  ctx 245k/300k"), "CONTEXT: W is at 245k of 300k."],
  ["a menu", "claude go", busyScreen("  ❯ 1. Yes\r\n    2. No\r\n  ctx 245k/300k"), "CONTEXT: W is at 245k of 300k."],
  ["a Grok pane", "grok go", busyScreen("  grok-4.5 · 213K / 256K"), "CONTEXT: W is at 213k context (83% of its window)."],
]) {
  test(`the save line stays out of ${name} and the chief gets the note`, async (t) => {
    const f = stallFixture();
    t.after(() => f.host.dispose());
    await f.host.openForBot("bot-1", { label: "W", command });
    f.children[0].data(screen);
    await f.advance(10_000);
    await f.advance(10_000);
    assert.deepEqual(f.children[0].writes, [`${command}\r`]);
    assert.deepEqual(contextNotes(f), [`${note} ${NO_SAVE}`]);
  });
}

test("a save line that never shows gets no Enter and the chief gets the note", async (t) => {
  const f = stallFixture();
  t.after(() => f.host.dispose());
  await f.host.openForBot("bot-1", { label: "W", command: "codex go" });
  f.children[0].data(busyScreen("  Context 40% left"));
  await f.advance(10_000);
  await f.advance(10_000);
  assert.deepEqual(f.children[0].writes, ["codex go\r", SAVE_LINE]);
  assert.deepEqual(contextNotes(f), [`CONTEXT: W is at 60% of its window. ${NO_SAVE}`]);
});

for (const [name, screen] of [
  ["menu-appears-before-enter", `> ${SAVE_LINE}\r\nAllow this command?\r\n❯ 1. Yes\r\n  2. No\r\nctx 245k/300k\r\n`],
  ["menu over the active input", busyScreen("❯ 1. Yes\r\n  2. No\r\nctx 245k/300k", SAVE_LINE)],
  ["permission prompt over the active input", busyScreen("Allow this command? (y/n)\r\nctx 245k/300k", SAVE_LINE)],
  ["save line in old output", `${SAVE_LINE}\r\n${busyScreen("ctx 245k/300k").replace(/\x1b\[2J\x1b\[H/, "")}\x1b[4;3H`],
  ["only the save-line suffix in input", busyScreen("ctx 245k/300k", SAVE_LINE.replace(/\s+/g, "").slice(-16))],
]) {
  test(`a delayed save-line Enter refuses ${name}`, async (t) => {
    const f = stallFixture();
    t.after(() => f.host.dispose());
    await f.host.openForBot("bot-1", { label: "W", command: "claude go" });
    f.children[0].data(busyScreen("ctx 245k/300k"));
    await f.advance(10_000);
    assert.deepEqual(f.children[0].writes.slice(1), [SAVE_LINE]);
    f.children[0].data(`\x1b[2J\x1b[H${screen}`);
    await f.advance(10_000);
    await f.advance(10_000);
    assert.deepEqual(f.children[0].writes.slice(1), [SAVE_LINE]);
    assert.deepEqual(contextNotes(f), [`CONTEXT: W is at 245k of 300k. ${NO_SAVE}`]);
  });
}

test("the worker status line prints its tokens of the compact window after the user's own line", { skip: process.platform !== "win32", timeout: 30_000 }, async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "orbit-status-line-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const bin = await installOrbitMsg(path.join(dir, "bin"), "win32");
  const script = path.join(bin, "orbit-status.ps1");
  assert.equal(JSON.parse(fs.readFileSync(path.join(bin, "claude-worker.json"), "utf8")).statusLine.command,
    `powershell.exe -NoProfile -ExecutionPolicy Bypass -File "${script.replace(/\\/g, "/")}" 300000`);
  fs.writeFileSync(path.join(dir, "settings.json"), JSON.stringify({ statusLine: { type: "command", command: "cat" } }));
  const status = { model: { display_name: "Opus" }, context_window: { total_input_tokens: 241_234, context_window_size: 1_000_000, used_percentage: 24, remaining_percentage: 76 } };
  const out = await new Promise((resolve, reject) => {
    const child = execFile("powershell.exe", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", script, "300000"],
      { windowsHide: true, env: { ...process.env, CLAUDE_CONFIG_DIR: dir, CLAUDE_CODE_GIT_BASH_PATH: "" } },
      (error, stdout) => error ? reject(error) : resolve(stdout));
    child.stdin.end(JSON.stringify(status));
  });
  const [user, ctx] = out.split("\n");
  assert.deepEqual(JSON.parse(user).context_window, { total_input_tokens: 241_234, context_window_size: 300_000, used_percentage: 80, remaining_percentage: 20 });
  assert.equal(ctx, "ctx 241k/300k");
});

test("the compact hook signals only a confirmed compact SessionStart",{ skip: process.platform !== "win32", timeout: 30_000 }, async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "orbit-compact-signal-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const bin = await installOrbitMsg(path.join(dir, "bin"), "win32");
  const signal = path.join(dir, "signal");
  for (const [part, hook] of [
    ["card", { hook_event_name: "SessionStart", source: "startup" }],
    ["card", { hook_event_name: "Stop", source: "compact" }],
    ["progress", { hook_event_name: "SessionStart", source: "compact" }],
    ["card", { hook_event_name: "SessionStart", source: "compact" }],
  ]) {
    await new Promise((resolve, reject) => {
      const child = execFile("powershell.exe", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", path.join(bin, "orbit-compact.ps1"), part],
        { windowsHide: true, env: { ...process.env, ORBIT_COMPACT_SIGNAL: signal } },
        (error) => error ? reject(error) : resolve());
      child.stdin.end(JSON.stringify(hook));
    });
    assert.equal(fs.existsSync(signal), part === "card" && hook.hook_event_name === "SessionStart" && hook.source === "compact");
  }
});
