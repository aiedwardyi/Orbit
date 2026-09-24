// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";

import { StoreProvider, useStore, type Bot, type Group, type Message } from "./store";

class FakeEventSource {
  static last: FakeEventSource | null = null;
  onmessage: ((event: { data: string; lastEventId: string }) => void) | null = null;
  close = vi.fn();
  constructor() {
    FakeEventSource.last = this;
  }
}

const bot = {
  id: "b1",
  threadId: "t-bot",
  name: "Bot",
  busy: true,
  activity: "working",
  messages: [],
  modelSelection: { instanceId: "inst", model: "m" },
} as unknown as Bot;
const group = {
  id: "g1",
  threadId: "t-group",
  name: "Room",
  memberIds: ["b1"],
  busyBotId: "b1",
  messages: [],
} as unknown as Group;
const accepted = (threadId: string): Message => ({
  id: `m-${threadId}`,
  at: 1,
  role: "user",
  kind: "text",
  text: "hello",
  sendId: "s1",
});

let store: ReturnType<typeof useStore>;
let unmount: (() => Promise<void>) | null = null;

afterEach(async () => {
  await unmount?.();
  unmount = null;
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  localStorage.clear();
});

async function mount(
  threadPage: (threadId: string, init?: RequestInit) => Response | Promise<Response>,
  post: () => Promise<Response> = async () => {
    throw new TypeError("Load failed");
  },
) {
  const fetch = vi.fn(async (url: string, init?: RequestInit) => {
    const path = String(url);
    if (path === "/api/bots") return Response.json({ bots: [bot], groups: [group], computerControl: {} });
    if (init?.method === "POST" && path.endsWith("/messages")) return post();
    const page = path.match(/^\/api\/threads\/([\w-]+)\/messages\?/);
    if (page) return threadPage(page[1]!, init);
    return Response.json({ error: "not in this test" }, { status: 404 });
  });
  vi.stubGlobal("fetch", fetch);
  vi.stubGlobal("EventSource", FakeEventSource);
  vi.spyOn(console, "warn").mockImplementation(() => {});
  function Probe() {
    store = useStore();
    return null;
  }
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  await act(async () => root.render(createElement(StoreProvider, null, createElement(Probe))));
  unmount = async () => {
    await act(async () => root.unmount());
    host.remove();
  };
  await act(async () => {
    FakeEventSource.last!.onmessage!({ data: JSON.stringify({ kind: "hello", resumed: false, cursor: "c1" }), lastEventId: "" });
  });
  await vi.waitFor(() => expect(store.state.bots).toHaveLength(1));
  return fetch;
}

const sends = [
  { name: "send", threadId: bot.threadId, action: (onError: () => void) => ({ type: "send", botId: bot.id, text: "hello", sendId: "s1", threadId: bot.threadId, onError }) },
  { name: "sendGroup", threadId: group.threadId, action: (onError: () => void) => ({ type: "sendGroup", groupId: group.id, text: "hello", sendId: "s1", threadId: group.threadId, onError }) },
] as const;

const messagesOf = (threadId: string) =>
  store.state.bots.find((b) => b.threadId === threadId)?.messages ??
  store.state.groups.find((g) => g.threadId === threadId)?.messages;

