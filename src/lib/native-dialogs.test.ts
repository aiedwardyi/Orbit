import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";

it("keeps native dialogs out of production renderer sources", () => {
  const src = join(dirname(fileURLToPath(import.meta.url)), "..");
  const violations = readdirSync(src, { recursive: true, encoding: "utf8" })
    .filter((name) => /\.[cm]?[jt]sx?$/.test(name) && !/\.(?:test|spec)(?:[.-]|\.)/.test(name))
    .filter((name) => /\bwindow\s*\.\s*(?:confirm|alert|prompt)\b/.test(readFileSync(join(src, name), "utf8")));
  expect(violations).toEqual([]);
});
