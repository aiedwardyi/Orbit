import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeAll, describe, expect, it, vi } from "vitest";

import type { Bot } from "@/state/store";
import type { AcceptedSends } from "@/lib/send-accept";
import { currentTurnId } from "@/lib/turn-stage";

const acceptedSends: AcceptedSends = {};

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

  it("keeps the Chief of Staff name when the badge folds to the crown", () => {
    expect(chatHeader).toContain('aria-label={t("chrome.chiefOfStaff")}');
    expect(chatHeader).toContain("@max-xs/chathead:sr-only");
    expect(chatHeader).not.toContain("@max-xs/chathead:hidden");
  });

  it("hides Computer and new-task chrome from the ChatView header", () => {
    expect(chatHeader).toContain("showComputerPanelChrome()");
    expect(chatHeader).toContain("showBotNewTaskControl()");
    expect(chatHeader).toContain("<TaskPicker");
    expect(chatHeader).toContain('type: "toggleComputer"');
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
        ...actual.initialState,
        acceptedSends,
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
    useStreaming: () => ({
      streaming: { t1: "A reply still streaming" }, reasoning: {}, signal: {},
      turn: { t1: currentTurnId({}, "t1", "u1") },
    }),
  };
});

vi.mock("./DesktopCapabilities", () => ({
  useDesktopCapabilities: () => ({
    capabilities: {
      host: { platform: "other", homeDir: undefined },
      toasts: { available: false },
      dictation: { available: false },
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

describe("ChatView mid-turn sends", () => {
  it("keeps the live reply staged and gives placeholders no transcript controls", async () => {
    const { ChatView } = await import("./ChatView");
    // u0 is an edited-away version of u1, so u1 carries the branch switcher
    const bot: Bot = {
      ...botWithUsage, busy: true, activeLeafId: "u1",
      messages: [
        { id: "u0", role: "user", kind: "text", text: "Earlier prompt", at: 0 },
        { id: "u1", role: "user", kind: "text", text: "First prompt", at: 1 },
      ],
    };
    expect(renderToStaticMarkup(createElement(ChatView, { bot }))).toContain("Responding");
    acceptedSends.t1 = [{ sendId: "s1", kind: "sends-next", text: "Follow-up", at: 42 }];
    try {
      const pending = renderToStaticMarkup(createElement(ChatView, { bot }));
      expect(pending).toContain("Follow-up");
      expect(pending).toContain("Responding");
      expect(pending).not.toContain("A reply still streaming");
      expect(pending.match(/data-message-hover-actions/g)).toHaveLength(1);
      expect(pending.match(/class="tabular-nums"/g)).toHaveLength(1);
      const confirmed = renderToStaticMarkup(createElement(ChatView, {
        bot: { ...bot, activeLeafId: "u2", messages: [...bot.messages, { id: "u2", sendId: "s1", parentId: "u1", role: "user", kind: "text", text: "Follow-up", at: 42 }] },
      }));
      expect(confirmed.match(/data-message-hover-actions/g)).toHaveLength(2);
    } finally {
      delete acceptedSends.t1;
    }
  });
});

describe("SettingsPanel still owns folder and usage", () => {
  beforeAll(() => {
    if (typeof document === "undefined") {
      Object.defineProperty(globalThis, "document", {
        value: { documentElement: { lang: "en", dataset: {} } },
        configurable: true,
      });
    }
  });

  it("renders an optional project folder in Bot details and keeps Usage behind Advanced", async () => {
    const { SettingsPanel } = await import("./SettingsPanel");
    const { I18nProvider } = await import("@/lib/i18n");
    const html = renderToStaticMarkup(
      createElement(
        I18nProvider,
        null,
        createElement(SettingsPanel, { bot: botWithUsage, defaultAdvancedOpen: true }),
      ),
    );
    expect(html).toContain("Project folder (optional)");
    expect(html).toMatch(/private workspace/i);
    expect(html).not.toContain("Working folder");
    expect(html).not.toContain("Where this bot runs its shell and file tools.");
    expect(html).not.toContain("All bots");
    expect(settingsPanel).toContain("{advancedOpen && <BotUsageCard bot={bot} />}");
  });

  it("keeps a pinned-elsewhere folder path in monospace", async () => {
    const { SettingsPanel } = await import("./SettingsPanel");
    const { I18nProvider } = await import("@/lib/i18n");
    const html = renderToStaticMarkup(
      createElement(
        I18nProvider,
        null,
        createElement(SettingsPanel, { bot: botWithUsage }),
      ),
    );
    expect(html).toContain("New tasks start here");
    expect(html).toMatch(/<span class="font-mono">\/tmp\/friend<\/span>/);
  });

  it("presents an empty cwd as an optional private workspace", async () => {
    const { SettingsPanel } = await import("./SettingsPanel");
    const { I18nProvider } = await import("@/lib/i18n");
    const botWithoutCwd = { ...botWithUsage, cwd: undefined };
    const html = renderToStaticMarkup(
      createElement(
        I18nProvider,
        null,
        createElement(SettingsPanel, { bot: botWithoutCwd }),
      ),
    );
    expect(html).toContain("Project folder (optional)");
    expect(html).toContain("Private bot workspace");
    expect(html).toMatch(/Leave empty for a private workspace/i);
    expect(html).not.toMatch(/you must configure where tools run/i);
    expect(html).not.toContain("Where this bot runs its shell and file tools.");
  });
});
