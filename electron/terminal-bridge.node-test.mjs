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

test("read grants cannot reach a terminal write endpoint", async () => {
  let received = false;
  const bridge = createTerminalBridge({
    token: "bridge-secret",
    host: {
      readBot: () => ({ botId: "bot-1", state: "no-terminal" }),
      sendBot: () => { received = true; },
    },
  });
  const connection = await bridge.start();
  const response = await fetch(`${connection.url}/v1/bots/bot-1/terminal/send`, {
    method: "POST",
    headers: { authorization: `Bearer ${terminalReadGrant(connection.token, "bot-1")}`, "content-type": "application/json" },
    body: JSON.stringify({ sessionId: "s1", generation: 2, text: "echo exact\r" }),
  });
  assert.equal(response.status, 405);
  assert.equal(received, false);
  await bridge.close();
});
