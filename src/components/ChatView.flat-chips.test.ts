// @vitest-environment happy-dom
import { act, createElement, useEffect } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";

import { StoreProvider, useStore, type Bot, type Message } from "@/state/store";

import { ChatView } from "./ChatView";

vi.mock("shiki", () => ({ codeToHtml: async (code: string) => `<pre><code>${code}</code></pre>` }));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

class FakeEventSource {
  onmessage: ((event: { data: string; lastEventId: string }) => void) | null = null;
  close = vi.fn();
}

const messages: Message[] = [
  { id: "u1", at: 1, role: "user", kind: "text", text: "Ask Atlas" },
  { id: "comm", at: 2, role: "bot", kind: "activity", tool: { name: "Message to @Atlas" }, comm: { groupId: "pair", withBotId: "b2", withName: "Atlas", withColor: "pink", peer: "message" } },
  { id: "b1", at: 3, role: "bot", kind: "text", text: "Reading." },
  { id: "step", at: 4, role: "bot", kind: "activity", tool: { name: "Read", summary: "src/a.ts", ok: true, durationMs: 300 } },
  { id: "b2", at: 5, role: "bot", kind: "text", text: "Done." },
];

const bot = {
  id: "flat", threadId: "thread-flat", name: "Flat", title: "", description: "", notifications: false,
  color: "iris", unread: false, modelSelection: { instanceId: "inst", model: "m" }, messages, hasMore: false,
} as unknown as Bot;

function Seed() {
  const { dispatch } = useStore();
  useEffect(() => {
    dispatch({ type: "configStatus", config: { features: { showToolCalls: true } } } as never);
    dispatch({ type: "provisioning", botId: "flat", on: true });
  }, [dispatch]);
  return null;
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  localStorage.clear();
});

const tokens = (el: Element) => new Set(el.className.split(/\s+/));

describe("ChatView tool chips", () => {
  it("draws the conversation, step and provisioning chips flat, with a fill only on the button's hover and focus", async () => {
    vi.stubGlobal("EventSource", FakeEventSource);
    vi.stubGlobal("fetch", vi.fn(async () => new Response("{}", { status: 404 })));
    vi.stubGlobal("ResizeObserver", class {
      observe() {}
      unobserve() {}
      disconnect() {}
    });
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const host = document.createElement("div");
    document.body.append(host);
    const root = createRoot(host);
    await act(async () => root.render(createElement(StoreProvider, null, createElement(Seed), createElement(ChatView, { bot }))));
    try {
      const comm = host.querySelector<HTMLButtonElement>('button[title="Open the conversation with Atlas"]')!;
      const step = [...host.querySelectorAll("div")].find((el) => el.firstElementChild?.nextElementSibling?.textContent === "Read src/a.ts")!;
      const provisioning = [...host.querySelectorAll("div")].find((el) => el.lastChild?.nodeType === Node.TEXT_NODE && el.lastChild.textContent === "Setting up this bot's computer…")!;
      for (const chip of [comm, step, provisioning]) {
        const cls = tokens(chip);
        expect(cls.has("border-transparent")).toBe(true);
        expect([...cls].filter((c) => /^(bg-|border-hairline|rounded-(full|2xl))/.test(c))).toEqual([]);
      }
      const button = tokens(comm);
      for (const c of ["rounded-lg", "hover:bg-control", "focus-visible:bg-control", "hover:text-ink", "focus-visible:text-ink"]) expect(button.has(c)).toBe(true);
    } finally {
      await act(async () => root.unmount());
      host.remove();
    }
  });
});
