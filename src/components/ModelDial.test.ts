import "./ProfileFields.test-dom.ts";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { I18nProvider } from "@/lib/i18n";
import type { Bot, InstanceInfo } from "@/state/store";
import { ModelPickerControl } from "./ModelPicker";

const L5 = ["low", "medium", "high", "xhigh", "max"] as const;
const dispatch = vi.fn();
const animate = vi.fn(() => ({ cancel: vi.fn() } as unknown as Animation));
const originalAnimate = Element.prototype.animate;
let root: Root;

function engine(instanceId: string, driverKind: string, ids: string[], signedIn = true): InstanceInfo {
  return {
    instanceId, driverKind, displayName: instanceId,
    snapshot: { state: "available", authenticated: signedIn },
    models: { default: ids[0]!, options: ids.map((id) => ({ id, label: id })) },
    capabilities: { effortLevels: [...L5] },
  };
}

function media({ wide = true, reduced = false } = {}) {
  vi.spyOn(window, "matchMedia").mockImplementation((query: string) => ({
    matches: query.includes("reduce") ? reduced : wide,
    media: query,
    onchange: null,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
    addListener: () => undefined,
    removeListener: () => undefined,
    dispatchEvent: () => false,
  }));
}

async function mount({ grokSignedIn = true, dial = true } = {}) {
  const host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  const instances = [
    engine("claude", "claudeAgent", ["claude-opus-5-5", "claude-sonnet-5-5"]),
    engine("codex", "codex", ["gpt-6.1-sol", "gpt-6-luna"]),
    engine("grok", "grokAgent", ["grok-4.7"], grokSignedIn),
  ];
  const bot: Bot = { id: "bot-1", threadId: "thread-1", name: "Dial", title: "", description: "", color: "green", notifications: false, unread: false, messages: [], modelSelection: { instanceId: "claude", model: "claude-opus-5-5", effort: "high", mode: "pinned" } };
  await act(async () => {
    root.render(createElement(I18nProvider, null, createElement(ModelPickerControl, {
      bot,
      store: { state: { instances, selectedId: "bot-1" }, dispatch, refreshInstances: async () => undefined },
      defaultOpen: true,
      dial,
    })));
  });
}

async function key(key: string) {
  await act(async () => {
    (document.activeElement ?? document.body).dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true }));
  });
}

const selected = () => document.querySelector('.dial-card[aria-pressed="true"]')?.getAttribute("data-model-cell");
const effort = () => document.querySelector(".dial-effort b")?.textContent;
const saved = () => dispatch.mock.calls.find(([action]) => action.type === "setModel")?.[0].selection;

beforeEach(() => {
  Element.prototype.animate = animate;
});

afterEach(async () => {
  await act(async () => root?.unmount());
  document.body.replaceChildren();
  dispatch.mockReset();
  vi.restoreAllMocks();
  Element.prototype.animate = originalAnimate;
});

describe("ModelDial", () => {
  it("steps models with up and down and wraps at the ends", async () => {
    media();
    await mount();
    expect(document.querySelector(".model-dial")).not.toBeNull();
    expect(selected()).toBe("claude-opus-5-5");
    await key("ArrowDown");
    expect(selected()).toBe("claude-sonnet-5-5");
    await key("ArrowUp");
    await key("ArrowUp");
    expect(selected()).toBe("grok-4.7");
  });

  it("clamps effort at both ends", async () => {
    media();
    await mount();
    expect(effort()).toBe("high");
    for (let i = 0; i < 4; i++) await key("ArrowRight");
    expect(effort()).toBe("max");
    expect(document.querySelector(".dial-stage")?.hasAttribute("data-max")).toBe(true);
    for (let i = 0; i < 8; i++) await key("ArrowLeft");
    expect(effort()).toBe("low");
  });

  it("picks with Enter and closes with Esc", async () => {
    media();
    await mount();
    await key("ArrowDown");
    await key("Enter");
    expect(saved()).toEqual({ instanceId: "claude", model: "claude-sonnet-5-5", effort: "high", mode: "pinned" });
    await act(async () => root.unmount());
    dispatch.mockReset();
    await mount();
    await key("Escape");
    await act(async () => new Promise((resolve) => setTimeout(resolve, 400)));
    expect(document.querySelector("[data-model-picker-content]")).toBeNull();
    expect(saved()).toBeUndefined();
  });

  it("jumps by typed name and lands with Enter", async () => {
    media();
    await mount();
    await key("s");
    await key("o");
    expect(selected()).toBe("claude-sonnet-5-5");
    await key("l");
    expect(selected()).toBe("gpt-6.1-sol");
    await key("Enter");
    expect(saved()).toEqual({ instanceId: "codex", model: "gpt-6.1-sol", effort: "high", mode: "pinned" });
  });

  it("shows a signed-out engine locked and never picks it", async () => {
    media();
    await mount({ grokSignedIn: false });
    expect(document.querySelector('[data-dial-lab="grok"]')?.hasAttribute("data-locked")).toBe(true);
    await key("ArrowUp");
    expect(selected()).toBe("grok-4.7");
    expect((document.querySelector("[data-dial-pick]") as HTMLButtonElement).disabled).toBe(true);
    await key("Enter");
    expect(saved()).toBeUndefined();
  });

  it("switches to the list view and back", async () => {
    media();
    await mount();
    const toggle = () => document.querySelector<HTMLButtonElement>(".model-dial-view")!;
    expect(toggle().textContent).toBe("List View");
    await act(async () => toggle().click());
    expect(document.querySelector(".model-dial")).toBeNull();
    expect(document.querySelector(".model-cross-stage")).not.toBeNull();
    expect(toggle().textContent).toBe("Dial View");
    await act(async () => toggle().click());
    expect(document.querySelector(".model-dial")).not.toBeNull();
  });

  it("keeps the list picker below the desktop cutoff", async () => {
    media({ wide: false });
    await mount();
    expect(document.querySelector(".model-dial")).toBeNull();
    expect(document.querySelector(".model-dial-view")).toBeNull();
    expect(document.querySelector(".model-cross-stage")).not.toBeNull();
  });

  it("shows the rest look at once under reduced motion", async () => {
    media({ reduced: true });
    await mount();
    await key("ArrowDown");
    expect(document.querySelector(".dial-plane")?.hasAttribute("data-open")).toBe(true);
    media();
    await key("ArrowDown");
    expect(document.querySelector(".dial-plane")?.hasAttribute("data-open")).toBe(false);
  });
});
