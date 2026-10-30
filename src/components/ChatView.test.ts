// @vitest-environment happy-dom
import { act, createElement, useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";

import { StoreProvider, useStore, type Bot, type Group, type InstanceInfo, type Message } from "@/state/store";

import { setFindCurrent } from "@/lib/chat-find";

import { DRAWER_BUTTON_RIGHT } from "@/lib/drawer-button";
import { PHONE_HEADER_MENU_RESERVE_PX } from "@/lib/phone-header";
import { SIDEBAR_SIDE_KEY } from "@/lib/sidebar-preferences";
import { ChatView, clearLivePaneCache } from "./ChatView";
import { GroupView } from "./GroupView";
import type { TurnStreamState } from "@/lib/turn-stage";

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
  live.current = { streaming: {}, reasoning: {}, signal: {}, gen: {}, turn: {} };
  clearLivePaneCache();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  localStorage.clear();
});

describe("ChatView reply settle", () => {
  it.each(["user", "tools", "legacy"])("keeps the reply row and code card after a %s tail", async (tail) => {
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
    const text = "```js\nconsole.log('stable');\n```";
    const messages: Message[] = tail === "tools" ? [
      ...botA.messages,
      { id: "tool-1", parentId: "ua", at: 1, role: "bot", kind: "activity", tool: { name: "Read", ok: true } },
      { id: "tool-2", parentId: "tool-1", at: 1, role: "bot", kind: "activity", tool: { name: "Read", ok: true } },
    ] : botA.messages;
    const current = { ...botA, messages };
    const parentId = messages.at(-1)!.id;
    const reply: Message = { id: "reply-a", parentId: tail === "legacy" ? undefined : parentId, at: 2, role: "bot", kind: "text", text };
    const completed = { ...current, messages: [...messages, reply], activeLeafId: tail === "legacy" ? undefined : reply.id };
    const render = async (bot: Bot) => {
      await act(async () => root.render(createElement(StoreProvider, null, createElement(ChatView, { bot }))));
    };
    try {
      live.current = { streaming: { "thread-a": text }, reasoning: {}, signal: {}, turn: { "thread-a": `0:${parentId}` } };
      await render(current);
      await act(async () => { await sleep(300); });
      const user = host.querySelector('[data-orbit-message="user"]');
      const row = host.querySelector('[data-orbit-message="bot"]');
      const body = row?.querySelector("[data-orbit-message-body]");
      const content = row?.querySelector("[data-orbit-message-content]");
      const markdown = row?.querySelector(".chat-md");
      const card = markdown?.firstElementChild;
      const copy = card?.querySelector("button");
      const code = card?.querySelector("pre");
      expect.soft(body).not.toBeNull();
      expect(copy).toBeTruthy();
      const widths = [row?.className, body?.className, content?.className];
      await render(completed);
      expect.soft(host.querySelectorAll('[data-orbit-message="bot"]')).toHaveLength(1);
      expect.soft(host.querySelector('[data-orbit-message="bot"]')).toBe(row);
      expect.soft(host.querySelector(".chat-md")).toBe(markdown);
      expect.soft(host.querySelector('.chat-md button')).toBe(copy);
      live.current = { streaming: {}, reasoning: {}, signal: {}, turn: {} };
      await render({ ...completed, busy: false, activity: "idle" });
      await act(async () => { await sleep(600); });
      const settled = host.querySelector('[data-orbit-message="bot"]');
      expect.soft(settled).toBe(row);
      expect.soft(settled?.querySelector("[data-orbit-message-body]")).toBe(body);
      expect.soft(settled?.querySelector("[data-orbit-message-content]")).toBe(content);
      expect.soft(settled?.querySelector(".chat-md")?.firstElementChild).toBe(card);
      expect.soft(settled?.querySelector("pre")).toBe(code);
      expect.soft(host.querySelector('[data-orbit-message="user"]')).toBe(user);
      expect.soft([
        settled?.className,
        settled?.querySelector("[data-orbit-message-body]")?.className,
        settled?.querySelector("[data-orbit-message-content]")?.className,
      ]).toEqual(widths);
      const followup = { ...userMsg("followup", "Next question"), parentId: reply.id, at: 3 };
      live.current = { streaming: { "thread-a": "Second reply" }, reasoning: {}, signal: {}, turn: { "thread-a": "0:followup" } };
      await render({ ...completed, messages: [...completed.messages, followup], activeLeafId: tail === "legacy" ? undefined : followup.id });
      expect(host.querySelectorAll('[data-orbit-message="bot"]')).toHaveLength(2);
      expect(host.querySelector('[data-orbit-message="bot"]')).toBe(row);
      expect(row?.querySelector("pre")).toBe(code);
    } finally {
      await act(async () => root.unmount());
      host.remove();
    }
  });
});

