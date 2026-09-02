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
            capabilities: { effortLevels: ["low", "medium", "high"] },
          },
        ],
        bots: [],
        config: {},
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
      host: { platform: "other", homeDir: undefined },
      toasts: { available: false },
      localComputer: { available: false, support: "unsupported" },
    },
    ready: true,
  }),
}));

vi.mock("./VoiceSettings", () => ({
  VoiceSettings: () => null,
}));

vi.mock("./BotProfileAvatarCard", () => ({
  BotProfileAvatarCard: () => null,
}));

vi.mock("./LocalComputerAutoWarning", () => ({
  LocalComputerAutoWarning: () => null,
}));

vi.mock("./CloudBackendPicker", () => ({
  CloudBackendPicker: () => null,
}));

const bot = {
  id: "bot-1",
  threadId: "t1",
  name: "Friend",
  title: "",
  description: "",
  notifications: false,
  color: "green",
  unread: false,
  modelSelection: { instanceId: "grok", model: "grok-4.6", mode: "automatic" },
  messages: [],
} as Bot;

describe("SettingsPanel friends effort", () => {
  beforeAll(() => {
    if (typeof document === "undefined") {
      Object.defineProperty(globalThis, "document", {
        value: { documentElement: { lang: "en", dataset: {} } },
        configurable: true,
      });
    }
  });

  it("does not bury a blank Effort control under Advanced", async () => {
    const { SettingsPanel } = await import("./SettingsPanel");
    const { I18nProvider } = await import("@/lib/i18n");
    const html = renderToStaticMarkup(
      createElement(I18nProvider, null, createElement(SettingsPanel, { bot, defaultAdvancedOpen: true })),
    );
    expect(html).toContain("Advanced");
    expect(html).toContain("Computer, coordination, browser, approvals, voice, and usage");
    expect(html).not.toContain("How hard this bot thinks");
    expect(html).not.toMatch(/>Effort</);
    expect(html).not.toContain("Effort, computer");
  });
});
