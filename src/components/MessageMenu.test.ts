// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";

import { StoreProvider, useStore, type Bot, type Group, type Message } from "@/state/store";
import { I18nProvider } from "@/lib/i18n";
import { en, ko } from "@/lib/i18n-catalog";
import { applySkin } from "@/lib/skins";
import { EXTENDED_REACTIONS } from "../../shared/reactions";

import { ChatView } from "./ChatView";
import { GroupView } from "./GroupView";
import {
  QUICK_REACTIONS,
  contextClickKind,
  copyShortcutHint,
  selectionContainsPoint,
  type SelectionLike,
} from "./MessageMenu";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

class FakeEventSource {
  static last: FakeEventSource | null = null;
  onmessage: ((event: { data: string; lastEventId: string }) => void) | null = null;
  close = vi.fn();
  constructor() {
    FakeEventSource.last = this;
  }
}

const userMsg = (id: string, text: string): Message => ({ id, at: 1, role: "user", kind: "text", text });
const botMsg = (id: string, text: string, extra?: Partial<Message>): Message => ({ id, at: 2, role: "bot", kind: "text", text, ...extra });
const bot = (messages: Message[]): Bot => ({
  id: "helper", threadId: "thread-helper", name: "Helper", title: "", description: "",
  notifications: false, color: "blue", unread: false, busy: false, activity: "idle",
  modelSelection: { instanceId: "inst", model: "m" }, messages,
});

interface SeenStore {
  bots: Bot[];
  groups: Group[];
}
let latest: SeenStore = { bots: [], groups: [] };
function Probe() {
  const { state } = useStore();
  latest = { bots: state.bots, groups: state.groups };
  return null;
}

let unmount: (() => Promise<void>) | null = null;
let renderChat: ((next: Bot) => Promise<void>) | null = null;

afterEach(async () => {
  await unmount?.();
  unmount = null;
  renderChat = null;
  FakeEventSource.last = null;
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  localStorage.clear();
  applySkin("precision");
  Object.assign(document, { caretRangeFromPoint: undefined });
});

async function mountChat(current: Bot) {
  vi.stubGlobal("EventSource", FakeEventSource);
  vi.stubGlobal("fetch", vi.fn(async (url: string) => url === "/api/bots?messages=200"
    ? Response.json({ bots: [current], groups: [], computerControl: {} })
    : new Response("{}", { status: 404 })));
  vi.stubGlobal("ResizeObserver", class {
    observe() {}
    unobserve() {}
    disconnect() {}
  });
  vi.spyOn(console, "warn").mockImplementation(() => {});
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  const draw = (next: Bot) => {
    root.render(createElement(I18nProvider, null,
      createElement(StoreProvider, null, createElement(ChatView, { bot: next }), createElement(Probe)),
    ));
  };
  renderChat = async (next: Bot) => {
    await act(async () => { draw(next); });
  };
  await act(async () => { draw(current); });
  await act(async () => {
    FakeEventSource.last?.onmessage?.({ data: JSON.stringify({ kind: "hello", resumed: false, cursor: "qa:1" }), lastEventId: "qa:1" });
  });
  unmount = async () => {
    await act(async () => root.unmount());
    host.remove();
  };
  return host;
}

const member = (id: string, name: string): Bot => ({ ...bot([]), id, threadId: `thread-${id}`, name });
async function mountRoom(members: Bot[], group: Group) {
  vi.stubGlobal("EventSource", FakeEventSource);
  vi.stubGlobal("fetch", vi.fn(async (url: string) => url === "/api/bots?messages=200"
    ? Response.json({ bots: members, groups: [group], computerControl: {} })
    : new Response("{}", { status: 404 })));
  vi.stubGlobal("ResizeObserver", class {
    observe() {}
    unobserve() {}
    disconnect() {}
  });
  vi.spyOn(console, "warn").mockImplementation(() => {});
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  await act(async () => root.render(createElement(I18nProvider, null,
    createElement(StoreProvider, null, createElement(GroupView, { group }), createElement(Probe)),
  )));
  await act(async () => {
    FakeEventSource.last?.onmessage?.({ data: JSON.stringify({ kind: "hello", resumed: false, cursor: "qa:1" }), lastEventId: "qa:1" });
  });
  unmount = async () => {
    await act(async () => root.unmount());
    host.remove();
  };
  return host;
}

