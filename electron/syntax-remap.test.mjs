import { describe, expect, it } from "vitest";
import { parseCssRemaps, unmappedEmittedHexes } from "../scripts/check-skin-contrast.mjs";

describe("syntax remaps are keyed by skin id", () => {
  it("fails a light skin that has no remap selector", () => {
    const hex = "#ff7b72";
    const sample = [
      '[data-skin="atelier"] { --color-syntax-keyword: #8b1a24; }',
      '[data-skin="paper"] { --color-syntax-keyword: #8b1a24; }',
      ":is([data-skin=\"atelier\"]) .shiki span[style*=" +
        JSON.stringify(hex) +
        " i] { color: var(--color-syntax-keyword) !important; }",
    ].join("\n");
    expect(unmappedEmittedHexes(sample, "atelier", [hex])).toEqual([]);
    expect(unmappedEmittedHexes(sample, "paper", [hex])).toEqual([hex]);
    expect(parseCssRemaps(sample).get("paper")?.get(hex)).toBeUndefined();
  });
});
