// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";

import { StoreProvider, useStore, type Bot, type Group, type Message } from "@/state/store";
import type { TurnStreamState } from "@/lib/turn-stage";

import { ChatView } from "./ChatView";
import { GroupView } from "./GroupView";

const live = vi.hoisted(() => ({ current: { streaming: {}, reasoning: {}, signal: {}, gen: {}, turn: {} } as TurnStreamState }));
vi.mock("@/state/store", async (importOriginal) => ({
  ...await importOriginal<typeof import("@/state/store")>(),
  useStreaming: () => live.current,
}));
vi.mock("shiki", () => ({ codeToHtml: async (code: string) => `<pre><code>${code}</code></pre>` }));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

class FakeEventSource {
  static last: FakeEventSource | null = null;
  onmessage: ((event: { data: string; lastEventId: string }) => void) | null = null;
  close = vi.fn();
  constructor() {
    FakeEventSource.last = this;
  }
}

const row = (i: number): Message => ({ id: `m${i}`, at: 1, role: "user", kind: "text", text: `row ${i};` });
const rows = (from: number, to: number) => Array.from({ length: to - from }, (_, i) => row(from + i));

const bot = (messages: Message[], hasMore: boolean) =>
  ({
    id: "a",
    threadId: "thread-a",
    name: "A",
    title: "",
    description: "",
    notifications: false,
    color: "iris",
    unread: false,
    modelSelection: { instanceId: "inst", model: "m" },
    messages,
    hasMore,
  }) as unknown as Bot;

const room = (messages: Message[], hasMore: boolean) =>
  ({
    id: "g",
    threadId: "thread-g",
    name: "Room",
    memberIds: [],
    defaultResponder: { kind: "everyone" },
    bulletin: "",
    unread: false,
    createdAt: 1,
    setupCompletedAt: 1,
    messages,
    hasMore,
  }) as unknown as Group;

/** Serves `thread` in pages the way the scrollback endpoint does. */
function pagedServer(threadId: string, thread: Message[], snapshot: { bots: Bot[]; groups: Group[] }) {
  const calls: string[] = [];
  vi.stubGlobal("fetch", vi.fn(async (url: string) => {
    const path = String(url);
    calls.push(path);
    if (path === "/api/bots?messages=200") return Response.json({ ...snapshot, computerControl: {} });
    const page = path.match(new RegExp(`^/api/threads/${threadId}/messages\\?limit=(\\d+)&before=(\\w+)$`));
    if (page) {
      const stop = thread.findIndex((message) => message.id === page[2]);
      const start = Math.max(0, stop - Number(page[1]));
      return Response.json({ messages: thread.slice(start, stop), hasMore: start > 0 });
    }
    const around = path.match(new RegExp(`^/api/threads/${threadId}/messages\\?around=(\\w+)&limit=(\\d+)$`));
    if (around) {
      const limit = Number(around[2]);
      const index = thread.findIndex((message) => message.id === around[1]);
      const start = Math.max(0, Math.min(index - Math.floor((limit - 1) / 2), thread.length - limit));
      return Response.json({ messages: thread.slice(start, start + limit), hasMore: start > 0 });
    }
    return new Promise<Response>(() => {});
  }));
  return calls;
}

const arrive = (threadId: string, message: Message) =>
  act(async () => store.dispatch({ type: "messageAdded", threadId, message }));

let unmount: (() => Promise<void>) | null = null;
let store: ReturnType<typeof useStore>;
let resizeCallbacks: (() => void)[] = [];

afterEach(async () => {
  await unmount?.();
  unmount = null;
  resizeCallbacks = [];
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  localStorage.clear();
});

async function mount(view: "chat" | "room") {
  vi.stubGlobal("EventSource", FakeEventSource);
  vi.stubGlobal("ResizeObserver", class {
    constructor(callback: () => void) {
      resizeCallbacks.push(callback);
    }
    observe() {}
    unobserve() {}
    disconnect() {}
  });
  vi.spyOn(console, "warn").mockImplementation(() => {});
  function Live() {
    store = useStore();
    const b = store.state.bots.find((candidate) => candidate.id === store.state.selectedId) ?? store.state.bots[0];
    const g = store.state.groups[0];
    if (view === "chat") return b ? createElement(ChatView, { bot: b }) : null;
    return g ? createElement(GroupView, { group: g }) : null;
  }
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  await act(async () => root.render(createElement(StoreProvider, null, createElement(Live))));
  await act(async () => {
    FakeEventSource.last!.onmessage!({ data: JSON.stringify({ kind: "hello", resumed: false, cursor: "c1" }), lastEventId: "" });
  });
  unmount = async () => {
    await act(async () => root.unmount());
    host.remove();
  };
  return host;
}

const lettered = (p: string, length: number) =>
  Array.from({ length }, (_, i): Message => ({ id: `${p}${i}`, at: 1, role: "user", kind: "text", text: `${p} row ${i};` }));
const touch = (el: HTMLElement, type: string, clientY: number) => {
  const event = new Event(type, { bubbles: true });
  Object.defineProperty(event, "touches", { value: [{ clientY }] });
  el.dispatchEvent(event);
};

const button = (host: HTMLElement, label: string) =>
  Array.from(host.querySelectorAll("button")).find((b) => b.textContent?.includes(label));

