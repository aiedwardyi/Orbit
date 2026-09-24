import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { MuseMark, ProviderMark } from "./ProviderIcons";

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
