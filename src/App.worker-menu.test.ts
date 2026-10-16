// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import App from "./App";
import { SNAPSHOT_CACHE_KEY } from "@/state/snapshot-cache";

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
