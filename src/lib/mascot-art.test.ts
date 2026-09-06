import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { MASCOT_STYLE_ASSETS, MASCOT_STYLES } from "../../shared/bot-avatar";
import { MAUS_COLORS } from "./mascot";
import { mascotSvgMarkup, scopeMascotSvgIds } from "./mascot-art";

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

  it("wraps each face's existing eyes in idle + blink groups without changing the art", () => {
    const eyeMarks = {
      peach: ['cx="100" cy="130" r="16"', 'cx="156" cy="130" r="16"'],
      teal: ['cx="102" cy="132" r="15.5"', 'cx="154" cy="132" r="15.5"'],
      lavender: ['cx="102" cy="140" r="15"', 'cx="154" cy="140" r="15"'],
      coral: ['cx="100" cy="130" r="16"', 'cx="156" cy="130" r="16"'],
    } as const;

    for (const style of Object.keys(eyeMarks) as Array<keyof typeof eyeMarks>) {
      const svg = mascotSvgMarkup(style, "red");
      const idle = svg.indexOf('class="mascot-idle"');
      const blink = svg.indexOf('class="mascot-blink"');
      expect(idle, `${style} missing mascot-idle`).toBeGreaterThan(-1);
      expect(blink, `${style} missing mascot-blink`).toBeGreaterThan(idle);
      for (const mark of eyeMarks[style]) {
        expect(svg.indexOf(mark), `${style} lost ${mark}`).toBeGreaterThan(blink);
      }
    }
  });

  it("ships two-dot simple shapes without blush, mouth, or limbs", () => {
    const simple = ["squircle", "circle", "pill"] as const;
    for (const name of simple) {
      const svg = readFileSync(join(assetsDir, `${name}.svg`), "utf8");
      expect(svg).toContain("<svg");
      expect(svg).toContain("{{BODY}}");
      expect(svg).toContain('class="mascot-idle"');
      expect(svg).toContain('class="mascot-blink"');
      expect(svg).not.toContain("#F4A0B4");
      expect(svg).not.toMatch(/stroke="#3A241C"/);
      expect(svg).not.toContain('id="antenna"');
      expect(svg).not.toContain('id="ear-left"');
      expect(svg).not.toContain('id="flop-left"');
      expect([...svg.matchAll(/fill="#1A1210"/g)]).toHaveLength(2);
      expect(svg).not.toContain('fill="#fff"');
      const painted = mascotSvgMarkup(name, "red");
      expect(painted).toContain("#D94B52");
      expect(painted).not.toContain("{{BODY}}");
    }
    expect(new Set(simple.map((name) => readFileSync(join(assetsDir, `${name}.svg`), "utf8"))).size).toBe(3);
  });

  it("keeps BODY_LIGHT/SHADOW distinct on clamped neutrals", () => {
    for (const color of ["white", "black", "gray"] as const) {
      const svg = mascotSvgMarkup("teal", color);
      const stops = [...svg.matchAll(/stop-color="(#[0-9A-Fa-f]{6})"/g)].map((match) => match[1]);
      expect(stops).toContain(MAUS_COLORS[color]);
      // BODY_LIGHT and SHADOW must still differ from BODY after the mix.
      expect(new Set(stops).size).toBeGreaterThanOrEqual(2);
    }
  });

  it("scopes gradient ids so two inlined mascots cannot collide", () => {
    const painted = mascotSvgMarkup("peach", "red");
    const a = scopeMascotSvgIds(painted, "a1");
    const b = scopeMascotSvgIds(painted, "b2");
    expect(a).toContain('id="a1-peach-body"');
    expect(a).toContain("url(#a1-peach-body)");
    expect(a).not.toContain('id="peach-body"');
    expect(new Set([a, b]).size).toBe(2);
    expect(a).not.toContain("b2-peach-body");
    expect(b).not.toContain("a1-peach-body");
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
    'case "white", "black", "gray": return .peach',
    "default: return .peach",
  ];

  it("keeps CuteMascotStyle.resolved and CompanionCore.MascotStyle.resolved on the same map", () => {
    for (const line of cases) {
      expect(cute, `MausAvatar.swift missing ${line}`).toContain(line);
      expect(core, `Models.swift missing ${line}`).toContain(line);
    }
  });

  it("keeps iOS style ids in lockstep with the desktop pack", () => {
    const casesLine = "case peach, teal, lavender, coral, squircle, circle, pill";
    expect(cute).toContain(casesLine);
    expect(core).toContain(casesLine);
    for (const style of MASCOT_STYLES) {
      expect(cute).toContain(`case .${style}:`);
    }
  });
});
