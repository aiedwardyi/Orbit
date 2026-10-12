import { describe, expect, it } from "vitest";

import { restoreWindowZoom, routeZoomShortcut, setImageZoomOwned } from "./window-zoom.mjs";

function contents(id, level) {
  return {
    id,
    getZoomLevel: () => level.value,
    setZoomLevel: (next) => {
      level.value = next;
    },
  };
}

describe("image viewer zoom keys", () => {
  it("leaves window zoom unchanged while the viewer owns the keys", () => {
    const level = { value: 1 };
    const webContents = contents(41, level);
    setImageZoomOwned(41, true, 1);
    try {
      expect(routeZoomShortcut(webContents, { type: "keyDown", control: true, key: "=" })).toEqual({
        target: "image",
        action: "in",
      });
      expect(routeZoomShortcut(webContents, { type: "keyDown", control: true, key: "-" })).toEqual({
        target: "image",
        action: "out",
      });
      expect(routeZoomShortcut(webContents, { type: "keyDown", control: true, key: "0" })).toEqual({
        target: "image",
        action: "reset",
      });
      expect(level.value).toBe(1);
      expect(routeZoomShortcut(webContents, { type: "keyDown", control: true, key: "f" })).toBeNull();
    } finally {
      setImageZoomOwned(41, false);
    }
  });

  it("zooms the window again after the viewer releases the keys", () => {
    const level = { value: 0 };
    const webContents = contents(42, level);
    setImageZoomOwned(42, true, 0);
    setImageZoomOwned(42, false);
    expect(routeZoomShortcut(webContents, { type: "keyDown", control: true, key: "=" })).toEqual({
      target: "window",
      action: "in",
    });
    expect(level.value).toBe(0.5);
    expect(routeZoomShortcut(webContents, { type: "keyDown", control: true, key: "0" })).toEqual({
      target: "window",
      action: "reset",
    });
    expect(level.value).toBe(0);
  });

  it("restores window zoom if it changes while the viewer is open", () => {
    const level = { value: 0.5 };
    const webContents = contents(43, level);
    setImageZoomOwned(43, true, 0.5);
    try {
      level.value = 2;
      expect(restoreWindowZoom(webContents)).toBe(true);
      expect(level.value).toBe(0.5);
      expect(restoreWindowZoom(webContents)).toBe(false);
    } finally {
      setImageZoomOwned(43, false);
    }
  });
});
