import { describe, expect, it } from "vitest";

import { botBrowserEnabled, browserPrompt } from "./builtin-browser.ts";

describe("built-in browser gate", () => {
  it("gives a bot no browser tools or prompt on a default config", () => {
    const mounted = botBrowserEnabled({}, {}, { browserMcp: true });
    expect(mounted).toBe(false);
    expect(browserPrompt(mounted)).toBe("");
  });

  it("stays off even when the workspace and the bot opt in", () => {
    const mounted = botBrowserEnabled({ features: { browser: true } }, { browser: true }, { browserMcp: true });
    expect(mounted).toBe(false);
    expect(browserPrompt(mounted)).toBe("");
  });
});
