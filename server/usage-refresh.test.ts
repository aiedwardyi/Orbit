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
  it.each(["claudeAgent", "codex", "grokAgent"] as const)("normalizes %s without leaking credentials", async (driver) => {
    const refresh = createUsageRefresh({
      read: async () => credentials,
      request: async (_url, init) => {
        expect(new Headers(init?.headers).get("authorization")).toBe("Bearer access-secret");
        expect(init?.redirect).toBe("error");
        return Response.json({ ...fixtures[driver], access_token: "access-secret", refresh_token: "refresh-secret", authorization: "Bearer access-secret" });
      },
      rpc: async () => fixtures.codex,
    });
    const result = await refresh(driver);
    expect(result.error).toBeUndefined();
    expect(result.report?.windows.map((window) => window.usedPercent)).toEqual(driver === "grokAgent" ? [42] : [42, 19]);
    expect(result.report?.windows.map((window) => window.id)).toEqual(driver === "grokAgent" ? ["seven_day"] : ["five_hour", "seven_day"]);
    for (const secret of ["access-secret", "refresh-secret", "Bearer", "access_token", "refresh_token", "authorization"]) expect(JSON.stringify(result)).not.toContain(secret);
    expect(JSON.stringify(usageRefreshResponse(driver, result))).not.toContain("access-secret");
  });

  it("coalesces concurrent reads and throttles failed attempts for 30 seconds", async () => {
    let now = 1_000;
    let calls = 0;
    let status = 200;
    const refresh = createUsageRefresh({ now: () => now, read: async () => credentials, request: async () => {
      calls++;
      return Response.json(fixtures.claudeAgent, { status });
    } });
    const [first, second] = await Promise.all([refresh("claudeAgent"), refresh("claudeAgent")]);
    expect(calls).toBe(1);
    expect(second).toEqual(first);
    now += 29_999;
    await refresh("claudeAgent");
    expect(calls).toBe(1);
    now++;
    status = 401;
    const failed = await refresh("claudeAgent", {}, first.report);
    expect(calls).toBe(2);
    expect(failed.report).toEqual(first.report);
    expect(failed.error).toBe("Sign in again in Claude");
    await refresh("claudeAgent");
    expect(calls).toBe(2);
  });

  it.each([403, 500])("keeps the last report after HTTP %s", async (status) => {
    const refresh = createUsageRefresh({ read: async () => credentials, request: async () => Response.json({ error: "access-secret" }, { status }) });
    const report = { windows: [{ id: "seven_day", usedPercent: 12, resetsAt: null }], observedAt: reset };
    const result = await refresh("grokAgent", {}, report);
    expect(result.report).toEqual(report);
    expect(result.error).toBe(status === 403 ? "Sign in again in Grok" : "Could not refresh Grok limits");
  });

  it("rejects malformed usage and skips unsupported engines and macOS Keychain access", async () => {
    let calls = 0;
    const refresh = createUsageRefresh({ platform: "darwin", read: async () => credentials, request: async () => { calls++; return Response.json({}); } });
    expect((await refresh("claudeAgent")).error).toContain("Keychain");
    expect((await refresh("antigravityAgent")).error).toBe("Usage refresh is not supported");
    expect(calls).toBe(0);
    expect((await refresh("grokAgent")).error).toBe("Could not refresh Grok limits");
  });
});
