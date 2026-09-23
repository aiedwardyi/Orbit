import assert from "node:assert/strict";
import test from "node:test";
import os from "node:os";
import { createTerminalBridge, terminalReadGrant, updateGrant } from "./terminal-bridge.mjs";
import { createTerminalHost } from "./terminal-host.mjs";
import { closeBotPanes } from "../server/terminal-cleanup.ts";
import { updateGrant as serverUpdateGrant } from "../server/terminal-grant.ts";

test("requires the private bearer and scopes reads to the requested bot", async () => {
  const calls = [];
  const bridge = createTerminalBridge({
    token: "bridge-secret",
    host: {
      readBot(botId) {
        calls.push(["read", botId]);
        return { botId, sessionId: "s1", generation: 1, screenText: "ready", seq: 4, capturedAt: 1, truncated: false };
      },
      sendBot(botId, input) {
        calls.push(["send", botId, input]);
        return { ok: true };
      },
    },
  });
  const connection = await bridge.start();
  const unauthorized = await fetch(`${connection.url}/v1/bots/bot-1/terminal`);
  assert.equal(unauthorized.status, 401);
  const response = await fetch(`${connection.url}/v1/bots/bot-1/terminal`, { headers: { authorization: `Bearer ${terminalReadGrant(connection.token, "bot-1")}` } });
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { botId: "bot-1", sessionId: "s1", generation: 1, screenText: "ready", seq: 4, capturedAt: 1, truncated: false });
  assert.deepEqual(calls, [["read", "bot-1"]]);
  const crossBot = await fetch(`${connection.url}/v1/bots/bot-2/terminal`, { headers: { authorization: `Bearer ${terminalReadGrant(connection.token, "bot-1")}` } });
  assert.equal(crossBot.status, 401);
  await bridge.close();
});

function sendFixture() {
  const calls = [];
  const bridge = createTerminalBridge({
    token: "bridge-secret",
    host: {
      readBot: (botId) => ({ botId, sessionId: "s1", generation: 2, screenText: "echo exact", seq: 5, capturedAt: 7, exited: false, truncated: false }),
      async sendBot(botId, input) {
        calls.push([botId, input]);
        if (input.generation !== 2) throw new Error("Terminal session is stale; take a fresh snapshot");
        return { id: input.sessionId, output: "raw" };
      },
    },
  });
  return { bridge, calls };
}

const sendRequest = (connection, init = {}) => fetch(`${connection.url}/v1/bots/bot-1/terminal/send`, {
  method: "POST",
  headers: { authorization: `Bearer ${terminalReadGrant(connection.token, "bot-1")}`, "content-type": "application/json" },
  ...init,
});

test("sends text to the bot's own terminal and returns the read-shaped snapshot", async () => {
  const { bridge, calls } = sendFixture();
  const connection = await bridge.start();
  const response = await sendRequest(connection, { body: JSON.stringify({ sessionId: "s1", generation: 2, text: "echo exact\r" }) });
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { botId: "bot-1", sessionId: "s1", generation: 2, screenText: "echo exact", seq: 5, capturedAt: 7, exited: false, truncated: false });
  assert.deepEqual(calls, [["bot-1", { sessionId: "s1", generation: 2, text: "echo exact\r" }]]);
  await bridge.close();
});

test("rejects a stale generation with 409", async () => {
  const { bridge } = sendFixture();
  const connection = await bridge.start();
  const response = await sendRequest(connection, { body: JSON.stringify({ sessionId: "s1", generation: 1, text: "old\r" }) });
  assert.equal(response.status, 409);
  assert.match((await response.json()).error, /stale/);
  await bridge.close();
});

test("only POST reaches the send route", async () => {
  const { bridge, calls } = sendFixture();
  const connection = await bridge.start();
  const response = await sendRequest(connection, { method: "GET" });
  assert.equal(response.status, 405);
  assert.deepEqual(calls, []);
  await bridge.close();
});

test("rejects oversized and malformed send bodies before the host", async () => {
  const { bridge, calls } = sendFixture();
  const connection = await bridge.start();
  const oversized = await sendRequest(connection, { body: JSON.stringify({ sessionId: "s1", generation: 2, text: "x".repeat(17 * 1024) }) });
  assert.equal(oversized.status, 413);
  const malformed = await sendRequest(connection, { body: "{" });
  assert.equal(malformed.status, 400);
  const crossBot = await fetch(`${connection.url}/v1/bots/bot-2/terminal/send`, {
    method: "POST",
    headers: { authorization: `Bearer ${terminalReadGrant(connection.token, "bot-1")}` },
    body: JSON.stringify({ sessionId: "s1", generation: 2, text: "x\r" }),
  });
  assert.equal(crossBot.status, 401);
  assert.deepEqual(calls, []);
  await bridge.close();
});

