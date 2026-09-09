import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { ProviderMark } from "./ProviderIcons";

describe("ProviderMark", () => {
  it.each(["grok", "grokAgent"])("renders the Grok mark as an SVG for %s", (driverKind) => {
    const markup = renderToStaticMarkup(createElement(ProviderMark, { driverKind, size: 18 }));

    expect(markup).toContain("<svg");
    expect(markup).toContain("viewBox=\"0 0 24 24\"");
    expect(markup).toContain("M9.27 15.29");
    expect(markup).not.toContain(">G</span>");
  });
});
