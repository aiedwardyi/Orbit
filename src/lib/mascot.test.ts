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
  const quiz = {
    kind: "options" as const,
    card: {
      title: "What do you mostly want help with?",
      options: ["Work & projects"],
    },
  };

  it("looks curious while the first-turn quiz is still open", () => {
    expect(stateForBot({ name: "Nova", messages: [quiz] })).toBe("curious");
  });

  it("does not stay attentive after the first-turn quiz is ignored", () => {
    expect(
      stateForBot({
        name: "Nova",
        messages: [{ ...quiz, card: { ...quiz.card, dismissed: true } }],
      }),
    ).toBe("idle");
  });
});
