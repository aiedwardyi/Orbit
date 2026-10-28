// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import { applyLocale } from "@/lib/i18n";

const { state, dispatch, api } = vi.hoisted(() => ({
  state: {
    appSettingsSection: "connections",
    bots: [],
    config: {
      imageGen: { configured: true },
      composio: { configured: false },
      gemini: { configured: false },
      box: { configured: false },
      vps: { configured: false, sshAlias: "" },
      rooms: { turnTimeoutMinutes: 5 },
      profile: { name: "", email: "" },
      localVm: { mode: "shared", maxInstances: 1 },
      features: {},
    },
  },
  dispatch: vi.fn(),
  api: vi.fn(async () => ({ uses: {} })),
}));

vi.mock("@/state/store", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/state/store")>()),
  useStore: () => ({ state, dispatch }),
  api,
}));
vi.mock("@/lib/friends-chrome", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/friends-chrome")>()),
  showSettingsAdvancedSection: () => true,
}));
vi.mock("./DesktopCapabilities", () => ({
  useDesktopCapabilities: () => ({ capabilities: { host: { platform: "win32" } }, ready: true }),
}));
vi.mock("./EnginesSettings", () => ({ EnginesSettings: () => null }));

import { SettingsModal } from "./SettingsModal";

it.each([
  ["connections", "Remove the Saved Key", "Remove the Saved Key"],
  ["general", "Delete VM", "Delete"],
  ["general", "Delete and Recreate", "Replace"],
])("keeps %s / %s confirmation focus above Settings", async (section, triggerLabel, confirmLabel) => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  applyLocale("en");
  state.appSettingsSection = section;
  const status = {
    runtime: "docker", daemonUp: true, image: true, imageMatches: false,
    managed: true, container: "stopped", network: "loopback", security: "hardened",
    persistence: "durable", ready: false, mode: "shared", commands: {},
  };
  vi.stubGlobal("fetch", vi.fn(async () => Response.json(status)));
  const host = document.body.appendChild(document.createElement("div"));
  const root = createRoot(host);
  const confirmation = () => document.querySelector('[role="dialog"][aria-describedby]');
  const button = (label: string) => [...confirmation()!.querySelectorAll("button")].find((node) => node.textContent === label)!;
  try {
    await act(async () => root.render(createElement(SettingsModal, { defaultAdvancedOpen: true })));
    const trigger = [...host.querySelectorAll("button")].find((node) =>
      node.getAttribute("aria-label") === triggerLabel || node.textContent?.trim() === triggerLabel,
    )!;
    trigger.focus();
    await act(async () => trigger.click());
    expect(document.activeElement).toBe(button("Cancel"));
    button(confirmLabel).focus();
    const tab = new KeyboardEvent("keydown", { key: "Tab", shiftKey: true, bubbles: true, cancelable: true });
    button(confirmLabel).dispatchEvent(tab);
    // happy-dom leaves native focus traversal to the browser; neither trap
    // should intercept the inner step from Confirm back to Cancel.
    expect(tab.defaultPrevented).toBe(false);
    expect(document.activeElement).toBe(button(confirmLabel));
    button("Cancel").focus();
    button("Cancel").dispatchEvent(new KeyboardEvent("keydown", { key: "Tab", shiftKey: true, bubbles: true }));
    expect(document.activeElement).toBe(button(confirmLabel));
    button(confirmLabel).dispatchEvent(new KeyboardEvent("keydown", { key: "Tab", bubbles: true }));
    expect(document.activeElement).toBe(button("Cancel"));
    dispatch.mockClear();
    await act(async () => button("Cancel").dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })));
    expect(confirmation()).toBeNull();
    expect(host.querySelector('[role="dialog"]')).not.toBeNull();
    expect(dispatch).not.toHaveBeenCalled();
    expect(document.activeElement).toBe(trigger);
  } finally {
    await act(async () => root.unmount());
    host.remove();
    vi.unstubAllGlobals();
  }
});

it("still traps focus and closes on Escape when focus escapes to the page", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  applyLocale("en");
  state.appSettingsSection = "connections";
  const host = document.body.appendChild(document.createElement("div"));
  const root = createRoot(host);
  try {
    await act(async () => root.render(createElement(SettingsModal, { defaultAdvancedOpen: true })));
    (document.activeElement as HTMLElement | null)?.blur();
    const tab = new KeyboardEvent("keydown", { key: "Tab", shiftKey: true, bubbles: true, cancelable: true });
    document.body.dispatchEvent(tab);
    expect(tab.defaultPrevented).toBe(true);
    expect(host.querySelector('[role="dialog"]')!.contains(document.activeElement)).toBe(true);
    (document.activeElement as HTMLElement | null)?.blur();
    dispatch.mockClear();
    document.body.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
    expect(dispatch).toHaveBeenCalledWith({ type: "toggleAppSettings", open: false });
  } finally {
    await act(async () => root.unmount());
    host.remove();
    vi.unstubAllGlobals();
  }
});
