import { describe, expect, it } from "vitest";

import { builtInBrowserEnabled, showToolCallsEnabled, skillRecorderEnabled } from "./feature-flags";

describe("experimental feature flags", () => {
  it("keeps Teach a skill hidden by default", () => {
    expect(skillRecorderEnabled(null)).toBe(false);
    expect(skillRecorderEnabled({})).toBe(false);
    expect(skillRecorderEnabled({ features: { skillRecorder: false } })).toBe(false);
  });

  it("shows Teach a skill only after explicit opt-in", () => {
    expect(skillRecorderEnabled({ features: { skillRecorder: true } })).toBe(true);
  });

  it("hides tool-call chips by default", () => {
    expect(showToolCallsEnabled(null)).toBe(false);
    expect(showToolCallsEnabled({})).toBe(false);
    expect(showToolCallsEnabled({ features: { showToolCalls: false } })).toBe(false);
    expect(showToolCallsEnabled({ features: {} })).toBe(false);
  });

  it("shows tool-call chips only after explicit opt-in", () => {
    expect(showToolCallsEnabled({ features: { showToolCalls: true } })).toBe(true);
  });

  it("keeps the built-in browser on unless it is switched off", () => {
    expect(builtInBrowserEnabled(null)).toBe(true);
    expect(builtInBrowserEnabled({})).toBe(true);
    expect(builtInBrowserEnabled({ features: {} })).toBe(true);
    expect(builtInBrowserEnabled({ features: { browser: false } })).toBe(false);
    expect(builtInBrowserEnabled({ features: { browser: true } })).toBe(true);
  });
});
