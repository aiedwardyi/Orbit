import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { ClaudeMark, MuseMark, ProviderMark } from "./ProviderIcons";

describe("ProviderMark", () => {
  it.each(["grok", "grokAgent"])("renders the Grok mark as an SVG for %s", (driverKind) => {
    const markup = renderToStaticMarkup(createElement(ProviderMark, { driverKind, size: 18 }));

    expect(markup).toContain("<svg");
    expect(markup).toContain("viewBox=\"0 0 24 24\"");
    expect(markup).toContain("M9.27 15.29");
    expect(markup).not.toContain(">G</span>");
  });

  it("renders the Muse mark with a thin margin so it sits level with the other marks", () => {
    const markup = renderToStaticMarkup(createElement(MuseMark, { size: 14 }));
    expect(markup).toContain("<svg");
    expect(markup).toContain("viewBox=\"2.5 2.5 19 19\"");
    expect(markup).toContain("M4 20V4h3.2");
  });

  it("serves the padded Muse mark for museAgent", () => {
    const markup = renderToStaticMarkup(createElement(ProviderMark, { driverKind: "museAgent", size: 14 }));
    expect(markup).toContain("viewBox=\"2.5 2.5 19 19\"");
  });

  it.each([
    "grok",
    "grokAgent",
    "claudeAgent",
    "codex",
    "geminiAgent",
    "antigravityAgent",
    "museAgent",
    "kimiAgent",
    "droidAgent",
    "cursorAgent",
    "qwenAgent",
    "hermesAgent",
    "boxAgent",
    "piAgent",
  ])("pins the %s mark to its size so row overflow cannot squish it", (driverKind) => {
    const markup = renderToStaticMarkup(createElement(ProviderMark, { driverKind, size: 14 }));
    expect(markup).toContain("<svg");
    expect(markup).toContain('width="14"');
    expect(markup).toContain('height="14"');
    expect(markup).toContain("shrink-0");
    // Decorative beside a visible label: hidden from assistive technology.
    expect(markup).toContain("aria-hidden");
  });
});

describe("ClaudeMark", () => {
  const rects = (markup: string) =>
    [...markup.matchAll(/<rect x="(\d+)" y="(\d+)" width="(\d+)" height="(\d+)"/g)].map((m) => m.slice(1).map(Number));

  it("draws the claude bot as crisp pixel rects in the claude orange, not the starburst", () => {
    const markup = renderToStaticMarkup(createElement(ProviderMark, { driverKind: "claudeAgent", size: 16 }));
    expect(markup).toContain('shape-rendering="crispEdges"');
    expect(markup).toContain("fill-[#d97757]");
    expect(markup).not.toContain("<path");
    expect(rects(markup)).toEqual([
      [3, 0, 13, 2],
      [3, 2, 2, 2],
      [6, 2, 7, 2],
      [14, 2, 2, 2],
      [1, 4, 17, 2],
      [3, 6, 13, 2],
      [3, 8, 1, 2],
      [5, 8, 1, 2],
      [13, 8, 1, 2],
      [15, 8, 1, 2],
    ]);
  });

  const viewBox = (size: number) =>
    renderToStaticMarkup(createElement(ClaudeMark, { size })).match(/viewBox="(\S+) (\S+) (\S+) (\S+)"/)!.slice(1).map(Number);

  it.each([14, 16, 17])("keeps one css px per bot column at %i px so the eyes and legs survive at ratio 1", (size) => {
    const markup = renderToStaticMarkup(createElement(ClaudeMark, { size }));
    expect(markup).toContain("overflow-visible");
    expect(viewBox(size)[2]).toBe(size);
  });

  it.each([24, 32])("scales the bot from the exact center at %i px", (size) => {
    const [x, y, w, h] = viewBox(size);
    expect(w).toBe(17);
    expect(h).toBe(17);
    expect(x + w / 2).toBe(9.5);
    expect(y + h / 2).toBe(5);
  });
});
