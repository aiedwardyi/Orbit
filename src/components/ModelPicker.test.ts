import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import { I18nProvider } from "@/lib/i18n";
import { modelFamilyAccent } from "@/lib/model-chip";
import type { Bot, InstanceInfo } from "@/state/store";

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
      readyEngine("muse", "museAgent", "Meta Muse"),
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

import { ModelPicker, ModelPickerControl } from "./ModelPicker";

const antigravityTiered: InstanceInfo = {
  instanceId: "antigravity",
  driverKind: "antigravityAgent",
  displayName: "Gemini (Antigravity)",
  snapshot: { state: "available" as const, authenticated: true, version: "1.0.0" },
  models: {
    default: "gemini-3.8-flash-high",
    options: [
      { id: "gemini-3.8-flash-high", label: "Gemini 3.8 Flash (High)" },
      { id: "gemini-3.8-flash-medium", label: "Gemini 3.8 Flash (Medium)" },
      { id: "gemini-3.8-flash-low", label: "Gemini 3.8 Flash (Low)" },
    ],
  },
  capabilities: {},
};

function tieredMarkup(selection: Bot["modelSelection"]) {
  return renderToStaticMarkup(
    createElement(
      I18nProvider,
      null,
      createElement(ModelPickerControl, {
        bot: { ...bot, modelSelection: selection },
        store: {
          state: { instances: [antigravityTiered], selectedId: "bot-1" },
          dispatch: () => undefined,
          refreshInstances: async () => undefined,
        },
      }),
    ),
  );
}

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
  'data-model-row="muse"',
];

function platformMarkup(platform: string, defaultOpen = false) {
  vi.stubGlobal("navigator", { platform });
  try {
    return markup(bot.modelSelection, defaultOpen);
  } finally {
    vi.unstubAllGlobals();
  }
}

/** Visible chip text: strip tags so model + effort read as one line. */
function chipText(html: string): string {
  return html.replace(/<[^>]*>/g, "");
}

