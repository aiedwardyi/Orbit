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
    let level = 0;
    const contents = {
      getZoomLevel: () => level,
      setZoomLevel: (next) => {
        level = next;
      },
    };
    expect(applyZoomShortcut(contents, { type: "keyDown", control: true, key: "=" })).toBe(true);
    expect(level).toBe(0.5);
    expect(applyZoomShortcut(contents, { type: "keyDown", control: true, key: "-" })).toBe(true);
    expect(level).toBe(0);
    expect(applyZoomShortcut(contents, { type: "keyDown", control: true, key: "-" })).toBe(true);
    expect(level).toBe(-0.5);
    expect(applyZoomShortcut(contents, { type: "keyDown", control: true, key: "=" })).toBe(true);
    expect(level).toBe(0);
    expect(applyZoomShortcut(contents, { type: "keyDown", control: true, key: "0" })).toBe(true);
    expect(level).toBe(0);
    expect(applyZoomShortcut(contents, { type: "keyDown", control: true, key: "f" })).toBe(false);
    expect(level).toBe(0);
  });

  it("does not claim handled when get/set throw", () => {
    const contents = {
      getZoomLevel: () => {
        throw new Error("missing");
      },
      setZoomLevel: () => {
        throw new Error("missing");
      },
    };
    expect(applyZoomShortcut(contents, { type: "keyDown", control: true, key: "=" })).toBe(false);
    expect(applyZoomShortcut(contents, { type: "keyDown", control: true, key: "-" })).toBe(false);
    expect(applyZoomShortcut(contents, { type: "keyDown", control: true, key: "0" })).toBe(false);
  });

  it("is wired on the main window so zoom-in and zoom-out both work", () => {
    const main = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "main.mjs"), "utf8");
    expect(main).toContain("routeZoomShortcut");
    expect(main).toContain("before-input-event");
  });

  it("clears image zoom ownership on reload and renderer crash", () => {
    const main = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "main.mjs"), "utf8");
    const guards = main.slice(main.indexOf("imageZoomGuards"));
    expect(guards).toContain("did-start-navigation");
    expect(guards).toContain("render-process-gone");
    expect(guards.match(/setImageZoomOwned\(contents\.id, false\)/g)?.length).toBeGreaterThanOrEqual(3);
  });

  it("sends zoom keys to the open image viewer instead of the window", () => {
    const dir = dirname(fileURLToPath(import.meta.url));
    const main = readFileSync(join(dir, "main.mjs"), "utf8");
    const preload = readFileSync(join(dir, "preload.cjs"), "utf8");
    const handlers = main.split("before-input-event").slice(1);
    expect(handlers.length).toBeGreaterThanOrEqual(2);
    for (const handler of handlers) {
      expect(handler.slice(0, 280)).toContain("routeWindowZoomKeys");
    }
    expect(main).toContain('ipcMain.on("image-zoom:own"');
    expect(main).toContain('"image-zoom:shortcut"');
    expect(preload).toContain("image-zoom:own");
    expect(preload).toContain("image-zoom:shortcut");
  });
});
