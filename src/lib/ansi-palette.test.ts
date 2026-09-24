import { describe, expect, it } from "vitest";
import { ANSI_PALETTE, ansiColor } from "./ansi-palette";

describe("ansi palette", () => {
  it("builds the 256-color table", () => {
    expect(ANSI_PALETTE).toHaveLength(256);
    expect(ANSI_PALETTE[2]).toBe("#4e9a06");
    expect(ANSI_PALETTE[16]).toBe("#000000");
    expect(ANSI_PALETTE[208]).toBe("#ff8700");
    expect(ANSI_PALETTE[231]).toBe("#ffffff");
    expect(ANSI_PALETTE[232]).toBe("#080808");
    expect(ANSI_PALETTE[255]).toBe("#eeeeee");
  });

  it("passes truecolor through and leaves unset colors unset", () => {
    expect(ansiColor(1)).toBe("#cc0000");
    expect(ansiColor("#010203")).toBe("#010203");
    expect(ansiColor(undefined)).toBeUndefined();
  });
});
