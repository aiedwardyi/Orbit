import { describe, expect, it } from "vitest";

import {
  claudeRateLimitWindows,
  codexRateLimitWindows,
  epochMs,
  exhaustedWindow,
  grokRateLimitWindows,
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
    expect(grokRateLimitWindows(null)).toEqual([]);
    expect(grokRateLimitWindows("42%")).toEqual([]);
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
      expect(usageLimitFromError(new Error(message))).toEqual({ resetsAt: null });
    }
  });

  it("reads retry-after seconds as a reset time", () => {
    const now = 1_790_000_000_000;
    expect(usageLimitFromError(Object.assign(new Error("429 Too Many Requests"), { data: { retryAfter: 600 } }), now))
      .toEqual({ resetsAt: now + 600_000 });
  });

  it("leaves anything that is not a usage limit alone", () => {
    expect(usageLimitFromError(new Error("Internal error"))).toBeNull();
    expect(usageLimitFromError(new Error("Invalid API key"))).toBeNull();
    expect(usageLimitFromError(new Error("model not found: grok-9"))).toBeNull();
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

  it("ignores a window with room left, and one whose reset has passed", () => {
    expect(exhaustedWindow([{ id: "seven_day", usedPercent: 99.4, resetsAt: now + 60_000 }], now)).toBeNull();
    expect(exhaustedWindow([{ id: "seven_day", usedPercent: 100, resetsAt: now - 1 }], now)).toBeNull();
    expect(exhaustedWindow([], now)).toBeNull();
    expect(exhaustedWindow(undefined, now)).toBeNull();
  });
});
