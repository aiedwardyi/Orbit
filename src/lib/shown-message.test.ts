import { describe, expect, it } from "vitest";

import { isShownMessage } from "./shown-message";

describe("isShownMessage", () => {
  it("hides a quiet wake while leaving user dots alone", () => {
    expect(isShownMessage({ role: "bot", hidden: true })).toBe(false);
    expect(isShownMessage({ role: "bot", hidden: false })).toBe(true);
    expect(isShownMessage({ role: "user", hidden: true })).toBe(true);
  });

  it("hides only a bot's engine-summarized note", () => {
    expect(isShownMessage({ role: "bot", summarized: true })).toBe(false);
    expect(isShownMessage({ role: "bot" })).toBe(true);
    expect(isShownMessage({ role: "bot", summarized: false })).toBe(true);
    expect(isShownMessage({ role: "user", summarized: true })).toBe(true);
  });
});