const room = (messages: Message[]): Group => ({
  id: "g", threadId: "thread-g", name: "Room", memberIds: ["m1", "m2"],
  defaultResponder: { kind: "everyone" }, bulletin: "", unread: false,
  createdAt: 1, setupCompletedAt: 1, hasMore: false, messages,
});

const rightClick = (el: Element, x = 100, y = 100) =>
  act(async () => {
    el.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: x, clientY: y }));
  });
const keyOn = (el: Element, init: KeyboardEventInit) =>
  act(async () => {
    el.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, ...init }));
  });

const messageMenu = () => document.querySelector("[data-message-menu]");
const selectionMenu = () => document.querySelector("[data-selection-menu]");
const menuReactions = () => Array.from(document.querySelectorAll("[data-menu-reaction]"));
const storeMessage = (threadId: string, id: string) =>
  [...latest.bots, ...latest.groups].find((c) => c.threadId === threadId)?.messages.find((m) => m.id === id);

function stubClipboard() {
  const writeText = vi.fn<(text: string) => Promise<void>>(async () => {});
  Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText } });
  return writeText;
}

function stubSelection(text: string, inRange: boolean) {
  const node = document.createTextNode(text);
  const like: SelectionLike = {
    isCollapsed: false, rangeCount: 1, anchorNode: node,
    toString: () => text, getRangeAt: () => ({ isPointInRange: () => inRange }),
  };
  // SAFETY: the menu only reads the SelectionLike slice mocked above.
  const sel = like as Selection;
  vi.spyOn(window, "getSelection").mockReturnValue(sel);
  // happy-dom keeps a separate document.getSelection; browsers share one
  vi.spyOn(document, "getSelection").mockReturnValue(sel);
  Object.assign(document, { caretRangeFromPoint: () => ({ startContainer: node, startOffset: 0 }) });
}

function stubPlatform(platform: string) {
  Object.defineProperty(window.navigator, "platform", { configurable: true, value: platform });
}

describe("message menu helpers", () => {
  it("lists the six quick reactions", () => {
    expect(QUICK_REACTIONS).toEqual(["👍", "👎", "❤️", "😂", "🎉", "🔥"]);
    for (const emoji of QUICK_REACTIONS) expect(EXTENDED_REACTIONS).toContain(emoji);
  });

  it("hints Ctrl+C, or Cmd+C on macOS", () => {
    stubPlatform("Win32");
    expect(copyShortcutHint()).toBe("Ctrl+C");
    stubPlatform("MacIntel");
    expect(copyShortcutHint()).toBe("Cmd+C");
  });

  it("keeps the native menu on links and editable fields", () => {
    const host = document.createElement("div");
    host.innerHTML = '<a href="https://example.com">docs</a><textarea></textarea><input /><p>plain</p>';
    document.body.append(host);
    try {
      expect(contextClickKind(host.querySelector("a")!, 1, 1)).toBe("native");
      expect(contextClickKind(host.querySelector("textarea")!, 1, 1)).toBe("native");
      expect(contextClickKind(host.querySelector("input")!, 1, 1)).toBe("native");
      expect(contextClickKind(host.querySelector("p")!, 1, 1)).toBe("message");
    } finally {
      host.remove();
    }
  });

  it("detects a click inside the selection", () => {
    const node = document.createTextNode("hello");
    const sel: SelectionLike = {
      isCollapsed: false, rangeCount: 1, anchorNode: node,
      toString: () => "hello", getRangeAt: () => ({ isPointInRange: (n: Node) => n === node }),
    };
    expect(selectionContainsPoint(sel, node, 2)).toBe(true);
    expect(selectionContainsPoint(sel, document.createTextNode("other"), 0)).toBe(false);
    expect(selectionContainsPoint(null, node, 0)).toBe(false);
  });
});

