// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import App from "./App";
import { PRESENCE_EXIT_MS } from "@/lib/use-presence";
import { SNAPSHOT_CACHE_KEY } from "@/state/snapshot-cache";

let host: HTMLDivElement;
let root: Root;

const wait = (ms: number) => act(() => new Promise<void>((done) => setTimeout(done, ms)));
// the surfaces are lazy chunks
async function until(found: () => Element | null) {
  for (let tries = 0; tries < 100 && !found(); tries++) await wait(20);
  return found();
}
const button = (label: string) => host.ownerDocument.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`);
const settingsDialog = () => document.querySelector('[aria-labelledby="app-settings-title"]');
const detailsPanel = () => document.querySelector("[data-settings-panel]");

beforeEach(async () => {
  localStorage.setItem("omb-onboarding-done", "true");
  localStorage.setItem(SNAPSHOT_CACHE_KEY, JSON.stringify({
    bots: [
      { id: "b1", threadId: "t1", name: "Scout", messages: [], modelSelection: { instanceId: "inst", model: "m" } },
      { id: "b2", threadId: "t2", name: "Sage", messages: [], modelSelection: { instanceId: "inst", model: "m" } },
    ],
    groups: [],
    selectedId: "b1",
  }));
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("fetch", vi.fn(() => new Promise<Response>(() => {})));
  vi.stubGlobal("EventSource", class { onmessage = null; close = vi.fn(); });
  host = document.body.appendChild(document.createElement("div"));
  root = createRoot(host);
  await act(async () => root.render(createElement(App)));
});

afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  vi.unstubAllGlobals();
  localStorage.clear();
});

describe("Settings fade", () => {
  it("shows details at the end state when an open panel switches bots", async () => {
    await act(async () => button("Open Scout's profile")!.click());
    expect((await until(detailsPanel))?.classList.contains("animate-panel-in")).toBe(true);
    await act(async () => host.querySelector<HTMLElement>('[data-sidebar-row-id="b2"] [role="button"]')!.click());
    expect(host.querySelector<HTMLInputElement>("[data-settings-panel] label input")?.value).toBe("Sage");
    expect(detailsPanel()?.classList.contains("animate-panel-in")).toBe(false);
    // happy-dom rejects a canceled animation, so the sidebar's width motion ends before unmount
    await wait(340);
  });

  it("keeps app Settings mounted and inert while it fades out, then unmounts", async () => {
    const opener = host.querySelector<HTMLButtonElement>('[data-sidebar-profile-row] button[aria-label="App settings"]')!;
    opener.focus();
    await act(async () => opener.click());
    expect((await until(settingsDialog))?.getAttribute("role")).toBe("dialog");

    await act(async () => button("Close Settings")!.click());
    const backdrop = settingsDialog()?.parentElement;
    expect(backdrop?.hasAttribute("data-closing")).toBe(true);
    expect(backdrop?.hasAttribute("inert")).toBe(true);
    expect(settingsDialog()?.hasAttribute("role")).toBe(false);
    expect(document.activeElement).toBe(opener);

    await wait(PRESENCE_EXIT_MS + 40);
    expect(settingsDialog()).toBeNull();
  });

  it("keeps phone bot details mounted and inert while it fades out, then unmounts", async () => {
    vi.stubGlobal("innerWidth", 390);
    await act(async () => window.dispatchEvent(new Event("resize")));
    await act(async () => button("Open Scout's profile")!.click());
    expect((await until(detailsPanel))?.hasAttribute("data-closing")).toBe(false);

    await act(async () => button("Close Bot Details")!.click());
    expect(detailsPanel()?.hasAttribute("data-closing")).toBe(true);
    expect(detailsPanel()?.hasAttribute("inert")).toBe(true);

    await wait(PRESENCE_EXIT_MS + 40);
    expect(detailsPanel()).toBeNull();
  });
});