describe("paged transcripts", () => {
  it("hydrates each conversation with one bounded page", async () => {
    const thread = rows(0, 500);
    const calls = pagedServer("thread-a", thread, { bots: [bot(thread.slice(-200), true)], groups: [] });
    const host = await mount("chat");
    await vi.waitFor(() => expect(host.textContent).toContain("row 499;"));
    expect(calls).toContain("/api/bots?messages=200");
    expect(calls).not.toContain("/api/bots");
  });

  it("loads older pages on Show earlier, keeps the reader's place, and stops at the top", async () => {
    const thread = rows(0, 500);
    const calls = pagedServer("thread-a", thread, { bots: [bot(thread.slice(-100), true)], groups: [] });
    const host = await mount("chat");
    await vi.waitFor(() => expect(host.textContent).toContain("row 499;"));
    expect(host.textContent).not.toContain("row 399;");

    const scroller = host.querySelector("[data-orbit-transcript]") as HTMLElement;
    Object.defineProperty(scroller, "scrollHeight", {
      configurable: true,
      get: () => host.querySelectorAll("[data-mid]").length * 10,
    });
    scroller.scrollTop = 0;
    await act(async () => button(host, "Show earlier messages")!.click());
    await vi.waitFor(() => expect(host.textContent).toContain("row 280;"));
    expect(calls).toContain("/api/threads/thread-a/messages?limit=200&before=m400");
    expect(host.textContent).not.toContain("row 279;");
    expect(scroller.scrollTop).toBe(1200);

    await act(async () => button(host, "Show earlier messages (80 more)")!.click());
    expect(host.textContent).toContain("row 200;");
    await act(async () => button(host, "Show earlier messages")!.click());
    await vi.waitFor(() => expect(store.state.bots[0]!.messages).toHaveLength(500));
    await act(async () => button(host, "Show earlier messages (80 more)")!.click());
    expect(host.textContent).toContain("row 0;");
    expect(button(host, "Show earlier messages")).toBeUndefined();
    expect(calls.filter((call) => call.includes("before="))).toEqual([
      "/api/threads/thread-a/messages?limit=200&before=m400",
      "/api/threads/thread-a/messages?limit=200&before=m200",
    ]);
  });

  it("pages a room back the same way", async () => {
    const thread = rows(0, 250);
    const calls = pagedServer("thread-g", thread, { bots: [], groups: [room(thread.slice(-50), true)] });
    const host = await mount("room");
    await vi.waitFor(() => expect(host.textContent).toContain("row 249;"));
    await act(async () => button(host, "Show earlier messages")!.click());
    await vi.waitFor(() => expect(store.state.groups[0]!.messages).toHaveLength(250));
    expect(store.state.groups[0]!.hasMore).toBe(false);
    expect(calls).toContain("/api/threads/thread-g/messages?limit=200&before=m200");
  });

  it("pages back to a search hit older than every loaded page", async () => {
    const thread = rows(0, 600);
    pagedServer("thread-a", thread, { bots: [bot(thread.slice(-200), true)], groups: [] });
    const host = await mount("chat");
    await vi.waitFor(() => expect(host.textContent).toContain("row 599;"));
    await act(async () => store.dispatch({ type: "focusMessage", threadId: "thread-a", messageId: "m5" }));
    await vi.waitFor(() => expect(host.querySelector('[data-mid="m5"]')).not.toBeNull());
    expect(store.state.bots[0]!.messages).toHaveLength(200);
    // the window stays bounded around the hit instead of mounting the whole thread
    expect(host.querySelectorAll("[data-mid]").length).toBeLessThan(200);
  });

  it("reloads onto the selected branch when its leaf is older than the loaded page", async () => {
    const link = (i: number, parentId: string | null): Message => ({ ...row(i), parentId });
    const thread = [
      ...Array.from({ length: 100 }, (_, i) => link(i, i ? `m${i - 1}` : null)),
      ...Array.from({ length: 400 }, (_, i) => link(i + 100, i ? `m${i + 99}` : "m49")),
    ];
    pagedServer("thread-a", thread, { bots: [{ ...bot(thread.slice(-200), true), activeLeafId: "m99" }], groups: [] });
    const host = await mount("chat");
    await vi.waitFor(() => expect(host.textContent).toContain("row 99;"));
    expect(host.textContent).not.toContain("row 499;");
  });

  it("opens at the newest row when the selected branch lands from an older page", async () => {
    const link = (i: number, parentId: string | null): Message => ({ ...row(i), parentId });
    const thread = [
      ...Array.from({ length: 300 }, (_, i) => link(i, i ? `m${i - 1}` : null)),
      ...Array.from({ length: 200 }, (_, i) => link(i + 300, i ? `m${i + 299}` : "m149")),
    ];
    pagedServer("thread-a", thread, { bots: [{ ...bot(thread.slice(-200), true), activeLeafId: "m299" }], groups: [] });
    const host = await mount("chat");
    await vi.waitFor(() => expect(host.textContent).toContain("row 299;"));
    expect(host.textContent).not.toContain("row 100;");
    expect(button(host, "Show earlier messages (80 more)")).toBeDefined();
  });

  it("regenerates from a prompt older than the loaded page", async () => {
    const thread: Message[] = [
      { id: "m0", at: 1, role: "user", kind: "text", text: "the prompt;", parentId: null },
      ...Array.from({ length: 250 }, (_, i): Message => ({ id: `m${i + 1}`, at: 1, role: "bot", kind: "text", text: `step ${i + 1};`, parentId: `m${i}` })),
    ];
    const calls = pagedServer("thread-a", thread, { bots: [{ ...bot(thread.slice(-200), true), activeLeafId: "m250" }], groups: [] });
    const host = await mount("chat");
    await vi.waitFor(() => expect(store.state.bots[0]!.messages[0]!.id).toBe("m0"));
    await act(async () => (host.querySelector('[aria-label="Regenerate response"]') as HTMLElement).click());
    expect(calls).toContain("/api/bots/a/messages/m0/edit");
  });

  it("jumps within one bot while another bot's older page is still loading", async () => {
    const thread = (p: string) =>
      Array.from({ length: 600 }, (_, i): Message => ({ id: `${p}${i}`, at: 1, role: "user", kind: "text", text: `${p} row ${i};` }));
    const threads: Record<string, Message[]> = { "thread-a": thread("a"), "thread-b": thread("b") };
    const b = { ...bot(threads["thread-b"]!.slice(-200), true), id: "b", threadId: "thread-b", name: "B" } as Bot;
    let releaseA = () => {};
    const calls: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (url: string) => {
      const path = String(url);
      calls.push(path);
      if (path === "/api/bots?messages=200") {
        return Response.json({ bots: [bot(threads["thread-a"]!.slice(-200), true), b], groups: [], computerControl: {} });
      }
      const page = path.match(/^\/api\/threads\/([\w-]+)\/messages\?limit=(\d+)&before=(\w+)$/);
      if (page) {
        const all = threads[page[1]!]!;
        const stop = all.findIndex((message) => message.id === page[3]);
        const start = Math.max(0, stop - Number(page[2]));
        const body = () => Response.json({ messages: all.slice(start, stop), hasMore: start > 0 });
        if (page[1] === "thread-a") return new Promise<Response>((resolve) => (releaseA = () => resolve(body())));
        return body();
      }
      const around = path.match(/^\/api\/threads\/([\w-]+)\/messages\?around=(\w+)&limit=200$/);
      if (around) {
        const all = threads[around[1]!]!;
        const index = all.findIndex((message) => message.id === around[2]);
        const body = () => Response.json({ messages: all.slice(Math.max(0, index - 99), index + 101), hasMore: index > 99 });
        if (around[1] === "thread-a") return new Promise<Response>((resolve) => (releaseA = () => resolve(body())));
        return body();
      }
      return new Promise<Response>(() => {});
    }));
    const host = await mount("chat");
    await act(async () => store.dispatch({ type: "select", id: "a" }));
    await vi.waitFor(() => expect(host.textContent).toContain("a row 599;"));
    await act(async () => store.dispatch({ type: "focusMessage", threadId: "thread-a", messageId: "a5" }));
    await vi.waitFor(() => expect(calls).toContain("/api/threads/thread-a/messages?around=a5&limit=200"));
    await act(async () => {
      store.dispatch({ type: "select", id: "b" });
      store.dispatch({ type: "focusMessage", threadId: "thread-b", messageId: "b300" });
    });
    await vi.waitFor(() => expect(host.querySelector('[data-mid="b300"]')).not.toBeNull());
    releaseA();
  });

  it("jumps to an old message with one bounded request", async () => {
    const thread = rows(0, 5000);
    const calls = pagedServer("thread-a", thread, { bots: [bot(thread.slice(-200), true)], groups: [] });
    const host = await mount("chat");
    await vi.waitFor(() => expect(host.textContent).toContain("row 4999;"));
    await act(async () => store.dispatch({ type: "focusMessage", threadId: "thread-a", messageId: "m5" }));
    await vi.waitFor(() => expect(host.querySelector('[data-mid="m5"]')).not.toBeNull());
    expect(calls.filter((call) => call.startsWith("/api/threads/"))).toEqual(["/api/threads/thread-a/messages?around=m5&limit=200"]);
    expect(store.state.bots[0]!.messages).toHaveLength(200);
  });

  it("returns to the latest after a jump with live arrivals kept", async () => {
    const link = (i: number): Message => ({ ...row(i), parentId: i ? `m${i - 1}` : null });
    const thread = Array.from({ length: 5000 }, (_, i) => link(i));
    const calls = pagedServer("thread-a", thread, { bots: [bot(thread.slice(-200), true)], groups: [] });
    const host = await mount("chat");
    await vi.waitFor(() => expect(host.textContent).toContain("row 4999;"));
    await act(async () => store.dispatch({ type: "focusMessage", threadId: "thread-a", messageId: "m2500" }));
    await vi.waitFor(() => expect(host.querySelector('[data-mid="m2500"]')).not.toBeNull());
    await arrive("thread-a", link(5000));
    expect(store.state.bots[0]!.messages).toHaveLength(201);
    expect(host.textContent).not.toContain("row 5000;");

    for (let i = 0; i < 3 && !calls.some((call) => call.includes("before=")); i++) {
      await act(async () => button(host, "Show earlier messages")!.click());
    }
    await vi.waitFor(() => expect(host.textContent).toContain("row 2281;"));
    expect(calls).toContain("/api/threads/thread-a/messages?limit=200&before=m2401");
    expect(store.state.bots[0]!.messages).toHaveLength(201);

    await act(async () => button(host, "Show later messages")!.click());
    expect(button(host, "Show later messages")).toBeUndefined();
    await act(async () => button(host, "Jump to latest")!.click());
    expect(host.textContent).toContain("row 5000;");
    expect(host.textContent).toContain("row 4999;");
    expect(host.textContent).not.toContain("row 2500;");
  });

  it("shows patches and reactions on a jump window's rows", async () => {
    const thread = rows(0, 5000);
    pagedServer("thread-a", thread, { bots: [bot(thread.slice(-200), true)], groups: [] });
    const host = await mount("chat");
    await vi.waitFor(() => expect(host.textContent).toContain("row 4999;"));
    await act(async () => store.dispatch({ type: "focusMessage", threadId: "thread-a", messageId: "m2500" }));
    await vi.waitFor(() => expect(host.querySelector('[data-mid="m2500"]')).not.toBeNull());
    await act(async () => store.dispatch({ type: "messagePatched", threadId: "thread-a", message: { ...row(2500), text: "patched;" } }));
    expect(host.querySelector('[data-mid="m2500"]')!.textContent).toContain("patched;");
    await act(async () => store.dispatch({ type: "toggleReaction", threadId: "thread-a", messageId: "m2499", emoji: "🎉", message: row(2499) }));
    expect(host.querySelector('[data-mid="m2499"]')!.textContent).toContain("🎉");
  });

  it("drops a jump window when switching bots and reopens at the newest message", async () => {
    const thread = (p: string) =>
      Array.from({ length: 5000 }, (_, i): Message => ({ id: `${p}${i}`, at: 1, role: "user", kind: "text", text: `${p} row ${i};` }));
    const threads: Record<string, Message[]> = { "thread-a": thread("a"), "thread-b": thread("b") };
    const b = { ...bot(threads["thread-b"]!.slice(-200), true), id: "b", threadId: "thread-b", name: "B" } as Bot;
    vi.stubGlobal("fetch", vi.fn(async (url: string) => {
      const path = String(url);
      if (path === "/api/bots?messages=200") {
        return Response.json({ bots: [bot(threads["thread-a"]!.slice(-200), true), b], groups: [], computerControl: {} });
      }
      const around = path.match(/^\/api\/threads\/([\w-]+)\/messages\?around=(\w+)&limit=200$/);
      if (around) {
        const all = threads[around[1]!]!;
        const index = all.findIndex((message) => message.id === around[2]);
        return Response.json({ messages: all.slice(index - 99, index + 101), hasMore: true });
      }
      return new Promise<Response>(() => {});
    }));
    const host = await mount("chat");
    await act(async () => store.dispatch({ type: "select", id: "a" }));
    await vi.waitFor(() => expect(host.textContent).toContain("a row 4999;"));
    await act(async () => store.dispatch({ type: "focusMessage", threadId: "thread-a", messageId: "a2500" }));
    await vi.waitFor(() => expect(host.querySelector('[data-mid="a2500"]')).not.toBeNull());
    await act(async () => store.dispatch({ type: "select", id: "b" }));
    await vi.waitFor(() => expect(host.textContent).toContain("b row 4999;"));
    await arrive("thread-a", { id: "a5000", at: 1, role: "user", kind: "text", text: "a row 5000;" });
    await act(async () => store.dispatch({ type: "select", id: "a" }));
    expect(host.textContent).toContain("a row 5000;");
    expect(host.querySelector('[data-mid="a2500"]')).toBeNull();
  });

  it("shows an edit made in a jump window on its new branch with the ancestors", async () => {
    const link = (i: number): Message => ({ ...row(i), parentId: i ? `m${i - 1}` : null });
    const thread = Array.from({ length: 1000 }, (_, i) => link(i));
    pagedServer("thread-a", thread, { bots: [{ ...bot(thread.slice(-200), true), activeLeafId: "m999" }], groups: [] });
    const host = await mount("chat");
    await vi.waitFor(() => expect(host.textContent).toContain("row 999;"));
    await act(async () => store.dispatch({ type: "focusMessage", threadId: "thread-a", messageId: "m500" }));
    await vi.waitFor(() => expect(host.querySelector('[data-mid="m500"]')).not.toBeNull());
    await act(async () => (host.querySelector('[data-mid="m500"] [aria-label="Edit message"]') as HTMLElement).click());
    await act(async () => button(host, "Send")!.click());
    await arrive("thread-a", { id: "e1", at: 2, role: "user", kind: "text", text: "edited;", parentId: "m499" });
    await vi.waitFor(() => expect(host.querySelector('[data-mid="m499"]')).not.toBeNull());
    expect(host.querySelector('[data-mid="e1"]')).not.toBeNull();
    expect(host.querySelector('[data-mid="m500"]')).toBeNull();
  });

  it("follows the selected branch through a fork in a jump window", async () => {
    const link = (id: string, parentId: string | null, text: string): Message => ({ id, at: 1, role: "user", kind: "text", text, parentId });
    // a newer abandoned answer forks off m300; the selected branch runs on to the loaded tail
    const thread = [
      ...Array.from({ length: 305 }, (_, i) => link(`m${i}`, i ? `m${i - 1}` : null, `row ${i};`)),
      link("b", "m300", "abandoned;"),
      ...Array.from({ length: 294 }, (_, i) => link(`m${i + 305}`, `m${i + 304}`, `row ${i + 305};`)),
    ];
    pagedServer("thread-a", thread, { bots: [{ ...bot(thread.slice(-200), true), activeLeafId: "m598" }], groups: [] });
    const host = await mount("chat");
    await vi.waitFor(() => expect(host.textContent).toContain("row 598;"));
    await act(async () => store.dispatch({ type: "focusMessage", threadId: "thread-a", messageId: "m299" }));
    await vi.waitFor(() => expect(host.querySelector('[data-mid="m299"]')).not.toBeNull());
    expect(store.state.bots[0]!.messages).toHaveLength(200);
    expect(host.querySelector('[data-mid="m301"]')).not.toBeNull();
    expect(host.querySelector('[data-mid="b"]')).toBeNull();
  });

  it("jumps a room to an old message with one bounded request", async () => {
    const thread = rows(0, 5000);
    const calls = pagedServer("thread-g", thread, { bots: [], groups: [room(thread.slice(-200), true)] });
    const host = await mount("room");
    await vi.waitFor(() => expect(host.textContent).toContain("row 4999;"));
    await act(async () => store.dispatch({ type: "focusMessage", threadId: "thread-g", messageId: "m5" }));
    await vi.waitFor(() => expect(host.querySelector('[data-mid="m5"]')).not.toBeNull());
    expect(calls.filter((call) => call.startsWith("/api/threads/"))).toEqual(["/api/threads/thread-g/messages?around=m5&limit=200"]);
    expect(store.state.groups[0]!.messages).toHaveLength(200);
  });

  it("stops looking for a bot-only branch's prompt after a few pages", async () => {
    const thread = Array.from({ length: 2000 }, (_, i): Message => ({ id: `m${i}`, at: 1, role: "bot", kind: "text", text: `step ${i};`, parentId: i ? `m${i - 1}` : null }));
    const calls = pagedServer("thread-a", thread, { bots: [{ ...bot(thread.slice(-200), true), activeLeafId: "m1999" }], groups: [] });
    await mount("chat");
    await vi.waitFor(() => expect(store.state.bots[0]!.messages).toHaveLength(800));
    await act(async () => new Promise((resolve) => setTimeout(resolve, 50)));
    expect(calls.filter((call) => call.includes("before="))).toHaveLength(3);
    expect(store.state.bots[0]!.messages).toHaveLength(800);
  });

  const snapshot = (bots: Bot[]) =>
    act(async () => store.dispatch({ type: "hydrate", bots, groups: [], computerControl: {}, sidebarOrder: [] } as never));

  it("keeps the reader on the same row when a snapshot drops the scrollback they were in", async () => {
    const thread = rows(0, 600);
    pagedServer("thread-a", thread, { bots: [bot(thread.slice(-200), true)], groups: [] });
    const host = await mount("chat");
    await vi.waitFor(() => expect(host.textContent).toContain("row 599;"));
    const scroller = host.querySelector("[data-orbit-transcript]") as HTMLElement;
    Object.defineProperty(scroller, "scrollHeight", { configurable: true, get: () => host.querySelectorAll("[data-mid]").length * 10 });
    scroller.scrollTop = 0;
    await act(async () => button(host, "Show earlier messages (80 more)")!.click());
    await act(async () => button(host, "Show earlier messages")!.click());
    await vi.waitFor(() => expect(store.state.bots[0]!.messages).toHaveLength(400));
    expect(host.querySelector('[data-mid="m280"]')).not.toBeNull();
    scroller.scrollTop = 0;
    await snapshot([bot(thread.slice(-200), true)]);
    await vi.waitFor(() => expect(host.querySelector('[data-mid="m280"]')).not.toBeNull());
    expect(store.state.bots[0]!.messages).toHaveLength(200);
  });

  it("refetches an open jump window after a snapshot so its reactions stay", async () => {
    const thread = rows(0, 5000);
    const calls = pagedServer("thread-a", thread, { bots: [bot(thread.slice(-200), true)], groups: [] });
    const host = await mount("chat");
    await vi.waitFor(() => expect(host.textContent).toContain("row 4999;"));
    await act(async () => store.dispatch({ type: "focusMessage", threadId: "thread-a", messageId: "m2500" }));
    await vi.waitFor(() => expect(host.querySelector('[data-mid="m2500"]')).not.toBeNull());
    await act(async () => store.dispatch({ type: "toggleReaction", threadId: "thread-a", messageId: "m2499", emoji: "🎉", message: row(2499) }));
    expect(host.querySelector('[data-mid="m2499"]')!.textContent).toContain("🎉");
    thread[2499] = { ...row(2499), reactions: [{ emoji: "🎉", by: "user" }] } as Message;
    await snapshot([bot(thread.slice(-200), true)]);
    await vi.waitFor(() => expect(host.querySelector('[data-mid="m2499"]')!.textContent).toContain("🎉"));
    expect(calls.filter((call) => call.includes("around=m2500"))).toHaveLength(2);
  });

  it("opens a bot at the newest message when a resume snapshot lands after a touch scroll", async () => {
    const threads: Record<string, Message[]> = { "thread-a": lettered("a", 1000), "thread-b": lettered("b", 1000) };
    const a = bot(threads["thread-a"]!.slice(600, 800), true);
    const b = { ...bot(threads["thread-b"]!.slice(600, 800), true), id: "b", threadId: "thread-b", name: "B" } as Bot;
    const calls = pagedServer("thread-b", threads["thread-b"]!, { bots: [a, b], groups: [] });
    const host = await mount("chat");
    await act(async () => store.dispatch({ type: "select", id: "a" }));
    await vi.waitFor(() => expect(host.textContent).toContain("a row 799;"));
    await act(async () => store.dispatch({ type: "select", id: "b" }));
    await vi.waitFor(() => expect(host.textContent).toContain("b row 799;"));
    const scroller = host.querySelector("[data-orbit-transcript]") as HTMLElement;
    await act(async () => {
      touch(scroller, "touchstart", 100);
      touch(scroller, "touchmove", 140);
    });
    await snapshot([{ ...a, messages: threads["thread-a"]!.slice(800) }, { ...b, messages: threads["thread-b"]!.slice(800) }]);
    await act(async () => new Promise((resolve) => setTimeout(resolve, 50)));
    expect(host.textContent).toContain("b row 999;");
    expect(button(host, "Show later messages")).toBeUndefined();
    expect(calls.filter((call) => call.includes("around="))).toEqual([]);
  });

  it("opens a task at the newest message when a snapshot lands after the switch", async () => {
    const threads: Record<string, Message[]> = { "thread-a": lettered("a", 1000), "thread-a2": lettered("t", 1000) };
    const a = bot(threads["thread-a"]!.slice(-200), true);
    const calls = pagedServer("thread-a2", threads["thread-a2"]!, { bots: [a], groups: [] });
    const host = await mount("chat");
    await vi.waitFor(() => expect(host.textContent).toContain("a row 999;"));
    const scroller = host.querySelector("[data-orbit-transcript]") as HTMLElement;
    await act(async () => scroller.dispatchEvent(new WheelEvent("wheel", { deltaY: -10, bubbles: true })));
    const task = { ...a, threadId: "thread-a2", messages: threads["thread-a2"]!.slice(600, 800) };
    await act(async () => store.dispatch({ type: "taskSwitched", bot: task }));
    await vi.waitFor(() => expect(host.textContent).toContain("t row 799;"));
    Object.defineProperty(scroller, "scrollHeight", { configurable: true, get: () => host.querySelectorAll("[data-mid]").length * 10 });
    scroller.scrollTop = 0;
    await arrive("thread-a2", threads["thread-a2"]![800]!);
    expect(scroller.scrollTop).toBe(scroller.scrollHeight);
    await snapshot([{ ...task, messages: threads["thread-a2"]!.slice(800) }]);
    await act(async () => new Promise((resolve) => setTimeout(resolve, 50)));
    expect(host.textContent).toContain("t row 999;");
    expect(button(host, "Show later messages")).toBeUndefined();
    expect(calls.filter((call) => call.includes("around="))).toEqual([]);
  });

  it("follows a room's new task to the bottom after the reader scrolled up in the old one", async () => {
    const g = room(lettered("g", 200), false);
    pagedServer("thread-g", [], { bots: [], groups: [g] });
    const host = await mount("room");
    await vi.waitFor(() => expect(host.textContent).toContain("g row 199;"));
    const scroller = host.querySelector("[data-orbit-transcript]") as HTMLElement;
    await act(async () => scroller.dispatchEvent(new WheelEvent("wheel", { deltaY: -10, bubbles: true })));
    await act(async () => store.dispatch({ type: "groupPatched", group: { ...g, threadId: "thread-g2", messages: lettered("t", 200) } }));
    await vi.waitFor(() => expect(host.textContent).toContain("t row 199;"));
    Object.defineProperty(scroller, "scrollHeight", { configurable: true, get: () => host.querySelectorAll("[data-mid]").length * 10 });
    scroller.scrollTop = 0;
    await arrive("thread-g2", { id: "t200", at: 1, role: "user", kind: "text", text: "t row 200;" });
    expect(scroller.scrollTop).toBe(scroller.scrollHeight);
  });

  it("retries a failed edit-join page instead of stranding the branch", async () => {
    const link = (i: number): Message => ({ ...row(i), parentId: i ? `m${i - 1}` : null });
    const thread = Array.from({ length: 1000 }, (_, i) => link(i));
    pagedServer("thread-a", thread, { bots: [{ ...bot(thread.slice(-200), true), activeLeafId: "m999" }], groups: [] });
    const served = globalThis.fetch as (url: string) => Promise<Response>;
    let failed = false;
    vi.stubGlobal("fetch", vi.fn(async (url: string) => {
      if (String(url).includes("before=") && !failed) {
        failed = true;
        return new Response("{}", { status: 500 });
      }
      return served(url);
    }));
    const host = await mount("chat");
    await vi.waitFor(() => expect(host.textContent).toContain("row 999;"));
    await act(async () => store.dispatch({ type: "focusMessage", threadId: "thread-a", messageId: "m500" }));
    await vi.waitFor(() => expect(host.querySelector('[data-mid="m500"]')).not.toBeNull());
    await act(async () => (host.querySelector('[data-mid="m500"] [aria-label="Edit message"]') as HTMLElement).click());
    await act(async () => button(host, "Send")!.click());
    await arrive("thread-a", { id: "e1", at: 2, role: "user", kind: "text", text: "edited;", parentId: "m499" });
    await vi.waitFor(() => expect(host.querySelector('[data-mid="m499"]')).not.toBeNull(), { timeout: 4000 });
    expect(failed).toBe(true);
  });

  it("resumes the edit join when the reader returns from another bot", async () => {
    const link = (p: string, i: number): Message => ({ id: `${p}${i}`, at: 1, role: "user", kind: "text", text: `${p} row ${i};`, parentId: i ? `${p}${i - 1}` : null });
    const threads: Record<string, Message[]> = {
      "thread-a": Array.from({ length: 1000 }, (_, i) => link("a", i)),
      "thread-b": Array.from({ length: 300 }, (_, i) => ({ ...link("b", i), parentId: undefined })),
    };
    const a = { ...bot(threads["thread-a"]!.slice(-200), true), activeLeafId: "a999" };
    const b = { ...bot(threads["thread-b"]!.slice(-200), true), id: "b", threadId: "thread-b", name: "B" } as Bot;
    let releasePage = () => {};
    let held = false;
    vi.stubGlobal("fetch", vi.fn(async (url: string) => {
      const path = String(url);
      if (path === "/api/bots?messages=200") return Response.json({ bots: [a, b], groups: [], computerControl: {} });
      const page = path.match(/^\/api\/threads\/([\w-]+)\/messages\?limit=(\d+)&before=(\w+)$/);
      if (page) {
        const all = threads[page[1]!]!;
        const stop = all.findIndex((message) => message.id === page[3]);
        const start = Math.max(0, stop - Number(page[2]));
        const body = () => Response.json({ messages: all.slice(start, stop), hasMore: start > 0 });
        if (!held) {
          held = true;
          return new Promise<Response>((resolve) => (releasePage = () => resolve(body())));
        }
        return body();
      }
      const around = path.match(/^\/api\/threads\/([\w-]+)\/messages\?around=(\w+)&limit=200$/);
      if (around) {
        const all = threads[around[1]!]!;
        const index = all.findIndex((message) => message.id === around[2]);
        return Response.json({ messages: all.slice(Math.max(0, index - 99), index + 101), hasMore: index > 99 });
      }
      return new Promise<Response>(() => {});
    }));
    const host = await mount("chat");
    await act(async () => store.dispatch({ type: "select", id: "a" }));
    await vi.waitFor(() => expect(host.textContent).toContain("a row 999;"));
    await act(async () => store.dispatch({ type: "focusMessage", threadId: "thread-a", messageId: "a500" }));
    await vi.waitFor(() => expect(host.querySelector('[data-mid="a500"]')).not.toBeNull());
    await act(async () => (host.querySelector('[data-mid="a500"] [aria-label="Edit message"]') as HTMLElement).click());
    await act(async () => button(host, "Send")!.click());
    await arrive("thread-a", { id: "e1", at: 2, role: "user", kind: "text", text: "edited;", parentId: "a499" });
    await vi.waitFor(() => expect(held).toBe(true));
    await act(async () => store.dispatch({ type: "select", id: "b" }));
    await vi.waitFor(() => expect(host.textContent).toContain("b row 299;"));
    await act(async () => releasePage());
    await vi.waitFor(() => expect(store.state.bots.find((candidate) => candidate.id === "a")!.messages.length).toBeGreaterThanOrEqual(400));
    await act(async () => store.dispatch({ type: "select", id: "a" }));
    await vi.waitFor(() => expect(store.state.bots.find((candidate) => candidate.id === "a")!.messages.some((message) => message.id === "a499")).toBe(true));
  });

  it("stops leaf paging once a search hit opens a jump window", async () => {
    const link = (i: number): Message => ({ ...row(i), parentId: i ? `m${i - 1}` : null });
    const thread = Array.from({ length: 3000 }, (_, i) => link(i));
    const calls = pagedServer("thread-a", thread, { bots: [bot(thread.slice(-200), true)], groups: [] });
    const host = await mount("chat");
    await vi.waitFor(() => expect(host.textContent).toContain("row 2999;"));
    await act(async () => {
      store.dispatch({ type: "threadActive", threadId: "thread-a", activeLeafId: "m100" });
      store.dispatch({ type: "focusMessage", threadId: "thread-a", messageId: "m110" });
    });
    await vi.waitFor(() => expect(host.querySelector('[data-mid="m110"]')).not.toBeNull());
    await act(async () => new Promise((resolve) => setTimeout(resolve, 100)));
    expect(calls.filter((call) => call.includes("before=")).length).toBeLessThanOrEqual(1);
  });
});