describe("ChatView worker rows", () => {
  const LABEL = "THEME-CYCLE | Sonnet 5.5 | medium";
  const launch = (id: string, label: string, at = 1): Message => ({ id, at, role: "bot", kind: "launch", text: `Launched ${label}\nLabel: ${label}\nWorking folder: C:\\repo\nSession: ${id}` });
  const note = (id: string, pane: string, text: string, at = 2, label = "X"): Message => ({ id, at, role: "bot", kind: "note", text: `[pane ${pane.slice(0, 8)}] [${label}] from Wink (61902933-1c2d-4e5f-8a9b-0c1d2e3f4a5b): ${text}` });
  const stubDom = () => {
    vi.stubGlobal("EventSource", FakeEventSource);
    vi.stubGlobal("fetch", vi.fn(async () => new Response("{}", { status: 404 })));
    vi.stubGlobal("ResizeObserver", class {
      observe() {}
      unobserve() {}
      disconnect() {}
    });
    vi.spyOn(console, "warn").mockImplementation(() => {});
  };
  const mountChat = async (bot: Bot, onOpenTerminalPane?: (sessionId: string) => void) => {
    const host = document.createElement("div");
    document.body.append(host);
    const root = createRoot(host);
    await act(async () => root.render(createElement(StoreProvider, null, createElement(ChatView, { bot, onOpenTerminalPane }))));
    return { host, unmount: async () => { await act(async () => root.unmount()); host.remove(); } };
  };
  const rows = (host: HTMLElement) => Array.from(host.querySelectorAll<HTMLElement>("[data-worker-run] > button"));
  const states = (host: HTMLElement) => Array.from(host.querySelectorAll("[data-worker-run] [data-worker-state]")).map((el) => el.getAttribute("data-worker-state"));

  it("folds a worker's notes into one row and opens them on tap", async () => {
    stubDom();
    const pane = "0f3c9a1e-1111-4222-8333-944455556666";
    const plain: Message = { id: "plain", at: 4, role: "bot", kind: "note", text: "Synced from Work PC" };
    // SAFETY: botA is a full Bot fixture; only messages is replaced, with valid Messages.
    const current = { ...botA, messages: [
      userMsg("ua", "go"),
      note("n1", pane, "DONE OPUS branch=fix/x sha=3623665c dirty=no\ntests pass", 2, "OPUS | Opus 5.5 | high"),
      note("n2", pane, "still running", 3),
      plain,
    ] } as Bot;
    const { host, unmount } = await mountChat(current);
    try {
      expect(rows(host).map((b) => b.textContent)).toEqual(["OPUSOpus 5.5 · High●Working"]);
      expect(host.querySelector("[data-orbit-worker]")).toBeNull();
      await act(async () => { rows(host)[0]!.click(); });
      const shown = host.querySelector("[data-orbit-worker]")?.textContent ?? "";
      expect(shown).toBe("Finishedtests passstill running");
      for (const machine of ["[pane", "61902933", "branch=", "sha=", "dirty="]) expect(shown).not.toContain(machine);
      expect(Array.from(host.querySelectorAll("button")).map((b) => b.textContent)).toContain("Note");
      await act(async () => { rows(host)[0]!.click(); });
      expect(host.querySelector("[data-orbit-worker]")).toBeNull();
    } finally {
      await unmount();
    }
  });

  it("shows nickname, model, and status for each launch, and the folder when opened", async () => {
    stubDom();
    // SAFETY: botA is a full Bot fixture; only messages is replaced, with valid Messages.
    const current = { ...botA, messages: [userMsg("ua", "go"), launch("p1", LABEL), launch("p2", "B"), launch("p3", "C | script")] } as Bot;
    const { host, unmount } = await mountChat(current);
    try {
      expect(rows(host).map((b) => b.textContent)).toEqual(["THEME-CYCLESonnet 5.5 · MediumMed●Working", "B●Working", "Cscript●Working"]);
      await act(async () => { rows(host)[0]!.click(); });
      expect(host.querySelector("[data-orbit-worker]")?.textContent).toBe("Folder: C:\\repo");
      expect(host.textContent).not.toContain("Launched");
    } finally {
      await unmount();
    }
  });

  it("jumps to an open pane and ends a closed one with no report", async () => {
    stubDom();
    const pane = (sessionId: string) => ({ sessionId, generation: 1, label: null, cwd: "C:\\repo", main: false, exited: false });
    vi.stubGlobal("ogb", { platform: "win32", terminal: { readBot: vi.fn(async () => ({ panes: [pane("p1")] })) } });
    // SAFETY: botA is a full Bot fixture; only messages is replaced, with valid Messages.
    const current = { ...botA, messages: [userMsg("ua", "go"), launch("p1", "A"), launch("p2", "B"), ...Array.from({ length: 28 }, (_, i) => launch(`x${i}`, `X${i}`))] } as Bot;
    const onOpenTerminalPane = vi.fn();
    const readBot = (window.ogb!.terminal!.readBot as ReturnType<typeof vi.fn>);
    const { host, unmount } = await mountChat(current, onOpenTerminalPane);
    try {
      expect(states(host).slice(0, 2)).toEqual(["working", "ended"]);
      await act(async () => { rows(host)[0]!.click(); });
      const open = Array.from(host.querySelectorAll<HTMLButtonElement>("[data-orbit-worker] button")).find((b) => b.textContent === "Running in C:\\repo")!;
      await act(async () => { open.click(); });
      expect(onOpenTerminalPane).toHaveBeenCalledWith("p1");
      await act(async () => { rows(host)[1]!.click(); });
      expect(host.textContent).toContain("Ran in C:\\repo");
      expect(onOpenTerminalPane).toHaveBeenCalledTimes(1);
      expect(host.textContent).not.toContain("Session:");
      expect(readBot).toHaveBeenCalledTimes(1);
    } finally {
      await unmount();
    }
  });

  it("shows a resumed worker working again at the resume", async () => {
    stubDom();
    const pane = "bc9c674b-2844-43b0-982e-88305df70570";
    const resume: Message = {
      id: "r1", at: 4, role: "bot", kind: "launch",
      text: `Resumed A | Opus 5.5 | high\nLabel: A | Opus 5.5 | high\nWorking folder: C:\\repo\nSession: ${pane}`,
    };
    // SAFETY: botA is a full Bot fixture; only messages is replaced, with valid Messages.
    const current = { ...botA, messages: [
      userMsg("ua", "go"),
      launch(pane, "A | Opus 5.5 | high"),
      note("n1", pane, "DONE A branch=x sha=y dirty=no\nAll green.", 3, "A | Opus 5.5 | high"),
      resume,
    ] } as Bot;
    const { host, unmount } = await mountChat(current);
    try {
      expect(rows(host)).toHaveLength(1);
      expect(rows(host)[0]!.textContent).toBe("AOpus 5.5 · High●Working");
      expect(host.querySelector("[data-worker-run]")!.closest("[data-mid]")?.getAttribute("data-mid")).toBe("r1");
      await act(async () => { rows(host)[0]!.click(); });
      expect(host.querySelector("[data-orbit-worker]")?.textContent).toContain("All green.");
    } finally {
      await unmount();
    }
  });

  it("takes the newest report as the state and keeps it over a closed pane", async () => {
    stubDom();
    vi.stubGlobal("ogb", { platform: "win32", terminal: { readBot: vi.fn(async () => ({ panes: [] })) } });
    const done = "bc9c674b-2844-43b0-982e-88305df70570";
    const failed = "0f3c9a1e-1111-4222-8333-944455556666";
    // SAFETY: botA is a full Bot fixture; only messages is replaced, with valid Messages.
    const current = { ...botA, messages: [
      userMsg("ua", "go"), launch(done, "A"), launch(failed, "B"),
      note("n1", done, "FAIL A branch=x sha=y dirty=no\nfirst try broke", 2),
      note("n2", done, "DONE A branch=fix/a sha=3623665c dirty=no\nAll green.", 3),
      note("n3", failed, "FAIL B branch=x sha=y dirty=yes\nThe build broke.", 4),
    ] } as Bot;
    const { host, unmount } = await mountChat(current, vi.fn());
    try {
      expect(rows(host).map((b) => b.textContent)).toEqual(["A✓Done", "B!Failed"]);
      await act(async () => { rows(host)[0]!.click(); });
      const shown = host.querySelector("[data-orbit-worker]")?.textContent ?? "";
      expect(shown).toBe("Ran in C:\\repoFailedfirst try brokeFinishedAll green.");
      for (const machine of ["Session", "Label", "branch=", "sha=", "dirty=", done]) expect(shown).not.toContain(machine);
      expect(host.querySelector("[data-worker-status]")).toBeNull();
    } finally {
      await unmount();
    }
  });

  it("keeps a pane closed when its close lands before the snapshot", async () => {
    stubDom();
    const pane = (sessionId: string) => ({ sessionId, generation: 1, label: null, cwd: "C:\\repo", main: false, exited: false });
    let resolveSnapshot: (value: { panes: ReturnType<typeof pane>[] }) => void = () => {};
    let opened: (event: { botId: string; id: string }) => void = () => {};
    let closed: (event: { botId: string; id: string }) => void = () => {};
    vi.stubGlobal("ogb", { platform: "win32", terminal: {
      readBot: vi.fn(() => new Promise((resolve) => { resolveSnapshot = resolve; })),
      onOpened: vi.fn((cb: typeof opened) => { opened = cb; return () => {}; }),
      onClosed: vi.fn((cb: typeof closed) => { closed = cb; return () => {}; }),
    } });
    // SAFETY: botA is a full Bot fixture; only messages is replaced, with valid Messages.
    const current = { ...botA, messages: [userMsg("ua", "go"), launch("p1", "A"), launch("p2", "B"), launch("p3", "C")] } as Bot;
    const { host, unmount } = await mountChat(current, vi.fn());
    try {
      await act(async () => { closed({ botId: botA.id, id: "p1" }); opened({ botId: botA.id, id: "p2" }); });
      await act(async () => { resolveSnapshot({ panes: [pane("p1"), pane("p3")] }); });
      expect(states(host)).toEqual(["ended", "working", "working"]);
    } finally {
      await unmount();
    }
  });

  it("ends exited desktop panes while DONE and FAIL still win", async () => {
    stubDom();
    const ids = ["aaaaaaaa-1", "bbbbbbbb-1", "cccccccc-1", "dddddddd-1"];
    vi.stubGlobal("ogb", { platform: "win32", terminal: {
      readBot: async () => ({ panes: ids.map((sessionId) => ({ sessionId, main: false, exited: true })) }),
    } });
    const current: Bot = { ...botA, messages: [
      ...ids.map((id, i) => launch(id, `W${i}`)),
      note("n1", ids[1]!, "BLOCKED W1 branch=x sha=y dirty=no", 2),
      note("n2", ids[2]!, "DONE W2 branch=x sha=y dirty=no", 3),
      note("n3", ids[3]!, "FAIL W3 branch=x sha=y dirty=no", 4),
    ] };
    const { host, unmount } = await mountChat(current);
    try {
      expect(states(host)).toEqual(["ended", "ended", "done", "failed"]);
      expect(host.querySelector("[data-worker-status]")).toBeNull();
    } finally {
      await unmount();
    }
  });

  it("keeps desktop exit events over a late snapshot and unsubscribes", async () => {
    stubDom();
    const panes = ["aaaaaaaa-1", "bbbbbbbb-1", "cccccccc-1"].map((sessionId) => ({ sessionId, main: false, exited: false }));
    let resolveSnapshot: (value: { panes: typeof panes }) => void = () => {};
    let exit: (event: { id: string; exitCode: number }) => void = () => {};
    const offExit = vi.fn();
    vi.stubGlobal("ogb", { platform: "win32", terminal: {
      readBot: () => new Promise((resolve) => { resolveSnapshot = resolve; }),
      onExit: (cb: typeof exit) => { exit = cb; return offExit; },
    } });
    const current: Bot = { ...botA, messages: [
      ...panes.map((pane, i) => launch(pane.sessionId, `W${i}`)),
      note("n1", panes[2]!.sessionId, "DONE W2 branch=x sha=y dirty=no", 2),
    ] };
    const { host, unmount } = await mountChat(current);
    try {
      await act(async () => exit({ id: panes[0]!.sessionId, exitCode: 1 }));
      await act(async () => resolveSnapshot({ panes }));
      expect(states(host)).toEqual(["ended", "working", "done"]);
      await act(async () => {
        exit({ id: panes[1]!.sessionId, exitCode: 0 });
        exit({ id: panes[2]!.sessionId, exitCode: 0 });
      });
      expect(states(host)).toEqual(["ended", "ended", "done"]);
      expect(host.querySelector("[data-worker-status]")).toBeNull();
    } finally {
      await unmount();
    }
    expect(offExit).toHaveBeenCalledOnce();
  });

  it("shows a strip for live runs that opens the list, urgent first", async () => {
    stubDom();
    const [a, b, c, d] = ["aaaaaaaa-1", "bbbbbbbb-1", "cccccccc-1", "dddddddd-1"];
    // SAFETY: botA is a full Bot fixture; only messages is replaced, with valid Messages.
    const current = { ...botA, messages: [
      userMsg("ua", "go"),
      launch(a, "BUILD | GPT-6 Astra | high", 1),
      launch(b, "GUIDE | Opus 5.5 | high", 2),
      launch(c, "COPY | Gemini 3.8 | high", 3),
      launch(d, "SHIP | Grok 4.7 | high", 4),
      note("n1", b, "BLOCKED GUIDE branch=x sha=y dirty=no\nWhich skin?", 5),
      note("n2", c, "DONE COPY branch=x sha=y dirty=no", 6),
      note("n3", d, "FAIL SHIP branch=x sha=y dirty=no", 7),
    ] } as Bot;
    const { host, unmount } = await mountChat(current);
    try {
      expect(states(host)).toEqual(["working", "waiting", "done", "failed"]);
      const strip = host.querySelector<HTMLButtonElement>("[data-worker-status]")!;
      expect(strip.closest("[class*='@container/chathead']")).not.toBeNull();
      expect(host.querySelector("[data-orbit-composer]")?.closest("[class*='z-[2]']")?.querySelector("[data-worker-status]") ?? null).toBeNull();
      expect(strip.getAttribute("aria-label")).toBe("2 workers");
      expect(strip.textContent).toBe("2 workers");
      expect(strip.querySelector("svg")).toBeNull();
      await act(async () => { strip.click(); });
      const list = document.body.querySelector("[data-worker-list]")!;
      expect(list.getAttribute("role")).toBe("dialog");
      expect(list.querySelector("h2")?.textContent).toBe("A's workers");
      expect(Array.from(list.querySelectorAll("li")).map((li) => li.textContent)).toEqual([
        "GUIDEOpus 5.5 · High‖Waiting", "BUILDGPT-6 Astra · High●Working",
      ]);
      await act(async () => { document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })); });
      expect(document.body.querySelector("[data-worker-list]")).toBeNull();
    } finally {
      await unmount();
    }
  });

  it("counts all workers in the header words", async () => {
    stubDom();
    const current = { ...botA, messages: [userMsg("ua", "go"), ...Array.from({ length: 7 }, (_, i) => launch(`${i}0000000-1`, `W${i} | Opus 5.5 | high`, i + 1))] } as Bot;
    const { host, unmount } = await mountChat(current);
    try {
      expect(host.querySelector("[data-worker-status]")?.textContent).toBe("7 workers");
      expect(host.querySelector("[data-worker-strip]")).toBeNull();
    } finally { await unmount(); }
  });

  it("hides the header status when only a done pane is live", async () => {
    stubDom();
    const closedWork = "aaaaaaaa-1";
    const liveDone = "cccccccc-1";
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      if (String(input).includes("/terminal")) {
        return new Response(JSON.stringify({ panes: [{ sessionId: liveDone, main: false }] }), { status: 200 });
      }
      return new Response("{}", { status: 404 });
    }));
    // SAFETY: botA is a full Bot fixture; only messages is replaced, with valid Messages.
    const current = { ...botA, messages: [
      launch(closedWork, "WORK | Opus 5.5 | high", 1),
      launch(liveDone, "COPY | Opus 5.5 | high", 2),
      note("n1", liveDone, "DONE COPY branch=x sha=y dirty=no", 3),
    ] } as Bot;
    const { host, unmount } = await mountChat(current);
    try {
      await vi.waitFor(() => expect(states(host)).toEqual(["ended", "done"]));
      expect(host.querySelector("[data-worker-status]")).toBeNull();
      expect(document.body.querySelector("[data-worker-list]")).toBeNull();
    } finally {
      await unmount();
    }
  });

  describe("without the desktop bridge", () => {
    const [a, b, c] = ["aaaaaaaa-1", "bbbbbbbb-1", "cccccccc-1"];
    const terminalPath = `/api/bots/${botA.id}/terminal?panes=1`;
    const roster = (...ids: string[]) => ({ panes: [{ sessionId: "main-1", main: true }, ...ids.map((sessionId) => ({ sessionId, main: false }))] });
    // SAFETY: botA is a full Bot fixture; only messages is replaced, with valid Messages.
    const threeRuns = () => ({ ...botA, messages: [userMsg("ua", "go"), launch(a, "A"), launch(b, "B"), launch(c, "C")] } as Bot);
    const reply = (status: number, body: { error?: string; panes?: Array<{ sessionId: string; main: boolean; exited?: boolean }> }) => new Response(JSON.stringify(body), { status });
    const stubTerminal = (answer: (call: number) => Promise<Response>) => {
      stubDom();
      const calls: string[] = [];
      vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        if (!url.startsWith("/api/bots/") || !url.includes("/terminal")) return reply(404, {});
        calls.push(`${init?.method ?? "GET"} ${url}`);
        return answer(calls.length);
      }));
      return calls;
    };
    let feed: (panes: Record<string, string[]>) => void = () => {};
    function Feed() {
      const { dispatch } = useStore();
      feed = (panes) => dispatch({ type: "setTerminalPanes", panes });
      return null;
    }
    const mountFed = async (bot: Bot) => {
      const host = document.createElement("div");
      document.body.append(host);
      const root = createRoot(host);
      const render = async (next: Bot) => act(async () => root.render(createElement(StoreProvider, null, createElement(Feed), createElement(ChatView, { bot: next }))));
      await render(bot);
      return { host, render, unmount: async () => { await act(async () => root.unmount()); host.remove(); } };
    };
    const settle = () => act(async () => { await sleep(0); });

    it("ends a run whose pane is gone and keeps the live one", async () => {
      const calls = stubTerminal(async () => reply(200, roster(a, c)));
      const { host, unmount } = await mountFed(threeRuns());
      try {
        await settle();
        expect(states(host)).toEqual(["working", "ended", "working"]);
        expect(host.querySelector("[data-worker-status]")?.textContent).toBe("2 workers");
        expect(calls).toEqual([`GET ${terminalPath}`]);
      } finally {
        await unmount();
      }
    });

    it("ends exited phone panes while DONE and FAIL still win", async () => {
      stubTerminal(async () => reply(200, { panes: [a, b, c].map((sessionId) => ({ sessionId, main: false, exited: true })) }));
      const current: Bot = { ...threeRuns(), messages: [
        ...threeRuns().messages,
        note("n1", b, "DONE B branch=x sha=y dirty=no", 2),
        note("n2", c, "FAIL C branch=x sha=y dirty=no", 3),
      ] };
      const { host, unmount } = await mountFed(current);
      try {
        await settle();
        expect(states(host)).toEqual(["ended", "done", "failed"]);
        expect(host.querySelector("[data-worker-status]")).toBeNull();
      } finally {
        await unmount();
      }
    });

    it("rereads a new launch session despite identical pane labels", async () => {
      let live = a;
      const calls = stubTerminal(async () => reply(200, roster(live)));
      const current: Bot = { ...botA, messages: [launch(a, "JOB | script")] };
      const { host, render, unmount } = await mountFed(current);
      try {
        await settle();
        await act(async () => feed({ [botA.id]: ["JOB | script"] }));
        await settle();
        const before = calls.length;
        live = b;
        await render({ ...current, messages: [...current.messages, launch(b, "JOB | script", 2)] });
        for (let i = 0; i < 4; i++) await act(async () => feed({ [botA.id]: ["JOB | script"] }));
        await settle();
        expect(calls).toHaveLength(before + 1);
        expect(states(host)).toEqual(["ended", "working"]);
      } finally {
        await unmount();
      }
    });

    it("retries failed phone reads with capped backoff and keeps the last roster", async () => {
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
      let healthy = false;
      const calls = stubTerminal(async (call) => call === 1 ? reply(200, roster(a)) : healthy ? reply(200, roster(b)) : reply(500, { error: "offline" }));
      const { host, unmount } = await mountFed(threeRuns());
      try {
        await act(async () => feed({ [botA.id]: ["x"] }));
        expect(calls).toHaveLength(2);
        expect(states(host)).toEqual(["working", "ended", "ended"]);
        for (const delay of [1000, 2000, 4000, 8000, 15000, 15000]) {
          const before = calls.length;
          await act(async () => vi.advanceTimersByTimeAsync(delay - 1));
          expect(calls).toHaveLength(before);
          await act(async () => vi.advanceTimersByTimeAsync(1));
          expect(calls).toHaveLength(before + 1);
          expect(states(host)).toEqual(["working", "ended", "ended"]);
        }
        healthy = true;
        await act(async () => vi.advanceTimersByTimeAsync(15000));
        expect(states(host)).toEqual(["ended", "working", "ended"]);
        const before = calls.length;
        await act(async () => vi.advanceTimersByTimeAsync(30000));
        expect(calls).toHaveLength(before);
      } finally {
        await unmount();
        vi.useRealTimers();
      }
    });

    it("coalesces phone refreshes without parallel reads or superseded rosters", async () => {
      const pending: Array<(response: Response) => void> = [];
      const calls = stubTerminal((call) => call === 1 ? Promise.resolve(reply(200, roster(a))) : new Promise<Response>((resolve) => { pending.push(resolve); }));
      const { host, unmount } = await mountFed(threeRuns());
      try {
        await settle();
        await act(async () => feed({ [botA.id]: ["x"] }));
        await act(async () => feed({ [botA.id]: ["y"] }));
        await act(async () => feed({ [botA.id]: ["z"] }));
        expect(calls).toHaveLength(2);
        await act(async () => pending[0]!(reply(200, roster())));
        await settle();
        expect(calls).toHaveLength(3);
        expect(states(host)).toEqual(["working", "ended", "ended"]);
        await act(async () => pending[1]!(reply(200, roster(b))));
        await settle();
        expect(states(host)).toEqual(["ended", "working", "ended"]);
      } finally {
        await unmount();
      }
    });

    it("ends every run and drops the strip on 404 Unknown terminal", async () => {
      const calls = stubTerminal(async () => reply(404, { error: "Unknown terminal" }));
      const { host, unmount } = await mountFed(threeRuns());
      try {
        await settle();
        expect(states(host)).toEqual(["ended", "ended", "ended"]);
        expect(host.querySelector("[data-worker-status]")).toBeNull();
        expect(calls).toHaveLength(1);
      } finally {
        await unmount();
      }
    });

    it.each([
      ["a 500", async () => reply(500, { error: "boom" })],
      ["a 502 bridge error", async () => reply(502, { error: "terminal bridge unreachable" })],
      ["a 200 with no pane list", async () => reply(200, {})],
      ["a network error", async () => { throw new TypeError("Failed to fetch"); }],
    ])("leaves states unchanged on %s", async (_name, answer) => {
      const calls = stubTerminal(answer);
      const { host, unmount } = await mountFed(threeRuns());
      try {
        await settle();
        expect(calls).toEqual([`GET ${terminalPath}`]);
        expect(states(host)).toEqual(["working", "working", "working"]);
        expect(host.querySelector("[data-worker-status]")).not.toBeNull();
      } finally {
        await unmount();
      }
    });

    it("keeps a final report over a gone pane", async () => {
      stubTerminal(async () => reply(200, roster()));
      // SAFETY: botA is a full Bot fixture; only messages is replaced, with valid Messages.
      const current = { ...botA, messages: [userMsg("ua", "go"), launch(a, "A"), launch(b, "B"), note("n1", a, "DONE A branch=x sha=y dirty=no\nGreen.", 3)] } as Bot;
      const { host, unmount } = await mountFed(current);
      try {
        await settle();
        expect(states(host)).toEqual(["ended", "done"]);
      } finally {
        await unmount();
      }
    });

    it("refetches when this bot's labels change and not on an identical poll", async () => {
      const calls = stubTerminal(async () => reply(200, roster(a)));
      const { host, unmount } = await mountFed(threeRuns());
      try {
        await settle();
        expect(calls).toHaveLength(1);
        await act(async () => feed({ [botA.id]: ["x"] }));
        await settle();
        expect(calls).toHaveLength(2);
        await act(async () => feed({ [botA.id]: ["x"], other: ["y"] }));
        await act(async () => feed({ [botA.id]: ["x"] }));
        await settle();
        expect(calls).toHaveLength(2);
        await act(async () => feed({ [botA.id]: ["x", "y"] }));
        await settle();
        expect(calls).toHaveLength(3);
        await act(async () => feed({}));
        await settle();
        expect(calls).toHaveLength(4);
        expect(calls.every((call) => call === `GET ${terminalPath}`)).toBe(true);
        expect(states(host)).toEqual(["working", "ended", "ended"]);
      } finally {
        await unmount();
      }
    });

    it("drops a late response and keeps the last known set when a refetch fails", async () => {
      const late: Array<(response: Response) => void> = [];
      stubTerminal((call) => (call === 3 ? Promise.resolve(reply(500, {})) : new Promise<Response>((resolve) => { late[call] = resolve; })));
      const { host, unmount } = await mountFed(threeRuns());
      try {
        await act(async () => feed({ [botA.id]: ["x"] }));
        expect(late[2]).toBeUndefined();
        await act(async () => { late[1]!(reply(200, roster(a, b, c))); });
        await settle();
        await act(async () => { late[2]!(reply(200, roster(b))); });
        await settle();
        expect(states(host)).toEqual(["ended", "working", "ended"]);
        await act(async () => feed({ [botA.id]: ["x", "y"] }));
        await settle();
        expect(states(host)).toEqual(["ended", "working", "ended"]);
      } finally {
        await unmount();
      }
    });

    it("rereads when the page becomes visible again, not while hidden", async () => {
      const calls = stubTerminal(async () => reply(200, roster(a)));
      const { unmount } = await mountFed(threeRuns());
      const visibility = vi.spyOn(document, "visibilityState", "get");
      try {
        await settle();
        visibility.mockReturnValue("hidden");
        await act(async () => { document.dispatchEvent(new Event("visibilitychange")); });
        expect(calls).toHaveLength(1);
        visibility.mockReturnValue("visible");
        await act(async () => { document.dispatchEvent(new Event("visibilitychange")); });
        await settle();
        expect(calls).toHaveLength(2);
      } finally {
        await unmount();
      }
    });

    it("never starts or types into a terminal", async () => {
      const calls = stubTerminal(async () => reply(200, roster(a)));
      const { host, unmount } = await mountFed(threeRuns());
      try {
        await settle();
        await act(async () => feed({ [botA.id]: ["x"] }));
        await act(async () => { rows(host)[0]!.click(); });
        expect(calls.length).toBeGreaterThan(1);
        expect(calls.every((call) => /^GET \/api\/bots\/[^/]+\/terminal\?panes=1$/.test(call))).toBe(true);
      } finally {
        await unmount();
      }
    });
  });

  it("renders runs from two room members and folds their notes", async () => {
    stubDom();
    const fromA: Message["from"] = { botId: "a", name: "A", color: "blue" };
    const fromB: Message["from"] = { botId: "b", name: "B", color: "green" };
    const group: Group = {
      id: "g",
      threadId: "thread-g",
      name: "Room",
      memberIds: ["a", "b"],
      defaultResponder: { kind: "everyone" },
      bulletin: "",
      unread: false,
      createdAt: 1,
      setupCompletedAt: 1,
      hasMore: false,
      messages: [
        userMsg("ua", "split it"),
        { ...launch("aaaaaaaa-1", "CHECK | Opus 5.5 | high", 2), from: fromA },
        { ...launch("bbbbbbbb-1", "REVIEW | GPT-6.1 Sol | high", 3), from: fromB },
        { ...note("n1", "aaaaaaaa-1", "DONE CHECK branch=x sha=y dirty=no\nGreen.", 4), from: fromA },
      ],
    };
    const host = document.createElement("div");
    document.body.append(host);
    const root = createRoot(host);
    try {
      await act(async () => root.render(createElement(StoreProvider, null, createElement(GroupView, { group }))));
      expect(rows(host).map((b) => b.textContent)).toEqual(["REVIEWGPT-6.1 Sol · High●Working", "CHECKOpus 5.5 · High✓Done"]);
      expect(host.textContent).not.toContain("Green.");
      const chip = host.querySelector("[data-worker-status]");
      const find = host.querySelector('button[aria-label="Find in conversation"]')!;
      if (!chip) throw new Error("chip missing");
      expect(chip.closest("[class*='@container/chathead']")).not.toBeNull();
      expect(chip.compareDocumentPosition(find) & Node.DOCUMENT_POSITION_FOLLOWING).not.toBe(0);
      expect(chip?.getAttribute("aria-label")).toBe("1 worker");
      await act(async () => chip?.dispatchEvent(new MouseEvent("click", { bubbles: true })));
      const list = document.querySelector("[data-worker-list]");
      expect(list).not.toBeNull();
      expect(list?.querySelectorAll("li")).toHaveLength(1);
      expect(list?.querySelector("button")).toBeNull();
    } finally {
      await act(async () => root.unmount());
      host.remove();
    }
  });
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

