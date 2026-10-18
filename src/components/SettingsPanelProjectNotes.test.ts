// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { I18nProvider, persistPreference } from "@/lib/i18n";
import type { Bot } from "@/state/store";

const { mockDispatch } = vi.hoisted(() => ({ mockDispatch: vi.fn() }));

// oxlint-disable-next-line anti-slop/no-module-mocking -- Bot details reads the shared store; this harness only records the patch.
vi.mock("@/state/store", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/state/store")>();
  return {
    ...actual,
    useStore: () => ({
      state: { instances: [], bots: [], config: {}, mascotMotion: null },
      dispatch: mockDispatch,
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
vi.mock("./VoiceSettings", () => ({ VoiceSettings: () => null }));
// oxlint-disable-next-line anti-slop/no-module-mocking -- The avatar picker is outside the notes field.
vi.mock("./BotProfileAvatarCard", () => ({ BotProfileAvatarCard: () => null }));
// oxlint-disable-next-line anti-slop/no-module-mocking -- Cloud backend choices are outside the notes field.
vi.mock("./CloudBackendPicker", () => ({ CloudBackendPicker: () => null }));

import { SettingsPanel } from "./SettingsPanel";

const NOTES = "C:\\vault\\Orbit\\BRAIN.md";
// SAFETY: the panel reads id, name, modelSelection and projectNotes; the rest of Bot stays unused.
const bot = {
  id: "bot-1",
  threadId: "t1",
  name: "Mentor",
  title: "",
  description: "",
  notifications: false,
  color: "green",
  unread: false,
  modelSelection: { instanceId: "claude", model: "claude-3-5-sonnet", mode: "automatic" },
  messages: [],
} as Bot;

describe("SettingsPanel project notes", () => {
  let host: HTMLDivElement;
  let root: ReturnType<typeof createRoot>;
  const render = (value: Bot) =>
    act(async () => root.render(createElement(I18nProvider, null, createElement(SettingsPanel, { bot: value }))));

  beforeEach(() => {
    mockDispatch.mockClear();
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ text: "", truncated: false, topics: [] }))));
    host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);
  });

  afterEach(() => {
    root.unmount();
    host.remove();
    vi.unstubAllGlobals();
    persistPreference("en");
  });

  it.each(["en", "ko"] as const)("hides empty project notes in %s", async (locale) => {
    persistPreference(locale);
    await render(bot);
    expect(host.querySelector('input[aria-label="Project notes"], input[aria-label="프로젝트 노트"]')).toBeNull();
    expect(host.textContent).not.toContain(locale === "en" ? "Project notes" : "프로젝트 노트");
    expect(mockDispatch).not.toHaveBeenCalled();
  });

  it.each(["en", "ko"] as const)("preserves hidden project notes in %s", async (locale) => {
    persistPreference(locale);
    await render({ ...bot, projectNotes: NOTES });
    expect(host.querySelector('input[aria-label="Project notes"], input[aria-label="프로젝트 노트"]')).toBeNull();
    expect(host.textContent).not.toContain(NOTES);
    expect(mockDispatch).not.toHaveBeenCalled();
  });
});
