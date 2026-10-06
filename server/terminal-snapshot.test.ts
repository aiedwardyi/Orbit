import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { terminalPaneCountsGrant, terminalReadGrant, terminalSendGrant } from "./terminal-grant.ts";
import { acceptedPaneCounts, raisePaneAttention, terminalPaneCountsResponse, terminalSendResponse, terminalSnapshotResponse, terminalStartResponse } from "./terminal-snapshot.ts";
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

describe("remote terminal start", () => {
  it("starts the main shell with the per-bot grant and relays only the snapshot fields", async () => {
    const calls: Array<{ url: string; auth: string | null; method: string | undefined }> = [];
    const fetchImpl: typeof fetch = async (url, init) => {
      calls.push({ url: String(url), auth: new Headers(init?.headers).get("authorization"), method: init?.method });
      return new Response(JSON.stringify({ botId: "bot-1", sessionId: "s1", generation: 1, screenText: "PS>", output: "raw", panes: [{ sessionId: "s1", main: true, screenText: "PS>" }] }));
    };
    await expect(terminalStartResponse(ACCESS, "bot-1", fetchImpl)).resolves.toEqual({
      status: 200,
      body: { sessionId: "s1", generation: 1, screenText: "PS>", panes: [{ sessionId: "s1", main: true }] },
    });
    expect(calls).toEqual([{ url: `${ACCESS.url}/v1/bots/bot-1/terminal/main`, auth: `Bearer ${terminalReadGrant(ACCESS.token, "bot-1")}`, method: "POST" }]);
  });

  it("answers 503 without a bridge and keeps the host's reason on failure", async () => {
    const never: typeof fetch = async () => { throw new Error("must not fetch"); };
    await expect(terminalStartResponse(null, "bot-1", never)).resolves.toEqual({ status: 503, body: { error: "terminal bridge unavailable" } });
    const refused: typeof fetch = async () => new Response(JSON.stringify({ error: "Terminal folder is unavailable" }), { status: 400 });
    await expect(terminalStartResponse(ACCESS, "bot-1", refused)).resolves.toEqual({ status: 502, body: { error: "Terminal folder is unavailable" } });
    const down: typeof fetch = async () => { throw new Error("offline"); };
    await expect(terminalStartResponse(ACCESS, "bot-1", down)).resolves.toEqual({ status: 502, body: { error: "terminal bridge unreachable" } });
  });

  it("routes the remote start through the app's own auth", () => {
    expect(server).toContain("terminalStartResponse(terminalBridgeAccess, bot.id)");
    expect(remoteAccess).toContain('BEARER_ONLY_PATHS = new Set(["/api/internal/terminal-bridge"])');
  });
});

