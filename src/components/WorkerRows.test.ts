import "@/components/ProfileFields.test-dom.ts";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { Message } from "@/state/store";
import { workerRuns, type WorkerShownState } from "@/lib/worker-runs";
import { ProviderMark } from "./ProviderIcons";
import { applyLocale } from "@/lib/i18n";
import { WORKER_STATUS, WorkerChip, WorkerRow, type ShownRun } from "./WorkerRows";

const run = (label: string) => {
  const launch: Message = { id: "l1", at: 1, role: "bot", kind: "launch", text: `Launched ${label}\nLabel: ${label}\nWorking folder: C:\\repo\nSession: aaaaaaaa-1` };
  return workerRuns([launch])[0]!;
};

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
    const markup = renderToStaticMarkup(createElement(WorkerRow, { run: run(`A | ${model} | high`), state: "waiting", live: null }));
    expect(markup).toContain(renderToStaticMarkup(createElement(ProviderMark, { driverKind, size: 14 })));
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
  const mount = async (runs: ShownRun[], opts?: { onOpenTerminalPane?: (sessionId: string) => void; livePanes?: Set<string> | null }) => {
    applyLocale("en");
    const host = document.createElement("div");
    document.body.append(host);
    const root = createRoot(host);
    await act(async () => root.render(createElement(WorkerChip, { name: "Ada", runs, livePanes: opts?.livePanes, onOpenTerminalPane: opts?.onOpenTerminalPane })));
    return {
      host,
      root,
      chip: () => host.querySelector<HTMLButtonElement>("[data-worker-strip]"),
      unmount: async () => { await act(async () => root.unmount()); host.remove(); },
    };
  };

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

  it("stacks three marks on desktop and one mark plus a count on a phone", async () => {
    vi.stubGlobal("matchMedia", () => ({ matches: false }));
    const runs = [1, 2, 3, 4].map((at) => shown(`W${at}`, "working", `session-${at}`, at));
    const { host, unmount } = await mount(runs);
    try {
      const desktop = host.querySelector("[data-worker-chip-desktop]")!;
      expect(desktop.querySelectorAll("[data-worker-state]")).toHaveLength(3);
      expect(desktop.textContent).toBe("+1");
      const phone = host.querySelector("[data-worker-chip-phone]")!;
      expect(phone.querySelectorAll("[data-worker-state]")).toHaveLength(1);
      expect(phone.textContent).toBe("4");
      expect(host.querySelector("[data-worker-strip]")?.getAttribute("aria-label")).toBe("4 working, 0 waiting, 0 failed, 0 done. Show workers");
    } finally {
      await unmount();
    }
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
      expect(host.querySelector("[data-worker-strip]")).not.toBeNull();
      expect([...host.querySelectorAll("[data-worker-chip-desktop] [data-worker-state]")].map((el) => el.getAttribute("data-worker-state"))).toEqual(["waiting", "failed", "done"]);
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
        "WAITOpus 5.5‖Waiting", "SHIPOpus 5.5!Failed", "COPYOpus 5.5✓Done",
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
      expect([...host.querySelectorAll("[data-worker-chip-desktop] [data-worker-state]")].map((el) => el.getAttribute("data-worker-state"))).toEqual(["waiting", "working"]);
      await act(async () => chip()!.click());
      expect([...host.querySelectorAll("[data-worker-list] li")].map((li) => li.textContent)).toEqual([
        "WAITOpus 5.5‖Waiting", "WORKOpus 5.5●Working",
      ]);
    } finally {
      await unmount();
    }
  });

  it("faces a waiting script first with a scroll glyph while AI workers keep brand marks", async () => {
    vi.stubGlobal("matchMedia", () => ({ matches: false }));
    const { host, chip, unmount } = await mount([
      { run: run("A | Grok 4.7 | high"), state: "working" },
      { run: run("REL-CHAIN-166 | script"), state: "waiting" },
    ], { livePanes: null });
    try {
      const desktop = [...host.querySelectorAll("[data-worker-chip-desktop] svg")];
      expect(desktop).toHaveLength(2);
      expect(desktop[0]!.classList.contains("lucide-scroll-text")).toBe(true);
      expect(desktop.some((svg) => svg.classList.contains("lucide-square-terminal"))).toBe(false);
      const phone = host.querySelector("[data-worker-chip-phone] svg")!;
      expect(phone.classList.contains("lucide-scroll-text")).toBe(true);
      await act(async () => chip()!.click());
      const list = host.querySelector("[data-worker-list]")!;
      expect([...list.querySelectorAll("li")].map((li) => li.textContent)).toEqual([
        "REL-CHAIN-166script‖Waiting", "AGrok 4.7●Working",
      ]);
      const marks = [...list.querySelectorAll("svg")];
      expect(marks).toHaveLength(2);
      expect(marks.filter((svg) => svg.classList.contains("lucide-scroll-text"))).toHaveLength(1);
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
    const { host, root, chip, unmount } = await mount(runs, { livePanes: new Set(["aaaaaaaa-1"]), onOpenTerminalPane: onOpen });
    try {
      expect(chip()!.getAttribute("aria-label")).toBe("0 working, 1 waiting, 0 failed, 0 done. Show workers");
      expect(host.querySelectorAll("[data-worker-chip-desktop] [data-worker-state]")).toHaveLength(1);
      expect(host.querySelector("[data-worker-chip-phone]")!.textContent).toBe("");
      await act(async () => chip()!.click());
      const list = document.body.querySelector("[data-worker-list]")!;
      expect(list.querySelectorAll("li")).toHaveLength(1);
      expect(list.querySelector("li")!.textContent).toBe("CHAIN-GP2Opus 5.5‖Waiting");
      await act(async () => list.querySelector<HTMLButtonElement>("li > button")!.click());
      expect(onOpen).toHaveBeenCalledExactlyOnceWith("aaaaaaaa-1");
      await act(async () => root.render(createElement(WorkerChip, { name: "Ada", runs, livePanes: null })));
      expect(chip()!.getAttribute("aria-label")).toBe("1 working, 1 waiting, 0 failed, 0 done. Show workers");
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
      expect(host.querySelector("[data-worker-strip]")).toBeNull();
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
});
