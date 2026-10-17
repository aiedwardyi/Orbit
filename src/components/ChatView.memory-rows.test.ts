// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";

import { applyLocale } from "@/lib/i18n";
import { setFindCurrent } from "@/lib/chat-find";
import { StoreProvider, type Bot, type Message } from "@/state/store";

import { ChatView } from "./ChatView";

class FakeEventSource {
  onmessage: ((event: { data: string; lastEventId: string }) => void) | null = null;
  close = vi.fn();
}

const say = (id: string, text: string, at: number): Message => ({ id, at, role: "bot", kind: "text", text });
const save = (id: string, spoken: string, at: number): Message => ({ id, at, role: "bot", kind: "activity", tool: { name: "memory.save", spoken, ok: true } });

const botWith = (messages: Message[]): Bot => ({
  id: "mem", threadId: "thread-mem", name: "Mem", title: "", description: "", notifications: false,
  color: "blue", unread: false, modelSelection: { instanceId: "inst", model: "m" }, messages, hasMore: false,
});

const saves = [save("s1", "likes short replies", 3), save("s2", "lives in Seoul", 4), save("s3", "prefers dark mode", 5)];
const ask: Message = { id: "u1", at: 1, role: "user", kind: "text", text: "remember me" };
const thread = (...between: Message[]) => [ask, say("b1", "Saving notes.", 2), ...between, say("b2", "Done.", 9)];

async function mount(messages: Message[]) {
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
  const render = (next: Message[]) => act(async () => root.render(createElement(StoreProvider, null, createElement(ChatView, { bot: botWith(next) }))));
  await render(messages);
  return { host, render, unmount: async () => { await act(async () => root.unmount()); host.remove(); } };
}

const folds = (host: HTMLElement) => [...host.querySelectorAll<HTMLButtonElement>("button[aria-expanded]")].filter((button) => /^(Memory updated ·|메모리 업데이트 ·)/.test(button.textContent ?? ""));
const labels = (host: HTMLElement) => folds(host).map((button) => button.textContent);
const fold = (host: HTMLElement) => folds(host)[0]!;
const notes = (host: HTMLElement) => [...host.querySelectorAll("[data-mid]")].filter((row) => row.textContent?.startsWith("Memory updated:")).map((row) => row.textContent);

afterEach(() => {
  setFindCurrent(null);
  applyLocale("en");
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  localStorage.clear();
});

describe("ChatView memory rows", () => {
  it("folds a run of saves into one row that names the count", async () => {
    const view = await mount(thread(...saves));
    try {
      expect(labels(view.host)).toEqual(["Memory updated · 3 notes"]);
      expect(fold(view.host).getAttribute("aria-expanded")).toBe("false");
      expect(view.host.textContent).not.toContain("likes short replies");
    } finally {
      await view.unmount();
    }
  });

  it("says the count in Korean", async () => {
    applyLocale("ko");
    const view = await mount(thread(...saves));
    try {
      expect(labels(view.host)).toEqual(["메모리 업데이트 · 3개"]);
      expect(view.host.textContent).not.toContain("Memory updated");
    } finally {
      await view.unmount();
    }
  });

  it("leaves a lone save as today's row", async () => {
    const view = await mount(thread(saves[0]));
    try {
      expect(folds(view.host)).toEqual([]);
      expect(notes(view.host)).toEqual(["Memory updated: likes short replies"]);
    } finally {
      await view.unmount();
    }
  });

  it("opens on a click, lists every note oldest first, and folds on the next click", async () => {
    const view = await mount(thread(...saves));
    try {
      await act(async () => fold(view.host).click());
      expect(fold(view.host).getAttribute("aria-expanded")).toBe("true");
      expect(notes(view.host)).toEqual(["Memory updated: likes short replies", "Memory updated: lives in Seoul", "Memory updated: prefers dark mode"]);
      await act(async () => fold(view.host).click());
      expect(notes(view.host)).toEqual([]);
    } finally {
      await view.unmount();
    }
  });

  it("is a focusable native button, so Enter and Space open it", async () => {
    const view = await mount(thread(...saves));
    try {
      const button = fold(view.host);
      expect(button.tagName).toBe("BUTTON");
      expect(button.getAttribute("type")).toBe("button");
      expect(button.disabled).toBe(false);
      expect(button.tabIndex).toBe(0);
    } finally {
      await view.unmount();
    }
  });

  it("stays open and counts the new note while the bot keeps saving", async () => {
    const view = await mount(thread(...saves));
    try {
      await act(async () => fold(view.host).click());
      await view.render(thread(...saves, save("s4", "owns a cat", 6)));
      expect(fold(view.host).getAttribute("aria-expanded")).toBe("true");
      expect(labels(view.host)).toEqual(["Memory updated · 4 notes"]);
      expect(notes(view.host)).toHaveLength(4);
    } finally {
      await view.unmount();
    }
  });

  it("folds saves across rows the chat hides", async () => {
    const hiddenStep: Message = { id: "r1", at: 4, role: "bot", kind: "activity", tool: { name: "Read", ok: true } };
    const view = await mount(thread(saves[0], hiddenStep, saves[1]));
    try {
      expect(labels(view.host)).toEqual(["Memory updated · 2 notes"]);
    } finally {
      await view.unmount();
    }
  });

  it("starts a second run after the bot speaks", async () => {
    const view = await mount(thread(saves[0], saves[1], say("mid", "More.", 5), save("s5", "a", 6), save("s6", "b", 7)));
    try {
      expect(labels(view.host)).toEqual(["Memory updated · 2 notes", "Memory updated · 2 notes"]);
    } finally {
      await view.unmount();
    }
  });

  it("opens for a find hit on a note inside it", async () => {
    const view = await mount(thread(...saves));
    try {
      expect(notes(view.host)).toEqual([]);
      await act(async () => setFindCurrent({ messageId: "s2", query: "Seoul" }));
      expect(fold(view.host).getAttribute("aria-expanded")).toBe("true");
      expect(view.host.querySelector('[data-mid="s2"]')?.textContent).toBe("Memory updated: lives in Seoul");
    } finally {
      await view.unmount();
    }
  });
});