describe("message menu in 1:1 chats", () => {
  it("opens a bot menu with quick reactions, Reply and Copy", async () => {
    const host = await mountChat(bot([userMsg("u1", "hi"), botMsg("b1", "hello there")]));
    await rightClick(host.querySelector('[data-mid="b1"] [data-orbit-message-content]')!);

    const menu = messageMenu();
    expect(menu).not.toBeNull();
    expect(menuReactions().map((b) => b.textContent)).toEqual([...QUICK_REACTIONS]);
    expect(menu?.querySelector("[data-menu-expand]")).not.toBeNull();
    expect(menu?.querySelector("[data-menu-reply]")?.textContent).toBe("Reply");
    expect(menu?.querySelector("[data-menu-copy]")?.textContent).toBe("Copy");
    expect(menu?.textContent).not.toContain("Copy ID");
  });

  it("expands to the full grid and collapses back", async () => {
    const host = await mountChat(bot([botMsg("b1", "hello")]));
    await rightClick(host.querySelector('[data-mid="b1"] [data-orbit-message-content]')!);
    await act(async () => { document.querySelector("[data-menu-expand]")!.dispatchEvent(new MouseEvent("click", { bubbles: true })); });

    expect(menuReactions().map((b) => b.textContent)).toEqual([...EXTENDED_REACTIONS]);
    expect(messageMenu()?.querySelector("[data-menu-reply]")).not.toBeNull();
    expect(messageMenu()?.querySelector("[data-menu-copy]")).not.toBeNull();
    await act(async () => { document.querySelector("[data-menu-collapse]")!.dispatchEvent(new MouseEvent("click", { bubbles: true })); });
    expect(menuReactions()).toHaveLength(6);
  });

  it("toggles a quick reaction with the same dispatch as ReactionBar", async () => {
    const host = await mountChat(bot([botMsg("b1", "hello")]));
    await rightClick(host.querySelector('[data-mid="b1"] [data-orbit-message-content]')!);
    await act(async () => { menuReactions()[0]!.dispatchEvent(new MouseEvent("click", { bubbles: true })); });

    expect(storeMessage("thread-helper", "b1")?.reactions).toEqual([{ emoji: "👍", by: "user" }]);
    expect(messageMenu()).toBeNull();
  });

  it("shows applied emoji pressed and toggles it off", async () => {
    const host = await mountChat(bot([botMsg("b1", "hello", { reactions: [{ emoji: "👍", by: "user" }] })]));
    await rightClick(host.querySelector('[data-mid="b1"] [data-orbit-message-content]')!);

    expect(menuReactions()[0]!.getAttribute("role")).toBe("menuitemcheckbox");
    expect(menuReactions()[0]!.getAttribute("aria-checked")).toBe("true");
    await act(async () => { menuReactions()[0]!.dispatchEvent(new MouseEvent("click", { bubbles: true })); });
    expect(storeMessage("thread-helper", "b1")?.reactions).toBeUndefined();
  });

  it("replies exactly like the hover Reply button", async () => {
    const host = await mountChat(bot([botMsg("b1", "hover target")]));
    await rightClick(host.querySelector('[data-mid="b1"] [data-orbit-message-content]')!);
    await act(async () => { document.querySelector("[data-menu-reply]")!.dispatchEvent(new MouseEvent("click", { bubbles: true })); });

    const cancel = host.querySelector('button[aria-label="Cancel reply"]');
    expect(cancel).not.toBeNull();
    expect(cancel?.parentElement?.textContent).toContain("hover target");
    expect(messageMenu()).toBeNull();
  });

  it("copies the same text the hover Copy button copies", async () => {
    const writeText = stubClipboard();
    const host = await mountChat(bot([userMsg("u1", "user words"), botMsg("b1", "bot words **bold**")]));
    await rightClick(host.querySelector('[data-mid="b1"] [data-orbit-message-content]')!);
    await act(async () => { document.querySelector("[data-menu-copy]")!.dispatchEvent(new MouseEvent("click", { bubbles: true })); });
    const menuCopy = writeText.mock.calls.at(-1)?.[0];

    const hoverCopy = host.querySelector('[data-mid="b1"] button[aria-label="Copy message"]')!;
    await act(async () => { hoverCopy.dispatchEvent(new MouseEvent("click", { bubbles: true })); });
    expect(menuCopy).toBe("bot words **bold**");
    expect(writeText.mock.calls.at(-1)?.[0]).toBe(menuCopy);
    expect(messageMenu()).toBeNull();
  });

  it("shows a user message with Reply and Copy only", async () => {
    const host = await mountChat(bot([userMsg("u1", "my words")]));
    await rightClick(host.querySelector('[data-mid="u1"] [data-orbit-message-content]')!);

    const menu = messageMenu();
    expect(menu).not.toBeNull();
    expect(menu?.querySelectorAll("button")).toHaveLength(2);
    expect(menu?.querySelector("[data-menu-reaction]")).toBeNull();
    expect(menu?.querySelector("[data-menu-expand]")).toBeNull();
    expect(menu?.querySelector("[data-menu-reply]")?.textContent).toBe("Reply");
    expect(menu?.querySelector("[data-menu-copy]")?.textContent).toBe("Copy");
  });

  it("copies a user message verbatim", async () => {
    const writeText = stubClipboard();
    const host = await mountChat(bot([userMsg("u1", "my words")]));
    await rightClick(host.querySelector('[data-mid="u1"] [data-orbit-message-content]')!);
    await act(async () => { document.querySelector("[data-menu-copy]")!.dispatchEvent(new MouseEvent("click", { bubbles: true })); });
    expect(writeText).toHaveBeenCalledWith("my words");
  });

  it("opens the selection menu on selected text and copies it", async () => {
    stubPlatform("Win32");
    const writeText = stubClipboard();
    const host = await mountChat(bot([botMsg("b1", "selectable words here")]));
    stubSelection("words", true);
    await rightClick(host.querySelector('[data-mid="b1"] [data-orbit-message-content]')!);

    const menu = selectionMenu();
    expect(menu).not.toBeNull();
    expect(messageMenu()).toBeNull();
    expect(menu?.querySelectorAll("button")).toHaveLength(1);
    expect(menu?.textContent).toContain("Copy");
    expect(menu?.textContent).toContain("Ctrl+C");
    await act(async () => { menu?.querySelector("button")!.dispatchEvent(new MouseEvent("click", { bubbles: true })); });
    expect(writeText).toHaveBeenCalledWith("words");
    expect(selectionMenu()).toBeNull();
  });

  it("opens the message menu when the click is outside the selection", async () => {
    const host = await mountChat(bot([botMsg("b1", "hello")]));
    stubSelection("elsewhere", false);
    await rightClick(host.querySelector('[data-mid="b1"] [data-orbit-message-content]')!);
    expect(messageMenu()).not.toBeNull();
    expect(selectionMenu()).toBeNull();
  });

  it("leaves links to the native menu", async () => {
    const host = await mountChat(bot([botMsg("b1", "read the [docs](https://example.com/guide) first")]));
    const link = host.querySelector('[data-mid="b1"] a[href="https://example.com/guide"]')!;
    await rightClick(link);
    expect(messageMenu()).toBeNull();
    expect(selectionMenu()).toBeNull();
  });

  it("leaves the edit box to the native menu", async () => {
    const host = await mountChat(bot([userMsg("u1", "fix me")]));
    await act(async () => { host.querySelector('[data-mid="u1"] button[aria-label="Edit message"]')!.dispatchEvent(new MouseEvent("click", { bubbles: true })); });
    await rightClick(host.querySelector("[data-orbit-transcript] textarea")!);
    expect(messageMenu()).toBeNull();
    expect(selectionMenu()).toBeNull();
  });

  it("stays closed on touch-first devices", async () => {
    const host = await mountChat(bot([botMsg("b1", "hello")]));
    const orig = window.matchMedia;
    Object.defineProperty(window, "matchMedia", { configurable: true, value: () => ({ matches: true }) });
    try {
      await rightClick(host.querySelector('[data-mid="b1"] [data-orbit-message-content]')!);
      expect(messageMenu()).toBeNull();
      expect(selectionMenu()).toBeNull();
    } finally {
      Object.defineProperty(window, "matchMedia", { configurable: true, value: orig });
    }
  });

  it("opens from the keyboard and hands focus back on Escape", async () => {
    const host = await mountChat(bot([botMsg("b1", "hello")]));
    const row = host.querySelector<HTMLElement>('[data-mid="b1"] [data-orbit-message]')!;
    row.focus();
    await keyOn(row, { key: "F10", shiftKey: true });
    expect(messageMenu()).not.toBeNull();
    await keyOn(row, { key: "Escape" });
    expect(messageMenu()).toBeNull();
    expect(document.activeElement).toBe(row);
  });

  it("opens from the ContextMenu key", async () => {
    const host = await mountChat(bot([userMsg("u1", "mine")]));
    const row = host.querySelector<HTMLElement>('[data-mid="u1"] [data-orbit-message]')!;
    row.focus();
    await keyOn(row, { key: "ContextMenu" });
    expect(messageMenu()?.querySelector("[data-menu-copy]")).not.toBeNull();
  });

  it("leaves a focused link to the native menu", async () => {
    const host = await mountChat(bot([botMsg("b1", "read the [docs](https://example.com/guide) first")]));
    const link = host.querySelector<HTMLElement>('[data-mid="b1"] a[href="https://example.com/guide"]')!;
    link.focus();
    for (const init of [{ key: "F10", shiftKey: true }, { key: "ContextMenu" }] as const) {
      let prevented = false;
      await act(async () => {
        const event = new KeyboardEvent("keydown", { bubbles: true, cancelable: true, ...init });
        link.dispatchEvent(event);
        prevented = event.defaultPrevented;
      });
      expect(messageMenu(), init.key).toBeNull();
      expect(prevented, init.key).toBe(false);
    }
  });

  it("closes the menu when the thread changes", async () => {
    const host = await mountChat(bot([botMsg("b1", "hello")]));
    await rightClick(host.querySelector('[data-mid="b1"] [data-orbit-message-content]')!);
    expect(messageMenu()).not.toBeNull();
    const next = { ...bot([botMsg("b2", "other")]), id: "other", threadId: "thread-other" };
    await renderChat!(next);
    expect(messageMenu()).toBeNull();
  });

  it("returns focus to the row after Copy and to the composer after Reply", async () => {
    stubClipboard();
    const host = await mountChat(bot([userMsg("u1", "mine")]));
    const row = host.querySelector<HTMLElement>('[data-mid="u1"] [data-orbit-message]')!;
    const open = () => rightClick(host.querySelector('[data-mid="u1"] [data-orbit-message-content]')!);

    await open();
    const copy = document.querySelector<HTMLElement>("[data-menu-copy]")!;
    copy.focus();
    await act(async () => { copy.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, key: "Enter" })); });
    expect(messageMenu()).toBeNull();
    expect(document.activeElement).toBe(row);

    await open();
    const reply = document.querySelector<HTMLElement>("[data-menu-reply]")!;
    reply.focus();
    await act(async () => { reply.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, key: "Enter" })); });
    expect(messageMenu()).toBeNull();
    expect(document.activeElement).toBe(host.querySelector("[data-orbit-composer]"));
  });

  it("moves with arrow keys and activates with Enter", async () => {
    const host = await mountChat(bot([userMsg("u1", "arrow target")]));
    await rightClick(host.querySelector('[data-mid="u1"] [data-orbit-message-content]')!);
    const reply = document.querySelector<HTMLElement>("[data-menu-reply]")!;
    const copy = document.querySelector<HTMLElement>("[data-menu-copy]")!;
    expect(document.activeElement).toBe(reply);
    await act(async () => { reply.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, key: "ArrowDown" })); });
    expect(document.activeElement).toBe(copy);
    await act(async () => { copy.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, key: "ArrowUp" })); });
    expect(document.activeElement).toBe(reply);
    await act(async () => { reply.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, key: "Enter" })); });
    const cancel = host.querySelector('button[aria-label="Cancel reply"]');
    expect(cancel).not.toBeNull();
    expect(cancel?.parentElement?.textContent).toContain("arrow target");
    expect(messageMenu()).toBeNull();
  });

  it("closes on outside click, blur and transcript scroll", async () => {
    const host = await mountChat(bot([botMsg("b1", "hello")]));
    const content = host.querySelector('[data-mid="b1"] [data-orbit-message-content]')!;
    const scroller = host.querySelector("[data-orbit-transcript]")!;

    await rightClick(content);
    expect(messageMenu()).not.toBeNull();
    await act(async () => { document.body.dispatchEvent(new MouseEvent("mousedown", { bubbles: true })); });
    expect(messageMenu()).toBeNull();

    await rightClick(content);
    await act(async () => { window.dispatchEvent(new Event("blur")); });
    expect(messageMenu()).toBeNull();

    await rightClick(content);
    await act(async () => { scroller.dispatchEvent(new Event("scroll")); });
    expect(messageMenu()).toBeNull();
  });

  it("labels Reply and Copy in English and Korean", async () => {
    expect(en["chat.reply"]).toBe("Reply");
    expect(en["chat.copy"]).toBe("Copy");
    expect(ko["chat.reply"]).toBe("답장");
    expect(ko["chat.copy"]).toBe("복사");
    localStorage.setItem("omb-locale", "ko");
    const host = await mountChat(bot([userMsg("u1", "mine")]));
    await rightClick(host.querySelector('[data-mid="u1"] [data-orbit-message-content]')!);
    expect(messageMenu()?.querySelector("[data-menu-reply]")?.textContent).toBe("답장");
    expect(messageMenu()?.querySelector("[data-menu-copy]")?.textContent).toBe("복사");
  });
});

