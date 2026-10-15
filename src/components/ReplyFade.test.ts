// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { StoreProvider, useStore, type Bot, type Group, type Message } from "@/state/store";
import { ChatView } from "./ChatView";
import { GroupView } from "./GroupView";

vi.mock("shiki", () => ({ codeToHtml: async (code: string) => `<pre><code>${code}</code></pre>` }));

class FakeEventSource {
  static last: FakeEventSource;
  onmessage: ((event: { data: string; lastEventId: string }) => void) | null = null;
  close = vi.fn();
  constructor() { FakeEventSource.last = this; }
}

const user: Message = { id: "u1", at: Date.now(), role: "user", kind: "text", text: "Explain the change" };
const bot: Bot = {
  id: "b1", threadId: "t1", name: "Helper", title: "", description: "", notifications: false,
  color: "blue", unread: false, busy: true, activity: "working",
  modelSelection: { mode: "pinned", instanceId: "inst", model: "m" }, messages: [user],
};
const group: Group = {
  id: "g1", threadId: "t1", name: "Room", memberIds: ["b1"], busyBotId: "b1", messages: [user], bulletin: "",
  defaultResponder: { kind: "member", botId: "b1" }, unread: false, createdAt: user.at, setupCompletedAt: user.at,
};
let store: ReturnType<typeof useStore>;
let unmount: (() => Promise<void>) | undefined;
const animate = vi.fn(() => ({ cancel: vi.fn() } as unknown as Animation));
const originalAnimate = Element.prototype.animate;

beforeEach(() => {
  vi.useFakeTimers();
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("EventSource", FakeEventSource);
  vi.stubGlobal("ResizeObserver", class { observe() {} unobserve() {} disconnect() {} });
  vi.spyOn(console, "warn").mockImplementation(() => {});
  Element.prototype.animate = animate;
  animate.mockClear();
});

afterEach(async () => {
  await unmount?.();
  unmount = undefined;
  Element.prototype.animate = originalAnimate;
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  localStorage.clear();
});

async function emit(frame: object, lastEventId = "") {
  await act(async () => FakeEventSource.last.onmessage!({ data: JSON.stringify(frame), lastEventId }));
}

async function advance(ms = 16) {
  await act(async () => { vi.advanceTimersByTime(ms); });
}

async function delta(text: string, lastEventId = "") {
  await emit({ kind: "runtime", event: { type: "content.delta", threadId: "t1", turnId: "turn1", streamKind: "assistant_text", delta: text } }, lastEventId);
  await advance();
}

const started = { kind: "runtime", event: { type: "turn.started", threadId: "t1", turnId: "turn1" } };
const reply = (text: string): Message => ({ id: "a1", parentId: "u1", at: user.at + 1, role: "bot", kind: "text", text, from: { botId: "b1", name: "Helper", color: "blue" } });

async function mount(room = false, history: Message[] = [user]) {
  vi.stubGlobal("fetch", vi.fn(async (url: string) => String(url) === "/api/bots?messages=200"
    ? Response.json({ bots: [{ ...bot, threadId: room ? "bot-thread" : "t1", messages: room ? [] : history }], groups: room ? [{ ...group, messages: history }] : [], computerControl: {} })
    : Response.json({}, { status: 404 })));
  function View() {
    store = useStore();
    const current = room ? store.state.groups[0] : store.state.bots[0];
    return current ? (room ? createElement(GroupView, { group: current as Group }) : createElement(ChatView, { bot: current as Bot })) : null;
  }
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  unmount = async () => { await act(async () => root.unmount()); host.remove(); };
  await act(async () => root.render(createElement(StoreProvider, null, createElement(View))));
  await emit({ kind: "hello", resumed: false, cursor: "s:0" });
  for (let i = 0; i < 20 && !store.state.hydrated; i++) await act(async () => {});
  expect(store.state.hydrated).toBe(true);
  return host;
}

