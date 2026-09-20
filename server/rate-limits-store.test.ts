import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { loadRateLimits, saveRateLimits, type RateLimitsMap } from "./rate-limits-store.ts";

describe("rate-limits-store", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "omb-rate-limits-"));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("roundtrips a report through the file", () => {
    const map: RateLimitsMap = new Map([
      ["claudeHappy", {
        windows: [
          { id: "five_hour", usedPercent: 42, resetsAt: 1_790_000_000_000 },
          { id: "seven_day", usedPercent: 19, resetsAt: null },
        ],
        observedAt: "2026-09-20T00:00:00.000Z",
      }],
    ]);
    saveRateLimits(map, dir);
    expect(loadRateLimits(dir)).toEqual(map);
  });

  it("returns an empty map for a missing file", () => {
    expect(loadRateLimits(dir)).toEqual(new Map());
  });

  it("returns an empty map for a malformed file without throwing", () => {
    writeFileSync(join(dir, "rate-limits.json"), "{not json");
    expect(loadRateLimits(dir)).toEqual(new Map());
    writeFileSync(join(dir, "rate-limits.json"), JSON.stringify({ claudeHappy: { windows: [], observedAt: "bogus" } }));
    expect(loadRateLimits(dir)).toEqual(new Map());
  });
});
