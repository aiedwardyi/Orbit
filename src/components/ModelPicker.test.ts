import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import { I18nProvider } from "@/lib/i18n";
import type { Bot } from "@/state/store";

const { mockInstances } = vi.hoisted(() => {
  const readyEngine = (
    instanceId: string,
    driverKind: string,
    displayName: string,
    extra: Record<string, unknown> = {},
  ) => ({
    instanceId,
    driverKind,
    displayName,
    snapshot: { state: "available" as const, authenticated: true, version: "1.0.0" },
    models: {
      default: `${instanceId}-default`,
      options: [{ id: `${instanceId}-default`, label: `${displayName} default` }],
    },
    ...extra,
  });
  return {
    mockInstances: [
      {
        instanceId: "grok",
        driverKind: "grokAgent",
        displayName: "Grok",
        snapshot: {
          state: "available" as const,
          authenticated: true,
          version: "grok 1.0.13 (5e9a58528b76) [stable]",
        },
        models: {
          default: "grok-4.6",
          options: [
            { id: "grok-4.6", label: "Grok 4.6" },
            { id: "grok-4.5", label: "Grok 4.5" },
            { id: "omlx::local", label: "local (oMLX)", custom: true },
          ],
        },
      },
      {
        instanceId: "claude",
        driverKind: "claudeAgent",
        displayName: "Claude",
        snapshot: { state: "available" as const, authenticated: true, version: "1.0.0" },
        models: {
          default: "claude-fable-5-1",
          options: [{ id: "claude-fable-5-1", label: "Fable 5.1" }],
        },
      },
      readyEngine("gemini", "geminiAgent", "Gemini API"),
      readyEngine("antigravity", "antigravityAgent", "Gemini (Antigravity)"),
      readyEngine("codex", "codex", "Codex"),
      readyEngine("opencode", "opencodeGo", "OpenCode"),
      readyEngine("kimi", "kimiAgent", "Kimi"),
      readyEngine("qwen", "qwenAgent", "Qwen"),
      readyEngine("cursor", "cursorAgent", "Cursor"),
      readyEngine("hermes", "hermesAgent", "Hermes", { access: "custom" }),
    ],
  };
});

vi.mock("@/state/store", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/state/store")>();
  return {
    ...actual,
    useStore: () => ({
      state: { instances: mockInstances, selectedId: "bot-1" },
      dispatch: () => undefined,
      refreshInstances: async () => undefined,
    }),
  };
});

import { ModelPicker } from "./ModelPicker";

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

function markup(
  selection: Bot["modelSelection"] = bot.modelSelection,
  defaultOpen = false,
) {
  return renderToStaticMarkup(
    createElement(
      I18nProvider,
      null,
      createElement(ModelPicker, {
        bot: { ...bot, modelSelection: selection },
        defaultOpen,
      }),
    ),
  );
}

const NON_FRIENDS_LABELS = [
  'data-model-row="kimi"',
  'data-model-row="qwen"',
  'data-model-row="cursor"',
  'data-model-row="hermes"',
  'data-model-row="gemini"',
];
const FRIENDS_LABELS = [
  'data-model-row="grok"',
  'data-model-row="claude"',
  'data-model-row="codex"',
  'data-model-row="antigravity"',
  'data-model-row="opencode"',
];

function platformMarkup(platform: string, defaultOpen = false) {
  vi.stubGlobal("navigator", { platform });
  try {
    return markup(bot.modelSelection, defaultOpen);
  } finally {
    vi.unstubAllGlobals();
  }
}

