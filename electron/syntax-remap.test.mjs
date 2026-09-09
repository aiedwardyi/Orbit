import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const here = dirname(fileURLToPath(import.meta.url));

function parseCssRemaps(source) {
  const bySkin = new Map();
  const rule = /([^{}]+)\{[^{}]*color:\s*var\((--color-syntax-[\w-]+)\)/gi;
  const skinRe = /\[data-skin="([a-z0-9-]+)"\]/gi;
  const hexRe = new RegExp("\\[style\\*=\"#([0-9a-fA-F]{6})\"", "gi");
  for (const [, selectors, token] of source.matchAll(rule)) {
    const skins = [...selectors.matchAll(skinRe)].map((m) => m[1]);
    const hexes = [...selectors.matchAll(hexRe)].map((m) => `#${m[1].toLowerCase()}`);
    for (const id of skins) {
      if (!bySkin.has(id)) bySkin.set(id, new Map());
      const map = bySkin.get(id);
      for (const hex of hexes) map.set(hex, token);
    }
  }
  return bySkin;
}

function unmappedEmittedHexes(cssSource, skinId, hexes) {
  const remaps = parseCssRemaps(cssSource);
  const skinRemaps = remaps.get(skinId) ?? new Map();
  return hexes.filter((hex) => !skinRemaps.has(hex));
}

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

  it("keys production remaps by skin id", () => {
    const check = readFileSync(join(here, "../scripts/check-skin-contrast.mjs"), "utf8");
    expect(check).toContain("bySkin");
    expect(check).toContain("remaps.get(id)");
  });
});
