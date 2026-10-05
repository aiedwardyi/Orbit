import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { altDigitSelectsPane, backquoteTogglesTerminal } from "./terminal-hotkeys";

const app = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "..", "App.tsx"), "utf8");

describe("web terminal toggle", () => {
  it("opens in a window with no preload and still requires the desktop preload at home", () => {
    expect(backquoteTogglesTerminal(false, false)).toBe(true);
    expect(backquoteTogglesTerminal(true, true)).toBe(true);
    expect(backquoteTogglesTerminal(true, false)).toBe(false);
  });

  it("keeps the chat, bot, group and overlay guards on the same toggle", () => {
    expect(app).toContain(
      'if (!backquoteTogglesTerminal(Boolean(window.ogb), Boolean(window.ogb?.terminal)) || !bot || group || state.activeView !== "chat" || nativeViewOverlayOpen || browserWorkspaceBotId || localVmWorkspaceBotId) return;',
    );
    expect(app).toContain("if (terminalOpen) closeTerminal();");
    expect(app).toContain("else openTerminal();");
  });
});

describe("web Alt+digit pane pick", () => {
  it("picks a remote pane only when this window has no preload", () => {
    expect(altDigitSelectsPane(false, true)).toBe(true);
    expect(altDigitSelectsPane(true, false)).toBe(true);
    expect(altDigitSelectsPane(false, false)).toBe(false);
  });

  it("keeps Alt+digit on panes and Ctrl+digit on bots", () => {
    const handler = app.slice(app.indexOf("const onKey = (e: KeyboardEvent)"), app.indexOf('window.addEventListener("keydown", onKey, true)'));
    expect(handler).toContain("if (n !== null && e.altKey && terminalOpen && altDigitSelectsPane(Boolean(window.ogb?.terminal), !window.ogb))");
    expect(handler).not.toMatch(/e\.ctrlKey && terminalOpen/);
    expect(handler).toContain('type: "select", id');
  });
});