describe("paragraph reply reveal", () => {
  it.each([false, true])("shows finished blocks once through the settled swap, room=%s", async (room) => {
    const host = await mount(room);
    await emit(started);
    await delta("First thought");
    expect(host.querySelector(".chat-md")?.textContent ?? "").toBe("");
    expect(host.querySelector('[data-turn-mascot][aria-hidden="false"], .turn-mascot-in')).not.toBeNull();
    await delta(".\n\nSecond");
    const first = host.querySelector(".chat-md > :first-child");
    expect(first?.textContent).toBe("First thought.");
    expect(animate).toHaveBeenCalledTimes(1);
    expect(animate).toHaveBeenLastCalledWith(
      [{ opacity: 0, transform: "translateY(8px)" }, { opacity: 1, transform: "translateY(0)" }],
      { duration: 400, easing: "ease-out" },
    );
    await emit({ kind: "bot", bot: { id: "b1", name: "Helper updated" } });
    expect(animate).toHaveBeenCalledTimes(1);
    await delta(" thought.\n\nTail");
    expect(host.querySelector(".chat-md")?.textContent).toBe("First thought.Second thought.");
    expect(animate).toHaveBeenCalledTimes(2);
    await emit({ kind: "message", threadId: "t1", message: reply("First thought.\n\nSecond thought.\n\nTail") });
    expect(host.querySelector(".chat-md > :first-child")).toBe(first);
    expect(host.querySelector(".chat-md")?.textContent).toBe("First thought.Second thought.Tail");
    expect(animate).toHaveBeenCalledTimes(2);
    await emit({ kind: "runtime", event: { type: "turn.completed", threadId: "t1", turnId: "turn1" } });
    expect(animate).toHaveBeenCalledTimes(2);
  });

  it("lands history and synced replies without a fade", async () => {
    const host = await mount(false, [user, reply("Saved.\n\nHistory.")]);
    expect(host.querySelector(".chat-md")?.textContent).toContain("Saved.");
    await emit({ kind: "message", threadId: "t1", message: { ...reply("Synced."), id: "a2", parentId: "a1" } });
    expect(host.textContent).toContain("Synced.");
    expect(animate).not.toHaveBeenCalled();
  });

  it("lands a resumed stream whole without a fade", async () => {
    const host = await mount();
    await delta("A stream already in progress");
    expect(host.querySelector(".chat-md")?.textContent).toBe("A stream already in progress");
    expect(animate).not.toHaveBeenCalled();
  });

  it("lands replay and window backlog whole without another fade", async () => {
    const host = await mount();
    await emit(started);
    await delta("First.\n\n", "s:2");
    animate.mockClear();
    const visible = vi.spyOn(document, "visibilityState", "get");
    visible.mockReturnValue("hidden");
    await act(async () => document.dispatchEvent(new Event("visibilitychange")));
    visible.mockReturnValue("visible");
    await act(async () => document.dispatchEvent(new Event("visibilitychange")));
    await emit({ kind: "hello", resumed: true, cursor: "s:4" });
    await delta("Replayed unfinished", "s:3");
    expect(host.querySelector(".chat-md")?.textContent).toContain("Replayed unfinished");
    expect(animate).not.toHaveBeenCalled();
    visible.mockReturnValue("hidden");
    await emit({ kind: "runtime", event: { type: "content.delta", threadId: "t1", turnId: "turn1", streamKind: "assistant_text", delta: " backlog" } });
    visible.mockReturnValue("visible");
    await act(async () => document.dispatchEvent(new Event("visibilitychange")));
    expect(host.querySelector(".chat-md")?.textContent).toContain("Replayed unfinished backlog");
    expect(animate).not.toHaveBeenCalled();
  });

  it("keeps block boundaries under reduced motion without animating", async () => {
    vi.spyOn(window, "matchMedia").mockReturnValue({ matches: true } as MediaQueryList);
    const host = await mount();
    await emit(started);
    await delta("Complete.\n\nUnfinished");
    expect(host.querySelector(".chat-md")?.textContent).toBe("Complete.");
    expect(animate).not.toHaveBeenCalled();
  });

  it("flushes an unfinished tail at turn end before the saved row arrives", async () => {
    const host = await mount();
    await emit(started);
    await delta("Complete.\n\nUnfinished");
    await emit({ kind: "runtime", event: { type: "turn.completed", threadId: "t1", turnId: "turn1" } });
    expect(host.querySelector(".chat-md")?.textContent).toBe("Complete.Unfinished");
  });
});
