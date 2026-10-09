// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { LiveFrame } from "@/lib/live-events";
import { StoreProvider, useStore, useStreaming, type Bot, type Message } from "./store";

type Frame = LiveFrame & { threadId?: string; message?: Message };

class FakeEventSource {
  static last: FakeEventSource;
  onmessage: ((event: { data: string; lastEventId: string }) => void) | null = null;
  close = vi.fn();
  constructor() {
    FakeEventSource.last = this;
  }
}

// 2,000 characters: one big engine chunk
const BURST = "word ".repeat(400);
// SAFETY: the store folds only these fields here; the full Bot contract is server-owned.
const bot = {
  id: "b1", threadId: "t1", name: "Bot", busy: true, unread: false,
  modelSelection: { instanceId: "inst", model: "m" },
  messages: [{ id: "u1", at: 1, role: "user", kind: "text", text: "Write a lot" }],
} as Bot;

let store: ReturnType<typeof useStore>;
let stream: ReturnType<typeof useStreaming>;
let unmount: (() => Promise<void>) | undefined;
let reducedMotion = false;

beforeEach(() => {
  vi.useFakeTimers();
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("EventSource", FakeEventSource);
  vi.spyOn(console, "warn").mockImplementation(() => {});
  const matchMedia = window.matchMedia.bind(window);
  vi.spyOn(window, "matchMedia").mockImplementation((query) => ({
    ...matchMedia(query),
    matches: reducedMotion && query === "(prefers-reduced-motion: reduce)",
  }));
});

afterEach(async () => {
  await unmount?.();
  unmount = undefined;
  reducedMotion = false;
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  localStorage.clear();
});

async function emit(frame: Frame, lastEventId = "") {
  await act(async () => FakeEventSource.last.onmessage!({ data: JSON.stringify(frame), lastEventId }));
}

