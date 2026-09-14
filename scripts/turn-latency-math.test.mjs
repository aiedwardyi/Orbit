import { describe, expect, it } from "vitest";

import { stats, summarizeTurn } from "./turn-latency-math.mjs";

const turn = [
  { t: 1000, kind: "start" },
  { t: 1050, kind: "local", label: "promptBuild", ms: 50 },
  { t: 1800, kind: "firstToken" },
  { t: 2000, kind: "tokens", n: 20 },
  { t: 2200, kind: "toolStart" },
  { t: 2500, kind: "toolEnd" },
  { t: 2800, kind: "tokens", n: 30 },
  { t: 3000, kind: "end", output: 50 },
];

describe("summarizeTurn", () => {
  it("decomposes a turn into provider, tool, and local slices", () => {
    const summary = summarizeTurn(turn);
    expect(summary.totalMs).toBe(2000);
    expect(summary.ttftMs).toBe(800);
    expect(summary.outputTokens).toBe(50);
    expect(summary.tokPerSec).toBeCloseTo(50 / 1.2, 6);
    expect(summary.toolTrips).toEqual([300]);
    expect(summary.localMs).toEqual({ promptBuild: 50 });
    expect(summary.providerMs).toBe(1950);
  });

  it("falls back to the provider-reported output count without batches", () => {
    const summary = summarizeTurn([
      { t: 0, kind: "start" },
      { t: 100, kind: "firstToken" },
      { t: 500, kind: "end", output: 12 },
    ]);
    expect(summary.outputTokens).toBe(12);
    expect(summary.tokPerSec).toBeCloseTo(12 / 0.4, 6);
  });

  it("leaves token metrics null when nothing was emitted", () => {
    const summary = summarizeTurn([
      { t: 0, kind: "start" },
      { t: 500, kind: "end" },
    ]);
    expect(summary.ttftMs).toBeNull();
    expect(summary.outputTokens).toBe(0);
    expect(summary.tokPerSec).toBeNull();
  });

  it("ignores unmatched tool boundaries instead of inventing trips", () => {
    const summary = summarizeTurn([
      { t: 0, kind: "start" },
      { t: 100, kind: "toolEnd" },
      { t: 200, kind: "toolStart" },
      { t: 500, kind: "end" },
    ]);
    expect(summary.toolTrips).toEqual([]);
  });
});

describe("stats", () => {
  it("reports mean, spread, and range", () => {
    expect(stats([100, 200, 300])).toEqual({ n: 3, mean: 200, min: 100, max: 300, sd: expect.closeTo(81.65, 2) });
  });

  it("returns nulls for an empty sample", () => {
    expect(stats([])).toEqual({ n: 0, mean: null, min: null, max: null, sd: null });
  });
});
