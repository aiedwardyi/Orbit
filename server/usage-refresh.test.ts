import { describe, expect, it } from "vitest";

import { createUsageRefresh, usageRefreshResponse } from "./usage-refresh.ts";

const reset = "2026-10-01T12:00:00Z";
const fixtures = {
  claudeAgent: { five_hour: { utilization: 42, resets_at: reset }, seven_day: { utilization: 19, resets_at: reset } },
  codex: { rateLimits: { primary: { usedPercent: 42, windowDurationMins: 300, resetsAt: Date.parse(reset) / 1000 }, secondary: { usedPercent: 19, windowDurationMins: 10080, resetsAt: Date.parse(reset) / 1000 } } },
  grokAgent: { config: { creditUsagePercent: 42, currentPeriod: { type: "USAGE_PERIOD_TYPE_WEEKLY", end: reset } } },
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

  it("rejects malformed usage and skips unsupported engines and macOS Keychain access", async () => {
    let calls = 0;
    const refresh = createUsageRefresh({
      platform: "darwin",
      read: async () => credentials,
      request: async () => { calls++; return Response.json({}); },
      billing: async () => ({}),
    });
    expect((await refresh("claudeAgent", { instanceId: "claude" })).error).toContain("Keychain");
    expect((await refresh("antigravityAgent", { instanceId: "antigravity" })).error).toBe("Usage refresh is not supported");
    expect(calls).toBe(0);
    expect((await refresh("grokAgent", { instanceId: "grok" })).error).toBe("Could not refresh Grok limits");
  });
});
