// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import App from "@/App";
import { SNAPSHOT_CACHE_KEY } from "@/state/snapshot-cache";
import { PRESENCE_EXIT_MS } from "@/lib/use-presence";

let host: HTMLDivElement;
let root: Root;
let phone: boolean;
const changes = new Set<() => void>();
const dialog = () => document.querySelector('[aria-labelledby="app-settings-title"]');
const button = (label: string) => dialog()?.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`);
const wait = (ms = 20) => act(() => new Promise<void>((done) => setTimeout(done, ms)));

async function until(found: () => unknown) {
  for (let tries = 0; tries < 100 && !found(); tries++) await wait();
  expect(found()).toBeTruthy();
}

async function open(locale = "en") {
  localStorage.setItem("omb-locale", locale);
  await act(async () => root.render(createElement(App)));
  const label = locale === "ko" ? "앱 설정" : "App settings";
  await act(async () => host.querySelector<HTMLButtonElement>(`[data-sidebar-profile-row] button[aria-label="${label}"]`)!.click());
  await until(dialog);
}

async function tap(label: string) {
  const row = [...dialog()!.querySelectorAll("button")].find((node) => node.textContent === label)!;
  expect(row).toBeDefined();
  await act(async () => row.click());
}

async function escape() {
  await act(async () => window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true })));
}

beforeEach(() => {
  phone = true;
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("fetch", vi.fn(() => new Promise<Response>(() => {})));
  vi.stubGlobal("EventSource", class { onmessage = null; close() {} });
  vi.spyOn(window, "matchMedia").mockImplementation((query) => ({
    matches: phone && query.includes("max-width"), media: query, onchange: null,
    addListener() {}, removeListener() {}, dispatchEvent: () => true,
    addEventListener: (_: string, flip: EventListenerOrEventListenerObject) => { changes.add(flip as () => void); },
    removeEventListener: (_: string, flip: EventListenerOrEventListenerObject) => { changes.delete(flip as () => void); },
  }));
  localStorage.setItem("omb-onboarding-done", "true");
  localStorage.setItem(SNAPSHOT_CACHE_KEY, JSON.stringify({
    bots: [{ id: "b1", threadId: "t1", name: "Scout", messages: [], modelSelection: { instanceId: "inst", model: "m" } }],
    groups: [], selectedId: "b1",
  }));
  host = document.body.appendChild(document.createElement("div"));
  root = createRoot(host);
});

afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  localStorage.clear();
  changes.clear();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("phone Settings navigation", () => {
  it.each([
    ["en", ["Account", "General", "Connections", "Themes", "Usage", "Model Index"]],
    ["ko", ["계정", "일반", "연결", "테마", "사용량", "모델 지표"]],
  ])("opens the labeled list in %s without mounting a page or Shortcuts", async (locale, labels) => {
    await open(locale);
    const rows = [...dialog()!.querySelectorAll("nav button")].filter((node) => node.querySelector(".lucide-chevron-right"));
    expect(rows.map((node) => node.textContent)).toEqual(labels);
    expect(rows.every((node) => node.querySelector(".lucide-chevron-right"))).toBe(true);
    expect(dialog()!.querySelector('[role="radiogroup"]')).toBeNull();
  });

  it("pushes a page and pops with the button before Escape closes Settings", async () => {
    await open();
    await tap("General");
    expect(dialog()!.querySelector('[aria-label="Bot List Side"]')).not.toBeNull();
    expect(button("Back")?.textContent).toBe("Settings");
    await act(async () => button("Back")!.click());
    expect(button("Back")).toBeNull();
    expect(dialog()!.querySelector("nav")?.textContent).toContain("Connections");
    await escape();
    expect(dialog()?.parentElement?.hasAttribute("data-closing")).toBe(true);
  });

  it("pops the page on Escape and closes on the next Escape", async () => {
    await open();
    await tap("General");
    await escape();
    expect(dialog()?.parentElement?.hasAttribute("data-closing")).toBe(false);
    expect(button("Back")).toBeNull();
    await escape();
    await wait(PRESENCE_EXIT_MS + 40);
    expect(dialog()).toBeNull();
  });

  it("pops the page on phone Back and closes on the next Back", async () => {
    await open();
    await tap("General");
    const depth = window.history.state.depth;
    await act(async () => window.dispatchEvent(new PopStateEvent("popstate", { state: { depth: depth - 1 } })));
    expect(button("Back")).toBeNull();
    expect(dialog()?.parentElement?.hasAttribute("data-closing")).toBe(false);
    await act(async () => window.dispatchEvent(new PopStateEvent("popstate", { state: { depth: depth - 2 } })));
    expect(dialog()?.parentElement?.hasAttribute("data-closing")).toBe(true);
  });

  it("opens a Usage deep link directly and returns to the list", async () => {
    await act(async () => root.render(createElement(App)));
    await act(async () => window.dispatchEvent(new KeyboardEvent("keydown", { key: "u", code: "KeyU", altKey: true })));
    await until(() => button("Back"));
    expect(dialog()!.querySelector("#app-settings-title")?.textContent).toBe("Usage");
    await act(async () => button("Back")!.click());
    expect(dialog()!.querySelector("nav")?.textContent).toContain("Account");
  });

  it("uses the existing Korean Back label", async () => {
    await open("ko");
    await tap("일반");
    expect(button("뒤로")?.textContent).toBe("설정");
    await act(async () => button("뒤로")!.click());
    expect(dialog()!.querySelector("nav")?.textContent).toContain("계정");
  });

  it("keeps desktop navigation and opens General from the gear", async () => {
    phone = false;
    await open();
    expect([...dialog()!.querySelectorAll("nav button")].map((node) => node.getAttribute("aria-label"))).toEqual([
      "Account", "General", "Connections", "Phone", "Themes", "Usage", "Model Index", "Shortcuts",
    ]);
    expect(button("General")?.getAttribute("aria-current")).toBe("page");
    expect(button("Back")).toBeNull();
    expect(dialog()!.querySelector('[aria-label="Bot List Side"]')).not.toBeNull();
    await escape();
    expect(dialog()?.parentElement?.hasAttribute("data-closing")).toBe(true);
  });

  it("shows the list when desktop Shortcuts narrows to phone", async () => {
    phone = false;
    await open();
    await act(async () => button("Shortcuts")!.click());
    phone = true;
    await act(async () => changes.forEach((flip) => flip()));
    expect(button("Back")).toBeNull();
    expect(dialog()!.querySelector("nav")?.textContent).toContain("Account");
  });
});
