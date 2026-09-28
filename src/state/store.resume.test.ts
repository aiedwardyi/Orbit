// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";

import { StoreProvider, useStore, type Bot, type Message } from "./store";

class FakeEventSource {
  static last: FakeEventSource | null = null;
  onmessage: ((event: { data: string; lastEventId: string }) => void) | null = null;
  close = vi.fn();
  constructor() {
    FakeEventSource.last = this;
  }
}

const text = (id: string, i: number): Message => ({ id: `${id}-${i}`, at: i, role: "bot", kind: "text", text: `line ${i}` });
const botOf = (id: string, messages: Message[]) =>
  ({
    id,
    threadId: `t-${id}`,
    name: id,
    unread: false,
    messages,
    modelSelection: { instanceId: "inst", model: "m" },
  }) as unknown as Bot;

let store: ReturnType<typeof useStore>;
let unmount: (() => Promise<void>) | null = null;

afterEach(async () => {
  await unmount?.();
  unmount = null;
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  localStorage.clear();
});

async function mount(snapshot: () => Promise<Response>) {
  vi.stubGlobal("fetch", vi.fn(async (url: string) => (String(url) === "/api/bots" ? snapshot() : new Promise<Response>(() => {}))));
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
}

async function hello() {
  await act(async () => {
    FakeEventSource.last!.onmessage!({ data: JSON.stringify({ kind: "hello", resumed: false, cursor: "c1" }), lastEventId: "" });
  });
}

async function hide() {
  vi.spyOn(document, "visibilityState", "get").mockReturnValue("hidden");
  await act(async () => document.dispatchEvent(new Event("visibilitychange")));
}

describe("page reload after the tab was discarded", () => {
  it("shows the last chat before the stream or snapshot answers", async () => {
    const bots = [botOf("b1", [text("b1", 0)]), botOf("b2", [text("b2", 0), text("b2", 1)])];
    await mount(async () => Response.json({ bots, groups: [], computerControl: {} }));
    await hello();
    await vi.waitFor(() => expect(store.state.bots).toHaveLength(2));
    await act(async () => store.dispatch({ type: "select", id: "b2" }));
    await hide();
    await unmount!();
    unmount = null;
    vi.restoreAllMocks();

    await mount(() => new Promise<Response>(() => {}));
    expect(store.state.bots.map((b) => b.id)).toEqual(["b1", "b2"]);
    expect(store.state.selectedId).toBe("b2");
    expect(store.state.bots[1].messages.map((m) => m.text)).toEqual(["line 0", "line 1"]);
    expect(store.state.hydrated).toBe(false);
  });

  it("replaces the cached chat with the live snapshot", async () => {
    await mount(async () => Response.json({ bots: [botOf("b1", [text("b1", 0)])], groups: [], computerControl: {} }));
    await hello();
    await vi.waitFor(() => expect(store.state.bots).toHaveLength(1));
    await hide();
    await unmount!();
    unmount = null;
    vi.restoreAllMocks();

    await mount(async () => Response.json({ bots: [botOf("b1", [text("b1", 0), text("b1", 1)])], groups: [], computerControl: {} }));
    expect(store.state.bots[0].messages).toHaveLength(1);
    await hello();
    await vi.waitFor(() => expect(store.state.bots[0].messages).toHaveLength(2));
    expect(store.state.hydrated).toBe(true);
  });

  it("keeps only a recent tail without screen pixels", async () => {
    const messages = Array.from({ length: 200 }, (_, i) => text("b1", i));
    messages.push({ id: "shot", at: 200, role: "bot", kind: "screen", png: "AAAA" } as Message);
    await mount(async () => Response.json({ bots: [botOf("b1", messages)], groups: [], computerControl: {} }));
    await hello();
    await vi.waitFor(() => expect(store.state.bots).toHaveLength(1));
    await hide();
    await unmount!();
    unmount = null;
    vi.restoreAllMocks();

    await mount(() => new Promise<Response>(() => {}));
    const cached = store.state.bots[0].messages;
    expect(cached.length).toBeLessThan(200);
    expect(cached.at(-1)?.id).toBe("shot");
    expect(cached.at(-1)?.png).toBeUndefined();
  });

  it("stays on the connecting screen on a first load with nothing cached", async () => {
    await mount(() => new Promise<Response>(() => {}));
    expect(store.state.bots).toEqual([]);
  });
});
