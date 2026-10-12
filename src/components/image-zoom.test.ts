import { describe, expect, it } from "vitest";

import {
  FIT_VIEW,
  clampScale,
  panBy,
  toggleZoomAt,
  wheelPanOffset,
  zoomAround,
  type ZoomFrame,
  type ZoomView,
} from "./image-zoom";

const frame: ZoomFrame = { viewW: 400, viewH: 300, fitW: 200, fitH: 100 };
const corner = { x: 100, y: 100 };

function imageLocal(view: ZoomView, point: { x: number; y: number }) {
  const icx = frame.viewW / 2 + view.panX;
  const icy = frame.viewH / 2 + view.panY;
  return { x: (point.x - icx) / view.scale, y: (point.y - icy) / view.scale };
}

function overlap(view: ZoomView) {
  const sw = frame.fitW * view.scale;
  const sh = frame.fitH * view.scale;
  const left = frame.viewW / 2 + view.panX - sw / 2;
  const top = frame.viewH / 2 + view.panY - sh / 2;
  return {
    w: Math.min(frame.viewW, left + sw) - Math.max(0, left),
    h: Math.min(frame.viewH, top + sh) - Math.max(0, top),
  };
}

describe("image zoom math", () => {
  it("clamps scale from fit to 8x", () => {
    expect(clampScale(0)).toBe(1);
    expect(clampScale(0.4)).toBe(1);
    expect(clampScale(1)).toBe(1);
    expect(clampScale(6)).toBe(6);
    expect(clampScale(8)).toBe(8);
    expect(clampScale(12)).toBe(8);
    expect(clampScale(Number.NaN)).toBe(1);
  });

  it("zooms around a point without moving that image point", () => {
    const before = imageLocal(FIT_VIEW, corner);
    const zoomed = zoomAround(FIT_VIEW, corner, frame, 2);
    expect(zoomed.scale).toBe(2);
    expect(imageLocal(zoomed, corner)).toEqual(before);

    const atCap = zoomAround({ scale: 5, panX: 0, panY: 0 }, { x: 200, y: 150 }, frame, 4);
    expect(atCap.scale).toBe(8);
    expect(imageLocal(atCap, { x: 200, y: 150 })).toEqual(imageLocal({ scale: 5, panX: 0, panY: 0 }, { x: 200, y: 150 }));

    expect(zoomAround({ scale: 8, panX: 10, panY: -4 }, corner, frame, 2)).toEqual({ scale: 8, panX: 10, panY: -4 });
  });

  it("keeps part of the image inside the view when panning", () => {
    const zoomed = zoomAround(FIT_VIEW, { x: 200, y: 150 }, frame, 2);
    const shoved = panBy(zoomed, 10_000, -10_000, frame);
    const seen = overlap(shoved);
    expect(seen.w).toBeGreaterThanOrEqual(48);
    expect(seen.h).toBeGreaterThanOrEqual(48);
    expect(panBy(FIT_VIEW, 80, 40, frame)).toEqual(FIT_VIEW);
  });

  it("toggles fit and 2x at the clicked point", () => {
    const before = imageLocal(FIT_VIEW, corner);
    const zoomed = toggleZoomAt(FIT_VIEW, corner, frame);
    expect(zoomed.scale).toBe(2);
    expect(imageLocal(zoomed, corner)).toEqual(before);
    expect(toggleZoomAt(zoomed, corner, frame)).toEqual(FIT_VIEW);
    expect(toggleZoomAt({ scale: 6, panX: 30, panY: 12 }, corner, frame)).toEqual(FIT_VIEW);
  });

  it("returns to fit when a zoom-out reaches 1x", () => {
    const zoomed = zoomAround(FIT_VIEW, corner, frame, 2);
    expect(zoomAround(zoomed, corner, frame, 0.4)).toEqual(FIT_VIEW);
  });

  it("turns wheel deltas into a pan offset that moves the view with the scroll", () => {
    expect(wheelPanOffset({ deltaX: 20, deltaY: 100, deltaMode: 0 }, frame)).toEqual({ dx: -20, dy: -100 });
    expect(wheelPanOffset({ deltaX: 2, deltaY: 3, deltaMode: 1 }, frame)).toEqual({ dx: -32, dy: -48 });
    expect(wheelPanOffset({ deltaX: 1, deltaY: 1, deltaMode: 2 }, frame)).toEqual({ dx: -400, dy: -300 });
  });

  it("pans the zoomed image with the wheel and ignores the wheel at fit", () => {
    const zoomed = zoomAround(FIT_VIEW, { x: 200, y: 150 }, frame, 2);
    const { dx, dy } = wheelPanOffset({ deltaX: 10, deltaY: 120, deltaMode: 0 }, frame);
    const panned = panBy(zoomed, dx, dy, frame);
    expect(panned.scale).toBe(2);
    expect(panned.panX).toBeLessThan(zoomed.panX);
    expect(panned.panY).toBeLessThan(zoomed.panY);
    expect(panBy(FIT_VIEW, dx, dy, frame)).toEqual(FIT_VIEW);
  });
});
