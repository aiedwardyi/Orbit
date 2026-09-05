import { describe, expect, it } from "vitest";

import { buildConnectingPage, isPackagedAppUrl } from "./boot-page.mjs";

describe("packaged connecting page", () => {
  it("is a data URL that paints the skin color and connecting copy", () => {
    const href = buildConnectingPage({
      locale: "en",
      fontStack: "system-ui,sans-serif",
      backgroundColor: "#0a0a0b",
      message: "Connecting to the bot server…",
    });
    expect(href.startsWith("data:text/html;charset=utf-8,")).toBe(true);
    const html = decodeURIComponent(href.slice("data:text/html;charset=utf-8,".length));
    expect(html).toContain('lang="en"');
    expect(html).toContain("#0a0a0b");
    expect(html).toContain("Connecting to the bot server…");
    expect(html).toContain("system-ui,sans-serif");
    expect(html).not.toContain("Couldn't start");
  });
});

describe("isPackagedAppUrl", () => {
  it("accepts only the loopback harness origin for this boot's port", () => {
    expect(isPackagedAppUrl("http://127.0.0.1:8799/", 8799)).toBe(true);
    expect(isPackagedAppUrl("http://127.0.0.1:8799", 8799)).toBe(true);
    expect(isPackagedAppUrl("http://127.0.0.1:18799/", 8799)).toBe(false);
    expect(isPackagedAppUrl("data:text/html,boot", 8799)).toBe(false);
    expect(isPackagedAppUrl("http://localhost:8799/", 8799)).toBe(false);
  });
});
