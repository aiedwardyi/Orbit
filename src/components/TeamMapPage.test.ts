// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import { applyLocale } from "@/lib/i18n";

const { api, dispatch, state } = vi.hoisted(() => ({
  api: vi.fn(), dispatch: vi.fn(),
  state: { bots: [{ id: "b1", name: "Ada", title: "Research", section: "Research" }] },
}));
vi.mock("@/state/store", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/state/store")>()),
  api, useStore: () => ({ state, dispatch }),
}));
vi.mock("./Avatar", () => ({ BotAvatar: () => null }));

import { TeamMapPage } from "./TeamMapPage";

it("keeps unsaved context after Cancel or Escape and discards only on confirmation", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  applyLocale("en");
  api.mockImplementation(async (path: string) => path === "/api/team-map"
    ? { collaborations: [], queued: [], running: [] }
    : { text: "Saved context", maxBytes: 24000, updatedAt: null });
  const host = document.body.appendChild(document.createElement("div"));
  const root = createRoot(host);
  const confirmation = () => document.querySelector('[role="dialog"][aria-describedby]');
  const button = (text: string) => [...confirmation()!.querySelectorAll("button")].find((node) => node.textContent === text)!;
  try {
    await act(async () => root.render(createElement(TeamMapPage)));
    await act(async () => host.querySelector<HTMLButtonElement>('button[title="Shared context"]')!.click());
    const textarea = document.querySelector("textarea")!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(textarea, "Unsaved context");
      textarea.dispatchEvent(new Event("input", { bubbles: true }));
    });
    api.mockClear();
    const close = document.querySelector<HTMLButtonElement>('button[aria-label="Close shared context"]')!;
    close.focus();
    await act(async () => close.click());
    expect(confirmation()?.textContent).toContain("Discard unsaved changes to this shared context?");
    expect(document.activeElement).toBe(button("Cancel"));
    await act(async () => button("Cancel").click());
    expect(textarea.value).toBe("Unsaved context");
    expect(document.activeElement).toBe(close);
    await act(async () => close.click());
    await act(async () => button("Cancel").dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })));
    expect(confirmation()).toBeNull();
    expect(document.querySelector("textarea")).toBe(textarea);
    expect(api).not.toHaveBeenCalled();
    await act(async () => close.click());
    await act(async () => button("Discard").click());
    expect(document.querySelector('[role="dialog"]')).toBeNull();
    expect(api).not.toHaveBeenCalled();
  } finally {
    await act(async () => root.unmount());
    host.remove();
    vi.unstubAllGlobals();
  }
});
