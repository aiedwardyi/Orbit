import { describe, expect, it } from "vitest";

import {
  antigravityRateLimitWindows,
  chatUsageLimit,
  claudeRateLimitWindows,
  codexRateLimitWindows,
  epochMs,
  exhaustedWindow,
  grokRateLimitWindows,
  museUsageReport,
  usageLimitFromError,
} from "./rate-limits.ts";

describe("epochMs", () => {
  it("turns provider seconds into milliseconds and leaves milliseconds alone", () => {
    expect(epochMs(1_790_000_000)).toBe(1_790_000_000_000);
    expect(epochMs(1_790_000_000_000)).toBe(1_790_000_000_000);
    expect(epochMs(0)).toBeNull();
    expect(epochMs(-5)).toBeNull();
    expect(epochMs("1790000000")).toBeNull();
    expect(epochMs(Number.NaN)).toBeNull();
    expect(epochMs(undefined)).toBeNull();
  });
});

describe("claudeRateLimitWindows", () => {
  it("reads both subscription windows from unifiedWindows, as percents", () => {
    expect(
      claudeRateLimitWindows({
        status: "allowed",
        rateLimitType: "seven_day",
        utilization: 0.76,
        resetsAt: 1_790_172_800,
        unifiedWindows: {
          five_hour: { utilization: 0.123, resetsAt: 1_790_000_000 },
          seven_day: { utilization: 0.76, resetsAt: 1_790_172_800 },
          seven_day_overage_included: { utilization: 0.1, resetsAt: 1_790_172_800 },
        },
      }),
    ).toEqual([
      { id: "five_hour", usedPercent: 12.3, resetsAt: 1_790_000_000_000, windowMinutes: 300 },
      { id: "seven_day", usedPercent: 76, resetsAt: 1_790_172_800_000, windowMinutes: 10_080 },
    ]);
  });

  it("falls back to the binding claim when there is no per-window block", () => {
    expect(
      claudeRateLimitWindows({ status: "allowed_warning", rateLimitType: "seven_day_opus", utilization: 0.9, resetsAt: 1_790_172_800 }),
    ).toEqual([{ id: "seven_day_opus", usedPercent: 90, resetsAt: 1_790_172_800_000, windowMinutes: 10_080 }]);
    // past the cap: the account is in overage, and the number says so
    expect(claudeRateLimitWindows({ status: "rejected", rateLimitType: "five_hour", utilization: 1.2 })).toEqual([
      { id: "five_hour", usedPercent: 120, resetsAt: null, windowMinutes: 300 },
    ]);
  });

  it("never invents a window: overage, a missing fill level, and junk yield nothing", () => {
    expect(claudeRateLimitWindows({ status: "allowed", rateLimitType: "overage", utilization: 0.5 })).toEqual([]);
    expect(claudeRateLimitWindows({ status: "allowed", rateLimitType: "seven_day", resetsAt: 1_790_172_800 })).toEqual([]);
    expect(claudeRateLimitWindows({ status: "allowed", unifiedWindows: { seven_day: { resetsAt: 1_790_172_800 } } })).toEqual([]);
    expect(claudeRateLimitWindows({ status: "allowed", unifiedWindows: { seven_day: { utilization: "0.7" } } })).toEqual([]);
    expect(claudeRateLimitWindows(null)).toEqual([]);
    expect(claudeRateLimitWindows("76%")).toEqual([]);
  });
});

