// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { applyLocale, I18nProvider } from "@/lib/i18n";
import { StoreProvider, type Bot, type Group, type Message } from "@/state/store";

import { ChatView } from "./ChatView";
import { Transcript } from "./GroupView";

const missing = "C:\\old-parent\\missing-project";
const replacement = "C:\\projects\\new-project";
const ask: Message = { id: "u1", role: "user", kind: "text", text: "Try this again", at: 1 };
const failure: Message = {
  id: "e1", parentId: "u1", role: "bot", kind: "activity", at: 2,
  tool: { name: `error: Project folder not found: \`${missing}\`.`, ok: false, folder: missing } as Message["tool"],
  from: { botId: "b1", name: "Friend", color: "blue" },
};
const bot: Bot = {
  id: "b1", threadId: "t1", name: "Friend", title: "", description: "", notifications: false,
  color: "blue", unread: false, busy: false, activity: "idle", cwd: missing,
  modelSelection: { instanceId: "fake", model: "m" }, messages: [ask, failure],
};
const group: Group = {
  id: "g1", threadId: "gt1", name: "Project", memberIds: [bot.id],
  defaultResponder: { kind: "member", botId: bot.id }, bulletin: "", unread: false,
  createdAt: 1, cwd: missing, pinnedCwd: missing, messages: [ask, failure],
};

class FakeEventSource {
  close() {}
}

let root: ReturnType<typeof createRoot> | null = null;
let reduced = false;
let saveError = false;
let calls: Array<{ url: string; method: string; body?: Record<string, unknown> }>;

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("EventSource", FakeEventSource);
  vi.stubGlobal("ResizeObserver", class { observe() {} unobserve() {} disconnect() {} });
  vi.spyOn(console, "warn").mockImplementation(() => {});
  const media = window.matchMedia.bind(window);
  vi.spyOn(window, "matchMedia").mockImplementation((query) => ({ ...media(query), matches: query.includes("reduced-motion") && reduced }));
  Object.defineProperty(window, "ogb", { configurable: true, writable: true, value: undefined });
  applyLocale("en");
  calls = [];
  vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
    const method = init?.method ?? "GET";
    const body = typeof init?.body === "string" ? JSON.parse(init.body) : undefined;
    calls.push({ url, method, body });
    if (method === "PATCH") {
      if (saveError) return Response.json({ error: "Folder is unavailable" }, { status: 400 });
      return Response.json(url.includes("/groups/") ? { group: { ...group, cwd: body.cwd, pinnedCwd: body.cwd } } : { bot: { ...bot, cwd: body.cwd } });
    }
    if (url.startsWith("/api/bots?")) return Response.json({ bots: [bot], groups: [group], computerControl: {} });
    if (url === "/api/devices") return Response.json({ devices: [] });
    if (url.endsWith("/messages") && method === "GET") return Response.json({ messages: bot.messages, hasMore: false });
    return Response.json({});
  }));
});

afterEach(async () => {
  await act(async () => root?.unmount());
  root = null;
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  Object.defineProperty(window, "ogb", { configurable: true, writable: true, value: undefined });
  document.body.replaceChildren();
  localStorage.clear();
  reduced = false;
  saveError = false;
});

async function mount(room?: Group, current = bot) {
  const host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  const view = room ? createElement(Transcript, {
    group: room, members: [current], messages: room.messages, transcript: room.messages,
    streamingMessage: null, dock: null, onReply() {}, onFocusComposer() {}, onMessageMenu() {}, workers: [],
  }) : createElement(ChatView, { bot: current });
  await act(async () => root!.render(createElement(I18nProvider, null, createElement(StoreProvider, null, view))));
  vi.useFakeTimers();
  return host;
}

function choose(host: HTMLElement) {
  const button = [...host.querySelectorAll("button")].find((element) => element.textContent?.trim() === "Choose folder");
  expect(button, "missing-folder action").toBeDefined();
  return button!;
}

const patches = () => calls.filter((call) => call.method === "PATCH");
const retries = () => calls.filter((call) => call.method === "POST" && (/\/edit$/.test(call.url) || /\/groups\/.+\/messages$/.test(call.url)));
async function advance(ms: number) { await act(async () => vi.advanceTimersByTimeAsync(ms)); }
async function click(button: HTMLButtonElement) { await act(async () => button.click()); }
function setPicker(pickFolder: (current?: string) => Promise<string | null>) {
  Object.defineProperty(window, "ogb", { configurable: true, writable: true, value: { pickFolder } });
}

