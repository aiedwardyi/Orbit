import assert from "node:assert/strict";
import test from "node:test";
import os from "node:os";
import { createTerminalHost, createTerminalOutputParser, resolveBotSession, terminalEnvironment, terminalReadyTimeoutMs, trustedTerminalSender } from "./terminal-host.mjs";

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
    loadPty: () => ({ spawn: (_shell, _args, options) => {
      const child = { options, writes: [], sizes: [], killed: false, onData(cb) { this.data = cb; }, onExit(cb) { this.exit = cb; }, write(data) { this.writes.push(data); }, resize(...size) { this.sizes.push(size); }, kill() { this.killed = true; } };
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
  for (let i = 0; i < 8; i += 1) await f.host.openForBot("bot-1", { label: `w${i}` });
  await assert.rejects(f.host.openForBot("bot-1", { label: "w8" }), /Too many bot terminals/);
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
  for (let i = 0; i < 8; i += 1) panes.push(await f.host.openForBot("bot-1", { label: `w${i}` }));
  await assert.rejects(f.host.openForBot("bot-1", { label: "w8" }), /Too many bot terminals/);
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
  const many = Promise.allSettled(["bot-2", "bot-3", "bot-4"].flatMap((botId) => Array.from({ length: 8 }, () => f.host.openForBot(botId, {}))));
  release();
  const perBot = await one;
  assert.equal(perBot.filter((result) => result.status === "fulfilled").length, 8);
  assert.ok(perBot.filter((result) => result.status === "rejected").every((result) => /Too many bot terminals/.test(result.reason.message)));
  const global = await many;
  assert.equal(global.filter((result) => result.status === "fulfilled").length, 8);
  assert.ok(global.filter((result) => result.status === "rejected").every((result) => /Too many terminal sessions/.test(result.reason.message)));
  assert.equal(f.children.length, 16);
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
  for (let i = 0; i < 16; i += 1) {
    exited.push((await f.host.openForBot("bot-1", {})).sessionId);
    f.children[i].exit({ exitCode: 0 });
  }
  const next = await f.host.openForBot("bot-1", {});
  assert.ok(next.sessionId);
  const closed = f.events.filter(([channel]) => channel === "terminal:closed").map(([, value]) => value);
  assert.deepEqual(closed, exited.map((id) => ({ id, botId: "bot-1" })));
  await assert.rejects(f.host.open(f.event, { ...f.input, sessionId: exited[0] }), /Unknown terminal/);
});

function stallFixture({ failures = 0 } = {}) {
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
  });
  owner = f.owner;
  // Lets the stall check sample the screen before the clock moves.
  const settle = () => wait(25);
  const advance = async (ms) => { clock += ms; await settle(); };
  return { ...f, notes, settle, advance };
}

test("a worker pane that goes quiet without a report sends one stall note with its last lines", async () => {
  const f = stallFixture();
  const pane = await f.host.openForBot("bot-1", { label: "TAP-AUDIT | Astra | high", command: "codex --model gpt-6-astra 'Read card.md and do it.'" });
  f.children[0].data("■ You've hit your usage limit. Try again at 10:14 PM.\r\n\r\n  Approaching rate limits\r\n  1. Switch to gpt-6-luna\r\n  2. Keep current model\r\n");
  await f.settle();
  await f.advance(119_000);
  assert.equal(f.notes.length, 0);
  await f.advance(2_000);
  assert.equal(f.notes.length, 1);
  assert.deepEqual(f.notes[0].scope, { pane: pane.sessionId, bot: "bot-1", teacher: "bot-1" });
  assert.deepEqual(f.notes[0].mail, { url: "http://127.0.0.1:9", token: "secret" });
  assert.match(f.notes[0].text, /^STALLED: no screen change for 2 min and no report\./);
  assert.match(f.notes[0].text, /Try again at 10:14 PM\.\n {2}Approaching rate limits\n {2}1\. Switch to gpt-6-luna\n {2}2\. Keep current model$/);
  await f.advance(600_000);
  assert.equal(f.notes.length, 1);
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
