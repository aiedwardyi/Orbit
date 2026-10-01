import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { OrbitMark } from "./OrbitMark";

const html = renderToStaticMarkup(createElement(OrbitMark, { size: 96 }));
const lower = html.toLowerCase();

describe("OrbitMark", () => {
  it("renders the Wink prompt artwork", () => {
    expect(html).toContain("<svg");
    expect(lower).toContain("#1f2747");
    expect(lower).toContain("#0a0e19");
    expect(lower).toContain("#ff4d9d");
    expect(lower).toContain("#ffd447");
    expect(lower).toContain('aria-label="wink"');
    expect(lower).toContain('d="m72 86 l122 128 l72 170"');
  });

  it("gives each instance its own gradient and filter ids", () => {
    const pair = renderToStaticMarkup(
      createElement("div", null, createElement(OrbitMark), createElement(OrbitMark)),
    );
    const ids = [...pair.matchAll(/ id="([^"]+)"/g)].map((match) => match[1]);
    expect(ids.length).toBe(8);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("drops the Peach Warm face artwork", () => {
    expect(lower).not.toContain("#2b1d1a");
    expect(lower).not.toContain("#ff9e64");
    expect(lower).not.toContain("#f8e8d0");
    expect(lower).not.toContain("<ellipse");
  });
});
