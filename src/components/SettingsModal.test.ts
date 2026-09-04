import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeAll, describe, expect, it, vi } from "vitest";

import type { AppSettingsSection } from "@/state/store";

const mock = vi.hoisted(() => ({
  section: "general" as AppSettingsSection,
}));

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
        appSettingsOpen: true,
        appSettingsSection: mock.section,
        bots: [],
        config: {
          composio: { configured: false },
          gemini: { configured: false },
          box: { configured: false },
          vps: { configured: false, sshAlias: "" },
          rooms: { turnTimeoutMinutes: 5 },
          localVm: { mode: "shared", maxInstances: 1 },
          opencodeGo: { configured: false },
          profile: { name: "", email: "" },
          features: { skillRecorder: false, showToolCalls: false },
        },
      },
      dispatch: () => undefined,
    }),
  };
});

vi.mock("@/lib/analytics", () => ({
  analyticsEnabled: () => false,
  setAnalyticsEnabled: () => undefined,
}));

vi.mock("./DesktopCapabilities", () => ({
  useDesktopCapabilities: () => ({
    capabilities: {
      host: { platform: "win32", packaged: true, homeDir: undefined },
      toasts: { available: false },
      localComputer: { available: false, support: "unsupported" },
    },
    ready: true,
  }),
}));

vi.mock("./CompanionSection", () => ({
  CompanionSection: () => {
    throw new Error("companion must stay parked");
  },
}));

vi.mock("./EnginesSettings", () => ({
  EnginesSettings: () => null,
}));

vi.mock("./UsageSection", () => ({
  UsageSection: () => null,
}));

import { SettingsModal } from "./SettingsModal";

const here = dirname(fileURLToPath(import.meta.url));

function markup(
  section: AppSettingsSection = "general",
  defaultAdvancedOpen = false,
  defaultMoreServicesOpen = false,
) {
  mock.section = section;
  return renderToStaticMarkup(
    createElement(SettingsModal, { defaultAdvancedOpen, defaultMoreServicesOpen }),
  );
}

describe("SettingsModal friends chrome", () => {
  beforeAll(() => {
    if (typeof document === "undefined") {
      Object.defineProperty(globalThis, "document", {
        value: { documentElement: { lang: "en", dataset: {} } },
        configurable: true,
      });
    }
  });

  it("keeps idle General short: no Advanced, no Local VM / channel / experimental / diagnostics", () => {
    const html = markup("general");
    expect(html).toContain("Profile");
    expect(html).toContain("Skin");
    expect(html).toContain("Tool calls");
    expect(html).toContain("Usage analytics");
    expect(html).toContain("Save name and email");
    expect(html).not.toContain("Advanced");
    expect(html).not.toContain("data-settings-advanced");
    expect(html).not.toContain('aria-label="Search settings"');
    expect(html).not.toMatch(/>Channel turns</);
    expect(html).not.toContain("Set one maximum duration");
    expect(html).not.toContain("Maximum turn length");
    expect(html).not.toMatch(/>Experimental features</);
    expect(html).not.toContain("Teach a skill");
    expect(html).not.toMatch(/>Diagnostics</);
    expect(html).not.toContain("Export Diagnostics");
    expect(html).not.toContain("Show Local VM setup");
    expect(html).not.toContain("Cua Linux");
    expect(html).not.toContain("Hide Local VM setup");
    expect(html).not.toMatch(/>Local VM</);
    expect(html).not.toMatch(/>Phone</);
    expect(html).not.toContain("OpenMausBot");
    expect(html).not.toContain("accounts.openmausbot.com");
  });

  it("does not reveal Local VM, channel turns, experimental, or diagnostics when Advanced would have been open", () => {
    const html = markup("general", true);
    expect(html).not.toContain("data-settings-advanced");
    expect(html).not.toContain("Advanced");
    expect(html).not.toMatch(/>Channel turns</);
    expect(html).not.toContain("Set one maximum duration");
    expect(html).not.toMatch(/>Experimental features</);
    expect(html).not.toContain("Teach a skill");
    expect(html).not.toMatch(/>Diagnostics</);
    expect(html).not.toContain("Export Diagnostics");
    expect(html).not.toMatch(/>Local VM</);
    expect(html).not.toContain("Cua Linux");
  });

  it("folds Gemini and OpenCode keys into Connections and hides the zoo services", () => {
    const html = markup("connections");
    expect(html).toContain("Gemini API key");
    expect(html).toContain("OpenCode API key");
    expect(html).not.toContain("More services");
    expect(html).not.toContain("data-settings-more-services");
    expect(html).not.toContain("Box API key");
    expect(html).not.toContain("AssemblyAI");
    expect(html).not.toContain("Self-hosted VPS");
    expect(html).not.toContain("Composio project key");
    expect(html).not.toContain("Self-host connected apps");
    expect(html).not.toContain("OpenMausBot");
    expect(html).not.toMatch(/>Engines</);
  });

  it("opens Engines as the unified Connections page", () => {
    const html = markup("engines");
    expect(html).toContain("Gemini API key");
    expect(html).toContain("OpenCode API key");
    expect(html).not.toContain("More services");
    expect(html).not.toMatch(/>Engines</);
  });

  it("keeps Local VM, channel turns, experimental, and diagnostics inside the folded Advanced body", () => {
    const source = readFileSync(join(here, "SettingsModal.tsx"), "utf8");
    const marker = "data-settings-advanced";
    const start = source.indexOf(marker);
    expect(start).toBeGreaterThan(-1);
    const advanced = source.slice(start);
    expect(advanced).toContain("<LocalComputerSection");
    expect(advanced).toContain("settings.channelTurns.title");
    expect(advanced).toContain("<ExperimentalFeaturesRow");
    expect(advanced).toContain("<DiagnosticsRow");
    const before = source.slice(0, start);
    expect(before).not.toContain("<LocalComputerSection");
    expect(before).not.toContain("settings.channelTurns.title");
    expect(before).not.toContain("<ExperimentalFeaturesRow");
    expect(before).not.toContain("<DiagnosticsRow");
  });

  it("keeps non-Gemini connections inside the More services body", () => {
    const source = readFileSync(join(here, "SettingsModal.tsx"), "utf8");
    const marker = "data-settings-more-services";
    const start = source.indexOf(marker);
    expect(start).toBeGreaterThan(-1);
    const more = source.slice(start);
    expect(more).toContain("<TranscriptionSettings");
    expect(more).toContain('section="box"');
    expect(more).toContain("<VpsConnection");
    expect(more).toContain('section="composio"');
    const before = source.slice(0, start);
    expect(before).toContain('section="gemini"');
    expect(before).toContain('section="opencodeGo"');
    expect(before).not.toContain("<TranscriptionSettings");
    expect(before).not.toContain('section="box"');
    expect(before).not.toContain("<VpsConnection");
  });
});

describe("friends settings chrome has no OpenMausBot docs", () => {
  it("strips OpenMausBot-named help links from settings chrome", () => {
    const apiKeys = readFileSync(join(here, "ApiKeys.tsx"), "utf8");
    const linux = readFileSync(join(here, "LinuxLocalControl.tsx"), "utf8");
    const settings = readFileSync(join(here, "SettingsModal.tsx"), "utf8");
    for (const source of [apiKeys, linux, settings]) {
      expect(source).not.toContain("OpenMausBot");
      expect(source).not.toContain("openmausbot");
      expect(source).not.toContain("milind-soni");
    }
  });
});
