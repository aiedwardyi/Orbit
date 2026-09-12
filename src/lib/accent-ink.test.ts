import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// skins.test.ts checks the --color-accent-ink token itself; this checks that
// the buttons actually consume it, which is what a warm accent breaks.
const componentsDir = join(dirname(fileURLToPath(import.meta.url)), "../components");

const WHITE = /(?:^|\s)text-white(?![\w-])/;

interface Hit {
  value: string;
  index: number;
}

/** Every quoted or backticked class-ish literal in a source file. Classes are
 * routinely non-adjacent inside one string, so the pairing has to be judged
 * per string, not per line - a ternary can put bg-accent and text-white on
 * one line yet in different branches. */
function classStrings(source: string, offset = 0): Hit[] {
  return [...source.matchAll(/"([^"\n]*)"|`([^`]*)`/g)].map((m) => ({
    value: m[1] ?? m[2] ?? "",
    index: offset + m.index,
  }));
}

function hasAccentFill(value: string): boolean {
  return /(?:^|\s|:)bg-accent(?![\w/-])/.test(value);
}

/** Each cn() call's string arguments joined into one unit. A base string can
 * hold the foreground while a branch holds the fill, so the pairing is
 * invisible to any per-string or per-line check - that shape is how the
 * Composer send button hid. */
function classGroups(source: string): Hit[] {
  const groups: Hit[] = [];
  for (const match of source.matchAll(/\bcn\(/g)) {
    let depth = 0;
    let i = match.index + match[0].length - 1;
    for (; i < source.length; i += 1) {
      if (source[i] === "(") depth += 1;
      else if (source[i] === ")") {
        depth -= 1;
        if (depth === 0) break;
      }
    }
    const slice = source.slice(match.index, i + 1);
    groups.push({ value: classStrings(slice).map((hit) => hit.value).join(" "), index: match.index });
  }
  return groups;
}

/** Recursive on purpose: this guard is only worth having if it covers the
 * whole tree, and a non-recursive read would silently stop covering any
 * subdirectory someone adds later. */
function sourceFiles(): Array<{ name: string; source: string }> {
  return readdirSync(componentsDir, { recursive: true, encoding: "utf8" })
    .filter((name) => name.endsWith(".tsx"))
    .map((name) => ({ name, source: readFileSync(join(componentsDir, name), "utf8") }));
}

function lineOf(source: string, index: number): number {
  return source.slice(0, index).split("\n").length;
}

function offenders(pick: (source: string) => Hit[]): string[] {
  return sourceFiles().flatMap(({ name, source }) =>
    pick(source)
      .filter((hit) => hasAccentFill(hit.value) && WHITE.test(hit.value))
      .map((hit) => `${name}:${lineOf(source, hit.index)} - ${hit.value.trim().slice(0, 80)}`),
  );
}

describe("accent fills carry accent ink", () => {
  it("never pairs bg-accent with hardcoded white text", () => {
    expect(offenders((source) => classStrings(source))).toEqual([]);
  });

  it("never leaves white on an accent fill split across one cn() call", () => {
    expect(offenders(classGroups)).toEqual([]);
  });

  it("scans the components it claims to scan, subdirectories included", () => {
    const files = sourceFiles();
    expect(files.length).toBeGreaterThan(20);
    expect(files.some(({ source }) => classStrings(source).some((hit) => hasAccentFill(hit.value)))).toBe(true);
    expect(files.some(({ source }) => classGroups(source).some((hit) => hasAccentFill(hit.value)))).toBe(true);
    // the tree is flat today, so this only proves the walk reaches everything
    // that exists — the recursive read is what keeps that true as it grows
    expect(files.length).toBe(readdirSync(componentsDir).filter((name) => name.endsWith(".tsx")).length);
  });
});
