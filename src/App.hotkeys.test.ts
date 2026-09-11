import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const app = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "App.tsx"), "utf8");

describe("bot switch shortcuts", () => {
  it("matches Ctrl/Cmd+Shift brackets by e.code so Shift does not rewrite the key", () => {
    expect(app).toContain("const mod = e.metaKey || e.ctrlKey");
    expect(app).toContain('e.shiftKey && (e.code === "BracketLeft" || e.code === "BracketRight")');
    expect(app).toContain('(e.code === "BracketRight" ? 1 : -1)');
    expect(app).not.toContain('e.key === "["');
    expect(app).not.toContain('e.key === "]"');
  });
});
