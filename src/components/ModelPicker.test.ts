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
      state: { instances: mockInstances },
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
  defaultRailOpen = false,
  defaultShowAllEngines = false,
) {
  return renderToStaticMarkup(
    createElement(
      I18nProvider,
      null,
      createElement(ModelPicker, {
        bot: { ...bot, modelSelection: selection },
        defaultOpen,
        defaultRailOpen,
        defaultShowAllEngines,
      }),
    ),
  );
}

const NON_FRIENDS_LABELS = ['aria-label="Kimi"', 'aria-label="Qwen"', 'aria-label="Cursor"', 'aria-label="Hermes"'];
const FRIENDS_LABELS = [
  'aria-label="Grok"',
  'aria-label="Claude"',
  'aria-label="Gemini API"',
  'aria-label="Gemini (Antigravity)"',
  'aria-label="Codex"',
  'aria-label="OpenCode"',
];

describe("ModelPicker friends chip", () => {
  it("paints Grok 4.6 on the chip while automatic is the mode", () => {
    const html = markup();
    expect(html).toContain("Grok 4.6");
    expect(html).not.toContain("Automatic");
    expect(html).not.toContain("Switch engine");
    expect(html).not.toContain("data-model-picker-content");
    expect(html).toContain('title="Orbit is choosing a working engine for this job. Currently Grok 4.6."');
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

  it("lets the automatic help sentence wrap instead of truncating it", () => {
    const html = markup(bot.modelSelection, true);
    expect(html).toContain("Keep the current engine when it works. Switch only when needed.");
    expect(html).toMatch(/leading-snug[^"]*"[^>]*>Keep the current engine when it works/);
    expect(html).not.toMatch(/truncate[^"]*"[^>]*>Keep the current engine when it works/);
  });

  it("shows Ready on the open engine pane, not the CLI --version dump", () => {
    const html = markup(bot.modelSelection, true);
    expect(html).toMatch(/bg-success\/10 text-success[^"]*"[^>]*>Ready</);
    expect(html).toContain('title="Grok · Ready"');
    expect(html).not.toContain("CLI 1.0.13");
    expect(html).not.toContain("CLI grok");
    expect(html).not.toContain("1.0.13");
    expect(html).not.toContain("5e9a58528b76");
    expect(html).not.toContain("[stable]");
  });

  it("keeps catalog order with one default badge and one check", () => {
    const html = markup({ instanceId: "grok", model: "grok-4.5", mode: "pinned" }, true);
    const list = html.slice(html.indexOf("data-model-picker-content"));
    const grok46 = list.indexOf("Grok 4.6");
    const grok45 = list.indexOf("Grok 4.5");
    const defaultAt = list.indexOf("Default");
    expect(grok46).toBeGreaterThan(-1);
    expect(grok45).toBeGreaterThan(grok46);
    expect(defaultAt).toBeGreaterThan(grok46);
    expect(defaultAt).toBeLessThan(grok45);
  });

  it("opens the custom pane when defaultOpen and the selected model is custom", () => {
    const html = markup({ instanceId: "grok", model: "omlx::local", mode: "pinned" }, true);
    const list = html.slice(html.indexOf("data-model-picker-content"));
    expect(list).toContain("Run this agent with a model already on your machine.");
    expect(list).toContain("local (oMLX)");
    expect(list).not.toContain("Suggested");
  });

  it("folds the Cloud/Local engine rail while the open picker is idle", () => {
    const html = markup(bot.modelSelection, true);
    const list = html.slice(html.indexOf("data-model-picker-content"));
    expect(list).toContain("Grok 4.6");
    expect(list).toContain("Automatic");
    expect(list).toMatch(/bg-success\/10 text-success[^"]*"[^>]*>Ready</);
    expect(list).toContain("Switch engine");
    expect(list).not.toContain("w-14 shrink-0");
    expect(list).not.toContain('aria-label="Claude"');
    expect(list).not.toContain("Fable 5.1");
    for (const label of NON_FRIENDS_LABELS) expect(list).not.toContain(label);
    expect(list).not.toContain("Use a local model");
  });

  it("shows the friends-only engine rail when the user asks to switch", () => {
    const html = markup(bot.modelSelection, true, true);
    const list = html.slice(html.indexOf("data-model-picker-content"));
    expect(list).toContain("data-engine-rail");
    expect(list).toContain("w-14 shrink-0");
    expect(list).toContain('aria-label="Claude"');
    expect(list).toContain('title="Claude · Ready"');
    expect(list).toContain("Grok 4.6");
    for (const label of FRIENDS_LABELS) expect(list).toContain(label);
    for (const label of NON_FRIENDS_LABELS) expect(list).not.toContain(label);
    expect(list).toContain("Show all engines · 4 more");
    expect(list).not.toContain("Use a local model");
    expect(list).not.toContain(">Local<");
  });

  it("reveals the rest of the fleet after Show all engines", () => {
    const html = markup(bot.modelSelection, true, true, true);
    const list = html.slice(html.indexOf("data-model-picker-content"));
    for (const label of FRIENDS_LABELS) expect(list).toContain(label);
    for (const label of NON_FRIENDS_LABELS) expect(list).toContain(label);
    expect(list).toContain("Show fewer engines");
    expect(list).toContain("Use a local model");
    expect(list).toContain(">Local<");
    expect(list).toContain('aria-label="Hermes"');
  });

  it("keeps the active non-friends engine on the folded friends rail", () => {
    const html = markup({ instanceId: "kimi", model: "kimi-default", mode: "pinned" }, true, true);
    const list = html.slice(html.indexOf("data-model-picker-content"));
    expect(list).toContain('aria-label="Kimi"');
    expect(list).not.toContain('aria-label="Qwen"');
    expect(list).not.toContain('aria-label="Cursor"');
    expect(list).toContain("Show all engines · 3 more");
  });
});