describe("open window and jump pill", () => {
  const tool = (id: string, parentId: string | null): Message => ({ id, parentId, at: 1, role: "bot", kind: "activity", tool: { name: "Read", ok: true } });
  const say = (id: string, parentId: string | null, role: "user" | "bot", text: string): Message => ({ id, parentId, at: 1, role, kind: "text", text });
  /** One branch of hidden tool rows with text at the given indexes. */
  const toolThread = (length: number, texts: Record<number, readonly [role: "user" | "bot", text: string]>) =>
    Array.from({ length }, (_, i) => {
      const parentId = i ? `m${i - 1}` : null;
      const text = texts[i];
      return text ? say(`m${i}`, parentId, text[0], text[1]) : tool(`m${i}`, parentId);
    });
  const resize = () => act(async () => resizeCallbacks.forEach((callback) => callback()));
  const pill = (host: HTMLElement) => button(host, "Jump to latest");

  /** Lays out every transcript at `rowPx` per text row in a `viewportPx` tall view. */
  function stubTranscriptLayout(viewportPx: number, rowPx: number) {
    const proto = HTMLElement.prototype;
    const saved = (["clientHeight", "scrollHeight"] as const).map((key) => [key, Object.getOwnPropertyDescriptor(proto, key)] as const);
    const transcript = (el: HTMLElement) => el.hasAttribute("data-orbit-transcript");
    Object.defineProperty(proto, "clientHeight", { configurable: true, get(this: HTMLElement) { return transcript(this) ? viewportPx : 0; } });
    Object.defineProperty(proto, "scrollHeight", {
      configurable: true,
      get(this: HTMLElement) { return transcript(this) ? this.querySelectorAll("[data-orbit-message]").length * rowPx : 0; },
    });
    return () => {
      for (const [key, descriptor] of saved) {
        if (descriptor) Object.defineProperty(proto, key, descriptor);
        else Reflect.deleteProperty(proto, key);
      }
    };
  }

  function layout(scroller: HTMLElement, size: { client: number; scroll: number }) {
    Object.defineProperty(scroller, "clientHeight", { configurable: true, get: () => size.client });
    Object.defineProperty(scroller, "scrollHeight", { configurable: true, get: () => size.scroll });
  }

  it("opens a tool-heavy chat with the replies its prompt paging loaded", async () => {
    const thread = toolThread(350, { 0: ["user", "watch CI;"], 140: ["bot", "the workers run locally;"], 330: ["bot", "launched 343;"] });
    pagedServer("thread-a", thread, { bots: [{ ...bot(thread.slice(-200), true), activeLeafId: "m349" }], groups: [] });
    const host = await mount("chat");
    await vi.waitFor(() => expect(store.state.bots[0]!.messages).toHaveLength(350));
    expect(host.textContent).toContain("the workers run locally;");
    expect(host.textContent).toContain("watch CI;");
    expect(button(host, "more)")).toBeUndefined();
  });

  it.each(["chat", "room"] as const)("pages older rows into a %s too short to fill the view", async (view) => {
    const notes = Array.from({ length: 18 }, (_, k) => [20 + 45 * k, ["bot", `note ${20 + 45 * k};`]] as const);
    const thread = toolThread(1000, Object.fromEntries([[820, ["user", "keep going;"]] as const, ...notes]));
    const restore = stubTranscriptLayout(400, 100);
    try {
      const snapshot = view === "chat"
        ? { bots: [{ ...bot(thread.slice(-200), true), activeLeafId: "m999" }], groups: [] }
        : { bots: [], groups: [room(thread.slice(-200), true)] };
      const calls = pagedServer(view === "chat" ? "thread-a" : "thread-g", thread, snapshot);
      const host = await mount(view);
      await vi.waitFor(() => expect(host.textContent).toContain("note 785;"));
      await act(async () => new Promise((resolve) => setTimeout(resolve, 50)));
      expect(calls.filter((call) => call.includes("before="))).toHaveLength(1);
      expect(host.textContent).toContain("note 605;");
    } finally {
      restore();
    }
  });

  it.each(["chat", "room"] as const)("shows Jump to latest in a %s only while the newest row is below the view", async (view) => {
    const thread = lettered("x", 150);
    pagedServer("thread-x", [], view === "chat" ? { bots: [bot(thread, false)], groups: [] } : { bots: [], groups: [room(thread, false)] });
    const host = await mount(view);
    await vi.waitFor(() => expect(host.textContent).toContain("x row 149;"));
    const scroller = host.querySelector<HTMLElement>("[data-orbit-transcript]")!;
    const size = { client: 400, scroll: 1000 };
    layout(scroller, size);
    scroller.scrollTop = 600;
    await act(async () => scroller.dispatchEvent(new WheelEvent("wheel", { deltaY: -10, bubbles: true })));
    scroller.scrollTop = 300;
    await act(async () => scroller.dispatchEvent(new Event("scroll")));
    expect(pill(host)).toBeDefined();

    // the keyboard closes: the view grows over the newest row with no scroll event
    size.client = 700;
    await resize();
    expect(pill(host)).toBeUndefined();

    size.scroll = 1100;
    await arrive(view === "chat" ? "thread-a" : "thread-g", { id: "x150", at: 1, role: "user", kind: "text", text: "x row 150;" });
    await resize();
    expect(scroller.scrollTop).toBe(300);
    expect(pill(host)).toBeDefined();
  });

  it.each(["chat", "room"] as const)("keeps following after an upward swipe on a %s too short to scroll", async (view) => {
    const thread = lettered("x", 3);
    pagedServer("thread-x", [], view === "chat" ? { bots: [bot(thread, false)], groups: [] } : { bots: [], groups: [room(thread, false)] });
    const host = await mount(view);
    await vi.waitFor(() => expect(host.textContent).toContain("x row 2;"));
    const scroller = host.querySelector<HTMLElement>("[data-orbit-transcript]")!;
    const size = { client: 400, scroll: 300 };
    layout(scroller, size);
    scroller.scrollTop = 0;
    await act(async () => {
      touch(scroller, "touchstart", 100);
      touch(scroller, "touchmove", 160);
    });
    await act(async () => scroller.dispatchEvent(new WheelEvent("wheel", { deltaY: -10, bubbles: true })));
    expect(pill(host)).toBeUndefined();

    size.scroll = 1000;
    await arrive(view === "chat" ? "thread-a" : "thread-g", { id: "x3", at: 1, role: "user", kind: "text", text: "x row 3;" });
    expect(scroller.scrollTop).toBe(1000);
  });
});
