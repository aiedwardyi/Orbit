// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";

import { applyLocale } from "@/lib/i18n";
import { swipeBlocked } from "@/lib/phone-swipe";
import { SIDEBAR_SIDE_KEY } from "@/lib/sidebar-preferences";
import { forgetTurns } from "@/lib/turn-index";
import { StoreProvider, useStore, type Bot, type Message } from "@/state/store";

import { ChatView } from "./ChatView";

class FakeEventSource {
  static last: FakeEventSource | null = null;
  onmessage: ((event: { data: string; lastEventId: string }) => void) | null = null;
  close = vi.fn();
  constructor() {
    FakeEventSource.last = this;
  }
}

const start = new Date(2026, 9, 16, 9).getTime();
const chat = (p: string): Message[] => [
  { id: `${p}-hello`, at: start, role: "bot", kind: "text", text: "Hi" },
  ...Array.from({ length: 5 }, (_, t): Message[] => [
    { id: `${p}${t}`, parentId: t ? `${p}${t - 1}-reply` : `${p}-hello`, at: start + (t + 1) * 600_000, role: "user", kind: "text", text: `${p} turn ${t}` },
    { id: `${p}${t}-reply`, parentId: `${p}${t}`, at: start + (t + 1) * 600_000 + 1000, role: "bot", kind: "text", text: "ok" },
  ]).flat(),
];
const bot = (p: string): Bot => ({
  id: p, threadId: `thread-${p}`, name: p.toUpperCase(), title: "", description: "", notifications: false,
  color: "blue", unread: false, modelSelection: { instanceId: "inst", model: "m" }, messages: chat(p), hasMore: true,
});
const index = (p: string) => ({
  ids: Array.from({ length: 5 }, (_, t) => `${p}${t}`),
  at: [Math.floor((start + 600_000) / 1000), 600, 600, 600, 600],
  words: Array.from({ length: 5 }, (_, t) => `${p} turn ${t}`),
  first: `${p}-hello`,
});

let unmount: (() => Promise<void>) | null = null;
let store: ReturnType<typeof useStore>;

afterEach(async () => {
  await unmount?.();
  unmount = null;
  forgetTurns();
  localStorage.clear();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

async function mount({ width = 1000, height = 800, touch = false } = {}) {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  applyLocale("en");
  const calls: string[] = [];
  vi.stubGlobal("EventSource", FakeEventSource);
  vi.stubGlobal("ResizeObserver", class {
    observe() {}
    unobserve() {}
    disconnect() {}
  });
  vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
    const path = String(url);
    calls.push(`${init?.method ?? "GET"} ${path}`);
    if (path === "/api/bots?messages=200") return Response.json({ bots: [bot("a"), bot("b")], groups: [], computerControl: {} });
    const turns = path.match(/^\/api\/threads\/thread-(\w)\/turns$/);
    if (turns) return Response.json(index(turns[1]!));
    if (init?.method === "POST" && path.endsWith("/messages")) return Response.json({ ok: true, queued: true, queueId: "q1", threadId: "thread-b" }, { status: 202 });
    return new Promise<Response>(() => {});
  }));
  if (touch) vi.stubGlobal("matchMedia", (query: string) => ({ matches: query === "(hover: none)", media: query, addEventListener() {}, removeEventListener() {} }));
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(HTMLElement.prototype, "offsetWidth", "get").mockReturnValue(width);
  vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockReturnValue(width - 8);
  vi.spyOn(HTMLElement.prototype, "clientHeight", "get").mockReturnValue(height);
  function Live() {
    store = useStore();
    const shown = store.state.bots.find((candidate) => candidate.id === store.state.selectedId) ?? store.state.bots[0];
    return shown ? createElement(ChatView, { bot: shown }) : null;
  }
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  await act(async () => root.render(createElement(StoreProvider, null, createElement(Live))));
  unmount = async () => {
    await act(async () => root.unmount());
    host.remove();
  };
  await act(async () => {
    FakeEventSource.last!.onmessage!({ data: JSON.stringify({ kind: "hello", resumed: false, cursor: "c1" }), lastEventId: "" });
  });
  await vi.waitFor(() => expect(host.textContent).toContain("a turn 4"));
  const strip = () => host.querySelector<HTMLElement>("[data-turn-rail-strip]")!;
  // the rail measures itself a frame after it shows
  await vi.waitFor(() => expect(strip().style.height).toBe(`${height - (width < 640 ? 8 : 16)}px`));
  const scroller = host.querySelector<HTMLElement>("[data-orbit-transcript]")!;
  const turnCalls = () => calls.filter((call) => call.includes("/turns"));
  const select = (id: string) => act(async () => store.dispatch({ type: "select", id }));
  const near = () => act(async () => scroller.dispatchEvent(new PointerEvent("pointermove", { pointerType: "mouse", clientX: 990, clientY: 400, bubbles: true })));
  // the rail's own box starts 16 px down, so a rail y is clientY - 16
  const hover = (clientY: number) => act(async () => strip().dispatchEvent(new PointerEvent("pointerenter", { pointerType: "mouse", clientX: 985, clientY })));
  return { host, calls, turnCalls, strip, scroller, select, near, hover };
}

