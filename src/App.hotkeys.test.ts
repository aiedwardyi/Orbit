// @vitest-environment happy-dom
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { describe, expect, it, vi } from "vitest";
import App from "./App";
import {
  DRAWER_BUTTON_LEFT,
  DRAWER_BUTTON_RIGHT,
  DRAWER_HEADER_LEFT,
  DRAWER_HEADER_RIGHT,
} from "@/lib/drawer-button";
import { LIGHT_SKIN_IDS, SKINS, SKIN_IDS, nextSkin, type SkinId } from "@/lib/skins";
import { SNAPSHOT_CACHE_KEY } from "@/state/snapshot-cache";

const app = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "App.tsx"), "utf8");
/** Every page whose header keeps the drawer button's corner clear. */
const HEADERS = [
  "ChatView.tsx",
  "GroupView.tsx",
  "RemoteTerminalView.tsx",
  "RoutinesPage.tsx",
  "TeamMapPage.tsx",
  "TerminalWorkspace.tsx",
];

const MENU_LABEL = 'aria-label={menuQuestion ? t("ask.openBotList") : menuRoutine ? t("routine.openBotList") : t("chrome.openBotList")}';
const menuButtonSource = () => app.slice(app.indexOf(MENU_LABEL), app.indexOf("</button>", app.indexOf(MENU_LABEL)));

describe("phone drawer menu button", () => {
  it("sits top-right when the sidebar side is right, top-left otherwise", () => {
    const button = menuButtonSource();
    expect(button).toContain("sidebarOnRight ? DRAWER_BUTTON_RIGHT : DRAWER_BUTTON_LEFT");
    expect(button).toContain("md:hidden");
    expect(button).toContain("data-phone-menu");
    // Both sides share one inset and one top, so neither can drift from the header row.
    expect(DRAWER_BUTTON_LEFT).toBe(DRAWER_BUTTON_RIGHT.replace("right-3.5", "left-3.5"));
    expect(DRAWER_BUTTON_LEFT).toContain("top-[15px]");
  });

  it("centers on the same leading row every page header reserves", () => {
    expect(DRAWER_HEADER_LEFT).toBe(DRAWER_HEADER_RIGHT.replace("pr-11", "pl-11"));
    // 30px button centered on the row: 15 + 15 + 30 = 60.
    expect(DRAWER_HEADER_LEFT).toContain("max-md:min-h-[60px]");
    for (const header of HEADERS) {
      const source = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "components", header), "utf8");
      expect(source, header).toContain("sidebarOnRight ? DRAWER_HEADER_RIGHT : DRAWER_HEADER_LEFT");
    }
  });

  it("badges other unread chats, excluding the open one", () => {
    const button = menuButtonSource();
    expect(button).toContain("data-menu-unread");
    expect(button).toContain("{menuUnreadBadge}");
    expect(app).toContain("collapsedUnreadCount(state.bots, state.groups, state.selectedId)");
  });

  it("glows while another chat has a question or an open approval", () => {
    expect(menuButtonSource()).toContain('${menuAsking ? " needs-you-glow" : ""}');
    expect(app).toContain("anyChatNeedsYou(menuChats, menuExceptId)");
    expect(app).toContain("anyRoutineRinging(state.routineRuns, menuChats, menuExceptId)");
  });

  it("closes when App settings opens from the drawer and stays closed after", async () => {
    localStorage.setItem("omb-onboarding-done", "true");
    localStorage.setItem(SNAPSHOT_CACHE_KEY, JSON.stringify({
      bots: [{ id: "b1", threadId: "t1", name: "Scout", messages: [], modelSelection: { instanceId: "inst", model: "m" } }],
      groups: [],
      selectedId: "b1",
    }));
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    vi.stubGlobal("fetch", vi.fn(() => new Promise<Response>(() => {})));
    vi.stubGlobal("EventSource", class { onmessage = null; close = vi.fn(); });
    const host = document.body.appendChild(document.createElement("div"));
    const root = createRoot(host);
    try {
      await act(async () => root.render(createElement(App)));
      const menu = host.querySelector<HTMLButtonElement>('button[aria-label="Open bot list"]')!;
      const appSettings = host.querySelector<HTMLButtonElement>('[data-sidebar-profile-row] button[aria-label="App settings"]')!;
      await act(async () => menu.click());
      expect(menu.getAttribute("aria-expanded")).toBe("true");
      await act(async () => appSettings.click());
      expect(menu.getAttribute("aria-expanded")).toBe("false");
      await act(async () => appSettings.click());
      expect(menu.getAttribute("aria-expanded")).toBe("false");
    } finally {
      await act(async () => root.unmount());
      host.remove();
      vi.unstubAllGlobals();
      localStorage.clear();
    }
  });
});