describe("ModelPicker friends chip", () => {
  it.each([["MacIntel", "Option"], ["Win32", "Alt"]])("paints Grok 4.6 with the %s shortcut while automatic is the mode", (platform, shortcut) => {
    const html = platformMarkup(platform);
    expect(html).toContain("Grok 4.6");
    expect(html).not.toContain("Automatic");
    expect(html).not.toContain("Current model");
    expect(html).not.toContain("Switch engine");
    expect(html).not.toContain("data-model-picker-content");
    expect(html).toContain(`title="Stay on this engine while it works. Currently Grok 4.6. (${shortcut}+P)"`);
  });

  it("folds the chip to the engine name in a narrow chat header", () => {
    const html = markup();
    expect(html).toMatch(/max-w-\[160px\] truncate[^"]*@max-4xl\/chathead:hidden"[^>]*>Grok 4\.6</);
    expect(html).toMatch(/hidden max-w-\[96px\] truncate @max-4xl\/chathead:inline"[^>]*>Grok</);
    expect(html).toContain("@max-4xl/chathead:hidden");
  });

  it("shows unresolved when automatic has no live model", () => {
    const html = markup({ instanceId: "", model: "", mode: "automatic" });
    expect(html).toContain(">unresolved<");
    expect(html).toContain("Currently unresolved.");
  });

  it("names the current model on the Current model row", () => {
    const html = markup(bot.modelSelection, true);
    expect(html).toContain("Current model");
    expect(html).toContain("Grok 4.6");
    expect(html).not.toContain("stay on this while it works");
    expect(html).toContain('class="break-all text-ink">grok-4.6<');
  });

  it("shows Ready on the open engine pane, not the CLI --version dump", () => {
    const html = markup(bot.modelSelection, true);
    expect(html).toMatch(/bg-success\/10 text-success[^"]*"[^>]*>Ready</);
    expect(html).not.toContain("CLI 1.0.13");
    expect(html).not.toContain("CLI grok");
    expect(html).not.toContain("1.0.13");
    expect(html).not.toContain("5e9a58528b76");
    expect(html).not.toContain("[stable]");
  });

  it("keeps the ragged row in catalog order with one selected cell", () => {
    const html = markup({ instanceId: "grok", model: "grok-4.5", mode: "pinned" }, true);
    const list = html.slice(html.indexOf("data-model-picker-content"));
    const grok46 = list.indexOf("Grok 4.6");
    const grok45 = list.indexOf("Grok 4.5");
    expect(grok46).toBeGreaterThan(-1);
    expect(grok45).toBeGreaterThan(grok46);
    expect(list.match(/aria-pressed="true"/g)).toHaveLength(1);
    expect(list).toContain('data-model-cell="grok-4.5" aria-pressed="true"');
  });

  it("gives a pinned custom model its own selected cell", () => {
    const html = markup({ instanceId: "grok", model: "omlx::local", mode: "pinned" }, true);
    const list = html.slice(html.indexOf("data-model-picker-content"));
    expect(list).toContain('data-model-cell="omlx::local" aria-pressed="true"');
    expect(list).toContain("local (oMLX)");
    expect(list).not.toContain("Suggested");
  });

  it.each([["MacIntel", "Option"], ["Win32", "Alt"]])("opens a modal with ordered model groups and %s keycap bindings", (platform, shortcut) => {
    for (const [id, model] of [["antigravity", "gemini-3.8-flash-high"], ["codex", "gpt-6-astra"], ["opencode", "meta/muse-spark-1.3"]]) {
      mockInstances.find((instance) => instance.instanceId === id)!.models = { default: model!, options: [{ id: model!, label: model! }] };
    }
    const html = platformMarkup(platform, true);
    const list = html.slice(html.indexOf("data-model-picker-content"));
    expect(list).toContain('role="dialog" aria-modal="true"');
    for (const key of [shortcut, "P", "↑", "↓", "←", "→", "Enter", "Esc"]) expect(list).toContain(`<kbd>${key}</kbd>`);
    expect(list).toContain("</kbd>Model");
    expect(list).toContain("</kbd>Effort");
    expect(list).toContain('aria-label="Models"');
    expect(list).not.toContain(">Cloud<");
    expect(list).toContain("Grok 4.6");
    expect(list).toContain("Current model");
    expect(list).not.toContain("Automatic");
    expect(list).toMatch(/bg-success\/10 text-success[^"]*"[^>]*>Ready</);
    expect(list).not.toMatch(/aria-label="Switch engine"[^>]*aria-expanded/);
    for (const label of FRIENDS_LABELS) expect(list).toContain(label);
    for (const label of NON_FRIENDS_LABELS) expect(list).not.toContain(label);
    expect(list).not.toContain("Show all engines");
    expect(list).not.toContain(">Local<");
    expect(list).toContain("Use a local model");
    const grok = list.indexOf('data-model-row="grok"');
    const claude = list.indexOf('data-model-row="claude"');
    const codex = list.indexOf('data-model-row="codex"');
    const antigravity = list.indexOf('data-model-row="antigravity"');
    const opencode = list.indexOf('data-model-row="opencode"');
    expect(claude).toBeGreaterThan(-1);
    expect(codex).toBeGreaterThan(claude);
    expect(grok).toBeGreaterThan(codex);
    expect(antigravity).toBeGreaterThan(grok);
    expect(opencode).toBeGreaterThan(antigravity);
  });

  it("preserves a non-featured pin in its own row without exposing other engines", () => {
    const html = markup({ instanceId: "kimi", model: "kimi-default", mode: "pinned" }, true);
    const list = html.slice(html.indexOf("data-model-picker-content"));
    expect(list).toContain('data-model-row="kimi"');
    expect(list).toContain('data-model-cell="kimi-default" aria-pressed="true"');
    expect(list).not.toContain('data-model-row="gemini"');
    expect(list).not.toContain("Show all engines");
  });
});
