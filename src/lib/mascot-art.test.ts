import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { MASCOT_STYLE_ASSETS, MASCOT_STYLES } from "../../shared/bot-avatar";
import { mascotSvgMarkup } from "./mascot-art";

const assetsDir = join(dirname(fileURLToPath(import.meta.url)), "../assets/mascots");

describe("cute mascot art pack", () => {
  it("ships a bundled SVG for every style id", () => {
    for (const style of MASCOT_STYLES) {
      const filename = MASCOT_STYLE_ASSETS[style].replace(/^.*\//, "");
      const path = join(assetsDir, filename);
      expect(existsSync(path), path).toBe(true);
      const svg = readFileSync(path, "utf8");
      expect(svg).toContain("<svg");
      expect(svg).toContain("{{BODY}}");
      expect(svg.toLowerCase()).not.toContain("arrow");
    }
  });

  it("paints each style with the bot color and keeps the four faces distinct", () => {
    const peach = mascotSvgMarkup("peach", "red");
    const teal = mascotSvgMarkup("teal", "teal");
    const lavender = mascotSvgMarkup("lavender", "purple");
    const coral = mascotSvgMarkup("coral", "coral");

    expect(peach).toContain("#D94B52");
    expect(teal).toContain("#01A492");
    expect(lavender).toContain("#8057C8");
    expect(coral).toContain("#E5634E");

    expect(peach).not.toContain("{{BODY}}");
    expect(new Set([peach, teal, lavender, coral]).size).toBe(4);
    expect(teal).toContain('id="antenna"');
    expect(lavender).toContain('id="ear-left"');
    expect(coral).toContain('id="flop-left"');
  });
});

describe("iOS color-map lockstep", () => {
  const here = dirname(fileURLToPath(import.meta.url));
  const cute = readFileSync(join(here, "../../ios/App/MausAvatar.swift"), "utf8");
  const core = readFileSync(join(here, "../../ios/Sources/CompanionCore/Models.swift"), "utf8");
  const cases = [
    'case "green", "teal", "cyan": return .teal',
    'case "blue", "purple": return .lavender',
    'case "pink", "coral": return .coral',
    "default: return .peach",
  ];

  it("keeps CuteMascotStyle.resolved and CompanionCore.MascotStyle.resolved on the same map", () => {
    for (const line of cases) {
      expect(cute, `MausAvatar.swift missing ${line}`).toContain(line);
      expect(core, `Models.swift missing ${line}`).toContain(line);
    }
  });
});
