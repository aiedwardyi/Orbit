// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";

// oxlint-disable-next-line anti-slop/no-module-mocking -- This pins the store's toast decision; the shell bridge itself has its own tests.
vi.mock("@/lib/notify", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/notify")>();
  return { ...actual, showNotification: vi.fn() };
});

import { showNotification } from "@/lib/notify";
import { StoreProvider, useStore, type Message } from "./store";

class FakeEventSource {
  static last: FakeEventSource | null = null;
  onmessage: ((event: { data: string; lastEventId: string }) => void) | null = null;
  close = vi.fn();
  constructor(readonly url: string) {
    FakeEventSource.last = this;
  }
}

const text = (id: string, i: number): Message => ({ id: `${id}-${i}`, at: i, role: "bot", kind: "text", text: `line ${i}` });
const botOf = (id: string, messages: Message[]) => ({
  id,
  threadId: `t-${id}`,
  name: id,
  unread: false,
  messages,
  modelSelection: { instanceId: "inst", model: "m" },
});

const notification = {
  kind: "done",
  botId: "b1",
  botName: "b1",
  threadId: "t-b1",
  title: "b1 finished",
  body: "All done",
  icon: "",
};

let store: ReturnType<typeof useStore>;
let unmount: (() => Promise<void>) | null = null;

afterEach(async () => {
  await unmount?.();
  unmount = null;
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  localStorage.clear();
  FakeEventSource.last = null;
});

async function mount() {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  // Unknown endpoints fail fast: hydration waits on its peripheral snapshot
  // boundary, and a hanging fetch would hold every frame behind it forever.
  vi.stubGlobal("fetch", vi.fn(async (url: string) =>
    String(url) === "/api/bots?messages=200"
      ? Response.json({ bots: [botOf("b1", [text("b1", 0)])], groups: [], computerControl: {} })
      : Response.json({ error: "not in this test" }, { status: 404 }),
  ));
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
    FakeEventSource.last!.onmessage!({ data: JSON.stringify({ kind: "hello", resumed: false, cursor: "s:1" }), lastEventId: "" });
  });
  await vi.waitFor(() => expect(store.state.hydrated).toBe(true));
  // A live frame landing proves the stream is past its snapshot boundary,
  // not just that the chat half of hydration rendered.
  await act(async () => {
    FakeEventSource.last!.onmessage!({
      data: JSON.stringify({ kind: "message", threadId: "t-b1", message: text("b1", 1) }),
      lastEventId: "s:2",
    });
  });
  await vi.waitFor(() => expect(store.state.bots[0]?.messages).toHaveLength(2));
  vi.mocked(showNotification).mockClear();
}

async function resume(cursor: string) {
  await act(async () => {
    FakeEventSource.last!.onmessage!({ data: JSON.stringify({ kind: "hello", resumed: true, cursor }), lastEventId: "" });
  });
}

async function notify(at: number | undefined, lastEventId: string) {
  await act(async () => {
    FakeEventSource.last!.onmessage!({
      data: JSON.stringify(at === undefined ? { kind: "notify", notification } : { kind: "notify", notification, at }),
      lastEventId,
    });
  });
}

describe("notify toast age gate", () => {
  it("stays quiet for a frame older than two minutes", async () => {
    await mount();
    await notify(Date.now() - 3 * 60_000, "s:3");
    expect(vi.mocked(showNotification)).not.toHaveBeenCalled();
  });

  it("stays quiet for a replayed frame from before frames carried a time", async () => {
    await mount();
    await resume("s:100");
    await notify(undefined, "s:90");
    expect(vi.mocked(showNotification)).not.toHaveBeenCalled();
  });

  it("still toasts a fresh frame", async () => {
    await mount();
    await notify(Date.now(), "s:3");
    expect(vi.mocked(showNotification)).toHaveBeenCalledOnce();
    expect(vi.mocked(showNotification).mock.calls[0]?.[0]).toMatchObject({ title: "b1 finished" });
  });

  it("still toasts a fresh replayed frame", async () => {
    await mount();
    await resume("s:100");
    await notify(Date.now(), "s:90");
    expect(vi.mocked(showNotification)).toHaveBeenCalledOnce();
  });
});
