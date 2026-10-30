// @vitest-environment happy-dom
import { act, createElement, useState } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";

import { StoreProvider, useStore, type Bot, type Message } from "@/state/store";
import type { TurnStreamState } from "@/lib/turn-stage";

import { ChatView } from "./ChatView";

const live = vi.hoisted(() => ({ current: { streaming: {}, reasoning: {}, signal: {}, gen: {}, turn: {} } as TurnStreamState }));
vi.mock("@/state/store", async (importOriginal) => ({
  ...await importOriginal<typeof import("@/state/store")>(),
  useStreaming: () => live.current,
}));
vi.mock("shiki", () => ({ codeToHtml: async (code: string) => `<pre><code>${code}</code></pre>` }));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

class FakeEventSource {
  onmessage: ((event: { data: string; lastEventId: string }) => void) | null = null;
  close = vi.fn();
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

type Snapshot = { panes: { sessionId: string; main: boolean; exited: boolean }[] };

function stubBridge() {
  const resolvers = new Map<string, (snapshot: Snapshot) => void>();
  const exits: Array<(event: { botId: string; id: string }) => void> = [];
  const readBot = vi.fn((botId: string) => new Promise<Snapshot>((resolve) => { resolvers.set(botId, resolve); }));
  vi.stubGlobal("ogb", {
    platform: "win32",
    terminal: {
      readBot,
      onOpened: vi.fn(() => () => {}),
      onClosed: vi.fn(() => () => {}),
      onExit: vi.fn((cb: (event: { botId: string; id: string }) => void) => { exits.push(cb); return () => {}; }),
    },
  });
  return { resolvers, exits };
}

const answer = async (resolvers: Map<string, (snapshot: Snapshot) => void>, botId: string, ids: string[]) => {
  await vi.waitFor(() => expect(resolvers.has(botId)).toBe(true));
  await act(async () => {
    resolvers.get(botId)!({ panes: ids.map((sessionId) => ({ sessionId, main: false, exited: false })) });
    await sleep(10);
  });
};

const launch = (id: string, nick: string, session: string): Message => ({
  id, at: 1, role: "bot", kind: "launch",
  text: `Launched ${nick} | script\nLabel: ${nick} | script\nSession: ${session}`,
});

const bot = (id: string, name: string, messages: Message[]) =>
  ({
    id, threadId: `thread-${id}`, name, title: "", description: "", notifications: false,
    color: "iris", unread: false, modelSelection: { instanceId: "inst", model: "m" }, messages, hasMore: false,
  }) as unknown as Bot;

let switchBot: (bot: Bot) => void = () => {};
function Harness({ initial }: { initial: Bot }) {
  const [current, setCurrent] = useState<Bot>(initial);
  switchBot = setCurrent;
  return createElement(ChatView, { bot: current });
}

let badgeOf: (botId: string) => string[] = () => [];
let seedBadge: (panes: Record<string, string[]>) => void = () => {};
function BadgeProbe() {
  const { state, dispatch } = useStore();
  badgeOf = (botId) => state.terminalPanes[botId] ?? [];
  seedBadge = (panes) => dispatch({ type: "setTerminalPanes", panes });
  return null;
}

const mountChat = async (initial: Bot, fetchImpl: typeof fetch = async () => new Response("{}", { status: 404 })) => {
  vi.stubGlobal("EventSource", FakeEventSource);
  vi.stubGlobal("fetch", vi.fn(fetchImpl));
  vi.stubGlobal("ResizeObserver", class {
    observe() {}
    unobserve() {}
    disconnect() {}
  });
  vi.spyOn(console, "warn").mockImplementation(() => {});
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  await act(async () => root.render(createElement(StoreProvider, null, createElement(Harness, { initial }), createElement(BadgeProbe))));
  return { host, unmount: async () => { await act(async () => root.unmount()); host.remove(); } };
};

afterEach(() => {
  live.current = { streaming: {}, reasoning: {}, signal: {}, gen: {}, turn: {} };
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  localStorage.clear();
});

const remoteTerminal = (botId: string, live: { ids: string[] }): typeof fetch => {
  return async (input) => {
    if (!String(input).includes(`/api/bots/${botId}/terminal`)) return new Response("{}", { status: 404 });
    return Response.json({ panes: live.ids.map((sessionId) => ({ sessionId, label: `L-${sessionId}`, main: false, exited: false })) });
  };
};

const chipLabel = (host: HTMLElement) => host.querySelector("[data-worker-status]")?.getAttribute("aria-label") ?? null;

describe("worker chip liveness", () => {
  it("lists nothing on a first desktop visit until readBot answers", async () => {
    const { resolvers } = stubBridge();
    const fresh = bot("chip-fresh", "Fresh", [launch("l1", "F1", "f1ffffff-1"), launch("l2", "F2", "f2ffffff-2")]);
    const { host, unmount } = await mountChat(fresh);
    try {
      await vi.waitFor(() => expect(resolvers.has("chip-fresh")).toBe(true));
      expect(host.querySelector("[data-worker-status]")).toBeNull();
      await answer(resolvers, "chip-fresh", ["f1ffffff-1"]);
      await vi.waitFor(() => expect(chipLabel(host)).toBe("1 worker"));
    } finally {
      await unmount();
    }
  });

  it("shows the cached set straight away on switch-back", async () => {
    const { resolvers } = stubBridge();
    const botA = bot("chip-a", "A", [launch("la1", "A1", "a1aaaaaa-1"), launch("la2", "A2", "a2aaaaaa-2")]);
    const botB = bot("chip-b", "B", [launch("lb1", "B1", "b1bbbbbb-1")]);
    const { host, unmount } = await mountChat(botA);
    try {
      await answer(resolvers, "chip-a", ["a1aaaaaa-1"]);
      await vi.waitFor(() => expect(chipLabel(host)).toBe("1 worker"));
      await act(async () => switchBot(botB));
      await answer(resolvers, "chip-b", ["b1bbbbbb-1"]);
      await vi.waitFor(() => expect(chipLabel(host)).toBe("1 worker"));
      await act(async () => switchBot(botA));
      expect(chipLabel(host)).toBe("1 worker");
    } finally {
      await unmount();
    }
  });

  it("counts a live pane with no launch in the loaded messages, and drops it on exit", async () => {
    const { resolvers, exits } = stubBridge();
    const ids = Array.from({ length: 7 }, (_, index) => `p${index}pppppp-${index}`);
    const seven = bot("chip-seven", "Seven", ids.slice(0, 6).map((id, index) => launch(`ls${index}`, `S${index}`, id)));
    const { host, unmount } = await mountChat(seven);
    try {
      await answer(resolvers, "chip-seven", ids);
      await vi.waitFor(() => expect(chipLabel(host)).toBe("7 workers"));
      await act(async () => {
        for (const cb of exits) cb({ botId: "chip-seven", id: ids[6]! });
        await sleep(10);
      });
      await vi.waitFor(() => expect(chipLabel(host)).toBe("6 workers"));
    } finally {
      await unmount();
    }
  });

  describe("device view (remote reads)", () => {
    const ids = ["r0rrrrrr-0", "r1rrrrrr-1", "r2rrrrrr-2"];

    it("drops the badge and the chip together when a pane exits", async () => {
      const remote = bot("chip-remote", "Remote", ids.map((id, index) => launch(`lr${index}`, `R${index}`, id)));
      const live = { ids };
      const { host, unmount } = await mountChat(remote, remoteTerminal("chip-remote", live));
      try {
        await act(async () => seedBadge({ "chip-remote": ids.map((id) => `L-${id}`) }));
        await vi.waitFor(() => expect(chipLabel(host)).toBe("3 workers"));
        expect(badgeOf("chip-remote")).toHaveLength(3);
        live.ids = ids.slice(0, 2);
        await act(async () => {
          document.dispatchEvent(new Event("visibilitychange"));
          await sleep(10);
        });
        await vi.waitFor(() => expect(chipLabel(host)).toBe("2 workers"));
        expect(badgeOf("chip-remote")).toEqual(ids.slice(0, 2).map((id) => `L-${id}`));
      } finally {
        await unmount();
      }
    });

    it("lists the badge's panes when the loaded page has no runs", async () => {
      const bare = bot("chip-bare", "Bare", []);
      const { host, unmount } = await mountChat(bare, remoteTerminal("chip-bare", { ids }));
      try {
        await act(async () => seedBadge({ "chip-bare": ids.map((id) => `L-${id}`) }));
        await vi.waitFor(() => expect(chipLabel(host)).toBe("3 workers"));
      } finally {
        await unmount();
      }
    });
  });
});