describe("terminal snapshot relay", () => {
  it("answers 503 when the desktop bridge is absent", async () => {
    const fetchImpl = (async () => { throw new Error("must not fetch"); }) as typeof fetch;
    await expect(terminalSnapshotResponse(null, "bot-1", undefined, fetchImpl)).resolves.toEqual({
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
        screenRuns: [[{ t: "$", fg: 2 }, { t: " ls" }]],
        recentText: "done",
        seq: 9,
        modes: [1],
      }), { status: 200, headers: { "content-type": "application/json" } });
    }) as typeof fetch;
    await expect(terminalSnapshotResponse(ACCESS, "bot-1", undefined, fetchImpl)).resolves.toEqual({
      status: 200,
      body: { screenText: "$ ls", screenRuns: [[{ t: "$", fg: 2 }, { t: " ls" }]], recentText: "done", sessionId: "s1", generation: 2, cwd: "C:\work", exited: false },
    });
    expect(calls).toEqual([
      { url: "http://127.0.0.1:52150/v1/bots/bot-1/terminal", auth: `Bearer ${terminalReadGrant(ACCESS.token, "bot-1")}` },
    ]);
  });

  it("passes the no-terminal state through", async () => {
    const fetchImpl = (async () => new Response(JSON.stringify({ botId: "bot-1", state: "no-terminal", screenText: "", recentText: "" }))) as typeof fetch;
    await expect(terminalSnapshotResponse(ACCESS, "bot-1", undefined, fetchImpl)).resolves.toMatchObject({ status: 200, body: { state: "no-terminal" } });
  });

  it("passes sessionId through as a query param and relays panes and label", async () => {
    const calls: Array<{ url: string }> = [];
    const fetchImpl = (async (url: string | URL | Request) => {
      calls.push({ url: String(url) });
      return new Response(JSON.stringify({
        botId: "bot-1",
        sessionId: "worker",
        label: "build",
        cwd: "C:\work",
        exited: false,
        screenText: "$ build",
        recentText: "",
        panes: [
          { sessionId: "main", generation: 1, label: null, cwd: "C:\work", main: true, exited: false },
          { sessionId: "worker", generation: 1, label: "build", cwd: "C:\work\worker", main: false, exited: false },
        ],
      }));
    }) as typeof fetch;
    await expect(terminalSnapshotResponse(ACCESS, "bot-1", "worker", fetchImpl)).resolves.toMatchObject({
      status: 200,
      body: {
        label: "build",
        panes: [
          { sessionId: "main", generation: 1, label: null, cwd: "C:\work", main: true, exited: false },
          { sessionId: "worker", generation: 1, label: "build", cwd: "C:\work\worker", main: false, exited: false },
        ],
      },
    });
    expect(calls).toEqual([{ url: "http://127.0.0.1:52150/v1/bots/bot-1/terminal?sessionId=worker" }]);
  });

  it("keeps other panes' screens out of the browser snapshot", async () => {
    const fetchImpl = (async () => new Response(JSON.stringify({
      sessionId: "main",
      screenText: "$ ls",
      panes: [{ sessionId: "main", generation: 1, label: null, main: true, screenText: "$ ls" }],
    }))) as typeof fetch;
    const { body } = await terminalSnapshotResponse(ACCESS, "bot-1", undefined, fetchImpl);
    expect(body.panes).toEqual([{ sessionId: "main", generation: 1, label: null, main: true }]);
  });

  it("answers a clean 404 for an unknown or closed pane instead of a 502", async () => {
    const notFound = (async () => new Response(JSON.stringify({ error: "Unknown terminal route" }), { status: 404 })) as typeof fetch;
    await expect(terminalSnapshotResponse(ACCESS, "bot-1", "gone", notFound)).resolves.toEqual({
      status: 404,
      body: { error: "Unknown terminal" },
    });
    const unknownPane = (async () => new Response(JSON.stringify({ error: "Unknown terminal" }), { status: 409 })) as typeof fetch;
    await expect(terminalSnapshotResponse(ACCESS, "bot-1", "gone", unknownPane)).resolves.toEqual({
      status: 404,
      body: { error: "Unknown terminal" },
    });
  });

  it("maps bridge failures to 502", async () => {
    const failing = (async () => new Response("{}", { status: 401 })) as typeof fetch;
    await expect(terminalSnapshotResponse(ACCESS, "bot-1", undefined, failing)).resolves.toMatchObject({ status: 502 });
    const down = (async () => { throw new TypeError("fetch failed"); }) as typeof fetch;
    await expect(terminalSnapshotResponse(ACCESS, "bot-1", undefined, down)).resolves.toMatchObject({ status: 502 });
  });

  it("routes GET /api/bots/:id/terminal through the bot lookup and normal /api auth", () => {
    const route = server.slice(server.indexOf("/terminal$/);"), server.indexOf("/terminal$/);") + 400);
    expect(route).toContain('method === "GET"');
    expect(route).toContain('json(res, 404, { error: "no such bot" })');
    expect(route).toContain("terminalSnapshotResponse(terminalBridgeAccess, bot.id, url.searchParams.get(\"sessionId\"))");
    expect(remoteAccess).not.toMatch(/BEARER_ONLY_PATHS = new Set\([^)]*\/terminal"/);
  });
});