describe("codexRateLimitWindows", () => {
  it("names the 5-hour and weekly windows and keeps other lengths by slot", () => {
    expect(
      codexRateLimitWindows({
        planType: "plus",
        primary: { usedPercent: 12.34, windowDurationMins: 300, resetsAt: 1_790_000_000 },
        secondary: { usedPercent: 76, windowDurationMins: 10_080, resetsAt: 1_790_172_800 },
      }),
    ).toEqual([
      { id: "five_hour", usedPercent: 12.3, resetsAt: 1_790_000_000_000, windowMinutes: 300 },
      { id: "seven_day", usedPercent: 76, resetsAt: 1_790_172_800_000, windowMinutes: 10_080 },
    ]);
    expect(codexRateLimitWindows({ primary: { usedPercent: 5, windowDurationMins: 60 } })).toEqual([
      { id: "primary", usedPercent: 5, resetsAt: null, windowMinutes: 60 },
    ]);
  });

  it("drops a slot without a fill level and tolerates junk", () => {
    expect(
      codexRateLimitWindows({ primary: { windowDurationMins: 300, resetsAt: 1_790_000_000 }, secondary: { usedPercent: "76" } }),
    ).toEqual([]);
    expect(codexRateLimitWindows({ secondary: { usedPercent: 40 } })).toEqual([{ id: "secondary", usedPercent: 40, resetsAt: null }]);
    expect(codexRateLimitWindows(undefined)).toEqual([]);
    expect(codexRateLimitWindows([])).toEqual([]);
  });
});

describe("grokRateLimitWindows", () => {
  it("reads the weekly pool as used percent and never invents a 5-hour window", () => {
    expect(
      grokRateLimitWindows({
        config: {
          creditUsagePercent: 42.34,
          currentPeriod: {
            type: "USAGE_PERIOD_TYPE_WEEKLY",
            start: "2026-09-08T00:00:00Z",
            end: "2026-09-15T12:00:00Z",
          },
        },
      }),
    ).toEqual([
      { id: "seven_day", usedPercent: 42.3, resetsAt: Date.parse("2026-09-15T12:00:00Z"), windowMinutes: 10_080 },
    ]);
    expect(
      grokRateLimitWindows({
        config: { creditUsagePercent: 12, currentPeriod: { type: "USAGE_PERIOD_TYPE_WEEKLY" } },
      }),
    ).toEqual([{ id: "seven_day", usedPercent: 12, resetsAt: null, windowMinutes: 10_080 }]);
  });

  it("keeps zero usage as a valid weekly observation", () => {
    expect(
      grokRateLimitWindows({
        config: {
          creditUsagePercent: 0,
          currentPeriod: { type: "USAGE_PERIOD_TYPE_WEEKLY", end: "2026-09-15T12:00:00Z" },
        },
      }),
    ).toEqual([
      { id: "seven_day", usedPercent: 0, resetsAt: Date.parse("2026-09-15T12:00:00Z"), windowMinutes: 10_080 },
    ]);
  });

  /** Display rounding must not invent an exhausted week out of 99.96%. */
  it("keeps a nearly-full week short of spent", () => {
    const windows = grokRateLimitWindows({
      config: {
        creditUsagePercent: 99.96,
        currentPeriod: { type: "USAGE_PERIOD_TYPE_WEEKLY", end: "2026-09-15T12:00:00Z" },
      },
    });
    expect(windows).toEqual([
      { id: "seven_day", usedPercent: 99.9, resetsAt: Date.parse("2026-09-15T12:00:00Z"), windowMinutes: 10_080 },
    ]);
    expect(exhaustedWindow(windows, Date.parse("2026-09-14T00:00:00Z"))).toBeNull();
  });

  it("reads a subscriber's untouched week as unused", () => {
    expect(
      grokRateLimitWindows({
        config: {
          currentPeriod: { type: "USAGE_PERIOD_TYPE_WEEKLY", start: "2026-10-04T08:45:16.197799+00:00", end: "2026-10-11T08:45:16.197799+00:00" },
          onDemandCap: { val: 0 },
          isUnifiedBillingUser: true,
        },
        subscription_tier: "SuperGrok",
      }),
    ).toEqual([
      { id: "seven_day", usedPercent: 0, resetsAt: Date.parse("2026-10-11T08:45:16.197799+00:00"), windowMinutes: 10_080 },
    ]);
  });

  it("drops a payload without a weekly fill", () => {
    expect(
      grokRateLimitWindows({
        config: { currentPeriod: { type: "USAGE_PERIOD_TYPE_WEEKLY", end: "2026-09-15T12:00:00Z" } },
      }),
    ).toEqual([]);
    expect(
      grokRateLimitWindows({
        config: {
          creditUsagePercent: 12,
          currentPeriod: { type: "USAGE_PERIOD_TYPE_MONTHLY", end: "2026-10-01T00:00:00Z" },
        },
      }),
    ).toEqual([]);
    expect(grokRateLimitWindows({ config: { creditUsagePercent: "42" } })).toEqual([]);
    expect(grokRateLimitWindows({})).toEqual([]);
    expect(grokRateLimitWindows(null)).toEqual([]);
    expect(grokRateLimitWindows("42%")).toEqual([]);
  });
});

