// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { I18nProvider } from "@/lib/i18n";
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
  const input = () => host.querySelector<HTMLInputElement>('input[aria-label="Project notes"]')!;
  const card = () => input().closest("div.rounded-xl")!;
  const button = (label: string) => Array.from(card().querySelectorAll("button")).find((b) => b.textContent === label);
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
  });

  it("sits under the project folder and saves a typed path", async () => {
    await render(bot);
    const labels = Array.from(host.querySelectorAll(".text-\\[15px\\]")).map((node) => node.textContent);
    expect(labels.indexOf("Project notes")).toBe(labels.indexOf("Project folder") + 1);
    expect(input().placeholder).toBe("Path to a notes file, like BRAIN.md");
    expect(button("Clear")).toBeUndefined();
    await act(async () => {
      Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")!.set!.call(input(), `  ${NOTES} `);
      input().dispatchEvent(new Event("input", { bubbles: true }));
    });
    await act(async () => button("Save")!.click());
    expect(mockDispatch).toHaveBeenCalledWith({ type: "updateBot", botId: "bot-1", patch: { projectNotes: NOTES } });
  });

  it("clears a set path", async () => {
    await render({ ...bot, projectNotes: NOTES });
    expect(input().value).toBe(NOTES);
    await act(async () => button("Clear")!.click());
    expect(mockDispatch).toHaveBeenCalledWith({ type: "updateBot", botId: "bot-1", patch: { projectNotes: null } });
  });
});
