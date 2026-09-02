import { describe, expect, it } from "vitest";

import {
  botUsage,
  cachedInput,
  costCaption,
  formatTokens,
  formatUsd,
  percentUsed,
  resetCountdown,
  resetPhrase,
  sumUsage,
  usageChip,
  usageDetail,
  windowExpired,
  windowKind,
} from "./usage";

describe("usage formatting", () => {
  it("formats token counts compactly", () => {
    expect(formatTokens(950)).toBe("950");
    expect(formatTokens(12_400)).toBe("12.4k");
    expect(formatTokens(120_000)).toBe("120k");
    expect(formatTokens(2_300_000)).toBe("2.3M");
  });

  it("keeps small dollar amounts visible", () => {
    expect(formatUsd(0)).toBe("$0");
    expect(formatUsd(0.004)).toBe("$0.004");
    expect(formatUsd(0.31)).toBe("$0.31");
  });

  it("does not throw on missing usage fields from older bots.json", () => {
    expect(formatUsd(undefined as unknown as number)).toBe("");
    expect(formatTokens(undefined as unknown as number)).toBe("0");
    expect(
      usageChip({ input: 100, output: 20, turns: 1 } as { input: number; output: number; costUsd: null; turns: number }),
    ).toBe("120 tok");
  });

  it("treats NaN and Infinity cost as missing", () => {
    expect(formatUsd(Number.NaN)).toBe("");
    expect(formatUsd(Number.POSITIVE_INFINITY)).toBe("");
    expect(formatTokens(Number.NaN)).toBe("0");
    expect(formatTokens(Number.POSITIVE_INFINITY)).toBe("0");
    expect(usageChip({ input: 100, output: 20, costUsd: Number.NaN, turns: 1 })).toBe("120 tok");
    expect(usageChip({ input: 100, output: 20, costUsd: Number.POSITIVE_INFINITY, turns: 1 })).toBe("120 tok");
    expect(
      sumUsage([
        { input: 1, output: 1, costUsd: Number.NaN, turns: 1 },
        { input: 2, output: 2, costUsd: 0.01, turns: 1 },
      ]),
    ).toEqual({ input: 3, output: 3, costUsd: 0.01, turns: 2 });
  });

  it("carries the cached share through sums and names it in the breakdown", () => {
    // records from before the field existed simply don't contribute to it
    expect(sumUsage([{ input: 100, output: 10, costUsd: null, turns: 1 }, { input: 200, output: 20, cachedInput: 150, costUsd: null, turns: 1 }]))
      .toEqual({ input: 300, output: 30, cachedInput: 150, costUsd: null, turns: 2 });
    expect(sumUsage([{ input: 100, output: 10, costUsd: null, turns: 1 }])).toEqual({ input: 100, output: 10, costUsd: null, turns: 1 });
    // the headline stays the whole figure; the split is what explains it
    expect(usageDetail({ input: 88_200, output: 1_200, cachedInput: 79_000, costUsd: null, turns: 5 })).toBe("88.2k in (79k cached) · 1.2k out");
    expect(usageDetail({ input: 900, output: 50, costUsd: null, turns: 1 })).toBe("900 in · 50 out");
    expect(usageDetail({ input: 900, output: 50, cachedInput: 0, costUsd: null, turns: 1 })).toBe("900 in · 50 out");
    // a cached figure can never exceed the input it is part of, or go negative
    expect(cachedInput({ input: 100, output: 0, cachedInput: 250, costUsd: null, turns: 1 })).toBe(100);
    expect(cachedInput({ input: 100, output: 0, cachedInput: -3, costUsd: null, turns: 1 })).toBe(0);
    expect(cachedInput({ input: 100, output: 0, cachedInput: Number.NaN, costUsd: null, turns: 1 })).toBe(0);
  });

  it("builds the chip: tokens always, cost only when known, nothing when unused", () => {
    expect(usageChip({ input: 0, output: 0, costUsd: null, turns: 0 })).toBe("");
    expect(usageChip({ input: 10_000, output: 2_400, costUsd: null, turns: 3 })).toBe("12.4k tok");
    expect(usageChip({ input: 10_000, output: 2_400, costUsd: 0.06, turns: 3 })).toBe("12.4k tok · $0.06");
  });

  it("sums across tasks and leaves cost null until one reports it", () => {
    expect(sumUsage([{ input: 1, output: 1, costUsd: null, turns: 1 }, undefined, { input: 2, output: 2, costUsd: null, turns: 1 }])).toEqual({
      input: 3,
      output: 3,
      costUsd: null,
      turns: 2,
    });
    expect(
      botUsage({
        tasks: [
          { threadId: "a", title: "", createdAt: 0, usage: { input: 5, output: 5, costUsd: 0.01, turns: 1 } },
          { threadId: "b", title: "", createdAt: 0 },
          { threadId: "c", title: "", createdAt: 0, usage: { input: 5, output: 5, costUsd: null, turns: 2 } },
        ],
      }),
    ).toEqual({ input: 10, output: 10, costUsd: 0.01, turns: 3 });
  });

  it("captions cost by billing", () => {
    expect(costCaption("subscription")).toMatch(/not billed/);
    expect(costCaption("metered")).toMatch(/API key/);
    expect(costCaption(undefined)).toMatch(/reported/);
  });
});

