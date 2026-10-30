// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";

import { StoreProvider, useStore, type Bot, type Group, type Message } from "@/state/store";
import { I18nProvider } from "@/lib/i18n";
import { en, ko } from "@/lib/i18n-catalog";
import { applySkin } from "@/lib/skins";
import * as friendsChrome from "@/lib/friends-chrome";
import { EXTENDED_REACTIONS } from "../../shared/reactions";

import { ChatView } from "./ChatView";
import { GroupView } from "./GroupView";
import {
  QUICK_REACTIONS,
  contextClickKind,
  copyShortcutHint,
  endSelectMode,
  selectionContainsPoint,
  startSelectMode,
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
const pinnedChatId = () => latest.bots.find((b) => b.threadId === "thread-helper")?.pinnedMessageId;
const botWithPin = (messages: Message[], pinnedMessageId: string): Bot => ({ ...bot(messages), pinnedMessageId });
const pinnedRoomId = () => latest.groups.find((g) => g.threadId === "thread-g")?.pinnedMessageId;
const roomWithPin = (messages: Message[], pinnedMessageId: string): Group => ({ ...room(messages), pinnedMessageId });
// room pins round-trip through PATCH, so the stub server confirms them like production
function stubGroupPatch() {
  vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
    if (typeof url === "string" && url.startsWith("/api/groups/")) {
      const group = latest.groups.find((g) => url.endsWith(g.id))!;
      return Response.json({ group: { ...group, ...JSON.parse(String(init?.body)) } });
    }
    return new Response("{}", { status: 404 });
  }));
}

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
    expect(QUICK_REACTIONS).toEqual(["👍", "👎", "❤️", "😂", "😮", "🔥"]);
    for (const emoji of QUICK_REACTIONS) expect(EXTENDED_REACTIONS).toContain(emoji);
  });

  it("hints Ctrl+C, or Cmd+C on macOS", () => {
    stubPlatform("Win32");
    expect(copyShortcutHint()).toBe("Ctrl+C");
    stubPlatform("MacIntel");
    expect(copyShortcutHint()).toBe("Cmd+C");
  });

  it("keeps the native menu on links, images and editable fields", () => {
    const host = document.createElement("div");
    host.innerHTML = '<a href="https://example.com">docs</a><button data-file-link><span>clip.mp4</span></button><img src="shot.png" alt="" /><textarea></textarea><input /><p>plain</p>';
    document.body.append(host);
    try {
      expect(contextClickKind(host.querySelector("a")!, 1, 1)).toBe("native");
      expect(contextClickKind(host.querySelector("[data-file-link] span")!, 1, 1)).toBe("native");
      expect(contextClickKind(host.querySelector("img")!, 1, 1)).toBe("native");
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

  it("keeps select mode off the desktop Back stack", () => {
    const onLayer = vi.fn();
    const row = document.body.appendChild(document.createElement("div"));
    row.textContent = "hello there";
    window.ogb = {} as NonNullable<typeof window.ogb>;
    window.addEventListener("orbit:back-layer", onLayer);
    try {
      startSelectMode(row, { x: 0, y: 0 });
      expect(row.hasAttribute("data-select-mode")).toBe(true);
      expect(window.getSelection()?.toString()).toBe("hello there");
      endSelectMode();
      expect(row.hasAttribute("data-select-mode")).toBe(false);
      expect(window.getSelection()?.toString()).toBe("");
      expect(onLayer).not.toHaveBeenCalled();
    } finally {
      endSelectMode();
      window.removeEventListener("orbit:back-layer", onLayer);
      window.ogb = undefined;
      row.remove();
    }
  });
});

describe("message menu in 1:1 chats", () => {
  it("opens a bot menu with quick reactions, Reply and Copy", async () => {
    const host = await mountChat(bot([userMsg("u1", "hi"), botMsg("b1", "hello there")]));
    expect(host.querySelector('[data-message-hover-actions] .lucide-pin')).toBeNull();
    expect(host.querySelector('[data-message-hover-actions] .lucide-pin-off')).toBeNull();
    await rightClick(host.querySelector('[data-mid="b1"] [data-orbit-message-content]')!);

    const menu = messageMenu();
    expect(menu).not.toBeNull();
    expect(menuReactions().map((b) => b.textContent)).toEqual([...QUICK_REACTIONS]);
    expect(menu?.querySelector("[data-menu-expand]")).not.toBeNull();
    expect(menu?.querySelector("[data-menu-reply]")?.textContent).toBe("Reply");
    expect(menu?.querySelector("[data-menu-copy]")?.textContent).toBe("Copy");
    expect(menu?.querySelector("[data-menu-pin]")?.textContent).toBe("Pin message");
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

  it("keeps a retired gem chip visible and removable", async () => {
    expect(EXTENDED_REACTIONS).not.toContain("💎");
    const host = await mountChat(bot([botMsg("b1", "hello", { reactions: [{ emoji: "💎", by: "user" }] })]));
    const chip = host.querySelector('[data-mid="b1"] [data-message-reactions] button')!;
    expect(chip.textContent).toContain("💎");
    await act(async () => { chip.dispatchEvent(new MouseEvent("click", { bubbles: true })); });
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

  it("shows a user message with Pin, Reply and Copy only", async () => {
    const host = await mountChat(bot([userMsg("u1", "my words")]));
    await rightClick(host.querySelector('[data-mid="u1"] [data-orbit-message-content]')!);

    const menu = messageMenu();
    expect(menu).not.toBeNull();
    expect(menu?.querySelectorAll("button")).toHaveLength(3);
    expect(menu?.querySelector("[data-menu-reaction]")).toBeNull();
    expect(menu?.querySelector("[data-menu-expand]")).toBeNull();
    expect(menu?.querySelector("[data-menu-pin]")?.textContent).toBe("Pin message");
    expect(menu?.querySelector("[data-menu-reply]")?.textContent).toBe("Reply");
    expect(menu?.querySelector("[data-menu-copy]")?.textContent).toBe("Copy");
  });

  it("pins above Reply and toggles to Unpin in the menu", async () => {
    const messages = [userMsg("u1", "hi"), botMsg("b1", "hello there")];
    const host = await mountChat(bot(messages));
    await rightClick(host.querySelector('[data-mid="b1"] [data-orbit-message-content]')!);

    const menu = messageMenu();
    const order = Array.from(menu!.querySelectorAll("button"));
    const pinAt = order.findIndex((b) => b.hasAttribute("data-menu-pin"));
    const replyAt = order.findIndex((b) => b.hasAttribute("data-menu-reply"));
    expect(pinAt).toBe(replyAt - 1);
    expect(menu?.querySelector("[data-menu-pin]")?.textContent).toBe("Pin message");
    await act(async () => { document.querySelector("[data-menu-pin]")!.dispatchEvent(new MouseEvent("click", { bubbles: true })); });

    expect(pinnedChatId()).toBe("b1");
    expect(messageMenu()).toBeNull();

    await renderChat!(botWithPin(messages, "b1"));
    await rightClick(host.querySelector('[data-mid="b1"] [data-orbit-message-content]')!);
    expect(messageMenu()?.querySelector("[data-menu-pin]")?.textContent).toBe("Unpin message");
    await act(async () => { document.querySelector("[data-menu-pin]")!.dispatchEvent(new MouseEvent("click", { bubbles: true })); });
    expect(pinnedChatId()).toBe("");
  });

  it("restores hover unpin when its gate is enabled", async () => {
    vi.spyOn(friendsChrome, "showHoverPin").mockReturnValue(true);
    const messages = [botMsg("b1", "hover target")];
    const host = await mountChat(bot(messages));
    await rightClick(host.querySelector('[data-mid="b1"] [data-orbit-message-content]')!);
    await act(async () => { document.querySelector("[data-menu-pin]")!.dispatchEvent(new MouseEvent("click", { bubbles: true })); });
    expect(pinnedChatId()).toBe("b1");

    await renderChat!(botWithPin(messages, "b1"));
    const hover = host.querySelector('[data-mid="b1"] button[aria-label="Unpin message"]')!;
    expect(hover).not.toBeNull();
    await act(async () => { hover.dispatchEvent(new MouseEvent("click", { bubbles: true })); });
    expect(pinnedChatId()).toBe("");
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
    const pin = document.querySelector<HTMLElement>("[data-menu-pin]")!;
    const reply = document.querySelector<HTMLElement>("[data-menu-reply]")!;
    const copy = document.querySelector<HTMLElement>("[data-menu-copy]")!;
    expect(document.activeElement).toBe(pin);
    await act(async () => { pin.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, key: "ArrowDown" })); });
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

  it("labels Pin, Reply and Copy in English and Korean", async () => {
    expect(en["chat.reply"]).toBe("Reply");
    expect(en["chat.copy"]).toBe("Copy");
    expect(en["chat.pinMessage"]).toBe("Pin message");
    expect(en["chat.unpinMessage"]).toBe("Unpin message");
    expect(ko["chat.reply"]).toBe("답장");
    expect(ko["chat.copy"]).toBe("복사");
    expect(ko["chat.pinMessage"]).toBe("메시지 고정");
    expect(ko["chat.unpinMessage"]).toBe("메시지 고정 해제");
    localStorage.setItem("omb-locale", "ko");
    const host = await mountChat(bot([userMsg("u1", "mine")]));
    await rightClick(host.querySelector('[data-mid="u1"] [data-orbit-message-content]')!);
    expect(messageMenu()?.querySelector("[data-menu-pin]")?.textContent).toBe("메시지 고정");
    expect(messageMenu()?.querySelector("[data-menu-reply]")?.textContent).toBe("답장");
    expect(messageMenu()?.querySelector("[data-menu-copy]")?.textContent).toBe("복사");
  });
});

describe("message menu in rooms", () => {
  const members = [member("m1", "Ada"), member("m2", "Bo")];
  const roomBot = (id: string, text: string): Message => ({
    ...botMsg(id, text), from: { botId: "m1", name: "Ada", color: "blue" },
  });

  it("opens a bot menu with reactions, Pin, Reply and Copy", async () => {
    const host = await mountRoom(members, room([userMsg("u1", "hi all"), roomBot("b1", "room hello")]));
    expect(host.querySelector('[data-message-hover-actions] .lucide-pin')).toBeNull();
    expect(host.querySelector('[data-message-hover-actions] .lucide-pin-off')).toBeNull();
    await rightClick(host.querySelector('[data-mid="b1"] [data-orbit-message-content]')!);

    const menu = messageMenu();
    expect(menu).not.toBeNull();
    expect(menuReactions()).toHaveLength(6);
    expect(menu?.querySelector("[data-menu-pin]")?.textContent).toBe("Pin message");
    expect(menu?.querySelector("[data-menu-reply]")?.textContent).toBe("Reply");
    expect(menu?.querySelector("[data-menu-copy]")?.textContent).toBe("Copy");
  });

  it("pins a room message above Reply", async () => {
    const messages: Message[] = [
      userMsg("u1", "hi all"),
      { ...botMsg("b1", "room hello"), from: { botId: "m1", name: "Ada", color: "blue" } },
    ];
    const host = await mountRoom(members, room(messages));
    stubGroupPatch();
    await rightClick(host.querySelector('[data-mid="b1"] [data-orbit-message-content]')!);

    const order = Array.from(messageMenu()!.querySelectorAll("button"));
    const pinAt = order.findIndex((b) => b.hasAttribute("data-menu-pin"));
    const replyAt = order.findIndex((b) => b.hasAttribute("data-menu-reply"));
    expect(pinAt).toBe(replyAt - 1);
    await act(async () => { document.querySelector("[data-menu-pin]")!.dispatchEvent(new MouseEvent("click", { bubbles: true })); });
    expect(pinnedRoomId()).toBe("b1");
    expect(messageMenu()).toBeNull();
  });

  it("unpins a room message from the menu", async () => {
    const messages: Message[] = [
      { ...botMsg("b1", "room hello"), from: { botId: "m1", name: "Ada", color: "blue" } },
    ];
    const host = await mountRoom(members, roomWithPin(messages, "b1"));
    stubGroupPatch();
    await rightClick(host.querySelector('[data-mid="b1"] [data-orbit-message-content]')!);
    expect(messageMenu()?.querySelector("[data-menu-pin]")?.textContent).toBe("Unpin message");
    await act(async () => { document.querySelector("[data-menu-pin]")!.dispatchEvent(new MouseEvent("click", { bubbles: true })); });
    expect(pinnedRoomId()).toBe("");
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

describe("message menu on touch", () => {
  const members = [member("m1", "Ada"), member("m2", "Bo")];
  const content = (host: Element, id: string) => host.querySelector(`[data-mid="${id}"] [data-orbit-message-content]`)!;
  const row = (host: Element, id: string) => host.querySelector<HTMLElement>(`[data-mid="${id}"] [data-orbit-message]`)!;
  const labels = (selector: string) => Array.from(messageMenu()!.querySelectorAll(selector)).map((b) => b.textContent);

  function stubTouchScreen() {
    vi.stubGlobal("matchMedia", (query: string) => ({ matches: query === "(pointer: coarse)" }));
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  }

  async function touch(type: string, el: Element, points: Array<[number, number]> = []) {
    const event = new Event(type, { bubbles: true, cancelable: true });
    Object.defineProperty(event, "touches", { value: points.map(([clientX, clientY]) => ({ clientX, clientY })) });
    await act(async () => { el.dispatchEvent(event); });
    return event;
  }
  const wait = (ms: number) => act(async () => { vi.advanceTimersByTime(ms); });
  async function hold(el: Element, x = 100, y = 120) {
    await touch("touchstart", el, [[x, y]]);
    await wait(500);
    return touch("touchend", el);
  }
  const tapOutside = () => touch("touchstart", document.body, [[5, 5]]);
  const selectText = () =>
    act(async () => { document.querySelector("[data-menu-select]")!.dispatchEvent(new MouseEvent("click", { bubbles: true })); });
  const place = (el: Element, rect: { x?: number; y?: number; width?: number; height?: number }) =>
    Object.defineProperty(el, "getBoundingClientRect", { configurable: true, value: () => DOMRect.fromRect({ width: 400, height: 400, ...rect }) });
  function textNode(el: Element, text: string): Text {
    const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      if (node instanceof Text && node.data.includes(text)) return node;
    }
    throw new Error(`no text node with ${text}`);
  }
  function stubCaret(at: () => [Node, number] | null) {
    const caret = vi.fn((_x: number, _y: number) => {
      const point = at();
      if (!point) return null;
      const range = document.createRange();
      range.setStart(...point);
      return range;
    });
    Object.assign(document, { caretRangeFromPoint: caret });
    return caret;
  }
  async function selectAt(host: Element, id: string, at: (content: Element) => [Node, number] | null) {
    const el = content(host, id);
    place(el, {});
    const caret = stubCaret(() => at(el));
    await hold(el);
    await selectText();
    return caret;
  }

  afterEach(async () => {
    await tapOutside();
    vi.useRealTimers();
  });

  it("opens the bot menu at the finger after a hold in a chat", async () => {
    const host = await mountChat(bot([userMsg("u1", "hi"), botMsg("b1", "hello there")]));
    stubTouchScreen();
    await touch("touchstart", content(host, "b1"), [[100, 120]]);
    await wait(499);
    expect(messageMenu()).toBeNull();
    await wait(1);

    const menu = document.querySelector<HTMLElement>("[data-message-menu]")!;
    expect(menu).not.toBeNull();
    expect(menuReactions().map((b) => b.textContent)).toEqual([...QUICK_REACTIONS]);
    expect(menu.querySelector("[data-menu-expand]")).not.toBeNull();
    expect(labels("[role=menuitem]:not([data-menu-expand])")).toEqual(["Pin message", "Reply", "Copy", "Select text"]);
    expect(menu.lastElementChild?.hasAttribute("data-menu-select")).toBe(true);
    expect(menu.style.top).toBe("120px");
    expect(menu.style.left).toBe("100px");
    for (const button of menu.querySelectorAll("button")) expect(button.className).toMatch(/\b(size-10|min-h-10)\b/);
  });

  it("opens his menu with Pin, Reply, Copy and Select text", async () => {
    const host = await mountChat(bot([userMsg("u1", "my words")]));
    stubTouchScreen();
    await hold(content(host, "u1"));
    expect(labels("button")).toEqual(["Pin message", "Reply", "Copy", "Select text"]);
  });

  it("pins from the hold menu above Reply", async () => {
    const host = await mountChat(bot([userMsg("u1", "hi"), botMsg("b1", "hello there")]));
    stubTouchScreen();
    await hold(content(host, "b1"));
    expect(labels("[role=menuitem]:not([data-menu-expand])")).toEqual(["Pin message", "Reply", "Copy", "Select text"]);
    await act(async () => { document.querySelector("[data-menu-pin]")!.dispatchEvent(new MouseEvent("click", { bubbles: true })); });
    expect(pinnedChatId()).toBe("b1");
    expect(messageMenu()).toBeNull();
  });

  it("opens after a hold in a room", async () => {
    const roomBot: Message = { ...botMsg("b1", "room hello"), from: { botId: "m1", name: "Ada", color: "blue" } };
    const host = await mountRoom(members, room([userMsg("u1", "hi all"), roomBot]));
    stubTouchScreen();
    await hold(content(host, "b1"));
    expect(menuReactions()).toHaveLength(6);
    expect(messageMenu()?.querySelector("[data-menu-select]")?.textContent).toBe("Select text");
    await tapOutside();
    await hold(content(host, "u1"));
    expect(labels("button")).toEqual(["Pin message", "Reply", "Copy", "Select text"]);
  });

  it("opens nothing on a quick tap, a moving finger, a scroll or a second finger", async () => {
    const host = await mountChat(bot([botMsg("b1", "hello there")]));
    stubTouchScreen();
    const target = content(host, "b1");

    await touch("touchstart", target, [[100, 120]]);
    await wait(150);
    expect((await touch("touchend", target)).defaultPrevented).toBe(false);
    await wait(600);
    expect(messageMenu()).toBeNull();

    await touch("touchstart", target, [[100, 120]]);
    await touch("touchmove", target, [[100, 131]]);
    await wait(600);
    expect(messageMenu()).toBeNull();

    await touch("touchstart", target, [[100, 120]]);
    await act(async () => { host.querySelector("[data-orbit-transcript]")!.dispatchEvent(new Event("scroll")); });
    await wait(600);
    expect(messageMenu()).toBeNull();

    await touch("touchstart", target, [[100, 120]]);
    await touch("touchcancel", target);
    await wait(600);
    expect(messageMenu()).toBeNull();

    await touch("touchstart", target, [[100, 120]]);
    await touch("touchstart", target, [[100, 120], [200, 220]]);
    await wait(600);
    expect(messageMenu()).toBeNull();

    await touch("touchstart", target, [[100, 120]]);
    await touch("touchmove", target, [[106, 126]]);
    await wait(500);
    expect(messageMenu()).not.toBeNull();
  });

  it("drops its scroll watch once the menu opens and still swallows the lift", async () => {
    const host = await mountChat(bot([botMsg("b1", "hello there")]));
    stubTouchScreen();
    const add = vi.spyOn(document, "addEventListener");
    const remove = vi.spyOn(document, "removeEventListener");
    const target = content(host, "b1");
    await touch("touchstart", target, [[100, 120]]);
    const watch = add.mock.calls.find(([type, , capture]) => type === "scroll" && capture === true)?.[1];
    expect(watch).toBeDefined();
    remove.mockClear();
    await wait(500);
    expect(messageMenu()).not.toBeNull();
    expect(remove.mock.calls.some(([type, fn]) => type === "scroll" && fn === watch)).toBe(true);
    expect((await touch("touchend", target)).defaultPrevented).toBe(true);
    add.mockRestore();
    remove.mockRestore();
  });

  it("swallows the lift after a hold so it presses nothing", async () => {
    const host = await mountChat(bot([botMsg("b1", "hello there")]));
    stubTouchScreen();
    const lift = await hold(content(host, "b1"));
    expect(lift.defaultPrevented).toBe(true);
    expect(storeMessage("thread-helper", "b1")?.reactions).toBeUndefined();
    expect(messageMenu()).not.toBeNull();
  });

  it("hands the held word to native selection with Select text until an outside tap", async () => {
    const host = await mountChat(bot([botMsg("b1", "first reply"), botMsg("b2", "second reply")]));
    stubTouchScreen();
    await selectAt(host, "b1", (el) => [textNode(el, "first"), 2]);

    expect(messageMenu()).toBeNull();
    expect(row(host, "b1").hasAttribute("data-select-mode")).toBe(true);
    expect(row(host, "b2").hasAttribute("data-select-mode")).toBe(false);
    expect(window.getSelection()?.toString()).toBe("first");

    await hold(content(host, "b1"));
    expect(messageMenu()).toBeNull();
    const native = new MouseEvent("contextmenu", { bubbles: true, cancelable: true });
    await act(async () => { content(host, "b1").dispatchEvent(native); });
    expect(native.defaultPrevented).toBe(false);

    await touch("touchstart", host.querySelector("[data-orbit-composer]")!, [[10, 10]]);
    expect(row(host, "b1").hasAttribute("data-select-mode")).toBe(false);
    await hold(content(host, "b1"));
    expect(messageMenu()).not.toBeNull();
  });

  it("clears only the script selection on the first inside touch", async () => {
    const host = await mountChat(bot([botMsg("b1", "first reply")]));
    stubTouchScreen();
    await selectAt(host, "b1", (el) => [textNode(el, "first"), 2]);
    const el = content(host, "b1");
    const sel = window.getSelection()!;
    expect(sel.toString()).toBe("first");

    expect((await touch("touchstart", el, [[100, 120]])).defaultPrevented).toBe(false);
    expect(sel.rangeCount).toBe(0);
    expect(row(host, "b1").hasAttribute("data-select-mode")).toBe(true);
    const node = textNode(el, "first");
    sel.setBaseAndExtent(node, 0, node, 5);
    await hold(el);
    expect(sel.toString()).toBe("first");
    sel.setBaseAndExtent(node, 0, node, node.length);
    await hold(el);
    expect(sel.toString()).toBe("first reply");
    expect(messageMenu()).toBeNull();
  });

  it("keeps the selected word on mousedown before handing it to touch", async () => {
    const host = await mountChat(bot([botMsg("b1", "first reply")]));
    stubTouchScreen();
    await selectAt(host, "b1", (el) => [textNode(el, "first"), 2]);
    const el = content(host, "b1");
    await act(async () => { el.dispatchEvent(new MouseEvent("mousedown", { bubbles: true })); });
    expect(window.getSelection()?.toString()).toBe("first");
    expect(row(host, "b1").hasAttribute("data-select-mode")).toBe(true);
    await touch("touchstart", el, [[100, 120]]);
    expect(window.getSelection()?.rangeCount).toBe(0);
  });

  it("selects the held Korean word", async () => {
    localStorage.setItem("omb-locale", "ko");
    const host = await mountChat(bot([botMsg("b1", "안녕하세요 메시지를 확인했어요")]));
    stubTouchScreen();
    await selectAt(host, "b1", (el) => [textNode(el, "메시지를"), 8]);
    expect(window.getSelection()?.toString()).toBe("메시지를");
  });

  it("selects the nearest word at a word end, on a space, on punctuation or in the padding", async () => {
    const host = await mountChat(bot([botMsg("b1", "hello there, friend")]));
    stubTouchScreen();
    const cases: Array<[(el: Element) => [Node, number], string]> = [
      [(el) => [textNode(el, "hello"), 11], "there"],
      [(el) => [textNode(el, "hello"), 12], "there"],
      [(el) => [textNode(el, "hello"), 13], "friend"],
      [(el) => [textNode(el, "hello"), 5], "hello"],
      [(el) => [el, 0], "hello"],
      [(el) => [textNode(el, "hello").parentNode!, 1], "friend"],
    ];
    for (const [at, word] of cases) {
      await selectAt(host, "b1", at);
      expect(window.getSelection()?.toString()).toBe(word);
      await tapOutside();
    }
  });

  it("falls back to the whole message when no word is under the hold", async () => {
    const host = await mountChat(bot([botMsg("b1", "first reply"), botMsg("b2", "second reply")]));
    stubTouchScreen();
    const caret = await selectAt(host, "b1", () => null);
    expect(caret).toHaveBeenCalledWith(100, 120);
    expect(window.getSelection()?.toString()).toBe("first reply");
    await tapOutside();

    await selectAt(host, "b1", () => [textNode(content(host, "b2"), "second"), 2]);
    expect(window.getSelection()?.toString()).toBe("first reply");
    await tapOutside();

    const el = content(host, "b1");
    const outside = stubCaret(() => [textNode(el, "first"), 2]);
    place(el, { y: 200 });
    await hold(el);
    await selectText();
    expect(outside).not.toHaveBeenCalled();
    expect(window.getSelection()?.toString()).toBe("first reply");
  });

  it("finds the held word after the transcript moves", async () => {
    const host = await mountChat(bot([botMsg("b1", "first reply")]));
    stubTouchScreen();
    const el = content(host, "b1");
    place(row(host, "b1"), { y: 100 });
    place(el, {});
    let selectable = false;
    let menuGone = false;
    const caret = stubCaret(() => {
      selectable = row(host, "b1").hasAttribute("data-select-mode");
      menuGone = messageMenu() === null;
      return [textNode(el, "reply"), 8];
    });
    await hold(el);
    place(row(host, "b1"), { y: 40 });
    await selectText();
    expect(caret).toHaveBeenCalledWith(100, 60);
    expect(selectable).toBe(true);
    expect(menuGone).toBe(true);
    expect(window.getSelection()?.toString()).toBe("reply");
  });

  it("selects the held word in a room", async () => {
    const roomBot: Message = { ...botMsg("b1", "room hello"), from: { botId: "m1", name: "Ada", color: "blue" } };
    const host = await mountRoom(members, room([userMsg("u1", "hi all"), roomBot]));
    stubTouchScreen();
    await selectAt(host, "b1", (el) => [textNode(el, "room"), 7]);
    expect(row(host, "b1").hasAttribute("data-select-mode")).toBe(true);
    expect(window.getSelection()?.toString()).toBe("hello");
    await tapOutside();
    await selectAt(host, "u1", (el) => [textNode(el, "hi all"), 0]);
    expect(window.getSelection()?.toString()).toBe("hi");
  });

  it("ends select mode when another message's menu opens", async () => {
    const host = await mountChat(bot([botMsg("b1", "first reply"), botMsg("b2", "second reply")]));
    stubTouchScreen();
    await hold(content(host, "b1"));
    await act(async () => { document.querySelector("[data-menu-select]")!.dispatchEvent(new MouseEvent("click", { bubbles: true })); });
    await hold(content(host, "b2"));
    expect(messageMenu()).not.toBeNull();
    expect(row(host, "b1").hasAttribute("data-select-mode")).toBe(false);
  });

  it("keeps the phone's own hold on links and images", async () => {
    const host = await mountChat(bot([botMsg("b1", "read the [docs](https://example.com/guide) and ![shot](https://example.com/shot.png)")]));
    stubTouchScreen();
    for (const selector of ['a[href="https://example.com/guide"]', 'img[src="https://example.com/shot.png"]']) {
      const el = host.querySelector(`[data-mid="b1"] ${selector}`)!;
      expect(el, selector).not.toBeNull();
      await touch("touchstart", el, [[100, 120]]);
      const native = new MouseEvent("contextmenu", { bubbles: true, cancelable: true });
      await act(async () => { el.dispatchEvent(native); });
      await wait(500);
      expect((await touch("touchend", el)).defaultPrevented, selector).toBe(false);
      expect(native.defaultPrevented, selector).toBe(false);
      expect(messageMenu(), selector).toBeNull();
    }
    await hold(content(host, "b1"));
    expect(messageMenu()).not.toBeNull();
  });

  it("holds a Back entry and Back closes only the menu", async () => {
    const opened: boolean[] = [];
    const onMenu = (event: CustomEvent<boolean>) => opened.push(event.detail);
    window.addEventListener("orbit:message-menu", onMenu);
    try {
      const host = await mountChat(bot([botMsg("b1", "hello there")]));
      stubTouchScreen();
      await hold(content(host, "b1"));
      expect(opened).toEqual([true]);
      await act(async () => { window.dispatchEvent(new Event("orbit:close-message-menu")); });
      expect(messageMenu()).toBeNull();
      expect(opened).toEqual([true, false]);
      expect(host.querySelector('[data-mid="b1"]')).not.toBeNull();
    } finally {
      window.removeEventListener("orbit:message-menu", onMenu);
    }
  });

  it("labels the touch menu in Korean", async () => {
    expect(en["chat.selectText"]).toBe("Select text");
    expect(ko["chat.selectText"]).toBe("텍스트 선택");
    localStorage.setItem("omb-locale", "ko");
    const host = await mountChat(bot([userMsg("u1", "mine"), botMsg("b1", "hello")]));
    stubTouchScreen();
    await hold(content(host, "b1"));
    expect(labels("[role=menuitem]:not([data-menu-expand])")).toEqual(["메시지 고정", "답장", "복사", "텍스트 선택"]);
    await tapOutside();
    await hold(content(host, "u1"));
    expect(labels("button")).toEqual(["메시지 고정", "답장", "복사", "텍스트 선택"]);
  });

  it("keeps the desktop menu on a touchscreen laptop with a mouse", async () => {
    const host = await mountChat(bot([botMsg("b1", "hello there")]));
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    await hold(content(host, "b1"));
    expect(messageMenu()).toBeNull();
    await rightClick(content(host, "b1"));
    expect(messageMenu()?.querySelector("[data-menu-select]")).toBeNull();
    expect(messageMenu()?.className).toContain("w-[248px]");
    expect(menuReactions()[0]!.className).toContain("size-8");
  });
});
