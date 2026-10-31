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

function media({ wide = true, reduced = false, phone = false } = {}) {
  vi.spyOn(window, "matchMedia").mockImplementation((query: string) => ({
    matches: query.includes("reduce") ? reduced : query.startsWith("(max-width") ? phone : wide,
    media: query,
    onchange: null,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
    addListener: () => undefined,
    removeListener: () => undefined,
    dispatchEvent: () => false,
  }));
}

function mouse(width: number, height = 900) {
  const screen = { width, height, changes: new Set<(event: Event) => void>() };
  const fits = (query: string) => query.split(", ").some((part) => part.split(" and ").every((term) => {
    const [, name, value] = /\(([\w-]+): ([\w./]+)\)/.exec(term)!;
    if (name === "max-aspect-ratio") return screen.width * Number(value.split("/")[1]) <= screen.height * Number(value.split("/")[0]);
    return name === "pointer" ? value === "fine" : name === "max-width" ? screen.width <= parseFloat(value) : name === "min-width" ? screen.width >= parseFloat(value) : false;
  }));
  vi.spyOn(window, "matchMedia").mockImplementation((query: string) => ({
    get matches() { return fits(query); },
    media: query,
    onchange: null,
    addEventListener: (_: string, change: (event: Event) => void) => void screen.changes.add(change),
    removeEventListener: (_: string, change: (event: Event) => void) => void screen.changes.delete(change),
    addListener: () => undefined,
    removeListener: () => undefined,
    dispatchEvent: () => false,
  }));
  return (next: number) => act(async () => {
    screen.width = next;
    screen.changes.forEach((change) => change(new Event("change")));
    window.dispatchEvent(new Event("resize"));
  });
}