describe("subscription windows", () => {
  const now = Date.UTC(2026, 8, 3, 12, 0, 0);
  const hours = (n: number) => now + n * 3_600_000;
  const minutes = (n: number) => now + n * 60_000;

  it("classes a window by its id first, then by its length", () => {
    expect(windowKind("five_hour")).toBe("session");
    expect(windowKind("seven_day")).toBe("weekly");
    expect(windowKind("seven_day_opus")).toBe("weekly");
    expect(windowKind("primary", 300)).toBe("session");
    expect(windowKind("secondary", 10_080)).toBe("weekly");
    expect(windowKind("primary")).toBe("other");
    expect(windowKind("primary", 1_440)).toBe("other");
  });

  it("shows whole percents and keeps overage honest", () => {
    expect(percentUsed(76.4)).toBe(76);
    expect(percentUsed(0)).toBe(0);
    expect(percentUsed(120)).toBe(120);
    expect(percentUsed(-3)).toBe(0);
    expect(percentUsed(Number.NaN)).toBeNull();
    expect(percentUsed(Number.POSITIVE_INFINITY)).toBeNull();
    expect(percentUsed(undefined)).toBeNull();
    expect(percentUsed("76")).toBeNull();
  });

  it("counts down in days, then hours, then minutes", () => {
    expect(resetCountdown(hours(49), now)).toEqual({ unit: "days", value: 2 });
    expect(resetCountdown(hours(36), now)).toEqual({ unit: "days", value: 2 });
    expect(resetCountdown(hours(30), now)).toEqual({ unit: "days", value: 1 });
    expect(resetCountdown(hours(23.6), now)).toEqual({ unit: "days", value: 1 });
    expect(resetCountdown(hours(5.4), now)).toEqual({ unit: "hours", value: 5 });
    expect(resetCountdown(minutes(59.4), now)).toEqual({ unit: "hours", value: 1 });
    expect(resetCountdown(minutes(20), now)).toEqual({ unit: "minutes", value: 20 });
    expect(resetCountdown(now + 10, now)).toEqual({ unit: "minutes", value: 1 });
    expect(resetCountdown(now, now)).toBeNull();
    expect(resetCountdown(now - 1, now)).toBeNull();
    expect(resetCountdown(null, now)).toBeNull();
    expect(resetCountdown(undefined, now)).toBeNull();
  });

  it("phrases the reset as one complete message, including unknown and passed", () => {
    expect(resetPhrase(hours(49), now)).toEqual({ key: "usage.limits.resetsInDays", vars: { days: 2 } });
    expect(resetPhrase(hours(30), now)).toEqual({ key: "usage.limits.resetsInOneDay" });
    expect(resetPhrase(hours(3), now)).toEqual({ key: "usage.limits.resetsInHours", vars: { hours: 3 } });
    expect(resetPhrase(hours(1), now)).toEqual({ key: "usage.limits.resetsInOneHour" });
    expect(resetPhrase(minutes(5), now)).toEqual({ key: "usage.limits.resetsInMinutes", vars: { minutes: 5 } });
    expect(resetPhrase(now + 30_000, now)).toEqual({ key: "usage.limits.resetsInOneMinute" });
    expect(resetPhrase(null, now)).toEqual({ key: "usage.limits.resetUnknown" });
    expect(resetPhrase(Number.NaN, now)).toEqual({ key: "usage.limits.resetUnknown" });
    expect(resetPhrase(now - 1, now)).toEqual({ key: "usage.limits.resetPassed" });
  });

  it("knows a passed reset from a missing one", () => {
    expect(windowExpired(now - 1, now)).toBe(true);
    expect(windowExpired(now, now)).toBe(true);
    expect(windowExpired(hours(1), now)).toBe(false);
    expect(windowExpired(null, now)).toBe(false);
    expect(windowExpired(undefined, now)).toBe(false);
  });
});
