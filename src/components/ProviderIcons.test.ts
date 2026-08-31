import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { ProviderMark } from "./ProviderIcons";

describe("ProviderMark", () => {
  it.each(["grok", "grokAgent"])("renders a neutral monogram for %s", (driverKind) => {
    const markup = renderToStaticMarkup(createElement(ProviderMark, { driverKind, size: 18 }));

    expect(markup).toContain(">G</span>");
    expect(markup).toContain("width:18px;height:18px;font-size:11px");
    expect(markup).not.toContain("<svg");
  });
});
