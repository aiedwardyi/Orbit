// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";

import { applyLocale } from "@/lib/i18n";
import { StoreProvider, type Bot, type Message } from "@/state/store";
import { ChatView, clearLivePaneCache } from "./ChatView";

vi.mock("shiki", () => ({ codeToHtml: async (code: string) => `<pre><code>${code}</code></pre>` }));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

class FakeEventSource {
  onmessage: ((event: { data: string; lastEventId: string }) => void) | null = null;
  close = vi.fn();
}

const launch = (i: number): Message => ({ id: `launch-${i}`, at: i + 1, role: "bot", kind: "launch", text: `Launched W${i} | Opus 5.5 | high\nSession: ${i}0000000-1` });
const blocked: Message = { id: "blocked", at: 20, role: "bot", kind: "note", text: "[pane 00000000] [W0 | Opus 5.5 | high] from Ada (ada): BLOCKED W0 branch=x sha=y dirty=no" };

const bot = (workers: number): Bot => ({
  id: "ada", threadId: "thread-ada", name: "Ada", title: "", description: "", notifications: false, color: "iris", unread: false,
  modelSelection: { instanceId: "inst", model: "m" },
  messages: [{ id: "u", at: 0, role: "user", kind: "text", text: "go" }, ...Array.from({ length: workers }, (_, i) => launch(i)), ...(workers ? [blocked] : [])],
} as unknown as Bot);

async function mount(workers: number, phone: boolean) {
  vi.stubGlobal("EventSource", FakeEventSource);
  vi.stubGlobal("fetch", vi.fn(async () => new Response("{}", { status: 404 })));
  vi.stubGlobal("ResizeObserver", class { observe() {} unobserve() {} disconnect() {} });
  vi.spyOn(window, "matchMedia").mockImplementation((query) => ({ matches: phone && query.includes("max-width"), media: query, addEventListener: vi.fn(), removeEventListener: vi.fn() }) as unknown as MediaQueryList);
  vi.spyOn(console, "warn").mockImplementation(() => {});
  const host = document.body.appendChild(document.createElement("div"));
  const root = createRoot(host);
  await act(async () => root.render(createElement(StoreProvider, null, createElement(ChatView, { bot: bot(workers) }))));
  const header = host.querySelector<HTMLElement>("[class*='@container/chathead']")!;
  return { header, unmount: async () => { await act(async () => root.unmount()); host.remove(); } };
}

const marks = (el: Element | null | undefined) => el ? [...el.querySelectorAll("[data-worker-state]")].map((mark) => mark.getAttribute("data-worker-state")) : [];

afterEach(() => {
  applyLocale("en");
  clearLivePaneCache();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  localStorage.clear();
});

describe("chat header worker strip", () => {
  it.each([false, true])("shows one mark for one worker with phone=%s", async (phone) => {
    const { header, unmount } = await mount(1, phone);
    try {
      const strip = header.querySelector("[data-worker-strip]")!;
      expect(header.firstElementChild?.contains(strip)).toBe(false);
      expect(marks(strip.querySelector("[data-worker-chip-desktop]"))).toEqual(["waiting"]);
      expect(marks(strip.querySelector("[data-worker-chip-phone]"))).toEqual(["waiting"]);
      expect(strip.textContent).toBe("");
      expect(strip.getAttribute("aria-label")).toBe("0 working, 1 waiting, 0 failed, 0 done. Show workers");
      expect(header.querySelector("[data-worker-status]")).toBeNull();
      expect(header.textContent).not.toMatch(/worker/i);
    } finally { await unmount(); }
  });

  it.each([false, true])("shows three marks plus four and a phone count of seven with phone=%s", async (phone) => {
    const { header, unmount } = await mount(7, phone);
    try {
      const strip = header.querySelector<HTMLButtonElement>("[data-worker-strip]")!;
      expect(marks(strip.querySelector("[data-worker-chip-desktop]"))).toHaveLength(3);
      expect(strip.querySelector("[data-worker-chip-desktop]")?.textContent).toBe("+4");
      expect(marks(strip.querySelector("[data-worker-chip-phone]"))).toHaveLength(1);
      expect(strip.querySelector("[data-worker-chip-phone]")?.textContent).toBe("7");
      expect(strip.getAttribute("aria-label")).toBe("6 working, 1 waiting, 0 failed, 0 done. Show workers");
      expect(header.querySelector("[data-worker-status]")).toBeNull();
      expect(header.textContent).not.toMatch(/7 workers/);
      await act(async () => strip.click());
      expect(document.body.querySelectorAll("[data-worker-list] li")).toHaveLength(7);
    } finally { await unmount(); }
  });

  it("has no strip and no worker line without workers", async () => {
    const { header, unmount } = await mount(0, false);
    try {
      expect(header.querySelector("[data-worker-strip]")).toBeNull();
      expect(header.querySelector("[data-worker-status]")).toBeNull();
    } finally { await unmount(); }
  });

  it("labels the strip in Korean", async () => {
    applyLocale("ko");
    const { header, unmount } = await mount(7, false);
    try {
      expect(header.querySelector("[data-worker-strip]")?.getAttribute("aria-label")).toBe("작업 중 6개, 대기 중 1개, 실패 0개, 완료 0개. 작업자 보기");
    } finally { await unmount(); }
  });
});
