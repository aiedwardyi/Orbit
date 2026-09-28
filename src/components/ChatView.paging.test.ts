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
    return new Promise<Response>(() => {});
  }));
  return calls;
}

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
    const b = store.state.bots[0];
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
    expect(store.state.bots[0]!.hasMore).toBe(false);
    // the window stays bounded around the hit instead of mounting the whole thread
    expect(host.querySelectorAll("[data-mid]").length).toBeLessThan(200);
  });
});
