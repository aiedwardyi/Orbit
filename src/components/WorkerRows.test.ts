import "@/components/ProfileFields.test-dom.ts";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { Message } from "@/state/store";
import { workerRuns, type WorkerShownState } from "@/lib/worker-runs";
import { ProviderMark } from "./ProviderIcons";
import { applyLocale } from "@/lib/i18n";
import { SWIPE_MOTION_MS } from "@/lib/phone-swipe";
import { WORKER_STATUS, WorkerChip, WorkerRow, useWorkerRows, type ShownRun } from "./WorkerRows";

const run = (label: string) => {
  const launch: Message = { id: "l1", at: 1, role: "bot", kind: "launch", text: `Launched ${label}\nLabel: ${label}\nWorking folder: C:\\repo\nSession: aaaaaaaa-1` };
  return workerRuns([launch])[0]!;
};

describe("useWorkerRows", () => {
  it("moves to a new note and keeps expansion when older messages mount", async () => {
    const launch: Message = { id: "l1", at: 1, role: "bot", kind: "launch", text: "Launched A | script\nSession: aaaaaaaa-1" };
    const note: Message = { id: "n1", at: 2, role: "bot", kind: "note", text: "[pane aaaaaaaa] [A | script] from Wink (a): BLOCKED A\nWaiting" };
    let current: ReturnType<typeof useWorkerRows>;
    function Rows({ messages, mounted = messages }: { messages: Message[]; mounted?: Message[] }) {
      current = useWorkerRows(workerRuns(messages).map((run) => ({ run, state: run.state })), mounted);
      return null;
    }
    const host = document.createElement("div");
    const root = createRoot(host);
    try {
      await act(async () => root.render(createElement(Rows, { messages: [launch] })));
      const id = current!.workerAt.get("l1")!.run.id;
      await act(async () => current!.toggle(id));
      await act(async () => root.render(createElement(Rows, { messages: [launch, note] })));
      expect(current!.workerAt.get("l1")).toBeNull();
      expect(current!.workerAt.get("n1")?.run.id).toBe(id);
      expect(current!.open.has(id)).toBe(true);
      await act(async () => root.render(createElement(Rows, { messages: [launch, note], mounted: [note] })));
      await act(async () => root.render(createElement(Rows, { messages: [launch, note] })));
      expect(current!.workerAt.get("n1")?.run.id).toBe(id);
      expect(current!.open.has(id)).toBe(true);
    } finally {
      await act(async () => root.unmount());
    }
  });
});

