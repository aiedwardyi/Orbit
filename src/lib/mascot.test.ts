import { describe, expect, it } from "vitest";

import { DEFAULT_MAUS_COLOR, MAUS_COLORS, mausColorHex, stateForBot } from "./mascot";

describe("mascot color fallback", () => {
  it("treats red as the default mascot color", () => {
    expect(DEFAULT_MAUS_COLOR).toBe("red");
    expect(MAUS_COLORS[DEFAULT_MAUS_COLOR]).toBe("#D94B52");
  });

  it("maps known colors and unknown or missing names to the red hex", () => {
    expect(mausColorHex("green")).toBe("#009957");
    expect(mausColorHex("red")).toBe("#D94B52");
    expect(mausColorHex("not-a-color")).toBe("#D94B52");
    expect(mausColorHex(undefined)).toBe("#D94B52");
    expect(mausColorHex(null)).toBe("#D94B52");
  });

  it("does not treat inherited object keys as palette colors", () => {
    expect(mausColorHex("__proto__")).toBe("#D94B52");
    expect(mausColorHex("constructor")).toBe("#D94B52");
  });
});

describe("mascot attention after first-turn ignore", () => {
  it("looks curious while the first-turn quiz is still open", () => {
    expect(stateForBot({ name: "Nova", messages: [{ kind: "options", card: {} }] })).toBe("curious");
  });

  it("does not stay attentive after the first-turn quiz is ignored", () => {
    expect(
      stateForBot({
        name: "Nova",
        messages: [{ kind: "options", card: { dismissed: true } }],
      }),
    ).toBe("idle");
  });

  it("does not stay attentive after the first-turn quiz is answered", () => {
    expect(
      stateForBot({
        name: "Nova",
        messages: [{ kind: "options", card: { answered: "Work & projects" } }],
      }),
    ).toBe("idle");
  });

  it("looks curious while a live ask is still open", () => {
    expect(
      stateForBot({
        name: "Nova",
        messages: [{ kind: "options", card: { requestId: "r1" } }],
      }),
    ).toBe("curious");
  });

  it("does not stay curious after a live ask is resolved", () => {
    expect(
      stateForBot({
        name: "Nova",
        messages: [{ kind: "options", card: { requestId: "r1", answered: "allow" } }],
      }),
    ).toBe("idle");
    expect(
      stateForBot({
        name: "Nova",
        messages: [{ kind: "options", card: { requestId: "r1", dismissed: true } }],
      }),
    ).toBe("idle");
  });
});