describe("terminal pane counts", () => {
  it("answers 503 when the desktop bridge is absent", async () => {
    const fetchImpl = (async () => { throw new Error("must not fetch"); }) as typeof fetch;
    await expect(terminalPaneCountsResponse(null, fetchImpl)).resolves.toEqual({
      status: 503,
      body: { error: "terminal bridge unavailable" },
    });
  });

  it("reads with the pane-counts grant and keeps labels with their counts", async () => {
    const calls: Array<{ url: string; auth: string | null }> = [];
    const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: String(url), auth: new Headers(init?.headers).get("authorization") });
      return new Response(JSON.stringify({
        counts: { "bot-1": 2, "bot-2": 1 },
        panes: { "bot-1": ["w1", "w2"], "bot-2": ["other"] },
      }));
    }) as typeof fetch;
    await expect(terminalPaneCountsResponse(ACCESS, fetchImpl)).resolves.toEqual({
      status: 200,
      body: { counts: { "bot-1": 2, "bot-2": 1 }, panes: { "bot-1": ["w1", "w2"], "bot-2": ["other"] } },
    });
    expect(calls).toEqual([
      { url: "http://127.0.0.1:52150/v1/terminal/pane-counts", auth: `Bearer ${terminalPaneCountsGrant(ACCESS.token)}` },
    ]);
  });

  it("drops a bad bot id and a count past the pane cap, and can answer counts alone", () => {
    expect(acceptedPaneCounts({
      panes: { "bot-1": ["w1", "w2"], "../x": ["nope"], "bot-2": [] },
      counts: { "bot-1": 9 },
    })).toEqual({ counts: { "bot-1": 2 }, panes: { "bot-1": ["w1", "w2"] } });
    expect(acceptedPaneCounts({ counts: { "bot-3": 2, "bot-4": 0, "bad id": 1 } })).toEqual({
      counts: { "bot-3": 2 },
      panes: {},
    });
  });

  it("maps a bad bridge body or a down bridge to 502", async () => {
    const bad = (async () => new Response(JSON.stringify({ panes: { "bot-1": [1] } }))) as typeof fetch;
    await expect(terminalPaneCountsResponse(ACCESS, bad)).resolves.toEqual({
      status: 502,
      body: { error: "terminal bridge: bad pane counts" },
    });
    const denied = (async () => new Response("{}", { status: 401 })) as typeof fetch;
    await expect(terminalPaneCountsResponse(ACCESS, denied)).resolves.toEqual({
      status: 502,
      body: { error: "terminal bridge: HTTP 401" },
    });
    const down = (async () => { throw new TypeError("fetch failed"); }) as typeof fetch;
    await expect(terminalPaneCountsResponse(ACCESS, down)).resolves.toEqual({
      status: 502,
      body: { error: "terminal bridge unreachable" },
    });
  });

  it("routes GET /api/terminal/pane-counts through the bridge with normal /api auth", () => {
    const start = server.indexOf('if (method === "GET" && path === "/api/terminal/pane-counts")');
    const route = server.slice(start, start + 240);
    expect(route).toContain('method === "GET"');
    expect(route).toContain("terminalPaneCountsResponse(terminalBridgeAccess)");
    expect(remoteAccess).not.toMatch(/BEARER_ONLY_PATHS = new Set\([^)]*pane-counts/);
  });
});

