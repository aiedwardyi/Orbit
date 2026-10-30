import { describe, expect, it } from "vitest";
import {
  atFit, clampScale, fitView, imageFrame, panBy, resizeView, toggleZoomAt,
  wheelZoomFactor, zoomAround, zoomKeyAction, type ZoomFrame, type ZoomView,
} from "./image-zoom";

const phone = imageFrame(390, 844, 3216, 4974);
const desktop = imageFrame(1440, 900, 3216, 4974);
const center = (f: ZoomFrame) => ({ x: f.viewW / 2, y: f.viewH / 2 });
const sourcePoint = (v: ZoomView, p: { x: number; y: number }, f: ZoomFrame) => ({
  x: (p.x - f.viewW / 2 - v.panX) / v.scale + f.sourceW / 2,
  y: (p.y - f.viewH / 2 - v.panY) / v.scale + f.sourceH / 2,
});

describe("image zoom", () => {
  it.each([phone, desktop])("makes a 12 px collage label native and reaches 800% at either width", (f) => {
    const fit = fitView(f);
    expect(fit.scale).toBeLessThan(0.2);
    const native = toggleZoomAt(fit, center(f), f);
    expect(native.scale * 12).toBe(12);
    expect(zoomAround(native, center(f), f, 100).scale).toBe(8);
    expect(toggleZoomAt(native, center(f), f)).toEqual(fit);
  });

  it("does not enlarge a small image to fill the stage", () => {
    expect(imageFrame(1440, 900, 200, 100).fit).toBe(1);
  });

  it.each([{ x: 195, y: 422 }, { x: 80, y: 240 }, { x: 350, y: 690 }])("keeps the source pixel beneath the pointer while zooming", (p) => {
    const fit = fitView(phone);
    const before = sourcePoint(fit, p, phone);
    const after = sourcePoint(zoomAround(fit, p, phone, 1 / fit.scale), p, phone);
    expect(after.x).toBeCloseTo(before.x, 8);
    expect(after.y).toBeCloseTo(before.y, 8);
  });

  it("moves the same source pixel with a moving pinch midpoint", () => {
    const start = { scale: 1, panX: -100, panY: 60 };
    const p = { x: 140, y: 390 };
    const next = zoomAround(start, p, phone, 1.5, { x: 35, y: -20 });
    expect(sourcePoint(next, { x: 175, y: 370 }, phone)).toEqual(sourcePoint(start, p, phone));
  });

  it("fills both edges after a huge drag and centers undersized axes", () => {
    const panned = panBy({ scale: 1, panX: 0, panY: 0 }, 100_000, -100_000, phone);
    const left = (phone.viewW - phone.sourceW) / 2 + panned.panX;
    const bottom = (phone.viewH + phone.sourceH) / 2 + panned.panY;
    expect(left).toBe(0);
    expect(bottom).toBe(phone.viewH);
    const small = imageFrame(800, 600, 100, 100);
    expect(panBy(fitView(small), 10_000, 10_000, small)).toEqual(fitView(small));
  });

  it("clamps an anchored edge without exposing blank space", () => {
    const next = zoomAround(fitView(phone), { x: 0, y: 0 }, phone, 1.01);
    expect((phone.viewW - phone.sourceW * next.scale) / 2 + next.panX).toBeLessThanOrEqual(0);
    expect(next.panY).toBe(0);
  });

  it("keeps native scale and the centered source point after rotation", () => {
    const landscape = imageFrame(844, 390, 3216, 4974);
    const native = { scale: 1, panX: 190, panY: -300 };
    const resized = resizeView(native, phone, landscape);
    expect(resized.scale).toBe(1);
    expect(sourcePoint(resized, center(landscape), landscape)).toEqual(sourcePoint(native, center(phone), phone));
    expect(resizeView(fitView(phone), phone, landscape)).toEqual(fitView(landscape));
  });

  it("resets to centered fit and ignores nonfinite input", () => {
    const native = { scale: 1, panX: 110, panY: -240 };
    expect(zoomAround(native, center(phone), phone, 0.0001)).toEqual(fitView(phone));
    for (const delta of [NaN, Infinity, -Infinity]) {
      expect(zoomAround(native, center(phone), phone, delta)).toBe(native);
      expect(panBy(native, delta, 0, phone)).toBe(native);
      expect(wheelZoomFactor(delta)).toBe(1);
    }
    expect(clampScale(NaN, phone.fit)).toBe(phone.fit);
    expect(clampScale(100, phone.fit)).toBe(8);
    expect(atFit(fitView(phone), phone)).toBe(true);
  });

  it.each(["=", "+", "-", "0"])("accepts plain and modified %s without Alt", (key) => {
    expect(zoomKeyAction({ key, altKey: false })).not.toBeNull();
    expect(zoomKeyAction({ key, altKey: true })).toBeNull();
  });
});
