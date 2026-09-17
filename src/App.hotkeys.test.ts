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

describe("retired bot switch shortcuts", () => {
  it("keeps bot navigation out of the app-wide shortcut handler", () => {
    const handler = app.slice(app.indexOf("const onKey = (e: KeyboardEvent)"), app.indexOf("window.addEventListener(\"keydown\", onKey)"));
    expect(handler).not.toContain('type: "newBot"');
    expect(handler).not.toContain('type: "select"');
    expect(handler).not.toContain("BracketLeft");
    expect(handler).not.toContain("BracketRight");
  });
});

describe("terminal attention routing", () => {
  it("includes terminal attention in the taskbar count", () => {
    expect(app).toContain("unreadConversationCount(state.bots, state.groups) + terminalAttentionCount(state.terminalAttention)");
  });

  it("keys each attention event by PTY session without marking chat unread", () => {
    const start = app.indexOf("const offAttention");
    const end = app.indexOf("}, [dispatch, terminalOpen]);", start);
    const handler = app.slice(start, end);

    expect(handler).toContain("id: sessionId");
    expect(handler).toContain("terminalAttentionKey(botId, sessionId)");
    expect(handler).toContain('type: "markTerminalAttention"');
    expect(handler.indexOf('type: "markTerminalAttention"')).toBeLessThan(handler.indexOf("buildTerminalNotification"));
    expect(handler).not.toContain('type: "markUnread"');
  });

  it("carries the exact terminal session through notification clicks", () => {
    expect(app).toContain("buildTerminalNotification(bot, reason, sessionId)");
    expect(app).toContain("terminalAttentionForBot(latestState.current.terminalAttention, target.botId)");
    expect(app).toContain("openNotificationTarget(dispatch, target, current)");
    expect(app).toContain("if (!terminalOpen || !bot || !document.hasFocus()) return;");
    expect(app).toContain('window.addEventListener("focus", acknowledgeVisible)');
    expect(app).toContain('type: "ackTerminalAttention"');
  });

  it("keeps targeted acknowledgements scoped by bot while a notification click settles", () => {
    expect(app).toContain("useRef(new Map<string, Set<string>>())");
    expect(app).toContain("const targeted = pendingTerminalAcknowledgements.current.get(bot.id)");
    expect(app).toContain("if (targeted.size === 0) pendingTerminalAcknowledgements.current.delete(bot.id)");
  });
});
