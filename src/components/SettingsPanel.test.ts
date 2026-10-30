import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import type { Bot } from "@/state/store";

const chrome = vi.hoisted(() => ({ botDetailsAdvanced: false, disabledShareTerminal: false }));

const storeMock = vi.hoisted(() => ({ dispatch: vi.fn() }));

const configMock = vi.hoisted(() => ({ terminalHost: false }));

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
    showDisabledShareTerminal: () => chrome.disabledShareTerminal,
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
        config: { features: { terminalHost: configMock.terminalHost } },
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
    const fromLabel = html.slice(html.indexOf('aria-label="Ask Me Before Contacting Other Bots"'));
    const buttonTag = fromLabel.slice(0, fromLabel.indexOf(">"));

    expect(buttonTag).not.toContain("disabled");
    expect(html).not.toContain("This engine cannot contact other bots");
  });

  it("offers no per-bot Browser switch even with Advanced open", async () => {
    chrome.botDetailsAdvanced = true;
    const { SettingsPanel } = await import("./SettingsPanel");
    const { I18nProvider } = await import("@/lib/i18n");
    const html = renderToStaticMarkup(
      createElement(I18nProvider, null, createElement(SettingsPanel, { bot, defaultAdvancedOpen: true })),
    );
    expect(html).not.toContain("Give This Bot a Built-in Browser");
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
    configMock.terminalHost = false;
    vi.unstubAllGlobals();
  });

  it("renders the bot details header while keeping the core rows in Korean", async () => {
    configMock.terminalHost = true;
    const { SettingsPanel } = await import("./SettingsPanel");
    const { I18nProvider } = await import("@/lib/i18n");
    const html = renderToStaticMarkup(
      createElement(I18nProvider, null, createElement(SettingsPanel, { bot })),
    );
    expect(html).toContain("봇 세부 정보");
    expect(html).toContain("aria-label=\"봇 세부 정보 접기\"");
    expect(html).toContain("aria-label=\"봇 세부 정보 닫기\"");
    expect(html).toContain(">프로젝트 폴더<");
    expect(html).toContain(">이름<");
    expect(html).toContain(">메모리<");
    expect(html).not.toContain(">Name<");
    expect(html).not.toContain(">Memory<");
    expect(html).toContain(">알림<");
    expect(html).toContain("aria-label=\"봇 알림\"");
    expect(html).toContain(">터미널을 대화와 공유<");
    expect(html).toContain("aria-label=\"터미널을 대화와 공유\"");
    expect(html).not.toContain(">Notifications<");
    expect(html).not.toContain("Share Terminal with Chat");
    expect(html).not.toContain("Bot Notifications");
    expect(html).not.toContain(">연결 앱<");
    expect(html).not.toContain("Allow this bot to use connected apps");
    expect(html).not.toContain("Stays on the active engine by default");
    expect(html).not.toContain(">Bot details<");
    expect(html).not.toContain("Collapse Bot Details");
    expect(html).not.toContain("Close Bot Details");
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

  afterEach(() => {
    chrome.botDetailsAdvanced = false;
  });

  it("keeps Load Skills & Plugins off the idle surface", async () => {
    const { SettingsPanel } = await import("./SettingsPanel");
    const { I18nProvider } = await import("@/lib/i18n");
    const html = renderToStaticMarkup(
      createElement(I18nProvider, null, createElement(SettingsPanel, { bot: claudeBot, defaultAdvancedOpen: true })),
    );
    expect(html).not.toContain("Load Skills");
  });

  it("shows Load skills and plugins on by default with no hint", async () => {
    chrome.botDetailsAdvanced = true;
    const { SettingsPanel } = await import("./SettingsPanel");
    const { I18nProvider } = await import("@/lib/i18n");
    const html = renderToStaticMarkup(
      createElement(I18nProvider, null, createElement(SettingsPanel, { bot: claudeBot, defaultAdvancedOpen: true })),
    );
    expect(html).toContain("Load Skills &amp; Plugins");
    expect(html).toContain('aria-label="Load Skills &amp; Plugins"');
    expect(html).toContain('aria-checked="true"');
    expect(html).not.toContain("Lean startup");
    expect(html).not.toContain("project settings only");
    expect(html).not.toContain("user skills");
  });

  it("shows off when leanStartup is true", async () => {
    chrome.botDetailsAdvanced = true;
    const { SettingsPanel } = await import("./SettingsPanel");
    const { I18nProvider } = await import("@/lib/i18n");
    const html = renderToStaticMarkup(
      createElement(
        I18nProvider,
        null,
        createElement(SettingsPanel, { bot: { ...claudeBot, leanStartup: true } as Bot, defaultAdvancedOpen: true }),
      ),
    );
    const labelAt = html.indexOf('aria-label="Load Skills');
    const buttonStart = html.lastIndexOf("<button", labelAt);
    const buttonTag = html.slice(buttonStart, html.indexOf(">", labelAt));
    expect(buttonTag).toContain('aria-checked="false"');
  });
});

describe("SettingsPanel share terminal switch", () => {
  const terminalButtonTag = (html: string) => {
    const labelAt = html.indexOf('aria-label="Share Terminal with Chat"');
    return html.slice(html.lastIndexOf("<button", labelAt), html.indexOf(">", labelAt));
  };

  afterEach(() => {
    configMock.terminalHost = false;
    chrome.disabledShareTerminal = false;
    (globalThis as { window: { ogb?: unknown } }).window.ogb = undefined;
  });

  it("hides when neither the desktop app nor the server has a terminal bridge", async () => {
    const { SettingsPanel } = await import("./SettingsPanel");
    const { I18nProvider } = await import("@/lib/i18n");
    const html = renderToStaticMarkup(createElement(I18nProvider, null, createElement(SettingsPanel, { bot })));
    expect(html).not.toContain("Share Terminal with Chat");
  });

  it("stays disabled without a terminal bridge when the flag shows it", async () => {
    chrome.disabledShareTerminal = true;
    const { SettingsPanel } = await import("./SettingsPanel");
    const { I18nProvider } = await import("@/lib/i18n");
    const html = renderToStaticMarkup(createElement(I18nProvider, null, createElement(SettingsPanel, { bot })));
    expect(terminalButtonTag(html)).toContain('disabled=""');
  });

  it("stays visible to turn off a share saved on another device", async () => {
    const { SettingsPanel } = await import("./SettingsPanel");
    const { I18nProvider } = await import("@/lib/i18n");
    const html = renderToStaticMarkup(
      createElement(I18nProvider, null, createElement(SettingsPanel, { bot: { ...bot, shareTerminalWithChat: true } })),
    );
    expect(terminalButtonTag(html)).not.toContain('disabled=""');
  });

  it("enables when the server reports a terminal bridge", async () => {
    configMock.terminalHost = true;
    const { SettingsPanel } = await import("./SettingsPanel");
    const { I18nProvider } = await import("@/lib/i18n");
    const html = renderToStaticMarkup(createElement(I18nProvider, null, createElement(SettingsPanel, { bot })));
    expect(terminalButtonTag(html)).not.toContain('disabled=""');
  });

  it("enables when the desktop app has a terminal bridge", async () => {
    (globalThis as { window: { ogb?: unknown } }).window.ogb = { terminal: {} };
    const { SettingsPanel } = await import("./SettingsPanel");
    const { I18nProvider } = await import("@/lib/i18n");
    const html = renderToStaticMarkup(createElement(I18nProvider, null, createElement(SettingsPanel, { bot })));
    expect(terminalButtonTag(html)).not.toContain('disabled=""');
  });
});
