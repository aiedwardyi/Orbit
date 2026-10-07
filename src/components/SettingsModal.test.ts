import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeAll, describe, expect, it, vi } from "vitest";

import { catalogs } from "@/lib/i18n-catalog";
import { saveRainbowBox } from "@/lib/rainbow-box";
import { LIGHT_SKIN_IDS, SKINS } from "@/lib/skins";
import { saveTerminalPopups } from "@/lib/terminal-popups";
import type { AppSettingsSection } from "@/state/store";

const mock = vi.hoisted(() => ({
  section: "general" as AppSettingsSection,
  updaterState: null as unknown,
}));

// keep the real useManualCheck: SettingsModal imports it from here too, and
// a mock exporting only useUpdaterState throws at render
vi.mock("@/lib/updater", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/updater")>()),
  useUpdaterState: () => mock.updaterState,
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
          profile: { name: "", email: "" },
          features: { skillRecorder: false, showToolCalls: false },
        },
      },
      dispatch: () => undefined,
    }),
  };
});

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
    expect(html).not.toContain("Skin");
    expect(html).not.toContain("Applies instantly and is remembered");
    expect(html).toContain("Tool calls");
    expect(html).toContain("Show work steps");
    expect(html).toContain("Failed tools, turn-level errors, and bot-to-bot messages still appear.");
    expect(html).toMatch(/aria-label="Show work steps"[^>]*aria-checked="false"|aria-checked="false"[^>]*aria-label="Show work steps"/);
    expect(html).toContain(">Auto<");
    expect(html).toContain("Uses English or Korean from the operating system.");
    expect(html).toContain("aria-describedby");
    expect(html).not.toMatch(/title="Uses English or Korean from the operating system/);
    expect(html).toContain("Detailed replies");
    expect(html).toContain("Bots write longer, fuller answers. Off keeps replies short and to the point.");
    expect(html).toMatch(/aria-checked="false"[^>]*aria-label="Detailed replies"/);
    expect(html).toContain("English");
    expect(html).toContain("한국어");
    expect(html).toContain("Your name");
    expect(html).not.toContain("you@example.com");
    expect(html).not.toContain("Usage analytics");
    expect(html).not.toContain("Save name and email");
    expect(html).toContain("Save name");
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
    expect(html).not.toContain("Browser profiles");
    expect(html).not.toContain("Named sign-in sessions");
  });

  it("does not ship the Browser profiles setting", () => {
    const source = readFileSync(join(here, "SettingsModal.tsx"), "utf8");
    expect(source).not.toContain("BrowserProfilesRow");
    expect(source).not.toContain("settings.browserProfiles.title");
  });

  it("offers Onyx, Dracula, and Panda Syntax in Skin alongside the shipped palettes", () => {
    const html = markup("themes");
    expect(html).toContain("Skin");
    expect(html).toContain("Applies instantly and is remembered");
    expect(html).toContain("Catppuccin Frappe");
    expect(html).toContain("Tokyo Night");
    expect(html).toContain("Vesper");
    expect(html).toContain("Ledger");
    expect(html).toContain("Onyx");
    expect(html).toContain("Dracula");
    expect(html).toContain("Panda Syntax");
    expect(html).toContain("Gruvbox");
    expect(html).toContain("Kanagawa");
    expect(html).toContain("Peach");
    expect(html).toContain("Coral");
    expect(html).not.toContain("HaX0R_BLUE");
    expect(html).not.toContain("Seaglass");
    expect(html).toContain("Hurtado");
    expect(html).toContain("Rosé Pine");
    expect(html).toContain("Nord");
    expect(html).toContain("GitHub Dimmed");
    expect(html).toContain("TUI");
    expect(html).toContain("TUI Black");
    expect(html).toContain("TUI Amber");
    expect(html).toContain("TUI Ice");
    expect(html).toContain("TUI Slate");
    expect(html).toContain("TUI Smoke");
    expect(html).toContain("VS Code Dark");
    expect(html).toContain("Studio Gray");
    expect(html).toContain("Steel Gray");
    expect(html).toContain("Precision");
    expect(html).toContain("Notebook");
    expect(html).toContain("Messenger");
    expect(html).toContain("Community");
    expect(html).toContain("Code Review");
    expect(html).toContain("Blueprint");
    expect(html).toContain("Blueprint Gray");
    expect(html).toContain("Blueprint Charcoal");
    expect(html).not.toContain("Cobalt");
    expect(html).toContain('data-skin="catppuccin-frappe"');
    expect(html).toContain('data-skin="tokyo-night"');
    expect(html).toContain('data-skin="vesper"');
    expect(html).toContain('data-skin="onyx"');
    expect(html).toContain('data-skin="dracula"');
    expect(html).toContain('data-skin="cobalt"');
    expect(html).toContain('data-skin="gruvbox"');
    expect(html).toContain('data-skin="kanagawa"');
    expect(html).toContain('data-skin="peach"');
    expect(html).toContain('data-skin="coral"');
    expect(html).not.toContain('data-skin="haxor-blue"');
    expect(html).not.toContain('data-skin="seaglass"');
    expect(html).toContain('data-skin="hurtado"');
    expect(html).toContain('data-skin="rose-pine"');
    expect(html).toContain('data-skin="nord"');
    expect(html).toContain('data-skin="github-dimmed"');
    expect(html).toContain('data-skin="tui"');
    expect(html).toContain('data-skin="tui-black"');
    expect(html).toContain('data-skin="tui-amber"');
    expect(html).toContain('data-skin="tui-ice"');
    expect(html).toContain('data-skin="tui-slate"');
    expect(html).toContain('data-skin="tui-smoke"');
    expect(html).toContain('data-skin="vscode-dark"');
    expect(html).toContain('data-skin="studio-gray"');
    expect(html).toContain('data-skin="steel-gray"');
    expect(html).toContain('data-skin="precision"');
    expect(html).toContain('data-skin="notebook"');
    expect(html).toContain('data-skin="messenger"');
    expect(html).toContain('data-skin="community"');
    expect(html).toContain('data-skin="community-light"');
    expect(html).toContain('data-skin="code-review"');
    expect(html).toContain('data-skin="blueprint"');
    expect(html).toContain('data-skin="blueprint-gray"');
    expect(html).toContain('data-skin="blueprint-charcoal"');
    expect(html).toContain('data-skin="instrument"');
    expect(html).toContain('data-skin="matte"');
    expect(html).toContain('data-skin="carbon"');
    expect(html).toContain('data-skin="pewter"');
    expect(html).toContain('data-skin="pewter-dusk"');
    expect(html).toContain('data-skin="pewter-night"');
    expect(html).toContain('data-skin="coal"');
    expect(html).toContain('data-skin="folio"');
    expect(html).toContain('data-skin="wink"');
    expect(html).toContain('data-skin="wink-cyber"');
    expect(html).toContain('data-skin="wink-violet"');
    expect(html).toContain('data-skin="wink-black"');
    expect(html).toContain('data-skin="wink-day"');
    expect(html).toContain("Wink Day");
  });

  it("orders Themes and Usage last in the settings left nav", () => {
    const source = readFileSync(join(here, "SettingsModal.tsx"), "utf8");
    const start = source.indexOf("const SECTIONS");
    const end = source.indexOf("];", start);
    const block = source.slice(start, end);
    const themes = block.indexOf('id: "themes"');
    const usage = block.indexOf('id: "usage"');
    const shortcuts = block.indexOf('id: "shortcuts"');
    const connections = block.indexOf('id: "connections"');
    expect(themes).toBeGreaterThan(shortcuts);
    expect(themes).toBeGreaterThan(connections);
    expect(usage).toBeGreaterThan(themes);
  });

  it("shows Alt+T and Alt+U on the Themes and Usage nav rows", () => {
    const html = markup("themes");
    expect(html).toContain("Alt+T");
    expect(html).toContain("Alt+U");
    expect(html).toContain('aria-keyshortcuts="Alt+T"');
    expect(html).toContain('aria-keyshortcuts="Alt+U"');
  });

  it("spreads the phone icon strip across the full row and leaves the desktop column alone", () => {
    const html = markup("general");
    const nav = html.slice(html.indexOf("<nav"), html.indexOf("</nav>"));
    const strip = nav.match(/<div class="([^"]*max-md:flex-row[^"]*)"/)![1]!.split(" ");
    expect(strip).toContain("max-md:justify-between");
    expect(strip).not.toContain("justify-between");
    expect(nav.match(/<button/g)!.length).toBeGreaterThanOrEqual(7);
  });

  it("places Model index right after Usage with its shortcuts", () => {
    const source = readFileSync(join(here, "SettingsModal.tsx"), "utf8");
    const block = source.slice(source.indexOf("const SECTIONS"), source.indexOf("];", source.indexOf("const SECTIONS")));
    expect(block.indexOf('id: "models-index"')).toBeGreaterThan(block.indexOf('id: "usage"'));
    const html = markup("models-index");
    expect(html).toContain('aria-keyshortcuts="Alt+I"');
    expect(html).not.toContain("Ctrl+Shift+M");
    expect(html).toContain("Data as of");
  });

  it("keeps Skin out of General and on its own Themes tab", () => {
    const general = markup("general");
    expect(general).not.toContain("Skin");
    expect(general).not.toContain("Applies instantly and is remembered");
    expect(general).not.toContain('data-skin="kanagawa"');
    const themes = markup("themes");
    expect(themes).toContain("Skin");
    expect(themes).toContain('data-skin="kanagawa"');
  });

  it("flips the Terminal popups switch on General, off by default", () => {
    const popupsSwitch = /<button role="switch" aria-checked="(true|false)" aria-label="Terminal popups"/;
    expect(markup("general")).toContain("Notifications");
    expect(markup("general").match(popupsSwitch)?.[1]).toBe("false");
    saveTerminalPopups(true);
    expect(markup("general").match(popupsSwitch)?.[1]).toBe("true");
    saveTerminalPopups(false);
    expect(markup("general").match(popupsSwitch)?.[1]).toBe("false");
  });

  it("flips the Rainbow chat box switch on Themes, off by default", () => {
    expect(markup("general")).not.toContain("Rainbow chat box");
    const rainbowSwitch = /<button role="switch" aria-checked="(true|false)" aria-label="Rainbow chat box"/;
    expect(markup("themes").match(rainbowSwitch)?.[1]).toBe("false");
    saveRainbowBox(true);
    expect(markup("themes").match(rainbowSwitch)?.[1]).toBe("true");
    saveRainbowBox(false);
    expect(markup("themes").match(rainbowSwitch)?.[1]).toBe("false");
    const source = readFileSync(join(here, "SettingsModal.tsx"), "utf8");
    expect(source).toContain("onClick={() => saveRainbowBox(!on)}");
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

  it("keeps Connections quiet without Gemini key or zoo services", () => {
    const html = markup("connections");
    expect(html).not.toContain("Gemini API key");
    expect(html).not.toContain("Wink detects installed");
    expect(html).not.toContain("OpenCode API key");
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
    expect(html).not.toContain("Gemini API key");
    expect(html).not.toContain("OpenCode API key");
    expect(html).not.toContain("More services");
    expect(html).not.toMatch(/>Engines</);
  });

  it("compresses Language into a segmented row and Profile into compact chrome", () => {
    const source = readFileSync(join(here, "SettingsModal.tsx"), "utf8");
    const picker = readFileSync(join(here, "LanguagePicker.tsx"), "utf8");
    const profile = readFileSync(join(here, "ProfileFields.tsx"), "utf8");
    const primitives = readFileSync(join(here, "SettingsPrimitives.tsx"), "utf8");
    expect(picker).not.toContain("compact");
    expect(picker).not.toContain("flex-col gap-2");
    expect(picker).toMatch(/role="radiogroup"/);
    expect(picker).toContain("language.matchSystem");
    expect(picker).toContain("language.name.en");
    expect(picker).toContain("language.name.ko");
    expect(picker).toContain("language.matchSystemHint");
    expect(picker).toContain("aria-describedby");
    expect(picker).not.toMatch(/title=\{id === "system"/);
    expect(source).toContain("settings.profile.title");
    expect(source).not.toContain("compact");
    expect(profile).toContain("settings.profile.namePlaceholder");
    expect(profile).not.toContain("settings.profile.emailPlaceholder");
    expect(profile).toContain("settings.profile.save");
    expect(primitives).not.toContain("compact");
    const general = source.slice(source.indexOf('section === "general"'), source.indexOf('section === "connections"'));
    expect(general.indexOf("<LanguagePicker")).toBeGreaterThan(-1);
    expect(general.indexOf("<ToolCallsRow")).toBeGreaterThan(general.indexOf("<LanguagePicker"));
    expect(general).not.toContain("settings.skin.title");
    expect(general).not.toContain("<SkinPicker");
    const themes = source.slice(source.indexOf('section === "themes"'), source.indexOf('section === "engines"') === -1 ? undefined : source.indexOf('section === "engines"'));
    expect(themes).toContain("<SkinPicker");
    expect(themes).toContain("settings.skin.title");
  });

  it("orders General cards so Left/Right sits under Language and switches follow", () => {
    const source = readFileSync(join(here, "SettingsModal.tsx"), "utf8");
    const general = source.slice(source.indexOf('section === "general"'), source.indexOf('section === "connections"'));
    const order = ["<LanguagePicker", "<SidebarSideRow", "settings.profile.title", "<TerminalAppearanceRow", "<ToolCallsRow", "<NotificationsRow", "<VibrationRow", "<UpdatesRow", "data-settings-advanced"].map((marker) => general.indexOf(marker));
    expect(order.every((at) => at > -1)).toBe(true);
    expect(order).toEqual([...order].sort((a, b) => a - b));
  });

  it("puts phone notifications in the General Notifications card, not Connections", () => {
    const source = readFileSync(join(here, "SettingsModal.tsx"), "utf8");
    const row = source.slice(source.indexOf("function NotificationsRow"), source.indexOf("function RainbowBoxRow"));
    expect(row).toContain("<PhoneNotificationSettings");
    const connections = source.slice(source.indexOf('section === "connections"'), source.indexOf('section === "sync"'));
    expect(connections).toContain("<PhoneLinkSettings");
    expect(connections).not.toContain("<PhoneNotificationSettings");
    const search = readFileSync(join(here, "../lib/settings-search.ts"), "utf8");
    const generalKeys = search.slice(search.indexOf("  general: ["), search.indexOf("  themes: ["));
    expect(generalKeys).toContain("settings.phoneNotifications.title");
  });

  it("hides phone notifications in the desktop app", () => {
    const source = readFileSync(join(here, "SettingsModal.tsx"), "utf8");
    const row = source.slice(source.indexOf("function NotificationsRow"), source.indexOf("function RainbowBoxRow"));
    expect(row).toContain("{!window.ogb && <PhoneNotificationSettings />}");
  });

  it("shows Vibration only where a phone can vibrate", () => {
    const win = window as unknown as Record<string, unknown>;
    const matchMedia = (matches: boolean) => () => ({ matches });
    try {
      expect(markup("general")).not.toContain("Vibrate on send");
      win.matchMedia = matchMedia(false);
      win.navigator = { vibrate: () => true };
      expect(markup("general")).not.toContain("Vibrate on send");
      win.matchMedia = matchMedia(true);
      win.navigator = {};
      expect(markup("general")).not.toContain("Vibrate on send");
      win.navigator = { vibrate: () => true };
      expect(markup("general")).toContain("Vibrate on send");
    } finally {
      delete win.matchMedia;
      delete win.navigator;
    }
  });

  it("drops the on-this-device line from Sync", () => {
    expect(readFileSync(join(here, "SyncPanel.tsx"), "utf8")).not.toContain("settings.sync.localChats");
    expect(catalogs.en).not.toHaveProperty("settings.sync.localChats");
    expect(catalogs.ko).not.toHaveProperty("settings.sync.localChats");
  });

  it("labels Soft and Boxy as Corners with a tooltip", () => {
    expect(markup("themes")).toContain('title="Corners"');
  });

  it("splits Skin into Dark then Light groups covering every skin", () => {
    const html = markup("themes");
    const dark = html.indexOf(">Dark<");
    const light = html.indexOf(">Light<");
    expect(dark).toBeGreaterThan(-1);
    expect(light).toBeGreaterThan(dark);
    const ids = (part: string) => [...part.matchAll(/data-skin="([a-z-]+)"/g)].map(([, id]) => id);
    expect(ids(html.slice(dark, light))).toEqual(SKINS.filter((skin) => !LIGHT_SKIN_IDS.has(skin.id)).map((skin) => skin.id));
    expect(ids(html.slice(light))).toEqual(SKINS.filter((skin) => LIGHT_SKIN_IDS.has(skin.id)).map((skin) => skin.id));
    expect(ids(html)).toHaveLength(SKINS.length);
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

  it("keeps optional connections inside the More services body", () => {
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
    expect(before).not.toContain('section="gemini"');
    expect(before).not.toContain('section="opencodeGo"');
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

describe("updater missing app-update.yml fallback", () => {
  it("shows friendly fallback message when app-update.yml is missing (ENOENT)", () => {
    Object.defineProperty(window, "ogb", {
      value: { updater: { check: vi.fn(), download: vi.fn(), install: vi.fn() } },
      configurable: true,
      writable: true,
    });
    mock.updaterState = {
      status: "error",
      message: "Error: ENOENT: no such file or directory, open 'C:\\resources\\app-update.yml'",
    };
    const html = markup("general");
    expect(html.replace(/&#x27;/g, "'")).toContain("Updates aren't available in this build");
    expect(html).not.toContain("ENOENT");
    expect(html).not.toContain("app-update.yml");
  });
});

describe("updates card on the phone remote view", () => {
  it("renders from the proxied state without the preload bridge", () => {
    Object.defineProperty(window, "ogb", { value: undefined, configurable: true, writable: true });
    mock.updaterState = { status: "installing", appVersion: "1.0.52" };
    const html = markup("general");
    expect(html).toContain("Restarting to update");
    expect(html).toContain("v1.0.52");
    expect(html).toMatch(/<button[^>]*disabled=""[^>]*>Check for updates/);
  });

  it("stays hidden when the desktop updater is unavailable", () => {
    Object.defineProperty(window, "ogb", { value: undefined, configurable: true, writable: true });
    mock.updaterState = null;
    expect(markup("general")).not.toContain("Check for updates");
  });
});
