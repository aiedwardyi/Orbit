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

  it("does not bury a blank Effort control — Advanced stays off the idle surface", async () => {
    const { SettingsPanel } = await import("./SettingsPanel");
    const { I18nProvider } = await import("@/lib/i18n");
    const html = renderToStaticMarkup(
      createElement(I18nProvider, null, createElement(SettingsPanel, { bot, defaultAdvancedOpen: true })),
    );
    expect(html).not.toContain("Advanced");
    expect(html).not.toContain("Computer, coordination, browser, approvals, voice, and usage");
    expect(html).not.toContain("How hard this bot thinks");
    expect(html).not.toMatch(/>Effort</);
    expect(html).not.toContain("Effort, computer");
  });

  it("keeps Chief of Staff switchable in source when Advanced is re-enabled", async () => {
    const { readFileSync } = await import("node:fs");
    const { dirname, join } = await import("node:path");
    const { fileURLToPath } = await import("node:url");
    const source = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "SettingsPanel.tsx"), "utf8");
    const start = source.indexOf('aria-label="Chief of Staff"');
    expect(start).toBeGreaterThan(-1);
    const button = source.slice(start, start + 500);
    expect(button).not.toContain("disabled");
    expect(source).toContain('t("chrome.cannotContactTeammates")');
    expect(source).not.toContain("Choose a Claude or ACP engine");
  });

  it("keeps peer comms switchable in source when Advanced is re-enabled", async () => {
    const { readFileSync } = await import("node:fs");
    const { dirname, join } = await import("node:path");
    const { fileURLToPath } = await import("node:url");
    const source = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "SettingsPanel.tsx"), "utf8");
    const start = source.indexOf('aria-label="Ask me before contacting other bots"');
    expect(start).toBeGreaterThan(-1);
    const button = source.slice(start, start + 500);
    expect(button).not.toContain("disabled");
    expect(source).not.toContain("This engine cannot contact other bots");
  });
});
