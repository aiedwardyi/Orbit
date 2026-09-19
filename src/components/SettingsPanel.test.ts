import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import type { Bot } from "@/state/store";

const chrome = vi.hoisted(() => ({ botDetailsAdvanced: false }));

const storeMock = vi.hoisted(() => ({ dispatch: vi.fn() }));

vi.hoisted(() => {
  Object.defineProperty(globalThis, "window", {
    value: { ogb: undefined },
    configurable: true,
    writable: true,
  });
});

vi.mock("@/lib/friends-chrome", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/friends-chrome")>();
  return {
    ...actual,
    showBotDetailsAdvanced: () => chrome.botDetailsAdvanced,
  };
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
          {
            instanceId: "claude",
            driverKind: "claudeAgent",
            displayName: "Claude",
            snapshot: { state: "available", authenticated: true, version: "1.0.13" },
            models: { default: "claude-3-5-sonnet", options: [{ id: "claude-3-5-sonnet", label: "Claude 3.5 Sonnet" }] },
            capabilities: {},
          },
        ],
        bots: [],
        config: {},
        mascotMotion: null,
      },
      dispatch: storeMock.dispatch,
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

  afterEach(() => {
    chrome.botDetailsAdvanced = false;
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

  it("keeps Chief of Staff switchable on an engine that cannot coordinate", async () => {
    chrome.botDetailsAdvanced = true;
    const { SettingsPanel } = await import("./SettingsPanel");
    const { I18nProvider } = await import("@/lib/i18n");
    const html = renderToStaticMarkup(
      createElement(I18nProvider, null, createElement(SettingsPanel, { bot, defaultAdvancedOpen: true })),
    );
    const fromLabel = html.slice(html.indexOf('aria-label="Chief of Staff"'));
    const buttonTag = fromLabel.slice(0, fromLabel.indexOf(">"));

    expect(buttonTag).not.toContain("disabled");
    expect(html).toContain("This engine cannot contact teammates yet");
    expect(html).not.toContain("Choose a Claude or ACP engine");
  });

  it("keeps a null task pin on the private workspace in the remembered-folder notice", async () => {
    const { SettingsPanel } = await import("./SettingsPanel");
    const { I18nProvider } = await import("@/lib/i18n");
    const homePinned = {
      ...bot,
      cwd: "/work/orbit",
      rememberedProjectCwd: "/work/orbit",
      tasks: [{ threadId: "t1", cwd: null }],
    } as Bot;
    const html = renderToStaticMarkup(
      createElement(I18nProvider, null, createElement(SettingsPanel, { bot: homePinned, defaultAdvancedOpen: true })),
    );
    expect(html).toContain("Next task uses");
    expect(html).toContain("private workspace");
    expect(html).not.toContain("This task stays in /work/orbit");
  });

  it("keeps peer comms switchable on an engine that cannot coordinate", async () => {
    chrome.botDetailsAdvanced = true;
    const { SettingsPanel } = await import("./SettingsPanel");
    const { I18nProvider } = await import("@/lib/i18n");
    const html = renderToStaticMarkup(
      createElement(I18nProvider, null, createElement(SettingsPanel, { bot, defaultAdvancedOpen: true })),
    );
    const fromLabel = html.slice(html.indexOf('aria-label="Ask me before contacting other bots"'));
    const buttonTag = fromLabel.slice(0, fromLabel.indexOf(">"));

    expect(buttonTag).not.toContain("disabled");
    expect(html).not.toContain("This engine cannot contact other bots");
  });
});

describe("SettingsPanel Korean bot details", () => {
  beforeEach(() => {
    vi.stubGlobal("localStorage", {
      getItem: (key: string) => (key === "omb-locale" ? "ko" : null),
      setItem: () => {},
      removeItem: () => {},
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("renders the bot details header while keeping the core rows in Korean", async () => {
    const { SettingsPanel } = await import("./SettingsPanel");
    const { I18nProvider } = await import("@/lib/i18n");
    const html = renderToStaticMarkup(
      createElement(I18nProvider, null, createElement(SettingsPanel, { bot })),
    );
    expect(html).toContain("봇 세부 정보");
    expect(html).toContain("aria-label=\"봇 세부 정보 접기\"");
    expect(html).toContain("aria-label=\"봇 세부 정보 닫기\"");
    expect(html).toContain(">프로젝트 폴더<");
    expect(html).toContain(">Memory<");
    expect(html).toContain(">Notifications<");
    expect(html).not.toContain(">연결 앱<");
    expect(html).not.toContain("Allow this bot to use connected apps");
    expect(html).not.toContain("Stays on the active engine by default");
    expect(html).not.toContain(">Bot details<");
    expect(html).not.toContain("Collapse bot details");
    expect(html).not.toContain("Close bot details");
    expect(html).not.toMatch(/>Connected apps</);
  });
});

describe("SettingsPanel lean startup", () => {
  const claudeBot = {
    ...bot,
    modelSelection: { instanceId: "claude", model: "claude-3-5-sonnet", mode: "automatic" },
  } as Bot;

  beforeEach(() => {
    storeMock.dispatch.mockClear();
  });

  it("shows Load skills and plugins on by default with no hint", async () => {
    const { SettingsPanel } = await import("./SettingsPanel");
    const { I18nProvider } = await import("@/lib/i18n");
    const html = renderToStaticMarkup(
      createElement(I18nProvider, null, createElement(SettingsPanel, { bot: claudeBot })),
    );
    expect(html).toContain("Load skills &amp; plugins");
    expect(html).toContain('aria-label="Load skills &amp; plugins"');
    expect(html).toContain('aria-checked="true"');
    expect(html).not.toContain("Lean startup");
    expect(html).not.toContain("project settings only");
    expect(html).not.toContain("user skills");
  });

  it("shows off when leanStartup is true", async () => {
    const { SettingsPanel } = await import("./SettingsPanel");
    const { I18nProvider } = await import("@/lib/i18n");
    const html = renderToStaticMarkup(
      createElement(
        I18nProvider,
        null,
        createElement(SettingsPanel, { bot: { ...claudeBot, leanStartup: true } as Bot }),
      ),
    );
    const labelAt = html.indexOf('aria-label="Load skills');
    const buttonStart = html.lastIndexOf("<button", labelAt);
    const buttonTag = html.slice(buttonStart, html.indexOf(">", labelAt));
    expect(buttonTag).toContain('aria-checked="false"');
  });
});
