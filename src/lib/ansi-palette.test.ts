import { describe, expect, it } from "vitest";
import { ANSI_PALETTE, ansiColor, ensureContrast, paintRun, runPaint } from "./ansi-palette";
import { contrast, terminalAnsiPalette } from "./terminal-appearance";

const winkDay = {
  inset: "#f0eef6", ink: "#1f2747", "ink-secondary": "#545b7c", accent: "#c81e69", "accent-text": "#b3195d", danger: "#b3261e", success: "#1d7048", warning: "#8a5800",
  "syntax-keyword": "#a3134f", "syntax-string": "#1a4c96", "syntax-function": "#6a2bb0", "syntax-constant": "#0a5590", "syntax-variable": "#7a4300", "syntax-tag": "#17653a",
};
const wink = { inset: "#080b15", ink: "#eef0f8", "ink-secondary": "#a8b0d0", "accent-text": "#ff7ab5" };
const reader = (tokens: Record<string, string>) => (name: string) => tokens[name] ?? "";
const ratio = (a: string | undefined, b: string) => contrast(a ?? "", b) ?? 0;

// Truecolor grays and yellows an engine CLI prints for a dark terminal.
const fixtures: TerminalRun[] = [
  { t: "gray", fg: "#999999" },
  { t: "dimgray", fg: "#999999", d: 1 },
  { t: "yellow", fg: "#ffe14a" },
  { t: "green", fg: "#5fb30a" },
  { t: "pink", fg: "#ff6b8a" },
  { t: "lavender", fg: "#e6e0ff" },
  ...Array.from({ length: 16 }, (_, i): TerminalRun => ({ t: `ansi${i}`, fg: i })),
  ...Array.from({ length: 16 }, (_, i): TerminalRun => ({ t: `dimansi${i}`, fg: i, d: 1 })),
  { t: "cube", fg: 226 },
  { t: "ramp", fg: 250, d: 1 },
  { t: "inverse", fg: 0, bg: 7 },
  { t: "bgonly", bg: "#2e3a5c" },
  { t: "dimbg", fg: "#cccccc", bg: "#334466", d: 1 },
  { t: "plain" },
];
const skins = { "wink-day": winkDay, wink };

describe("ansi palette", () => {
  it("builds the 256-color table", () => {
    expect(ANSI_PALETTE).toHaveLength(256);
    expect(ANSI_PALETTE[2]).toBe("#4e9a06");
    expect(ANSI_PALETTE[16]).toBe("#000000");
    expect(ANSI_PALETTE[208]).toBe("#ff8700");
    expect(ANSI_PALETTE[231]).toBe("#ffffff");
    expect(ANSI_PALETTE[232]).toBe("#080808");
    expect(ANSI_PALETTE[255]).toBe("#eeeeee");
  });

  it("passes truecolor through and leaves unset colors unset", () => {
    expect(ansiColor(1)).toBe("#cc0000");
    expect(ansiColor("#010203")).toBe("#010203");
    expect(ansiColor(undefined)).toBeUndefined();
  });

  it("takes ANSI 0-15 from the desktop palette on a light background only", () => {
    const light = runPaint(reader(winkDay));
    expect(light.palette.slice(0, 16)).toEqual(Object.values(terminalAnsiPalette(reader(winkDay))));
    expect(light.palette[1]).toBe(winkDay["syntax-keyword"]);
    expect(light.palette[15]).toBe(winkDay.ink);
    expect(light.palette.slice(16)).toEqual(ANSI_PALETTE.slice(16));
    expect(runPaint(reader(wink)).palette).toEqual(ANSI_PALETTE);
    expect(runPaint(() => "").palette).toEqual(ANSI_PALETTE);
  });
});