describe("send reject after the server accepted", () => {
  it.each(sends)("$name settles without restoring the draft", async ({ threadId, action }) => {
    const fetch = await mount((thread) => Response.json({ messages: [accepted(thread)], hasMore: false }));
    const onError = vi.fn();
    await act(async () => store.dispatch(action(onError) as never));
    await vi.waitFor(() => expect(messagesOf(threadId)).toEqual([accepted(threadId)]));
    expect(fetch).toHaveBeenCalledWith(`/api/threads/${threadId}/messages?limit=200`, expect.anything());
    expect(store.state.acceptedSends[threadId]).toBeUndefined();
    expect(store.state.error).toBeNull();
    expect(onError).not.toHaveBeenCalled();
  });

  it.each(sends)("$name still restores the draft when the lookup fails", async ({ threadId, action }) => {
    await mount(() => Response.json({ error: "down" }, { status: 500 }));
    const onError = vi.fn();
    await act(async () => store.dispatch(action(onError) as never));
    await vi.waitFor(() => expect(onError).toHaveBeenCalledOnce());
    expect(store.state.acceptedSends[threadId]).toBeUndefined();
    expect(store.state.error).toBe("Load failed");
    expect(messagesOf(threadId)).toEqual([]);
  });

  it.each(sends)("$name restores the draft when the same sendId carries other text", async ({ threadId, action }) => {
    await mount((thread) => Response.json({ messages: [{ ...accepted(thread), text: "other" }], hasMore: false }));
    const onError = vi.fn();
    await act(async () => store.dispatch(action(onError) as never));
    await vi.waitFor(() => expect(onError).toHaveBeenCalledOnce());
    expect(messagesOf(threadId)).toEqual([]);
  });

  it.each(sends)("$name settles from local state without a lookup", async ({ threadId, action }) => {
    let reject!: (cause: Error) => void;
    const fetch = await mount(
      () => Response.json({ messages: [], hasMore: false }),
      () => new Promise<Response>((_, fail) => { reject = fail; }),
    );
    const onError = vi.fn();
    await act(async () => store.dispatch(action(onError) as never));
    await act(async () => {
      FakeEventSource.last!.onmessage!({ data: JSON.stringify({ kind: "message", threadId, message: accepted(threadId) }), lastEventId: "e2" });
    });
    await act(async () => reject(new TypeError("Load failed")));
    await vi.waitFor(() => expect(store.state.acceptedSends[threadId]).toBeUndefined());
    expect(fetch).not.toHaveBeenCalledWith(`/api/threads/${threadId}/messages?limit=200`, expect.anything());
    expect(messagesOf(threadId)).toEqual([accepted(threadId)]);
    expect(onError).not.toHaveBeenCalled();
  });

  it.each(sends)("$name restores the draft when the lookup lacks the message", async ({ threadId, action }) => {
    await mount(() => Response.json({ messages: [], hasMore: false }));
    const onError = vi.fn();
    await act(async () => store.dispatch(action(onError) as never));
    await vi.waitFor(() => expect(onError).toHaveBeenCalledOnce());
    expect(messagesOf(threadId)).toEqual([]);
  });

  it.each(sends)("$name adds the message once when SSE and the lookup both deliver it", async ({ threadId, action }) => {
    let answer!: () => void;
    let asked = false;
    await mount(
      (thread) =>
        new Promise<Response>((done) => {
          asked = true;
          answer = () => done(Response.json({ messages: [accepted(thread)], hasMore: false }));
        }),
    );
    const onError = vi.fn();
    await act(async () => store.dispatch(action(onError) as never));
    await vi.waitFor(() => expect(asked).toBe(true));
    await act(async () => {
      FakeEventSource.last!.onmessage!({ data: JSON.stringify({ kind: "message", threadId, message: accepted(threadId) }), lastEventId: "e2" });
    });
    await act(async () => answer());
    await vi.waitFor(() => expect(store.state.acceptedSends[threadId]).toBeUndefined());
    expect(messagesOf(threadId)).toEqual([accepted(threadId)]);
    expect(onError).not.toHaveBeenCalled();
  });

  it.each(sends)("$name restores the draft when the lookup hangs past the timeout", async ({ threadId, action }) => {
    await mount(
      (_, init) =>
        new Promise<Response>((_, fail) => init?.signal?.addEventListener("abort", () => fail(init.signal!.reason))),
    );
    vi.useFakeTimers();
    // Native AbortSignal.timeout ignores fake timers.
    vi.spyOn(AbortSignal, "timeout").mockImplementation((ms) => {
      const controller = new AbortController();
      setTimeout(() => controller.abort(new DOMException("timed out", "TimeoutError")), ms);
      return controller.signal;
    });
    try {
      const onError = vi.fn();
      await act(async () => store.dispatch(action(onError) as never));
      await act(async () => vi.advanceTimersByTimeAsync(4_999));
      expect(onError).not.toHaveBeenCalled();
      await act(async () => vi.advanceTimersByTimeAsync(1));
      expect(onError).toHaveBeenCalledOnce();
      expect(messagesOf(threadId)).toEqual([]);
    } finally {
      vi.useRealTimers();
    }
  });
});
