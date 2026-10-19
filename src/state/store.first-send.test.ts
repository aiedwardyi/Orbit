// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";

import { StoreProvider, useStore, type Bot } from "./store";

class FakeEventSource {
  static last: FakeEventSource;
  onmessage: ((event: { data: string; lastEventId: string }) => void) | null = null;
  close = vi.fn();
  constructor() {
    FakeEventSource.last = this;
  }
}

let store: ReturnType<typeof useStore>;
let unmount: (() => Promise<void>) | undefined;

afterEach(async () => {
  await unmount?.();
  unmount = undefined;
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  localStorage.clear();
});

async function emit(frame: object, lastEventId = "") {
  await act(async () => FakeEventSource.last.onmessage!({ data: JSON.stringify(frame), lastEventId }));
}

async function mount() {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("EventSource", FakeEventSource);
  vi.spyOn(console, "warn").mockImplementation(() => {});
  function Probe() {
    store = useStore();
    return null;
  }
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  unmount = async () => {
    await act(async () => root.unmount());
    host.remove();
  };
  await act(async () => root.render(createElement(StoreProvider, null, createElement(Probe))));
}

const bot = (name: string) => ({
  id: "b1", threadId: "t1", name, busy: false, unread: false,
  title: "Task", description: "", notifications: false, color: "green",
  modelSelection: { instanceId: "inst", model: "m" }, messages: [],
} as Bot);

describe("first-send hydration", () => {
  it.each([
    ["stream00:4", "stream00:4", false],
    ["stream00:5", "stream00:4", false],
    ["stream00:3", "stream00:4", true],
    ["oldrun00:9", "stream00:4", true],
    [undefined, "stream00:4", true],
  ])("fetches at mount and validates %s against hello %s", async (cursor, boundary, refetch) => {
    let reads = 0;
    vi.stubGlobal("fetch", vi.fn(async (url: string) => {
      if (String(url) !== "/api/bots?messages=200") return Response.json({}, { status: 404 });
      reads += 1;
      return Response.json({ bots: [bot(reads === 1 ? "Prefetched" : "Fresh")], groups: [], cursor: reads === 1 ? cursor : boundary });
    }));
    await mount();
    expect(reads).toBe(1);
    expect(store.state.hydrated).toBe(false);
    expect(store.state.bots).toEqual([]);
    await emit({ kind: "hello", resumed: false, cursor: boundary });
    await vi.waitFor(() => expect(store.state.hydrated).toBe(true));
    expect(reads).toBe(refetch ? 2 : 1);
    expect(store.state.bots[0].name).toBe(refetch ? "Fresh" : "Prefetched");
    await emit({ kind: "bot", bot: { ...bot("Live"), unread: false } }, "stream00:5");
    expect(store.state.bots[0].name).toBe("Live");
  });

  it("holds an early response beyond the fallback deadline until hello", async () => {
    let reads = 0;
    vi.stubGlobal("fetch", vi.fn(async (url: string) => {
      if (String(url) !== "/api/bots?messages=200") return Response.json({}, { status: 404 });
      reads += 1;
      return Response.json({ bots: [bot("Prefetched")], groups: [], cursor: "stream00:4" });
    }));
    await mount();
    expect(reads).toBe(1);
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 1_050)); });
    expect(store.state.hydrated).toBe(false);
    await emit({ kind: "hello", resumed: false, cursor: "stream00:4" });
    await vi.waitFor(() => expect(store.state.hydrated).toBe(true));
    expect(reads).toBe(1);
  });

  it("keeps frames received while the prefetched response is pending", async () => {
    let reads = 0;
    let release!: (response: Response) => void;
    const held = new Promise<Response>((resolve) => { release = resolve; });
    vi.stubGlobal("fetch", vi.fn((url: string) => {
      if (String(url) !== "/api/bots?messages=200") return Promise.resolve(Response.json({}, { status: 404 }));
      reads += 1;
      return held;
    }));
    await mount();
    expect(reads).toBe(1);
    await emit({ kind: "hello", resumed: false, cursor: "stream00:4" });
    await emit({ kind: "bot", bot: bot("Live") }, "stream00:5");
    expect(store.state.hydrated).toBe(false);
    await act(async () => release(Response.json({ bots: [bot("Prefetched")], groups: [], cursor: "stream00:4" })));
    await vi.waitFor(() => expect(store.state.hydrated).toBe(true));
    expect(store.state.bots[0].name).toBe("Live");
    expect(reads).toBe(1);
  });
});
