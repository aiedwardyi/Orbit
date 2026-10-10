// @vitest-environment happy-dom
import { act, createElement, useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";

import { StoreProvider, useStore, type Bot, type Group, type InstanceInfo, type Message } from "@/state/store";

import { ChatView } from "./ChatView";
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

describe("ChatView note collapse", () => {
  it("collapses a note to its header and expands the status and the worker's words", async () => {
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
    const labeled: Message = { id: "note-1", at: 1, role: "bot", kind: "note", text: "[pane 0f3c9a1e] [OPUS | MED] from Wink (61902933-1c2d-4e5f-8a9b-0c1d2e3f4a5b): DONE OPUS branch=fix/x sha=3623665c dirty=no\ntests pass" };
    const unlabeled: Message = { id: "note-2", at: 2, role: "bot", kind: "note", text: "[pane 0f3c9a1e] from worker (w1): still running" };
    const current = { ...botA, messages: [userMsg("ua", "go"), labeled, unlabeled] } as Bot;
    try {
      await act(async () => root.render(createElement(StoreProvider, null, createElement(ChatView, { bot: current }))));
      const buttons = Array.from(host.querySelectorAll("button")).filter((b) => b.textContent?.startsWith("Note from"));
      expect(buttons.map((b) => b.textContent)).toEqual(["Note from OPUS | MED", "Note from a worker"]);
      expect(host.querySelector("[data-orbit-note]")).toBeNull();
      await act(async () => { buttons[0]!.click(); });
      const shown = host.querySelector("[data-orbit-note]")?.textContent ?? "";
      expect(shown).toBe("Finishedtests pass");
      for (const machine of ["[pane", "61902933", "branch=", "sha=", "dirty="]) expect(shown).not.toContain(machine);
      await act(async () => { buttons[0]!.click(); });
      expect(host.querySelector("[data-orbit-note]")).toBeNull();
    } finally {
      await act(async () => root.unmount());
      host.remove();
    }
  });

  it("collapses a launch row to its header and expands only the folder", async () => {
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
    const launch = (id: string, label: string): Message => ({ id, at: 1, role: "bot", kind: "launch", text: `Launched ${label}\nLabel: ${label}\nWorking folder: C:\\repo\nSession: ${id}` });
    const current = { ...botA, messages: [userMsg("ua", "go"), launch("p1", "THEME-CYCLE | Sonnet 5.5 | medium"), launch("p2", "B"), launch("p3", "C")] } as Bot;
    try {
      await act(async () => root.render(createElement(StoreProvider, null, createElement(ChatView, { bot: current }))));
      const buttons = Array.from(host.querySelectorAll("button")).filter((b) => b.textContent?.startsWith("Launched"));
      expect(buttons.map((b) => b.textContent)).toEqual(["Launched THEME-CYCLE | Sonnet 5.5 | medium", "Launched B", "Launched C"]);
      expect(host.querySelector("[data-orbit-launch]")).toBeNull();
      await act(async () => { buttons[0]!.click(); });
      expect(host.querySelector("[data-orbit-launch]")?.textContent).toBe("Folder: C:\\repo");
      await act(async () => { buttons[0]!.click(); });
      expect(host.querySelector("[data-orbit-launch]")).toBeNull();
    } finally {
      await act(async () => root.unmount());
      host.remove();
    }
  });

  it("jumps to an open launch pane and marks a closed one", async () => {
    vi.stubGlobal("EventSource", FakeEventSource);
    vi.stubGlobal("fetch", vi.fn(async () => new Response("{}", { status: 404 })));
    vi.stubGlobal("ResizeObserver", class {
      observe() {}
      unobserve() {}
      disconnect() {}
    });
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const pane = (sessionId: string) => ({ sessionId, generation: 1, label: null, cwd: "C:\\repo", main: false, exited: false });
    vi.stubGlobal("ogb", { platform: "win32", terminal: { readBot: vi.fn(async () => ({ panes: [pane("p1")] })) } });
    const host = document.createElement("div");
    document.body.append(host);
    const root = createRoot(host);
    const launch = (id: string, label: string): Message => ({ id, at: 1, role: "bot", kind: "launch", text: `Launched ${label}\nLabel: ${label}\nWorking folder: C:\\repo\nSession: ${id}` });
    const current = { ...botA, messages: [userMsg("ua", "go"), launch("p1", "A"), launch("p2", "B"), ...Array.from({ length: 28 }, (_, i) => launch(`x${i}`, `X${i}`))] } as Bot;
    const onOpenTerminalPane = vi.fn();
    const readBot = (window.ogb!.terminal!.readBot as ReturnType<typeof vi.fn>);
    try {
      await act(async () => root.render(createElement(StoreProvider, null, createElement(ChatView, { bot: current, onOpenTerminalPane }))));
      const buttons = Array.from(host.querySelectorAll("button"));
      await act(async () => { buttons.find((b) => b.textContent === "Launched A")!.click(); });
      expect(onOpenTerminalPane).toHaveBeenCalledWith("p1");
      expect(host.querySelector("[data-orbit-launch]")).toBeNull();
      await act(async () => { host.querySelector<HTMLButtonElement>("button[aria-label='Details']")!.click(); });
      expect(host.querySelector("[data-orbit-launch]")?.textContent).toBe("Running in C:\\repo");
      const closed = Array.from(host.querySelectorAll("button")).find((b) => b.textContent === "Launched B · closed")!;
      await act(async () => { closed.click(); });
      expect(onOpenTerminalPane).toHaveBeenCalledTimes(1);
      expect(host.textContent).toContain("Ran in C:\\repo");
      expect(host.textContent).not.toContain("Session:");
      expect(host.textContent).not.toContain("Label:");
      expect(readBot).toHaveBeenCalledTimes(1);
    } finally {
      await act(async () => root.unmount());
      host.remove();
    }
  });

  it("shows a closed launch's newest report as its status and words", async () => {
    vi.stubGlobal("EventSource", FakeEventSource);
    vi.stubGlobal("fetch", vi.fn(async () => new Response("{}", { status: 404 })));
    vi.stubGlobal("ResizeObserver", class {
      observe() {}
      unobserve() {}
      disconnect() {}
    });
    vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.stubGlobal("ogb", { platform: "win32", terminal: { readBot: vi.fn(async () => ({ panes: [] })) } });
    const host = document.createElement("div");
    document.body.append(host);
    const root = createRoot(host);
    const done = "bc9c674b-2844-43b0-982e-88305df70570";
    const failed = "0f3c9a1e-1111-4222-8333-944455556666";
    const launch = (id: string, label: string): Message => ({ id, at: 1, role: "bot", kind: "launch", text: `Launched ${label}\nLabel: ${label}\nWorking folder: C:\\repo\nSession: ${id}` });
    const note = (id: string, pane: string, text: string): Message => ({ id, at: 2, role: "bot", kind: "note", text: `[pane ${pane.slice(0, 8)}] [X] from Wink (61902933-1c2d-4e5f-8a9b-0c1d2e3f4a5b): ${text}` });
    // SAFETY: botA is a full Bot fixture; only messages is replaced, with valid Messages.
    const current = { ...botA, messages: [
      userMsg("ua", "go"), launch(done, "A"), launch(failed, "B"),
      note("n1", done, "FAIL A branch=x sha=y dirty=no\nfirst try broke"),
      note("n2", done, "DONE A branch=fix/a sha=3623665c dirty=no\nAll green."),
      note("n3", failed, "FAIL B branch=x sha=y dirty=yes\nThe build broke."),
    ] } as Bot;
    try {
      await act(async () => root.render(createElement(StoreProvider, null, createElement(ChatView, { bot: current, onOpenTerminalPane: vi.fn() }))));
      const rows = Array.from(host.querySelectorAll("button")).filter((b) => b.textContent?.startsWith("Launched"));
      expect(rows.map((b) => b.textContent)).toEqual(["Launched A · finished", "Launched B · failed"]);
      await act(async () => { rows[0]!.click(); });
      const shown = host.querySelector("[data-orbit-launch]")?.textContent ?? "";
      expect(shown).toBe("FinishedAll green.");
      for (const machine of ["Session", "Label", "branch=", "sha=", "dirty=", done]) expect(shown).not.toContain(machine);
    } finally {
      await act(async () => root.unmount());
      host.remove();
    }
  });

  it("keeps a pane closed when its close lands before the snapshot", async () => {
    vi.stubGlobal("EventSource", FakeEventSource);
    vi.stubGlobal("fetch", vi.fn(async () => new Response("{}", { status: 404 })));
    vi.stubGlobal("ResizeObserver", class {
      observe() {}
      unobserve() {}
      disconnect() {}
    });
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const pane = (sessionId: string) => ({ sessionId, generation: 1, label: null, cwd: "C:\\repo", main: false, exited: false });
    let resolveSnapshot: (value: { panes: ReturnType<typeof pane>[] }) => void = () => {};
    let opened: (event: { botId: string; id: string }) => void = () => {};
    let closed: (event: { botId: string; id: string }) => void = () => {};
    vi.stubGlobal("ogb", { platform: "win32", terminal: {
      readBot: vi.fn(() => new Promise((resolve) => { resolveSnapshot = resolve; })),
      onOpened: vi.fn((cb: typeof opened) => { opened = cb; return () => {}; }),
      onClosed: vi.fn((cb: typeof closed) => { closed = cb; return () => {}; }),
    } });
    const host = document.createElement("div");
    document.body.append(host);
    const root = createRoot(host);
    const launch = (id: string, label: string): Message => ({ id, at: 1, role: "bot", kind: "launch", text: `Launched ${label}\nLabel: ${label}\nWorking folder: C:\\repo\nSession: ${id}` });
    // SAFETY: botA is a full Bot fixture; only messages is replaced, with valid Messages.
    const current = { ...botA, messages: [userMsg("ua", "go"), launch("p1", "A"), launch("p2", "B"), launch("p3", "C")] } as Bot;
    try {
      await act(async () => root.render(createElement(StoreProvider, null, createElement(ChatView, { bot: current, onOpenTerminalPane: vi.fn() }))));
      await act(async () => { closed({ botId: botA.id, id: "p1" }); opened({ botId: botA.id, id: "p2" }); });
      await act(async () => { resolveSnapshot({ panes: [pane("p1"), pane("p3")] }); });
      const labels = Array.from(host.querySelectorAll("button")).map((b) => b.textContent).filter((t) => t?.startsWith("Launched"));
      expect(labels).toEqual(["Launched A · closed", "Launched B", "Launched C"]);
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

  it("keeps an expanded window after scrolling back to the bottom during a live turn", async () => {
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

      await render({ ...botA, messages: [...messages, tool(0)] });
      expect(host.textContent).toContain("row 130;");

      await render({ ...botA, messages: [...messages, tool(0), tool(1)] });
      await act(async () => {
        await sleep(300);
      });
      expect(host.textContent).toContain("row 130;");
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

  it("opens the avatar picker from the header icon on desktop", async () => {
    expect(await tap(false)).toEqual({ open: true, avatar: 1 });
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

describe("agy sign-in error bubble", () => {
  it("shows the sign-in button with command agy", async () => {
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
      expect(host.querySelector("code")?.textContent).toBe("agy");
      expect(host.textContent).toContain("Open sign-in in Terminal");
      expect(host.textContent).toContain("Sign in to Gemini (Antigravity)");
      expect(host.textContent).toContain("Retry");
    } finally {
      window.ogb = previousOgb;
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

  it("keeps one mascot at the bottom of the turn across a tool step", async () => {
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
      expect(dockedIn()).toBe("reply-1");
      expect(host.querySelector(".turn-presence")).toBeNull();

      await render({ ...botA, messages: [...botA.messages, first, tool], activeLeafId: "tool-1" });
      expect(dockedIn()).toBe("reply-1");
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