describe("antigravityRateLimitWindows", () => {
  const now = Date.parse("2026-09-14T12:00:00Z");

  it("reads statusline quota buckets as used percent with resets", () => {
    expect(
      antigravityRateLimitWindows(
        {
          "gemini-5h": { remaining_fraction: 0.58, reset_in_seconds: 5400 },
          "gemini-daily": { remaining_fraction: 0.7, reset_in_seconds: 3600 },
          "gemini-weekly": { remaining_fraction: 0.81, reset_in_seconds: 518_400 },
        },
        now,
      ),
    ).toEqual([
      { id: "five_hour", usedPercent: 42, resetsAt: now + 5_400_000, windowMinutes: 300 },
      { id: "seven_day", usedPercent: 19, resetsAt: now + 518_400_000, windowMinutes: 10_080 },
      { id: "daily", usedPercent: 30, resetsAt: now + 3_600_000, windowMinutes: 1440 },
    ]);
  });

  it("reads RetrieveUserQuotaSummary groups and keeps the most constrained pool per window", () => {
    expect(
      antigravityRateLimitWindows(
        {
          groups: [
            {
              displayName: "Gemini Models",
              buckets: [
                { bucketId: "weekly", displayName: "Weekly Limit", remaining: { remainingFraction: 0.67 }, resetTime: "2026-09-21T12:00:00Z" },
                { bucketId: "five_hour", displayName: "Five Hour Limit", remaining: { remainingFraction: 0.02 }, resetTime: "2026-09-14T13:00:00Z" },
              ],
            },
            {
              displayName: "Claude and GPT models",
              buckets: [
                { bucketId: "weekly", displayName: "Weekly Limit", remaining: { remainingFraction: 1 }, resetTime: "2026-09-21T12:00:00Z" },
                { bucketId: "five_hour", displayName: "Five Hour Limit", remaining: { remainingFraction: 0.5 }, resetTime: "2026-09-14T13:00:00Z" },
              ],
            },
          ],
        },
        now,
      ),
    ).toEqual([
      { id: "five_hour", usedPercent: 98, resetsAt: Date.parse("2026-09-14T13:00:00Z"), windowMinutes: 300 },
      { id: "seven_day", usedPercent: 33, resetsAt: Date.parse("2026-09-21T12:00:00Z"), windowMinutes: 10_080 },
    ]);
  });

  it("reads the legacy GetUserStatus model configs", () => {
    expect(
      antigravityRateLimitWindows(
        {
          userStatus: {
            cascadeModelConfigData: {
              clientModelConfigs: [
                { quotaInfo: { remainingFraction: 0.9, resetTime: "2026-09-14T17:00:00Z" }, quotaWindow: "five_hour" },
              ],
            },
          },
        },
        now,
      ),
    ).toEqual([
      { id: "five_hour", usedPercent: 10, resetsAt: Date.parse("2026-09-14T17:00:00Z"), windowMinutes: 300 },
    ]);
  });

  it("unwraps the response envelope around live quota-summary groups", () => {
    // bucket ids and camelCase fields as observed live against the local
    // language server: gemini + third-party pools, 5h and weekly each.
    expect(
      antigravityRateLimitWindows(
        {
          response: {
            groups: [
              {
                displayName: "Gemini Models",
                buckets: [
                  { bucketId: "gemini-weekly", displayName: "Weekly Limit", remainingFraction: 0.9, resetTime: "2026-09-21T12:00:00Z" },
                  { bucketId: "gemini-5h", displayName: "Five Hour Limit", remainingFraction: 0.4, resetTime: "2026-09-14T13:00:00Z" },
                ],
              },
              {
                displayName: "Claude and GPT models",
                buckets: [
                  { bucketId: "3p-weekly", displayName: "Weekly Limit", remainingFraction: 0.7, resetTime: "2026-09-21T12:00:00Z" },
                  { bucketId: "3p-5h", displayName: "Five Hour Limit", remainingFraction: 0.8, resetTime: "2026-09-14T13:00:00Z" },
                ],
              },
            ],
          },
        },
        now,
      ),
    ).toEqual([
      { id: "five_hour", usedPercent: 60, resetsAt: Date.parse("2026-09-14T13:00:00Z"), windowMinutes: 300 },
      { id: "seven_day", usedPercent: 30, resetsAt: Date.parse("2026-09-21T12:00:00Z"), windowMinutes: 10_080 },
    ]);
  });

  it("keeps sibling quota data beside a decoy response record", () => {
    expect(
      antigravityRateLimitWindows(
        {
          response: { note: "not an envelope" },
          "gemini-5h": { remaining_fraction: 0.5, reset_in_seconds: 60 },
        },
        now,
      ),
    ).toEqual([{ id: "five_hour", usedPercent: 50, resetsAt: now + 60_000, windowMinutes: 300 }]);
  });

  it("drops buckets without a fill level and tolerates junk", () => {
    expect(
      antigravityRateLimitWindows({ "gemini-weekly": { reset_in_seconds: 60 }, "gemini-5h": { remaining_fraction: "0.5" } }, now),
    ).toEqual([]);
    expect(antigravityRateLimitWindows({ groups: [{ buckets: [{ bucketId: "weekly" }] }] }, now)).toEqual([]);
    expect(antigravityRateLimitWindows(null, now)).toEqual([]);
    expect(antigravityRateLimitWindows("42%", now)).toEqual([]);
  });
});