describe("settings section shortcuts", () => {
  it("opens Themes and Usage with Alt+T and Alt+U by physical key", () => {
    expect(app).toContain("e.altKey && !mod && !e.shiftKey");
    expect(app).toContain('e.code === "KeyT"');
    expect(app).toContain('e.code === "KeyU"');
    expect(app).toContain('section: "themes"');
    expect(app).toContain('section: "usage"');
    expect(app).toContain("toggleAppSettings");
  });

  it("opens Model index with Alt+I only", () => {
    expect(app).toContain('e.altKey && !mod && !e.shiftKey && e.code === "KeyI"');
    expect(app).not.toContain('e.code === "KeyM"');
    expect(app).toContain('section: "models-index"');
    const block = app.slice(app.indexOf('e.code === "KeyI"'), app.indexOf('section: "models-index"'));
    expect(block).toContain("e.stopPropagation()");
  });

  it("does not bind those jumps to Ctrl/Cmd", () => {
    const handler = app.slice(app.indexOf("const onKey = (e: KeyboardEvent)"), app.indexOf("window.addEventListener(\"keydown\", onKey)"));
    expect(handler).toMatch(/e\.code === "KeyT"/);
    expect(handler).toMatch(/e\.altKey && !mod/);
    expect(handler).not.toMatch(/mod && e\.key === "t"/);
  });
});

