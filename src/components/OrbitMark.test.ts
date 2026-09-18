import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { OrbitMark } from "./OrbitMark";

const html = renderToStaticMarkup(createElement(OrbitMark, { size: 96 }));
const lower = html.toLowerCase();

describe("OrbitMark", () => {
  it("renders the Peach Warm artwork", () => {
    expect(html).toContain("<svg");
    expect(lower).toContain("#2b1d1a");
    expect(lower).toContain("#ff9e64");
    expect(lower).toContain("#f8e8d0");
    expect(lower).toContain('aria-label="orbit"');
  });

  it("keeps the two-dot face with no mouth", () => {
    expect(lower.match(/<circle[^>]*fill="#2b1d1a"/g)?.length).toBe(2);
    expect(lower).not.toContain("smile");
  });

  it("drops the old spectrum-ring artwork", () => {
    expect(html).not.toContain("orbit-spectrum");
    expect(html).not.toContain("orbit-core");
    expect(lower).not.toContain("#1688ff");
    expect(lower).not.toContain("#f45aa8");
  });
});
