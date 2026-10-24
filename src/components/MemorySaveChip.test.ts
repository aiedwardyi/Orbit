// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { PRESENCE_EXIT_MS } from "@/lib/use-presence";
import type { Message } from "@/state/store";

import { MemorySaveChip, MemorySaveRun } from "./MemorySaveChip";

const NOW = 1_800_000_000_000;

async function renderChip(at: number) {
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  await act(async () => root.render(createElement(MemorySaveChip, { summary: "likes short replies", at })));
  return { host, root };
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
});

afterEach(() => {
  vi.useRealTimers();
  document.body.innerHTML = "";
});

describe("MemorySaveChip", () => {
  it("shows an earlier save as saved on mount, without replaying Saving to memory", async () => {
    const { host, root } = await renderChip(NOW - 60_000);
    try {
      expect(host.textContent).toContain("likes short replies");
      expect(host.textContent).not.toContain("Saving to memory");
    } finally {
      await act(async () => root.unmount());
    }
  });

  it("draws the row flat", async () => {
    const { host, root } = await renderChip(NOW - 60_000);
    try {
      const cls = new Set(host.querySelector("span")!.parentElement!.className.split(/\s+/));
      expect(cls.has("border-transparent")).toBe(true);
      expect([...cls].filter((c) => /^(bg-|border-hairline|rounded-)/.test(c))).toEqual([]);
    } finally {
      await act(async () => root.unmount());
    }
  });

  it("flickers Saving to memory for a save that just landed", async () => {
    const { host, root } = await renderChip(NOW);
    try {
      expect(host.textContent).toContain("Saving to memory");
      await act(async () => {
        vi.advanceTimersByTime(700);
      });
      expect(host.textContent).toContain("likes short replies");
    } finally {
      await act(async () => root.unmount());
    }
  });
});

describe("MemorySaveRun", () => {
  const note = (id: string, at: number): Message => ({ id, at, role: "bot", kind: "activity", tool: { name: "memory.save", spoken: id, ok: true } });

  async function renderRun(ats: number[]) {
    const host = document.createElement("div");
    document.body.append(host);
    const root = createRoot(host);
    const messages = ats.map((at, i) => note(`n${i}`, at));
    await act(async () => root.render(createElement(MemorySaveRun, { messages, children: createElement("i", null, "notes") })));
    return { host, root };
  }

  it("draws the folded row flat, like the single save", async () => {
    const { host, root } = await renderRun([NOW - 60_000, NOW - 59_000]);
    try {
      const button = host.querySelector("button")!;
      const cls = new Set(button.className.split(/\s+/));
      expect(cls.has("border-transparent")).toBe(true);
      expect([...cls].filter((c) => /^(bg-|border-hairline|rounded-(full|2xl))/.test(c))).toEqual([]);
      expect(button.textContent).toBe("Memory updated · 2 notes");
      expect(button.querySelector("svg.text-success")).not.toBeNull();
    } finally {
      await act(async () => root.unmount());
    }
  });

  it("flickers again when the run grows live, then counts the new note", async () => {
    const { host, root } = await renderRun([NOW - 60_000, NOW - 59_000]);
    try {
      const messages = [NOW - 60_000, NOW - 59_000, NOW].map((at, i) => note(`n${i}`, at));
      await act(async () => root.render(createElement(MemorySaveRun, { messages, children: createElement("i", null, "notes") })));
      expect(host.querySelector("button")!.textContent).toBe("Saving to memory…");
      await act(async () => {
        vi.advanceTimersByTime(700);
      });
      expect(host.querySelector("button")!.textContent).toBe("Memory updated · 3 notes");
    } finally {
      await act(async () => root.unmount());
    }
  });

  it("keeps the notes mounted through the collapse, and drops them at once with reduced motion", async () => {
    let reduce = false;
    vi.spyOn(window, "matchMedia").mockImplementation((query: string) => ({
      matches: reduce, media: query, onchange: null, addListener: () => {}, removeListener: () => {}, addEventListener: () => {}, removeEventListener: () => {}, dispatchEvent: () => false,
    }));
    const { host, root } = await renderRun([NOW - 60_000, NOW - 59_000]);
    const toggle = () => host.querySelector("button")!;
    try {
      await act(async () => toggle().click());
      const notes = host.querySelector("i")!;
      expect(toggle().getAttribute("aria-expanded")).toBe("true");
      await act(async () => toggle().click());
      expect(toggle().getAttribute("aria-expanded")).toBe("false");
      expect(notes.closest("[data-closing]")).not.toBeNull();
      await act(async () => {
        vi.advanceTimersByTime(PRESENCE_EXIT_MS);
      });
      expect(notes.isConnected).toBe(false);
      reduce = true;
      await act(async () => toggle().click());
      await act(async () => toggle().click());
      expect(host.querySelector("i")).toBeNull();
    } finally {
      await act(async () => root.unmount());
      vi.restoreAllMocks();
    }
  });

  it("opens at its end state for a search landing, and a click still folds it open", async () => {
    vi.spyOn(window, "matchMedia").mockImplementation((query: string) => ({
      matches: false, media: query, onchange: null, addListener: () => {}, removeListener: () => {}, addEventListener: () => {}, removeEventListener: () => {}, dispatchEvent: () => false,
    }));
    const host = document.createElement("div");
    document.body.append(host);
    const root = createRoot(host);
    const messages = [NOW - 60_000, NOW - 59_000].map((at, i) => note(`n${i}`, at));
    const show = (forceOpen: boolean) => act(async () => root.render(createElement(MemorySaveRun, { messages, forceOpen, children: createElement("i", null, "notes") })));
    const toggle = () => act(async () => host.querySelector("button")!.click());
    const settle = () => act(async () => {
      vi.advanceTimersByTime(PRESENCE_EXIT_MS);
    });
    try {
      await show(true);
      const notes = host.querySelector("i")!;
      expect(host.querySelector(".animate-expand-in")).toBeNull();
      await toggle();
      expect(notes.closest("[data-closing]")).not.toBeNull();
      await settle();
      await show(false);
      await show(true);
      expect(host.querySelector("i")).not.toBeNull();
      expect(host.querySelector(".animate-expand-in")).toBeNull();
      await toggle();
      await settle();
      await toggle();
      expect(host.querySelector("i")!.closest(".animate-expand-in")).not.toBeNull();
    } finally {
      await act(async () => root.unmount());
      vi.restoreAllMocks();
    }
  });

  it("flickers Saving to memory while the newest save is inside the window, then counts", async () => {
    const { host, root } = await renderRun([NOW - 60_000, NOW]);
    try {
      expect(host.querySelector("button")!.textContent).toBe("Saving to memory…");
      expect(host.querySelector("button svg.animate-spin")).not.toBeNull();
      await act(async () => {
        vi.advanceTimersByTime(700);
      });
      expect(host.querySelector("button")!.textContent).toBe("Memory updated · 2 notes");
    } finally {
      await act(async () => root.unmount());
    }
  });
});