describe("worker list shortcut", () => {
  const mount = async (group = false, phone = false, workers = true) => {
    localStorage.setItem("omb-onboarding-done", "true");
    const messages = workers ? [{ id: "l1", at: 1, role: "bot", kind: "launch", text: "Launched WORK\nLabel: WORK | Opus 5.5 | high\nWorking folder: C:\\repo\nSession: aaaaaaaa-1" }] : [];
    localStorage.setItem(SNAPSHOT_CACHE_KEY, JSON.stringify({
      bots: [{ id: "b1", threadId: "t1", name: "Scout", messages, modelSelection: { instanceId: "inst", model: "m" } }],
      groups: group ? [{ id: "g1", threadId: "tg1", name: "Team", memberIds: ["b1"], defaultResponder: { kind: "everyone" }, bulletin: "", messages }] : [],
      selectedId: group ? "g1" : "b1",
    }));
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    vi.stubGlobal("fetch", vi.fn(() => new Promise<Response>(() => {})));
    vi.stubGlobal("EventSource", class { onmessage = null; close = vi.fn(); });
    vi.spyOn(window, "matchMedia").mockImplementation((query) => ({ matches: phone && query.includes("max-width"), media: query, addEventListener: vi.fn(), removeEventListener: vi.fn() }) as unknown as MediaQueryList);
    const host = document.body.appendChild(document.createElement("div"));
    const root = createRoot(host);
    await act(async () => root.render(createElement(App)));
    return {
      host,
      press: async (init: KeyboardEventInit = {}) => {
        const event = new KeyboardEvent("keydown", { code: "KeyW", key: "ㅈ", altKey: true, bubbles: true, cancelable: true, ...init });
        await act(async () => { window.dispatchEvent(event); });
        return event;
      },
      unmount: async () => {
        await act(async () => root.unmount());
        host.remove();
        vi.restoreAllMocks();
        vi.unstubAllGlobals();
        localStorage.clear();
      },
    };
  };

  it.each([[false, false], [true, false], [false, true], [true, true]])("toggles the active conversation with group=%s phone=%s", async (group, phone) => {
    const { host, press, unmount } = await mount(group, phone);
    try {
      const chip = host.querySelector("[data-worker-strip]")!;
      expect(chip.getAttribute("aria-expanded")).toBe("false");
      expect((await press()).defaultPrevented).toBe(true);
      expect(chip.getAttribute("aria-expanded")).toBe("true");
      const list = document.body.querySelector("[data-worker-list]")!;
      expect(list.textContent).toContain(group ? "Team's workers" : "Scout's workers");
      expect(list.getAttribute("aria-modal")).toBe(phone ? "true" : null);
      await press();
      expect(document.body.querySelector("[data-worker-list]")).toBeNull();
    } finally {
      await unmount();
    }
  });

  it("prevents the Window mnemonic even when there are no workers", async () => {
    const { host, press, unmount } = await mount(false, false, false);
    try {
      expect(host.querySelector("[data-worker-strip]")).toBeNull();
      expect((await press()).defaultPrevented).toBe(true);
      expect(document.body.querySelector("[data-worker-list]")).toBeNull();
    } finally {
      await unmount();
    }
  });

  it("ignores extra modifiers, repeats and composition", async () => {
    const { press, unmount } = await mount();
    try {
      expect((await press()).defaultPrevented).toBe(true);
      await press();
      for (const init of [{ shiftKey: true }, { ctrlKey: true }, { metaKey: true }, { repeat: true }, { isComposing: true }, { altKey: false }]) {
        expect((await press(init)).defaultPrevented).toBe(false);
        expect(document.body.querySelector("[data-worker-list]")).toBeNull();
      }
    } finally {
      await unmount();
    }
  });

  it("leaves Alt+W to the open terminal", async () => {
    const { host, press, unmount } = await mount();
    try {
      expect((await press()).defaultPrevented).toBe(true);
      await press({ code: "Backquote", key: "`", ctrlKey: true, altKey: false });
      expect(host.querySelector('.orbit-terminal-overlay[data-open="true"]')).not.toBeNull();
      expect(document.body.querySelector("[data-worker-list]")).toBeNull();
      expect((await press()).defaultPrevented).toBe(false);
      expect(document.body.querySelector("[data-worker-list]")).toBeNull();
    } finally {
      await unmount();
    }
  });
});

describe("theme cycle shortcut", () => {
  const handler = () =>
    app.slice(app.indexOf("const onKey = (e: KeyboardEvent)"), app.indexOf("window.addEventListener(\"keydown\", onKey)"));

  const dark = SKINS.filter((s) => !LIGHT_SKIN_IDS.has(s.id)).map((s) => s.id);
  const light = SKINS.filter((s) => LIGHT_SKIN_IDS.has(s.id)).map((s) => s.id);

  const order = [...dark, ...light];

  it("steps through the picker's dark-then-light order", () => {
    expect(nextSkin(dark[0])).toBe(dark[1]);
    expect(nextSkin(light[0])).toBe(light[1]);
  });

  it("crosses from last dark to first light", () => {
    expect(nextSkin(dark[dark.length - 1])).toBe(light[0]);
  });

  it("wraps from last light to first dark", () => {
    expect(nextSkin(light[light.length - 1])).toBe(dark[0]);
  });

  it("visits every skin once per lap", () => {
    const seen = [order[0]];
    for (let id = nextSkin(order[0]); id !== order[0]; id = nextSkin(id)) seen.push(id);
    expect(seen).toEqual(order);
  });

  it("falls back to the first skin for an unknown id", () => {
    expect(nextSkin("gone" as SkinId)).toBe(SKIN_IDS[0]);
  });

  it("binds Alt+Shift+T to cycling the skin and ignores repeat or IME composition", () => {
    expect(handler()).toContain('e.altKey && !mod && e.shiftKey && e.code === "KeyT"');
    expect(handler()).toContain("if (e.repeat || e.isComposing) return;");
    expect(handler()).toContain("nextSkin(current)");
    expect(handler()).toContain("applySkin(next)");
    expect(handler()).toContain("setThemeToast(");
  });

  it("keeps the shortcut comment in App-wide shortcuts up to date", () => {
    expect(app).toContain("Alt+Shift+T Cycle theme");
  });
});