describe("museUsageReport", () => {
  const payload = {
    usage: {
      observedAtMs: 1_790_000_000_000,
      tier: "pro",
      window: { usedPercent: 22, windowDurationMins: 300, resetsAtMs: 1_790_000_000_000 },
      weekly: { usedPercent: 61, resetsAtMs: 1_790_172_800_000 },
    },
  };

  it("normalizes the stable five-hour and weekly windows", () => {
    expect(museUsageReport(payload)).toEqual({
      observedAt: new Date(1_790_000_000_000).toISOString(),
      windows: [
        { id: "five_hour", usedPercent: 22, resetsAt: 1_790_000_000_000, windowMinutes: 300 },
        { id: "seven_day", usedPercent: 61, resetsAt: 1_790_172_800_000, windowMinutes: 10_080 },
      ],
    });
    expect(museUsageReport(payload.usage)).toEqual(museUsageReport(payload));
  });

  it("rejects empty and malformed observations", () => {
    expect(museUsageReport({})).toBeNull();
    expect(museUsageReport({ usage: {} })).toBeNull();
    expect(museUsageReport({ usage: { ...payload.usage, observedAtMs: "1790000000000" } })).toBeNull();
    expect(museUsageReport({ usage: { ...payload.usage, window: { ...payload.usage.window, usedPercent: -1 } } })).toBeNull();
    expect(museUsageReport({ usage: { ...payload.usage, weekly: { ...payload.usage.weekly, resetsAtMs: 0 } } })).toBeNull();
    expect(museUsageReport(null)).toBeNull();
  });
});

