import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";

import * as mailbox from "./mailbox.ts";
import { terminalReadGrant } from "./terminal-grant.ts";

const ACCESS = { url: "http://127.0.0.1:1", token: "bridge-secret" };
const SCOPE = { bot: "worker", pane: "pane-1" };

describe("mailbox turn-end delivery", () => {
  it("queues the original text at the private bridge without delivering a note", async () => {
    const fetchImpl = vi.fn(async (_url: string | URL | Request, _init?: RequestInit) => new Response('{"raised":true}'));
    expect(await mailbox.deferMailboxAuto(ACCESS, SCOPE, "done", fetchImpl)).toBe(true);
    expect(fetchImpl).toHaveBeenCalledOnce();
    const [url, init] = fetchImpl.mock.calls[0]!;
    expect(url).toBe(`${ACCESS.url}/v1/bots/worker/terminal/attention`);
    expect(new Headers(init?.headers).get("authorization")).toBe(`Bearer ${terminalReadGrant(ACCESS.token, "worker")}`);
    expect(JSON.parse(String(init?.body))).toEqual({ sessionId: "pane-1", kind: "auto", text: "done" });
  });

  it("fails closed when the bridge or pane is unavailable", async () => {
    const down = vi.fn(async () => { throw new Error("offline"); });
    expect(await mailbox.deferMailboxAuto(null, SCOPE, "done", down)).toBe(false);
    expect(down).not.toHaveBeenCalled();
    expect(await mailbox.deferMailboxAuto(ACCESS, SCOPE, "done", down)).toBe(false);
    expect(await mailbox.deferMailboxAuto(ACCESS, SCOPE, "done", async () => new Response('{"raised":false}'))).toBe(false);
    expect(await mailbox.deferMailboxAuto(ACCESS, SCOPE, "done", async () => new Response('{"raised":true}', { status: 503 }))).toBe(false);
  });

  it("defers auto posts before storage and acknowledges reports before storage", () => {
    const server = readFileSync(new URL("./index.ts", import.meta.url), "utf8");
    const route = server.slice(server.indexOf('path === "/api/mailbox"'), server.indexOf('path.startsWith("/api/")', server.indexOf('path === "/api/mailbox"')));
    expect(route).toContain('parsed.data.kind === "auto"');
    expect(route).not.toContain("mailboxAutoDedup.shouldDrop");
    expect(route.indexOf("deferMailboxAuto(")).toBeLessThan(route.indexOf("store.appendMessage("));
    expect(route).toContain("{ ok: true, deferred: true }");
    expect(route.indexOf("await raisePaneAttention(")).toBeLessThan(route.indexOf("store.appendMessage("));
  });
});