describe("bot switch shortcuts", () => {
  it("keeps bracket navigation out of the app-wide shortcut handler", () => {
    const handler = app.slice(app.indexOf("const onKey = (e: KeyboardEvent)"), app.indexOf("window.addEventListener(\"keydown\", onKey)"));
    expect(handler).not.toContain('type: "newBot"');
    expect(handler).not.toContain("BracketLeft");
    expect(handler).not.toContain("BracketRight");
  });
});

describe("bot number shortcuts", () => {
  const handler = () =>
    app.slice(app.indexOf("const onKey = (e: KeyboardEvent)"), app.indexOf("window.addEventListener(\"keydown\", onKey)"));

  it("jumps to the Nth visible bot with Alt+1..Alt+9 in sidebar display order", () => {
    expect(handler()).toContain('e.altKey && !mod && !e.shiftKey');
    expect(handler()).toContain('data-sidebar-row-kind');
    expect(handler()).toContain('data-sidebar-row-id');
    expect(handler()).toContain('type: "select"');
    expect(handler()).toContain("Digit1");
    expect(handler()).toContain("Digit9");
  });

  it("also jumps with Ctrl+1..Ctrl+9, never with Shift or Ctrl+Alt", () => {
    expect(handler()).toContain("e.ctrlKey && !e.metaKey && !e.altKey");
    expect(handler()).toContain("!e.shiftKey && (");
  });

  it("leaves Ctrl+0 zoom reset and the other Ctrl shortcuts alone", () => {
    const start = app.indexOf("const onKey = (e: KeyboardEvent)");
    const tight = app.slice(start, app.indexOf('window.addEventListener("keydown", onKey, true)', start));
    for (const code of ["Digit0", "Numpad0", "Backquote", "KeyK", "KeyF", "KeyZ"]) {
      expect(tight).not.toContain(code);
    }
  });

  it("uses capture so a focused terminal does not swallow Alt+digit", () => {
    expect(app).toContain('window.addEventListener("keydown", onKey, true)');
    expect(handler()).toContain("preventDefault");
    expect(handler()).toContain("stopPropagation");
  });

  it("no-ops past the end with no last-item magic for Alt+9", () => {
    expect(handler()).toMatch(/\[n - 1\]|\[digit - 1\]/);
    expect(handler()).toMatch(/if \(!id\) return/);
    expect(handler()).not.toContain("length - 1");
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

  it("marks attention but skips the popup while terminal popups are off", () => {
    const start = app.indexOf("const offAttention");
    const end = app.indexOf("}, [dispatch, terminalOpen]);", start);
    const handler = app.slice(start, end);

    expect(handler).toContain("if (!terminalPopupsEnabled()) return;");
    expect(handler.indexOf('type: "markTerminalAttention"')).toBeLessThan(handler.indexOf("if (!terminalPopupsEnabled())"));
    expect(handler.indexOf("if (!terminalPopupsEnabled())")).toBeLessThan(handler.indexOf("buildTerminalNotification"));
  });

  it("carries the exact terminal session through notification clicks", () => {
    expect(app).toContain("buildTerminalNotification(bot, reason, sessionId)");
    expect(app).toContain("terminalAttentionForBot(latestState.current.terminalAttention, target.botId)");
    expect(app).toContain("openNotificationTarget(dispatch, target, current)");
    expect(app).toContain("if (!terminalOpen || !bot || !document.hasFocus()) return;");
    expect(app).toContain('window.addEventListener("focus", acknowledgeVisible)');
    expect(app).toContain('type: "ackTerminalAttention"');
    expect(app).toContain("const acknowledge = window.ogb?.terminal?.acknowledge");
    expect(app).toContain("acknowledge(attention.sessionId)");
  });

  it("keeps targeted acknowledgements scoped by bot while a notification click settles", () => {
    expect(app).toContain("useRef(new Map<string, Set<string>>())");
    expect(app).toContain("const targeted = pendingTerminalAcknowledgements.current.get(bot.id)");
    expect(app).toContain("if (targeted.size === 0) pendingTerminalAcknowledgements.current.delete(bot.id)");
  });
});

describe("terminal close routing", () => {
  it("subscribes to onClosed once and clears attention without re-acknowledging the pane", () => {
    const start = app.indexOf("const offClosed");
    const end = app.indexOf("}, [dispatch]);", start);
    const handler = app.slice(start, end);

    expect(handler).toContain("window.ogb?.terminal?.onClosed?.(({ id: sessionId, botId })");
    expect(handler).toContain("terminalAttentionKey(botId, sessionId)");
    expect(handler).toContain("clearTerminalAttention({ botId, sessionId })");
    expect(handler).not.toContain("window.ogb?.terminal?.acknowledge");
  });

  it("shares the ackTerminalAttention dispatch and ref cleanup with the acknowledge path", () => {
    const start = app.indexOf("const clearTerminalAttention");
    const end = app.indexOf("const acknowledgeTerminalAttention");
    const handler = app.slice(start, end);

    expect(handler).toContain("handledTerminalAttention.current.delete(key)");
    expect(handler).toContain('type: "ackTerminalAttention"');
  });
});

describe("terminal pane shortcuts", () => {
  const handler = () =>
    app.slice(app.indexOf("const onKey = (e: KeyboardEvent)"), app.indexOf("window.addEventListener(\"keydown\", onKey)"));

  it("routes Alt+digit to the Nth pane while the terminal is open and swallows it", () => {
    const pane = handler().slice(handler().indexOf("if (n !== null && e.altKey && terminalOpen && altDigitSelectsPane"), handler().indexOf('data-sidebar-row-kind'));
    expect(pane).toContain("e.preventDefault()");
    expect(pane).toContain("e.stopPropagation()");
    expect(pane).toContain("setPaneHotkey({ n })");
    expect(pane).toContain("return;");
    expect(app).toContain("paneHotkey={paneHotkey}");
    expect(app).toContain("terminalOpen, dispatch]);");
  });

  it("focuses the notifying pane from both toast clicks and the in-app attention", () => {
    const notification = app.slice(app.indexOf("const openTerminalNotification"), app.indexOf("const openTerminalAttention"));
    const attention = app.slice(app.indexOf("const openTerminalAttention"), app.indexOf("useEffect(() => {\n    const acknowledgeVisible"));
    const click = app.slice(app.indexOf("window.ogb?.onNotificationClick"), app.indexOf("// A tapped push notification"));
    expect(notification).toContain("setPaneFocus({ sessionId: target.terminalSessionId })");
    expect(attention).toContain("setPaneFocus({ sessionId: attention.sessionId })");
    expect(click).toContain("setPaneFocus({ sessionId: target.terminalSessionId })");
    expect(app).toContain("paneFocus={paneFocus}");
  });

  it("keeps Alt+digit on bots with the terminal closed and Ctrl+digit on bots everywhere", () => {
    const h = handler();
    expect(h.indexOf("e.altKey && terminalOpen")).toBeLessThan(h.indexOf('type: "select"'));
    expect(h).not.toMatch(/e\.ctrlKey && terminalOpen/);
    expect(h).toContain("e.ctrlKey && !e.metaKey && !e.altKey");
    expect(h).toContain('type: "select", id');
  });
});

describe("conversation layout", () => {
  it("clips the hidden terminal overlay instead of making the chat scrollable", () => {
    // overflow-hidden is still programmatically scrollable: a terminal tab scrollIntoView shifted the chat under the sidebar.
    expect(app).toContain('ref={conversationRef} className="relative flex min-h-0 min-w-0 flex-1 flex-col overflow-clip"');
  });
});
