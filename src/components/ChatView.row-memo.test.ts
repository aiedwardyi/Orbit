// @vitest-environment happy-dom
import { act, createElement, Profiler, useEffect, type Dispatch } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";

import { StoreProvider, useStore, type Action, type Bot, type Message } from "@/state/store";

import { ChatView } from "./ChatView";

vi.mock("shiki", () => ({ codeToHtml: async (code: string) => `<pre><code>${code}</code></pre>` }));

class FakeEventSource {
  onmessage: ((event: { data: string; lastEventId: string }) => void) | null = null;
  close = vi.fn();
}

const messages: Message[] = [
  { id: "u1", at: 1, role: "user", kind: "text", text: "First question" },
  { id: "b1", parentId: "u1", at: 2, role: "bot", kind: "text", text: "First answer." },
  { id: "u2", parentId: "b1", at: 3, role: "user", kind: "text", text: "Second question" },
  { id: "b2", parentId: "u2", at: 4, role: "bot", kind: "text", text: "Second answer." },
];

const bot = {
  id: "memo", threadId: "thread-memo", name: "Memo", title: "", description: "", notifications: false,
  color: "iris", unread: false, modelSelection: { instanceId: "inst", model: "m" }, messages, activeLeafId: "b2", hasMore: false,
} as unknown as Bot;

const harness: { dispatch?: Dispatch<Action> } = {};

function View() {
  const { state, dispatch } = useStore();
  harness.dispatch = dispatch;
  useEffect(() => {
    dispatch({ type: "hydrate", bots: [bot], groups: [], computerControl: {}, sidebarOrder: { sectionOrder: [], itemOrder: {} } });
    dispatch({ type: "configStatus", config: { features: { showToolCalls: true } } } as never);
  }, [dispatch]);
  const live = state.bots.find((b) => b.id === bot.id);
  return live ? createElement(ChatView, { bot: live }) : null;
}

type Fiber = { type: unknown; memoizedProps: { message?: Message } | null; memoizedState: unknown; child: Fiber | null; sibling: Fiber | null };

/** Each mounted Bubble's first hook by message id: a new object means that row rendered again. */
function bubbleHooks(host: Element): Map<string, unknown> {
  const key = Object.keys(host).find((k) => k.startsWith("__reactContainer$"));
  if (!key) throw new Error("React root key not found");
  const container = (host as unknown as Record<string, { stateNode: { current: Fiber } }>)[key];
  const hooks = new Map<string, unknown>();
  const stack = [container.stateNode.current];
  while (stack.length) {
    const fiber = stack.pop()!;
    const id = fiber.memoizedProps?.message?.id;
    // the bundler may suffix the inner name of a memo'd component
    if (typeof fiber.type === "function" && /^Bubble\d*$/.test(fiber.type.name) && id) hooks.set(id, fiber.memoizedState);
    if (fiber.child) stack.push(fiber.child);
    if (fiber.sibling) stack.push(fiber.sibling);
  }
  return hooks;
}

async function mount() {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
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
  const commits = { count: 0 };
  await act(async () => root.render(createElement(
    StoreProvider,
    null,
    createElement(Profiler, { id: "chat", onRender: () => void commits.count++ }, createElement(View)),
  )));
  return {
    host,
    commits,
    unmount: async () => {
      await act(async () => root.unmount());
      host.remove();
    },
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  localStorage.clear();
});

describe("ChatView settled rows", () => {
  it("keeps settled bubbles from re-rendering when another row lands", async () => {
    const view = await mount();
    try {
      const before = bubbleHooks(view.host);
      expect([...before.keys()].sort()).toEqual(["b1", "b2", "u1", "u2"]);
      const commits = view.commits.count;
      const step: Message = { id: "t1", parentId: "b2", at: 5, role: "bot", kind: "activity", tool: { name: "Read", summary: "src/a.ts", ok: true, durationMs: 300 } };
      await act(async () => harness.dispatch!({ type: "messageAdded", threadId: "thread-memo", message: step }));
      expect(view.commits.count).toBeGreaterThan(commits);
      expect(view.host.querySelector('[data-mid="t1"]')?.textContent).toContain("src/a.ts");
      const after = bubbleHooks(view.host);
      for (const [id, hook] of before) expect(after.get(id), id).toBe(hook);
    } finally {
      await view.unmount();
    }
  });

  it("re-renders a row when its own reaction or pin changes", async () => {
    const view = await mount();
    try {
      const before = bubbleHooks(view.host);
      await act(async () => harness.dispatch!({ type: "toggleReaction", threadId: "thread-memo", messageId: "b1", emoji: "👍" }));
      const reacted = bubbleHooks(view.host);
      expect(reacted.get("b1")).not.toBe(before.get("b1"));
      for (const id of ["u1", "u2", "b2"]) expect(reacted.get(id), id).toBe(before.get(id));
      expect(view.host.querySelector('[data-mid="b1"] [data-message-reactions]')?.textContent).toContain("👍");

      await act(async () => harness.dispatch!({ type: "updateBot", botId: "memo", patch: { pinnedMessageId: "u1" } }));
      const pinned = bubbleHooks(view.host);
      expect(pinned.get("u1")).not.toBe(reacted.get("u1"));
      for (const id of ["b1", "u2", "b2"]) expect(pinned.get(id), id).toBe(reacted.get(id));
      expect(view.host.querySelector('[title="Jump to the pinned message"]')?.textContent).toContain("First question");
    } finally {
      await view.unmount();
    }
  });
});
