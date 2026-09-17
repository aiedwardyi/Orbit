import { describe, expect, it } from "vitest";

import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { createUsageRefresh, isCsrfRejection, readAntigravityQuota, readAntigravityUsageCommand, readGrokBillingRpc, readMuseUsage, usageRefreshResponse } from "./usage-refresh.ts";
import { antigravityRateLimitWindows } from "./drivers/rate-limits.ts";
import { removeTempDir } from "./testing/cleanup.ts";

const reset = "2026-10-01T12:00:00Z";
const FAKE_MSP_CLI = join(dirname(fileURLToPath(import.meta.url)), "testing", "fake-msp-cli.ts");
const FAKE_ACP_CLI = join(dirname(fileURLToPath(import.meta.url)), "testing", "fake-acp-cli.ts");
const fixtures = {
  claudeAgent: { five_hour: { utilization: 42, resets_at: reset }, seven_day: { utilization: 19, resets_at: reset } },
  codex: { rateLimits: { primary: { usedPercent: 42, windowDurationMins: 300, resetsAt: Date.parse(reset) / 1000 }, secondary: { usedPercent: 19, windowDurationMins: 10080, resetsAt: Date.parse(reset) / 1000 } } },
  grokAgent: { config: { creditUsagePercent: 42, currentPeriod: { type: "USAGE_PERIOD_TYPE_WEEKLY", end: reset } } },
  antigravityAgent: {
    "gemini-5h": { remaining_fraction: 0.58, reset_in_seconds: 3600 },
    "gemini-weekly": { remaining_fraction: 0.81, reset_in_seconds: 518_400 },
  },
  museAgent: {
    usage: {
      observedAtMs: 1_790_000_000_000,
      tier: "pro",
      window: { usedPercent: 22, windowDurationMins: 300, resetsAtMs: 1_790_000_000_000 },
      weekly: { usedPercent: 61, resetsAtMs: 1_790_172_800_000 },
    },
  },
};
const credentials = JSON.stringify({ claudeAiOauth: { accessToken: "access-secret" }, "auth.x.ai::test": { key: "access-secret", user_id: "user" }, tokens: { access_token: "access-secret", refresh_token: "refresh-secret" } });