describe("WorkerRow", () => {
  it.each([
    ["working", "●", "Working", "text-accent"],
    ["waiting", "‖", "Waiting", "text-warning"],
    ["failed", "!", "Failed", "text-danger"],
    ["done", "✓", "Done", "text-success"],
    ["ended", "○", "Ended", "text-ink-secondary"],
  ] as const)("shows %s as a glyph and a word in its theme color", (state: WorkerShownState, glyph, word, tone) => {
    const markup = renderToStaticMarkup(createElement(WorkerRow, { run: run("A | Opus 5.5 | high"), state, live: null }));
    expect(markup).toContain(`data-worker-state="${state}"`);
    expect(markup).toContain(tone);
    expect(markup).toContain(`<span aria-hidden="true">${glyph}</span>${word}`);
    expect(WORKER_STATUS[state].text).toBe(tone);
  });

  it.each([
    ["Opus 5.5", "claudeAgent"], ["GPT-6 Astra", "codex"], ["Gemini 3.8", "geminiAgent"], ["Grok 4.7", "grokAgent"], ["Muse 1.3", "museAgent"],
  ])("draws the %s mark exactly as the model picker does", (model, driverKind) => {
    // gradient ids carry the useId of each tree position
    const plain = (markup: string) => markup.replace(/(mark)R\w+/g, "$1");
    const markup = renderToStaticMarkup(createElement(WorkerRow, { run: run(`A | ${model} | high`), state: "waiting", live: null }));
    expect(plain(markup)).toContain(plain(renderToStaticMarkup(createElement(ProviderMark, { driverKind, size: 14 }))));
  });

  it("spans the whole transcript column like a message", () => {
    const markup = renderToStaticMarkup(createElement(WorkerRow, { run: run("A | Opus 5.5 | high"), state: "working", live: null }));
    expect(markup).toMatch(/^<div data-worker-run="[^"]*" class="flex w-full flex-col">/);
  });

  it("gives a script a quiet scroll glyph, not a brand or terminal glyph", () => {
    const markup = renderToStaticMarkup(createElement(WorkerRow, { run: run("POST-166 | script"), state: "working", live: null }));
    expect(markup).toContain("lucide-scroll-text");
    expect(markup).not.toContain("lucide-square-terminal");
    expect(markup).not.toContain("#D97757");
  });

  it.each(["NOVA | Nova 2 | high", "DEV"])("gives an unknown model '%s' a neutral bot glyph, not the script scroll", (label) => {
    const markup = renderToStaticMarkup(createElement(WorkerRow, { run: run(label), state: "working", live: null }));
    expect(markup).toContain("lucide-bot");
    expect(markup).not.toContain("lucide-scroll-text");
  });

  it("shows the effort next to the model", async () => {
    applyLocale("en");
    const host = document.createElement("div");
    document.body.append(host);
    const root = createRoot(host);
    await act(async () => root.render(createElement(WorkerRow, { run: run("SETTINGS-LIST | Muse 1.3 | max"), state: "working", live: null })));
    expect(host.textContent).toContain("Muse 1.3 · Max");
    await act(async () => root.unmount());
    host.remove();
  });

  it("shows no effort for a script run", async () => {
    applyLocale("en");
    const host = document.createElement("div");
    document.body.append(host);
    const root = createRoot(host);
    await act(async () => root.render(createElement(WorkerRow, { run: run("LANE-189A | script | -"), state: "working", live: null })));
    expect(host.textContent).toContain("LANE-189A");
    expect(host.textContent).not.toContain("·");
    await act(async () => root.unmount());
    host.remove();
  });

  it("shows the effort in Korean", async () => {
    applyLocale("ko");
    const host = document.createElement("div");
    document.body.append(host);
    const root = createRoot(host);
    try {
      await act(async () => root.render(createElement(WorkerRow, { run: run("SETTINGS-LIST | Muse 1.3 | max"), state: "working", live: null })));
      expect(host.textContent).toContain("Muse 1.3 · 최대");
    } finally {
      await act(async () => root.unmount());
      host.remove();
      applyLocale("en");
    }
  });

  it.each([
    ["done", true, "Ran in C:\\repo"],
    ["failed", true, "Ran in C:\\repo"],
    ["ended", false, "Ran in C:\\repo"],
    ["working", true, "Running in C:\\repo"],
    ["waiting", false, "Folder: C:\\repo"],
    ["working", null, "Folder: C:\\repo"],
  ] as const)("opens a %s run with live=%s on '%s'", async (state: WorkerShownState, live, line) => {
    applyLocale("en");
    const host = document.createElement("div");
    document.body.append(host);
    const root = createRoot(host);
    await act(async () => root.render(createElement(WorkerRow, { run: run("A | Opus 5.5 | high"), state, live })));
    await act(async () => host.querySelector("button")!.click());
    expect(host.querySelector("[data-orbit-worker]")!.textContent).toContain(line);
    await act(async () => root.unmount());
    host.remove();
  });
});