describe("ChatView transcript window", () => {
  const mount = async () => {
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
    const render = async (bot: Bot) => {
      await act(async () => root.render(createElement(StoreProvider, null, createElement(ChatView, { bot }))));
    };
    const unmount = async () => {
      await act(async () => root.unmount());
      host.remove();
    };
    return { host, render, unmount };
  };
  const tool = (i: number): Message => ({ id: `tool-${i}`, at: 1, role: "bot", kind: "activity", tool: { name: "Read", ok: true } });
  const button = (host: HTMLElement, label: string) =>
    Array.from(host.querySelectorAll("button")).find((b) => b.textContent?.includes(label));

  it("reaches past a tail of hidden tool rows to the last text", async () => {
    const { host, render, unmount } = await mount();
    const messages = [
      userMsg("ask", "research this"),
      { id: "early", at: 1, role: "bot", kind: "text", text: "early finding" } as Message,
      ...Array.from({ length: 250 }, (_, i) => tool(i)),
    ];
    try {
      await render({ ...botA, messages });
      expect(host.textContent).toContain("early finding");
    } finally {
      await unmount();
    }
  });

  it("lets go of an expanded window after scrolling back to the bottom during a live turn", async () => {
    const { host, render, unmount } = await mount();
    const messages = Array.from({ length: 370 }, (_, i) => userMsg(`m${i}`, `row ${i};`));
    try {
      await render({ ...botA, messages });
      expect(host.textContent).not.toContain("row 249;");
      await act(async () => button(host, "Show earlier messages")!.click());
      expect(host.textContent).toContain("row 130;");

      const scroller = host.querySelector("[data-orbit-transcript]") as HTMLElement;
      Object.defineProperty(scroller, "clientHeight", { configurable: true, get: () => VIEWPORT_PX });
      Object.defineProperty(scroller, "scrollHeight", { configurable: true, get: () => TRANSCRIPT_PX });
      scroller.scrollTop = TRANSCRIPT_PX - VIEWPORT_PX;
      await act(async () => scroller.dispatchEvent(new Event("scroll")));
      expect(button(host, "Jump to latest")).toBeUndefined();
      expect(host.textContent).toContain("row 130;");

      await render({ ...botA, messages: [...messages, tool(0)] });
      expect(host.textContent).not.toContain("row 249;");
      expect(host.textContent).toContain("row 250;");
      expect(button(host, "Show earlier messages")).toBeDefined();
    } finally {
      await unmount();
    }
  });

  it("re-tails an expanded window on Jump to latest", async () => {
    const { host, render, unmount } = await mount();
    const messages = Array.from({ length: 370 }, (_, i) => userMsg(`m${i}`, `row ${i};`));
    try {
      await render({ ...botA, messages });
      await act(async () => button(host, "Show earlier messages")!.click());
      expect(host.textContent).toContain("row 130;");
      const scroller = host.querySelector<HTMLElement>("[data-orbit-transcript]")!;
      Object.defineProperty(scroller, "clientHeight", { configurable: true, get: () => VIEWPORT_PX });
      Object.defineProperty(scroller, "scrollHeight", { configurable: true, get: () => TRANSCRIPT_PX });
      scroller.scrollTop = 0;
      await act(async () => scroller.dispatchEvent(new Event("scroll")));
      await act(async () => button(host, "Jump to latest")!.click());
      expect(host.textContent).not.toContain("row 130;");
      expect(host.textContent).toContain("row 250;");
    } finally {
      await unmount();
    }
  });
});

