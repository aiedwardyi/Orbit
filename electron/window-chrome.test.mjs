import { describe, expect, it } from "vitest";

import {
  WINDOWS_CAPTION_HEIGHT,
  applyWindowsTitleBarOverlay,
  titleBarOverlayOptions,
  windowChromeOptions,
} from "./window-chrome.mjs";

describe("window chrome", () => {
  it("uses inset traffic lights on macOS", () => {
    expect(windowChromeOptions("darwin")).toEqual({
      titleBarStyle: "hiddenInset",
      trafficLightPosition: { x: 16, y: 16 },
    });
  });

  it("keeps Linux window chrome native", () => {
    expect(windowChromeOptions("linux")).toEqual({});
  });

  it("enables a 32px theme-colored Windows titleBarOverlay", () => {
    expect(WINDOWS_CAPTION_HEIGHT).toBe(32);
    expect(
      windowChromeOptions("win32", { color: "#070707", symbolColor: "#b5b5b5" }),
    ).toEqual({
      titleBarStyle: "hidden",
      titleBarOverlay: {
        color: "#070707",
        symbolColor: "#b5b5b5",
        height: 32,
      },
    });
  });

  it("builds overlay options from skin chrome without inventing a frame", () => {
    expect(titleBarOverlayOptions({ color: "#e9e9e9", symbolColor: "#575757" })).toEqual({
      color: "#e9e9e9",
      symbolColor: "#575757",
      height: 32,
    });
    expect(windowChromeOptions("win32")).not.toHaveProperty("frame");
    expect(JSON.stringify(windowChromeOptions("win32"))).not.toContain("frame\":false");
  });

  it("recolors an existing Windows overlay and ignores missing APIs", () => {
    const calls = [];
    expect(
      applyWindowsTitleBarOverlay(
        { isDestroyed: () => false, setTitleBarOverlay: (opts) => calls.push(opts) },
        { color: "#1a1a1a", symbolColor: "#aaa7a0" },
      ),
    ).toBe(true);
    expect(calls).toEqual([{ color: "#1a1a1a", symbolColor: "#aaa7a0", height: 32 }]);
    expect(applyWindowsTitleBarOverlay(null, { color: "#000", symbolColor: "#fff" })).toBe(false);
    expect(applyWindowsTitleBarOverlay({ isDestroyed: () => true, setTitleBarOverlay() {} }, { color: "#000", symbolColor: "#fff" })).toBe(false);
    expect(applyWindowsTitleBarOverlay({ isDestroyed: () => false }, { color: "#000", symbolColor: "#fff" })).toBe(false);
  });

  it("does not change macOS or Linux when chrome colors are supplied", () => {
    const chrome = { color: "#e9e9e9", symbolColor: "#575757" };
    expect(windowChromeOptions("darwin", chrome)).toEqual({
      titleBarStyle: "hiddenInset",
      trafficLightPosition: { x: 16, y: 16 },
    });
    expect(windowChromeOptions("linux", chrome)).toEqual({});
  });
});
