// @vitest-environment happy-dom
import { act, createElement, Fragment, useState, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import App from "./App";
import { SNAPSHOT_CACHE_KEY } from "@/state/snapshot-cache";
import { ConfirmDialog } from "@/components/ConfirmDialog";
import { startSelectMode } from "@/components/MessageMenu";

let host: HTMLDivElement;
let root: Root;

const wait = (ms: number) => act(() => new Promise<void>((done) => setTimeout(done, ms)));
async function until<T extends Element>(found: () => T | null) {
  for (let tries = 0; tries < 100 && !found(); tries++) await wait(20);
  return found();
}
const key = (init: KeyboardEventInit) => act(async () => window.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, cancelable: true, ...init })));
const menu = () => document.querySelector("[data-worker-list]");
const strip = () => document.querySelector<HTMLButtonElement>("main [data-worker-strip]");

const launch = (botId: string, label: string, session: string) => ({
  id: `${botId}-launch`, at: 1, role: "bot", kind: "launch", from: { botId, name: botId },
  text: [`Launched ${label}`, `Label: ${label}`, "Working folder: C:/work", `Session: ${session}`].join("\n"),
});
const bot = (id: string, name: string, label: string) => ({
  id, threadId: `t-${id}`, name, modelSelection: { instanceId: "inst", model: "m" },
  messages: [launch(id, label, `${id.padEnd(8, "0")}-0000-4000-8000-000000000000`)],
});

function ConfirmOverApp() {
  const [open, setOpen] = useState(false);
  return createElement(Fragment, null,
    createElement(App),
    createElement("button", { "data-open-confirm": "", onClick: () => setOpen(true) }, "Confirm"),
    open && createElement(ConfirmDialog, { title: "Confirm", confirmLabel: "Confirm", onCancel: () => setOpen(false), onConfirm: () => setOpen(false) }),
  );
}

beforeEach(() => {
  localStorage.setItem("omb-onboarding-done", "true");
  localStorage.setItem(SNAPSHOT_CACHE_KEY, JSON.stringify({
    bots: [bot("b1", "Scout", "ONE | Opus 5.5 | high"), bot("b2", "Pilot", "TWO | Opus 5.5 | high")],
    groups: [],
    selectedId: "b1",
  }));
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("fetch", vi.fn(() => new Promise<Response>(() => {})));
  vi.stubGlobal("EventSource", class { onmessage = null; close = vi.fn(); });
  host = document.body.appendChild(document.createElement("div"));
  root = createRoot(host);
});

afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  localStorage.clear();
});

describe("the model picker follows the view", () => {
  it.each([
    ["Ctrl+`", { key: "`", code: "Backquote", ctrlKey: true }],
    ["a bot hotkey", { key: "2", code: "Digit2", ctrlKey: true }],
  ])("is told to close on %s", async (_name, init) => {
    const closed = vi.fn();
    window.addEventListener("orbit:close-model-picker", closed);
    try {
      await act(async () => root.render(createElement(App)));
      await until(strip);
      closed.mockClear();
      await key(init);
      expect(closed).toHaveBeenCalledTimes(1);
    } finally {
      window.removeEventListener("orbit:close-model-picker", closed);
    }
  });
});

describe("the workers menu follows the view", () => {
  const openMenu = async () => {
    await act(async () => root.render(createElement(App)));
    await until(strip);
    await act(async () => strip()!.click());
    expect(menu()?.querySelector("h2")?.textContent).toBe("Scout's workers");
  };

  it("closes when Ctrl+` switches to the terminal", async () => {
    await openMenu();
    await key({ key: "`", code: "Backquote", ctrlKey: true });
    expect(document.querySelector(".orbit-terminal-overlay")?.getAttribute("data-open")).toBe("true");
    expect(menu()).toBeNull();
    await key({ key: "`", code: "Backquote", ctrlKey: true });
    expect(document.querySelector(".orbit-terminal-overlay")?.getAttribute("data-open")).toBe("false");
    expect(menu()).toBeNull();
  });

  it("closes when a hotkey switches to another bot", async () => {
    await openMenu();
    await key({ key: "2", code: "Digit2", ctrlKey: true });
    expect(menu()).toBeNull();
    await act(async () => strip()!.click());
    expect(menu()?.querySelector("h2")?.textContent).toBe("Pilot's workers");
  });
});