describe("ChatView transcript click focus", () => {
  const mount = async () => {
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
    const reply: Message = { id: "reply-b", at: 2, role: "bot", kind: "text", text: "answer from B" };
    await act(async () => root.render(createElement(StoreProvider, null, createElement(ChatView, { bot: { ...botB, messages: [...botB.messages, reply] } }))));
    const composer = host.querySelector("[data-orbit-composer]") as HTMLTextAreaElement;
    const scroller = host.querySelector("[data-orbit-transcript]") as HTMLElement;
    const click = (el: Element) => act(async () => void el.dispatchEvent(new MouseEvent("click", { bubbles: true, button: 0 })));
    const unmount = async () => {
      await act(async () => root.unmount());
      host.remove();
    };
    return { host, composer, scroller, click, unmount };
  };

  it("leaves focus in Find while it is open", async () => {
    const { host, composer, scroller, click, unmount } = await mount();
    try {
      await click(host.querySelector('button[aria-label="Find in conversation"]')!);
      const find = host.querySelector('input[aria-label="Find in this conversation"]') as HTMLInputElement;
      find.focus();
      await click(scroller);
      expect(document.activeElement).not.toBe(composer);
      expect(document.activeElement).toBe(find);
      expect(host.querySelector("[data-chat-find]")?.contains(find)).toBe(true);
    } finally {
      await unmount();
    }
  });

  it("ignores clicks inside the portalled reaction picker", async () => {
    const { host, composer, scroller, click, unmount } = await mount();
    try {
      await click(scroller);
      expect(document.activeElement).toBe(composer);
      composer.blur();
      await click(host.querySelector("[data-reaction-bar] button[aria-expanded]")!);
      const picker = document.querySelector("[data-reaction-picker]")!;
      expect(host.contains(picker)).toBe(false);
      await click(picker);
      expect(document.activeElement).not.toBe(composer);
      expect(document.querySelector("[data-reaction-picker]")).not.toBeNull();
    } finally {
      await unmount();
    }
  });
});

