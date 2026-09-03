import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeAll, describe, expect, it, vi } from "vitest";

import type { Bot } from "@/state/store";

const here = dirname(fileURLToPath(import.meta.url));
const chatView = readFileSync(join(here, "ChatView.tsx"), "utf8");
const computerPanel = readFileSync(join(here, "ComputerPanel.tsx"), "utf8");
const settingsPanel = readFileSync(join(here, "SettingsPanel.tsx"), "utf8");

function headerBlock(source: string, startMarker: string, endMarker: string): string {
  const start = source.indexOf(startMarker);
  const end = source.indexOf(endMarker, start);
  expect(start).toBeGreaterThan(-1);
  expect(end).toBeGreaterThan(start);
  return source.slice(start, end);
}

const chatHeader = headerBlock(chatView, "{/* Header */}", "{findOpen &&");
const computerHeader = headerBlock(computerPanel, "{/* Header */}", '{panelView === "browser" &&');

describe("QA 17 one Bot-details header entry", () => {
  it("does not render usage or working-folder chips in the ChatView header", () => {
    expect(chatHeader).not.toContain("<UsageChip");
    expect(chatHeader).not.toContain("<WorkingFolderChip");
    expect(chatView).not.toContain("function UsageChip");
    expect(chatView).not.toContain("function WorkingFolderChip");
  });

  it("keeps avatar and name as the ChatView header entry that opens Bot details", () => {
    expect(chatHeader).toContain('title={t("chat.openProfile"');
    expect(chatHeader).toContain('onActivate={() => dispatch({ type: "toggleSettings", open: true })}');
    expect(chatHeader).toMatch(/onClick=\{\(\) => dispatch\(\{ type: "toggleSettings", open: true \}\)\}/);
  });

  it("does not keep a Bot-settings gear on the ComputerPanel header", () => {
    expect(computerHeader).not.toContain('title="Bot settings"');
    expect(computerHeader).not.toContain("<Settings");
    expect(computerHeader).not.toMatch(/type:\s*"toggleSettings"/);
  });

  it("keeps Computer/Android/Browser tabs and the Computer panel close control", () => {
    expect(computerHeader).toContain('setPanelView("computer")');
    expect(computerHeader).toContain('setPanelView("android")');
    expect(computerHeader).toContain('setPanelView("browser")');
    expect(computerHeader).toContain('type: "toggleComputer"');
    expect(computerHeader).toContain("<X size={18} />");
  });

  it("keeps WorkingFolder and BotUsageCard on SettingsPanel", () => {
    expect(settingsPanel).toContain("<WorkingFolder bot={bot} />");
    expect(settingsPanel).toContain("{advancedOpen && <BotUsageCard bot={bot} />}");
  });
});

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

const botWithUsage = {
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
  tasks: [
    {
      threadId: "t1",
      title: "Task",
      createdAt: 0,
      cwd: "/tmp/friend",
      usage: { input: 10_000, output: 2_400, costUsd: 0.06, turns: 3 },
    },
  ],
} as Bot;

describe("SettingsPanel still owns folder and usage", () => {
  beforeAll(() => {
    if (typeof document === "undefined") {
      Object.defineProperty(globalThis, "document", {
        value: { documentElement: { lang: "en", dataset: {} } },
        configurable: true,
      });
    }
  });

  it("renders Working folder and Usage cards in Bot details", async () => {
    const { SettingsPanel } = await import("./SettingsPanel");
    const { I18nProvider } = await import("@/lib/i18n");
    const html = renderToStaticMarkup(
      createElement(
        I18nProvider,
        null,
        createElement(SettingsPanel, { bot: botWithUsage, defaultAdvancedOpen: true }),
      ),
    );
    expect(html).toContain("Working folder");
    expect(html).toContain("Where this bot runs its shell and file tools.");
    expect(html).toContain("Usage");
    expect(html).toContain("All bots");
  });
});
