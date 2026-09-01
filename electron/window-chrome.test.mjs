import { describe, expect, it } from "vitest";

import { windowStartupOptions } from "./window-chrome.mjs";

describe("window startup", () => {
  it("uses inset traffic lights on macOS", () => {
    expect(windowStartupOptions("darwin")).toEqual({
      show: true,
      titleBarStyle: "hiddenInset",
      trafficLightPosition: { x: 16, y: 16 },
    });
  });

  it("shows Windows immediately with controls in the native title bar", () => {
    expect(windowStartupOptions("win32")).toEqual({ show: true });
  });

  it("keeps Linux window chrome native", () => {
    expect(windowStartupOptions("linux")).toEqual({ show: true });
  });
});
