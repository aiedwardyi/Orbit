// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";

import { buffersForTurn } from "@/lib/turn-stage";
import { StoreProvider, useStore, useStreaming, type Bot } from "./store";

class FakeEventSource {
  static last: FakeEventSource;
  onmessage: ((event: { data: string; lastEventId: string }) => void) | null = null;
  close = vi.fn();
  constructor() {
    FakeEventSource.last = this;
  }
}

let store: ReturnType<typeof useStore>;
let stream: ReturnType<typeof useStreaming>;
let unmount: (() => Promise<void>) | undefined;
let frame: FrameRequestCallback | undefined;

afterEach(async () => {
  await unmount?.();
  unmount = undefined;
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  localStorage.clear();
});

async function emit(value: object) {
  await act(async () => FakeEventSource.last.onmessage!({ data: JSON.stringify(value), lastEventId: "" }));
}

async function delta(text: string) {
  await emit({ kind: "runtime", event: { type: "content.delta", threadId: "t1", streamKind: "assistant_text", delta: text } });
  await act(async () => frame?.(0));
}

describe("launch rows while streaming", () => {
  it("keeps streamed text through three launch rows and chat switches", async () => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    vi.stubGlobal("EventSource", FakeEventSource);
    vi.stubGlobal("requestAnimationFrame", vi.fn((callback: FrameRequestCallback) => { frame = callback; return 1; }));
    vi.stubGlobal("cancelAnimationFrame", vi.fn());
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const bot = {
      id: "b1", threadId: "t1", name: "Bot", busy: true, unread: false,
      modelSelection: { instanceId: "inst", model: "m" },
      messages: [{ id: "u1", at: 1, role: "user", kind: "text", text: "Spawn three workers" }],
    } as Bot;
    vi.stubGlobal("fetch", vi.fn(async (url: string) => String(url) === "/api/bots?messages=200"
      ? Response.json({ bots: [bot, { ...bot, id: "b2", threadId: "t2", messages: [] }], groups: [], computerControl: {} })
      : Response.json({}, { status: 404 })));
    function Probe() {
      store = useStore();
      stream = useStreaming();
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
    await emit({ kind: "hello", resumed: false, cursor: "c1" });
    await vi.waitFor(() => expect(store.state.hydrated).toBe(true));
    await delta("Opening ");
    expect(stream.streaming.t1).toBe("Opening ");
    for (let i = 1; i <= 3; i++) {
      await emit({ kind: "message", threadId: "t1", message: {
        id: `l${i}`, parentId: i === 1 ? "u1" : `l${i - 1}`, at: i + 1, role: "bot", kind: "launch", text: `Launched worker ${i}`,
      } });
      expect.soft(buffersForTurn(stream, "t1", `l${i}`).streaming).toBe(`Opening ${"worker ".repeat(i - 1)}`);
      await delta("worker ");
    }
    await act(async () => store.dispatch({ type: "select", id: "b2" }));
    await act(async () => store.dispatch({ type: "select", id: "b1" }));
    expect(stream.streaming.t1).toBe("Opening worker worker worker ");
  });
});
