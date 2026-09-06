import { describe, expect, expectTypeOf, it } from "vitest";

import { DEFAULT_MAUS_COLOR, MAUS_COLOR_NAMES, MAUS_COLORS, mausColorHex, stateForBot, type MausColor } from "./mascot";
import type { MausColor as ServerMausColor } from "../../server/store";

describe("mascot color fallback", () => {
  it("treats red as the default mascot color", () => {
    expect(DEFAULT_MAUS_COLOR).toBe("red");
    expect(MAUS_COLORS[DEFAULT_MAUS_COLOR]).toBe("#D94B52");
  });

  it("maps known colors and unknown or missing names to the red hex", () => {
    expect(mausColorHex("green")).toBe("#009957");
    expect(mausColorHex("red")).toBe("#D94B52");
    expect(mausColorHex("white")).toBe("#EFE6DA");
    expect(mausColorHex("black")).toBe("#2C2826");
    expect(mausColorHex("gray")).toBe("#5C5854");
    expect(mausColorHex("not-a-color")).toBe("#D94B52");
    expect(mausColorHex(undefined)).toBe("#D94B52");
    expect(mausColorHex(null)).toBe("#D94B52");
  });

  it("adds clamped neutrals without changing the original ten hexes", () => {
    expect(MAUS_COLOR_NAMES.slice(0, 10)).toEqual([
      "green",
      "blue",
      "red",
      "orange",
      "purple",
      "cyan",
      "pink",
      "yellow",
      "teal",
      "coral",
    ]);
    expect(MAUS_COLORS).toMatchObject({
      green: "#009957",
      blue: "#377FE6",
      red: "#D94B52",
      orange: "#E78531",
      purple: "#8057C8",
      cyan: "#0EA5C6",
      pink: "#D84F8B",
      yellow: "#D8A729",
      teal: "#01A492",
      coral: "#E5634E",
    });
    expect(MAUS_COLORS.white).not.toBe("#FFFFFF");
    expect(MAUS_COLORS.black).not.toBe("#000000");
  });

  it("does not treat inherited object keys as palette colors", () => {
    expect(mausColorHex("__proto__")).toBe("#D94B52");
    expect(mausColorHex("constructor")).toBe("#D94B52");
  });

  it("keeps client MAUS_COLOR_NAMES and server MausColor in exact agreement", () => {
    expectTypeOf<MausColor>().toEqualTypeOf<ServerMausColor>();
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
