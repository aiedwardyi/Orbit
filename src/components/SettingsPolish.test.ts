// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { I18nProvider } from "@/lib/i18n";
import type { Bot, InstanceInfo } from "@/state/store";

const { mockState, mockApi, claudeInstance, codexInstance, grokInstance, geminiInstance } = vi.hoisted(() => {
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
  const codexInstance: InstanceInfo = {
    instanceId: "codex",
    driverKind: "codex",
    displayName: "Codex",
    snapshot: { state: "available", authenticated: true },
    models: { default: "o3-mini", options: [] },
    capabilities: { rateLimits: true },
  };
  const grokInstance: InstanceInfo = {
    instanceId: "grok",
    driverKind: "grokAgent",
    displayName: "Grok",
    snapshot: { state: "available", authenticated: true },
    models: { default: "grok-4", options: [] },
    capabilities: { rateLimits: true },
  };
  const geminiInstance: InstanceInfo = {
    instanceId: "gemini",
    driverKind: "geminiAgent",
    displayName: "Gemini",
    snapshot: { state: "available", authenticated: true },
    models: { default: "gemini-2.5", options: [] },
    capabilities: { rateLimits: false },
  };
  return {
    mockApi: vi.fn(async (_path: string, _options?: RequestInit): Promise<{ report?: { windows: { id: string; usedPercent: number }[]; observedAt: string }; error?: string }> => ({})),
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
    claudeInstance,
    codexInstance,
    grokInstance,
    geminiInstance,
  };
});

vi.mock("@/state/store", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/state/store")>();
  return {
    ...actual,
    api: mockApi,
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

  it("with Claude, Codex, Grok and one Gemini instance, clicking the button labelled 'Refresh all' POSTs /api/usage/refresh/ once for each of claude, codex and grok, and never for gemini", async () => {
    const previousInstances = mockState.instances;
    mockState.instances = [claudeInstance, codexInstance, grokInstance, geminiInstance];
    mockApi.mockClear();
    try {
      await act(async () => {
        root.render(createElement(I18nProvider, null, createElement(UsageSection)));
      });

      const refreshAllButton = [...host.querySelectorAll("button")].find(
        (b) => b.textContent?.trim() === "Refresh all",
      );
      expect(refreshAllButton).toBeDefined();
      await act(async () => {
        refreshAllButton?.click();
      });

      expect(mockApi).toHaveBeenCalledWith("/api/usage/refresh/claude", { method: "POST" });
      expect(mockApi).toHaveBeenCalledWith("/api/usage/refresh/codex", { method: "POST" });
      expect(mockApi).toHaveBeenCalledWith("/api/usage/refresh/grok", { method: "POST" });
      expect(mockApi).not.toHaveBeenCalledWith(expect.stringContaining("gemini"), expect.anything());
      expect(mockApi).toHaveBeenCalledTimes(3);
    } finally {
      mockState.instances = previousInstances;
    }
  });

  it("disables 'Refresh all' while an engine refresh is running and ignores clicks", async () => {
    const previousInstances = mockState.instances;
    mockState.instances = [claudeInstance, codexInstance, grokInstance, geminiInstance];
    let resolveClaude: () => void = () => {};
    mockApi.mockReset();
    mockApi.mockImplementation((path: string) => {
      if (path === "/api/usage/refresh/claude") {
        return new Promise((resolve) => {
          resolveClaude = () => resolve({});
        });
      }
      return Promise.resolve({});
    });
    try {
      await act(async () => {
        root.render(createElement(I18nProvider, null, createElement(UsageSection)));
      });

      const engineRefreshButton = [...host.querySelectorAll("button")].find(
        (b) => b.textContent?.trim() === "Refresh",
      );
      expect(engineRefreshButton).toBeDefined();

      await act(async () => {
        engineRefreshButton?.click();
      });

      expect(mockApi).toHaveBeenCalledTimes(1);
      expect(mockApi).toHaveBeenCalledWith("/api/usage/refresh/claude", { method: "POST" });

      const refreshAllButton = [...host.querySelectorAll("button")].find(
        (b) => b.textContent?.trim() === "Refresh all",
      );
      expect(refreshAllButton).toBeDefined();
      expect(refreshAllButton?.hasAttribute("disabled")).toBe(true);

      await act(async () => {
        refreshAllButton?.click();
      });

      expect(mockApi).toHaveBeenCalledTimes(1);

      await act(async () => {
        resolveClaude();
      });
    } finally {
      mockState.instances = previousInstances;
      mockApi.mockReset();
      mockApi.mockImplementation(async () => ({}));
    }
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
