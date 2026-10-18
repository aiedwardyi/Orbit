// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";

import { StoreProvider, type Bot, type Message } from "@/state/store";
import type { TurnStreamState } from "@/lib/turn-stage";

import { ChatView, clearLivePaneCache } from "./ChatView";

const live = vi.hoisted(() => ({ current: { streaming: {}, reasoning: {}, signal: {}, gen: {}, turn: {} } as TurnStreamState }));
// oxlint-disable-next-line anti-slop/no-module-mocking -- ChatView reads the live turn from the store; this test steps that buffer by hand.
vi.mock("@/state/store", async (importOriginal) => ({
  ...await importOriginal<typeof import("@/state/store")>(),
  useStreaming: () => live.current,
}));
// oxlint-disable-next-line anti-slop/no-module-mocking -- Markdown highlighting is not what this test checks.
vi.mock("shiki", () => ({ codeToHtml: async (code: string) => `<pre><code>${code}</code></pre>` }));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

class FakeEventSource {
  onmessage: ((event: { data: string; lastEventId: string }) => void) | null = null;
  close = vi.fn();
}

const thread = "thread-a";
const atA = 1_792_234_847_942;
const atReally = 1_792_234_930_191;

const baseBot = {
  id: "a",
  threadId: thread,
  name: "Pokkey",
  title: "",
  description: "",
  notifications: false,
  color: "iris",
  unread: false,
  busy: true,
  activity: "working",
  modelSelection: { instanceId: "inst", model: "m" },
  messages: [],
} as unknown as Bot;

const prompt: Message = { id: "prompt", at: atA - 60_000, role: "user", kind: "text", text: "tomorrow morning's preview." };
const userA: Message = { id: "user-a", sendId: "send-a", parentId: "prompt", at: atA, role: "user", kind: "text", text: "thats all great", steered: true };
const act1: Message = { id: "act-1", parentId: "user-a", at: atA + 1_000, role: "bot", kind: "activity", tool: { name: "Read", ok: true } };
const good: Message = { id: "good", parentId: "act-1", at: atA + 50_000, role: "bot", kind: "text", text: "Good idea" };
const launch: Message = {
  id: "launch",
  parentId: "good",
  at: atA + 52_000,
  role: "bot",
  kind: "launch",
  text: "Launched PREVIEW server :4618\nLabel: PREVIEW server :4618\nWorking folder: C:\\repo\nSession: launch",
};
const userB: Message = { id: "user-b", sendId: "send-b", parentId: "launch", at: atReally - 9_000, role: "user", kind: "text", text: "really?", steered: true };
const act2: Message = { id: "act-2", parentId: "user-b", at: atReally - 4_000, role: "bot", kind: "activity", tool: { name: "Read", ok: true } };
const really: Message = { id: "really", parentId: "act-2", at: atReally, role: "bot", kind: "text", text: "Really. It's small" };

const turn = (streaming?: string, tail?: string): TurnStreamState => ({
  streaming: streaming ? { [thread]: streaming } : {},
  reasoning: {},
  signal: { [thread]: "started" },
  turn: streaming && tail ? { [thread]: `0:${tail}` } : {},
});

const bot = (messages: Message[]): Bot => ({ ...baseBot, messages, activeLeafId: messages.at(-1)?.id });

function mount() {
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
  const render = (next: Bot) => act(async () => root.render(createElement(StoreProvider, null, createElement(ChatView, { bot: next }))));
  const unmount = async () => {
    await act(async () => root.unmount());
    host.remove();
  };
  return { host, render, unmount };
}

function settledFooter(host: ParentNode) {
  const mascot = host.querySelector("[data-turn-mascot]");
  const carried = mascot?.closest("[data-orbit-message]")?.querySelector("button")?.textContent ?? "";
  return {
    userA: host.querySelector('[data-mid="user-a"] [data-message-hover-actions]'),
    userB: host.querySelector('[data-mid="user-b"] [data-message-hover-actions]'),
    really: host.querySelector('[data-mid="really"] [data-message-hover-actions]'),
    alone: host.querySelector(".turn-presence [data-turn-mascot]"),
    carried,
  };
}

afterEach(() => {
  live.current = { streaming: {}, reasoning: {}, signal: {}, gen: {}, turn: {} };
  clearLivePaneCache();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  localStorage.clear();
});

describe("turn footer after a mid-turn send", () => {
  it("keeps settled reply actions and leaves the wait row without that reply's time", async () => {
    const { host, render, unmount } = mount();
    try {
      live.current = turn("Good idea", "act-1");
      await render(bot([prompt, userA, act1]));
      live.current = turn();
      await render(bot([prompt, userA, act1, good]));
      await render(bot([prompt, userA, act1, good, launch]));
      expect(host.querySelector('[data-mid="good"] [data-message-hover-actions]')).not.toBeNull();
      expect(host.querySelector(".turn-presence [data-turn-mascot]")).not.toBeNull();

      live.current = turn("Really. It's small", "act-2");
      await render(bot([prompt, userA, act1, good, launch, userB, act2]));
      expect(host.querySelector('[data-turn-mascot]')?.closest("[data-mid]")?.getAttribute("data-mid")).toBe(`stream:${thread}:act-2`);
      expect(host.querySelector(".turn-presence")).toBeNull();

      live.current = turn();
      await render(bot([prompt, userA, act1, good, launch, userB, act2, really]));
      const footer = settledFooter(host);
      expect(footer.userA, "earlier steered message keeps its action row").not.toBeNull();
      expect(footer.userB, "later steered message keeps its action row").not.toBeNull();
      expect(footer.really, "settled reply keeps its action row").not.toBeNull();
      expect(footer.alone, "wait row stands alone").not.toBeNull();
      expect(footer.carried, "wait row does not carry the reply time").toBe("");
    } finally {
      await unmount();
    }

    const fresh = mount();
    try {
      live.current = turn();
      await fresh.render(bot([prompt, userA, act1, good, launch, userB, act2, really]));
      const again = settledFooter(fresh.host);
      expect(again.userA).not.toBeNull();
      expect(again.really).not.toBeNull();
      expect(again.alone).not.toBeNull();
      expect(again.carried, "a fresh mount leaves the wait row without the reply time").toBe("");
    } finally {
      await fresh.unmount();
    }
  });
});