describe("ModelPicker friends chip", () => {
  it.each([["MacIntel", "Option"], ["Win32", "Alt"]])("labels the %s open/close shortcut", (platform, shortcut) => {
    expect(platformMarkup(platform, true)).toContain(`<kbd>${shortcut}</kbd><kbd>M</kbd>Open/Close`);
  });

  it.each([["MacIntel", "Option"], ["Win32", "Alt"]])("paints Grok 4.6 with the %s shortcut while automatic is the mode", (platform, shortcut) => {
    const html = platformMarkup(platform);
    expect(html).toContain("Grok 4.6");
    expect(html).not.toContain("Automatic");
    expect(html).not.toContain("Current model");
    expect(html).not.toContain("Switch engine");
    expect(html).not.toContain("data-model-picker-content");
    expect(html).toContain(`title="Stay on this engine while it works. Currently Grok 4.6. (${shortcut}+M)"`);
  });

  it("folds the chip to the engine name in a narrow chat header", () => {
    const html = markup();
    expect(html).toMatch(/max-w-\[160px\] truncate[^"]*@max-4xl\/chathead:hidden"[^>]*>Grok 4\.6</);
    expect(html).toMatch(/hidden max-w-\[96px\] truncate @max-4xl\/chathead:inline"[^>]*>Grok</);
    expect(html).toContain("@max-4xl/chathead:hidden");
  });

  it("shows effort beside the model name wearing the family accent", () => {
    const html = markup({ instanceId: "grok", model: "grok-4.6", mode: "automatic", effort: "high" });
    expect(chipText(html)).toContain("Grok 4.6 · High");
    expect(html).toContain("data-model-effort");
    expect(html).not.toContain(">high<");
    expect(html).toContain("#8b929c");
  });

  it("shows a derived effort dot for a tier-suffixed model without selection.effort", () => {
    const html = tieredMarkup({ instanceId: "antigravity", model: "gemini-3.8-flash-high", mode: "pinned" });
    expect(chipText(html)).toContain("Gemini 3.8 Flash · High");
    expect(html).not.toContain("(High)");
    expect(html).toContain("data-model-effort");
    expect(html).not.toContain(">high<");
    expect(html).toContain("#aa7bfa");
  });

  it.each([
    ["codex", "codex-default", "Codex default · Medium"],
    ["claude", "claude-fable-5-1", "Fable 5.1 · Medium"],
    ["muse", "muse-default", "Meta Muse default · Medium"],
    ["antigravity", "antigravity-default", "Gemini (Antigravity) default · Medium"],
    ["grok", "grok-4.6", "Grok 4.6 · Medium"],
  ])("shows the %s chip as one-line Model · Effort", (instanceId, model, chip) => {
    const html = markup({ instanceId, model, mode: "pinned", effort: "medium" });
    expect(chipText(html)).toContain(chip);
    expect(html).toContain("data-model-effort");
    expect(html).toContain("whitespace-nowrap");
  });

  it("shortens the contributor card with the full name in aria/title", () => {
    const museTwo: InstanceInfo = {
      instanceId: "muse",
      driverKind: "museAgent",
      displayName: "Meta Muse",
      snapshot: { state: "available" as const, authenticated: true, version: "1.0.0" },
      models: {
        default: "muse-spark-1.3",
        options: [
          { id: "muse-spark-1.3", label: "Meta Muse 1.3" },
          { id: "muse-spark-1.3-contributor", label: "Meta Muse 1.3 Contributor" },
        ],
      },
      capabilities: {},
    };
    const html = renderToStaticMarkup(
      createElement(
        I18nProvider,
        null,
        createElement(ModelPickerControl, {
          bot: { ...bot, modelSelection: { instanceId: "muse", model: "muse-spark-1.3-contributor", mode: "pinned" } },
          store: {
            state: { instances: [museTwo], selectedId: "bot-1" },
            dispatch: () => undefined,
            refreshInstances: async () => undefined,
          },
          defaultOpen: true,
        }),
      ),
    );
    const list = html.slice(html.indexOf("data-model-picker-content"));
    expect(list).toContain('data-model-cell="muse-spark-1.3-contributor" aria-pressed="true"');
    expect(list).toContain("model-cross-name\">Meta Muse 1.3<");
    expect(list).toContain(">Contrib<");
    expect(list).toContain('aria-label="Meta Muse 1.3 Contributor"');
    expect(list).toContain('title="Meta Muse 1.3 Contributor"');
    expect(list).not.toContain("model-cross-name\">Meta Muse 1.3 Contributor<");
  });

  it("keeps a lone legacy tier label with no badge when nothing derives", () => {
    const legacy: InstanceInfo = {
      ...antigravityTiered,
      models: {
        default: "gpt-oss-120b-medium",
        options: [{ id: "gpt-oss-120b-medium", label: "GPT-OSS 120B (Medium)" }],
      },
    };
    const html = renderToStaticMarkup(
      createElement(
        I18nProvider,
        null,
        createElement(ModelPickerControl, {
          bot: { ...bot, modelSelection: { instanceId: "antigravity", model: "gpt-oss-120b-medium", mode: "pinned" } },
          store: {
            state: { instances: [legacy], selectedId: "bot-1" },
            dispatch: () => undefined,
            refreshInstances: async () => undefined,
          },
        }),
      ),
    );
    expect(html).toContain("GPT-OSS 120B (Medium)");
    expect(html).not.toContain("data-model-effort");
  });

  it.each([
    ["codex", "codex-default", "#3594ff"],
    ["claude", "claude-fable-5-1", "#ed6549"],
    ["muse", "muse-default", "#43ce8b"],
    ["antigravity", "antigravity-default", "#aa7bfa"],
    ["grok", "grok-4.6", "#8b929c"],
  ])("paints the %s effort marker with %s", (instanceId, model, accent) => {
    const html = markup({ instanceId, model, mode: "pinned", effort: "medium" });
    expect(html).toContain("data-model-effort");
    expect(html).toContain("· Medium");
    expect(html).not.toContain(">medium<");
    expect(html).toContain(accent);
  });

  it("degrades to name-only when effort is absent", () => {
    const html = markup();
    expect(html).toContain("Grok 4.6");
    expect(html).not.toContain("data-model-effort");
    expect(html).not.toContain("#8b929c");
  });

  it("keeps effort visible while the model label folds in a narrow chat header", () => {
    const html = markup({ instanceId: "grok", model: "grok-4.6", mode: "automatic", effort: "high" });
    // the label still folds to the engine name below the breakpoint…
    expect(html).toMatch(/max-w-\[160px\] truncate[^"]*@max-4xl\/chathead:hidden/);
    expect(html).toMatch(/hidden max-w-\[96px\] truncate @max-4xl\/chathead:inline/);
    // …but the effort badge never folds away, dot included
    expect(html).toContain("data-model-effort");
    expect(html).not.toMatch(/data-model-effort[^>]*@max-4xl\/chathead:hidden/);
  });

  it.each(["ledger", "midnight"])("keeps the accent dot and effort visible beside a long label under the %s skin", (skin) => {
    const longLabel: InstanceInfo = {
      instanceId: "grok",
      driverKind: "grokAgent",
      displayName: "Northwind",
      snapshot: { state: "available" as const, authenticated: true, version: "1.0.0" },
      models: {
        default: "northwind-9-contributor",
        options: [{ id: "northwind-9-contributor", label: "Northwind 9 Contributor Extended Edition" }],
      },
    };
    // narrow header: truncation is CSS-driven, so the test pins the structure
    // that guarantees it — only the label side may shrink.
    const html = renderToStaticMarkup(
      createElement("div", { "data-skin": skin, style: { width: 240 } },
        createElement(
          I18nProvider,
          null,
          createElement(ModelPickerControl, {
            bot: { ...bot, modelSelection: { instanceId: "grok", model: "northwind-9-contributor", mode: "pinned", effort: "high" } },
            store: {
              state: { instances: [longLabel], selectedId: "bot-1" },
              dispatch: () => undefined,
              refreshInstances: async () => undefined,
            },
          }),
        )),
    );
    expect(html).toContain(`data-skin="${skin}"`);
    expect(html).toContain("Northwind 9 Contributor Extended Edition");
    expect(html).toMatch(/min-w-0 max-w-\[160px\] truncate/);
    expect(html).toMatch(/data-model-effort[^>]*shrink-0/);
    // palette lookup, not a hardcoded hex: the dot must wear the family's
    // resolved accent, whatever the palette table holds.
    expect(html).toContain(`background-color:${modelFamilyAccent("grokAgent")}`);
    expect(chipText(html)).toContain("Northwind 9 Contributor Extended Edition · High");
    expect(html).not.toContain(">high<");
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
    for (const [id, model] of [["antigravity", "gemini-3.8-flash-high"], ["codex", "gpt-6-astra"], ["muse", "muse-spark-1.3"]]) {
      mockInstances.find((instance) => instance.instanceId === id)!.models = { default: model!, options: [{ id: model!, label: model! }] };
    }
    const html = platformMarkup(platform, true);
    const list = html.slice(html.indexOf("data-model-picker-content"));
    expect(list).toContain('role="dialog" aria-modal="true"');
    for (const key of [shortcut, "M", "↑", "↓", "←", "→", "Enter", "Esc"]) expect(list).toContain(`<kbd>${key}</kbd>`);
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
    const muse = list.indexOf('data-model-row="muse"');
    expect(claude).toBeGreaterThan(-1);
    expect(codex).toBeGreaterThan(claude);
    expect(grok).toBeGreaterThan(codex);
    expect(antigravity).toBeGreaterThan(grok);
    expect(muse).toBeGreaterThan(antigravity);
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

describe("ModelPicker centre guides", () => {
  it("draws no crosshair guide lines in any theme", () => {
    const here = dirname(fileURLToPath(import.meta.url));
    const css = readFileSync(join(here, "ModelPicker.css"), "utf8");
    expect(css).not.toContain(".model-cross-column::before");
    expect(css).not.toContain(".model-cross-efforts::before");
  });
});
