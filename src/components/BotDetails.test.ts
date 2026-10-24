import "./ProfileFields.test-dom.ts";
import { act, createElement, useEffect } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { StoreProvider, useStore, type Bot } from "@/state/store";
import { I18nProvider } from "@/lib/i18n";
import { PRESENCE_EXIT_MS } from "@/lib/use-presence";
import { loadSidebarOrder } from "@/lib/sidebar-preferences";
import { ChatView, clearLivePaneCache } from "./ChatView";
import { SettingsPanel } from "./SettingsPanel";

Object.defineProperty(globalThis, "localStorage", { configurable: true, value: window.localStorage });
Object.defineProperty(globalThis, "HTMLTextAreaElement", { configurable: true, value: window.HTMLTextAreaElement });

const bot: Bot = {
  id: "details-bot",
  threadId: "details-thread",
  name: "Rando",
  title: "Helper",
  description: "Helps with the project.",
  notifications: false,
  color: "green",
  unread: false,
  modelSelection: { instanceId: "fixture", model: "default" },
  messages: [],
};

let host: HTMLDivElement;
let root: Root;
let send: ReturnType<typeof useStore>["dispatch"];
interface PendingResponse {
  resolve: (response: Response) => void;
  reject: (error: Error) => void;
}
let patch: PendingResponse;
let topics: Map<string, (response: Response) => void>;
let state: ReturnType<typeof useStore>["state"];

const json = <T,>(value: T) => new Response(JSON.stringify(value));

function Harness({ header }: { header: boolean }) {
  const store = useStore();
  send = store.dispatch;
  state = store.state;
  useEffect(() => {
    send({ type: "hydrate", bots: [bot], groups: [], computerControl: {}, sidebarOrder: loadSidebarOrder() });
  }, []);
  const current = state.bots.find((b) => b.id === bot.id) ?? bot;
  return createElement("div", null,
    header && createElement(ChatView, { bot: current }),
    (!header || state.settingsOpen) && createElement(SettingsPanel, { bot: current }),
  );
}

async function mount(header = false) {
  await act(async () => root.render(createElement(StoreProvider, null,
    createElement(I18nProvider, null, createElement(Harness, { header })),
  )));
}

function field(name: string) {
  const label = Array.from(host.querySelectorAll("label")).find((item) => item.firstElementChild?.textContent?.startsWith(name));
  if (!label) throw new Error(`Missing field ${name}`);
  return label;
}

const status = (name: string) => field(name).querySelector('[role="status"]');
const row = (name: string) => Array.from(host.querySelectorAll("button")).find((item) => item.textContent?.includes(name))!;
const click = (element: Element) => act(async () => { element.dispatchEvent(new MouseEvent("click", { bubbles: true })); });
const tick = (ms: number) => act(async () => { await vi.advanceTimersByTimeAsync(ms); });

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
  localStorage.clear();
  localStorage.setItem("omb-locale", "en");
  topics = new Map();
  vi.stubGlobal("ResizeObserver", class { observe() {} unobserve() {} disconnect() {} });
  vi.stubGlobal("EventSource", class { onmessage = null; close() {} });
  vi.spyOn(window, "matchMedia").mockImplementation((media) => ({
    matches: false, media, onchange: null, addListener() {}, removeListener() {},
    addEventListener() {}, removeEventListener() {}, dispatchEvent: () => false,
  }));
  vi.stubGlobal("fetch", vi.fn((path: string, init?: RequestInit) => {
    if (path === `/api/bots/${bot.id}` && init?.method === "PATCH") {
      return new Promise<Response>((resolve, reject) => { patch = { resolve, reject }; });
    }
    if (path.endsWith("/memory") && init?.method === "PUT") {
      return new Promise<Response>((resolve, reject) => { patch = { resolve, reject }; });
    }
    if (path.includes("/memory/topics/")) {
      return new Promise<Response>((resolve) => { topics.set(decodeURIComponent(path.split("/").at(-1)!), resolve); });
    }
    if (path.endsWith("/memory")) return Promise.resolve(json({
      text: "Project notes", revision: "r1", truncated: true,
      topics: [{ name: "project.md", bytes: 120 }, { name: "preferences.md", bytes: 80 }],
    }));
    if (path === "/api/bots") return Promise.resolve(json({ bots: [bot], groups: [], computerControl: {} }));
    return Promise.resolve(json({ instances: [], devices: [], routines: [], runs: [], webhooks: [], attempts: [] }));
  }));
  host = document.body.appendChild(document.createElement("div"));
  root = createRoot(host);
});

afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  clearLivePaneCache();
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  localStorage.clear();
});

describe("Bot Details header", () => {
  it("opens details from the avatar with the picker closed on desktop", async () => {
    await mount(true);
    await click(host.querySelector('button[data-orbit-chat-focus-fallback]')!);
    expect(state.settingsOpen).toBe(true);
    expect(state.settingsAvatarRequest).toBe(0);
    expect(host.querySelector('button[aria-label="Customize"]')).toBeNull();
    expect(host.querySelector('[data-settings-panel]')?.textContent).toContain("Customize");
    expect(host.querySelector('[data-settings-panel]')?.textContent).not.toContain("Done");
  });

  it("opens details from the desktop name without a pencil or rename mode", async () => {
    await mount(true);
    const name = Array.from(host.querySelectorAll("main button")).find((item) => item.textContent === bot.name && !item.classList.contains("md:hidden"));
    expect(host.querySelector("main .lucide-pencil")).toBeNull();
    expect(name).toBeDefined();
    await click(name!);
    expect(state.settingsOpen).toBe(true);
    expect(state.settingsAvatarRequest).toBe(0);
  });

});

describe("Bot Details save status", () => {
  it.each([["Name", "name"], ["Title", "title"], ["Description", "description"]] as const)(
    "shows %s as saved only after the patch response, then fades it out", async (label, key) => {
      await mount();
      expect(status(label)?.textContent ?? "").toBe("");
      await act(async () => send({ type: "updateBot", botId: bot.id, patch: { [key]: "Updated" } }));
      expect.soft(status(label)?.textContent).toBe("Saving…");
      await tick(400);
      expect.soft(status(label)?.textContent).toBe("Saving…");
      await act(async () => patch.resolve(json({ bot: { ...bot, [key]: "Updated" } })));
      expect(status(label)?.textContent).toBe("Saved");
      expect(status(label)?.querySelector(".lucide-check")).not.toBeNull();
      expect(status(label)?.querySelector(".animate-fade-in")).not.toBeNull();
      await tick(1999);
      expect(status(label)?.querySelector("[data-closing]")).toBeNull();
      await tick(1);
      expect(status(label)?.querySelector("[data-closing]")).not.toBeNull();
      await tick(PRESENCE_EXIT_MS);
      expect(status(label)?.textContent).toBe("");
    },
  );

  it.each([["Name", "name"], ["Title", "title"], ["Description", "description"]] as const)(
    "never confirms a rejected %s patch, including a successful reconciliation", async (label, key) => {
      await mount();
      await act(async () => send({ type: "updateBot", botId: bot.id, patch: { [key]: "Rejected" } }));
      expect.soft(status(label)?.textContent).toBe("Saving…");
      await tick(400);
      await act(async () => patch.reject(new Error("Save refused")));
      expect(state.error).toBe("Save refused");
      expect(status(label)).not.toBeNull();
      expect(status(label)?.textContent).not.toContain("Saved");
      expect(field(label).querySelector("input, textarea")?.getAttribute("value") ?? state.bots[0][key]).not.toBe("Rejected");
    },
  );

  it("shows a save already in flight at once when details open", async () => {
    await mount(true);
    await act(async () => send({ type: "updateBot", botId: bot.id, patch: { name: "Pending" } }));
    await act(async () => send({ type: "toggleSettings", open: true }));
    expect(status("Name")?.textContent).toBe("Saving…");
    expect(status("Name")?.querySelector(".animate-fade-in")).toBeNull();
  });

  it("keeps a newer edit saving when an older request succeeds", async () => {
    await mount();
    await act(async () => send({ type: "updateBot", botId: bot.id, patch: { name: "First", title: "New title" } }));
    await tick(400);
    const first = patch;
    await act(async () => send({ type: "updateBot", botId: bot.id, patch: { name: "Second" } }));
    await act(async () => first.resolve(json({ bot: { ...bot, name: "First", title: "New title" } })));
    expect(status("Name")?.textContent).toBe("Saving…");
    expect(status("Title")?.textContent).toBe("Saved");
    await tick(400);
    await act(async () => patch.resolve(json({ bot: { ...bot, name: "Second", title: "New title" } })));
    expect(status("Name")?.textContent).toBe("Saved");
  });

  it("uses the same checked, fading status after memory is confirmed", async () => {
    await mount();
    const editor = host.querySelector<HTMLTextAreaElement>('textarea[aria-label="Memory"]')!;
    const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, "value")!.set!;
    await act(async () => {
      setter.call(editor, "Updated memory");
      editor.dispatchEvent(new Event("input", { bubbles: true }));
    });
    const memoryStatus = () => editor.parentElement?.parentElement?.querySelector('[role="status"]');
    expect(memoryStatus()?.textContent).toBe("Saving…");
    await tick(800);
    expect(memoryStatus()?.textContent).toBe("Saving…");
    await act(async () => patch.resolve(json({ revision: "r2", truncated: false })));
    expect(memoryStatus()?.textContent).toBe("Saved");
    expect(memoryStatus()?.querySelector(".lucide-check")).not.toBeNull();
    await tick(2000);
    expect(memoryStatus()?.querySelector("[data-closing]")).not.toBeNull();
  });
});

