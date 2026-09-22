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
  it("closes spawned panes with the deleted bot's grant and leaves the main pane alone", async () => {
    const calls: Array<{ url: string; auth: string | null; body: unknown }> = [];
    const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: String(url), auth: new Headers(init?.headers).get("authorization"), body: init?.body ? JSON.parse(String(init.body)) : null });
      return new Response(JSON.stringify({ panes: [{ sessionId: "main", main: true }, { sessionId: "worker", main: false }, { sessionId: "exited", main: false }] }));
    }) as typeof fetch;
    await closeBotPanes(null, "bot-1", fetchImpl);
    expect(calls).toEqual([]);
    await closeBotPanes(ACCESS, "bot-1", fetchImpl);
    const url = `${ACCESS.url}/v1/bots/bot-1/terminal`;
    const auth = `Bearer ${terminalReadGrant(ACCESS.token, "bot-1")}`;
    expect(calls).toEqual([
      { url, auth, body: null },
      { url: `${url}/close`, auth, body: { sessionId: "worker" } },
      { url: `${url}/close`, auth, body: { sessionId: "exited" } },
    ]);
  });

  it("still closes the remaining panes when one close fails", async () => {
    const closed: string[] = [];
    const fetchImpl = (async (_url: string | URL | Request, init?: RequestInit) => {
      if (!init?.body) return new Response(JSON.stringify({ panes: [{ sessionId: "one", main: false }, { sessionId: "two", main: false }] }));
      const { sessionId } = JSON.parse(String(init.body));
      closed.push(sessionId);
      if (sessionId === "one") throw new Error("bridge disconnected");
      return new Response("{}");
    }) as typeof fetch;
    await expect(closeBotPanes(ACCESS, "bot-1", fetchImpl)).rejects.toThrow("bridge disconnected");
    expect(closed).toEqual(["one", "two"]);
  });

  it("reports bridge failure but accepts an already closed pane", async () => {
    const down = (async () => new Response("{}", { status: 503 })) as typeof fetch;
    await expect(closeBotPanes(ACCESS, "bot-1", down)).rejects.toThrow("503");
    for (const status of [409, 500]) {
      const fetchImpl = (async (_url: string | URL | Request, init?: RequestInit) => init?.body
        ? new Response("{}", { status })
        : new Response(JSON.stringify({ panes: [{ sessionId: "worker", main: false }] }))) as typeof fetch;
      if (status === 409) await expect(closeBotPanes(ACCESS, "bot-1", fetchImpl)).resolves.toBeUndefined();
      else await expect(closeBotPanes(ACCESS, "bot-1", fetchImpl)).rejects.toThrow("500");
    }
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
