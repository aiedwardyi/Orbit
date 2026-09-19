// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { I18nProvider } from "@/lib/i18n";
import type { Bot } from "@/state/store";

const { mockDispatch } = vi.hoisted(() => ({ mockDispatch: vi.fn() }));

vi.mock("@/state/store", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/state/store")>();
  return {
    ...actual,
    useStore: () => ({
      state: {
        instances: [
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
      dispatch: mockDispatch,
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

import { SettingsPanel } from "./SettingsPanel";

const claudeBot = {
  id: "bot-1",
  threadId: "t1",
  name: "Friend",
  title: "",
  description: "",
  notifications: false,
  color: "green",
  unread: false,
  modelSelection: { instanceId: "claude", model: "claude-3-5-sonnet", mode: "automatic" },
  messages: [],
} as Bot;

describe("SettingsPanel lean startup switch", () => {
  let host: HTMLDivElement;
  let root: ReturnType<typeof createRoot>;

  beforeEach(() => {
    mockDispatch.mockClear();
    host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);
    (window as any).ogb = {};
  });

  afterEach(() => {
    root.unmount();
    host.remove();
  });

  it("off saves leanStartup true", async () => {
    await act(async () => {
      root.render(createElement(I18nProvider, null, createElement(SettingsPanel, { bot: claudeBot })));
    });
    const toggle = host.querySelector('button[aria-label="Load skills & plugins"]');
    expect(toggle?.getAttribute("aria-checked")).toBe("true");
    await act(async () => {
      (toggle as HTMLButtonElement)?.click();
    });
    expect(mockDispatch).toHaveBeenCalledWith({
      type: "updateBot",
      botId: "bot-1",
      patch: { leanStartup: true },
    });
  });

  it("on saves leanStartup false", async () => {
    await act(async () => {
      root.render(
        createElement(I18nProvider, null, createElement(SettingsPanel, { bot: { ...claudeBot, leanStartup: true } as Bot })),
      );
    });
    const toggle = host.querySelector('button[aria-label="Load skills & plugins"]');
    expect(toggle?.getAttribute("aria-checked")).toBe("false");
    await act(async () => {
      (toggle as HTMLButtonElement)?.click();
    });
    expect(mockDispatch).toHaveBeenCalledWith({
      type: "updateBot",
      botId: "bot-1",
      patch: { leanStartup: false },
    });
  });
});