describe("terminal send relay", () => {
  const input = { sessionId: "s1", generation: 2, text: "ls\n" };
  const mustNotFetch = (async () => { throw new Error("must not fetch"); }) as typeof fetch;

  it("rejects bad input, oversized text and Ctrl+C before the bridge", async () => {
    await expect(terminalSendResponse(ACCESS, "bot-1", { sessionId: "s1", text: "ls\n" }, mustNotFetch)).resolves.toMatchObject({ status: 400 });
    await expect(terminalSendResponse(ACCESS, "bot-1", { ...input, text: "x".repeat(4 * 1024 + 1) }, mustNotFetch)).resolves.toEqual({
      status: 400,
      body: { error: "terminal input is capped at 4KB" },
    });
    await expect(terminalSendResponse(ACCESS, "bot-1", { ...input, text: "\x03" }, mustNotFetch)).resolves.toEqual({
      status: 400,
      body: { error: "Ctrl+C is not allowed" },
    });
    await expect(terminalSendResponse(null, "bot-1", input, mustNotFetch)).resolves.toEqual({
      status: 503,
      body: { error: "terminal bridge unavailable" },
    });
  });

  it.each(["\x1c", "\x1a", "\x04", "\x1b[99;5u", "\x00", "\x7f"])("refuses control bytes like %j before the bridge", async (text) => {
    await expect(terminalSendResponse(ACCESS, "bot-1", { ...input, text: `ls${text}\n` }, mustNotFetch)).resolves.toEqual({
      status: 400,
      body: { error: "control characters are not allowed" },
    });
  });

  it.each(["\t", "\n", "\r", "echo hi"])("passes %j through to the bridge", async (text) => {
    const fetchImpl = (async () => Response.json({ screenText: "$" })) as typeof fetch;
    await expect(terminalSendResponse(ACCESS, "bot-1", { ...input, text }, fetchImpl)).resolves.toEqual({
      status: 200,
      body: { screenText: "$" },
    });
  });

  it("frames a validated multi-line paste and still refuses a raw ESC in it", async () => {
    const bodies: unknown[] = [];
    const fetchImpl = (async (_url: string | URL | Request, init?: RequestInit) => {
      bodies.push(JSON.parse(String(init?.body)));
      return Response.json({ screenText: "$" });
    }) as typeof fetch;
    await expect(terminalSendResponse(ACCESS, "bot-1", { ...input, text: "first\nsecond", paste: true }, fetchImpl)).resolves.toMatchObject({ status: 200 });
    expect(bodies).toEqual([{ sessionId: "s1", generation: 2, text: "\x1b[200~first\nsecond\x1b[201~\n" }]);
    await expect(terminalSendResponse(ACCESS, "bot-1", { ...input, text: "first\x1b[201~\nsecond", paste: true }, mustNotFetch)).resolves.toEqual({
      status: 400,
      body: { error: "control characters are not allowed" },
    });
  });

  it.each([
    ["up", "\x1b[A"],
    ["down", "\x1b[B"],
    ["enter", "\r"],
    ["esc", "\x1b"],
  ])("maps the %s key to its bytes", async (key, text) => {
    const bodies: unknown[] = [];
    const fetchImpl = (async (_url: string | URL | Request, init?: RequestInit) => {
      bodies.push(JSON.parse(String(init?.body)));
      return Response.json({ screenText: "$" });
    }) as typeof fetch;
    await expect(terminalSendResponse(ACCESS, "bot-1", { sessionId: "s1", generation: 2, key }, fetchImpl)).resolves.toMatchObject({ status: 200 });
    expect(bodies).toEqual([{ sessionId: "s1", generation: 2, text }]);
  });

  it("refuses an unknown key before the bridge", async () => {
    await expect(terminalSendResponse(ACCESS, "bot-1", { sessionId: "s1", generation: 2, key: "ctrl+c" }, mustNotFetch)).resolves.toMatchObject({ status: 400 });
  });

  it("posts with the send grant and relays only the snapshot fields", async () => {
    const calls: Array<{ url: string; auth: string | null; method: string | undefined; body: unknown }> = [];
    const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: String(url), auth: new Headers(init?.headers).get("authorization"), method: init?.method, body: JSON.parse(String(init?.body)) });
      return new Response(JSON.stringify({ botId: "bot-1", sessionId: "s1", generation: 2, screenText: "$ ls", screenRuns: [[{ t: "$ ls" }]], seq: 9, modes: [1], panes: [] }));
    }) as typeof fetch;
    await expect(terminalSendResponse(ACCESS, "bot-1", { ...input, extra: true }, fetchImpl)).resolves.toEqual({
      status: 200,
      body: { sessionId: "s1", generation: 2, screenText: "$ ls", screenRuns: [[{ t: "$ ls" }]], panes: [] },
    });
    expect(calls).toEqual([{
      url: "http://127.0.0.1:52150/v1/bots/bot-1/terminal/send",
      auth: `Bearer ${terminalSendGrant(ACCESS.token, "bot-1")}`,
      method: "POST",
      body: input,
    }]);
    expect(terminalSendGrant(ACCESS.token, "bot-1")).not.toBe(terminalReadGrant(ACCESS.token, "bot-1"));
  });

  it("maps bridge errors", async () => {
    const reply = (status: number, error?: string) => (async () => new Response(JSON.stringify(error ? { error } : {}), { status })) as typeof fetch;
    await expect(terminalSendResponse(ACCESS, "bot-1", input, reply(404, "Unknown terminal route"))).resolves.toEqual({ status: 404, body: { error: "Unknown terminal" } });
    await expect(terminalSendResponse(ACCESS, "bot-1", input, reply(409, "Unknown terminal"))).resolves.toEqual({ status: 404, body: { error: "Unknown terminal" } });
    await expect(terminalSendResponse(ACCESS, "bot-1", input, reply(409, "Terminal session is stale; take a fresh snapshot"))).resolves.toEqual({
      status: 409,
      body: { error: "Terminal session is stale; take a fresh snapshot" },
    });
    await expect(terminalSendResponse(ACCESS, "bot-1", input, reply(401))).resolves.toEqual({ status: 502, body: { error: "terminal bridge: HTTP 401" } });
    const down = (async () => { throw new TypeError("fetch failed"); }) as typeof fetch;
    await expect(terminalSendResponse(ACCESS, "bot-1", input, down)).resolves.toEqual({ status: 502, body: { error: "terminal bridge unreachable" } });
  });

  it("routes POST /api/bots/:id/terminal/send through the bot lookup and normal /api auth", () => {
    const route = server.slice(server.indexOf("/terminal\\/send$/);"), server.indexOf("/terminal\\/send$/);") + 400);
    expect(route).toContain('method === "POST"');
    expect(route).toContain('json(res, 404, { error: "no such bot" })');
    expect(route).toContain("terminalSendResponse(terminalBridgeAccess, bot.id, await readBody(req))");
    expect(remoteAccess).not.toMatch(/BEARER_ONLY_PATHS = new Set\([^)]*\/terminal\/send"/);
  });
});