describe("ChatView header avatar tap", () => {
  const tap = async (phone: boolean) => {
    vi.stubGlobal("EventSource", FakeEventSource);
    vi.stubGlobal("fetch", vi.fn(async () => new Response("{}", { status: 404 })));
    vi.stubGlobal("ResizeObserver", class {
      observe() {}
      unobserve() {}
      disconnect() {}
    });
    vi.stubGlobal("matchMedia", () => ({ matches: phone }));
    vi.spyOn(console, "warn").mockImplementation(() => {});
    let settings = { open: false, avatar: 0 };
    function Probe() {
      const { state } = useStore();
      settings = { open: state.settingsOpen, avatar: state.settingsAvatarRequest };
      return null;
    }
    const host = document.createElement("div");
    document.body.append(host);
    const root = createRoot(host);
    await act(async () => root.render(createElement(StoreProvider, null, createElement(ChatView, { bot: botB }), createElement(Probe))));
    await act(async () => void host.querySelector(`button[aria-label="Open B's profile"]`)!.dispatchEvent(new MouseEvent("click", { bubbles: true, button: 0 })));
    await act(async () => root.unmount());
    host.remove();
    return settings;
  };

  it("opens bot details without an avatar request on a phone", async () => {
    expect(await tap(true)).toEqual({ open: true, avatar: 0 });
  });

  it("opens bot details collapsed from the header icon on desktop", async () => {
    expect(await tap(false)).toEqual({ open: true, avatar: 0 });
  });
});

describe("ChatView summarized notes", () => {
  const mount = async (width: number) => {
    vi.stubGlobal("EventSource", FakeEventSource);
    vi.stubGlobal("fetch", vi.fn(async () => new Response("{}", { status: 404 })));
    vi.stubGlobal("ResizeObserver", class {
      observe() {}
      unobserve() {}
      disconnect() {}
    });
    Object.defineProperty(window, "innerWidth", { configurable: true, value: width });
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const host = document.createElement("div");
    document.body.append(host);
    const root = createRoot(host);
    const bot: Bot = {
      ...botA,
      busy: false,
      messages: [
        userMsg("ua", "check the logs"),
        { id: "sum", parentId: "ua", at: 2, role: "bot", kind: "text", text: "Checking the logs.", summarized: true },
        { id: "plain", parentId: "sum", at: 3, role: "bot", kind: "text", text: "All clear." },
      ],
    };
    await act(async () => root.render(createElement(StoreProvider, null, createElement(ChatView, { bot }))));
    return {
      host,
      unmount: async () => {
        await act(async () => root.unmount());
        host.remove();
      },
    };
  };

  it.each([390, 1280])("hides a summarized note at %ipx and keeps the plain reply", async (width) => {
    const { host, unmount } = await mount(width);
    try {
      const bubbles = Array.from(host.querySelectorAll('[data-orbit-message="bot"]'));
      expect(bubbles).toHaveLength(1);
      expect(bubbles[0]!.textContent).toContain("All clear.");
      expect(bubbles[0]!.querySelector("[data-orbit-message-content]")?.className).not.toContain("text-ink-secondary");
      expect(host.textContent).not.toContain("Checking the logs.");
      expect(host.textContent).not.toContain("summarized");
    } finally {
      await unmount();
    }
  });

  it("hides a summarized note in a room", async () => {
    vi.stubGlobal("EventSource", FakeEventSource);
    vi.stubGlobal("fetch", vi.fn(async () => new Response("{}", { status: 404 })));
    vi.stubGlobal("ResizeObserver", class {
      observe() {}
      unobserve() {}
      disconnect() {}
    });
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const from: Message["from"] = { botId: "a", name: "A", color: "blue" };
    const group: Group = {
      id: "g",
      threadId: "thread-g",
      name: "Room",
      memberIds: ["a"],
      defaultResponder: { kind: "everyone" },
      bulletin: "",
      unread: false,
      createdAt: 1,
      setupCompletedAt: 1,
      hasMore: false,
      messages: [
        userMsg("ua", "check the logs"),
        { id: "sum", parentId: "ua", at: 2, role: "bot", kind: "text", text: "Checking the logs.", summarized: true, from },
        { id: "plain", parentId: "sum", at: 3, role: "bot", kind: "text", text: "All clear.", from },
      ],
    };
    const host = document.createElement("div");
    document.body.append(host);
    const root = createRoot(host);
    try {
      await act(async () => root.render(createElement(StoreProvider, null, createElement(GroupView, { group }))));
      const bubbles = Array.from(host.querySelectorAll('[data-orbit-message="bot"]'));
      expect(bubbles).toHaveLength(1);
      expect(bubbles[0]!.textContent).toContain("All clear.");
      expect(host.textContent).not.toContain("Checking the logs.");
      expect(host.textContent).not.toContain("summarized");
    } finally {
      await act(async () => root.unmount());
      host.remove();
    }
  });
});

describe("message bubbles", () => {
  it.each(["chat", "room"])("let long words wrap in a %s", async (view) => {
    vi.stubGlobal("EventSource", FakeEventSource);
    vi.stubGlobal("fetch", vi.fn(async () => new Response("{}", { status: 404 })));
    vi.stubGlobal("ResizeObserver", class {
      observe() {}
      unobserve() {}
      disconnect() {}
    });
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const from: Message["from"] = { botId: "a", name: "A", color: "blue" };
    const reply: Message = { id: "b", parentId: "ua", at: 2, role: "bot", kind: "text", text: "Landed as `9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08`." };
    const group: Group = {
      id: "g",
      threadId: "thread-g",
      name: "Room",
      memberIds: ["a"],
      defaultResponder: { kind: "everyone" },
      bulletin: "",
      unread: false,
      createdAt: 1,
      setupCompletedAt: 1,
      hasMore: false,
      messages: [userMsg("ua", "where did it land?"), { ...reply, from }],
    };
    const host = document.createElement("div");
    document.body.append(host);
    const root = createRoot(host);
    try {
      const page = view === "room"
        ? createElement(GroupView, { group })
        : createElement(ChatView, { bot: { ...botA, busy: false, messages: [userMsg("ua", "where did it land?"), reply] } });
      await act(async () => root.render(createElement(StoreProvider, null, page)));
      const boxes = Array.from(host.querySelectorAll("[data-orbit-message-content]"));
      expect(boxes).toHaveLength(2);
      for (const box of boxes) expect(box.className).toContain("break-words");
    } finally {
      await act(async () => root.unmount());
      host.remove();
    }
  });
});

describe("agy sign-in error bubble", () => {
  it("shows the one-click sign-in button", async () => {
    vi.stubGlobal("EventSource", FakeEventSource);
    vi.stubGlobal("fetch", vi.fn(async () => new Response("{}", { status: 404 })));
    vi.stubGlobal("ResizeObserver", class {
      observe() {}
      unobserve() {}
      disconnect() {}
    });
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const previousOgb = window.ogb;
    Object.assign(window, { ogb: { platform: "win32", openInstallTerminal: async () => true, openEngineSignIn: async () => "running" } });
    const agy: InstanceInfo = {
      instanceId: "agy",
      driverKind: "antigravityAgent",
      displayName: "Gemini (Antigravity)",
      models: { default: "gemini-3.1-pro-high", options: [] },
      install: { signInCommand: "agy" },
      snapshot: { state: "available", version: "1.2.4" },
    };
    function Harness() {
      const { dispatch } = useStore();
      useEffect(() => {
        dispatch({ type: "instances", instances: [agy] });
      }, [dispatch]);
      const bot: Bot = {
        ...botA,
        busy: false,
        activity: "idle",
        modelSelection: { instanceId: "agy", model: "gemini-3.1-pro-high" },
        activeLeafId: "err",
        messages: [
          userMsg("ua", "hi"),
          {
            id: "err",
            parentId: "ua",
            at: 2,
            role: "bot",
            kind: "activity",
            tool: { name: "error: authentication failed or timed out", ok: false, signIn: true },
          },
        ],
      };
      return createElement(ChatView, { bot });
    }
    const host = document.createElement("div");
    document.body.append(host);
    const root = createRoot(host);
    try {
      await act(async () => root.render(createElement(StoreProvider, null, createElement(Harness))));
      expect(host.querySelector("code")).toBeNull();
      expect([...host.querySelectorAll("button")].some((b) => b.textContent === "Sign In")).toBe(true);
      expect(host.textContent).toContain("Sign in to Gemini (Antigravity)");
      expect(host.textContent).toContain("Retry");
    } finally {
      window.ogb = previousOgb;
      await act(async () => root.unmount());
      host.remove();
    }
  });
});