describe("usageLimitFromError", () => {
  it("reads an explicit rate-limit rejection, with the reset it carries", () => {
    expect(
      usageLimitFromError(
        Object.assign(new Error("Internal error"), {
          code: -32603,
          data: { error: { type: "rate_limit_exceeded", message: "Rate limit exceeded" }, resetsAt: 1_790_172_800 },
        }),
        true,
      ),
    ).toEqual({ resetsAt: 1_790_172_800_000 });
  });

  it("matches the vocabulary providers actually send", () => {
    for (const message of [
      "xAI HTTP 429: Too Many Requests",
      "rate limit exceeded, slow down",
      "You have exceeded your usage limit for this week",
      "monthly quota exhausted",
    ]) {
      expect(usageLimitFromError(new Error(message), true)).toEqual({ resetsAt: null });
    }
  });

  /** A bare throttle is the same sentence on a subscription CLI and on a
   *  per-minute API key, and only one of them means "your plan is used up". */
  it("counts a bare throttle only for a driver that bills a subscription window", () => {
    for (const message of ["xAI HTTP 429: Too Many Requests", "rate limit exceeded, slow down"]) {
      expect(usageLimitFromError(new Error(message), false)).toBeNull();
    }
    expect(usageLimitFromError(new Error("monthly quota exhausted"), false)).toEqual({ resetsAt: null });
  });

  it("never classifies a JSON-RPC protocol error, whatever its payload says", () => {
    for (const code of [-32700, -32600, -32601, -32602, "-32602", " -32601 "]) {
      expect(usageLimitFromError(Object.assign(new Error("rate limit exceeded"), { code }), true)).toBeNull();
    }
    expect(usageLimitFromError(Object.assign(new Error("rate limit exceeded"), { code: -32603 }), true))
      .toEqual({ resetsAt: null });
  });

  /** "quota" on its own is as much an outage word as a limit word. */
  it("wants a spent-ness word, not the bare noun", () => {
    expect(usageLimitFromError(new Error("quota configuration is unavailable"), true)).toBeNull();
    expect(usageLimitFromError(Object.assign(new Error("Internal error"), {
      code: -32603,
      data: { hint: "check quota settings" },
    }), true)).toBeNull();
  });

  /** A named type is the provider saying it outright, so it decides alone —
   *  and it splits the same way the prose does. */
  it("prefers data.error.type over the prose, throttle types still gated", () => {
    const typed = (type: string) => Object.assign(new Error("Internal error"), { code: -32603, data: { error: { type } } });
    expect(usageLimitFromError(typed("quota_exceeded"), false)).toEqual({ resetsAt: null });
    expect(usageLimitFromError(typed("rate_limit_exceeded"), true)).toEqual({ resetsAt: null });
    expect(usageLimitFromError(typed("rate_limit_exceeded"), false)).toBeNull();
    expect(usageLimitFromError(
      Object.assign(new Error("usage limit reached"), { data: { error: { type: "invalid_request" } } }),
      true,
    )).toBeNull();
  });

  it("reads retry-after seconds as a reset time", () => {
    const now = 1_790_000_000_000;
    expect(
      usageLimitFromError(Object.assign(new Error("429 Too Many Requests"), { data: { retryAfter: 600 } }), true, now),
    ).toEqual({ resetsAt: now + 600_000 });
  });

  it("leaves anything that is not a usage limit alone", () => {
    expect(usageLimitFromError(new Error("Internal error"), true)).toBeNull();
    expect(usageLimitFromError(new Error("Invalid API key"), true)).toBeNull();
    expect(usageLimitFromError(new Error("model not found: grok-9"), true)).toBeNull();
  });
});

describe("exhaustedWindow", () => {
  const now = 1_790_000_000_000;

  it("finds a full window that has not reset yet", () => {
    expect(exhaustedWindow([{ id: "seven_day", usedPercent: 100, resetsAt: now + 60_000 }], now)).toEqual({
      id: "seven_day",
      usedPercent: 100,
      resetsAt: now + 60_000,
    });
  });

  it("keeps a full window whose reset the provider never reported", () => {
    expect(exhaustedWindow([{ id: "seven_day", usedPercent: 100, resetsAt: null }], now)).toEqual({
      id: "seven_day",
      usedPercent: 100,
      resetsAt: null,
    });
  });

  it("ignores a window with room left, and one whose reset has passed", () => {
    expect(exhaustedWindow([{ id: "seven_day", usedPercent: 99.4, resetsAt: now + 60_000 }], now)).toBeNull();
    expect(exhaustedWindow([{ id: "seven_day", usedPercent: 100, resetsAt: now - 1 }], now)).toBeNull();
    expect(exhaustedWindow([], now)).toBeNull();
    expect(exhaustedWindow(undefined, now)).toBeNull();
  });
});


