import { describe, expect, it, vi } from "vitest";

import {
  SIDEBAR_DENSITY_KEY,
  SIDEBAR_DEFAULT_WIDTH,
  SIDEBAR_MAX_WIDTH,
  SIDEBAR_MIN_WIDTH,
  SIDEBAR_WIDTH_KEY,
  SIDEBAR_WIDTH_STEP,
  clampSidebarWidth,
  loadSidebarDensity,
  loadSidebarWidth,
  parseSidebarDensity,
  parseSidebarWidth,
  saveSidebarDensity,
  saveSidebarWidth,
  stepSidebarWidth,
} from "./sidebar-preferences";

describe("sidebar density preferences", () => {
  it("accepts the three supported layouts and rejects stale values", () => {
    expect(parseSidebarDensity("comfortable")).toBe("comfortable");
    expect(parseSidebarDensity("compact")).toBe("compact");
    expect(parseSidebarDensity("icons")).toBe("icons");
    expect(parseSidebarDensity("tiny")).toBe("comfortable");
    expect(parseSidebarDensity(null)).toBe("comfortable");
  });

  it("loads and saves without making storage availability a launch dependency", () => {
    const setItem = vi.fn();
    saveSidebarDensity("icons", { setItem });
    expect(setItem).toHaveBeenCalledWith(SIDEBAR_DENSITY_KEY, "icons");
    expect(loadSidebarDensity({ getItem: () => "compact" })).toBe("compact");
    expect(loadSidebarDensity({ getItem: () => { throw new Error("blocked"); } })).toBe("comfortable");
  });
});

describe("sidebar width preferences", () => {
  it("clamps to a readable named-list range and rejects junk", () => {
    expect(clampSidebarWidth(320)).toBe(320);
    expect(clampSidebarWidth(SIDEBAR_MIN_WIDTH - 40)).toBe(SIDEBAR_MIN_WIDTH);
    expect(clampSidebarWidth(SIDEBAR_MAX_WIDTH + 80)).toBe(SIDEBAR_MAX_WIDTH);
    expect(clampSidebarWidth(Number.NaN)).toBe(SIDEBAR_DEFAULT_WIDTH);
    expect(parseSidebarWidth("272.4")).toBe(272);
    expect(parseSidebarWidth("")).toBe(SIDEBAR_DEFAULT_WIDTH);
    expect(parseSidebarWidth(null)).toBe(SIDEBAR_DEFAULT_WIDTH);
    expect(parseSidebarWidth("wide")).toBe(SIDEBAR_DEFAULT_WIDTH);
  });

  it("loads and saves without making storage availability a launch dependency", () => {
    const setItem = vi.fn();
    saveSidebarWidth(410, { setItem });
    expect(setItem).toHaveBeenCalledWith(SIDEBAR_WIDTH_KEY, "410");
    expect(loadSidebarWidth({ getItem: () => "240" })).toBe(240);
    expect(loadSidebarWidth({ getItem: () => { throw new Error("blocked"); } })).toBe(SIDEBAR_DEFAULT_WIDTH);
  });

  it("steps ten pixels on horizontal arrows and clamps at the named-list range", () => {
    expect(SIDEBAR_WIDTH_STEP).toBe(10);
    expect(stepSidebarWidth(320, "ArrowRight")).toBe(330);
    expect(stepSidebarWidth(320, "ArrowLeft")).toBe(310);
    expect(stepSidebarWidth(SIDEBAR_MIN_WIDTH, "ArrowLeft")).toBe(SIDEBAR_MIN_WIDTH);
    expect(stepSidebarWidth(SIDEBAR_MAX_WIDTH, "ArrowRight")).toBe(SIDEBAR_MAX_WIDTH);
    expect(stepSidebarWidth(320, "Home")).toBe(SIDEBAR_MIN_WIDTH);
    expect(stepSidebarWidth(320, "End")).toBe(SIDEBAR_MAX_WIDTH);
    expect(stepSidebarWidth(320, "ArrowUp")).toBe(null);
    expect(stepSidebarWidth(320, "Enter")).toBe(null);
  });
});