describe("WorkerChip", () => {
  const realMatchMedia = window.matchMedia.bind(window);
  afterEach(() => {
    window.matchMedia = realMatchMedia;
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  const stubMedia = (media: { matches: boolean; addEventListener?: (type: string, listener: () => void) => void }) => {
    Object.defineProperty(window, "matchMedia", { value: () => media, configurable: true, writable: true });
  };

  const shown = (nick: string, state: ShownRun["state"], sessionId: string, at: number): ShownRun => {
    const base = run(`${nick} | Opus 5.5 | high`);
    return { run: { ...base, id: sessionId, nick, sessionId, at }, state };
  };
  const mount = async (runs: ShownRun[], opts?: { onOpenTerminalPane?: (sessionId: string) => void; livePanes?: Set<string> | null; waitForLive?: boolean }) => {
    applyLocale("en");
    const host = document.createElement("div");
    document.body.append(host);
    const root = createRoot(host);
    await act(async () => root.render(createElement(WorkerChip, { name: "Ada", runs, livePanes: opts?.livePanes, waitForLive: opts?.waitForLive, onOpenTerminalPane: opts?.onOpenTerminalPane })));
    return {
      host,
      root,
      chip: () => host.querySelector<HTMLButtonElement>("[data-worker-status]"),
      unmount: async () => { await act(async () => root.unmount()); host.remove(); },
    };
  };

  it.each([false, true])("toggles on the app event and keeps dismissal with phone=%s", async (phone) => {
    stubMedia({ matches: phone });
    const { chip, unmount } = await mount([shown("WORK", "working", "work-1", 1)]);
    const toggle = async () => { await act(async () => { window.dispatchEvent(new Event("orbit:toggle-worker-menu")); }); };
    try {
      await toggle();
      expect(chip()!.getAttribute("aria-expanded")).toBe("true");
      expect(document.body.querySelector("[data-worker-list]")).not.toBeNull();
      await toggle();
      expect(document.body.querySelector("[data-worker-list]")).toBeNull();
      await toggle();
      await act(async () => { window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })); });
      expect(document.body.querySelector("[data-worker-list]")).toBeNull();
      await toggle();
      const outside = phone ? document.body.querySelector("[data-worker-list]")!.parentElement! : document.body;
      await act(async () => { outside.dispatchEvent(new MouseEvent("mousedown", { bubbles: true })); });
      expect(document.body.querySelector("[data-worker-list]")).toBeNull();
    } finally {
      await unmount();
    }
    await toggle();
    expect(document.body.querySelector("[data-worker-list]")).toBeNull();
  });

  it("keeps Tab inside the phone worker list", async () => {
    applyLocale("en");
    // SAFETY: isPhone() only reads matches. The stub answers max-width queries.
    window.matchMedia = ((query: string) => ({ matches: query.includes("max-width"), media: query })) as typeof window.matchMedia;
    const host = document.createElement("div");
    document.body.append(host);
    const behind = document.createElement("button");
    document.body.append(behind);
    const root = createRoot(host);
    await act(async () => root.render(createElement(WorkerChip, {
      name: "Ada",
      runs: [{ run: run("A | Opus 5.5 | high"), state: "working" }],
    })));
    await act(async () => host.querySelector("button")!.click());
    const panel = document.body.querySelector("[data-worker-list]")!;
    expect(panel.getAttribute("role")).toBe("dialog");
    const close = panel.querySelector("button")!;
    // happy-dom does not move focus on Tab, so a second control makes the wrap observable.
    const later = document.createElement("button");
    panel.append(later);
    const tab = (target: HTMLElement, shiftKey = false) =>
      target.dispatchEvent(new KeyboardEvent("keydown", { key: "Tab", bubbles: true, cancelable: true, shiftKey }));
    try {
      close.focus();
      await act(async () => tab(close, true));
      expect(document.activeElement).toBe(later);
      await act(async () => tab(later));
      expect(document.activeElement).toBe(close);
      behind.focus();
      await act(async () => tab(behind));
      expect(document.activeElement).toBe(close);
      behind.focus();
      await act(async () => tab(behind, true));
      expect(document.activeElement).toBe(later);
    } finally {
      await act(async () => root.unmount());
      host.remove();
      behind.remove();
    }
  });

  it("shows words without header icons", async () => {
    const { host, chip, unmount } = await mount([1, 2, 3, 4].map((at) => shown(`W${at}`, "working", `session-${at}`, at)));
    try {
      expect(chip()!.textContent).toBe("4 workers");
      expect(host.querySelector("svg")).toBeNull();
      expect(host.querySelector("[data-worker-strip]")).toBeNull();
    } finally { await unmount(); }
  });

  it("lists only live panes, urgent first, and opens that pane", async () => {
    vi.stubGlobal("matchMedia", () => ({ matches: false }));
    const waiting = shown("WAIT", "waiting", "wait-1", 2);
    const failed = shown("SHIP", "failed", "fail-1", 3);
    const working = shown("WORK", "working", "work-1", 1);
    const done = shown("COPY", "done", "done-1", 4);
    const onOpen = vi.fn();
    const { host, chip, unmount } = await mount([working, done, failed, waiting], {
      onOpenTerminalPane: onOpen,
      livePanes: new Set(["wait-1", "fail-1", "done-1"]),
    });
    try {
      expect(host.querySelector("[data-worker-status]")).not.toBeNull();
      expect(host.querySelector("[data-worker-status]")!.textContent).toBe("3 workers");
      const opener = chip()!;
      opener.focus();
      await act(async () => opener.click());
      const list = host.querySelector("[data-worker-list]")!;
      expect(list.getAttribute("role")).toBe("dialog");
      expect(list.getAttribute("aria-modal")).toBeNull();
      expect(opener.getAttribute("aria-haspopup")).toBe("dialog");
      expect(list.getAttribute("aria-labelledby")).toBe(list.querySelector("h2")?.id);
      expect(list.querySelector("h2")?.textContent).toBe("Ada's workers");
      expect([...list.querySelectorAll("li")].map((li) => li.textContent)).toEqual([
        "WAITOpus 5.5 · High‖Waiting", "SHIPOpus 5.5 · High!Failed", "COPYOpus 5.5 · High✓Done",
      ]);
      const entry = [...list.querySelectorAll("button")].find((button) => button.textContent?.includes("COPY"))!;
      await act(async () => entry.click());
      expect(onOpen).toHaveBeenCalledWith("done-1");
      expect(host.querySelector("[data-worker-list]")).toBeNull();
    } finally {
      await unmount();
    }
  });

  it("falls back to working and waiting when pane liveness is unknown", async () => {
    vi.stubGlobal("matchMedia", () => ({ matches: false }));
    const { host, chip, unmount } = await mount([
      shown("WORK", "working", "work-1", 1),
      shown("WAIT", "waiting", "wait-1", 2),
      shown("COPY", "done", "done-1", 3),
      shown("SHIP", "failed", "fail-1", 4),
    ], { livePanes: null });
    try {
      expect(host.querySelector("[data-worker-status]")!.textContent).toBe("2 workers");
      await act(async () => chip()!.click());
      expect([...host.querySelectorAll("[data-worker-list] li")].map((li) => li.textContent)).toEqual([
        "WAITOpus 5.5 · High‖Waiting", "WORKOpus 5.5 · High●Working",
      ]);
    } finally {
      await unmount();
    }
  });

  it("shows the effort next to the model in the list", async () => {
    vi.stubGlobal("matchMedia", () => ({ matches: false }));
    const { host, chip, unmount } = await mount([{ run: run("SETTINGS-LIST | Muse 1.3 | max"), state: "working" }], { livePanes: null });
    try {
      await act(async () => chip()!.click());
      expect(host.querySelector("[data-worker-list] li")!.textContent).toContain("Muse 1.3 · Max");
    } finally {
      await unmount();
    }
  });

  it("shortens the effort and the model before cutting the name in the desktop menu", async () => {
    vi.stubGlobal("matchMedia", () => ({ matches: false }));
    const { host, chip, unmount } = await mount([{ run: run("ARGON-TEST-LANE1 | Gemini 4 Argon | medium"), state: "working" }], { livePanes: null });
    try {
      await act(async () => chip()!.click());
      const item = host.querySelector("[data-worker-list] li")!;
      expect(item.textContent).toContain("ARGON-TEST-LANE1");
      expect(item.textContent).toContain("Med");
      expect(item.textContent).not.toContain("Medium");
      expect(item.querySelector("span.min-w-0 > span:nth-child(2)")!.className).toMatch(/(^|\s)flex-1(\s|$)/);
      expect(item.querySelector("span.min-w-0 > span:nth-child(2)")!.className).toMatch(/(^|\s)truncate(\s|$)/);
      expect(item.querySelector("span.min-w-0 > span:nth-child(3)")!.className).toMatch(/(^|\s)shrink-0(\s|$)/);
      expect(item.querySelector("span.min-w-0 > span:nth-child(3)")!.className).toMatch(/(^|\s)whitespace-pre(\s|$)/);
    } finally {
      await unmount();
    }
  });

  it("shortens the effort and the model before cutting the name in the phone sheet", async () => {
    stubMedia({ matches: true });
    const { chip, unmount } = await mount([{ run: run("ARGON-TEST-LANE1 | Gemini 4 Argon | medium"), state: "working" }], { livePanes: null });
    try {
      await act(async () => chip()!.click());
      const item = document.body.querySelector("[data-worker-list] li")!;
      expect(item.textContent).toContain("ARGON-TEST-LANE1");
      expect(item.textContent).toContain("Med");
      expect(item.textContent).not.toContain("Medium");
      expect(item.querySelector("span.min-w-0 > span:nth-child(2)")!.className).toMatch(/(^|\s)flex-1(\s|$)/);
      expect(item.querySelector("span.min-w-0 > span:nth-child(3)")!.className).toMatch(/(^|\s)shrink-0(\s|$)/);
    } finally {
      await unmount();
    }
  });

  it.each([false, true])("closes the open list when the app asks for it on a view switch with phone=%s", async (phone) => {
    stubMedia({ matches: phone });
    const { chip, unmount } = await mount([shown("WORK", "working", "work-1", 1)], { livePanes: new Set(["work-1"]) });
    try {
      await act(async () => chip()!.click());
      expect(document.body.querySelector("[data-worker-list]")).not.toBeNull();
      await act(async () => { window.dispatchEvent(new Event("orbit:close-worker-menu")); });
      expect(document.body.querySelector("[data-worker-list]")).toBeNull();
      expect(chip()!.getAttribute("aria-expanded")).toBe("false");
    } finally {
      await unmount();
    }
  });

  it("lists nothing while waiting for the live set, then lists as usual", async () => {
    vi.stubGlobal("matchMedia", () => ({ matches: false }));
    const runs = [shown("WORK", "working", "work-1", 1), shown("WAIT", "waiting", "wait-1", 2)];
    const { host, root, chip, unmount } = await mount(runs, { livePanes: null, waitForLive: true });
    try {
      expect(host.querySelector("[data-worker-status]")).toBeNull();
      await act(async () => root.render(createElement(WorkerChip, { name: "Ada", runs, livePanes: new Set(["work-1"]), waitForLive: true })));
      expect(chip()!.getAttribute("aria-label")).toBe("1 worker");
    } finally {
      await unmount();
    }
  });

  it("lists working runs for a room chip on the desktop with unknown liveness", async () => {
    vi.stubGlobal("matchMedia", () => ({ matches: false }));
    (window as unknown as { ogb?: unknown }).ogb = { terminal: {} };
    try {
      const { host, unmount } = await mount([
        shown("WORK", "working", "work-1", 1),
        shown("WAIT", "waiting", "wait-1", 2),
        shown("COPY", "done", "done-1", 3),
      ], { livePanes: null });
      try {
        expect(host.querySelector("[data-worker-status]")!.textContent).toBe("2 workers");
      } finally {
        await unmount();
      }
    } finally {
      (window as unknown as { ogb?: unknown }).ogb = undefined;
    }
  });

  it("faces a waiting script first with a scroll glyph while AI workers keep brand marks", async () => {
    vi.stubGlobal("matchMedia", () => ({ matches: false }));
    const { host, chip, unmount } = await mount([
      { run: run("A | Grok 4.7 | high"), state: "working" },
      { run: run("REL-CHAIN-166 | script"), state: "waiting" },
    ], { livePanes: null });
    try {
      expect(chip()!.textContent).toBe("2 workers");
      expect(host.querySelector("svg")).toBeNull();
      await act(async () => chip()!.click());
      const list = host.querySelector("[data-worker-list]")!;
      expect([...list.querySelectorAll("li")].map((li) => li.textContent)).toEqual([
        "REL-CHAIN-166script‖Waiting", "AGrok 4.7 · High●Working",
      ]);
      const marks = [...list.querySelectorAll("svg")];
      expect(marks.map((svg) => svg.classList.contains("lucide-scroll-text"))).toEqual([true, false]);
      expect(marks[1]!.getAttribute("class") ?? "").not.toContain("lucide");
    } finally {
      await unmount();
    }
  });

  it.each([false, true])("counts and opens a renamed pane once with phone=%s", async (phone) => {
    stubMedia({ matches: phone });
    const runs = workerRuns([
      { id: "l1", at: 1, role: "bot", kind: "launch", text: "Launched GO-GOOGLE | Opus 5.5 | high\nLabel: GO-GOOGLE | Opus 5.5 | high\nSession: aaaaaaaa-1" },
      { id: "n1", at: 2, role: "bot", kind: "note", text: "[pane aaaaaaaa] [GO-GOOGLE | Opus 5.5 | high] from Wink (61902933-1c2d-4e5f-8a9b-0c1d2e3f4a5b): BLOCKED CHAIN-GP2 branch=x sha=y dirty=no" },
    ]).map((run) => ({ run, state: run.state }));
    const onOpen = vi.fn();
    const { root, chip, unmount } = await mount(runs, { livePanes: new Set(["aaaaaaaa-1"]), onOpenTerminalPane: onOpen });
    try {
      expect(chip()!.getAttribute("aria-label")).toBe("1 worker");
      expect(chip()!.textContent).toBe("1 worker");
      await act(async () => chip()!.click());
      const list = document.body.querySelector("[data-worker-list]")!;
      expect(list.querySelectorAll("li")).toHaveLength(1);
      expect(list.querySelector("li")!.textContent).toBe("CHAIN-GP2Opus 5.5 · High‖Waiting");
      await act(async () => list.querySelector<HTMLButtonElement>("li > button")!.click());
      expect(onOpen).toHaveBeenCalledExactlyOnceWith("aaaaaaaa-1");
      await act(async () => root.render(createElement(WorkerChip, { name: "Ada", runs, livePanes: null })));
      expect(chip()!.getAttribute("aria-label")).toBe("2 workers");
      await act(async () => chip()!.click());
      const roomList = document.body.querySelector("[data-worker-list]")!;
      expect(roomList.querySelectorAll("li")).toHaveLength(2);
      expect(roomList.querySelector("li > button")).toBeNull();
    } finally {
      await unmount();
    }
  });

  it.each([false, true])("keeps an unverified pane visible without a click target with phone=%s", async (phone) => {
    stubMedia({ matches: phone });
    const runs = [shown("WORK", "working", "work-1", 1)];
    const onOpen = vi.fn();
    const { root, chip, unmount } = await mount(runs, { livePanes: null, onOpenTerminalPane: onOpen });
    try {
      await act(async () => chip()!.click());
      const list = document.body.querySelector("[data-worker-list]")!;
      expect(list.querySelectorAll("li")).toHaveLength(1);
      expect(list.querySelector("li > button")).toBeNull();
      await act(async () => list.querySelector<HTMLDivElement>("li > div")!.click());
      expect(onOpen).not.toHaveBeenCalled();
      await act(async () => root.render(createElement(WorkerChip, { name: "Ada", runs, livePanes: new Set(["work-1"]), onOpenTerminalPane: onOpen })));
      const entry = document.body.querySelector<HTMLButtonElement>("[data-worker-list] li > button")!;
      await act(async () => entry.click());
      expect(onOpen).toHaveBeenCalledExactlyOnceWith("work-1");
    } finally {
      await unmount();
    }
  });

  it("hides the chip when no pane is live", async () => {
    vi.stubGlobal("matchMedia", () => ({ matches: false }));
    const { host, unmount } = await mount([
      shown("WORK", "working", "work-1", 1),
    ], { livePanes: new Set() });
    try {
      expect(host.querySelector("[data-worker-status]")).toBeNull();
    } finally {
      await unmount();
    }
  });

  it("closes the desktop menu on escape and outside click, and focus returns to the chip", async () => {
    vi.stubGlobal("matchMedia", () => ({ matches: false }));
    const { host, chip, unmount } = await mount([shown("WORK", "working", "work-1", 1)]);
    const outside = document.createElement("button");
    document.body.append(outside);
    try {
      const opener = chip()!;
      opener.focus();
      await act(async () => opener.click());
      expect(host.querySelector("[data-worker-list]")).not.toBeNull();
      await act(async () => document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true })));
      expect(host.querySelector("[data-worker-list]")).toBeNull();
      expect(document.activeElement).toBe(opener);
      outside.focus();
      await act(async () => opener.click());
      await act(async () => outside.dispatchEvent(new MouseEvent("mousedown", { bubbles: true })));
      expect(host.querySelector("[data-worker-list]")).toBeNull();
      expect(document.activeElement).toBe(outside);
    } finally {
      outside.remove();
      await unmount();
    }
  });

  it("closes the open desktop list when the phone breakpoint flips", async () => {
    let flip: (() => void) | undefined;
    stubMedia({ matches: false, addEventListener: (_type, listener) => { flip = listener; } });
    const { host, chip, unmount } = await mount([shown("WORK", "working", "work-1", 1)]);
    try {
      await act(async () => chip()!.click());
      expect(host.querySelector("[data-worker-list]")).not.toBeNull();
      await act(async () => flip!());
      expect(host.querySelector("[data-worker-list]")).toBeNull();
    } finally {
      await unmount();
    }
  });

  it("mounts when matchMedia has no addEventListener", async () => {
    stubMedia({ matches: false });
    const { host, chip, unmount } = await mount([shown("WORK", "working", "work-1", 1)]);
    try {
      await act(async () => chip()!.click());
      expect(host.querySelector("[data-worker-list]")).not.toBeNull();
    } finally {
      await unmount();
    }
  });

  it("insets entries on the desktop dropdown but not in the phone sheet", async () => {
    const runs = [shown("WORK", "working", "work-1", 1)];
    stubMedia({ matches: false });
    const desktop = await mount(runs, { onOpenTerminalPane: () => {}, livePanes: new Set(["work-1"]) });
    try {
      await act(async () => desktop.chip()!.click());
      expect(desktop.host.querySelector("[data-worker-list] li > button")?.className).toContain("px-3");
    } finally {
      await desktop.unmount();
    }
    stubMedia({ matches: true });
    const phone = await mount(runs, { onOpenTerminalPane: () => {}, livePanes: new Set(["work-1"]) });
    try {
      await act(async () => phone.chip()!.click());
      const entry = document.body.querySelector("[data-worker-list] li > button")!;
      expect(entry.className).not.toMatch(/(^|\s)px-/);
    } finally {
      await phone.unmount();
    }
  });

  it("keeps the phone sheet's scrollbar in its side padding, clear of the status", async () => {
    const runs = [shown("WORK", "working", "work-1", 1)];
    stubMedia({ matches: true });
    const phone = await mount(runs, { onOpenTerminalPane: () => {}, livePanes: new Set(["work-1"]) });
    try {
      await act(async () => phone.chip()!.click());
      const sheet = document.body.querySelector("[data-worker-list]")!;
      expect(sheet.className.split(" ")).toContain("px-5");
      expect(sheet.querySelector("ul")!.className.split(" ")).toEqual(expect.arrayContaining(["overflow-y-auto", "-mx-5", "px-5"]));
    } finally {
      await phone.unmount();
    }
    stubMedia({ matches: false });
    const desktop = await mount(runs, { onOpenTerminalPane: () => {}, livePanes: new Set(["work-1"]) });
    try {
      await act(async () => desktop.chip()!.click());
      expect(desktop.host.querySelector("[data-worker-list] ul")!.className).not.toContain("-mx-5");
    } finally {
      await desktop.unmount();
    }
  });

  it.each([340, 420, 620])("keeps the desktop menu inside a %spx chat column", async (columnWidth) => {
    vi.stubGlobal("matchMedia", () => ({ matches: false }));
    const { host, chip, unmount } = await mount([shown("WORK", "working", "work-1", 1)]);
    const main = document.createElement("main");
    document.body.append(main);
    main.append(host);
    const box = (left: number, right: number) => new window.DOMRect(left, 0, right - left, 40);
    vi.spyOn(main, "getBoundingClientRect").mockReturnValue(box(280, 280 + columnWidth));
    vi.spyOn(chip()!.parentElement!, "getBoundingClientRect").mockReturnValue(box(436, 470));
    try {
      await act(async () => chip()!.click());
      const menu = host.querySelector<HTMLElement>("[data-worker-list]")!;
      const width = parseFloat(menu.style.width || menu.className.match(/\bw-\[(\d+)px\]/)?.[1] || "0");
      const right = 470 - parseFloat(menu.style.right);
      expect(right - width).toBeGreaterThanOrEqual(288);
      expect(right).toBeLessThanOrEqual(280 + columnWidth - 8);
      expect(width).toBe(Math.min(440, columnWidth - 16));
    } finally {
      await unmount();
      main.remove();
    }
  });

  it.each(["window", "column"])("repositions the desktop menu when the %s resizes", async (target) => {
    vi.stubGlobal("matchMedia", () => ({ matches: false }));
    const callbacks: Array<() => void> = [];
    vi.stubGlobal("ResizeObserver", class {
      constructor(callback: () => void) { callbacks.push(callback); }
      observe() {}
      disconnect() {}
    });
    const { host, chip, unmount } = await mount([shown("WORK", "working", "work-1", 1)]);
    const main = document.createElement("main");
    document.body.append(main);
    main.append(host);
    const box = (left: number, right: number) => new window.DOMRect(left, 0, right - left, 40);
    const column = vi.spyOn(main, "getBoundingClientRect").mockReturnValue(box(280, 700));
    const row = vi.spyOn(chip()!.parentElement!, "getBoundingClientRect").mockReturnValue(box(436, 470));
    try {
      await act(async () => chip()!.click());
      expect(host.querySelector<HTMLElement>("[data-worker-list]")!.style.right).toBe("-222px");
      expect(host.querySelector<HTMLElement>("[data-worker-list]")!.style.width).toBe("404px");
      column.mockReturnValue(box(280, 900));
      row.mockReturnValue(box(816, 850));
      await act(async () => {
        if (target === "window") window.dispatchEvent(new Event("resize"));
        else for (const callback of callbacks) callback();
      });
      expect(host.querySelector<HTMLElement>("[data-worker-list]")!.style.right).toBe("0px");
      expect(host.querySelector<HTMLElement>("[data-worker-list]")!.style.width).toBe("440px");
    } finally {
      await unmount();
      main.remove();
    }
  });

  it("scrolls a desktop list of eight entries", async () => {
    vi.stubGlobal("matchMedia", () => ({ matches: false }));
    const runs = Array.from({ length: 8 }, (_, i) => shown(`W${i}`, "working", `s${i}`, i));
    const { host, chip, unmount } = await mount(runs, { onOpenTerminalPane: () => {} });
    try {
      await act(async () => chip()!.click());
      const list = host.querySelector("[data-worker-list]")!;
      const scroller = [...list.querySelectorAll<HTMLElement>("*")].find((el) => el.className.includes("max-h-") && el.className.includes("overflow-y-auto"));
      expect(scroller?.querySelectorAll("li")).toHaveLength(8);
    } finally {
      await unmount();
    }
  });

  it("opens the one live pane that matches a note-only run", async () => {
    vi.stubGlobal("matchMedia", () => ({ matches: false }));
    const base = shown("OLD", "waiting", "ignored", 1);
    const onOpen = vi.fn();
    const { host, chip, unmount } = await mount(
      [{ run: { ...base.run, sessionId: null, pane8: "abcd1234" }, state: "waiting" }],
      { onOpenTerminalPane: onOpen, livePanes: new Set(["abcd1234-full", "zzzzzzzz-other"]) },
    );
    try {
      await act(async () => chip()!.click());
      const entry = [...host.querySelectorAll("button")].find((button) => button.textContent?.includes("OLD"))!;
      await act(async () => entry.click());
      expect(onOpen).toHaveBeenCalledWith("abcd1234-full");
    } finally {
      await unmount();
    }
  });

  describe("phone sheet swipe", () => {
    const openSheet = async (count: number, reduce = false) => {
      Object.defineProperty(window, "matchMedia", { value: (query: string) => ({ matches: query.includes("reduce") ? reduce : true }), configurable: true, writable: true });
      const runs = Array.from({ length: count }, (_, i) => shown(`W${i}`, "working", `s${i}`, i));
      const onOpen = vi.fn();
      const mounted = await mount(runs, { onOpenTerminalPane: onOpen, livePanes: new Set(runs.map((entry) => entry.run.id)) });
      await act(async () => mounted.chip()!.click());
      const sheet = document.body.querySelector<HTMLElement>("[data-worker-list]")!;
      // happy-dom has no layout
      Object.defineProperty(sheet, "offsetHeight", { configurable: true, value: 600 });
      return { ...mounted, sheet, row: sheet.querySelector<HTMLButtonElement>("li > button")!, onOpen };
    };
    const touch = (target: Element, type: string, y: number, timeStamp: number) => {
      const event = new Event(type, { bubbles: true, cancelable: true });
      Object.defineProperty(event, "touches", { value: type === "touchend" ? [] : [{ clientX: 200, clientY: y }] });
      Object.defineProperty(event, "timeStamp", { value: timeStamp });
      target.dispatchEvent(event);
      return event;
    };
    const drag = async (target: Element, ys: number[], ms: number) => {
      const events: Event[] = [];
      await act(async () => {
        ys.forEach((y, i) => events.push(touch(target, i === 0 ? "touchstart" : "touchmove", y, i * ms)));
        events.push(touch(target, "touchend", 0, ys.length * ms));
      });
      return events;
    };

    it("tops the phone sheet with a grabber screen readers skip", async () => {
      const { sheet, unmount } = await openSheet(1);
      try {
        expect(sheet.firstElementChild!.getAttribute("aria-hidden")).toBe("true");
        expect(sheet.firstElementChild!.className).toMatch(/(^|\s)bg-ink-secondary\/40(\s|$)/);
      } finally {
        await unmount();
      }
    });

    it("follows the finger down 1:1, never up, and springs back from a drag under a third of its height", async () => {
      const { sheet, row, chip, unmount } = await openSheet(1);
      try {
        await act(async () => {
          touch(row, "touchstart", 300, 0);
          touch(row, "touchmove", 340, 200);
        });
        expect(sheet.style.translate).toBe("0 40px");
        await act(async () => touch(row, "touchmove", 280, 400));
        expect(sheet.style.translate).toBe("0 0px");
        await act(async () => touch(row, "touchmove", 400, 600));
        await act(async () => touch(row, "touchmove", 470, 800));
        expect(sheet.style.translate).toBe("0 170px");
        let end!: Event;
        await act(async () => { end = touch(row, "touchend", 0, 1000); });
        expect(end.defaultPrevented).toBe(true);
        expect(chip()!.getAttribute("aria-expanded")).toBe("true");
        expect(sheet.style.translate).toBe("0 0");
        await act(() => new Promise<void>((done) => setTimeout(done, SWIPE_MOTION_MS + 40)));
        expect(sheet.style.translate).toBe("");
        await act(async () => sheet.querySelector<HTMLButtonElement>('button[aria-label="Close"]')!.click());
        expect(chip()!.getAttribute("aria-expanded")).toBe("false");
      } finally {
        await unmount();
      }
    });

    it.each([
      ["a slow drag past a third of its height", [300, 360, 420, 490], 200],
      ["a quick short flick", [300, 320, 340], 16],
    ])("closes on %s", async (_name, ys, ms) => {
      const { sheet, row, chip, unmount } = await openSheet(1);
      try {
        const events = await drag(row, ys, ms);
        expect(events.at(-1)!.defaultPrevented).toBe(true);
        expect(chip()!.getAttribute("aria-expanded")).toBe("false");
        expect(sheet.isConnected).toBe(false);
      } finally {
        await unmount();
      }
    });

    it("springs back from a quick short drag that stops before the finger lifts", async () => {
      const { sheet, row, chip, unmount } = await openSheet(1);
      try {
        await act(async () => {
          touch(row, "touchstart", 300, 0);
          touch(row, "touchmove", 320, 16);
          touch(row, "touchmove", 340, 32);
          touch(row, "touchend", 0, 182);
        });
        expect(chip()!.getAttribute("aria-expanded")).toBe("true");
        expect(sheet.style.translate).toBe("0 0");
      } finally {
        await unmount();
      }
    });

    it("lets a scrolled list scroll first and drags the sheet only from the list's top", async () => {
      const { sheet, row, chip, unmount } = await openSheet(13);
      const list = sheet.querySelector("ul")!;
      try {
        list.scrollTop = 40;
        const scroll = await drag(row, [300, 360, 420, 490], 200);
        expect(scroll.some((event) => event.defaultPrevented)).toBe(false);
        expect(sheet.style.translate).toBe("");
        expect(chip()!.getAttribute("aria-expanded")).toBe("true");
        list.scrollTop = 0;
        await drag(row, [300, 360, 420, 490], 200);
        expect(chip()!.getAttribute("aria-expanded")).toBe("false");
      } finally {
        await unmount();
      }
    });

    it.each([0, 4, 8])("leaves every event of a %i px jitter tap uncancelled and claims a pull", async (jitter) => {
      const { sheet, row, onOpen, chip, unmount } = await openSheet(1);
      try {
        await act(async () => {
          touch(row, "touchstart", 300, 0);
          touch(row, "touchmove", 312, 200);
        });
        expect(sheet.style.translate).toBe("0 12px");
        let end!: Event;
        await act(async () => { end = touch(row, "touchend", 0, 400); });
        expect(end.defaultPrevented).toBe(true);
        const tap = await drag(row, [300, 300 + jitter / 2, 300 + jitter], 50);
        expect(tap.some((event) => event.defaultPrevented)).toBe(false);
        expect(sheet.style.translate).toBe("");
        expect(onOpen).not.toHaveBeenCalled();
        expect(chip()!.getAttribute("aria-expanded")).toBe("true");
      } finally {
        await unmount();
      }
    });

    it("closes on a long drag without following the finger under reduced motion", async () => {
      const { sheet, row, chip, unmount } = await openSheet(1, true);
      try {
        await act(async () => {
          touch(row, "touchstart", 300, 0);
          touch(row, "touchmove", 500, 1000);
        });
        expect(sheet.style.translate).toBe("");
        await act(async () => touch(row, "touchend", 0, 1200));
        expect(chip()!.getAttribute("aria-expanded")).toBe("false");
        expect(sheet.isConnected).toBe(false);
      } finally {
        await unmount();
      }
    });
  });
});
