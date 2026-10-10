// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";

import { withAcceptedMessages } from "@/lib/send-accept";
import { reloadHeld } from "@/lib/reload-hold";
import { api, StoreProvider, useStore, type Bot, type Group, type Message, type OptionCardData } from "./store";

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
  post: (init?: RequestInit) => Promise<Response> = async () => {
    throw new TypeError("Load failed");
  },
  bots: Bot[] = [bot],
) {
  const fetch = vi.fn(async (url: string, init?: RequestInit) => {
    const path = String(url);
    if (path === "/api/bots?messages=200") return Response.json({ bots, groups: [group], computerControl: {} });
    if (init?.method === "POST" && (path.endsWith("/messages") || path.endsWith("/respond"))) return post(init);
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

describe("update reload during a send", () => {
  function gate<T>() {
    let open!: (value: T | PromiseLike<T>) => void;
    let fail!: (cause: Error) => void;
    const promise = new Promise<T>((done, reject) => {
      open = done;
      fail = reject;
    });
    return { promise, open, fail };
  }
  const settled = (threadId: string) => Response.json({ ok: true, threadId, message: accepted(threadId) });
  const dispatchSend = (name: (typeof sends)[number]["name"], onError: () => void) =>
    act(async () =>
      store.dispatch(
        name === "send"
          ? { type: "send", botId: bot.id, text: "hello", sendId: "s1", threadId: bot.threadId, onError }
          : { type: "sendGroup", groupId: group.id, text: "hello", sendId: "s1", threadId: group.threadId, onError },
      ),
    );

  it.each(sends)("$name holds the reload until its POST answers", async ({ name, threadId }) => {
    const post = gate<Response>();
    await mount(() => Response.json({ messages: [], hasMore: false }), () => post.promise);
    expect(reloadHeld()).toBe(false);
    await dispatchSend(name, vi.fn());
    expect(reloadHeld()).toBe(true);
    await act(async () => post.open(settled(threadId)));
    await vi.waitFor(() => expect(reloadHeld()).toBe(false));
    expect(messagesOf(threadId)).toEqual([accepted(threadId)]);
  });

  it.each(sends)("$name holds the reload through the lookup after a dropped POST", async ({ name, threadId }) => {
    const lookup = gate<Response>();
    let asked = false;
    await mount(() => {
      asked = true;
      return lookup.promise;
    });
    await dispatchSend(name, vi.fn());
    await vi.waitFor(() => expect(asked).toBe(true));
    expect(reloadHeld()).toBe(true);
    await act(async () => lookup.open(Response.json({ messages: [accepted(threadId)], hasMore: false })));
    await vi.waitFor(() => expect(reloadHeld()).toBe(false));
    expect(messagesOf(threadId)).toEqual([accepted(threadId)]);
  });

  it.each(sends)("$name releases the reload only after the draft is restored", async ({ name, threadId }) => {
    const lookup = gate<Response>();
    let asked = false;
    await mount(() => {
      asked = true;
      return lookup.promise;
    });
    let heldAtRestore: boolean | null = null;
    const onError = vi.fn(() => {
      heldAtRestore = reloadHeld();
    });
    await dispatchSend(name, onError);
    await vi.waitFor(() => expect(asked).toBe(true));
    await act(async () => lookup.open(Response.json({ messages: [], hasMore: false })));
    await vi.waitFor(() => expect(reloadHeld()).toBe(false));
    expect(onError).toHaveBeenCalledOnce();
    expect(heldAtRestore).toBe(true);
    expect(messagesOf(threadId)).toEqual([]);
  });

  it("holds a 1:1 send through its re-POST", async () => {
    const posts = [gate<Response>(), gate<Response>(), gate<Response>(), gate<Response>()];
    let calls = 0;
    await mount(() => Response.json({ messages: [], hasMore: false }), () => posts[calls++]!.promise);
    let heldAtRestore: boolean | null = null;
    const onError = vi.fn(() => {
      heldAtRestore = reloadHeld();
    });
    const send = (sendId: string) =>
      act(async () => store.dispatch({ type: "send", botId: bot.id, text: "hello", sendId, threadId: bot.threadId, onError }));

    await send("s5");
    await act(async () => posts[0]!.fail(new TypeError("Load failed")));
    await vi.waitFor(() => expect(calls).toBe(2));
    expect(reloadHeld()).toBe(true);
    await act(async () => posts[1]!.open(settled(bot.threadId)));
    await vi.waitFor(() => expect(reloadHeld()).toBe(false));
    expect(onError).not.toHaveBeenCalled();

    await send("s6");
    await act(async () => posts[2]!.fail(new TypeError("Load failed")));
    await vi.waitFor(() => expect(calls).toBe(4));
    expect(reloadHeld()).toBe(true);
    await act(async () => posts[3]!.fail(new TypeError("Load failed")));
    await vi.waitFor(() => expect(reloadHeld()).toBe(false));
    expect(onError).toHaveBeenCalledOnce();
    expect(heldAtRestore).toBe(true);
  });

  it("holds the reload for a write until it answers, not for a read", async () => {
    const write = gate<Response>();
    vi.stubGlobal("fetch", vi.fn((_url: string, init?: RequestInit) => (init?.method ? write.promise : Promise.resolve(Response.json({})))));
    const read = api("/api/bots");
    expect(reloadHeld()).toBe(false);
    await read;
    const edit = api("/api/messages/m1", { method: "PATCH", body: "{}" });
    expect(reloadHeld()).toBe(true);
    write.open(Response.json({ ok: true }));
    await edit;
    await vi.waitFor(() => expect(reloadHeld()).toBe(false));
  });

  it.each<{ name: string; card: OptionCardData; path: string }>([
    { name: "live ask", card: { title: "Q", subtitle: "", options: [], requestId: "r1" }, path: "/api/bots/b1/respond" },
    { name: "quiz", card: { title: "Q", subtitle: "", options: [] }, path: "/api/bots/b1/messages" },
  ])("holds the reload until a $name answer is posted", async ({ card, path }) => {
    const post = gate<Response>();
    const asking: Bot = { ...bot, messages: [{ id: "m-card", at: 1, role: "bot", kind: "options", card }] };
    const fetch = await mount(() => Response.json({ messages: [], hasMore: false }), () => post.promise, [asking]);
    await act(async () => store.dispatch({ type: "answerCard", botId: bot.id, messageId: "m-card", answer: "Yes" }));
    expect(fetch).toHaveBeenCalledWith(path, expect.objectContaining({ method: "POST" }));
    expect(reloadHeld()).toBe(true);
    await act(async () => post.open(Response.json({ ok: true })));
    await vi.waitFor(() => expect(reloadHeld()).toBe(false));
  });
});

describe("send while the server holds the thread", () => {
  const text = 'look\n\n<attached-image path="/a/1.png" />';
  const queued = () => Response.json({ ok: true, queued: true, queueId: "q1", threadId: bot.threadId }, { status: 202 });

  it("paints one bubble when a bot that looked idle queues the send", async () => {
    await mount(() => Response.json({ messages: [], hasMore: false }), async () => queued(), [
      { ...bot, busy: false, activity: "idle" },
    ]);
    await act(async () => store.dispatch({ type: "send", botId: bot.id, text, sendId: "s1", threadId: bot.threadId }));
    await vi.waitFor(() => expect(store.state.pendingQueued[bot.threadId]).toHaveLength(1));
    const painted = withAcceptedMessages([], store.state.acceptedSends[bot.threadId], store.state.pendingQueued[bot.threadId]);
    expect(painted.map((message) => message.text)).toEqual([text]);
  });

  it("keeps a queued send when the phone drops the POST response", async () => {
    const bodies: unknown[] = [];
    await mount(
      () => Response.json({ messages: [], hasMore: false }),
      async (init) => {
        bodies.push(JSON.parse(String(init?.body)));
        if (bodies.length === 1) throw new TypeError("Load failed");
        return queued();
      },
    );
    const onError = vi.fn();
    await act(async () =>
      store.dispatch({ type: "send", botId: bot.id, text: "it sent twice", sendId: "s2", threadId: bot.threadId, onError }),
    );
    await vi.waitFor(() => expect(store.state.pendingQueued[bot.threadId]).toEqual([expect.objectContaining({ queueId: "q1" })]));
    expect(bodies).toEqual([expect.objectContaining({ sendId: "s2" }), expect.objectContaining({ sendId: "s2" })]);
    expect(onError).not.toHaveBeenCalled();
    expect(store.state.error).toBeNull();
  });

  it("does not re-POST a send stopped while its lookup was pending", async () => {
    let answer!: () => void;
    let asked = false;
    const post = vi.fn(async () => {
      throw new TypeError("Load failed");
    });
    await mount(
      () =>
        new Promise<Response>((done) => {
          asked = true;
          answer = () => done(Response.json({ messages: [], hasMore: false }));
        }),
      post,
      [{ ...bot, busy: false, activity: "idle" }],
    );
    const onError = vi.fn();
    await act(async () => store.dispatch({ type: "send", botId: bot.id, text: "hello", sendId: "s3", threadId: bot.threadId, onError }));
    await vi.waitFor(() => expect(asked).toBe(true));
    await act(async () => store.dispatch({ type: "interrupt", botId: bot.id }));
    await act(async () => answer());
    await vi.waitFor(() => expect(store.state.acceptedSends[bot.threadId]).toBeUndefined());
    expect(post).toHaveBeenCalledOnce();
  });

  // The interrupt can reach the server before the send does, or after the
  // send was queued behind a turn still starting; neither may run later.
  it("cancels a send on the server when Stop beats its receipt", async () => {
    const fetch = await mount(
      () => Response.json({ messages: [], hasMore: false }),
      () => new Promise<Response>(() => {}),
      [{ ...bot, busy: false, activity: "idle" }],
    );
    await act(async () => store.dispatch({ type: "send", botId: bot.id, text: "hello", sendId: "s4", threadId: bot.threadId }));
    await act(async () => store.dispatch({ type: "interrupt", botId: bot.id }));
    expect(fetch).toHaveBeenCalledWith("/api/bots/b1/queue/s4", expect.objectContaining({ method: "DELETE" }));
    expect(fetch).toHaveBeenCalledWith("/api/bots/b1/interrupt", expect.objectContaining({ method: "POST" }));
  });
});

describe("stop", () => {
  const botFrame = (busy: boolean) =>
    act(async () => {
      FakeEventSource.last!.onmessage!({
        data: JSON.stringify({ kind: "bot", bot: { id: bot.id, busy, activity: busy ? "working" : "idle" } }),
        lastEventId: "",
      });
    });
  const busyNow = () => store.state.bots[0]!.busy;

  async function mountStop(interrupt: () => Promise<Response>, bots: Bot[] = [bot]) {
    const fetch = await mount(
      () => Response.json({ messages: [], hasMore: false }),
      () => new Promise<Response>(() => {}),
      bots,
    );
    const base = fetch.getMockImplementation()!;
    fetch.mockImplementation(async (url: string, init?: RequestInit) =>
      String(url).endsWith("/interrupt") ? interrupt() : base(url, init),
    );
    return () => fetch.mock.calls.filter(([url]) => String(url).endsWith("/interrupt")).length;
  }

  it("goes idle at once and holds through busy frames until the server is idle", async () => {
    await mountStop(() => new Promise<Response>(() => {}));
    expect(busyNow()).toBe(true);
    await act(async () => store.dispatch({ type: "interrupt", botId: bot.id }));
    expect(busyNow()).toBe(false);
    await botFrame(true);
    expect(busyNow()).toBe(false);
    await botFrame(false);
    await botFrame(true);
    expect(busyNow()).toBe(true);
  });

  it("sends one interrupt for repeat stops", async () => {
    const interrupts = await mountStop(() => new Promise<Response>(() => {}));
    for (let i = 0; i < 3; i++) await act(async () => store.dispatch({ type: "interrupt", botId: bot.id }));
    expect(interrupts()).toBe(1);
  });

  it("gives a new send its own Stop after stopping the last one", async () => {
    const interrupts = await mountStop(async () => Response.json({ ok: true }), [{ ...bot, busy: false, activity: "idle" }]);
    const send = (sendId: string) =>
      act(async () => store.dispatch({ type: "send", botId: bot.id, text: "hello", sendId, threadId: bot.threadId }));
    await send("s5");
    await act(async () => store.dispatch({ type: "interrupt", botId: bot.id }));
    expect(busyNow()).toBe(false);
    await send("s6");
    await botFrame(true);
    expect(busyNow()).toBe(true);
    await act(async () => store.dispatch({ type: "interrupt", botId: bot.id }));
    expect(interrupts()).toBe(2);
  });

  it("shows the error and the running turn when Stop fails", async () => {
    await mountStop(async () => Response.json({ error: "stop failed" }, { status: 500 }));
    await act(async () => store.dispatch({ type: "interrupt", botId: bot.id }));
    await vi.waitFor(() => expect(store.state.error).toBe("stop failed"));
    expect(busyNow()).toBe(true);
  });
});
