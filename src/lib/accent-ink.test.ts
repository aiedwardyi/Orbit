import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// skins.test.ts checks the --color-accent-ink token itself; this checks that
// the buttons actually consume it, which is what a warm accent breaks.
const componentsDir = join(dirname(fileURLToPath(import.meta.url)), "../components");

/** Every quoted or backticked class-ish literal in a source file. Classes are
 * routinely non-adjacent inside one string, so the pairing has to be judged
 * per string, not per line - a ternary can put bg-accent and text-white on
 * one line yet in different branches. */
function classStrings(source: string): string[] {
  return [...source.matchAll(/"([^"\n]*)"|`([^`]*)`/g)].map((m) => m[1] ?? m[2] ?? "");
}

function hasAccentFill(value: string): boolean {
  return /(?:^|\s|:)bg-accent(?![\w/-])/.test(value);
}

/** Each cn() call's string arguments joined into one unit. A base string can
 * hold the foreground while a branch holds the fill, so the pairing is
 * invisible to any per-string or per-line check - that shape is how the
 * Composer send button hid. */
function classGroups(source: string): string[] {
  const groups: string[] = [];
  for (const match of source.matchAll(/\bcn\(/g)) {
    let depth = 0;
    let i = match.index! + match[0].length - 1;
    for (; i < source.length; i += 1) {
      if (source[i] === "(") depth += 1;
      else if (source[i] === ")") {
        depth -= 1;
        if (depth === 0) break;
      }
    }
    groups.push(classStrings(source.slice(match.index!, i + 1)).join(" "));
  }
  return groups;
}

function sourceFiles(): Array<{ name: string; source: string }> {
  return readdirSync(componentsDir)
    .filter((name) => name.endsWith(".tsx"))
    .map((name) => ({ name, source: readFileSync(join(componentsDir, name), "utf8") }));
}

describe("accent fills carry accent ink", () => {
  it("never pairs bg-accent with hardcoded white text", () => {
    const offenders = sourceFiles().flatMap(({ name, source }) =>
      classStrings(source)
        .filter((value) => hasAccentFill(value) && /(?:^|\s)text-white(?![\w-])/.test(value))
        .map((value) => `${name}: ${value.trim().slice(0, 80)}`),
    );
    expect(offenders).toEqual([]);
  });

  it("never leaves white on an accent fill split across one cn() call", () => {
    const offenders = sourceFiles().flatMap(({ name, source }) =>
      classGroups(source)
        .filter((value) => hasAccentFill(value) && /(?:^|\s)text-white(?![\w-])/.test(value))
        .map((value) => `${name}: ${value.trim().slice(0, 80)}`),
    );
    expect(offenders).toEqual([]);
  });

  it("scans the components it claims to scan", () => {
    const files = sourceFiles();
    expect(files.length).toBeGreaterThan(20);
    expect(files.some(({ source }) => classStrings(source).some(hasAccentFill))).toBe(true);
    expect(files.some(({ source }) => classGroups(source).some(hasAccentFill))).toBe(true);
  });
});