describe("phone Back with the workers list", () => {
  let entries: unknown[];
  let index: number;
  let pending: number[];

  beforeEach(() => {
    entries = [null];
    index = 0;
    pending = [];
    vi.spyOn(window, "matchMedia").mockImplementation((query) => ({
      matches: query.includes("max-width") || query.includes("prefers-reduced-motion"),
      addEventListener: vi.fn(), removeEventListener: vi.fn(),
    }) as unknown as MediaQueryList);
    vi.spyOn(window, "history", "get").mockReturnValue({
      get state() { return entries[index]; },
      pushState: (state: unknown) => {
        entries.splice(index + 1);
        entries.push(state);
        index++;
      },
      go: (delta: number) => pending.push(index + delta),
    } as unknown as History);
  });

  const settle = async () => {
    for (let tries = 0; pending.length && tries < 10; tries++) {
      index = pending.shift()!;
      expect(index).toBeGreaterThanOrEqual(0);
      await act(async () => window.dispatchEvent(new PopStateEvent("popstate", { state: entries[index] })));
    }
    expect(pending).toHaveLength(0);
  };
  const back = async () => {
    window.history.go(-1);
    await settle();
  };
  const selectPilot = async (view: ReactNode = createElement(App)) => {
    await act(async () => root.render(view));
    await until(strip);
    await key({ key: "2", code: "Digit2", ctrlKey: true });
    expect(document.querySelector("textarea[data-orbit-composer]")?.getAttribute("placeholder")).toBe("Message Pilot");
  };

  it("closes the list before returning to the previous bot", async () => {
    await selectPilot();
    await act(async () => strip()!.click());
    expect(menu()?.querySelector("h2")?.textContent).toBe("Pilot's workers");
    await back();
    expect(menu()).toBeNull();
    expect(document.querySelector("textarea[data-orbit-composer]")?.getAttribute("placeholder")).toBe("Message Pilot");
    await back();
    expect(document.querySelector("textarea[data-orbit-composer]")?.getAttribute("placeholder")).toBe("Message Scout");
    expect(index).toBe(0);
  });

  it.each(["chat", "group"])("ends text selection before leaving the %s on Back", async (view) => {
    const message = { id: "reply", at: 2, role: "bot", kind: "text", text: "hello there" };
    const snapshot = JSON.parse(localStorage.getItem(SNAPSHOT_CACHE_KEY)!);
    snapshot.bots[1].messages.push(message);
    snapshot.groups = [{
      id: "g1", threadId: "t-g1", name: "Team", memberIds: ["b1", "b2"],
      defaultResponder: { kind: "everyone" }, bulletin: "", unread: false, createdAt: 1,
      messages: [message],
    }];
    localStorage.setItem(SNAPSHOT_CACHE_KEY, JSON.stringify(snapshot));
    vi.spyOn(window, "matchMedia").mockImplementation((query) => ({
      matches: query === "(pointer: coarse)" || query.includes("max-width") || query.includes("prefers-reduced-motion"),
      addEventListener: vi.fn(), removeEventListener: vi.fn(),
    }) as unknown as MediaQueryList);
    if (view === "chat") await selectPilot();
    else {
      await act(async () => root.render(createElement(App)));
      await until(strip);
      await act(async () => document.querySelector<HTMLButtonElement>('[data-sidebar-row-kind="group"] button')!.click());
    }
    const composer = () => document.querySelector("textarea[data-orbit-composer]")?.getAttribute("placeholder");
    const placeholder = composer();
    const row = document.querySelector<HTMLElement>('[data-mid="reply"] [data-orbit-message]')!;
    const content = row.querySelector("[data-orbit-message-content]")!;
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      const start = new Event("touchstart", { bubbles: true, cancelable: true });
      Object.defineProperty(start, "touches", { value: [{ clientX: 100, clientY: 120 }] });
      await act(async () => content.dispatchEvent(start));
      await act(async () => vi.advanceTimersByTime(500));
      await act(async () => content.dispatchEvent(new Event("touchend", { bubbles: true, cancelable: true })));
      await act(async () => document.querySelector<HTMLButtonElement>("[data-menu-select]")!.click());
    } finally {
      vi.useRealTimers();
    }
    await settle();
    expect(row.hasAttribute("data-select-mode")).toBe(true);
    expect(window.getSelection()?.toString()).toBe("hello there");
    await back();
    expect(composer()).toBe(placeholder);
    expect(row.hasAttribute("data-select-mode")).toBe(false);
    expect(window.getSelection()?.toString()).toBe("");
    expect(index).toBe(1);
    for (let count = 0; count < 3; count++) {
      await act(async () => startSelectMode(row, { x: 0, y: 0 }));
      expect(index).toBe(2);
      await act(async () => document.body.dispatchEvent(new Event("touchstart", { bubbles: true })));
      await settle();
      expect(row.hasAttribute("data-select-mode")).toBe(false);
      expect(window.getSelection()?.toString()).toBe("");
      expect(index).toBe(1);
    }
    await back();
    expect(composer()).toBe("Message Scout");
    expect(index).toBe(0);
  });

  it.each(["X", "backdrop"])("drops the list entry after %s, including five repeated opens", async (dismiss) => {
    await selectPilot();
    for (let count = 0; count < 5; count++) {
      await act(async () => strip()!.click());
      expect(menu()).not.toBeNull();
      expect(index).toBe(2);
      await act(async () => {
        if (dismiss === "X") menu()!.querySelector<HTMLButtonElement>("button")!.click();
        else menu()!.parentElement!.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
      });
      await settle();
      expect(menu()).toBeNull();
      expect(index).toBe(1);
    }
    await back();
    expect(document.querySelector("textarea[data-orbit-composer]")?.getAttribute("placeholder")).toBe("Message Scout");
    expect(index).toBe(0);
  });

  it("closes a confirm above the list one visible layer at a time", async () => {
    await selectPilot(createElement(ConfirmOverApp));
    await act(async () => strip()!.click());
    await act(async () => document.querySelector<HTMLButtonElement>("[data-open-confirm]")!.click());
    expect(document.querySelectorAll('[role="dialog"]')).toHaveLength(2);
    await back();
    expect(document.querySelectorAll('[role="dialog"]')).toHaveLength(1);
    expect(menu()).not.toBeNull();
    expect(index).toBe(2);
    await back();
    expect(menu()).toBeNull();
    expect(index).toBe(1);
    await back();
    expect(index).toBe(0);
  });

  it("replaces the tapped worker list with its terminal without an extra Back", async () => {
    vi.stubGlobal("fetch", vi.fn((url: string) => {
      const id = url.match(/^\/api\/bots\/(b[12])\/terminal(?:\?panes=1)?$/)?.[1];
      return id ? Promise.resolve(new Response(JSON.stringify({ panes: [{
        sessionId: `${id.padEnd(8, "0")}-0000-4000-8000-000000000000`,
        label: `${id === "b1" ? "ONE" : "TWO"} | Opus 5.5 | high`,
      }] }), { headers: { "Content-Type": "application/json" } })) : new Promise<Response>(() => {});
    }));
    await selectPilot();
    await act(async () => strip()!.click());
    const entry = () => menu()?.querySelector<HTMLButtonElement>("li button") ?? null;
    await until(entry);
    expect(entry()).not.toBeNull();
    await act(async () => entry()!.click());
    await settle();
    expect(menu()).toBeNull();
    expect(document.querySelector(".orbit-terminal-overlay")?.getAttribute("data-open")).toBe("true");
    expect(index).toBe(2);
    await back();
    expect(document.querySelector(".orbit-terminal-overlay")?.getAttribute("data-open")).toBe("false");
    expect(document.querySelector("textarea[data-orbit-composer]")?.getAttribute("placeholder")).toBe("Message Pilot");
    await back();
    expect(document.querySelector("textarea[data-orbit-composer]")?.getAttribute("placeholder")).toBe("Message Scout");
    expect(index).toBe(0);
  });

  it("closes a group's list before leaving the group", async () => {
    const snapshot = JSON.parse(localStorage.getItem(SNAPSHOT_CACHE_KEY)!);
    snapshot.groups = [{
      id: "g1", threadId: "t-g1", name: "Team", memberIds: ["b1", "b2"],
      defaultResponder: { kind: "everyone" }, bulletin: "", unread: false, createdAt: 1,
      messages: [launch("b1", "GROUP | Opus 5.5 | high", "group-session")],
    }];
    localStorage.setItem(SNAPSHOT_CACHE_KEY, JSON.stringify(snapshot));
    await act(async () => root.render(createElement(App)));
    await until(strip);
    await act(async () => document.querySelector<HTMLButtonElement>('[data-sidebar-row-kind="group"] button')!.click());
    await until(strip);
    await act(async () => strip()!.click());
    expect(menu()?.querySelector("h2")?.textContent).toBe("Team's workers");
    await back();
    expect(menu()).toBeNull();
    await act(async () => strip()!.click());
    expect(menu()?.querySelector("h2")?.textContent).toBe("Team's workers");
    await back();
    await back();
    expect(document.querySelector("textarea[data-orbit-composer]")?.getAttribute("placeholder")).toBe("Message Scout");
    expect(index).toBe(0);
  });

  it("keeps browser Back navigation off in the desktop app", async () => {
    window.ogb = {} as NonNullable<typeof window.ogb>;
    try {
      await selectPilot();
      await act(async () => strip()!.click());
      expect(menu()).not.toBeNull();
      expect(index).toBe(0);
      await act(async () => window.dispatchEvent(new PopStateEvent("popstate", { state: null })));
      expect(menu()).not.toBeNull();
      expect(document.querySelector("textarea[data-orbit-composer]")?.getAttribute("placeholder")).toBe("Message Pilot");
    } finally {
      window.ogb = undefined;
    }
  });
});
