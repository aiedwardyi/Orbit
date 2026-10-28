// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import { applyLocale } from "@/lib/i18n";
import type { Bot } from "@/state/store";

const { dispatch } = vi.hoisted(() => ({ dispatch: vi.fn() }));
vi.mock("@/state/store", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/state/store")>()),
  useStore: () => ({
    state: {
      instances: [{ instanceId: "grok", driverKind: "grokAgent", snapshot: { state: "available" }, capabilities: { computerMcp: true } }],
      config: { box: { configured: false } },
      routines: [], routineRuns: [], screens: {}, computerControl: {},
    },
    dispatch,
  }),
}));
vi.mock("./DesktopCapabilities", () => ({
  useDesktopCapabilities: () => ({
    capabilities: { host: { platform: "win32" }, localComputer: { available: false }, screenPreview: { available: false } },
    ready: true,
  }),
}));
vi.mock("./RoutinesPage", () => ({ RoutineEditor: () => null }));
vi.mock("./AndroidDevicePanel", () => ({ AndroidDevicePanel: () => null, useAndroidUsbDevices: () => ({ devices: [] }) }));
vi.mock("./BrowserPanel", () => ({ BrowserPanel: () => null }));
vi.mock("./LocalScreenPreview", () => ({ LocalScreenPreview: () => null }));

import { ComputerPanel } from "./ComputerPanel";

it.each([
  ["vm-delete", "Delete this bot's VM", "Delete"],
  ["vm-recreate", "Replace {name}'s VM", "Replace"],
  ["vps-replace", "Replace VPS computer", "Replace"],
])("dismisses %s when switching bots and requires a new confirmation", async (action, triggerLabel, confirmLabel) => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  applyLocale("en");
  const status = {
    mode: "per-bot", image: true, create_supported: true, configured: true,
    managed: true, container: "stopped", imageMatches: false, ready: action === "vm-delete",
  };
  const fetch = vi.fn(async (_path: string, _options?: RequestInit) => Response.json(status));
  vi.stubGlobal("fetch", fetch);
  const bot: Bot = {
    id: "bot-1", name: "Ada", threadId: "t1", color: "green", messages: [],
    title: "", description: "", notifications: false, unread: false,
    computer: action === "vps-replace" ? "cloud" : "vm", cloudBackend: "vps",
    modelSelection: { instanceId: "grok", model: "grok-4.6" },
  };
  const host = document.body.appendChild(document.createElement("div"));
  const root = createRoot(host);
  const render = (target: Bot) => act(async () => root.render(createElement(ComputerPanel, { bot: target, defaultAdvancedOpen: true })));
  const trigger = (name = "Ada") => [...host.querySelectorAll("button")].find((node) => node.textContent?.trim() === triggerLabel.replace("{name}", name))!;
  const dialog = () => document.querySelector('[role="dialog"]');
  try {
    await render(bot);
    await act(async () => trigger().click());
    expect(dialog()?.textContent).toContain("Ada");
    await render({ ...bot, name: "Ada renamed" });
    expect(dialog()).not.toBeNull();
    fetch.mockClear();
    const nextBot = { ...bot, id: "bot-2", name: "Bo" };
    await render(nextBot);
    expect(dialog()).toBeNull();
    expect(fetch.mock.calls.filter(([path, options]) => path.endsWith("/remove") && options?.method === "POST")).toHaveLength(0);

    await act(async () => trigger("Bo").click());
    expect(dialog()?.textContent).toContain("Bo");
    await act(async () => [...dialog()!.querySelectorAll("button")].find((node) => node.textContent === confirmLabel)!.click());
    const removals = fetch.mock.calls.filter(([path, options]) => path.endsWith("/remove") && options?.method === "POST");
    expect(removals.map(([path]) => path)).toEqual([`/api/bots/bot-2/${action === "vps-replace" ? "computer" : "local-computer"}/remove`]);
    expect(dialog()).toBeNull();
  } finally {
    await act(async () => root.unmount());
    host.remove();
    vi.unstubAllGlobals();
  }
});