describe("run contrast floor", () => {
  it("lifts every fixture run to 4.5:1, or 3:1 when dim, on light and dark skins", () => {
    for (const [id, tokens] of Object.entries(skins)) {
      const paint = runPaint(reader(tokens));
      for (const run of fixtures) {
        const painted = paintRun(run, paint);
        const ground = painted.backgroundColor ?? tokens.inset;
        const color = painted.color ?? tokens.ink;
        expect(ratio(color, ground), `${id} ${run.t}`).toBeGreaterThanOrEqual(run.d ? 3 : 4.5);
      }
    }
  });

  it("keeps dim visibly closer to the background than the same color undimmed", () => {
    for (const [id, tokens] of Object.entries(skins)) {
      const paint = runPaint(reader(tokens));
      for (const run of fixtures.filter((r) => r.d)) {
        const dim = paintRun(run, paint);
        const full = paintRun({ ...run, d: undefined }, paint);
        expect(ratio(dim.color, dim.backgroundColor ?? tokens.inset), `${id} ${run.t}`).toBeLessThan(ratio(full.color, full.backgroundColor ?? tokens.inset));
      }
    }
  });

  it("leaves a passing color exactly as given", () => {
    const paint = runPaint(reader(winkDay));
    expect(paintRun({ t: "x", fg: "#1F2747" }, paint).color).toBe("#1F2747");
    expect(paintRun({ t: "x", fg: 232 }, paint).color).toBe("#080808");
    expect(paintRun({ t: "x" }, paint)).toEqual({ color: undefined, backgroundColor: undefined });
    expect(ensureContrast("#1F2747", "#f0eef6", 4.5)).toBe("#1F2747");
  });

  it("darkens a faint yellow on paper and keeps its hue family", () => {
    const [r, g, b] = ensureContrast("#ffe14a", "#f0eef6", 4.5).slice(1).match(/../g)!.map((v) => Number.parseInt(v, 16));
    expect(r).toBeGreaterThanOrEqual(g);
    expect(g).toBeGreaterThan(b);
  });

  it("paints inverse and bg-only runs readable against their own bg", () => {
    const paint = runPaint(reader(winkDay));
    const inverse = paintRun({ t: "x", fg: 0, bg: 7 }, paint);
    expect(inverse.backgroundColor).toBe(paint.palette[7]);
    expect(ratio(inverse.color, inverse.backgroundColor!)).toBeGreaterThanOrEqual(4.5);
    const bgOnly = paintRun({ t: "x", bg: "#2e3a5c" }, paint);
    expect(bgOnly.color).toBeDefined();
    expect(ratio(bgOnly.color, "#2e3a5c")).toBeGreaterThanOrEqual(4.5);
  });

  it("reads the shortened hex a built stylesheet serves", () => {
    const paint = runPaint(reader({ inset: "#000", ink: "#ccc" }));
    expect(paint).toMatchObject({ background: "#000000", ink: "#cccccc" });
    expect(ratio(paintRun({ t: "x", fg: "#333333" }, paint).color, "#000000")).toBeGreaterThanOrEqual(4.5);
    expect(runPaint(reader({ ...winkDay, inset: "#fff" })).palette.slice(0, 16)).toEqual(runPaint(reader({ ...winkDay, inset: "#ffffff" })).palette.slice(0, 16));
  });

  it("caches per paint and starts over when the skin changes", () => {
    const paint = runPaint(reader(winkDay));
    const run = { t: "x", fg: "#999999", d: 1 } as const;
    expect(paintRun(run, paint)).toBe(paintRun({ ...run, t: "y" }, paint));
    expect(paint.cache.size).toBe(1);
    expect(paintRun(run, runPaint(reader(wink)))).not.toEqual(paintRun(run, paint));
  });

  it("falls back to the best extreme when neither direction reaches the ratio", () => {
    expect(ensureContrast("#808080", "#777777", 7)).toBe("#000000");
    expect(ensureContrast("rgb(1,2,3)", "#ffffff", 4.5)).toBe("rgb(1,2,3)");
    expect(ensureContrast("#999999", "", 4.5)).toBe("#999999");
  });
});