test("opens a pane only for the grant's own bot", async () => {
  const calls = [];
  const bridge = createTerminalBridge({
    token: "bridge-secret",
    host: {
      readBot: (botId) => ({ botId }),
      sendBot: () => ({}),
      async openForBot(botId, input) {
        calls.push([botId, input]);
        if (input.label === "full") throw new Error("Too many bot terminals (limit 8)");
        return { sessionId: "p1", generation: 1 };
      },
    },
  });
  const connection = await bridge.start();
  const open = (botId, body) => fetch(`${connection.url}/v1/bots/${botId}/terminal/open`, {
    method: "POST",
    headers: { authorization: `Bearer ${terminalReadGrant(connection.token, "bot-1")}`, "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const response = await open("bot-1", { label: "worker", command: "ls" });
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { sessionId: "p1", generation: 1 });
  assert.equal((await open("bot-2", { label: "worker" })).status, 401);
  assert.equal((await open("bot-1", { label: "full" })).status, 429);
  assert.deepEqual(calls.map(([botId, input]) => [botId, input.label]), [["bot-1", "worker"], ["bot-1", "full"]]);
  await bridge.close();
});

test("raises pane attention for the granted bot only", async () => {
  const calls = [];
  const bridge = createTerminalBridge({
    token: "bridge-secret",
    host: { readBot: () => ({}), sendBot: () => ({}), attendBot: (botId, sessionId) => { calls.push([botId, sessionId]); return true; } },
  });
  const connection = await bridge.start();
  const attend = (botId) => fetch(`${connection.url}/v1/bots/${botId}/terminal/attention`, {
    method: "POST",
    headers: { authorization: `Bearer ${terminalReadGrant(connection.token, "bot-1")}`, "content-type": "application/json" },
    body: JSON.stringify({ sessionId: "p1" }),
  });
  const response = await attend("bot-1");
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { raised: true });
  assert.equal((await attend("bot-2")).status, 401);
  assert.deepEqual(calls, [["bot-1", "p1"]]);
  await bridge.close();
});

test("closes a pane for the granted bot only", async () => {
  const calls = [];
  const bridge = createTerminalBridge({
    token: "bridge-secret",
    host: { readBot: () => ({}), sendBot: () => ({}), closeForBot: async (botId, sessionId) => { calls.push([botId, sessionId]); } },
  });
  const connection = await bridge.start();
  const close = (botId) => fetch(`${connection.url}/v1/bots/${botId}/terminal/close`, {
    method: "POST",
    headers: { authorization: `Bearer ${terminalReadGrant(connection.token, "bot-1")}`, "content-type": "application/json" },
    body: JSON.stringify({ sessionId: "p1" }),
  });
  const response = await close("bot-1");
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { closed: true });
  assert.equal((await close("bot-2")).status, 401);
  assert.deepEqual(calls, [["bot-1", "p1"]]);
  await bridge.close();
});

test("deleted bot cleanup retires its spawned panes through the bridge", async () => {
  const events = [];
  const children = [];
  const owner = { id: 1, isDestroyed: () => false, send: (...args) => events.push(args) };
  const host = createTerminalHost({
    authorize: () => {}, owner: () => owner, resolveCwd: async () => os.tmpdir(),
    platform: "linux", env: { SHELL: "/bin/sh" },
    loadPty: () => ({ spawn: () => {
      const child = { killed: false, onData() {}, onExit() {}, write() {}, resize() {}, kill() { this.killed = true; } };
      children.push(child);
      return child;
    } }),
  });
  const bridge = createTerminalBridge({ host });
  try {
    const access = await bridge.start();
    const main = await host.open({ sender: owner }, { botId: "bot-1", cols: 80, rows: 24 });
    const one = await host.openForBot("bot-1", { label: "one" });
    const two = await host.openForBot("bot-1", { label: "two" });
    const foreign = await host.openForBot("bot-2", { label: "foreign" });
    const unauthorized = await fetch(`${access.url}/v1/bots/bot-1/terminal`, { method: "DELETE" });
    assert.equal(unauthorized.status, 401);
    const crossBot = await fetch(`${access.url}/v1/bots/bot-1/terminal`, {
      method: "DELETE", headers: { authorization: `Bearer ${terminalReadGrant(access.token, "bot-2")}` },
    });
    assert.equal(crossBot.status, 401);
    await closeBotPanes(access, "bot-1");
    await closeBotPanes(access, "bot-1");
    assert.deepEqual(children.map((child) => child.killed), [false, true, true, false]);
    assert.deepEqual(host.readBot("bot-1").panes.map((pane) => pane.sessionId), [main.id]);
    assert.equal(host.readBot("bot-2").panes[0].sessionId, foreign.sessionId);
    assert.deepEqual(events.filter(([channel]) => channel === "terminal:closed").map(([, event]) => event.id), [one.sessionId, two.sessionId]);
  } finally {
    await bridge.close();
    host.dispose();
  }
});