describe("error row Retry", () => {
  it.each(["claudeAgent", "codex"])("retains reset and Retry for an untracked %s usage limit", async (driverKind) => {
    vi.stubGlobal("EventSource", FakeEventSource);
    vi.stubGlobal("fetch", vi.fn(async () => new Response("{}", { status: 404 })));
    vi.stubGlobal("ResizeObserver", class { observe() {} unobserve() {} disconnect() {} });
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const resetsAt = Date.now() + 90 * 60_000;
    const bot: Bot = {
      ...botA, busy: false, activity: "idle", activeLeafId: "err",
      modelSelection: { instanceId: driverKind, model: "test" },
      messages: [userMsg("ua", "hi"), { id: "err", parentId: "ua", at: 2, role: "bot", kind: "activity",
        tool: { name: "error: Plan spent", ok: false, usageLimit: { resetsAt } } }],
    };
    function Harness() {
      const { dispatch } = useStore();
      useEffect(() => { dispatch({ type: "instances", instances: [{ instanceId: driverKind, driverKind, displayName: driverKind,
        models: { options: [], default: "test" }, snapshot: { state: "available", billing: "subscription" } }] }); }, [dispatch]);
      return createElement(ChatView, { bot });
    }
    const host = document.createElement("div");
    document.body.append(host);
    const root = createRoot(host);
    try {
      await act(async () => root.render(createElement(StoreProvider, null, createElement(Harness))));
      expect(host.textContent).toContain("Usage limit reached");
      expect(host.textContent).toContain("Plan spent");
      expect(host.textContent).toContain("Try again after it resets.");
      expect(host.textContent).not.toContain("send Continue after it resets");
      expect(host.textContent).not.toContain("Resumes at");
      expect([...host.querySelectorAll("button")].some((button) => button.textContent?.trim() === "Retry")).toBe(true);
    } finally {
      await act(async () => root.unmount());
      host.remove();
    }
  });

  it.each([
    ["a real turn error", "error: the engine stopped", true],
    ["a chat sync notice", "error: This chat also changed on another PC. Both versions were kept.", false],
  ])("offers Retry on %s: %s", async (_label, name, retry) => {
    vi.stubGlobal("EventSource", FakeEventSource);
    vi.stubGlobal("fetch", vi.fn(async () => new Response("{}", { status: 404 })));
    vi.stubGlobal("ResizeObserver", class {
      observe() {}
      unobserve() {}
      disconnect() {}
    });
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const bot: Bot = {
      ...botA,
      busy: false,
      activity: "idle",
      activeLeafId: "err",
      messages: [
        userMsg("ua", "hi"),
        { id: "err", parentId: "ua", at: 2, role: "bot", kind: "activity", tool: { name, ok: false } },
      ],
    };
    const host = document.createElement("div");
    document.body.append(host);
    const root = createRoot(host);
    try {
      await act(async () => root.render(createElement(StoreProvider, null, createElement(ChatView, { bot }))));
      expect(host.textContent).toContain(name.slice(6).trim());
      expect(host.textContent?.includes("Retry")).toBe(retry);
    } finally {
      await act(async () => root.unmount());
      host.remove();
    }
  });
});

describe("ChatView reconnecting cue", () => {
  it("says it is reconnecting once this window has lost its PC for a moment", async () => {
    vi.useFakeTimers();
    const sources: Array<{ onopen: (() => void) | null; onerror: (() => void) | null }> = [];
    vi.stubGlobal("EventSource", class {
      onopen = null;
      onerror = null;
      onmessage = null;
      close = vi.fn();
      constructor() {
        sources.push(this);
      }
    });
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
    const cue = () => host.textContent?.includes("Reconnecting");
    try {
      await act(async () => root.render(createElement(StoreProvider, null, createElement(ChatView, { bot: botB }))));
      await act(async () => sources[0]!.onopen?.());
      await act(() => vi.advanceTimersByTimeAsync(5_000));
      expect(cue()).toBe(false);
      await act(async () => sources[0]!.onerror?.());
      await act(() => vi.advanceTimersByTimeAsync(1_000));
      expect(cue()).toBe(false);
      await act(() => vi.advanceTimersByTimeAsync(1_500));
      expect(cue()).toBe(true);
      await act(async () => sources.at(-1)!.onopen?.());
      expect(cue()).toBe(false);
    } finally {
      await act(async () => root.unmount());
      host.remove();
      vi.useRealTimers();
    }
  });
});

describe("ChatView queued sends", () => {
  const instance = (queueing: boolean): InstanceInfo => ({
    instanceId: "inst",
    driverKind: "antigravityAgent",
    displayName: "Engine",
    models: { default: "m", options: [] },
    snapshot: { state: "available" },
    capabilities: { queueing },
  });
  const replyA: Message = { id: "reply-a", parentId: "ua", at: 2, role: "bot", kind: "text", text: "answer for A" };
  const drained: Message = { id: "ub", parentId: "reply-a", queueId: "q1", at: 3, role: "user", kind: "text", text: "waiting B" };
  let show: (bot: Bot) => void = () => {};
  let send: ReturnType<typeof useStore>["dispatch"] = () => {};

  function Queued({ queueing }: { queueing: boolean }) {
    const { dispatch } = useStore();
    const [bot, setBot] = useState<Bot>(botA);
    show = setBot;
    send = dispatch;
    useEffect(() => {
      dispatch({ type: "instances", instances: [instance(queueing)] });
      dispatch({ type: "pendingQueued", threadId: "thread-a", queueId: "q1", text: "waiting B", at: 2 });
    }, [dispatch, queueing]);
    return createElement(ChatView, { bot });
  }

  const mount = async (queueing: boolean) => {
    vi.stubGlobal("EventSource", FakeEventSource);
    vi.stubGlobal("fetch", vi.fn(async () => new Response("{}", { status: 404 })));
    vi.stubGlobal("ResizeObserver", class {
      observe() {}
      unobserve() {}
      disconnect() {}
    });
    vi.spyOn(console, "warn").mockImplementation(() => {});
    live.current = { streaming: {}, reasoning: {}, signal: { "thread-a": "started" }, turn: {} };
    const host = document.createElement("div");
    document.body.append(host);
    const root = createRoot(host);
    await act(async () => root.render(createElement(StoreProvider, null, createElement(Queued, { queueing }))));
    const order = () =>
      [...host.querySelectorAll("[data-mid], .thinking-shimmer")].map((el) =>
        el.classList.contains("thinking-shimmer") ? "thinking" : el.getAttribute("data-mid"));
    const row = (id: string) => host.querySelector(`[data-mid="${id}"]`);
    return { host, root, order, row };
  };

  it("keeps a waiting send below the thinking row and the reply above it", async () => {
    const { host, root, order, row } = await mount(false);
    try {
      expect(order()).toEqual(["ua", "thinking", "q1"]);
      expect(row("q1")?.textContent).toContain("Sends next");
      const waiting = row("q1");

      live.current = { streaming: { "thread-a": "answer for A" }, reasoning: {}, signal: { "thread-a": "started" }, turn: { "thread-a": "0:ua" } };
      await act(async () => show({ ...botA }));
      expect(order()).toEqual(["ua", "stream:thread-a:ua", "thinking", "q1"]);
      expect(row("q1")).toBe(waiting);

      live.current = { streaming: {}, reasoning: {}, signal: { "thread-a": "started" }, turn: {} };
      await act(async () => show({ ...botA, messages: [...botA.messages, replyA], activeLeafId: "reply-a" }));
      expect(order()).toEqual(["ua", "reply-a", "thinking", "q1"]);
      expect(row("q1")).toBe(waiting);
      expect(row("q1")?.textContent).toContain("Sends next");
    } finally {
      await act(async () => root.unmount());
      host.remove();
    }
  });

  it("puts the next thinking row below the drained send", async () => {
    const { host, root, order, row } = await mount(false);
    try {
      await act(async () => show({ ...botA, messages: [...botA.messages, replyA], activeLeafId: "reply-a" }));
      expect(order()).toEqual(["ua", "reply-a", "thinking", "q1"]);
      await act(async () => {
        send({ type: "consumePendingQueued", threadId: "thread-a", queueId: "q1" });
        show({ ...botA, messages: [...botA.messages, replyA, drained], activeLeafId: "ub" });
      });
      expect(order()).toEqual(["ua", "reply-a", "ub", "thinking"]);
      expect(row("ub")?.textContent).not.toContain("Sends next");
    } finally {
      await act(async () => root.unmount());
      host.remove();
    }
  });

  it("puts a send a steering engine queued below the thinking row", async () => {
    const { host, root, order, row } = await mount(true);
    try {
      expect(order()).toEqual(["ua", "thinking", "q1"]);
      expect(row("q1")?.textContent).toContain("Sends next");
    } finally {
      await act(async () => root.unmount());
      host.remove();
    }
  });

  it("marks only the first waiting send as next", async () => {
    const { host, root, order, row } = await mount(false);
    try {
      await act(async () => send({ type: "pendingQueued", threadId: "thread-a", queueId: "q2", text: "waiting C", at: 3 }));
      expect(order()).toEqual(["ua", "thinking", "q1", "q2"]);
      expect(row("q1")?.textContent).toContain("Sends next");
      expect(row("q2")?.textContent).not.toContain("Sends next");
    } finally {
      await act(async () => root.unmount());
      host.remove();
    }
  });
});