describe("usage refresh route result", () => {
  it.each(["claudeAgent", "codex"] as const)("normalizes %s without leaking credentials", async (driver) => {
    const refresh = createUsageRefresh({
      platform: "linux",
      read: async () => credentials,
      request: async (_url, init) => {
        expect(new Headers(init?.headers).get("authorization")).toBe("Bearer access-secret");
        expect(init?.redirect).toBe("error");
        return Response.json({ ...fixtures[driver], access_token: "access-secret", refresh_token: "refresh-secret", authorization: "Bearer access-secret" });
      },
      rpc: async () => fixtures.codex,
    });
    const result = await refresh(driver, { instanceId: driver });
    expect(result.error).toBeUndefined();
    expect(result.report?.windows.map((window) => window.usedPercent)).toEqual([42, 19]);
    expect(result.report?.windows.map((window) => window.id)).toEqual(["five_hour", "seven_day"]);
    for (const secret of ["access-secret", "refresh-secret", "Bearer", "access_token", "refresh_token", "authorization"]) expect(JSON.stringify(result)).not.toContain(secret);
    expect(JSON.stringify(usageRefreshResponse(driver, result))).not.toContain("access-secret");
  });

  it("normalizes grokAgent from ACP billing without reading auth.json", async () => {
    let reads = 0;
    let http = 0;
    const refresh = createUsageRefresh({
      platform: "linux",
      read: async () => {
        reads++;
        return credentials;
      },
      request: async () => {
        http++;
        return Response.json({ access_token: "access-secret" });
      },
      billing: async () => fixtures.grokAgent,
    });
    const result = await refresh("grokAgent", { instanceId: "grok" });
    expect(result.error).toBeUndefined();
    expect(result.report?.windows).toEqual([
      { id: "seven_day", usedPercent: 42, resetsAt: Date.parse(reset), windowMinutes: 10_080 },
    ]);
    expect(reads).toBe(0);
    expect(http).toBe(0);
    expect(JSON.stringify(result)).not.toContain("access-secret");
  });

  it("uses Grok's launcher, cached-token auth, and billing method contract", async () => {
    const scratch = mkdtempSync(join(tmpdir(), "omb-grok-refresh-"));
    const argsDump = join(scratch, "args.json");
    const rpcDump = join(scratch, "rpc.json");
    try {
      const result = await readGrokBillingRpc(FAKE_ACP_CLI, {
        FAKE_ACP_DUMP: argsDump,
        FAKE_ACP_RPC_DUMP: rpcDump,
      });
      expect(result).toMatchObject({ config: { creditUsagePercent: 42, currentPeriod: { type: "USAGE_PERIOD_TYPE_WEEKLY" } } });
      expect(JSON.parse(readFileSync(argsDump, "utf8")).argv).toEqual(["--permission-mode", "default", "agent", "stdio"]);
      expect(JSON.parse(readFileSync(rpcDump, "utf8"))).toEqual(["initialize", "authenticate", "_x.ai/billing"]);
    } finally {
      removeTempDir(scratch);
    }
  });

  it("keeps two credential stores isolated within the throttle window", async () => {
    let calls = 0;
    const refresh = createUsageRefresh({
      platform: "linux",
      now: () => 1_000,
      read: async (path) => JSON.stringify({ claudeAiOauth: { accessToken: path.includes("account-a") ? "token-a" : "token-b" } }),
      request: async (_url, init) => {
        calls++;
        const utilization = new Headers(init?.headers).get("authorization") === "Bearer token-a" ? 12 : 67;
        return Response.json({ five_hour: { utilization, resets_at: reset }, seven_day: null });
      },
    });
    const account = (instanceId: string) => ({ instanceId, environment: { CLAUDE_CONFIG_DIR: instanceId, CLAUDE_CODE_OAUTH_TOKEN: "" } });
    const first = await refresh("claudeAgent", account("account-a"));
    const second = await refresh("claudeAgent", account("account-b"));
    expect(first.report?.windows[0].usedPercent).toBe(12);
    expect(second.report?.windows[0].usedPercent).toBe(67);
    expect(await refresh("claudeAgent", account("account-a"))).toEqual(first);
    expect(await refresh("claudeAgent", account("account-b"))).toEqual(second);
    expect(calls).toBe(2);
  });

  it("coalesces concurrent reads and throttles failed attempts for 30 seconds", async () => {
    let now = 1_000;
    let calls = 0;
    let status = 200;
    const refresh = createUsageRefresh({ platform: "linux", now: () => now, read: async () => credentials, request: async () => {
      calls++;
      return Response.json(fixtures.claudeAgent, { status });
    } });
    const [first, second] = await Promise.all([refresh("claudeAgent", { instanceId: "claude" }), refresh("claudeAgent", { instanceId: "claude" })]);
    expect(calls).toBe(1);
    expect(second).toEqual(first);
    now += 29_999;
    await refresh("claudeAgent", { instanceId: "claude" });
    expect(calls).toBe(1);
    now++;
    status = 401;
    const failed = await refresh("claudeAgent", { instanceId: "claude" }, first.report);
    expect(calls).toBe(2);
    expect(failed.report).toEqual(first.report);
    expect(failed.error).toBe("Sign in again in Claude");
    await refresh("claudeAgent", { instanceId: "claude" });
    expect(calls).toBe(2);
  });

  it("normalizes antigravityAgent from the local quota server without touching credentials", async () => {
    let reads = 0;
    let http = 0;
    const refresh = createUsageRefresh({
      platform: "linux",
      read: async () => {
        reads++;
        return credentials;
      },
      request: async () => {
        http++;
        return Response.json({ access_token: "access-secret" });
      },
      antigravity: async () => fixtures.antigravityAgent,
    });
    const result = await refresh("antigravityAgent", { instanceId: "antigravity" });
    expect(result.error).toBeUndefined();
    expect(result.report?.windows.map((window) => window.id)).toEqual(["five_hour", "seven_day"]);
    expect(result.report?.windows.map((window) => window.usedPercent)).toEqual([42, 19]);
    expect(result.report?.windows.map((window) => window.windowMinutes)).toEqual([300, 10_080]);
    expect(reads).toBe(0);
    expect(http).toBe(0);
    expect(JSON.stringify(result)).not.toContain("access-secret");
  });

  it.each(["signin", "refresh"] as const)("keeps the last report after Antigravity %s", async (kind) => {
    const refresh = createUsageRefresh({
      platform: "linux",
      antigravity: async () => {
        throw new Error(kind);
      },
    });
    const report = { windows: [{ id: "five_hour", usedPercent: 12, resetsAt: null }], observedAt: reset };
    const result = await refresh("antigravityAgent", { instanceId: "antigravity" }, report);
    expect(result.report).toEqual(report);
    expect(result.error).toBe(kind === "signin" ? "Sign in again in Antigravity" : "Could not refresh Antigravity limits");
  });

  it("treats an empty Antigravity quota as a refresh failure", async () => {
    const refresh = createUsageRefresh({ platform: "linux", antigravity: async () => ({}) });
    const result = await refresh("antigravityAgent", { instanceId: "antigravity" });
    expect(result.report).toBeUndefined();
    expect(result.error).toBe("Could not refresh Antigravity limits");
  });

  it("normalizes museAgent from the injected quota source without touching credentials", async () => {
    let reads = 0;
    let http = 0;
    const refresh = createUsageRefresh({
      platform: "linux",
      read: async () => {
        reads++;
        return credentials;
      },
      request: async () => {
        http++;
        return Response.json({ access_token: "access-secret" });
      },
      muse: async () => fixtures.museAgent,
    });
    const result = await refresh("museAgent", { instanceId: "muse" });
    expect(result.error).toBeUndefined();
    expect(result.report?.windows.map((window) => window.id)).toEqual(["five_hour", "seven_day"]);
    expect(result.report?.windows.map((window) => window.usedPercent)).toEqual([22, 61]);
    expect(result.report?.windows.map((window) => window.windowMinutes)).toEqual([300, 10_080]);
    expect(result.report?.windows.map((window) => window.resetsAt)).toEqual([1_790_000_000_000, 1_790_172_800_000]);
    expect(result.report?.observedAt).toBe(new Date(1_790_000_000_000).toISOString());
    expect(reads).toBe(0);
    expect(http).toBe(0);
    expect(JSON.stringify(result)).not.toContain("access-secret");
  });

  it.each(["signin", "refresh"] as const)("keeps the last report after Muse %s", async (kind) => {
    const refresh = createUsageRefresh({
      platform: "linux",
      muse: async () => {
        throw new Error(kind);
      },
    });
    const report = { windows: [{ id: "five_hour", usedPercent: 12, resetsAt: null }], observedAt: reset };
    const result = await refresh("museAgent", { instanceId: "muse" }, report);
    expect(result.report).toEqual(report);
    expect(result.error).toBe(kind === "signin" ? "Sign in again in Muse" : "Could not refresh Muse limits");
  });

  it("treats an empty Muse quota as a refresh failure", async () => {
    const refresh = createUsageRefresh({ platform: "linux", muse: async () => ({}) });
    const result = await refresh("museAgent", { instanceId: "muse" });
    expect(result.report).toBeUndefined();
    expect(result.error).toBe("Could not refresh Muse limits");
  });

  it("quietly keeps a valid Muse cache after an empty snapshot", async () => {
    const refresh = createUsageRefresh({ platform: "linux", muse: async () => ({}) });
    const report = { windows: [{ id: "five_hour", usedPercent: 12, resetsAt: null }], observedAt: reset };
    const result = await refresh("museAgent", { instanceId: "muse" }, report);
    expect(result.report).toEqual(report);
    expect(result.error).toBeUndefined();
  });

  it("keeps the last report after malformed Muse usage", async () => {
    const refresh = createUsageRefresh({
      platform: "linux",
      muse: async () => ({ usage: { observedAtMs: 1_790_000_000_000, tier: "pro", window: {} } }),
    });
    const report = { windows: [{ id: "five_hour", usedPercent: 12, resetsAt: null }], observedAt: reset };
    const result = await refresh("museAgent", { instanceId: "muse" }, report);
    expect(result.report).toEqual(report);
    expect(result.error).toBeUndefined();
  });

  it("keeps the newer report when Muse returns an older observation", async () => {
    const refresh = createUsageRefresh({
      platform: "linux",
      muse: async () => ({
        usage: {
          observedAtMs: Date.parse("2026-09-01T12:00:00Z"),
          tier: "pro",
          window: { usedPercent: 88, windowDurationMins: 300, resetsAtMs: Date.parse("2026-09-01T17:00:00Z") },
          weekly: { usedPercent: 70, resetsAtMs: Date.parse("2026-09-08T12:00:00Z") },
        },
      }),
    });
    const report = { windows: [{ id: "five_hour", usedPercent: 12, resetsAt: null }], observedAt: reset };
    const result = await refresh("museAgent", { instanceId: "muse" }, report);
    expect(result.report).toEqual(report);
    expect(result.error).toBeUndefined();
  });

  it("reads stable usage/read through the Muse serve lifecycle", async () => {
    const scratch = mkdtempSync(join(tmpdir(), "omb-muse-usage-"));
    const rpcDump = join(scratch, "rpc.json");
    process.env.FAKE_MSP_USAGE = JSON.stringify(fixtures.museAgent);
    process.env.FAKE_MSP_RPC_DUMP = rpcDump;
    try {
      await expect(readMuseUsage(FAKE_MSP_CLI, {
        FAKE_MSP_USAGE: process.env.FAKE_MSP_USAGE,
        FAKE_MSP_RPC_DUMP: rpcDump,
      })).resolves.toEqual(fixtures.museAgent);
      expect(JSON.parse(readFileSync(rpcDump, "utf8"))).toEqual(["initialize", "initialized", "usage/read"]);
    } finally {
      delete process.env.FAKE_MSP_USAGE;
      delete process.env.FAKE_MSP_RPC_DUMP;
      removeTempDir(scratch);
    }
  });

  it("leaves Gemini API off the refresh path without inventing numbers", async () => {
    let reads = 0;
    let http = 0;
    const refresh = createUsageRefresh({
      platform: "linux",
      read: async () => {
        reads++;
        return credentials;
      },
      request: async () => {
        http++;
        return Response.json({});
      },
    });
    const report = { windows: [{ id: "five_hour", usedPercent: 12, resetsAt: null }], observedAt: reset };
    const kept = await refresh("geminiAgent", { instanceId: "gemini" }, report);
    expect(kept.report).toEqual(report);
    expect(kept.error).toBe("Usage refresh is not supported");
    expect(kept.retryAt).toBe(0);
    const fresh = await refresh("geminiAgent", { instanceId: "gemini" });
    expect(fresh.report).toBeUndefined();
    expect(fresh.error).toBe("Usage refresh is not supported");
    expect(fresh.retryAt).toBe(0);
    expect(reads).toBe(0);
    expect(http).toBe(0);
    expect(JSON.stringify(kept)).not.toContain("access-secret");
  });

  it.each(["signin", "refresh"] as const)("keeps the last report after Grok billing %s", async (kind) => {
    const refresh = createUsageRefresh({
      platform: "linux",
      billing: async () => {
        throw new Error(kind);
      },
    });
    const report = { windows: [{ id: "seven_day", usedPercent: 12, resetsAt: null }], observedAt: reset };
    const result = await refresh("grokAgent", { instanceId: "grok" }, report);
    expect(result.report).toEqual(report);
    expect(result.error).toBe(kind === "signin" ? "Sign in again in Grok" : "Could not refresh Grok limits");
  });

  it("refreshes an expired Claude access token instead of demanding sign-in", async () => {
    const now = 1_000_000;
    const stored = { claudeAiOauth: { accessToken: "stale-access", refreshToken: "stored-refresh", expiresAt: now - 1, scopes: ["user:inference"] }, sibling: { keep: true } };
    let writes: Array<{ path: string; content: string }> = [];
    const seen: string[] = [];
    const refresh = createUsageRefresh({
      platform: "linux",
      now: () => now,
      read: async () => JSON.stringify(stored),
      write: async (path, content) => {
        writes.push({ path, content });
      },
      request: async (url, init) => {
        const target = String(url);
        seen.push(target);
        if (target.includes("/oauth/token")) {
          const body = JSON.parse(String(init?.body));
          expect(body).toMatchObject({ grant_type: "refresh_token", refresh_token: "stored-refresh", client_id: "9d1c250a-e61b-44d9-88ed-5944d1962f5e" });
          return Response.json({ access_token: "fresh-access", refresh_token: "rotated-refresh", expires_in: 28_800 });
        }
        const token = new Headers(init?.headers).get("authorization");
        if (token === "Bearer stale-access") return Response.json({ error: "expired" }, { status: 401 });
        expect(token).toBe("Bearer fresh-access");
        return Response.json(fixtures.claudeAgent);
      },
    });
    const result = await refresh("claudeAgent", { instanceId: "claude" });
    expect(result.error).toBeUndefined();
    expect(result.report?.windows.map((window) => window.usedPercent)).toEqual([42, 19]);
    expect(seen[0]).toContain("/api/oauth/usage");
    // the minted tokens persist in the CLI's shape, sibling keys untouched
    expect(writes).toHaveLength(1);
    expect(writes[0].path).toMatch(/\.credentials\.json$/);
    const persisted = JSON.parse(writes[0].content);
    expect(persisted.claudeAiOauth).toMatchObject({ accessToken: "fresh-access", refreshToken: "rotated-refresh", expiresAt: now + 28_800_000, scopes: ["user:inference"] });
    expect(persisted.sibling).toEqual({ keep: true });
    for (const secret of ["stale-access", "stored-refresh", "fresh-access", "rotated-refresh"]) expect(JSON.stringify(result)).not.toContain(secret);
  });

  it("treats a dead Claude refresh grant as signed out", async () => {
    let usageCalls = 0;
    let writes = 0;
    const refresh = createUsageRefresh({
      platform: "linux",
      read: async () => JSON.stringify({ claudeAiOauth: { accessToken: "stale-access", refreshToken: "dead-refresh" } }),
      write: async () => {
        writes++;
      },
      request: async (url) => {
        if (String(url).includes("/oauth/token")) return Response.json({ error: "invalid_grant" }, { status: 400 });
        usageCalls++;
        return Response.json({ error: "expired" }, { status: 401 });
      },
    });
    const result = await refresh("claudeAgent", { instanceId: "claude" });
    expect(result.error).toBe("Sign in again in Claude");
    expect(usageCalls).toBe(1);
    expect(writes).toBe(0);
  });

  it("treats a Claude token-endpoint outage as transient", async () => {
    const refresh = createUsageRefresh({
      platform: "linux",
      read: async () => JSON.stringify({ claudeAiOauth: { accessToken: "stale-access", refreshToken: "stored-refresh" } }),
      request: async (url) => {
        if (String(url).includes("/oauth/token")) throw new Error("network down");
        return Response.json({ error: "expired" }, { status: 401 });
      },
    });
    const report = { windows: [{ id: "five_hour", usedPercent: 12, resetsAt: null }], observedAt: reset };
    const result = await refresh("claudeAgent", { instanceId: "claude" }, report);
    expect(result.report).toEqual(report);
    expect(result.error).toBe("Could not refresh Claude limits");
  });

  it("fails the token over to the fallback host when the primary path is gone", async () => {
    const seen: string[] = [];
    const refresh = createUsageRefresh({
      platform: "linux",
      read: async () => JSON.stringify({ claudeAiOauth: { accessToken: "stale-access", refreshToken: "stored-refresh" } }),
      request: async (url, init) => {
        const target = String(url);
        seen.push(target);
        if (target.includes("/oauth/token")) {
          if (target.startsWith("https://console.anthropic.com")) return Response.json({}, { status: 404 });
          return Response.json({ access_token: "fresh-access", expires_in: 28_800 });
        }
        return new Headers(init?.headers).get("authorization") === "Bearer fresh-access"
          ? Response.json(fixtures.claudeAgent)
          : Response.json({ error: "expired" }, { status: 401 });
      },
    });
    const result = await refresh("claudeAgent", { instanceId: "claude" });
    expect(result.error).toBeUndefined();
    expect(seen.filter((target) => target.includes("/oauth/token"))).toEqual([
      "https://console.anthropic.com/v1/oauth/token",
      "https://platform.claude.com/v1/oauth/token",
    ]);
  });

  it("still serves the refresh when persisting the minted token fails", async () => {
    const refresh = createUsageRefresh({
      platform: "linux",
      read: async () => JSON.stringify({ claudeAiOauth: { accessToken: "stale-access", refreshToken: "stored-refresh" } }),
      write: async () => {
        throw new Error("read-only fs");
      },
      request: async (url, init) => {
        if (String(url).includes("/oauth/token")) return Response.json({ access_token: "fresh-access" });
        return new Headers(init?.headers).get("authorization") === "Bearer fresh-access"
          ? Response.json(fixtures.claudeAgent)
          : Response.json({ error: "expired" }, { status: 401 });
      },
    });
    const result = await refresh("claudeAgent", { instanceId: "claude" });
    expect(result.error).toBeUndefined();
    expect(result.report?.windows.map((window) => window.usedPercent)).toEqual([42, 19]);
  });

  it("never replays a grant after an ambiguous transport failure", async () => {
    const seen: string[] = [];
    const refresh = createUsageRefresh({
      platform: "linux",
      read: async () => JSON.stringify({ claudeAiOauth: { accessToken: "stale-access", refreshToken: "stored-refresh" } }),
      request: async (url) => {
        const target = String(url);
        if (target.includes("/oauth/token")) {
          seen.push(target);
          if (target.startsWith("https://console.anthropic.com")) throw new Error("connection reset");
          return Response.json({ access_token: "fresh-access" });
        }
        return Response.json({ error: "expired" }, { status: 401 });
      },
    });
    const report = { windows: [{ id: "five_hour", usedPercent: 12, resetsAt: null }], observedAt: reset };
    const result = await refresh("claudeAgent", { instanceId: "claude" }, report);
    // The first endpoint may already have rotated the grant: retrying it on
    // the fallback could come back invalid_grant and read as signed out.
    expect(seen).toEqual(["https://console.anthropic.com/v1/oauth/token"]);
    expect(result.report).toEqual(report);
    expect(result.error).toBe("Could not refresh Claude limits");
  });

  it("treats a failed credential reread as transient, not signed out", async () => {
    let reads = 0;
    const refresh = createUsageRefresh({
      platform: "linux",
      read: async () => {
        reads++;
        if (reads > 1) throw new Error("file busy");
        return JSON.stringify({ claudeAiOauth: { accessToken: "stale-access", refreshToken: "stored-refresh" } });
      },
      request: async () => Response.json({ error: "expired" }, { status: 401 }),
    });
    const report = { windows: [{ id: "five_hour", usedPercent: 12, resetsAt: null }], observedAt: reset };
    const result = await refresh("claudeAgent", { instanceId: "claude" }, report);
    expect(result.report).toEqual(report);
    expect(result.error).toBe("Could not refresh Claude limits");
  });

  it("sends a 403 straight to sign-in without burning a mint round-trip", async () => {
    let tokenCalls = 0;
    const refresh = createUsageRefresh({
      platform: "linux",
      read: async () => JSON.stringify({ claudeAiOauth: { accessToken: "scoped-access", refreshToken: "stored-refresh" } }),
      request: async (url) => {
        // 403 is insufficient scope: a minted token carries the same scopes.
        if (String(url).includes("/oauth/token")) tokenCalls++;
        return Response.json({ error: "insufficient_scope" }, { status: 403 });
      },
    });
    const result = await refresh("claudeAgent", { instanceId: "claude" });
    expect(result.error).toBe("Sign in again in Claude");
    expect(tokenCalls).toBe(0);
  });

  it("treats a non-grant OAuth 400 as transient, not signed out", async () => {
    const refresh = createUsageRefresh({
      platform: "linux",
      read: async () => JSON.stringify({ claudeAiOauth: { accessToken: "stale-access", refreshToken: "stored-refresh" } }),
      request: async (url) => {
        if (String(url).includes("/oauth/token")) return Response.json({ error: "invalid_request" }, { status: 400 });
        return Response.json({ error: "expired" }, { status: 401 });
      },
    });
    const report = { windows: [{ id: "five_hour", usedPercent: 12, resetsAt: null }], observedAt: reset };
    const result = await refresh("claudeAgent", { instanceId: "claude" }, report);
    expect(result.report).toEqual(report);
    expect(result.error).toBe("Could not refresh Claude limits");
  });

  it("treats an unreadable OAuth error body as transient, not signed out", async () => {
    const refresh = createUsageRefresh({
      platform: "linux",
      read: async () => JSON.stringify({ claudeAiOauth: { accessToken: "stale-access", refreshToken: "stored-refresh" } }),
      request: async (url) => {
        if (String(url).includes("/oauth/token")) return new Response("not json", { status: 400 });
        return Response.json({ error: "expired" }, { status: 401 });
      },
    });
    const result = await refresh("claudeAgent", { instanceId: "claude" });
    expect(result.report).toBeUndefined();
    expect(result.error).toBe("Could not refresh Claude limits");
  });

  it("mints once when two instances share one credential file", async () => {
    let files = JSON.stringify({ claudeAiOauth: { accessToken: "stale-access", refreshToken: "shared-refresh" } });
    let tokenCalls = 0;
    let writes = 0;
    const refresh = createUsageRefresh({
      platform: "linux",
      now: () => 1_000_000,
      read: async () => files,
      write: async (_path, content) => {
        writes++;
        files = content;
      },
      request: async (url, init) => {
        const target = String(url);
        if (target.includes("/oauth/token")) {
          tokenCalls++;
          return Response.json({ access_token: "fresh-access", refresh_token: "rotated-refresh", expires_in: 28_800 });
        }
        return new Headers(init?.headers).get("authorization") === "Bearer fresh-access"
          ? Response.json(fixtures.claudeAgent)
          : Response.json({ error: "expired" }, { status: 401 });
      },
    });
    const options = (instanceId: string) => ({ instanceId, environment: { CLAUDE_CONFIG_DIR: "/shared/claude" } });
    const [first, second] = await Promise.all([refresh("claudeAgent", options("a")), refresh("claudeAgent", options("b"))]);
    expect(first.error).toBeUndefined();
    expect(second.error).toBeUndefined();
    // One mint serves both: the loser re-reads the rotated file inside the
    // lock instead of redeeming the consumed grant a second time.
    expect(tokenCalls).toBe(1);
    expect(writes).toBe(1);
  });

  it("bridges a failed persist from memory instead of redeeming the dead grant", async () => {
    let now = 1_000_000;
    const file = JSON.stringify({ claudeAiOauth: { accessToken: "stale-access", refreshToken: "original-refresh" } });
    let failWrites = true;
    const written: string[] = [];
    let tokenCalls = 0;
    const grants: unknown[] = [];
    const refresh = createUsageRefresh({
      platform: "linux",
      now: () => now,
      read: async () => file,
      write: async (_path, content) => {
        if (failWrites) throw new Error("read-only fs");
        written.push(content);
      },
      request: async (url, init) => {
        const target = String(url);
        if (target.includes("/oauth/token")) {
          tokenCalls++;
          grants.push(JSON.parse(String(init?.body)).refresh_token);
          return Response.json({ access_token: "memory-access", refresh_token: "memory-refresh", expires_in: 28_800 });
        }
        return new Headers(init?.headers).get("authorization") === "Bearer memory-access"
          ? Response.json(fixtures.claudeAgent)
          : Response.json({ error: "expired" }, { status: 401 });
      },
    });
    const first = await refresh("claudeAgent", { instanceId: "claude" });
    expect(first.error).toBeUndefined();
    expect(tokenCalls).toBe(1);
    // Next cycle the file still holds the consumed grant, but no second
    // mint happens: the remembered rotation serves usage, then heals the file.
    now += 31_000;
    failWrites = false;
    const second = await refresh("claudeAgent", { instanceId: "claude" });
    expect(second.error).toBeUndefined();
    expect(second.report?.windows.map((window) => window.usedPercent)).toEqual([42, 19]);
    expect(tokenCalls).toBe(1);
    expect(grants).toEqual(["original-refresh"]);
    expect(written).toHaveLength(1);
    expect(JSON.parse(written[0]).claudeAiOauth).toMatchObject({ accessToken: "memory-access", refreshToken: "memory-refresh" });
  });

  it("keeps the env-token path fail-closed with no refresh attempt", async () => {
    let tokenCalls = 0;
    const refresh = createUsageRefresh({
      platform: "linux",
      request: async (url) => {
        if (String(url).includes("/oauth/token")) tokenCalls++;
        return Response.json({ error: "expired" }, { status: 401 });
      },
    });
    const result = await refresh("claudeAgent", { instanceId: "claude", environment: { CLAUDE_CODE_OAUTH_TOKEN: "env-token" } });
    expect(result.error).toBe("Sign in again in Claude");
    expect(tokenCalls).toBe(0);
  });

  it("rejects malformed usage and skips unsupported engines and macOS Keychain access", async () => {
    let calls = 0;
    const refresh = createUsageRefresh({
      platform: "darwin",
      read: async () => credentials,
      request: async () => { calls++; return Response.json({}); },
      billing: async () => ({}),
      antigravity: async () => ({}),
    });
    expect((await refresh("claudeAgent", { instanceId: "claude" })).error).toContain("Keychain");
    expect((await refresh("antigravityAgent", { instanceId: "antigravity" })).error).toBe("Could not refresh Antigravity limits");
    expect((await refresh("opencodeGo", { instanceId: "opencode" })).error).toBe("Usage refresh is not supported");
    expect(calls).toBe(0);
    expect((await refresh("grokAgent", { instanceId: "grok" })).error).toBe("Could not refresh Grok limits");
  });
});

