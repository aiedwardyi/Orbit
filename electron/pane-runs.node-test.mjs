import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createPaneRuns, notifyRestartedPanes } from "./pane-runs.mjs";
import { createTerminalHost, trustedTerminalSender } from "./terminal-host.mjs";

const MAIL = { url: "http://127.0.0.1:9", token: "t" };

function runFile(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pane-runs-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return path.join(dir, "pane-runs.json");
}

function launch(file) {
  const owner = { id: 1, mainFrame: { url: "http://127.0.0.1:8799/" }, getURL: () => "http://127.0.0.1:8799/", isDestroyed: () => false, send() {} };
  const children = [];
  const host = createTerminalHost({
    authorize: (caller) => { if (!trustedTerminalSender(caller, owner, "http://127.0.0.1:8799")) throw new Error("Untrusted"); },
    resolveCwd: async () => os.tmpdir(),
    owner: () => owner,
    platform: "linux",
    env: { SHELL: "/bin/sh" },
    stallCheckMs: 60_000,
    loadPty: () => ({ spawn: () => {
      const child = { onData(cb) { this.data = cb; }, onExit(cb) { this.exit = cb; }, write() {}, resize() {}, kill() {} };
      children.push(child);
      return child;
    } }),
    paneRuns: createPaneRuns(file),
  });
  return { host, children, event: { sender: owner, senderFrame: owner.mainFrame } };
}

async function restart(file) {
  const notes = [];
  const runs = createPaneRuns(file);
  await notifyRestartedPanes({ runs, mailbox: async () => MAIL, notePane: async (mail, scope, text) => { notes.push({ scope, text }); }, retryMs: 1 });
  return notes;
}

test("a restart sends one note naming only the panes left mid-run", async (t) => {
  const file = runFile(t);
  const app = launch(file);
  await app.host.open(app.event, { botId: "bot-1", cols: 80, rows: 24 });
  const first = await app.host.openForBot("bot-1", { label: "FIX-A", command: "claude" });
  const second = await app.host.openForBot("bot-1", { label: "FIX-B", command: "codex" });
  const reported = await app.host.openForBot("bot-1", { label: "FIX-C", command: "claude" });
  app.host.attendBot("bot-1", reported.sessionId, "report");
  app.host.dispose();
  const notes = await restart(file);
  assert.equal(notes.length, 1);
  assert.deepEqual(notes[0].scope, { pane: first.sessionId, bot: "bot-1", teacher: "bot-1" });
  const lines = notes[0].text.split("\n");
  assert.equal(lines[0], "RESTARTED: Wink restarted, so these panes you spawned closed mid-run:");
  assert.match(lines[1], new RegExp(`^- FIX-A \\[pane ${first.sessionId.slice(0, 8)}\\] in .+, spawned \\d{4}-\\d\\d-\\d\\dT`));
  assert.match(lines[2], new RegExp(`^- FIX-B \\[pane ${second.sessionId.slice(0, 8)}\\] in `));
  assert.equal(lines[3], "Edits in their folders are still there. Spawn a FRESH worker to continue, or tell the user.");
  assert.equal(lines.length, 4);
});

test("a crash with no clean quit still leaves the record", async (t) => {
  const file = runFile(t);
  const app = launch(file);
  const pane = await app.host.openForBot("bot-1", { label: "FIX-A", command: "claude" });
  const notes = await restart(file);
  assert.equal(notes.length, 1);
  assert.equal(notes[0].scope.pane, pane.sessionId);
  assert.match(notes[0].text, /^- FIX-A \[pane /m);
});

test("closed panes and panes whose command ended get no note", async (t) => {
  const file = runFile(t);
  const app = launch(file);
  const closed = await app.host.openForBot("bot-1", { label: "CLOSED", command: "claude" });
  await app.host.closeForBot("bot-1", closed.sessionId);
  const ended = await app.host.openForBot("bot-1", { label: "ENDED", command: "npm test" });
  app.children.at(-1).data(`\x1b]133;D;${ended.sessionId}\x07`);
  await app.host.openForBot("bot-1", { label: "EXITED", command: "claude" });
  app.children.at(-1).exit({ exitCode: 0 });
  await app.host.openForBot("bot-1", { label: "IDLE" });
  assert.deepEqual(await restart(file), []);
});

test("a pane given new work after its report counts as mid-run again", async (t) => {
  const file = runFile(t);
  const app = launch(file);
  const pane = await app.host.openForBot("bot-1", { label: "AGAIN", command: "claude" });
  app.host.attendBot("bot-1", pane.sessionId, "report");
  app.host.sendBot("bot-1", { sessionId: pane.sessionId, generation: pane.generation, text: "next task\r" });
  const notes = await restart(file);
  assert.equal(notes.length, 1);
  assert.match(notes[0].text, /^- AGAIN \[pane /m);
});

test("no panes means no note", async (t) => {
  const file = runFile(t);
  const app = launch(file);
  await app.host.open(app.event, { botId: "bot-1", cols: 80, rows: 24 });
  assert.deepEqual(await restart(file), []);
  assert.deepEqual(await restart(runFile(t)), []);
});

test("a second restart does not repeat the note", async (t) => {
  const file = runFile(t);
  const app = launch(file);
  await app.host.openForBot("bot-1", { label: "FIX-A", command: "claude" });
  assert.equal((await restart(file)).length, 1);
  assert.deepEqual(await restart(file), []);
});

test("two bots with panes get one note each", async (t) => {
  const file = runFile(t);
  const app = launch(file);
  await app.host.openForBot("bot-1", { label: "ONE-A", command: "claude" });
  await app.host.openForBot("bot-1", { label: "ONE-B", command: "claude" });
  await app.host.openForBot("bot-2", { label: "TWO-A", command: "claude" });
  const notes = await restart(file);
  assert.deepEqual(notes.map((note) => note.scope.bot).sort(), ["bot-1", "bot-2"]);
  assert.match(notes.find((note) => note.scope.bot === "bot-1").text, /ONE-A[^]*ONE-B/);
  assert.doesNotMatch(notes.find((note) => note.scope.bot === "bot-2").text, /ONE-/);
});

test("a failed post retries, and an undelivered note survives a restart in between", async (t) => {
  const file = runFile(t);
  const app = launch(file);
  await app.host.openForBot("bot-1", { label: "FIX-A", command: "claude" });
  // a second launch before the first one's note lands keeps the record
  createPaneRuns(file);
  let tries = 0;
  const runs = createPaneRuns(file);
  await notifyRestartedPanes({ runs, mailbox: async () => MAIL, notePane: async () => { if (++tries < 3) throw new Error("ECONNREFUSED"); }, retryMs: 1 });
  assert.equal(tries, 3);
  assert.deepEqual(await restart(file), []);
});
