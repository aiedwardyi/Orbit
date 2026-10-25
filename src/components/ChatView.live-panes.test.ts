// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";

import { workerRuns, type WorkerRun } from "@/lib/worker-runs";
import { useLivePanes } from "./ChatView";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

type Snapshot = { panes: { sessionId: string; main: boolean; exited: boolean }[] };

function stubBridge() {
  const resolvers = new Map<string, (snapshot: Snapshot) => void>();
  const opened: Array<(event: { id: string; botId: string; label: string | null; generation: number }) => void> = [];
  const readBot = vi.fn((botId: string) => new Promise<Snapshot>((resolve) => { resolvers.set(botId, resolve); }));
  vi.stubGlobal("ogb", {
    platform: "win32",
    terminal: {
      readBot,
      onOpened: vi.fn((cb: (typeof opened)[number]) => { opened.push(cb); return () => {}; }),
      onClosed: vi.fn(() => () => {}),
      onExit: vi.fn(() => () => {}),
    },
  });
  return { resolvers, opened };
}

const answer = async (resolvers: Map<string, (snapshot: Snapshot) => void>, botId: string, ids: string[]) => {
  await vi.waitFor(() => expect(resolvers.has(botId)).toBe(true));
  await act(async () => {
    resolvers.get(botId)!({ panes: ids.map((sessionId) => ({ sessionId, main: false, exited: false })) });
    await sleep(10);
  });
};

function Probe({ botId, seen, runs }: { botId: string; seen: (string[] | null)[]; runs?: WorkerRun[] }) {
  const panes = useLivePanes(botId, true, `${botId}-panes`, `${botId}-sessions`, undefined, runs);
  seen.push(panes === null ? null : [...panes].sort());
  return null;
}

const mountProbe = async (botId: string, seen: (string[] | null)[], runs?: WorkerRun[]) => {
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  await act(async () => root.render(createElement(Probe, { botId, seen, runs })));
  return {
    show: async (next: string) => { await act(async () => root.render(createElement(Probe, { botId: next, seen }))); },
    unmount: async () => { await act(async () => root.unmount()); host.remove(); },
  };
};

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("useLivePanes", () => {
  it("renders the cached set on switch and drops panes closed while away", async () => {
    const { resolvers } = stubBridge();
    const seen: (string[] | null)[] = [];
    const probe = await mountProbe("pane-a", seen);
    try {
      await answer(resolvers, "pane-a", ["pane-a-1", "pane-a-2"]);
      await vi.waitFor(() => expect(seen.at(-1)).toEqual(["pane-a-1", "pane-a-2"]));
      const firstVisit = seen.length;
      await probe.show("pane-b");
      expect(seen.slice(firstVisit)).toEqual([null]);
      await answer(resolvers, "pane-b", ["pane-b-1"]);
      await vi.waitFor(() => expect(seen.at(-1)).toEqual(["pane-b-1"]));
      const back = seen.length;
      await probe.show("pane-a");
      expect(seen.slice(back)).toEqual([["pane-a-1", "pane-a-2"]]);
      await answer(resolvers, "pane-a", ["pane-a-1"]);
      await vi.waitFor(() => expect(seen.at(-1)).toEqual(["pane-a-1"]));
    } finally {
      await probe.unmount();
    }
  });

  it("keeps a pane opened during the read", async () => {
    const { resolvers, opened } = stubBridge();
    const seen: (string[] | null)[] = [];
    const probe = await mountProbe("open-a", seen);
    try {
      await answer(resolvers, "open-a", ["open-a-1"]);
      await probe.show("open-b");
      await answer(resolvers, "open-b", ["open-b-1"]);
      await probe.show("open-a");
      await vi.waitFor(() => expect(seen.at(-1)).toEqual(["open-a-1"]));
      await act(async () => { opened.at(-1)!({ id: "open-a-9", botId: "open-a", label: null, generation: 1 }); });
      expect(seen.at(-1)).toEqual(["open-a-1", "open-a-9"]);
      await answer(resolvers, "open-a", ["open-a-1"]);
      await vi.waitFor(() => expect(seen.at(-1)).toEqual(["open-a-1", "open-a-9"]));
    } finally {
      await probe.unmount();
    }
  });

  it("reads again on a beat while a run waits on a stall note, until its pane moves on", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    const reads: Array<(snapshot: Snapshot & { panes: { changedAt: number }[] }) => void> = [];
    vi.stubGlobal("ogb", { platform: "win32", terminal: {
      readBot: vi.fn(() => new Promise((resolve) => { reads.push(resolve); })),
      onOpened: vi.fn(() => () => {}),
      onClosed: vi.fn(() => () => {}),
      onExit: vi.fn(() => () => {}),
    } });
    const pane = "beefbeef-0000-4000-8000-000000000001";
    const runs = workerRuns([{ id: "n1", at: 200_000, role: "bot", kind: "note", text: "[pane beefbeef] from Wink (beat): STALLED: no screen change for 2 min and no report." }]);
    const reply = async (n: number, changedAt: number) => {
      await vi.waitFor(() => expect(reads.length).toBeGreaterThan(n));
      await act(async () => { reads[n]!({ panes: [{ sessionId: pane, main: false, exited: false, changedAt }] }); await sleep(10); });
    };
    const probe = await mountProbe("beat", [], runs);
    try {
      await reply(0, 1_000);
      await reply(1, 1_000);
      await act(async () => { vi.advanceTimersByTime(15_000); });
      await reply(2, 300_000);
      const settled = reads.length;
      await act(async () => { vi.advanceTimersByTime(60_000); await sleep(10); });
      expect(reads).toHaveLength(settled);
    } finally {
      await probe.unmount();
    }
  });

  it("uses the per-bot cache on the phone poll path", async () => {
    const polls: Array<(ids: string[]) => void> = [];
    vi.stubGlobal("fetch", vi.fn(async () => {
      const ids = await new Promise<string[]>((resolve) => { polls.push(resolve); });
      return Response.json({ panes: ids.map((sessionId) => ({ sessionId, main: false, exited: false })) });
    }));
    const poll = async (n: number, ids: string[]) => {
      await vi.waitFor(() => expect(polls.length).toBeGreaterThan(n));
      await act(async () => { polls[n]!(ids); await sleep(10); });
    };
    const seen: (string[] | null)[] = [];
    const probe = await mountProbe("poll-a", seen);
    try {
      await poll(0, ["poll-a-1"]);
      await vi.waitFor(() => expect(seen.at(-1)).toEqual(["poll-a-1"]));
      const firstVisit = seen.length;
      await probe.show("poll-b");
      expect(seen.slice(firstVisit)).toEqual([null]);
      await poll(1, ["poll-b-1"]);
      await vi.waitFor(() => expect(seen.at(-1)).toEqual(["poll-b-1"]));
      const back = seen.length;
      await probe.show("poll-a");
      expect(seen.slice(back)).toEqual([["poll-a-1"]]);
    } finally {
      await probe.unmount();
    }
  });
});
