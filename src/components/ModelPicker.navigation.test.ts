import "./ProfileFields.test-dom.ts";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";

import { I18nProvider } from "@/lib/i18n";
import type { Bot, InstanceInfo, ModelSelection } from "@/state/store";

const instances: InstanceInfo[] = [];
const mock = {
  instances,
  dispatch: vi.fn(),
  refreshInstances: vi.fn(async () => undefined),
};

import { ModelPickerControl } from "./ModelPicker";

let root: Root;

function engine(instanceId: string, driverKind: string, ids: string[], effortLevels?: NonNullable<InstanceInfo["capabilities"]>["effortLevels"]): InstanceInfo {
  return {
    instanceId, driverKind, displayName: instanceId,
    snapshot: { state: "available", authenticated: true },
    models: { default: ids[0]!, options: ids.map((id) => ({ id, label: id })) },
    capabilities: effortLevels ? { effortLevels } : {},
  };
}

async function mount(selection: ModelSelection, defaultOpen = true, contained = false, selectedId = "bot-1") {
  const host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  await act(async () => {
    const bot: Bot = { id: "bot-1", threadId: "thread-1", name: "Picker", title: "", description: "", color: "green", notifications: false, unread: false, messages: [], modelSelection: selection };
    root.render(createElement(I18nProvider, null, createElement(ModelPickerControl, {
      bot,
      store: { state: { instances: mock.instances, selectedId }, dispatch: mock.dispatch, refreshInstances: mock.refreshInstances },
      defaultOpen,
      contained,
    })));
  });
}

async function key(key: string) {
  await act(async () => {
    (document.activeElement ?? document.body).dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true }));
  });
}

afterEach(async () => {
  await act(async () => root?.unmount());
  document.body.replaceChildren();
  mock.dispatch.mockReset();
});