async function mount(snapshot = async () => Response.json({ bots: [bot], groups: [], computerControl: {} })) {
  vi.stubGlobal("fetch", vi.fn(async (url: string) => String(url) === "/api/bots?messages=200"
    ? snapshot()
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
  await emit({ kind: "hello", resumed: false, cursor: "s:0" });
}

const started = { kind: "runtime", event: { type: "turn.started", threadId: "t1", turnId: "turn1" } };
const delta = (text: string, lastEventId?: string) => emit({
  kind: "runtime",
  event: { type: "content.delta", threadId: "t1", turnId: "turn1", streamKind: "assistant_text", delta: text },
}, lastEventId);
const shown = () => stream.streaming.t1?.length ?? 0;

async function live() {
  await mount();
  await vi.waitFor(() => expect(store.state.hydrated).toBe(true));
  await emit(started);
}

async function advance(ms: number) {
  await act(async () => {
    vi.advanceTimersByTime(ms);
  });
}

async function setVisible(visible: boolean) {
  vi.spyOn(document, "visibilityState", "get").mockReturnValue(visible ? "visible" : "hidden");
  await act(async () => document.dispatchEvent(new Event("visibilitychange")));
}

// The Claude driver sends the settled reply and the turn end right after the last delta.
async function settle(text = BURST) {
  await emit({ kind: "message", threadId: "t1", message: { id: "a1", parentId: "u1", at: 2, role: "bot", kind: "text", text } });
  await emit({ kind: "runtime", event: { type: "turn.completed", threadId: "t1", turnId: "turn1" } });
}

async function typingBurst() {
  await live();
  await delta(BURST);
  await advance(16);
  expect(shown()).toBeGreaterThan(0);
  expect(shown()).toBeLessThan(BURST.length);
}

describe("live reply typing", () => {
  it("types a 2,000 character burst out over several frames", async () => {
    await live();
    await delta(BURST);
    const frames: number[] = [];
    for (let i = 0; i < 12; i++) {
      await advance(16);
      frames.push(shown());
    }
    const typing = frames.filter((length) => length < BURST.length);
    expect(typing.length).toBeGreaterThanOrEqual(5);
    expect(typing[0]).toBeGreaterThan(0);
    expect(frames).toEqual([...frames].sort((a, b) => a - b));
    expect(frames.at(-1)).toBe(BURST.length);
  });

  it("keeps every character within 150 ms of its arrival", async () => {
    await live();
    await delta(BURST);
    await advance(100);
    await delta("more ".repeat(20));
    // 150 ms and a frame after the burst: all of it is up, the newer text is still typing
    await advance(66);
    expect(shown()).toBeGreaterThanOrEqual(BURST.length);
    expect(shown()).toBeLessThan(BURST.length + 100);
    await advance(100);
    expect(shown()).toBe(BURST.length + 100);
  });

  it("never shows half an emoji while typing", async () => {
    await live();
    await delta("🙂".repeat(200));
    for (let i = 0; i < 12; i++) {
      await advance(16);
      // under the u flag a whole pair is one code point, so only a lone surrogate matches
      expect(stream.streaming.t1).not.toMatch(/[\uD800-\uDFFF]/u);
    }
    expect(shown()).toBe(400);
  });

  it("stops typing when the turn ends and never types text that arrives after it", async () => {
    await typingBurst();
    await emit({ kind: "runtime", event: { type: "turn.completed", threadId: "t1", turnId: "turn1" } });
    expect(stream.streaming.t1).toBeUndefined();
    await delta("late ".repeat(100));
    await advance(16);
    expect(shown()).toBe(500);
  });

  it("lets the tail finish typing before the settled reply takes over", async () => {
    await typingBurst();
    const typed = shown();
    await settle();
    expect(store.state.bots[0].messages.at(-1)?.id).toBe("u1");
    expect(shown()).toBe(typed);
    await advance(16);
    expect(shown()).toBeGreaterThan(typed);
    await advance(150);
    expect(stream.streaming.t1).toBeUndefined();
    expect(store.state.bots[0].messages.at(-1)).toMatchObject({ id: "a1", text: BURST });
    expect(stream.signal.t1).toBeUndefined();
  });

  it("keeps the thread's later frames behind a reply that is still typing", async () => {
    await typingBurst();
    await settle();
    await emit({ kind: "message", threadId: "t1", message: { id: "n1", parentId: "a1", at: 3, role: "bot", kind: "note", text: "after" } });
    await advance(200);
    expect(store.state.bots[0].messages.map((m) => m.id)).toEqual(["u1", "a1", "n1"]);
  });

  it("settles at once when nothing is left to type", async () => {
    await live();
    await delta("Hi");
    await advance(200);
    await settle("Hi");
    expect(store.state.bots[0].messages.at(-1)?.id).toBe("a1");
  });

  it("settles at once after the turn ended", async () => {
    await typingBurst();
    await emit({ kind: "runtime", event: { type: "turn.completed", threadId: "t1", turnId: "turn1" } });
    await delta("late ".repeat(100));
    await emit({ kind: "message", threadId: "t1", message: { id: "a1", parentId: "u1", at: 2, role: "bot", kind: "text", text: BURST } });
    expect(store.state.bots[0].messages.at(-1)?.id).toBe("a1");
  });

  it("settles at once under reduced motion", async () => {
    await typingBurst();
    reducedMotion = true;
    await settle();
    expect(store.state.bots[0].messages.at(-1)?.id).toBe("a1");
  });

  it("settles a waiting reply when the window hides", async () => {
    await typingBurst();
    await settle();
    await setVisible(false);
    expect(store.state.bots[0].messages.at(-1)?.id).toBe("a1");
  });

  it("settles a reply held behind the history load at once", async () => {
    let release!: () => void;
    const loaded = new Promise<void>((resolve) => (release = resolve));
    await mount(async () => {
      await loaded;
      return Response.json({ bots: [bot], groups: [], computerControl: {} });
    });
    await emit(started);
    await delta(BURST);
    await emit({ kind: "message", threadId: "t1", message: { id: "a1", parentId: "u1", at: 2, role: "bot", kind: "text", text: BURST } });
    release();
    for (let i = 0; i < 20 && !store.state.hydrated; i++) await act(async () => {});
    expect(store.state.hydrated).toBe(true);
    expect(store.state.bots[0].messages.at(-1)?.id).toBe("a1");
  });

  it("lands frames held behind the history load whole", async () => {
    let release!: () => void;
    const loaded = new Promise<void>((resolve) => (release = resolve));
    await mount(async () => {
      await loaded;
      return Response.json({ bots: [bot], groups: [], computerControl: {} });
    });
    await emit(started);
    await delta(BURST);
    release();
    for (let i = 0; i < 20 && !store.state.hydrated; i++) await act(async () => {});
    expect(store.state.hydrated).toBe(true);
    expect(shown()).toBe(BURST.length);
  });

  it("lands a resumed stream's replay whole", async () => {
    await live();
    await delta("Hello ", "s:2");
    await advance(200);
    // waking reconnects, and the server replays what the window missed
    await setVisible(false);
    await setVisible(true);
    await emit({ kind: "hello", resumed: true, cursor: "s:4" });
    await delta(BURST, "s:3");
    expect(shown()).toBe(6 + BURST.length);
    await delta(BURST, "s:5");
    await advance(16);
    expect(shown()).toBeLessThan(6 + 2 * BURST.length);
  });

  it("lands the backlog whole when the window comes back", async () => {
    await typingBurst();
    await setVisible(false);
    await delta(BURST);
    await setVisible(true);
    expect(shown()).toBe(2 * BURST.length);
  });

  it("types nothing out under reduced motion", async () => {
    await typingBurst();
    reducedMotion = true;
    await advance(16);
    expect(shown()).toBe(BURST.length);
    await delta(BURST);
    await advance(16);
    expect(shown()).toBe(2 * BURST.length);
  });
});
