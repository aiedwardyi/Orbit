import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";

import { applyZoomShortcut, zoomShortcut } from "./window-zoom.mjs";

describe("zoom shortcuts", () => {
  it("zooms in on Ctrl+= and Ctrl++ and numpad add", () => {
    expect(zoomShortcut({ control: true, key: "=" })).toBe("in");
    expect(zoomShortcut({ control: true, key: "+" })).toBe("in");
    expect(zoomShortcut({ control: true, key: "Add" })).toBe("in");
    expect(zoomShortcut({ meta: true, key: "=" })).toBe("in");
  });

  it("zooms out on Ctrl+- and numpad subtract", () => {
    expect(zoomShortcut({ control: true, key: "-" })).toBe("out");
    expect(zoomShortcut({ control: true, key: "_" })).toBe("out");
    expect(zoomShortcut({ control: true, key: "Subtract" })).toBe("out");
  });

  it("resets on Ctrl+0", () => {
    expect(zoomShortcut({ control: true, key: "0" })).toBe("reset");
  });

  it("ignores unmodified typing and Alt combinations", () => {
    expect(zoomShortcut({ key: "=" })).toBeNull();
    expect(zoomShortcut({ control: true, alt: true, key: "=" })).toBeNull();
    expect(zoomShortcut({ control: true, key: "f" })).toBeNull();
  });

  it("drives both zoom-in and zoom-out on the webContents", () => {
    const calls = [];
    const contents = {
      zoomIn: () => calls.push("in"),
      zoomOut: () => calls.push("out"),
      setZoomLevel: (level) => calls.push(`reset:${level}`),
    };
    expect(applyZoomShortcut(contents, { type: "keyDown", control: true, key: "=" })).toBe(true);
    expect(applyZoomShortcut(contents, { type: "keyDown", control: true, key: "-" })).toBe(true);
    expect(applyZoomShortcut(contents, { type: "keyDown", control: true, key: "0" })).toBe(true);
    expect(applyZoomShortcut(contents, { type: "keyDown", control: true, key: "f" })).toBe(false);
    expect(calls).toEqual(["in", "out", "reset:0"]);
  });

  it("is wired on the main window so zoom-in and zoom-out both work", () => {
    const main = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "main.mjs"), "utf8");
    expect(main).toContain("applyZoomShortcut");
    expect(main).toContain("before-input-event");
  });
});