describe("timeline rail", () => {
  it("asks for no turns on bot switch, send or arrivals, then once on approach, and keeps them", async () => {
    const ui = await mount();
    await ui.select("b");
    await vi.waitFor(() => expect(ui.host.textContent).toContain("b turn 4"));
    const box = ui.host.querySelector("textarea")!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(box, "one more");
      box.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await act(async () => box.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", code: "Enter", keyCode: 13, bubbles: true, cancelable: true })));
    await vi.waitFor(() => expect(ui.calls).toContain("POST /api/bots/b/messages"));
    await act(async () => store.dispatch({ type: "messageAdded", threadId: "thread-b", message: { id: "b-sent", parentId: "b4-reply", at: start + 4_000_000, role: "user", kind: "text", text: "one more" } }));
    await act(async () => store.dispatch({ type: "messageAdded", threadId: "thread-b", message: { id: "b-sent-reply", parentId: "b-sent", at: start + 4_001_000, role: "bot", kind: "text", text: "done" } }));
    await ui.select("a");
    expect(ui.turnCalls()).toEqual([]);

    await ui.near();
    await vi.waitFor(() => expect(ui.strip().getAttribute("aria-valuemax")).toBe("5"));
    expect(ui.turnCalls()).toEqual(["GET /api/threads/thread-a/turns"]);

    await ui.select("b");
    await ui.near();
    await vi.waitFor(() => expect(ui.strip().getAttribute("aria-valuemax")).toBe("6"));
    await ui.select("a");
    await ui.near();
    await vi.waitFor(() => expect(ui.strip().getAttribute("aria-valuemax")).toBe("5"));
    expect(ui.turnCalls()).toEqual(["GET /api/threads/thread-a/turns", "GET /api/threads/thread-b/turns"]);
  });

  it("adds a turn that lands while the rail is awake, with no new request", async () => {
    const ui = await mount();
    await ui.near();
    await vi.waitFor(() => expect(ui.strip().getAttribute("aria-valuemax")).toBe("5"));
    await act(async () => store.dispatch({ type: "messageAdded", threadId: "thread-a", message: { id: "a-phone", parentId: "a4-reply", at: start + 5_000_000, role: "user", kind: "text", text: "sent from the phone" } }));
    await vi.waitFor(() => expect(ui.strip().getAttribute("aria-valuemax")).toBe("6"));
    expect(ui.turnCalls()).toHaveLength(1);
  });

  it("asks again when another PC moves the chat back to an earlier branch", async () => {
    const ui = await mount();
    await ui.near();
    await act(async () => store.dispatch({ type: "messageAdded", threadId: "thread-a", message: { id: "a-phone", parentId: "a4-reply", at: start + 5_000_000, role: "user", kind: "text", text: "sent from the phone" } }));
    await vi.waitFor(() => expect(ui.strip().getAttribute("aria-valuemax")).toBe("6"));
    await act(async () => store.dispatch({ type: "threadActive", threadId: "thread-a", activeLeafId: "a4-reply" }));
    await ui.near();
    await vi.waitFor(() => expect(ui.strip().getAttribute("aria-valuemax")).toBe("5"));
    expect(ui.turnCalls()).toHaveLength(2);
  });

  it("jumps through focusMessage, and its ends land on the first and the latest message", async () => {
    const ui = await mount();
    await ui.near();
    await vi.waitFor(() => expect(ui.strip().getAttribute("aria-valuemax")).toBe("5"));
    await ui.hover(16 + 384);
    expect(ui.strip().getAttribute("aria-valuenow")).toBe("3");
    expect(ui.strip().getAttribute("aria-valuetext")).toMatch(/, a turn 2$/);
    await act(async () => ui.strip().click());
    expect(store.state.focusMessage).toMatchObject({ threadId: "thread-a", messageId: "a2" });

    await ui.hover(16 + 1);
    await act(async () => ui.strip().click());
    expect(store.state.focusMessage).toMatchObject({ messageId: "a-hello" });

    const scrollTo = vi.spyOn(ui.scroller, "scrollTo");
    await ui.hover(16 + 784);
    await act(async () => ui.strip().click());
    expect(store.state.focusMessage).toMatchObject({ messageId: "a-hello" });
    await vi.waitFor(() => expect(scrollTo).toHaveBeenCalledWith({ top: expect.any(Number), behavior: "smooth" }));
  });

  it("keeps phone swipes off the rail and the open card", async () => {
    const ui = await mount();
    await ui.near();
    await vi.waitFor(() => expect(ui.strip().getAttribute("aria-valuemax")).toBe("5"));
    await ui.hover(400);
    const card = ui.host.querySelector<HTMLElement>("[data-turn-card]")!;
    await vi.waitFor(() => expect(card.classList.contains("live")).toBe(true));
    expect(swipeBlocked(ui.strip(), 500)).toBe(true);
    expect(swipeBlocked(card.querySelector(".turn-card-row")!, 500)).toBe(true);
    expect(swipeBlocked(ui.host.querySelector('[data-mid="a2"]')!.lastElementChild!, 500)).toBe(false);
  });

  it("keeps a touch on the rail or the card from becoming a browser fling", async () => {
    const ui = await mount();
    for (const target of [ui.strip(), ui.host.querySelector<HTMLElement>("[data-turn-card]")!]) {
      const touch = new TouchEvent("touchstart", { bubbles: true, cancelable: true });
      target.dispatchEvent(touch);
      expect(touch.defaultPrevented).toBe(true);
    }
  });

  it.each(["left", "right"])("opens no card over the composer when a phone transcript is too short for it, drawer on the %s", async (side) => {
    localStorage.setItem(SIDEBAR_SIDE_KEY, side);
    const ui = await mount({ width: 390, height: 200, touch: true });
    const card = ui.host.querySelector<HTMLElement>("[data-turn-card]")!;
    await act(async () => ui.strip().dispatchEvent(new PointerEvent("pointerdown", { pointerType: "touch", pointerId: 1, clientY: 100, bubbles: true, cancelable: true })));
    await vi.waitFor(() => expect(ui.strip().getAttribute("aria-valuemax")).toBe("5"));
    expect(card.classList.contains("live")).toBe(false);
    await act(async () => ui.strip().dispatchEvent(new PointerEvent("pointerup", { pointerType: "touch", pointerId: 1, clientY: 100, bubbles: true })));
    expect(card.classList.contains("live")).toBe(false);
  });

  it("sits on the right edge, clear of the scrollbar, while the drawer is on the left", async () => {
    const ui = await mount();
    expect(ui.strip().style.right).toBe("8px");
    expect(ui.strip().style.left).toBe("");
  });

  it("stays on the right edge when the drawer is on the right", async () => {
    localStorage.setItem(SIDEBAR_SIDE_KEY, "right");
    const ui = await mount();
    expect(ui.strip().style.right).toBe("8px");
    expect(ui.strip().style.left).toBe("");
    expect(ui.host.querySelector<HTMLElement>(".turn-rail")!.style.transform).toBe("");
  });
});
