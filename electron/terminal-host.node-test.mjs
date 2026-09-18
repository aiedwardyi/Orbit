import assert from "node:assert/strict";
import test from "node:test";
import os from "node:os";
import { createTerminalHost, createTerminalOutputParser, terminalEnvironment, terminalReadyTimeoutMs, trustedTerminalSender } from "./terminal-host.mjs";

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
    loadPty: () => ({ spawn: () => {
      const child = { writes: [], sizes: [], killed: false, onData(cb) { this.data = cb; }, onExit(cb) { this.exit = cb; }, write(data) { this.writes.push(data); }, resize(...size) { this.sizes.push(size); }, kill() { this.killed = true; } };
      children.push(child);
      return child;
    } }),
    ...options,
  });
  return { host, event, owner, children, events, input: { botId: "bot-1", cols: 80, rows: 24 } };
}

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
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
  assert.equal(child.killed, true);
  assert.equal(events.some(([channel]) => channel === "terminal:attention"), false);
  releaseReady();
  await cancelled;
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