describe("antigravity /usage quota command", () => {
  const groups = {
    groups: [
      {
        buckets: [
          { bucketId: "gemini-5h", displayName: "5 hour", remaining: { remainingFraction: 0.58 }, resetTime: reset },
          { bucketId: "gemini-weekly", displayName: "Weekly", remaining: { remainingFraction: 0.81 }, resetTime: reset },
        ],
      },
    ],
  };
  const usageLine = (data: unknown) => JSON.stringify({ event: "command_result", command: { name: "usage", data } });

  it("reads quota windows from the command_result line without a running server", async () => {
    const seen: Array<{ command: string; args: string[] }> = [];
    const data = await readAntigravityUsageCommand("agy", {}, async (command, args) => {
      seen.push({ command, args });
      return `${usageLine(groups)}\n`;
    });
    expect(data).toEqual(groups);
    expect(antigravityRateLimitWindows(data).map((window) => window.id)).toEqual(["five_hour", "seven_day"]);
    expect(seen).toEqual([{ command: "agy", args: ["-p", "/usage", "--output-format", "stream-json"] }]);
  });

  it("falls through to the final result command when the first line carries nothing", async () => {
    const stdout = [
      usageLine({ groups: [] }),
      "not json",
      JSON.stringify({ event: "result", result: { status: "SUCCESS", command: { name: "usage", data: groups } } }),
    ].join("\n");
    const data = await readAntigravityUsageCommand("agy", {}, async () => stdout);
    expect(data).toEqual(groups);
  });

  it("throws refresh on exec failure, garbage, and empty groups — never signin", async () => {
    await expect(readAntigravityUsageCommand("agy", {}, async () => null)).rejects.toThrow("refresh");
    await expect(readAntigravityUsageCommand("agy", {}, async () => "not json\n")).rejects.toThrow("refresh");
    await expect(readAntigravityUsageCommand("agy", {}, async () => `${usageLine({ groups: [] })}\n`)).rejects.toThrow("refresh");
    await expect(readAntigravityUsageCommand("agy", {}, async () => "")).rejects.toThrow("refresh");
  });

  it("ignores foreign or unnamed command payloads even when they carry quota-shaped data", async () => {
    const foreign = JSON.stringify({ event: "command_result", command: { name: "other", data: groups } });
    await expect(readAntigravityUsageCommand("agy", {}, async () => `${foreign}\n`)).rejects.toThrow("refresh");
    const unnamed = JSON.stringify({ event: "command_result", command: { data: groups } });
    await expect(readAntigravityUsageCommand("agy", {}, async () => `${unnamed}\n`)).rejects.toThrow("refresh");
    const wrongEvent = JSON.stringify({ event: "assistant", command: { name: "usage", data: groups } });
    await expect(readAntigravityUsageCommand("agy", {}, async () => `${wrongEvent}\n`)).rejects.toThrow("refresh");
  });

  it("reads a CSRF wall as unreachable, not as signed out", () => {
    expect(isCsrfRejection('{"code":"unauthenticated","message":"missing CSRF token"}')).toBe(true);
    expect(isCsrfRejection('{"code":"unauthenticated","message":"invalid CSRF token"}')).toBe(true);
    expect(isCsrfRejection("missing CSRF token")).toBe(true);
    expect(isCsrfRejection("")).toBe(false);
    expect(isCsrfRejection('{"code":"unauthenticated"}')).toBe(false);
  });

  it("refuses near-miss CSRF mentions so they keep the legacy signin meaning", () => {
    expect(isCsrfRejection('{"code":"unauthenticated","message":"CSRF token for language server expired"}')).toBe(false);
    expect(isCsrfRejection("check the CSRF token configuration and retry")).toBe(false);
    expect(isCsrfRejection('{"code":"unauthenticated","message":"missing CSRF token: quota denied"}')).toBe(false);
  });

  it("tries the usage command first and the RPC scrape only on failure", async () => {
    let rpcCalls = 0;
    const win = await readAntigravityQuota("agy", {}, {
      usage: async () => groups,
      rpc: async () => {
        rpcCalls++;
        return {};
      },
    });
    expect(win).toEqual(groups);
    expect(rpcCalls).toBe(0);

    const fallback = await readAntigravityQuota("agy", {}, {
      usage: async () => {
        throw new Error("refresh");
      },
      rpc: async () => groups,
    });
    expect(fallback).toEqual(groups);
  });

  it("propagates the fallback outcome when the usage command fails", async () => {
    await expect(readAntigravityQuota("agy", {}, {
      usage: async () => {
        throw new Error("refresh");
      },
      rpc: async () => {
        throw new Error("signin");
      },
    })).rejects.toThrow("signin");
    await expect(readAntigravityQuota("agy", {}, {
      usage: async () => {
        throw new Error("refresh");
      },
      rpc: async () => {
        throw new Error("refresh");
      },
    })).rejects.toThrow("refresh");
  });
});
