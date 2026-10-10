import { existsSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { MASCOT_STYLES, NOTIFY_ICON_COLORS, mascotNotifyIconPath } from "../shared/bot-avatar.ts";
import { MAUS_COLOR_NAMES } from "../src/lib/mascot.ts";
import { decodePng } from "./png-codec.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const pairs = MASCOT_STYLES.flatMap((style) => NOTIFY_ICON_COLORS.map((color) => [style, color]));

describe("notify icons", () => {
  it("covers exactly the palette the app paints", () => {
    expect([...NOTIFY_ICON_COLORS].sort()).toEqual([...MAUS_COLOR_NAMES].sort());
  });

  it("ships a PNG for every mascot style and color, and nothing else", () => {
    const missing = pairs.map(([style, color]) => mascotNotifyIconPath(style, color)).filter((path) => !existsSync(join(ROOT, "public", path)));
    expect(missing).toEqual([]);
    expect(readdirSync(join(ROOT, "public", "notify-icons")).sort()).toEqual(
      pairs.map(([style, color]) => mascotNotifyIconPath(style, color).split("/").pop()).sort(),
    );
  });

  it("renders each at 192 px on a transparent background", () => {
    for (const [style, color] of pairs) {
      const image = decodePng(join(ROOT, "public", mascotNotifyIconPath(style, color)));
      expect([image.width, image.height, image.pixels[3]], `${style}-${color}`).toEqual([192, 192, 0]);
    }
  });
});
