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

  it("renders the Muse mark cropped to the glyph so the header chip has no excess side padding", () => {
    const markup = renderToStaticMarkup(createElement(MuseMark, { size: 14 }));
    expect(markup).toContain("<svg");
    expect(markup).toContain("viewBox=\"4 4 16 16\"");
    expect(markup).toContain("M4 20V4h3.2");
  });

  it("serves the cropped Muse mark for museAgent", () => {
    const markup = renderToStaticMarkup(createElement(ProviderMark, { driverKind: "museAgent", size: 14 }));
    expect(markup).toContain("viewBox=\"4 4 16 16\"");
  });
});
