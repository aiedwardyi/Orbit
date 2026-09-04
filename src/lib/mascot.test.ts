import { describe, expect, it } from "vitest";

import { DEFAULT_MAUS_COLOR, MAUS_COLORS, mausColorHex } from "./mascot";

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
});
