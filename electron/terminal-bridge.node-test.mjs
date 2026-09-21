import assert from "node:assert/strict";
import test from "node:test";
import { createTerminalBridge, terminalReadGrant } from "./terminal-bridge.mjs";

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