describe("Bot Details topics", () => {
  it("keeps the list and memory editor mounted while one inline topic opens and closes", async () => {
    await mount();
    const editor = host.querySelector('textarea[aria-label="Memory"]');
    const first = row("project.md");
    const second = row("preferences.md");
    await click(first);
    expect.soft(first.getAttribute("aria-expanded")).toBe("true");
    expect.soft(first.textContent).toContain("Loading…");
    await act(async () => topics.get("project.md")!(json({ name: "project.md", text: "Project topic" })));
    expect(host.querySelector('textarea[aria-label="Memory"]')).toBe(editor);
    expect(row("preferences.md")).toBe(second);
    expect(first.getAttribute("aria-expanded")).toBe("true");
    expect(first.classList.contains("bg-control")).toBe(true);
    expect(first.querySelector(".lucide-chevron-down")?.classList.contains("rotate-180")).toBe(true);
    expect(first.parentElement?.querySelector("[data-expand] pre")?.textContent).toBe("Project topic");
    expect(first.parentElement?.querySelector("[data-expand]")?.classList.contains("animate-expand-in")).toBe(true);
    await click(first);
    expect(first.getAttribute("aria-expanded")).toBe("false");
    expect(first.classList.contains("bg-control")).toBe(false);
    expect(first.parentElement?.querySelector("[data-expand][data-closing] pre")?.textContent).toBe("Project topic");
    await tick(PRESENCE_EXIT_MS);
    expect(first.parentElement?.querySelector("pre")).toBeNull();
    expect(host.querySelector('textarea[aria-label="Memory"]')).toBe(editor);
    expect(host.textContent).not.toContain("Back");
  });

  it("ignores a late topic response after another row opens", async () => {
    await mount();
    const first = row("project.md");
    const second = row("preferences.md");
    await click(first);
    await click(second);
    await act(async () => topics.get("preferences.md")!(json({ name: "preferences.md", text: "Preferences topic" })));
    await act(async () => topics.get("project.md")!(json({ name: "project.md", text: "Stale project" })));
    expect(first.getAttribute("aria-expanded")).toBe("false");
    expect(second.getAttribute("aria-expanded")).toBe("true");
    expect(host.textContent).toContain("Preferences topic");
    expect(host.textContent).not.toContain("Stale project");
    expect(host.querySelector('textarea[aria-label="Memory"]')).not.toBeNull();
  });

  it("reopens a loaded topic at once while it refreshes", async () => {
    await mount();
    const first = row("project.md");
    await click(first);
    await act(async () => topics.get("project.md")!(json({ name: "project.md", text: "Project topic" })));
    await click(first);
    await tick(PRESENCE_EXIT_MS);
    await click(first);
    expect(first.getAttribute("aria-busy")).toBeNull();
    expect(first.textContent).not.toContain("Loading…");
    expect(first.parentElement?.querySelector("[data-expand] pre")?.textContent).toBe("Project topic");
  });

  it("closes a topic that fails to load and keeps the editor and list", async () => {
    await mount();
    const editor = host.querySelector('textarea[aria-label="Memory"]');
    const first = row("project.md");
    await click(first);
    await act(async () => topics.get("project.md")!(new Response(JSON.stringify({ error: "Topic missing" }), { status: 404 })));
    expect(first.getAttribute("aria-expanded")).toBe("false");
    expect(first.textContent).not.toContain("Loading…");
    expect(host.textContent).toContain("Topic missing");
    expect(host.querySelector('textarea[aria-label="Memory"]')).toBe(editor);
    expect(row("project.md")).toBe(first);
  });
});
