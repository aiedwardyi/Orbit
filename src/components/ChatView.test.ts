// @vitest-environment happy-dom
import { act, createElement, useState } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";

import { StoreProvider, type Bot, type Message } from "@/state/store";

import { ChatView } from "./ChatView";
import type { TurnStreamState } from "@/lib/turn-stage";

const live = vi.hoisted(() => ({ current: { streaming: {}, reasoning: {}, signal: {}, gen: {}, turn: {} } as TurnStreamState }));
vi.mock("@/state/store", async (importOriginal) => ({
  ...await importOriginal<typeof import("@/state/store")>(),
  useStreaming: () => live.current,
}));
vi.mock("shiki", () => ({ codeToHtml: async (code: string) => `<pre><code>${code}</code></pre>` }));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

class FakeEventSource {
  onmessage: ((event: { data: string; lastEventId: string }) => void) | null = null;
  close = vi.fn();
}

const PRESENCE_ROW_PX = 48;
const VIEWPORT_PX = 400;
const TRANSCRIPT_PX = 1000;

const baseBot = {
  title: "",
  description: "",
  notifications: false,
  color: "iris",
  unread: false,
  modelSelection: { instanceId: "inst", model: "m" },
  messages: [],
} as unknown as Bot;

const userMsg = (id: string, text: string): Message => ({ id, at: 1, role: "user", kind: "text", text });

const botA = {
  ...baseBot,
  id: "a",
  threadId: "thread-a",
  name: "A",
  busy: true,
  activity: "working",
  messages: [userMsg("ua", "question for A")],
} as Bot;
const botB = {
  ...baseBot,
  id: "b",
  threadId: "thread-b",
  name: "B",
  messages: [userMsg("ub", "question for B")],
} as Bot;

let switchBot: (id: "a" | "b") => void = () => {};

