import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeAll, describe, expect, it, vi } from "vitest";

import type { AppSettingsSection, ConfigStatus } from "@/state/store";

vi.hoisted(() => {
  Object.defineProperty(globalThis, "window", {
    value: { ogb: undefined },
    configurable: true,
    writable: true,
  });
  if (typeof document === "undefined") {
    Object.defineProperty(globalThis, "document", {
      value: { visibilityState: "visible", documentElement: { lang: "en", dataset: {} } },
      configurable: true,
    });
  }
});

const config: ConfigStatus = {
  composio: { configured: false, mode: "self-hosted" },
  box: { configured: false },
  vps: { configured: false, sshAlias: "" },
  rooms: { turnTimeoutMinutes: 5 },
  localVm: { mode: "shared", maxInstances: 2 },
  gemini: { configured: false },
  opencodeGo: { configured: false },
  profile: { name: "", email: "" },
  features: { skillRecorder: false, showToolCalls: false, browser: false },
  browserProfiles: [],
};

let section: AppSettingsSection = "general";

vi.mock("@/state/store", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/state/store")>();
  return {
    ...actual,
    useStore: () => ({
      state: {
        appSettingsOpen: true,
        appSettingsSection: section,
        instances: [],
        bots: [],
        config,
        routines: [],
        routineRuns: [],
        screens: {},
        computerControl: {},
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
      host: { platform: "win32", packaged: true, homeDir: undefined },
      toasts: { available: false },
      localComputer: { available: false, support: "unsupported" },
      screenPreview: { available: false },
    },
    ready: true,
  }),
}));

vi.mock("@/lib/analytics", () => ({
  analyticsEnabled: false,
  setAnalyticsEnabled: () => undefined,
}));

const here = dirname(fileURLToPath(import.meta.url));
const settingsModalSource = readFileSync(join(here, "SettingsModal.tsx"), "utf8");
const apiKeysSource = readFileSync(join(here, "ApiKeys.tsx"), "utf8");

describe("SettingsModal friends chrome", () => {
  beforeAll(() => {
    if (typeof document === "undefined") {
      Object.defineProperty(globalThis, "document", {
        value: { visibilityState: "visible", documentElement: { lang: "en", dataset: {} } },
        configurable: true,
      });
    }
  });

  it("hides Local VM from the nav and keeps Phone parked on the Windows friends pack", async () => {
    const { I18nProvider } = await import("@/lib/i18n");
    const { SettingsModal } = await import("./SettingsModal");
    section = "general";
    const html = renderToStaticMarkup(
      createElement(I18nProvider, null, createElement(SettingsModal)),
    );
    expect(html).toContain('data-settings-nav="general"');
    expect(html).toContain('data-settings-nav="connections"');
    expect(html).toContain('data-settings-nav="engines"');
    expect(html).toContain('data-settings-nav="usage"');
    expect(html).not.toContain('data-settings-nav="computer"');
    expect(html).not.toContain('data-settings-nav="companion"');
  });

  it("folds Local VM, Channel turns, Experimental, and Diagnostics behind one Advanced", async () => {
    const { I18nProvider } = await import("@/lib/i18n");
    const { SettingsModal } = await import("./SettingsModal");
    section = "general";
    const html = renderToStaticMarkup(
      createElement(I18nProvider, null, createElement(SettingsModal)),
    );
    expect(html).toContain("Advanced");
    expect(html).toContain("data-settings-advanced");
    expect(html).not.toContain("data-settings-advanced-body");
    expect(html).not.toContain("Channel turns");
    expect(html).not.toContain("Experimental features");
    expect(html).not.toContain("Export Diagnostics");
    expect(html).not.toContain("Show Local VM setup");
    expect(html).not.toContain("A shared Cua Linux sandbox");
    expect(html).toContain("Language");
    expect(html).toContain("Profile");
    expect(html).toContain("Skin");
    expect(html).toContain("Tool calls");
    expect(html).toContain("Usage analytics");
  });

  it("reveals the four Advanced blocks from that one disclosure", async () => {
    const { I18nProvider } = await import("@/lib/i18n");
    const { SettingsModal } = await import("./SettingsModal");
    section = "general";
    const html = renderToStaticMarkup(
      createElement(I18nProvider, null, createElement(SettingsModal, { defaultAdvancedOpen: true })),
    );
    expect(html).toContain("data-settings-advanced-body");
    expect(html).toContain("Channel turns");
    expect(html).toContain("Experimental features");
    expect(html).toContain("Export Diagnostics");
    expect(html).toContain("Local VM");
    expect(html).toContain("Show Local VM setup");
  });

  it("shows only the Gemini key on Connections until More services is opened", async () => {
    const { I18nProvider } = await import("@/lib/i18n");
    const { SettingsModal } = await import("./SettingsModal");
    section = "connections";
    const html = renderToStaticMarkup(
      createElement(I18nProvider, null, createElement(SettingsModal)),
    );
    expect(html).toContain("Gemini API key");
    expect(html).toContain("More services");
    expect(html).not.toContain("data-settings-more-services-body");
    expect(html).not.toContain("AssemblyAI transcription");
    expect(html).not.toContain("Box API key");
    expect(html).not.toContain("Self-hosted VPS");
    expect(html).not.toContain("OpenCode API key");
    expect(html).not.toContain("Self-host connected apps");
  });

  it("puts the other four connection entries behind More services", async () => {
    const { I18nProvider } = await import("@/lib/i18n");
    const { SettingsModal } = await import("./SettingsModal");
    section = "connections";
    const html = renderToStaticMarkup(
      createElement(I18nProvider, null, createElement(SettingsModal, { defaultMoreServicesOpen: true })),
    );
    expect(html).toContain("data-settings-more-services-body");
    expect(html).toContain("AssemblyAI transcription");
    expect(html).toContain("Box API key");
    expect(html).toContain("Self-hosted VPS");
    expect(html).toContain("OpenCode API key");
    expect(html).toContain("Self-host connected apps");
  });

  it("strips OpenMausBot documentation links from the shipped Settings surface", () => {
    expect(apiKeysSource).not.toContain("milind-soni/OpenMausBot");
    expect(apiKeysSource).not.toContain("docs/byo-vps.md");
    expect(settingsModalSource).not.toContain("milind-soni/OpenMausBot");
    expect(settingsModalSource).not.toMatch(/OpenMausBot\/blob|openmausbot\.com\/docs/i);
  });
});