describe("pane attention relay", () => {
  it("posts the pane to the bridge with the per-bot grant and swallows failures", async () => {
    const calls: Array<{ url: string; auth: string | null; body: unknown }> = [];
    const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: String(url), auth: new Headers(init?.headers).get("authorization"), body: JSON.parse(String(init?.body)) });
      return new Response("{}");
    }) as typeof fetch;
    await raisePaneAttention(null, "bot-1", "pane-1", undefined, fetchImpl);
    await raisePaneAttention(ACCESS, "bot-1", "pane-1", undefined, fetchImpl);
    await raisePaneAttention(ACCESS, "bot-1", "pane-1", "report", fetchImpl);
    const auth = `Bearer ${terminalReadGrant(ACCESS.token, "bot-1")}`;
    expect(calls).toEqual([
      { url: "http://127.0.0.1:52150/v1/bots/bot-1/terminal/attention", auth, body: { sessionId: "pane-1" } },
      { url: "http://127.0.0.1:52150/v1/bots/bot-1/terminal/attention", auth, body: { sessionId: "pane-1", kind: "report" } },
    ]);
    const down = (async () => { throw new TypeError("fetch failed"); }) as typeof fetch;
    await expect(raisePaneAttention(ACCESS, "bot-1", "pane-1", undefined, down)).resolves.toBeUndefined();
  });

  it("raises attention with the note kind after the mailbox stores a pane note", () => {
    const route = server.slice(server.indexOf('path === "/api/mailbox"'), server.indexOf('path === "/api/mailbox"') + 1600);
    expect(route).toContain("raisePaneAttention(terminalBridgeAccess, scope.bot, scope.pane, parsed.data.kind)");
  });
});
