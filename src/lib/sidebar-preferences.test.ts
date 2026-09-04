import { describe, expect, it, vi } from "vitest";

import {
  SIDEBAR_COLLAPSED_KEY,
  SIDEBAR_COLLAPSED_WIDTH,
  SIDEBAR_DENSITY_KEY,
  SIDEBAR_DEFAULT_WIDTH,
  SIDEBAR_MAX_WIDTH,
  SIDEBAR_MIN_WIDTH,
  SIDEBAR_SNAP_DISTANCE,
  SIDEBAR_WIDTH_KEY,
  SIDEBAR_WIDTH_STEP,
  clampSidebarWidth,
  displaySidebarWidth,
  loadSidebarCollapsed,
  loadSidebarDensity,
  loadSidebarWidth,
  parseSidebarCollapsed,
  parseSidebarDensity,
  parseSidebarWidth,
  saveSidebarCollapsed,
  saveSidebarDensity,
  restoreSidebarDragWidth,
  saveSidebarWidth,
  snapSidebarDrag,
  stepSidebarLayout,
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

  it("restores the pre-drag labeled width and collapsed flag when a pointer drag is cancelled", () => {
    expect(restoreSidebarDragWidth({ width: 320, collapsed: false })).toEqual({ width: 320, collapsed: false });
    expect(restoreSidebarDragWidth({ width: 410, collapsed: true })).toEqual({ width: 410, collapsed: true });
    expect(restoreSidebarDragWidth(null)).toBe(null);
  });
});

describe("sidebar icon-rail snap", () => {
  it("keeps the collapsed rail inside the Grok-style 56–72px band", () => {
    expect(SIDEBAR_COLLAPSED_WIDTH).toBeGreaterThanOrEqual(56);
    expect(SIDEBAR_COLLAPSED_WIDTH).toBeLessThanOrEqual(72);
    expect(SIDEBAR_COLLAPSED_WIDTH).toBeLessThan(SIDEBAR_MIN_WIDTH);
    expect(displaySidebarWidth({ width: 320, collapsed: false })).toBe(320);
    expect(displaySidebarWidth({ width: 320, collapsed: true })).toBe(SIDEBAR_COLLAPSED_WIDTH);
  });

  it("snaps into the icon rail a little past the labeled minimum and keeps that labeled width", () => {
    const labeled = { width: SIDEBAR_MIN_WIDTH, collapsed: false };
    expect(snapSidebarDrag(labeled, -(SIDEBAR_SNAP_DISTANCE - 1))).toEqual(labeled);
    expect(snapSidebarDrag(labeled, -SIDEBAR_SNAP_DISTANCE)).toEqual({
      width: SIDEBAR_MIN_WIDTH,
      collapsed: true,
    });
    expect(snapSidebarDrag({ width: 320, collapsed: false }, -(320 - SIDEBAR_MIN_WIDTH + SIDEBAR_SNAP_DISTANCE))).toEqual({
      width: 320,
      collapsed: true,
    });
  });

  it("snaps back to the last labeled width when dragged out of the rail", () => {
    const rail = { width: 360, collapsed: true };
    expect(snapSidebarDrag(rail, SIDEBAR_SNAP_DISTANCE - 1)).toEqual(rail);
    expect(snapSidebarDrag(rail, SIDEBAR_SNAP_DISTANCE)).toEqual({ width: 360, collapsed: false });
  });

  it("still live-resizes inside the labeled min/max range", () => {
    expect(snapSidebarDrag({ width: 320, collapsed: false }, 40)).toEqual({ width: 360, collapsed: false });
    expect(snapSidebarDrag({ width: 320, collapsed: false }, -40)).toEqual({ width: 280, collapsed: false });
    expect(snapSidebarDrag({ width: SIDEBAR_MAX_WIDTH, collapsed: false }, 80)).toEqual({
      width: SIDEBAR_MAX_WIDTH,
      collapsed: false,
    });
  });

  it("persists collapsed separately from the last labeled width", () => {
    const setItem = vi.fn();
    saveSidebarCollapsed(true, { setItem });
    expect(setItem).toHaveBeenCalledWith(SIDEBAR_COLLAPSED_KEY, "1");
    saveSidebarCollapsed(false, { setItem });
    expect(setItem).toHaveBeenCalledWith(SIDEBAR_COLLAPSED_KEY, "0");
    expect(parseSidebarCollapsed("1")).toBe(true);
    expect(parseSidebarCollapsed("true")).toBe(true);
    expect(parseSidebarCollapsed("0")).toBe(false);
    expect(parseSidebarCollapsed(null)).toBe(false);
    expect(loadSidebarCollapsed({ getItem: () => "1" })).toBe(true);
    expect(loadSidebarCollapsed({ getItem: () => "0" })).toBe(false);
    expect(loadSidebarCollapsed({ getItem: () => { throw new Error("blocked"); } })).toBe(false);
  });

  it("steps Home/End/arrows across the rail snap without dropping the last labeled width", () => {
    expect(stepSidebarLayout({ width: 320, collapsed: false }, "Home")).toEqual({ width: 320, collapsed: true });
    expect(stepSidebarLayout({ width: 320, collapsed: true }, "End")).toEqual({
      width: SIDEBAR_MAX_WIDTH,
      collapsed: false,
    });
    expect(stepSidebarLayout({ width: SIDEBAR_MIN_WIDTH, collapsed: false }, "ArrowLeft")).toEqual({
      width: SIDEBAR_MIN_WIDTH,
      collapsed: true,
    });
    expect(stepSidebarLayout({ width: 230, collapsed: false }, "ArrowLeft")).toEqual({
      width: 220,
      collapsed: false,
    });
    expect(stepSidebarLayout({ width: 360, collapsed: true }, "ArrowRight")).toEqual({
      width: 360,
      collapsed: false,
    });
    expect(stepSidebarLayout({ width: 360, collapsed: true }, "ArrowLeft")).toEqual({
      width: 360,
      collapsed: true,
    });
    expect(stepSidebarLayout({ width: 320, collapsed: false }, "ArrowRight")).toEqual({
      width: 330,
      collapsed: false,
    });
    expect(stepSidebarLayout({ width: 320, collapsed: false }, "ArrowUp")).toBe(null);
  });
});