async function mount({ grokSignedIn = true, dial = true, model = "claude-opus-5-5" } = {}) {
  const host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  const instances = [
    engine("claude", "claudeAgent", ["claude-opus-5-5", "claude-sonnet-5-5"]),
    engine("codex", "codex", ["gpt-6.1-sol", "gpt-6-luna"]),
    engine("grok", "grokAgent", ["grok-4.7"], grokSignedIn),
  ];
  const bot: Bot = { id: "bot-1", threadId: "thread-1", name: "Dial", title: "", description: "", color: "green", notifications: false, unread: false, messages: [], modelSelection: { instanceId: "claude", model, effort: "high", mode: "pinned" } };
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

const wait = (ms: number) => act(async () => vi.isFakeTimers() ? vi.advanceTimersByTimeAsync(ms) : new Promise((resolve) => setTimeout(resolve, ms)));

async function settle() {
  for (let i = 0; i < 60; i++) await wait(20);
}

async function pointer(type: string, x: number, y: number, pointerType = "touch") {
  await act(async () => {
    document.querySelector(".dial-stage")!.dispatchEvent(new window.PointerEvent(type, { pointerId: 1, pointerType, isPrimary: true, clientX: x, clientY: y, bubbles: true, cancelable: true }));
  });
}

async function drag(dx: number, dy: number, moves = 4, ms = 30, pointerType = "touch") {
  await pointer("pointerdown", 200, 400, pointerType);
  for (let i = 1; i <= moves; i++) {
    await wait(ms);
    await pointer("pointermove", 200 + dx * i / moves, 400 + dy * i / moves, pointerType);
  }
  await pointer("pointerup", 200 + dx, 400 + dy, pointerType);
}

const order = ["claude-opus-5-5", "claude-sonnet-5-5", "gpt-6.1-sol", "gpt-6-luna", "grok-4.7"];
const selected = () => document.querySelector('.dial-card[aria-pressed="true"]')?.getAttribute("data-model-cell");
const effort = () => document.querySelector(".dial-effort b")?.textContent;
const saved = () => dispatch.mock.calls.find(([action]) => action.type === "setModel")?.[0].selection;

function spoken(node: Node): string {
  if (node instanceof Element && node.getAttribute("aria-hidden") === "true") return "";
  return node.nodeType === Node.TEXT_NODE ? node.textContent ?? "" : Array.from(node.childNodes, spoken).join("");
}

beforeEach(() => {
  Element.prototype.animate = animate;
});

afterEach(async () => {
  await act(async () => root?.unmount());
  document.body.replaceChildren();
  dispatch.mockReset();
  vi.useRealTimers();
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

  it.each([
    [true, '[aria-label="Previous model"]', "grok-4.7"],
    [true, '[aria-label="Next model"]', "claude-sonnet-5-5"],
    [true, '[data-dial-lab="codex"]', "gpt-6.1-sol"],
    [false, '[aria-label="Previous model"]', "grok-4.7"],
    [false, '[aria-label="Next model"]', "claude-sonnet-5-5"],
  ])("keeps native Enter activation on %s dial %s", async (dial, selector, model) => {
    media();
    await mount({ dial });
    const button = document.querySelector<HTMLButtonElement>(selector)!;
    button.focus();
    const event = new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true });
    await act(async () => (button.querySelector("svg") ?? button).dispatchEvent(event));
    expect(event.defaultPrevented).toBe(false);
    expect(saved()).toBeUndefined();
    await act(async () => button.click());
    expect(document.querySelector(`[data-model-cell="${model}"][aria-pressed="true"]`)).not.toBeNull();
    expect(saved()).toBeUndefined();
    expect(document.querySelector("[data-model-picker-content]")).not.toBeNull();
  });

  it("keeps native Enter activation on List View", async () => {
    media();
    await mount();
    const button = document.querySelector<HTMLButtonElement>(".model-dial-view")!;
    button.focus();
    const event = new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true });
    await act(async () => button.dispatchEvent(event));
    expect(event.defaultPrevented).toBe(false);
    expect(saved()).toBeUndefined();
    await act(async () => button.click());
    expect(document.querySelector(".model-cross-stage")).not.toBeNull();
    expect(saved()).toBeUndefined();
  });

  it.each([
    ["claude-opus-5-5", ["53.6", "54.0", "2.94"]],
    ["unlisted-model", ["Unavailable", "Unavailable", "Unavailable"]],
  ])("exposes formatted stats without rolling digits for %s", async (model, values) => {
    media();
    await mount({ model });
    expect(Array.from(document.querySelectorAll(".dial-odo"), spoken)).toEqual(values);
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

  describe("in a mouse window", () => {
    const vertical = () => document.querySelector(".dial-stage")?.hasAttribute("data-phone");

    it("keeps the wide dial when wide or short", async () => {
      for (const [width, height] of [[1440, 900], [1024, 600]]) {
        mouse(width, height);
        await mount();
        expect(vertical()).toBe(false);
        await act(async () => root.unmount());
        vi.restoreAllMocks();
      }
    });

    it("takes the vertical dial when narrow", async () => {
      for (const [width, height] of [[1000, 900], [700, 900], [480, 900], [600, 300]]) {
        mouse(width, height);
        await mount();
        expect(vertical()).toBe(true);
        expect(document.querySelector(".model-dial-view")?.textContent).toBe("List View");
        await act(async () => root.unmount());
        vi.restoreAllMocks();
      }
    });

    it("turns models with a mouse drag when narrow", async () => {
      Element.prototype.setPointerCapture = () => undefined;
      mouse(700);
      await mount();
      await drag(0, -60, 4, 60, "mouse");
      await settle();
      expect(selected()).toBe("claude-sonnet-5-5");
    });

    it("swaps layouts on resize and keeps the pick and the view", async () => {
      const resize = mouse(1440);
      await mount();
      await key("ArrowDown");
      await key("ArrowLeft");
      await resize(700);
      expect(vertical()).toBe(true);
      expect([selected(), effort()]).toEqual(["claude-sonnet-5-5", "medium"]);
      await resize(1440);
      expect(vertical()).toBe(false);
      expect([selected(), effort()]).toEqual(["claude-sonnet-5-5", "medium"]);
      await act(async () => document.querySelector<HTMLButtonElement>(".model-dial-view")!.click());
      await resize(700);
      expect(document.querySelector(".model-dial")).toBeNull();
      expect(document.querySelector(".model-dial-view")?.textContent).toBe("Dial View");
    });
  });

  describe("on a phone", () => {
    beforeEach(() => {
      Element.prototype.setPointerCapture = () => undefined;
    });

    it("turns one model per drag step", async () => {
      media({ phone: true });
      await mount();
      expect(document.querySelector(".dial-stage")?.hasAttribute("data-phone")).toBe(true);
      await drag(0, -60, 4, 60);
      await settle();
      expect(selected()).toBe("claude-sonnet-5-5");
      await drag(0, 60, 4, 60);
      await settle();
      expect(selected()).toBe("claude-opus-5-5");
    });

    it("coasts after a flick and lands on a model", async () => {
      vi.useFakeTimers({ toFake: ["performance", "requestAnimationFrame", "cancelAnimationFrame"] });
      media({ phone: true });
      await mount();
      await drag(0, -120, 4, 10);
      await settle();
      const landed = order.indexOf(selected()!);
      expect(landed).toBeGreaterThan(2);
      expect(document.querySelectorAll('.dial-card[aria-pressed="true"]')).toHaveLength(1);
      await settle();
      expect(order.indexOf(selected()!)).toBe(landed);
    });

    it("stays put when the finger rests before release", async () => {
      vi.useFakeTimers({ toFake: ["performance", "requestAnimationFrame", "cancelAnimationFrame"] });
      media({ phone: true });
      await mount();
      await pointer("pointerdown", 200, 400);
      for (let i = 1; i <= 4; i++) {
        await wait(10);
        await pointer("pointermove", 200, 400 - 30 * i);
      }
      await wait(150);
      await pointer("pointerup", 200, 280);
      await settle();
      expect(selected()).toBe("gpt-6.1-sol");
    });

    it("moves effort one notch per horizontal swipe", async () => {
      media({ phone: true });
      await mount();
      await drag(200, 0);
      expect(effort()).toBe("Extra high");
      await drag(-200, 0);
      await drag(-200, 0);
      expect(effort()).toBe("medium");
      expect(selected()).toBe("claude-opus-5-5");
    });

    it("picks a tapped card and saves with the pick button", async () => {
      media({ phone: true });
      await mount();
      await act(async () => document.querySelector<HTMLButtonElement>('.dial-card[data-model-cell="claude-sonnet-5-5"]')!.click());
      expect(selected()).toBe("claude-sonnet-5-5");
      expect(saved()).toBeUndefined();
      await act(async () => document.querySelector<HTMLButtonElement>("[data-dial-pick]")!.click());
      expect(saved()).toEqual({ instanceId: "claude", model: "claude-sonnet-5-5", effort: "high", mode: "pinned" });
    });

    it("keeps a dial drag from the sidebar swipe", async () => {
      media({ phone: true });
      await mount();
      const swipe = vi.fn();
      document.addEventListener("touchstart", swipe);
      document.addEventListener("touchmove", swipe);
      const stage = document.querySelector(".dial-stage")!;
      await act(async () => {
        stage.dispatchEvent(new window.TouchEvent("touchstart", { bubbles: true }));
        stage.dispatchEvent(new window.TouchEvent("touchmove", { bubbles: true, cancelable: true }));
      });
      await drag(0, -60, 4, 60);
      await settle();
      expect(selected()).toBe("claude-sonnet-5-5");
      expect(swipe).not.toHaveBeenCalled();
      document.removeEventListener("touchstart", swipe);
      document.removeEventListener("touchmove", swipe);
    });

    it("snaps without coasting under reduced motion", async () => {
      vi.useFakeTimers({ toFake: ["performance", "requestAnimationFrame", "cancelAnimationFrame"] });
      media({ phone: true, reduced: true });
      await mount();
      await drag(0, -120, 4, 10);
      await settle();
      expect(selected()).toBe("gpt-6.1-sol");
    });
  });
});
