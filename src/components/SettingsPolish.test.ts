// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { I18nProvider } from "@/lib/i18n";
import type { Bot, InstanceInfo } from "@/state/store";

const { mockState } = vi.hoisted(() => {
  const claudeInstance: InstanceInfo = {
    instanceId: "claude",
    driverKind: "claudeAgent",
    displayName: "Claude",
    snapshot: { state: "available", authenticated: true },
    models: { default: "claude-3-5-sonnet", options: [] },
    capabilities: { rateLimits: true },
    rateLimits: {
      observedAt: new Date().toISOString(),
      windows: [],
    },
  };
  return {
    mockState: {
      appSettingsOpen: true,
      appSettingsSection: "connections",
      bots: [] as Bot[],
      instances: [claudeInstance],
      config: {
        composio: { configured: false, mode: "local" },
        gemini: { configured: false },
        box: { configured: false },
        vps: { configured: false, sshAlias: "" },
        rooms: { turnTimeoutMinutes: 5 },
        localVm: { mode: "shared", maxInstances: 1 },
        opencodeGo: { configured: false },
        profile: { name: "", email: "" },
        features: { skillRecorder: false, showToolCalls: false },
      },
      mascotMotion: null,
    },
  };
});

vi.mock("@/state/store", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/state/store")>();
  return {
    ...actual,
    api: vi.fn(async () => ({})),
    useStore: () => ({
      state: mockState,
      dispatch: () => undefined,
      refreshInstances: async () => undefined,
    }),
  };
});

vi.mock("@/lib/updater", () => ({
  useUpdaterState: () => null,
  useManualCheck: () => ({ acknowledged: true, check: () => {} }),
}));

vi.mock("./DesktopCapabilities", () => ({
  useDesktopCapabilities: () => ({
    capabilities: {
      host: { platform: "win32", homeDir: "/home/user" },
      toasts: { available: false },
      localComputer: { available: false, support: "unsupported" },
    },
    ready: true,
  }),
}));

vi.mock("./CompanionSection", () => ({
  CompanionSection: () => null,
}));

vi.mock("./EnginesSettings", () => ({
  EnginesSettings: () => null,
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

import { UsageSection } from "./UsageSection";
import { SettingsModal } from "./SettingsModal";
import { SettingsPanel } from "./SettingsPanel";

describe("Settings Polish", () => {
  let host: HTMLDivElement;
  let root: ReturnType<typeof createRoot>;

  beforeEach(() => {
    host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);
    (window as any).ogb = {
      pickFolder: vi.fn(),
    };
  });

  afterEach(() => {
    root.unmount();
    host.remove();
  });

  it("the Usage Refresh button carries border border-hairline/40", async () => {
    await act(async () => {
      root.render(createElement(I18nProvider, null, createElement(UsageSection)));
    });

    const refreshButton = [...host.querySelectorAll("button")].find(
      (b) => b.textContent?.trim() === "Refresh",
    );
    expect(refreshButton).toBeDefined();
    expect(refreshButton?.className).toContain("border border-hairline/40");
    expect(refreshButton?.className).toContain("hover:bg-raised/50");
    expect(refreshButton?.className).toContain("hover:text-ink");
  });

  it("the Connections pane shows \"Connections\" exactly once", async () => {
    mockState.appSettingsSection = "connections";
    await act(async () => {
      root.render(createElement(I18nProvider, null, createElement(SettingsModal)));
    });

    const pane = host.querySelector(".flex.min-w-0.flex-1.flex-col");
    expect(pane).toBeDefined();
    const connectionsLabels = [...(pane?.querySelectorAll("*") ?? [])].filter(
      (el) => el.children.length === 0 && el.textContent?.trim() === "Connections",
    );
    expect(connectionsLabels).toHaveLength(1);
  });

  it("the empty-state folder text is not monospace, while a real path still is", async () => {
    const emptyBot: Bot = {
      id: "bot-empty",
      threadId: "t1",
      name: "Empty Bot",
      title: "",
      description: "",
      notifications: false,
      color: "green",
      unread: false,
      modelSelection: { instanceId: "claude", model: "claude-3-5-sonnet", mode: "automatic" },
      messages: [],
      cwd: null,
    };

    await act(async () => {
      root.render(createElement(I18nProvider, null, createElement(SettingsPanel, { bot: emptyBot })));
    });

    const emptySpan = [...host.querySelectorAll("span")].find(
      (s) => s.textContent?.trim() === "Private bot workspace",
    );
    expect(emptySpan).toBeDefined();
    expect(emptySpan?.parentElement?.className).toContain("font-mono");
    expect(emptySpan?.className).toContain("font-sans");

    // Re-render with real path
    const populatedBot: Bot = {
      ...emptyBot,
      id: "bot-populated",
      cwd: "/home/user/my-project",
    };

    await act(async () => {
      root.render(createElement(I18nProvider, null, createElement(SettingsPanel, { bot: populatedBot })));
    });

    const populatedBox = host.querySelector('[title="/home/user/my-project"]');
    expect(populatedBox).toBeDefined();
    expect(populatedBox?.className).toContain("font-mono");
    expect(populatedBox?.textContent).toContain("my-project");
    expect(populatedBox?.querySelector(".font-sans")).toBeNull();
  });
});
