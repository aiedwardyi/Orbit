import { describe, expect, it } from "vitest";

import { soonAfterWake, wakeClock } from "./pc-wake.ts";

describe("pc wake", () => {
  it("counts the first minutes after boot", () => {
    expect(soonAfterWake(Date.now(), 600_000)).toBe(true);
    expect(soonAfterWake(Date.now() + 601_000, 600_000)).toBe(false);
  });

  it("marks a wake when a tick fires over a minute late", () => {
    const tick = wakeClock(30_000);
    const start = Date.now() + 3_600_000;
    tick(start);
    tick(start + 90_000);
    expect(soonAfterWake(start + 120_000, 600_000)).toBe(false);
    tick(start + 180_001);
    expect(soonAfterWake(start + 150_000, 600_000)).toBe(false);
    expect(soonAfterWake(start + 750_001, 600_000)).toBe(true);
    expect(soonAfterWake(start + 750_002, 600_000)).toBe(false);
  });
});
