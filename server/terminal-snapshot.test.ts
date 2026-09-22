import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { terminalReadGrant } from "./terminal-grant.ts";
import { raisePaneAttention, terminalSnapshotResponse } from "./terminal-snapshot.ts";
import { closeBotPanes } from "./terminal-cleanup.ts";

const ACCESS = { url: "http://127.0.0.1:52150", token: "bridge-secret" };
const server = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "index.ts"), "utf8");
const remoteAccess = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "remote-access.ts"), "utf8");

describe("deleted bot pane cleanup", () => {
  it("retires spawned panes with the deleted bot's grant", async () => {
    const calls: Array<{ url: string; auth: string | null; method: string | undefined }> = [];
    const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: String(url), auth: new Headers(init?.headers).get("authorization"), method: init?.method });
      return new Response("{}");
    }) as typeof fetch;
    await closeBotPanes(null, "bot-1", fetchImpl);
    expect(calls).toEqual([]);
    await closeBotPanes(ACCESS, "bot-1", fetchImpl);
    const url = `${ACCESS.url}/v1/bots/bot-1/terminal`;
    const auth = `Bearer ${terminalReadGrant(ACCESS.token, "bot-1")}`;
    expect(calls).toEqual([
      { url, auth, method: "DELETE" },
    ]);
  });

  it("reports a disconnected bridge", async () => {
    const fetchImpl = (async () => { throw new Error("bridge disconnected"); }) as typeof fetch;
    await expect(closeBotPanes(ACCESS, "bot-1", fetchImpl)).rejects.toThrow("bridge disconnected");
  });

  it("reports bridge failure", async () => {
    const down = (async () => new Response("{}", { status: 503 })) as typeof fetch;
    await expect(closeBotPanes(ACCESS, "bot-1", down)).rejects.toThrow("503");
  });

  it("runs cleanup for every persisted bot deletion", () => {
    const deletion = server.slice(server.indexOf('case "bot.deleted":'), server.indexOf('case "bots.order":'));
    expect(deletion).toContain("closeBotPanes(terminalBridgeAccess, change.botId)");
  });
});

describe("terminal snapshot relay", () => {
  it("answers 503 when the desktop bridge is absent", async () => {
    const fetchImpl = (async () => { throw new Error("must not fetch"); }) as typeof fetch;
    await expect(terminalSnapshotResponse(null, "bot-1", fetchImpl)).resolves.toEqual({
      status: 503,
      body: { error: "terminal bridge unavailable" },
    });
  });

  it("reads with the per-bot grant and relays only the snapshot fields", async () => {
    const calls: Array<{ url: string; auth: string | null }> = [];
    const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: String(url), auth: new Headers(init?.headers).get("authorization") });
      return new Response(JSON.stringify({
        botId: "bot-1",
        sessionId: "s1",
        generation: 2,
        cwd: "C:\work",
        exited: false,
        screenText: "$ ls",
        recentText: "done",
        seq: 9,
        modes: [1],
      }), { status: 200, headers: { "content-type": "application/json" } });
    }) as typeof fetch;
    await expect(terminalSnapshotResponse(ACCESS, "bot-1", fetchImpl)).resolves.toEqual({
      status: 200,
      body: { screenText: "$ ls", recentText: "done", sessionId: "s1", generation: 2, cwd: "C:\work", exited: false },
    });
    expect(calls).toEqual([
      { url: "http://127.0.0.1:52150/v1/bots/bot-1/terminal", auth: `Bearer ${terminalReadGrant(ACCESS.token, "bot-1")}` },
    ]);
  });

  it("passes the no-terminal state through", async () => {
    const fetchImpl = (async () => new Response(JSON.stringify({ botId: "bot-1", state: "no-terminal", screenText: "", recentText: "" }))) as typeof fetch;
    await expect(terminalSnapshotResponse(ACCESS, "bot-1", fetchImpl)).resolves.toMatchObject({ status: 200, body: { state: "no-terminal" } });
  });

  it("maps bridge failures to 502", async () => {
    const failing = (async () => new Response("{}", { status: 401 })) as typeof fetch;
    await expect(terminalSnapshotResponse(ACCESS, "bot-1", failing)).resolves.toMatchObject({ status: 502 });
    const down = (async () => { throw new TypeError("fetch failed"); }) as typeof fetch;
    await expect(terminalSnapshotResponse(ACCESS, "bot-1", down)).resolves.toMatchObject({ status: 502 });
  });

  it("routes GET /api/bots/:id/terminal through the bot lookup and normal /api auth", () => {
    const route = server.slice(server.indexOf("/terminal$/);"), server.indexOf("/terminal$/);") + 400);
    expect(route).toContain('method === "GET"');
    expect(route).toContain('json(res, 404, { error: "no such bot" })');
    expect(route).toContain("terminalSnapshotResponse(terminalBridgeAccess, bot.id)");
    expect(remoteAccess).not.toMatch(/BEARER_ONLY_PATHS = new Set\([^)]*\/terminal"/);
  });
});

describe("pane attention relay", () => {
  it("posts the pane to the bridge with the per-bot grant and swallows failures", async () => {
    const calls: Array<{ url: string; auth: string | null; body: unknown }> = [];
    const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: String(url), auth: new Headers(init?.headers).get("authorization"), body: JSON.parse(String(init?.body)) });
      return new Response("{}");
    }) as typeof fetch;
    await raisePaneAttention(null, "bot-1", "pane-1", fetchImpl);
    await raisePaneAttention(ACCESS, "bot-1", "pane-1", fetchImpl);
    expect(calls).toEqual([
      { url: "http://127.0.0.1:52150/v1/bots/bot-1/terminal/attention", auth: `Bearer ${terminalReadGrant(ACCESS.token, "bot-1")}`, body: { sessionId: "pane-1" } },
    ]);
    const down = (async () => { throw new TypeError("fetch failed"); }) as typeof fetch;
    await expect(raisePaneAttention(ACCESS, "bot-1", "pane-1", down)).resolves.toBeUndefined();
  });

  it("raises attention after the mailbox stores a pane note", () => {
    const route = server.slice(server.indexOf('path === "/api/mailbox"'), server.indexOf('path === "/api/mailbox"') + 1200);
    expect(route).toContain("raisePaneAttention(terminalBridgeAccess, scope.bot, scope.pane)");
  });
});