describe("docked reply mascot", () => {
  const mount = async () => {
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
    const render = (bot: Bot) => act(async () => root.render(createElement(StoreProvider, null, createElement(ChatView, { bot }))));
    const mascots = () => host.querySelectorAll("[data-turn-mascot]");
    const unmount = async () => {
      await act(async () => root.unmount());
      host.remove();
    };
    return { host, render, mascots, unmount };
  };
  const working = (thread: string, streaming?: string, tail = "ua"): TurnStreamState => ({
    streaming: streaming ? { [thread]: streaming } : {},
    reasoning: {},
    signal: { [thread]: "started" },
    turn: streaming ? { [thread]: `0:${tail}` } : {},
  });

  it("renders the mascot standalone before any text, then docks it in the live reply's action strip", async () => {
    localStorage.setItem("omb-reply-style", "live");
    const { host, render, mascots, unmount } = await mount();
    try {
      live.current = working("thread-a");
      await render(botA);
      expect(host.querySelector('[data-orbit-message="bot"]')).toBeNull();
      expect(host.querySelector(".turn-presence [data-turn-mascot]")).not.toBeNull();

      live.current = working("thread-a", "Shoelaces were patented in 1790");
      await render({ ...botA });
      const body = host.querySelector('[data-orbit-message="bot"] [data-orbit-message-body]');
      expect(body?.textContent).toContain("Shoelaces were patented in 1790");
      expect(body?.querySelector("[data-turn-mascot]")?.className).toContain("turn-mascot-in");
      expect(host.querySelector(".turn-presence")).toBeNull();
      expect(mascots()).toHaveLength(1);
    } finally {
      await unmount();
    }
  });

  it("leaves the strip in place with the reply actions at turn end", async () => {
    const { host, render, mascots, unmount } = await mount();
    const reply: Message = { id: "reply-a", parentId: "ua", at: 2, role: "bot", kind: "text", text: "Shoelaces were patented in 1790." };
    try {
      live.current = working("thread-a", "Shoelaces were patented in 1790.");
      await render(botA);
      const body = host.querySelector('[data-orbit-message="bot"] [data-orbit-message-body]');
      const strip = body?.className;
      expect(strip).toContain("pb-8");
      expect(body?.querySelector("[data-turn-mascot]")).not.toBeNull();
      expect(body?.querySelector("[data-message-hover-actions]")).toBeNull();

      live.current = { streaming: {}, reasoning: {}, signal: {}, turn: {} };
      await render({ ...botA, busy: false, activity: "idle", messages: [...botA.messages, reply], activeLeafId: "reply-a" });
      const settled = host.querySelector('[data-orbit-message="bot"] [data-orbit-message-body]');
      expect(settled).toBe(body);
      expect(settled?.className).toBe(strip);
      expect(settled?.querySelector("[data-message-hover-actions]")).not.toBeNull();
      expect(settled?.querySelector("[data-turn-mascot]")?.className).toContain("turn-mascot-out");
      expect(host.querySelector(".turn-presence")).toBeNull();
      expect(mascots()).toHaveLength(1);

      await act(async () => { await sleep(320); });
      expect(mascots()).toHaveLength(0);
      expect(host.querySelector('[data-orbit-message="bot"] [data-orbit-message-body]')).toBe(body);
      expect(body?.className).toBe(strip);
    } finally {
      await unmount();
    }
  });

  it("stands alone once reply text settles and docks again when the next reply streams", async () => {
    const { host, render, mascots, unmount } = await mount();
    const first: Message = { id: "reply-1", parentId: "ua", at: 2, role: "bot", kind: "text", text: "Checking the logs." };
    const tool: Message = { id: "tool-1", parentId: "reply-1", at: 3, role: "bot", kind: "activity", tool: { name: "Read" } };
    const dockedIn = () => host.querySelector("[data-turn-mascot]")?.closest("[data-mid]")?.getAttribute("data-mid");
    try {
      live.current = working("thread-a", "Checking the logs.");
      await render(botA);
      expect(dockedIn()).toBe("stream:thread-a:ua");

      live.current = working("thread-a");
      await render({ ...botA, messages: [...botA.messages, first], activeLeafId: "reply-1" });
      expect(host.querySelector(".turn-presence [data-turn-mascot]")).not.toBeNull();
      expect(host.querySelector('[data-mid="reply-1"] [data-message-hover-actions]')).not.toBeNull();
      expect(dockedIn()).toBeUndefined();

      await render({ ...botA, messages: [...botA.messages, first, tool], activeLeafId: "tool-1" });
      expect(host.querySelector(".turn-presence [data-turn-mascot]")).not.toBeNull();
      expect(mascots()).toHaveLength(1);

      live.current = working("thread-a", "All clear.", "tool-1");
      await render({ ...botA, messages: [...botA.messages, first, tool], activeLeafId: "tool-1" });
      expect(dockedIn()).toBe("stream:thread-a:tool-1");
      expect(host.querySelector(".turn-presence")).toBeNull();
      expect(mascots()).toHaveLength(1);
    } finally {
      await unmount();
    }
  });

  it("renders a room's live answer as a transcript row with its name label", async () => {
    localStorage.setItem("omb-reply-style", "live");
    vi.stubGlobal("EventSource", FakeEventSource);
    vi.stubGlobal("fetch", vi.fn(async () => new Response("{}", { status: 404 })));
    vi.stubGlobal("ResizeObserver", class {
      observe() {}
      unobserve() {}
      disconnect() {}
    });
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const from: Message["from"] = { botId: "a", name: "A", color: "blue" };
    const group: Group = {
      id: "g",
      threadId: "thread-g",
      name: "Room",
      memberIds: ["a"],
      defaultResponder: { kind: "everyone" },
      bulletin: "",
      unread: false,
      createdAt: 1,
      setupCompletedAt: 1,
      hasMore: false,
      busyBotId: "a",
      messages: [userMsg("ug", "room question")],
    };
    let show: (group: Group) => void = () => {};
    function Room() {
      const { dispatch } = useStore();
      const [current, setCurrent] = useState(group);
      show = setCurrent;
      useEffect(() => {
        dispatch({ type: "hydrate", bots: [botA], groups: [group], computerControl: {}, sidebarOrder: { sectionOrder: [], itemOrder: {} } });
      }, [dispatch]);
      return createElement(GroupView, { group: current });
    }
    const host = document.createElement("div");
    document.body.append(host);
    const root = createRoot(host);
    try {
      live.current = working("thread-g", "Room answer so far", "ug");
      await act(async () => root.render(createElement(StoreProvider, null, createElement(Room))));
      const slot = host.querySelector('[data-mid="stream:thread-g:ug"]');
      const label = slot?.firstElementChild;
      const row = slot?.querySelector('[data-orbit-message="bot"]');
      expect(row?.textContent).toContain("Room answer so far");
      expect(label).not.toBe(row);
      expect(label?.lastElementChild?.textContent).toBe("A");
      expect(row?.querySelector("[data-turn-mascot]")).not.toBeNull();
      expect(host.querySelector(".turn-presence")).toBeNull();

      const reply: Message = { id: "reply-g", parentId: "ug", at: 2, role: "bot", kind: "text", text: "Room answer so far, done.", from };
      live.current = { streaming: {}, reasoning: {}, signal: {}, turn: {} };
      await act(async () => show({ ...group, busyBotId: undefined, messages: [...group.messages, reply] }));
      const settled = host.querySelector('[data-mid="reply-g"]');
      expect(settled?.querySelector('[data-orbit-message="bot"]')).toBe(row);
      expect(settled?.firstElementChild).toBe(label);
      expect(host.querySelectorAll('[data-orbit-message="bot"]')).toHaveLength(1);
    } finally {
      await act(async () => root.unmount());
      host.remove();
    }
  });
});

