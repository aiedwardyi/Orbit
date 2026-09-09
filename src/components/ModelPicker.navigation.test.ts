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

async function mount(selection: ModelSelection, defaultOpen = true) {
  const host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  await act(async () => {
    const bot: Bot = { id: "bot-1", threadId: "thread-1", name: "Picker", title: "", description: "", color: "green", notifications: false, unread: false, messages: [], modelSelection: selection };
    root.render(createElement(I18nProvider, null, createElement(ModelPickerControl, {
      bot,
      store: { state: { instances: mock.instances, selectedId: bot.id }, dispatch: mock.dispatch, refreshInstances: mock.refreshInstances },
      defaultOpen,
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
    if (control === "effort") expected.effort = "low";
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

  it("clamps the model column when moving from a four-model row to Grok's two", async () => {
    mock.instances = [
      engine("codex", "codex", ["gpt-6-astra", "gpt-5.6-sol", "gpt-5.6-terra", "gpt-5.6-luna"]),
      engine("grok", "grokAgent", ["grok-4.6", "grok-4.5"], ["low", "medium", "high"]),
    ];
    await mount({ instanceId: "codex", model: "gpt-5.6-terra", mode: "pinned", effort: "xhigh" });
    await key("ArrowRight");
    await key("ArrowDown");
    await key("Enter");
    expect(mock.dispatch).toHaveBeenCalledExactlyOnceWith({
      type: "setModel", botId: "bot-1",
      selection: { instanceId: "grok", model: "grok-4.5", mode: "pinned" },
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
    await key("ArrowRight");
    expect(document.querySelector('[data-model-cell="grok-4.5"][aria-pressed="true"]')).not.toBeNull();
    await key("Escape");
    expect(mock.dispatch).not.toHaveBeenCalled();
    expect(document.querySelector('[role="dialog"]')).toBeNull();
    expect(document.activeElement).toBe(trigger);
    await act(async () => trigger.click());
    expect(document.querySelector('[data-model-cell="grok-4.6"][aria-pressed="true"]')).not.toBeNull();
  });

  it("opens with Alt+P and ignores Ctrl+Alt+P", async () => {
    mock.instances = [engine("grok", "grokAgent", ["grok-4.6", "grok-4.5"])];
    await mount({ instanceId: "grok", model: "grok-4.6", mode: "pinned" }, false);
    await act(async () => window.dispatchEvent(new KeyboardEvent("keydown", { code: "KeyP", altKey: true, ctrlKey: true, bubbles: true })));
    expect(document.querySelector('[role="dialog"]')).toBeNull();
    await act(async () => window.dispatchEvent(new KeyboardEvent("keydown", { code: "KeyP", altKey: true, bubbles: true })));
    expect(document.querySelector('[role="dialog"]')).not.toBeNull();
    await key("Escape");
    expect(mock.dispatch).not.toHaveBeenCalled();
  });
});
