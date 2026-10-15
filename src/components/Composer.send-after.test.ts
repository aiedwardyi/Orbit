// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";

import { StoreProvider, useStore, type Bot } from "@/state/store";

import { Composer } from "./Composer";

class FakeEventSource {
  static last: FakeEventSource | null = null;
  onmessage: ((event: { data: string; lastEventId: string }) => void) | null = null;
  close = vi.fn();
  constructor() {
    FakeEventSource.last = this;
  }
}

const bot = (instanceId: string): Bot => ({
  id: `bot-${instanceId}`, threadId: `thread-${instanceId}`, name: "Scout", title: "", description: "",
  notifications: false, color: "blue", unread: false, messages: [], busy: true, activity: "working",
  modelSelection: { instanceId, model: "m" },
});

let unmount: (() => Promise<void>) | null = null;

afterEach(async () => {
  await unmount?.();
  unmount = null;
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  localStorage.clear();
});

async function mount(subject: Bot, coarse = false, instancesReady = true) {
  const bodies: Array<{ text?: string; deliver?: string }> = [];
  vi.stubGlobal("matchMedia", (query: string) => ({ matches: coarse && query === "(pointer: coarse)", addEventListener() {}, removeEventListener() {} }));
  vi.stubGlobal("EventSource", FakeEventSource);
  vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
    const path = String(url);
    if (path === "/api/bots?messages=200") return Response.json({ bots: [subject], groups: [], computerControl: {} });
    if (path === "/api/instances") {
      if (!instancesReady) return new Promise<Response>(() => {});
      return Response.json({ instances: [
        { instanceId: "steers", capabilities: { queueing: true } },
        { instanceId: "waits", capabilities: {} },
      ] });
    }
    if (init?.method === "POST" && path.endsWith("/messages")) {
      bodies.push(JSON.parse(String(init.body)));
      return Response.json({ ok: true, queued: true, queueId: `q${bodies.length}`, threadId: subject.threadId }, { status: 202 });
    }
    return Response.json({ error: "not in this test" }, { status: 404 });
  }));
  vi.spyOn(console, "warn").mockImplementation(() => {});
  let instances = 0;
  let hydrated = false;
  function Probe() {
    const { state } = useStore();
    instances = state.instances.length;
    hydrated = state.hydrated;
    return createElement(Composer, { bot: subject });
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
  await vi.waitFor(() => expect(hydrated).toBe(true));
  if (instancesReady) await vi.waitFor(() => expect(instances).toBe(2));
  const box = host.querySelector("textarea")!;
  const type = (value: string) =>
    act(async () => {
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(box, value);
      box.dispatchEvent(new Event("input", { bubbles: true }));
    });
  await type("hello");
  const sendButton = () => {
    const button = host.querySelector<HTMLButtonElement>("button[aria-label^='Send'], button[aria-label^='Tap to send']");
    if (!button) throw new Error("send button did not render");
    return button;
  };
  const press = (init: KeyboardEventInit) =>
    act(async () => box.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", code: "Enter", keyCode: 13, bubbles: true, cancelable: true, ...init })));
  const touchSend = (kind: string, point = { clientX: 5, clientY: 5 }) =>
    act(async () => {
      const event = new Event(kind, { bubbles: true, cancelable: true });
      Object.defineProperty(event, "touches", { value: kind === "touchend" ? [] : [point] });
      sendButton().dispatchEvent(event);
    });
  return { bodies, box, host, type, sendButton, press, touch: touchSend };
}

describe("send after this turn", () => {
  it.each([false, true])("sends after-turn intent before capabilities load, coarse=%s", async (coarse) => {
    const ui = await mount(bot("steers"), coarse, false);
    if (coarse) {
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
      await ui.touch("touchstart");
      await act(async () => vi.advanceTimersByTime(500));
      vi.useRealTimers();
      await act(async () => ui.box.dispatchEvent(new Event("touchstart", { bubbles: true })));
    } else {
      await ui.press({ ctrlKey: true });
    }
    await vi.waitFor(() => expect(ui.bodies).toHaveLength(1));
    expect(ui.bodies[0]).toMatchObject({ deliver: "after" });
  });

  it("preserves after-turn intent through repeated retries beside a newer draft", async () => {
    const ui = await mount(bot("steers"));
    const served = globalThis.fetch;
    let finish: (response: Response) => void = () => undefined;
    let failures = 2;
    vi.stubGlobal("fetch", vi.fn((url: string, init?: RequestInit) => {
      if (init?.method === "POST" && String(url).endsWith("/messages") && failures-- > 0) {
        ui.bodies.push(JSON.parse(String(init.body)));
        return new Promise<Response>((resolve) => { finish = resolve; });
      }
      return served(url, init);
    }));
    await ui.press({ ctrlKey: true });
    await ui.type("newer draft");
    for (let attempt = 0; attempt < 2; attempt++) {
      await act(async () => finish(Response.json({ error: "offline" }, { status: 500 })));
      const retry = () => Array.from(ui.host.querySelectorAll("button")).find((button) => button.textContent === "Retry");
      await vi.waitFor(() => expect(retry()).toBeDefined());
      await act(async () => retry()!.click());
      await vi.waitFor(() => expect(ui.bodies).toHaveLength(attempt + 2));
      expect(ui.bodies[attempt + 1]).toMatchObject({ text: "hello", deliver: "after" });
      expect(ui.box.value).toBe("newer draft");
    }
  });

  it("sends Enter into the turn and Ctrl+Enter or Cmd+Enter after it", async () => {
    const ui = await mount(bot("steers"));
    await ui.press({});
    for (const mod of [{ ctrlKey: true }, { metaKey: true }]) {
      await ui.type("again");
      await ui.press(mod);
    }
    await vi.waitFor(() => expect(ui.bodies).toHaveLength(3));
    expect(ui.bodies[0]).not.toHaveProperty("deliver");
    expect(ui.bodies.slice(1)).toEqual([
      expect.objectContaining({ text: "again", deliver: "after" }),
      expect.objectContaining({ text: "again", deliver: "after" }),
    ]);
  });

  it("keeps Shift+Enter a newline and never sends mid-composition", async () => {
    const ui = await mount(bot("steers"));
    await ui.press({ shiftKey: true });
    await act(async () => ui.box.dispatchEvent(new Event("compositionstart", { bubbles: true })));
    await ui.press({ ctrlKey: true, isComposing: true });
    expect(ui.bodies).toHaveLength(0);
  });

  it("acts like Enter on an engine that cannot steer", async () => {
    const ui = await mount(bot("waits"));
    await ui.press({ ctrlKey: true });
    await vi.waitFor(() => expect(ui.bodies).toHaveLength(1));
    expect(ui.bodies[0]).toMatchObject({ deliver: "after" });
  });

  it("names the choice in the Send title", async () => {
    expect((await mount(bot("steers"))).sendButton().title).toBe("Send now. Ctrl+Enter sends after this turn");
    await unmount?.();
    expect((await mount(bot("steers"), true)).sendButton().getAttribute("aria-label")).toBe("Tap to send now. Hold to send after this turn");
  });

  it("sends after the turn on a long press, once, with no menu or stray click", async () => {
    const ui = await mount(bot("steers"), true);
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    const early = new MouseEvent("contextmenu", { bubbles: true, cancelable: true });
    await act(async () => ui.sendButton().dispatchEvent(early));
    expect(early.defaultPrevented).toBe(true);
    await ui.touch("touchstart");
    await act(async () => vi.advanceTimersByTime(499));
    expect(ui.bodies).toHaveLength(0);
    await act(async () => vi.advanceTimersByTime(1));
    vi.useRealTimers();
    await vi.waitFor(() => expect(ui.bodies).toEqual([expect.objectContaining({ text: "hello", deliver: "after" })]));
    // Send is gone now, so the hold's tail lands on whatever took its place
    const menu = new MouseEvent("contextmenu", { bubbles: true, cancelable: true });
    const click = new MouseEvent("click", { bubbles: true, cancelable: true });
    await act(async () => ui.box.dispatchEvent(menu));
    await act(async () => ui.box.dispatchEvent(click));
    expect(menu.defaultPrevented).toBe(true);
    expect(click.defaultPrevented).toBe(true);
    await act(async () => ui.box.dispatchEvent(new Event("touchstart", { bubbles: true })));
    const later = new MouseEvent("contextmenu", { bubbles: true, cancelable: true });
    await act(async () => ui.box.dispatchEvent(later));
    expect(later.defaultPrevented).toBe(false);
    expect(ui.bodies).toHaveLength(1);
  });

  it("sends a tap now and lets a moved finger cancel the hold", async () => {
    const ui = await mount(bot("steers"), true);
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    await ui.touch("touchstart");
    await ui.touch("touchmove", { clientX: 40, clientY: 5 });
    await act(async () => vi.advanceTimersByTime(600));
    expect(ui.bodies).toHaveLength(0);
    await ui.touch("touchstart");
    await act(async () => vi.advanceTimersByTime(100));
    await ui.touch("touchend");
    vi.useRealTimers();
    await act(async () => ui.sendButton().click());
    await vi.waitFor(() => expect(ui.bodies).toHaveLength(1));
    expect(ui.bodies[0]).toMatchObject({ text: "hello" });
    expect(ui.bodies[0]).not.toHaveProperty("deliver");
  });
});
