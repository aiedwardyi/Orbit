import { describe, expect, it } from "vitest";
import { placeTooltip, TOOLTIP_EDGE, TOOLTIP_GAP } from "./tooltip-position";

const size = { width: 160, height: 24 };
const anchor = (left: number, top = 300) => ({ top, bottom: top + 14, left, width: 40 });

describe("placeTooltip", () => {
  it("centres on the anchor and sits above it when there is room", () => {
    const { top, left } = placeTooltip({ anchor: anchor(400), size, viewportWidth: 1000, viewportHeight: 1000 });
    expect(left).toBe(400 + 20 - 80);
    expect(top).toBe(300 - TOOLTIP_GAP - 24);
  });

  it("drops below the anchor when there is no room above", () => {
    const { top } = placeTooltip({ anchor: anchor(400, 10), size, viewportWidth: 1000, viewportHeight: 1000 });
    expect(top).toBe(24 + TOOLTIP_GAP);
  });

  // a short bubble hard against either side of a narrow window: centred, the
  // tip would hang outside the pane the transcript clips horizontally
  it("keeps a short bubble's tip inside a narrow window at the left edge", () => {
    const { left } = placeTooltip({ anchor: anchor(12), size, viewportWidth: 380, viewportHeight: 1000 });
    expect(left).toBe(TOOLTIP_EDGE);
    expect(left + size.width).toBeLessThanOrEqual(380 - TOOLTIP_EDGE);
  });

  it("keeps a short bubble's tip inside a narrow window at the right edge", () => {
    const { left } = placeTooltip({ anchor: anchor(328), size, viewportWidth: 380, viewportHeight: 1000 });
    expect(left).toBeGreaterThanOrEqual(TOOLTIP_EDGE);
    expect(left + size.width).toBe(380 - TOOLTIP_EDGE);
  });

  // a window short enough that the anchor has no room above it and not enough
  // below it either, the way a 480px-tall frame runs out under a low bubble
  it("keeps the tip inside a short window when neither side fits", () => {
    const { top } = placeTooltip({ anchor: anchor(400, 10), size, viewportWidth: 1000, viewportHeight: 60 });
    expect(top).toBeLessThanOrEqual(60 - size.height - TOOLTIP_EDGE);
    expect(top).toBeGreaterThanOrEqual(TOOLTIP_EDGE);
  });

  it("still starts on screen when the tip is wider than the window", () => {
    const { left } = placeTooltip({ anchor: anchor(20), size: { width: 500, height: 24 }, viewportWidth: 380, viewportHeight: 1000 });
    expect(left).toBe(TOOLTIP_EDGE);
  });
});
