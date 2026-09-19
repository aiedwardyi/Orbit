// @vitest-environment happy-dom
import { act, createElement, useState } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";

import { StoreProvider, type Bot, type Message } from "@/state/store";

import { ChatView } from "./ChatView";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

class FakeEventSource {
  onmessage: ((event: { data: string; lastEventId: string }) => void) | null = null;
  close = vi.fn();
}

const PRESENCE_ROW_PX = 48;
const VIEWPORT_PX = 400;
const TRANSCRIPT_PX = 1000;

const baseBot = {
  title: "",
  description: "",
  notifications: false,
  color: "iris",
  unread: false,
  modelSelection: { instanceId: "inst", model: "m" },
  messages: [],
} as unknown as Bot;

const userMsg = (id: string, text: string): Message => ({ id, at: 1, role: "user", kind: "text", text });

const botA = {
  ...baseBot,
  id: "a",
  threadId: "thread-a",
  name: "A",
  busy: true,
  activity: "working",
  messages: [userMsg("ua", "question for A")],
} as Bot;
const botB = {
  ...baseBot,
  id: "b",
  threadId: "thread-b",
  name: "B",
  messages: [userMsg("ub", "question for B")],
} as Bot;

let switchBot: (id: "a" | "b") => void = () => {};

function Harness() {
  const [current, setCurrent] = useState<Bot>(botA);
  switchBot = (id) => setCurrent(id === "a" ? botA : botB);
  return createElement(ChatView, { bot: current });
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  localStorage.clear();
});

describe("ChatView bot switch while busy", () => {
  it("lands pinned with no stale presence row and no second shift", async () => {
    vi.stubGlobal("EventSource", FakeEventSource);
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ error: "not in this test" }), { status: 404 })));
    vi.stubGlobal("ResizeObserver", class {
      observe() {}
      unobserve() {}
      disconnect() {}
    });
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const host = document.createElement("div");
    document.body.append(host);
    const root = createRoot(host);
    try {
      await act(async () => {
        root.render(createElement(StoreProvider, null, createElement(Harness)));
      });
      const scroller = host.querySelector("[data-orbit-transcript]") as HTMLElement;
      const content = scroller.firstElementChild as HTMLElement;
      const presence = () => content.querySelector(".turn-presence") !== null;
      Object.defineProperty(scroller, "clientHeight", { configurable: true, get: () => VIEWPORT_PX });
      Object.defineProperty(scroller, "scrollHeight", {
        configurable: true,
        get: () => TRANSCRIPT_PX + (presence() ? PRESENCE_ROW_PX : 0),
      });
      // Browser-like clamp: scrollTo past the end sticks to the end.
      scroller.scrollTo = ((opts?: ScrollToOptions) => {
        scroller.scrollTop = Math.max(0, Math.min(opts?.top ?? 0, scroller.scrollHeight - scroller.clientHeight));
      }) as typeof scroller.scrollTo;
      expect(presence()).toBe(true);

      await act(async () => {
        switchBot("b");
      });
      expect(host.textContent).toContain("question for B");
      expect(host.textContent).not.toContain("question for A");
      // The old thread's presence row never renders under the new bot.
      expect(presence()).toBe(false);
      // Pinned: scrollTop equals scrollHeight - clientHeight after switch.
      expect(scroller.scrollTop).toBe(scroller.scrollHeight - scroller.clientHeight);
      const settledTop = scroller.scrollTop;

      await act(async () => {
        await sleep(400);
      });
      expect(presence()).toBe(false);
      expect(scroller.scrollTop).toBe(settledTop);
      expect(scroller.scrollTop).toBe(scroller.scrollHeight - scroller.clientHeight);
    } finally {
      await act(async () => root.unmount());
      host.remove();
    }
  });
});