for (const stage of ["folder", "ready"]) {
  test(`deleted bot cleanup rejects a pane pending ${stage}`, async () => {
    let release;
    let entered;
    const gate = new Promise((resolve) => { release = resolve; });
    const waiting = new Promise((resolve) => { entered = resolve; });
    const children = [];
    const events = [];
    const owner = { id: 1, isDestroyed: () => false, send: (...args) => events.push(args) };
    const host = createTerminalHost({
      authorize: () => {}, owner: () => owner,
      resolveCwd: async () => {
        if (stage === "folder") { entered(); await gate; }
        return os.tmpdir();
      },
      platform: "linux", env: { SHELL: "/bin/sh" },
      loadPty: () => ({ spawn: () => {
        const child = { killed: false, writes: [], ready: stage === "ready" ? gate : Promise.resolve(), onData() {}, onExit() {}, write(text) { this.writes.push(text); }, resize() {}, kill() { this.killed = true; } };
        children.push(child);
        if (stage === "ready") entered();
        return child;
      } }),
    });
    const bridge = createTerminalBridge({ host });
    try {
      const access = await bridge.start();
      const opening = host.openForBot("bot-1", { label: "pending", command: "worker-cli" });
      const rejected = assert.rejects(opening, /deleted/);
      await waiting;
      await closeBotPanes(access, "bot-1");
      assert.equal(children.some((child) => child.killed), false);
      release();
      await rejected;
      assert.deepEqual(host.readBot("bot-1").panes, []);
      assert.ok(children.every((child) => child.killed && child.writes.length === 0));
      assert.equal(events.some(([channel]) => channel === "terminal:opened"), false);
      await assert.rejects(host.openForBot("bot-1"), /deleted/);
    } finally {
      release();
      await bridge.close();
      host.dispose();
    }
  });
}

function updaterFixture() {
  const calls = [];
  let state = { status: "available", version: "1.0.53", appVersion: "1.0.52" };
  const updater = {
    state: () => state,
    check: async () => {
      calls.push("check");
      state = { ...state, status: "idle" };
    },
    download: () => {
      calls.push("download");
      state = { ...state, status: "downloading" };
      return new Promise(() => {});
    },
    install: () => {
      calls.push("install");
      state = { ...state, status: "installing" };
    },
  };
  return { calls, bridge: createTerminalBridge({ token: "bridge-secret", host: { readBot() {}, sendBot() {} }, updater }) };
}

test("serves the updater behind its own grant", async () => {
  const { bridge, calls } = updaterFixture();
  const connection = await bridge.start();
  const auth = { authorization: `Bearer ${updateGrant(connection.token)}` };
  assert.equal((await fetch(`${connection.url}/v1/update/state`)).status, 401);
  const botGrant = { authorization: `Bearer ${terminalReadGrant(connection.token, "update")}` };
  assert.equal((await fetch(`${connection.url}/v1/update/state`, { headers: botGrant })).status, 401);
  const state = await fetch(`${connection.url}/v1/update/state`, { headers: auth });
  assert.deepEqual(await state.json(), { status: "available", version: "1.0.53", appVersion: "1.0.52" });
  assert.equal((await fetch(`${connection.url}/v1/update/state`, { method: "POST", headers: auth })).status, 405);
  assert.equal((await fetch(`${connection.url}/v1/update/install`, { headers: auth })).status, 405);
  const download = await fetch(`${connection.url}/v1/update/download`, { method: "POST", headers: auth });
  assert.equal((await download.json()).status, "downloading");
  const check = await fetch(`${connection.url}/v1/update/check`, { method: "POST", headers: auth });
  assert.equal((await check.json()).status, "idle");
  const install = await fetch(`${connection.url}/v1/update/install`, { method: "POST", headers: auth });
  assert.equal((await install.json()).status, "installing");
  assert.deepEqual(calls, ["download", "check", "install"]);
  await bridge.close();
});

test("reports the updater missing when the bridge has none", async () => {
  const bridge = createTerminalBridge({ token: "bridge-secret", host: { readBot() {}, sendBot() {} } });
  const connection = await bridge.start();
  const response = await fetch(`${connection.url}/v1/update/state`, { headers: { authorization: `Bearer ${updateGrant(connection.token)}` } });
  assert.equal(response.status, 404);
  await bridge.close();
});

test("update grant matches the server's", () => {
  assert.equal(updateGrant("bridge-secret"), serverUpdateGrant("bridge-secret"));
});
