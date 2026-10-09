// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import App from "./App";
import { GroupWizard } from "@/components/GroupWizard";
import { RoutineEditor } from "@/components/RoutinesPage";
import { I18nProvider } from "@/lib/i18n";
import { SNAPSHOT_CACHE_KEY } from "@/state/snapshot-cache";
import { StoreProvider, type Bot } from "@/state/store";

let host: HTMLDivElement;
let root: Root;

const wait = (ms: number) => act(() => new Promise<void>((done) => setTimeout(done, ms)));
async function until<T extends Element>(found: () => T | null) {
  for (let tries = 0; tries < 100 && !found(); tries++) await wait(20);
  return found();
}
const input = (selector: string) => document.querySelector<HTMLInputElement>(selector);
// Chrome blurs focus inside a subtree that turns inert; happy-dom does not.
function blurInert() {
  if (document.activeElement instanceof HTMLElement) document.activeElement.blur();
}
function type(field: HTMLInputElement, value: string) {
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set?.call(field, value);
  field.dispatchEvent(new Event("input", { bubbles: true }));
}
const key = (init: KeyboardEventInit) => act(async () => window.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, ...init })));
const contextmenu = (row: Element) =>
  act(async () => (row.querySelector('[role="button"]') ?? row.querySelector("button") ?? row).dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: 40, clientY: 40 })));
const clickText = (scope: string, text: string) =>
  act(async () => [...document.querySelectorAll<HTMLButtonElement>(`${scope} button`)].find((button) => button.textContent?.includes(text))!.click());

beforeEach(() => {
  localStorage.setItem("omb-onboarding-done", "true");
  localStorage.setItem(SNAPSHOT_CACHE_KEY, JSON.stringify({
    bots: [{ id: "b1", threadId: "t1", name: "Scout", messages: [], modelSelection: { instanceId: "inst", model: "m" } }],
    groups: [{ id: "g1", threadId: "gt1", name: "Crew", memberIds: ["b1"], defaultResponder: "all", bulletin: "", unread: false, createdAt: 1, messages: [] }],
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

describe("a surface reopened during its fade takes focus again", () => {
  it("focuses the palette search and takes typing after Ctrl+K twice inside the fade", async () => {
    await act(async () => root.render(createElement(App)));
    const search = () => input('input[placeholder^="Search bots"]');
    // the palette is a lazy chunk; Ctrl+K does nothing until it has loaded
    for (let tries = 0; tries < 100 && !search(); tries++) {
      await key({ key: "k", ctrlKey: true });
      await wait(20);
    }
    expect(document.activeElement).toBe(search());

    await key({ key: "k", ctrlKey: true });
    expect(search()?.closest("[data-closing]")).not.toBeNull();
    blurInert();
    await key({ key: "k", ctrlKey: true });
    expect(search()?.closest("[data-closing]")).toBeNull();
    expect(document.activeElement).toBe(search());
    await act(async () => type(search()!, "Scout"));
    expect(search()?.value).toBe("Scout");
  });

  it("focuses the new section field when the section picker reopens inside its fade", async () => {
    await act(async () => root.render(createElement(App)));
    const field = () => input('[data-section-picker] input[aria-label="New section name"]');
    const row = (await until(() => document.querySelector('[data-sidebar-row-kind="bot"]')))!;
    await contextmenu(row);
    await clickText("[data-bot-menu]", "Move to section");
    expect(document.activeElement).toBe(await until(field));

    await key({ key: "Escape" });
    expect(field()?.closest("[data-closing]")).not.toBeNull();
    blurInert();
    await contextmenu(row);
    await clickText("[data-bot-menu]:not([data-closing])", "Move to section");
    expect(field()?.closest("[data-closing]")).toBeNull();
    expect(document.activeElement).toBe(field());
  });

  it("focuses the group rename field when its menu reopens inside the fade", async () => {
    await act(async () => root.render(createElement(App)));
    const field = () => input('[data-room-menu] input[aria-label="Rename Crew"]');
    const row = (await until(() => document.querySelector('[data-sidebar-row-kind="group"]')))!;
    await contextmenu(row);
    await clickText("[data-room-menu]", "Rename Crew");
    expect(document.activeElement).toBe(await until(field));

    await act(async () => field()!.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })));
    expect(field()?.closest("[data-closing]")).not.toBeNull();
    blurInert();
    await contextmenu(row);
    expect(field()?.closest("[data-closing]")).toBeNull();
    expect(document.activeElement).toBe(field());
  });

  it("focuses the group wizard name field again when it reopens", async () => {
    const render = (closing: boolean) =>
      act(async () => root.render(createElement(I18nProvider, null, createElement(StoreProvider, null, createElement(GroupWizard, { closing, onClose: () => {} })))));
    const field = () => input('[aria-labelledby="group-wizard-title"] input');
    await render(false);
    expect(document.activeElement).toBe(field());
    await render(true);
    blurInert();
    await render(false);
    expect(document.activeElement).toBe(field());
  });

  it("focuses the routine name field again when the editor reopens", async () => {
    // SAFETY: the editor reads only id and name from the bot list.
    const bots = [{ id: "b1", name: "Scout" }] as Bot[];
    const render = (closing: boolean) =>
      act(async () => root.render(createElement(StoreProvider, null, createElement(RoutineEditor, { bots, closing, onClose: () => {} }))));
    const field = () => input('input[placeholder="Morning research brief"]');
    await render(false);
    expect(document.activeElement).toBe(field());
    await render(true);
    blurInert();
    await render(false);
    expect(document.activeElement).toBe(field());
  });
});