function Harness() {
  const [current, setCurrent] = useState<Bot>(botA);
  switchBot = (id) => setCurrent(id === "a" ? botA : botB);
  return createElement(ChatView, { bot: current });
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

afterEach(() => {
  live.current = { streaming: {}, reasoning: {}, signal: {}, gen: {}, turn: {} };
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  localStorage.clear();
});

describe("ChatView reply settle", () => {
  it.each(["user", "tools", "legacy"])("keeps the reply row and code card after a %s tail", async (tail) => {
    vi.stubGlobal("EventSource", FakeEventSource);
    vi.stubGlobal("fetch", vi.fn(async () => new Response("{}", { status: 404 })));
    vi.stubGlobal("ResizeObserver", class {
      observe() {}
      unobserve() {}
      disconnect() {}
    });
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const host = document.createElement("div");
    document.body.append(host);
    const root = createRoot(host);
    const text = "```js\nconsole.log('stable');\n```";
    const messages: Message[] = tail === "tools" ? [
      ...botA.messages,
      { id: "tool-1", parentId: "ua", at: 1, role: "bot", kind: "activity", tool: { name: "Read", ok: true } },
      { id: "tool-2", parentId: "tool-1", at: 1, role: "bot", kind: "activity", tool: { name: "Read", ok: true } },
    ] : botA.messages;
    const current = { ...botA, messages };
    const parentId = messages.at(-1)!.id;
    const reply: Message = { id: "reply-a", parentId: tail === "legacy" ? undefined : parentId, at: 2, role: "bot", kind: "text", text };
    const completed = { ...current, messages: [...messages, reply], activeLeafId: tail === "legacy" ? undefined : reply.id };
    const render = async (bot: Bot) => {
      await act(async () => root.render(createElement(StoreProvider, null, createElement(ChatView, { bot }))));
    };
    try {
      live.current = { streaming: { "thread-a": text }, reasoning: {}, signal: {}, turn: { "thread-a": `0:${parentId}` } };
      await render(current);
      await act(async () => { await sleep(300); });
      const user = host.querySelector('[data-orbit-message="user"]');
      const row = host.querySelector('[data-orbit-message="bot"]');
      const body = row?.querySelector("[data-orbit-message-body]");
      const content = row?.querySelector("[data-orbit-message-content]");
      const markdown = row?.querySelector(".chat-md");
      const card = markdown?.firstElementChild;
      const copy = card?.querySelector("button");
      const code = card?.querySelector("pre");
      expect.soft(body).not.toBeNull();
      expect(copy).toBeTruthy();
      const widths = [row?.className, body?.className, content?.className];
      await render(completed);
      expect.soft(host.querySelectorAll('[data-orbit-message="bot"]')).toHaveLength(1);
      expect.soft(host.querySelector('[data-orbit-message="bot"]')).toBe(row);
      expect.soft(host.querySelector(".chat-md")).toBe(markdown);
      expect.soft(host.querySelector('.chat-md button')).toBe(copy);
      live.current = { streaming: {}, reasoning: {}, signal: {}, turn: {} };
      await render({ ...completed, busy: false, activity: "idle" });
      await act(async () => { await sleep(600); });
      const settled = host.querySelector('[data-orbit-message="bot"]');
      expect.soft(settled).toBe(row);
      expect.soft(settled?.querySelector("[data-orbit-message-body]")).toBe(body);
      expect.soft(settled?.querySelector("[data-orbit-message-content]")).toBe(content);
      expect.soft(settled?.querySelector(".chat-md")?.firstElementChild).toBe(card);
      expect.soft(settled?.querySelector("pre")).toBe(code);
      expect.soft(host.querySelector('[data-orbit-message="user"]')).toBe(user);
      expect.soft([
        settled?.className,
        settled?.querySelector("[data-orbit-message-body]")?.className,
        settled?.querySelector("[data-orbit-message-content]")?.className,
      ]).toEqual(widths);
      const followup = { ...userMsg("followup", "Next question"), parentId: reply.id, at: 3 };
      live.current = { streaming: { "thread-a": "Second reply" }, reasoning: {}, signal: {}, turn: { "thread-a": "0:followup" } };
      await render({ ...completed, messages: [...completed.messages, followup], activeLeafId: tail === "legacy" ? undefined : followup.id });
      expect(host.querySelectorAll('[data-orbit-message="bot"]')).toHaveLength(2);
      expect(host.querySelector('[data-orbit-message="bot"]')).toBe(row);
      expect(row?.querySelector("pre")).toBe(code);
    } finally {
      await act(async () => root.unmount());
      host.remove();
    }
  });
});

describe("ChatView note collapse", () => {
  it("collapses a note to its header and expands the full text on click", async () => {
    vi.stubGlobal("EventSource", FakeEventSource);
    vi.stubGlobal("fetch", vi.fn(async () => new Response("{}", { status: 404 })));
    vi.stubGlobal("ResizeObserver", class {
      observe() {}
      unobserve() {}
      disconnect() {}
    });
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const host = document.createElement("div");
    document.body.append(host);
    const root = createRoot(host);
    const labeled: Message = { id: "note-1", at: 1, role: "bot", kind: "note", text: "[pane 0f3c9a1e] [OPUS | MED] from worker (w1): tests pass" };
    const unlabeled: Message = { id: "note-2", at: 2, role: "bot", kind: "note", text: "[pane 0f3c9a1e] from worker (w1): still running" };
    const current = { ...botA, messages: [userMsg("ua", "go"), labeled, unlabeled] } as Bot;
    try {
      await act(async () => root.render(createElement(StoreProvider, null, createElement(ChatView, { bot: current }))));
      const buttons = Array.from(host.querySelectorAll("button")).filter((b) => b.textContent?.startsWith("Note from"));
      expect(buttons.map((b) => b.textContent)).toEqual(["Note from OPUS | MED", "Note from pane 0f3c9a1e"]);
      expect(host.querySelector("[data-orbit-note]")).toBeNull();
      await act(async () => { buttons[0]!.click(); });
      expect(host.querySelector("[data-orbit-note]")?.textContent).toBe("[pane 0f3c9a1e] [OPUS | MED] from worker (w1): tests pass");
      await act(async () => { buttons[0]!.click(); });
      expect(host.querySelector("[data-orbit-note]")).toBeNull();
    } finally {
      await act(async () => root.unmount());
      host.remove();
    }
  });
});

describe("ChatView bot switch while busy", () => {
  it("lands pinned with no stale presence row and no second shift", async () => {
    vi.stubGlobal("EventSource", FakeEventSource);
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ error: "not in this test" }), { status: 404 })));
    vi.stubGlobal("ResizeObserver", class {
      observe() {}
      unobserve() {}
      disconnect() {}
    });
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const host = document.createElement("div");
    document.body.append(host);
    const root = createRoot(host);
    try {
      await act(async () => {
        root.render(createElement(StoreProvider, null, createElement(Harness)));
      });
      const scroller = host.querySelector("[data-orbit-transcript]") as HTMLElement;
      const content = scroller.firstElementChild as HTMLElement;
      const presence = () => content.querySelector(".turn-presence") !== null;
      Object.defineProperty(scroller, "clientHeight", { configurable: true, get: () => VIEWPORT_PX });
      Object.defineProperty(scroller, "scrollHeight", {
        configurable: true,
        get: () => TRANSCRIPT_PX + (presence() ? PRESENCE_ROW_PX : 0),
      });
      // Browser-like clamp: scrollTo past the end sticks to the end.
      scroller.scrollTo = ((opts?: ScrollToOptions) => {
        scroller.scrollTop = Math.max(0, Math.min(opts?.top ?? 0, scroller.scrollHeight - scroller.clientHeight));
      }) as typeof scroller.scrollTo;
      expect(presence()).toBe(true);

      await act(async () => {
        switchBot("b");
      });
      expect(host.textContent).toContain("question for B");
      expect(host.textContent).not.toContain("question for A");
      // The old thread's presence row never renders under the new bot.
      expect(presence()).toBe(false);
      // Pinned: scrollTop equals scrollHeight - clientHeight after switch.
      expect(scroller.scrollTop).toBe(scroller.scrollHeight - scroller.clientHeight);
      const settledTop = scroller.scrollTop;

      await act(async () => {
        await sleep(400);
      });
      expect(presence()).toBe(false);
      expect(scroller.scrollTop).toBe(settledTop);
      expect(scroller.scrollTop).toBe(scroller.scrollHeight - scroller.clientHeight);
    } finally {
      await act(async () => root.unmount());
      host.remove();
    }
  });
});
