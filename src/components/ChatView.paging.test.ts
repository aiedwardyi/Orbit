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

afterEach(async () => {
  await unmount?.();
  unmount = null;
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  localStorage.clear();
});

async function mount(view: "chat" | "room") {
  vi.stubGlobal("EventSource", FakeEventSource);
  vi.stubGlobal("ResizeObserver", class {
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
});