describe("ModelPicker cross navigation", () => {
  it.each([".model-cross-options", ".model-cross-custom"])("preserves native wheel scrolling over %s", async (selector) => {
    const instance = engine("grok", "grokAgent", ["grok-4.6", "grok-4.5"]);
    instance.models.options.push({ id: "provider::custom-model", label: "Custom model", custom: true });
    mock.instances = [instance];
    await mount({ instanceId: "grok", model: "grok-4.6", mode: "pinned" });
    await act(async () => Array.from(document.querySelectorAll("button")).find((button) => button.textContent?.includes("Use a local model"))!.click());
    const event = new window.WheelEvent("wheel", { deltaY: 120, bubbles: true, cancelable: true });
    await act(async () => document.querySelector(selector)!.firstElementChild!.dispatchEvent(event));
    expect(event.defaultPrevented).toBe(false);
    expect(document.querySelector('[data-model-cell="grok-4.6"][aria-pressed="true"]')).not.toBeNull();
    expect(document.querySelector(".model-cross-custom")).not.toBeNull();
    expect(mock.dispatch).not.toHaveBeenCalled();
  });

  it.each(["retired/exact-model:pin", "unmapped-model"])("selects the first effort with Right from an unset effort for %s", async (model) => {
    mock.instances = [engine("grok", "grokAgent", ["grok-4.6", "unmapped-model"], ["low", "medium", "high"])];
    await mount({ instanceId: "grok", model, mode: "pinned" });
    expect(document.querySelector('[data-picker-effort][aria-pressed="true"]')).toBeNull();
    await key("ArrowRight");
    expect(document.querySelector('[data-picker-effort="low"][aria-pressed="true"]')).not.toBeNull();
    await key("Enter");
    expect(mock.dispatch.mock.calls[0]?.[0].selection).toEqual({ instanceId: "grok", model, mode: "pinned", effort: "low" });
  });

  it.each([120, -120])("moves one model per wheel notch %s and keeps effort", async (deltaY) => {
    mock.instances = [engine("claude", "claudeAgent", ["claude-fable-5-1", "claude-fable-5", "claude-opus-5"], ["low", "medium", "high", "xhigh", "max"])];
    await mount({ instanceId: "claude", model: "claude-fable-5", mode: "pinned", effort: "medium" });
    const event = new window.WheelEvent("wheel", { deltaY, bubbles: true, cancelable: true });
    await act(async () => document.querySelector(".model-cross-stage")!.dispatchEvent(event));
    expect(event.defaultPrevented).toBe(true);
    await key("Enter");
    expect(mock.dispatch.mock.calls[0]?.[0].selection).toEqual({
      instanceId: "claude", model: deltaY > 0 ? "claude-opus-5" : "claude-fable-5-1", mode: "pinned", effort: "medium",
    });
  });

  it("labels Alt+M Close and cancels the draft", async () => {
    mock.instances = [engine("grok", "grokAgent", ["grok-4.6", "grok-4.5"])];
    await mount({ instanceId: "grok", model: "grok-4.6", mode: "pinned" });
    expect(document.querySelector(".model-cross-binding")?.textContent).toBe("AltMClose");
    await key("ArrowDown");
    await act(async () => document.querySelector('[role="dialog"]')!.dispatchEvent(new KeyboardEvent("keydown", { code: "KeyM", altKey: true, bubbles: true })));
    expect(document.querySelector('[role="dialog"]')).toBeNull();
    expect(mock.dispatch).not.toHaveBeenCalled();
  });

  it("counts wheel notches delivered before the next render", async () => {
    mock.instances = [engine("claude", "claudeAgent", ["claude-fable-5-1", "claude-fable-5", "claude-opus-5"], ["low", "medium", "high"])];
    await mount({ instanceId: "claude", model: "claude-fable-5-1", mode: "pinned", effort: "medium" });
    await act(async () => {
      for (let notch = 0; notch < 2; notch++) {
        document.querySelector(".model-cross-stage")!.dispatchEvent(new window.WheelEvent("wheel", { deltaY: 120, bubbles: true, cancelable: true }));
      }
    });
    await key("Enter");
    expect(mock.dispatch.mock.calls[0]?.[0].selection).toEqual({ instanceId: "claude", model: "claude-opus-5", mode: "pinned", effort: "medium" });
  });

  it.each([
    ["claudeAgent", "claude-fable-5-1", "high"],
    ["codex", "gpt-6-astra", "low"],
    ["codex", "gpt-5.6-sol", "low"],
    ["codex", "gpt-5.6-terra", "medium"],
    ["codex", "gpt-5.6-luna", "medium"],
    ["grokAgent", "grok-4.6", "high"],
  ])("opens and saves %s %s with its real default %s", async (driverKind, model, effort) => {
    mock.instances = [engine("engine", driverKind, [model], ["low", "medium", "high", "xhigh", "max"])];
    await mount({ instanceId: "engine", model, mode: "pinned" });
    expect(document.querySelector('[data-picker-effort="default"]')).toBeNull();
    expect(document.querySelector('[data-picker-effort][aria-pressed="true"]')?.getAttribute("data-picker-effort")).toBe(effort);
    await key("Enter");
    expect(mock.dispatch.mock.calls[0]?.[0].selection).toEqual({ instanceId: "engine", model, mode: "pinned", effort });
  });

  it.each([
    ["grokAgent", "console-sol-2", "grok"],
    ["grokAgent", "nebula-opus", "grok"],
    ["grokAgent", "gpt-5.6-sol", "grok"],
    ["opencodeGo", "claude-opus-5", "opencode"],
    ["opencodeGo", "gpt-5.6-sol", "opencode"],
    ["geminiAgent", "gemini-3.8-pro", "gemini"],
    ["antigravityAgent", "gemini-3.8-flash-low", "gemini"],
    ["codex", "nebula-opus", "gpt"],
    ["claudeAgent", "console-sol-2", "claude"],
    ["unknown", "claude-opus-5", "grok"],
  ])("uses the %s engine family for %s", async (driverKind, model, family) => {
    mock.instances = [engine("engine", driverKind, [model])];
    await mount({ instanceId: "engine", model, mode: "pinned" });
    expect(document.querySelector("[data-picker-family]")?.getAttribute("data-picker-family")).toBe(family);
  });

  it("cancels when clicking the empty backdrop around the cross", async () => {
    mock.instances = [engine("grok", "grokAgent", ["grok-4.6"])];
    await mount({ instanceId: "grok", model: "grok-4.6", mode: "pinned" });
    await act(async () => document.querySelector(".model-cross-plane")!.dispatchEvent(new MouseEvent("mousedown", { bubbles: true })));
    expect(document.querySelector('[data-model-picker-content]')).toBeNull();
    expect(mock.dispatch).not.toHaveBeenCalled();
  });

  it("moves horizontally through Antigravity model ids without sending effort", async () => {
    mock.instances = [engine("antigravity", "antigravityAgent", ["gemini-3.8-flash-high", "gemini-3.8-flash-medium", "gemini-3.8-flash-low"])];
    await mount({ instanceId: "antigravity", model: "gemini-3.8-flash-low", mode: "pinned" });
    await key("ArrowRight");
    await key("Enter");
    expect(mock.dispatch).toHaveBeenCalledExactlyOnceWith({
      type: "setModel", botId: "bot-1",
      selection: { instanceId: "antigravity", model: "gemini-3.8-flash-medium", mode: "pinned" },
    });
    expect(mock.dispatch.mock.calls[0]?.[0].selection).not.toHaveProperty("effort");
  });

  it.each([
    ["grok", "grokAgent", "grok-4.5"],
    ["claude", "claudeAgent", "claude-sonnet-5"],
  ])("moves horizontally through %s effort without changing the model id", async (instanceId, driverKind, model) => {
    mock.instances = [engine(instanceId, driverKind, [model], ["low", "medium", "high"])];
    await mount({ instanceId, model, mode: "pinned", effort: "low" });
    await key("ArrowRight");
    await key("Enter");
    expect(mock.dispatch).toHaveBeenCalledExactlyOnceWith({
      type: "setModel", botId: "bot-1", selection: { instanceId, model, mode: "pinned", effort: "medium" },
    });
  });

  it("keeps an off-list id verbatim when changing effort on the horizontal axis", async () => {
    mock.instances = [engine("grok", "grokAgent", ["grok-4.6"], ["low", "medium", "high"])];
    await mount({ instanceId: "grok", model: "retired/exact-model:pin", mode: "pinned", effort: "low" });
    await key("ArrowRight");
    await key("Enter");
    expect(mock.dispatch.mock.calls[0]?.[0].selection).toEqual({ instanceId: "grok", model: "retired/exact-model:pin", mode: "pinned", effort: "medium" });
  });

  it("announces horizontal effort changes while focus stays on the dialog", async () => {
    mock.instances = [engine("grok", "grokAgent", ["grok-4.6"], ["low", "medium", "high"])];
    await mount({ instanceId: "grok", model: "grok-4.6", mode: "pinned", effort: "low" });
    expect(document.querySelector('[aria-live="polite"]')?.textContent).toContain("Effort: low");
    await key("ArrowRight");
    expect(document.activeElement).toBe(document.querySelector('[role="dialog"]'));
    expect(document.querySelector('[aria-live="polite"]')?.textContent).toContain("Effort: medium");
  });

  it("moves vertically through every model before crossing engine boundaries", async () => {
    mock.instances = [
      engine("codex", "codex", ["gpt-6-astra", "gpt-5.6-sol"]),
      engine("grok", "grokAgent", ["grok-4.6"]),
    ];
    await mount({ instanceId: "codex", model: "gpt-6-astra", mode: "pinned" });
    await key("ArrowDown");
    await key("Enter");
    expect(mock.dispatch.mock.calls[0]?.[0].selection).toEqual({ instanceId: "codex", model: "gpt-5.6-sol", mode: "pinned" });
  });

  it.each([
    [false, "bot-1", true],
    [true, "bot-1", false],
    [false, "another-bot", false],
  ] as const)("advertises Alt+M only when live (contained=%s, selected=%s)", async (contained, selectedId, enabled) => {
    mock.instances = [engine("grok", "grokAgent", ["grok-4.6"])];
    await mount({ instanceId: "grok", model: "grok-4.6", mode: "pinned" }, false, contained, selectedId);
    const trigger = document.querySelector<HTMLButtonElement>('[aria-haspopup="dialog"]')!;
    expect(trigger.title.includes(" (Alt+M)")).toBe(enabled);
    expect(trigger.getAttribute("aria-keyshortcuts")).toBe(enabled ? "Alt+M" : null);
    await act(async () => window.dispatchEvent(new KeyboardEvent("keydown", { code: "KeyM", altKey: true, bubbles: true })));
    expect(document.querySelector('[role="dialog"]') !== null).toBe(enabled);
  });

  it("round-trips an effort-only change through Enter", async () => {
    mock.instances = [engine("grok", "grokAgent", ["grok-4.6"], ["low", "medium", "high"])];
    const selection: ModelSelection = { instanceId: "grok", model: "grok-4.6", mode: "pinned", effort: "high" };
    await mount(selection);
    await act(async () => Array.from(document.querySelectorAll<HTMLButtonElement>("[data-effort-axis] button")).find((button) => button.textContent === "low")!.click());
    await key("Enter");
    expect(mock.dispatch).toHaveBeenCalledExactlyOnceWith({ type: "setModel", botId: "bot-1", selection: { ...selection, effort: "low" } });
    expect(document.querySelector('[role="dialog"]')).toBeNull();
  });

  it.each(["tier", "effort", "custom"])("preserves native Enter activation for a focused %s button", async (control) => {
    const instance = control === "tier"
      ? engine("antigravity", "antigravityAgent", ["gemini-3.8-flash-high", "gemini-3.8-flash-low"])
      : engine("codex", "codex", ["gpt-5.6-sol"], ["low", "high"]);
    instance.models.options.push({ id: "provider::custom-model", label: "Custom model", custom: true });
    mock.instances = [instance];
    await mount({ instanceId: instance.instanceId, model: instance.models.default, mode: "pinned" });
    if (control === "custom") {
      await act(async () => Array.from(document.querySelectorAll("button")).find((button) => button.textContent?.includes("Use a local model"))!.click());
    }
    const button = Array.from(document.querySelectorAll("button")).find((button) => button.textContent === (control === "custom" ? "Custom model" : "low"))!;
    const event = new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true });
    await act(async () => { button.focus(); button.dispatchEvent(event); });
    expect(event.defaultPrevented).toBe(false);
    expect(mock.dispatch).not.toHaveBeenCalled();
    expect(document.querySelector('[role="dialog"]')).not.toBeNull();
    // Happy DOM does not synthesize the browser's click default action.
    await act(async () => button.click());
    await act(async () => document.querySelector<HTMLElement>('[role="dialog"]')!.focus());
    await key("Enter");
    const expected: ModelSelection = {
      instanceId: instance.instanceId,
      model: control === "tier" ? "gemini-3.8-flash-low" : control === "custom" ? "provider::custom-model" : "gpt-5.6-sol",
      mode: "pinned",
    };
    if (control !== "tier") expected.effort = "low";
    expect(mock.dispatch.mock.calls[0]?.[0].selection).toEqual(expected);
  });

  it.each(["ArrowUp", "ArrowDown"])("skips an empty engine row with %s", async (direction) => {
    mock.instances = [
      engine("claude", "claudeAgent", ["claude-sonnet-5"]),
      engine("codex", "codex", []),
      engine("grok", "grokAgent", ["grok-4.6", "grok-4.5"]),
    ];
    const down = direction === "ArrowDown";
    await mount({ instanceId: down ? "claude" : "grok", model: down ? "claude-sonnet-5" : "grok-4.6", mode: "pinned" });
    await key(direction);
    await key("Enter");
    expect(mock.dispatch.mock.calls[0]?.[0].selection).toEqual({
      instanceId: down ? "grok" : "claude", model: down ? "grok-4.6" : "claude-sonnet-5", mode: "pinned",
    });
  });

  it("sends an off-list pinned model unchanged after an Enter round trip", async () => {
    mock.instances = [engine("claude", "claudeAgent", ["claude-sonnet-5", "claude-haiku-4-5"], ["low", "high"])];
    const selection: ModelSelection = { instanceId: "claude", model: "claude-haiku-4-5", mode: "pinned", effort: "high" };
    await mount(selection);
    expect(document.body.textContent).toContain("Current (not in list)");
    expect(document.body.textContent).toContain("claude-haiku-4-5");
    await key("Enter");
    expect(mock.dispatch).toHaveBeenCalledExactlyOnceWith({ type: "setModel", botId: "bot-1", selection });
  });

  it("selects an existing Antigravity tier id and sends no effort value", async () => {
    const ids = ["gemini-3.8-flash-high", "gemini-3.8-flash-medium", "gemini-3.8-flash-low", "gemini-3.1-pro-high", "gemini-3.1-pro-low"];
    mock.instances = [engine("antigravity", "antigravityAgent", ids)];
    await mount({ instanceId: "antigravity", model: ids[0]!, mode: "pinned" });
    const tier = document.querySelector<HTMLButtonElement>('button[data-model-tier="gemini-3.8-flash-medium"]');
    expect(tier).not.toBeNull();
    await act(async () => tier!.click());
    await key("Enter");
    const selection = mock.dispatch.mock.calls[0]?.[0].selection;
    expect(selection).toEqual({ instanceId: "antigravity", model: ids[1], mode: "pinned" });
    expect(ids).toContain(selection.model);
    expect(selection).not.toHaveProperty("effort");
    expect(document.querySelector('[data-effort-strip]')).toBeNull();
  });

  it("round-trips a bare Codex id without encoding or replacing it", async () => {
    mock.instances = [engine("codex", "codex", ["gpt-6-astra", "gpt-5.6-sol", "gpt-5.6-terra", "gpt-5.6-luna"])];
    const selection: ModelSelection = { instanceId: "codex", model: "gpt-5.6-terra", mode: "pinned" };
    await mount(selection);
    await key("Enter");
    expect(mock.dispatch).toHaveBeenCalledExactlyOnceWith({ type: "setModel", botId: "bot-1", selection });
  });

  it("crosses from the final model into the next engine and clears unsupported effort", async () => {
    mock.instances = [
      engine("codex", "codex", ["gpt-6-astra", "gpt-5.6-sol", "gpt-5.6-terra", "gpt-5.6-luna"]),
      engine("grok", "grokAgent", ["grok-4.6", "grok-4.5"], ["low", "medium", "high"]),
    ];
    await mount({ instanceId: "codex", model: "gpt-5.6-terra", mode: "pinned", effort: "xhigh" });
    await key("ArrowDown");
    await key("ArrowDown");
    await key("Enter");
    expect(mock.dispatch).toHaveBeenCalledExactlyOnceWith({
      type: "setModel", botId: "bot-1",
      selection: { instanceId: "grok", model: "grok-4.6", mode: "pinned", effort: "high" },
    });
  });

  it("preserves a pin missing from the entire catalog", async () => {
    mock.instances = [engine("claude", "claudeAgent", ["claude-sonnet-5"])];
    const selection: ModelSelection = { instanceId: "claude", model: "retired-model-exact-id", mode: "pinned" };
    await mount(selection);
    expect(document.body.textContent).toContain("Current (not in list)");
    await key("Enter");
    expect(mock.dispatch).toHaveBeenCalledExactlyOnceWith({ type: "setModel", botId: "bot-1", selection });
  });

  it("offers only high and low for an off-list Antigravity Pro pin", async () => {
    mock.instances = [engine("antigravity", "antigravityAgent", ["gemini-3.1-pro-high", "gemini-3.1-pro-low"])];
    await mount({ instanceId: "antigravity", model: "gemini-3.1-pro-high", mode: "pinned" });
    expect(document.querySelectorAll("[data-model-tier]")).toHaveLength(2);
    expect(document.querySelector("[data-effort-strip]")).toBeNull();
    expect(document.body.textContent).not.toContain("medium");
    await act(async () => document.querySelector<HTMLButtonElement>('[data-model-tier="gemini-3.1-pro-low"]')!.click());
    await key("Enter");
    expect(mock.dispatch.mock.calls[0]?.[0].selection).toEqual({ instanceId: "antigravity", model: "gemini-3.1-pro-low", mode: "pinned" });
  });

  it("keeps a custom encoded selection intact after choosing its row", async () => {
    const codex = engine("codex", "codex", ["gpt-5.6-sol"]);
    codex.models.options.push({ id: "provider::custom-model", label: "Custom model", custom: true });
    mock.instances = [codex];
    await mount({ instanceId: "codex", model: "gpt-5.6-sol", mode: "pinned" });
    await act(async () => Array.from(document.querySelectorAll("button")).find((button) => button.textContent?.includes("Use a local model"))!.click());
    await act(async () => Array.from(document.querySelectorAll("button")).find((button) => button.textContent === "Custom model")!.click());
    expect(document.querySelector('[data-model-cell="provider::custom-model"][aria-pressed="true"]')).not.toBeNull();
    expect(mock.dispatch).not.toHaveBeenCalled();
    await key("Enter");
    expect(mock.dispatch.mock.calls[0]?.[0].selection.model).toBe("provider::custom-model");
  });

  it("cancels navigation and restores focus without dispatching", async () => {
    mock.instances = [engine("grok", "grokAgent", ["grok-4.6", "grok-4.5"])];
    await mount({ instanceId: "grok", model: "grok-4.6", mode: "pinned" }, false);
    const trigger = document.querySelector<HTMLButtonElement>('[aria-haspopup="dialog"]')!;
    await act(async () => { trigger.focus(); trigger.click(); });
    await key("ArrowDown");
    expect(document.querySelector('[data-model-cell="grok-4.5"][aria-pressed="true"]')).not.toBeNull();
    await key("Escape");
    expect(mock.dispatch).not.toHaveBeenCalled();
    expect(document.querySelector('[role="dialog"]')).toBeNull();
    expect(document.activeElement).toBe(trigger);
    await act(async () => trigger.click());
    expect(document.querySelector('[data-model-cell="grok-4.6"][aria-pressed="true"]')).not.toBeNull();
  });

  it("opens with Alt+M and ignores Ctrl+Alt+M", async () => {
    mock.instances = [engine("grok", "grokAgent", ["grok-4.6", "grok-4.5"])];
    await mount({ instanceId: "grok", model: "grok-4.6", mode: "pinned" }, false);
    await act(async () => window.dispatchEvent(new KeyboardEvent("keydown", { code: "KeyM", altKey: true, ctrlKey: true, bubbles: true })));
    expect(document.querySelector('[role="dialog"]')).toBeNull();
    await act(async () => window.dispatchEvent(new KeyboardEvent("keydown", { code: "KeyM", altKey: true, bubbles: true })));
    expect(document.querySelector('[role="dialog"]')).not.toBeNull();
    await key("Escape");
    expect(mock.dispatch).not.toHaveBeenCalled();
  });
});