describe("missing project folder", () => {
  it("replaces Retry, picks near the missing folder, saves and reruns once after the fade and hold", async () => {
    const pickFolder = vi.fn(async () => replacement);
    setPicker(pickFolder);
    const host = await mount();
    const row = host.querySelector('[data-mid="e1"]')!;
    expect(row.textContent).not.toContain("Retry");
    await click(choose(host));
    expect(pickFolder).toHaveBeenCalledWith("C:\\old-parent\\");
    expect(patches()).toEqual([{ url: "/api/bots/b1", method: "PATCH", body: { cwd: replacement } }]);
    expect(host.querySelector('[data-folder-fix="fading"]')).not.toBeNull();
    await advance(200);
    const success = host.querySelector('[data-folder-fix="success"]')!;
    expect(success.textContent).toBe("Project folder set to new-project");
    expect(success.querySelector(".text-success")).not.toBeNull();
    expect(success.querySelector("[title]")?.getAttribute("title")).toBe(replacement);
    await advance(699);
    expect(retries()).toHaveLength(0);
    await advance(1);
    expect(retries()).toHaveLength(1);
    await advance(2000);
    expect(retries()).toHaveLength(1);
  });

  it("changes nothing on cancel", async () => {
    setPicker(vi.fn(async () => null));
    const host = await mount();
    await click(choose(host));
    await advance(2000);
    expect(patches()).toHaveLength(0);
    expect(retries()).toHaveLength(0);
    expect(host.querySelector('[data-folder-fix="red"]')).not.toBeNull();
  });

  it("keeps the error and its reason when saving fails", async () => {
    saveError = true;
    setPicker(vi.fn(async () => replacement));
    const host = await mount();
    await click(choose(host));
    expect(host.querySelector('[data-folder-fix="red"]')?.textContent).toContain("Folder is unavailable");
    await advance(2000);
    expect(retries()).toHaveLength(0);
    expect(choose(host).disabled).toBe(false);
  });

  it("skips the fade under reduced motion and still holds for 700 ms", async () => {
    reduced = true;
    setPicker(vi.fn(async () => replacement));
    const host = await mount();
    await click(choose(host));
    expect(host.querySelector('[data-folder-fix="success"]')).not.toBeNull();
    expect(host.querySelector('[data-folder-fix="fading"]')).toBeNull();
    await advance(699);
    expect(retries()).toHaveLength(0);
    await advance(1);
    expect(retries()).toHaveLength(1);
  });

  it("reuses the prefilled path field and Save without a native picker", async () => {
    const host = await mount();
    await click(choose(host));
    const field = host.querySelector<HTMLInputElement>('input[placeholder="Absolute path, or ~/…"]') ?? host.querySelector<HTMLInputElement>("form input");
    expect(field?.value).toBe(missing);
    expect(field?.className).toContain("font-mono");
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(field, replacement);
      field!.dispatchEvent(new Event("input", { bubbles: true }));
    });
    const save = [...host.querySelectorAll("button")].find((button) => button.textContent === "Save")!;
    await click(save);
    expect(patches()[0]).toMatchObject({ url: "/api/bots/b1", body: { cwd: replacement } });
  });

  it("falls back to the default picker when the missing parent cannot be opened", async () => {
    const pickFolder = vi.fn().mockRejectedValueOnce(new Error("parent missing")).mockResolvedValueOnce(replacement);
    setPicker(pickFolder);
    const host = await mount();
    await click(choose(host));
    expect(pickFolder.mock.calls).toEqual([["C:\\old-parent\\"], []]);
    expect(patches()).toHaveLength(1);
  });

  it("saves the group folder and invokes the group's own retry once", async () => {
    setPicker(vi.fn(async () => replacement));
    const host = await mount(group);
    expect(host.querySelector('[data-mid="e1"]')?.textContent).not.toContain("Retry");
    await click(choose(host));
    expect(patches()[0]).toMatchObject({ url: "/api/groups/g1", body: { cwd: replacement } });
    await advance(900);
    expect(retries()).toHaveLength(1);
    expect(retries()[0]).toMatchObject({ url: "/api/groups/g1/messages", body: { text: ask.text, threadId: "gt1" } });
    await advance(2000);
    expect(retries()).toHaveLength(1);
  });

  it("saves a stale room pin through the group setter", async () => {
    setPicker(vi.fn(async () => replacement));
    const host = await mount({ ...group, cwd: "C:\\other" });
    await click(choose(host));
    expect(patches()[0]).toMatchObject({ url: "/api/groups/g1", body: { cwd: replacement } });
  });

  it("saves a member's own folder through the bot setter", async () => {
    setPicker(vi.fn(async () => replacement));
    const host = await mount({ ...group, cwd: undefined, pinnedCwd: null });
    await click(choose(host));
    expect(patches()[0].url).toBe("/api/bots/b1");
    await advance(900);
    expect(retries()).toHaveLength(1);
  });

  it("leaves older folder errors without controls", async () => {
    const tail: Message = { id: "done", role: "bot", kind: "text", text: "Later reply", at: 3 };
    const host = await mount(undefined, { ...bot, messages: [...bot.messages, tail] });
    const row = host.querySelector('[data-mid="e1"]')!;
    expect(row.textContent).toContain("Project folder not found");
    expect(row.querySelector("button, input")).toBeNull();
  });
});