describe("message menu in rooms", () => {
  const members = [member("m1", "Ada"), member("m2", "Bo")];
  const roomBot = (id: string, text: string): Message => ({
    ...botMsg(id, text), from: { botId: "m1", name: "Ada", color: "blue" },
  });

  it("opens a bot menu with reactions, Reply and Copy", async () => {
    const host = await mountRoom(members, room([userMsg("u1", "hi all"), roomBot("b1", "room hello")]));
    await rightClick(host.querySelector('[data-mid="b1"] [data-orbit-message-content]')!);

    const menu = messageMenu();
    expect(menu).not.toBeNull();
    expect(menuReactions()).toHaveLength(6);
    expect(menu?.querySelector("[data-menu-reply]")?.textContent).toBe("Reply");
    expect(menu?.querySelector("[data-menu-copy]")?.textContent).toBe("Copy");
  });

  it("copies the room message text", async () => {
    const writeText = stubClipboard();
    const host = await mountRoom(members, room([roomBot("b1", "room hello")]));
    await rightClick(host.querySelector('[data-mid="b1"] [data-orbit-message-content]')!);
    await act(async () => { document.querySelector("[data-menu-copy]")!.dispatchEvent(new MouseEvent("click", { bubbles: true })); });
    expect(writeText).toHaveBeenCalledWith("room hello");
  });

  it("reacts to a room message", async () => {
    const host = await mountRoom(members, room([roomBot("b1", "room hello")]));
    await rightClick(host.querySelector('[data-mid="b1"] [data-orbit-message-content]')!);
    await act(async () => { menuReactions()[3]!.dispatchEvent(new MouseEvent("click", { bubbles: true })); });
    expect(storeMessage("thread-g", "b1")?.reactions).toEqual([{ emoji: "😂", by: "user" }]);
  });
});
