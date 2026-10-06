import "./ProfileFields.test-dom.ts";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { Bot } from "@/state/store";
import { I18nProvider } from "@/lib/i18n";
import { en, ko } from "@/lib/i18n-catalog";

const here = dirname(fileURLToPath(import.meta.url));
const chatView = readFileSync(join(here, "ChatView.tsx"), "utf8");
const settingsPanel = readFileSync(join(here, "SettingsPanel.tsx"), "utf8");

let avatarRequest = 0;
const scrolled = vi.fn();

// oxlint-disable-next-line anti-slop/no-module-mocking -- Bot details reads the shared store; this harness only varies the avatar request.
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
        settingsAvatarRequest: avatarRequest,
      },
      dispatch: () => undefined,
      refreshInstances: async () => undefined,
    }),
  };
});

// oxlint-disable-next-line anti-slop/no-module-mocking -- Desktop capability probes need a packaged host.
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

// oxlint-disable-next-line anti-slop/no-module-mocking -- Voice controls need a host audio device.
vi.mock("./VoiceSettings", () => ({
  VoiceSettings: () => null,
}));

// oxlint-disable-next-line anti-slop/no-module-mocking -- The picker body is a separate card; this test only checks that it is open.
vi.mock("./BotProfileAvatarCard", () => ({
  BotProfileAvatarCard: () => createElement("div", { "data-avatar-picker": "" }),
}));

// oxlint-disable-next-line anti-slop/no-module-mocking -- The local-computer warning is outside the avatar block.
vi.mock("./LocalComputerAutoWarning", () => ({
  LocalComputerAutoWarning: () => null,
}));

// oxlint-disable-next-line anti-slop/no-module-mocking -- Cloud backend choices are outside the avatar block.
vi.mock("./CloudBackendPicker", () => ({
  CloudBackendPicker: () => null,
}));

import { SettingsPanel } from "./SettingsPanel";

Object.defineProperty(globalThis, "localStorage", { configurable: true, value: window.localStorage });

// SAFETY: the avatar block reads id, name, and modelSelection; the rest of Bot stays unused.
const bot = {
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

afterEach(() => {
  localStorage.setItem("omb-locale", "en");
  document.body.replaceChildren();
  avatarRequest = 0;
  scrolled.mockClear();
});

async function renderPanel() {
  HTMLElement.prototype.scrollIntoView = () => {
    scrolled();
  };
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  await act(async () => {
    root.render(createElement(I18nProvider, null, createElement(SettingsPanel, { bot })));
  });
  return { host, root };
}

describe("chat avatar opens the avatar picker", () => {
  it("wires the header avatar, not the pencil, and keeps Customize in the catalog", () => {
    expect(chatView).toContain('onClick={() => dispatch({ type: "toggleSettings", open: true, avatar: true })}');
    expect(chatView).toContain('onActivate={() => dispatch({ type: "toggleSettings", open: true })}');
    expect(settingsPanel).toContain("settingsAvatarRequest");
    expect(settingsPanel).toContain("scrollIntoView");
    expect(settingsPanel).toContain('t("bot.avatarCustomize")');
    expect(settingsPanel).toContain('t("bot.avatarDone")');
    expect(en["bot.avatarCustomize"]).toBe("Customize");
    expect(ko["bot.avatarCustomize"]).toBe("꾸미기");
    expect(en["bot.avatarDone"]).toBe("Done");
    expect(ko["bot.avatarDone"]).toBe("완료");
  });

  it("starts closed from the pencil", async () => {
    localStorage.setItem("omb-locale", "ko");
    avatarRequest = 0;
    const { root } = await renderPanel();
    try {
      expect(document.body.textContent).toContain("꾸미기");
      expect(document.querySelector("[data-avatar-picker]")).toBeNull();
      expect(scrolled).not.toHaveBeenCalled();
    } finally {
      await act(async () => root.unmount());
    }
  });

  it("starts open and scrolls the avatar block into view", async () => {
    avatarRequest = 1;
    const { root } = await renderPanel();
    try {
      expect(document.body.textContent).toContain("Done");
      expect(document.querySelector("[data-avatar-picker]")).not.toBeNull();
      expect(scrolled).toHaveBeenCalled();
    } finally {
      await act(async () => root.unmount());
    }
  });
});
