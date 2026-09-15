import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const app = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "App.tsx"), "utf8");

describe("settings section shortcuts", () => {
  it("opens Themes and Usage with Alt+T and Alt+U by physical key", () => {
    expect(app).toContain("e.altKey && !mod && !e.shiftKey");
    expect(app).toContain('e.code === "KeyT"');
    expect(app).toContain('e.code === "KeyU"');
    expect(app).toContain('section: "themes"');
    expect(app).toContain('section: "usage"');
    expect(app).toContain("toggleAppSettings");
  });

  it("does not bind those jumps to Ctrl/Cmd", () => {
    const handler = app.slice(app.indexOf("const onKey = (e: KeyboardEvent)"), app.indexOf("window.addEventListener(\"keydown\", onKey)"));
    expect(handler).toMatch(/e\.code === "KeyT"/);
    expect(handler).toMatch(/e\.altKey && !mod/);
    expect(handler).not.toMatch(/mod && e\.key === "t"/);
  });
});

describe("bot switch shortcuts", () => {
  it("matches Ctrl/Cmd+Shift brackets by e.code so Shift does not rewrite the key", () => {
    expect(app).toContain("const mod = e.metaKey || e.ctrlKey");
    expect(app).toContain('e.shiftKey && (e.code === "BracketLeft" || e.code === "BracketRight")');
    expect(app).toContain('(e.code === "BracketRight" ? 1 : -1)');
    expect(app).not.toContain('e.key === "["');
    expect(app).not.toContain('e.key === "]"');
  });
});