describe("phone header name floor", () => {
  const MODEL = "claude-opus-5-5";
  const originals = [Element.prototype, HTMLElement.prototype, SVGElement.prototype].map((proto) => ({
    proto,
    rect: proto.getBoundingClientRect,
  }));

  const box = (left: number, width: number, top = 16, height = 28) => new DOMRect(left, top, width, height);

  const restoreRects = () => {
    for (const item of originals) item.proto.getBoundingClientRect = item.rect;
  };

  const headerOf = (el: Element) => el.closest("[class*='chathead']");

  const modelLabelOf = (root: ParentNode) => {
    const found = [...root.querySelectorAll("span.truncate")].find((el) => el.textContent?.includes(MODEL));
    return found instanceof HTMLElement ? found : null;
  };

  const installRects = (overlap: boolean, menuLeft?: number, slide = 0) => {
    const rect = function (this: Element) {
      if (this instanceof HTMLElement && this.style.left === "-9999px") return box(0, 80, 0, 20);
      if (menuLeft != null && this instanceof HTMLElement && this.hasAttribute("data-test-menu")) return box(menuLeft, 30, 15, 30);
      const header = headerOf(this);
      const label = header ? modelLabelOf(header) : null;
      const hidden = label?.style.display === "none";
      const chip = label?.closest("button");
      const name = header && [...header.querySelectorAll("button")].find((el) => el.textContent === "Bounty-Watch" && el.className.includes("md:hidden"));
      const cluster = name?.closest("[data-chat-name]")?.parentElement ?? null;
      if (header && this === header) return box(0, 360, 0, 60);
      if (cluster && this === cluster) return overlap && !hidden ? box(0, 280, 8, 44) : box(0, 160, 8, 44);
      if (name && this === name) return box(46, 100, 16, 22);
      if (cluster && this === cluster.firstElementChild) return box(6, 40, 10, 40);
      if (chip && this === chip) return overlap && !hidden ? box(40, 200, 14, 30) : box(240, 100, 14, 30);
      if (label && this === label) return box(80, 100, 18, 16);
      if (this instanceof HTMLElement && this.classList.contains("truncate")) return box(80, 100, 18, 16);
      if (this instanceof HTMLElement && this.hasAttribute("data-model-effort")) return box(160, 40, 18, 14);
      if (this instanceof SVGElement && chip?.contains(this)) return box(50, 14, 20, 14);
      return box(0, 0, 0, 0);
    };
    const slid = function (this: Element) {
      const r = rect.call(this);
      return slide && headerOf(this) ? box(r.left + slide, r.width, r.top, r.height) : r;
    };
    for (const item of originals) item.proto.getBoundingClientRect = slid;
  };

  const pinWhole = (el: HTMLElement) => {
    for (const key of ["scrollWidth", "clientWidth"]) {
      Object.defineProperty(el, key, { configurable: true, get: () => 48 });
    }
  };

  const mount = async (overlap: boolean, menu?: { left: number; glow?: boolean; bare?: boolean; slide?: number; rider?: boolean }, workers = false) => {
    vi.stubGlobal("EventSource", FakeEventSource);
    vi.stubGlobal("fetch", vi.fn(async () => new Response("{}", { status: 404 })));
    vi.stubGlobal("ResizeObserver", class {
      observe() {}
      unobserve() {}
      disconnect() {}
    });
    vi.stubGlobal("matchMedia", () => ({ matches: true }));
    vi.spyOn(console, "warn").mockImplementation(() => {});
    installRects(overlap, menu?.left, menu?.slide);
    if (menu) {
      const button = document.createElement("button");
      if (menu.bare) {
        button.className = `md:hidden ${DRAWER_BUTTON_RIGHT}${menu.glow ? " needs-you-glow" : ""}`;
      } else {
        button.className = `phone-menu-test${menu.glow ? " needs-you-glow" : ""}`;
        button.setAttribute("data-phone-menu", "");
      }
      button.setAttribute("data-test-menu", "");
      if (menu.rider) button.style.transform = `matrix(1, 0, 0, 1, ${menu.slide}, 0)`;
      document.body.append(button);
    }
    const bot: Bot = {
      ...botB,
      name: "Bounty-Watch",
      messages: workers ? [{ id: "header-launch", at: 1, role: "bot", kind: "launch", text: "Launched ALPHA\nSession: header00-1" }] : botB.messages,
      modelSelection: { instanceId: "inst", model: MODEL, effort: "max", mode: "pinned" },
    };
    const host = document.createElement("div");
    if (menu?.slide) host.style.transform = `matrix(1, 0, 0, 1, ${menu.slide}, 0)`;
    document.body.append(host);
    const root = createRoot(host);
    await act(async () => root.render(createElement(StoreProvider, null, createElement(ChatView, { bot, onOpenTerminal: () => undefined }))));
    await act(async () => { await Promise.resolve(); });
    const header = host.querySelector("[class*='chathead']");
    const modelLabel = header ? modelLabelOf(header) : null;
    const nameButton = header && [...header.querySelectorAll("button")].find((el) => el.textContent === "Bounty-Watch" && el.className.includes("md:hidden"));
    const cluster = nameButton?.closest("[data-chat-name]")?.parentElement ?? null;
    if (modelLabel) pinWhole(modelLabel);
    const effort = header?.querySelector("[data-model-effort]");
    if (effort instanceof HTMLElement) pinWhole(effort);
    if (nameButton instanceof HTMLElement) pinWhole(nameButton);
    await act(async () => { window.dispatchEvent(new Event("resize")); });
    return {
      host,
      header: header instanceof HTMLElement ? header : null,
      modelLabel,
      nameButton: nameButton instanceof HTMLButtonElement ? nameButton : null,
      cluster: cluster instanceof HTMLElement ? cluster : null,
      unmount: async () => {
        await act(async () => root.unmount());
        host.remove();
        document.querySelector("[data-test-menu]")?.remove();
        restoreRects();
      },
    };
  };

  afterEach(restoreRects);

  it("hides a long model label at 360 when no device tag is rendered", async () => {
    const view = await mount(true);
    try {
      expect(view.header).not.toBeNull();
      expect(view.modelLabel).not.toBeNull();
      expect(view.cluster).not.toBeNull();
      if (!view.header || !view.modelLabel || !view.cluster) return;
      expect(view.header.querySelector("[data-device-tag]")).toBeNull();
      expect(view.modelLabel.style.display).toBe("none");
      const chip = view.modelLabel.closest("button");
      expect(chip).toBeInstanceOf(HTMLElement);
      if (!(chip instanceof HTMLElement)) return;
      expect(chip.getBoundingClientRect().left).toBeGreaterThanOrEqual(view.cluster.getBoundingClientRect().right - 1);
    } finally {
      await view.unmount();
    }
  });

  it("reserves the whole worker status before the model label", async () => {
    const view = await mount(false, undefined, true);
    try {
      const status = view.header?.querySelector<HTMLElement>("[data-worker-status]");
      expect(status).not.toBeNull();
      Object.defineProperty(status!, "scrollWidth", { configurable: true, get: () => 180 });
      await act(async () => { window.dispatchEvent(new Event("resize")); });
      expect(view.nameButton?.style.minWidth).toBe("180px");
      expect(view.modelLabel?.style.display).toBe("none");
    } finally { await view.unmount(); }
  });

  it("includes both cluster paddings in the minimum width", async () => {
    const view = await mount(false);
    try {
      expect(view.cluster).not.toBeNull();
      expect(view.nameButton).not.toBeNull();
      if (!view.cluster || !view.nameButton) return;
      view.cluster.style.paddingLeft = "6px";
      view.cluster.style.paddingRight = "8px";
      await act(async () => { window.dispatchEvent(new Event("resize")); });
      const cs = getComputedStyle(view.cluster);
      const pad = Number.parseFloat(cs.paddingLeft) + Number.parseFloat(cs.paddingRight);
      expect(Number.parseFloat(cs.paddingRight)).toBe(8);
      const gap = Number.parseFloat(cs.columnGap);
      const gapPx = Number.isFinite(gap) ? gap : 0;
      let fixed = 0;
      let others = 0;
      for (const child of view.cluster.children) {
        if (!(child instanceof HTMLElement) || child === view.nameButton.closest("[data-chat-name]") || getComputedStyle(child).display === "none") continue;
        fixed += child.getBoundingClientRect().width;
        others += 1;
      }
      const nameMin = Number.parseFloat(view.nameButton.style.minWidth);
      expect(view.cluster.style.minWidth).toBe(`${Math.ceil(pad + fixed + gapPx * others + nameMin)}px`);
    } finally {
      await view.unmount();
    }
  });

  it("styles the data-model-label chip and ignores an earlier truncate", async () => {
    const view = await mount(false);
    try {
      expect(view.header).not.toBeNull();
      expect(view.modelLabel).not.toBeNull();
      if (!view.header || !view.modelLabel) return;
      const decoy = document.createElement("button");
      const decoyLabel = document.createElement("span");
      decoyLabel.className = "truncate";
      decoyLabel.textContent = "Decoy label";
      decoy.append(decoyLabel);
      await act(async () => { view.header?.prepend(decoy); });
      expect(view.modelLabel.hasAttribute("data-model-label")).toBe(true);
      expect(view.modelLabel.style.minWidth).toBe("max-content");
      expect(decoyLabel.style.minWidth).toBe("");
      expect(decoyLabel.style.display).toBe("");
    } finally {
      await view.unmount();
    }
  });

  it("hides the model label when the chip box reaches the menu button", async () => {
    const view = await mount(false, { left: 300 });
    try {
      expect(view.modelLabel).not.toBeNull();
      expect(view.modelLabel?.style.display).toBe("none");
    } finally {
      await view.unmount();
    }
  });

  it("hides the model label when the chip box reaches the menu glow", async () => {
    const view = await mount(false, { left: 348, glow: true });
    try {
      expect(view.modelLabel?.style.display).toBe("none");
    } finally {
      await view.unmount();
    }
  });

  it("finds the menu button by data attribute without its drawer classes", async () => {
    const view = await mount(false, { left: 300 });
    try {
      const menu = document.querySelector("[data-test-menu]");
      expect(menu?.hasAttribute("data-phone-menu")).toBe(true);
      expect(menu?.className).not.toContain("md:hidden");
      expect(view.modelLabel?.style.display).toBe("none");
    } finally {
      await view.unmount();
    }
  });

  it("ignores drawer classes without the menu data attribute", async () => {
    const view = await mount(false, { left: 300, bare: true });
    try {
      expect(document.querySelector("[data-test-menu]")?.hasAttribute("data-phone-menu")).toBe(false);
      expect(view.modelLabel?.style.display).not.toBe("none");
    } finally {
      await view.unmount();
    }
  });

  it("keeps the model label while the chat stage slides toward the menu", async () => {
    const view = await mount(false, { left: 348, slide: 32 });
    try {
      expect(view.modelLabel).not.toBeNull();
      expect(view.modelLabel?.style.display).not.toBe("none");
    } finally {
      await view.unmount();
    }
  });

  it("hides the model label while the chat stage slides away from the menu it reaches", async () => {
    const view = await mount(false, { left: 330, slide: -32 });
    try {
      expect(view.modelLabel?.style.display).toBe("none");
    } finally {
      await view.unmount();
    }
  });

  it("keeps the model label while the menu rides the chat stage away", async () => {
    const view = await mount(false, { left: 316, slide: -32, rider: true });
    try {
      expect(view.modelLabel).not.toBeNull();
      expect(view.modelLabel?.style.display).not.toBe("none");
    } finally {
      await view.unmount();
    }
  });

  it("hides an overlapping model label while the menu rides the chat stage toward it", async () => {
    const view = await mount(false, { left: 362, slide: 32, rider: true });
    try {
      expect(view.modelLabel?.style.display).toBe("none");
    } finally {
      await view.unmount();
    }
  });

  it("pads the phone header by the menu reserve when the menu is right", async () => {
    localStorage.setItem(SIDEBAR_SIDE_KEY, "right");
    const view = await mount(false);
    try {
      expect(view.header?.style.paddingRight).toBe(`${PHONE_HEADER_MENU_RESERVE_PX}px`);
      expect(view.header?.style.paddingRight).toBe("66px");
    } finally {
      await view.unmount();
    }
  });
});

describe("ChatView find reveal", () => {
  const tool = (id: string, name: string): Message => ({ id, at: 1, role: "bot", kind: "activity", tool: { name, ok: true } });

  it("shows a hidden tool row while it is the current find hit, then hides it again", async () => {
    vi.stubGlobal("EventSource", FakeEventSource);
    vi.stubGlobal("fetch", vi.fn(async () => new Response("{}", { status: 404 })));
    vi.stubGlobal("ResizeObserver", class {
      observe() {}
      unobserve() {}
      disconnect() {}
    });
    vi.spyOn(console, "warn").mockImplementation(() => {});
    // SAFETY: botB is a full Bot fixture; only messages is replaced, with valid Messages.
    const current = { ...botB, messages: [
      userMsg("ub", "go"),
      tool("single", "auto-approved Bash: gh api replies -X POST"),
      userMsg("between", "and"),
      tool("r1", "Read"),
      tool("r2", "auto-approved Bash: curl -X POST /talk"),
      tool("r3", "Edit"),
    ] } as Bot;
    const host = document.createElement("div");
    document.body.append(host);
    const root = createRoot(host);
    await act(async () => root.render(createElement(StoreProvider, null, createElement(ChatView, { bot: current }))));
    try {
      expect(host.querySelector('[data-mid="single"]')).toBeNull();
      await act(async () => setFindCurrent({ messageId: "single", query: "post" }));
      expect(host.querySelector('[data-mid="single"]')?.textContent).toContain("-X POST");
      await act(async () => setFindCurrent({ messageId: "r2", query: "post" }));
      expect(host.querySelector('[data-mid="single"]')).toBeNull();
      expect(host.querySelector('[data-mid="r2"]')?.textContent).toContain("curl -X POST");
      expect(host.querySelector('[data-mid="r1"]')).toBeNull();
      await act(async () => setFindCurrent(null));
      expect(host.querySelector('[data-mid="r2"]')).toBeNull();
    } finally {
      setFindCurrent(null);
      await act(async () => root.unmount());
      host.remove();
    }
  });
});
