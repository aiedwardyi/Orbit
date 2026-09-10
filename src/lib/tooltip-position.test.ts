import { describe, expect, it } from "vitest";
import { placeTooltip, TOOLTIP_EDGE, TOOLTIP_GAP } from "./tooltip-position";

const size = { width: 160, height: 24 };
const anchor = (left: number, top = 300) => ({ top, bottom: top + 14, left, width: 40 });

describe("placeTooltip", () => {
  it("centres on the anchor and sits above it when there is room", () => {
    const { top, left } = placeTooltip({ anchor: anchor(400), size, viewportWidth: 1000 });
    expect(left).toBe(400 + 20 - 80);
    expect(top).toBe(300 - TOOLTIP_GAP - 24);
  });

  it("drops below the anchor when there is no room above", () => {
    const { top } = placeTooltip({ anchor: anchor(400, 10), size, viewportWidth: 1000 });
    expect(top).toBe(24 + TOOLTIP_GAP);
  });

  // a short bubble hard against either side of a narrow window: centred, the
  // tip would hang outside the pane the transcript clips horizontally
  it("keeps a short bubble's tip inside a narrow window at the left edge", () => {
    const { left } = placeTooltip({ anchor: anchor(12), size, viewportWidth: 380 });
    expect(left).toBe(TOOLTIP_EDGE);
    expect(left + size.width).toBeLessThanOrEqual(380 - TOOLTIP_EDGE);
  });

  it("keeps a short bubble's tip inside a narrow window at the right edge", () => {
    const { left } = placeTooltip({ anchor: anchor(328), size, viewportWidth: 380 });
    expect(left).toBeGreaterThanOrEqual(TOOLTIP_EDGE);
    expect(left + size.width).toBe(380 - TOOLTIP_EDGE);
  });

  it("still starts on screen when the tip is wider than the window", () => {
    const { left } = placeTooltip({ anchor: anchor(20), size: { width: 500, height: 24 }, viewportWidth: 380 });
    expect(left).toBe(TOOLTIP_EDGE);
  });
});
