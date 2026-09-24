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

async function mount(threadPage: (threadId: string) => Response) {
  const fetch = vi.fn(async (url: string, init?: RequestInit) => {
    const path = String(url);
    if (path === "/api/bots") return Response.json({ bots: [bot], groups: [group], computerControl: {} });
    if (init?.method === "POST" && path.endsWith("/messages")) throw new TypeError("Load failed");
    const page = path.match(/^\/api\/threads\/([\w-]+)\/messages\?/);
    if (page) return threadPage(page[1]!);
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
});