describe("chatUsageLimit", () => {
  const now = 1_800_000_000_000;
  const reset = now + 3600_000;
  const windows = [{ id: "five_hour", usedPercent: 100, resetsAt: reset }];
  it.each(["UsageLimitReached", "usageLimitExceeded", "usage_limit_reached"])("prefers typed %s with provider reset", (type) => {
    expect(chatUsageLimit("codex", { type, message: "Plan spent", resets_at: reset / 1000 }, [], true, now))
      .toEqual({ message: "Plan spent", usageLimit: { resetsAt: reset } });
  });
  it("uses the latest reset of every exhausted window and ignores expired ones", () => {
    expect(chatUsageLimit("claude", "You've hit your limit", [
      ...windows, { id: "seven_day", usedPercent: 100, resetsAt: reset + 86400_000 },
      { id: "old", usedPercent: 100, resetsAt: now - 1 },
      { id: "available", usedPercent: 90, resetsAt: reset + 172800_000 },
    ], true, now)?.usageLimit).toEqual({ resetsAt: reset + 86400_000 });
  });
  it("prefers a typed Claude assistant error over generic result wording", () => {
    expect(chatUsageLimit("claude", { type: "assistant", error: "usage_limit_reached", resetsAt: reset,
      message: { content: [{ type: "text", text: "Plan spent" }] } }, [], true, now))
      .toEqual({ message: "Plan spent", usageLimit: { resetsAt: reset } });
  });
  it("retains exhausted model-specific Claude windows", () => {
    const parsed = claudeRateLimitWindows({ unifiedWindows: {
      five_hour: { utilization: 0.2, resetsAt: reset / 1000 },
      seven_day: { utilization: 0.5, resetsAt: reset / 1000 },
      seven_day_opus: { utilization: 1, resetsAt: (reset + 86400_000) / 1000 },
    } });
    expect(parsed.map((w) => w.id)).toEqual(["five_hour", "seven_day", "seven_day_opus"]);
    expect(chatUsageLimit("claude", "You've hit your limit", parsed, true, now)?.usageLimit).toEqual({ resetsAt: reset + 86400_000 });
  });
  it.each(["You've hit your session limit · resets 3am (Asia/Seoul)", "You've hit your weekly limit · resets Nov 3"])("marks Claude's own limit wording: %s", (message) => {
    expect(chatUsageLimit("claude", { error: "rate_limit", result: message }, windows, true, now)?.usageLimit).toEqual({ resetsAt: reset });
  });
  it("keeps an unknown reset null instead of inventing a delay", () => {
    expect(chatUsageLimit("claude", "You've hit your limit", [], true, now)?.usageLimit).toEqual({ resetsAt: null });
  });
  it.each(["429 Too Many Requests", "rate_limit_error", "overloaded", "capacity unavailable", "Invalid API key: usage limit reached", "authentication failed: usage limit reached", "billing: usage limit reached", "out of credits", "quota configuration unavailable", "To use Codex with your ChatGPT plan, upgrade to Plus: https://chatgpt.com/explore/plus."])("rejects unrelated failure even next to spent windows: %s", (message) => {
    expect(chatUsageLimit("claude", message, windows, true, now)).toBeNull();
    expect(chatUsageLimit("codex", { message }, windows, true, now)).toBeNull();
  });
  it("rejects Codex's typed plan-entitlement failure", () => {
    expect(chatUsageLimit("codex", { codexErrorInfo: "usageLimitExceeded", message: "To use Codex with your ChatGPT plan, upgrade to Plus: https://chatgpt.com/explore/plus." }, windows, true, now)).toBeNull();
  });
  it.each(["claude", "codex"] as const)("rejects API/inject billing for %s", (provider) => {
    expect(chatUsageLimit(provider, { type: "UsageLimitReached", message: "usage limit reached" }, windows, false, now)).toBeNull();
  });
  it("requires current window corroboration for untyped Claude wording when available", () => {
    expect(chatUsageLimit("claude", "You've hit your limit", [{ ...windows[0], usedPercent: 99 }], true, now)).toBeNull();
  });
});
