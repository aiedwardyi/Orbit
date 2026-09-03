import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeAll, describe, expect, it, vi } from "vitest";

import type { Bot } from "@/state/store";

vi.hoisted(() => {
  Object.defineProperty(globalThis, "window", {
    value: { ogb: undefined },
    configurable: true,
    writable: true,
  });
  if (typeof document === "undefined") {
    Object.defineProperty(globalThis, "document", {
      value: { visibilityState: "visible", documentElement: { lang: "en", dataset: {} } },
      configurable: true,
    });
  }
});

vi.mock("@/state/store", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/state/store")>();
  return {
    ...actual,
    useStore: () => ({
      state: {
        instances: [
          {
            instanceId: "grok",
            driverKind: "grokAgent",
            displayName: "Grok",
            snapshot: { state: "available", authenticated: true, version: "1.0.13" },
            models: { default: "grok-4.6", options: [{ id: "grok-4.6", label: "Grok 4.6" }] },
            capabilities: { computerMcp: true, localComputerMcp: true },
          },
        ],
        bots: [],
        config: { box: { configured: false } },
        routines: [],
        routineRuns: [],
        screens: {},
        computerControl: {},
        mascotMotion: null,
      },
      dispatch: () => undefined,
      refreshInstances: async () => undefined,
    }),
  };
});

vi.mock("./DesktopCapabilities", () => ({
  useDesktopCapabilities: () => ({
    capabilities: {
      host: { platform: "win32", homeDir: undefined },
      toasts: { available: false },
      localComputer: { available: false, support: "unsupported" },
      screenPreview: { available: false },
    },
    ready: true,
  }),
}));

vi.mock("./LocalScreenPreview", () => ({
  LocalScreenPreview: () => createElement("div", { "data-computer-host": "preview" }, "Preview this computer"),
}));

vi.mock("./LinuxLocalControl", () => ({
  LinuxLocalControl: () => createElement("div", { "data-computer-host": "linux" }, "Local control"),
}));

vi.mock("./MacLocalControl", () => ({
  MacLocalControl: () => createElement("div", { "data-computer-host": "mac" }, "Allow control of this computer"),
}));

vi.mock("./LocalComputerAutoWarning", () => ({
  LocalComputerAutoWarning: () => null,
}));

vi.mock("./RoutineEditor", () => ({
  RoutineEditor: () => null,
}));

vi.mock("./AndroidDevicePanel", () => ({
  AndroidDevicePanel: () => null,
  useAndroidUsbDevices: () => ({ devices: [] }),
}));

vi.mock("./BrowserPanel", () => ({
  BrowserPanel: () => null,
}));

import { ComputerPanel } from "./ComputerPanel";

const bot = {
  id: "bot-1",
  threadId: "t1",
  name: "Friend",
  title: "",
  description: "",
  notifications: false,
  color: "green",
  unread: false,
  computer: "off",
  modelSelection: { instanceId: "grok", model: "grok-4.6", mode: "automatic" },
  messages: [],
} as Bot;

function markup(
  patch: Partial<Bot> = {},
  defaultAdvancedOpen = false,
) {
  return renderToStaticMarkup(
    createElement(ComputerPanel, {
      bot: { ...bot, ...patch },
      defaultAdvancedOpen,
    }),
  );
}

describe("ComputerPanel friends chrome", () => {
  beforeAll(() => {
    if (typeof document === "undefined") {
      Object.defineProperty(globalThis, "document", {
        value: { visibilityState: "visible", documentElement: { lang: "en", dataset: {} } },
        configurable: true,
      });
    }
  });

  it("keeps preview plus Off and This computer while the idle panel is closed", () => {
    const html = markup();
    expect(html).toContain("data-computer-friends-destination");
    expect(html).toContain("Off");
    expect(html).toContain("This computer");
    expect(html).toContain("This bot");
    expect(html).toContain("computer is off");
    expect(html).not.toContain("Scheduled tasks");
    expect(html).not.toContain("Pick where this bot");
    expect(html).not.toContain("computer lives");
    expect(html).not.toContain("Cua-controlled");
    expect(html).not.toContain("Cloud backend");
    expect(html).not.toContain("Start VPS automatically");
    expect(html).not.toContain("Local VM");
    expect(html).not.toContain("Add a Box API key");
    expect(html).not.toContain("Delete this bot's VM");
    expect(html).not.toContain("Open two desktops");
    expect(html).not.toContain("data-computer-advanced");
    expect(html).not.toContain("data-computer-host");
    expect(html).not.toContain(">Sleep<");
    expect(html).not.toMatch(/>Cloud</);
  });

  it("reveals Cloud, backend, Box, and schedules when the user asks", () => {
    const html = markup({ computer: undefined }, true);
    expect(html).toContain("data-computer-advanced");
    expect(html).toContain("data-computer-friends-destination");
    expect(html).toContain("Pick where this bot");
    expect(html).toContain("computer lives");
    expect(html).toContain("Cua-controlled");
    expect(html).toContain("Cloud backend");
    expect(html).toContain("Local VM");
    expect(html).toContain("This computer");
    expect(html).toContain("Scheduled tasks");
    expect(html).toContain("data-computer-host");
  });

  it("keeps host local-control cards visible when this computer is the destination", () => {
    const html = markup({ computer: "local" });
    expect(html).toContain("data-computer-host");
    expect(html).not.toContain("Pick where this bot");
    expect(html).not.toContain("computer lives");
    expect(html).not.toContain("Cloud backend");
  });

  it("keeps Cloud, Box, backend, and schedules inside the folded advanced body", () => {
    const source = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "ComputerPanel.tsx"), "utf8");
    const marker = "data-computer-advanced";
    const start = source.indexOf(marker);
    expect(start).toBeGreaterThan(-1);
    const advanced = source.slice(start);
    expect(advanced).toContain("Sleep");
    expect(advanced).toContain("Delete this bot's VM");
    expect(advanced).toContain("Open two desktops");
    expect(advanced).toContain("Scheduled tasks");
    expect(advanced).toContain("<ApiKeyRow");
    expect(advanced).toContain("<CloudBackendPicker");
    const before = source.slice(0, start);
    expect(before).not.toContain("Put the computer to sleep");
    expect(before).not.toContain("Delete this bot's VM");
    expect(before).not.toContain("Open two desktops");
    expect(before).not.toContain(">Sleep<");
    expect(before).not.toContain("Scheduled tasks");
    expect(before).not.toContain("<ApiKeyRow");
    expect(before).not.toContain("<CloudBackendPicker");
  });
});
