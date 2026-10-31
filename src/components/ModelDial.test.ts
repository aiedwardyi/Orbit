import "./ProfileFields.test-dom.ts";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { modelDialEnabled } from "@/lib/feature-flags";
import { I18nProvider } from "@/lib/i18n";
import type { Bot, InstanceInfo } from "@/state/store";
import { ModelPickerControl } from "./ModelPicker";

const L5 = ["low", "medium", "high", "xhigh", "max"] as const;
const dispatch = vi.fn();
const animate = vi.fn((_keyframes: Keyframe[], _options?: number | KeyframeAnimationOptions) => ({ cancel: vi.fn() } as unknown as Animation));
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
    matches: query.includes("reduce") ? reduced : query.split(", ").some((part) => part.startsWith("(max-width") ? phone : wide),
    media: query,
    onchange: null,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
    addListener: () => undefined,
    removeListener: () => undefined,
    dispatchEvent: () => false,
  }));
}

function control({ grokSignedIn = true, dial = true, model = "claude-opus-5-5", open = true } = {}) {
  const instances = [
    engine("claude", "claudeAgent", ["claude-opus-5-5", "claude-sonnet-5-5"]),
    engine("codex", "codex", ["gpt-6.1-sol", "gpt-6-luna"]),
    engine("grok", "grokAgent", ["grok-4.7"], grokSignedIn),
  ];
  const bot: Bot = { id: "bot-1", threadId: "thread-1", name: "Dial", title: "", description: "", color: "green", notifications: false, unread: false, messages: [], modelSelection: { instanceId: "claude", model, effort: "high", mode: "pinned" } };
  return createElement(ModelPickerControl, {
    bot,
    store: { state: { instances, selectedId: "bot-1" }, dispatch, refreshInstances: async () => undefined },
    defaultOpen: open,
    dial,
  });
}

async function render(...controls: ReturnType<typeof control>[]) {
  await act(async () => {
    root.render(createElement(I18nProvider, null, ...controls));
  });
}

async function mount(options: Parameters<typeof control>[0] = {}) {
  const host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  await render(control(options));
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

async function pointer(type: string, x: number, y: number) {
  await act(async () => {
    document.querySelector(".dial-stage")!.dispatchEvent(new window.PointerEvent(type, { pointerId: 1, pointerType: "touch", isPrimary: true, clientX: x, clientY: y, bubbles: true, cancelable: true }));
  });
}

async function drag(dx: number, dy: number, moves = 4, ms = 30) {
  await pointer("pointerdown", 200, 400);
  for (let i = 1; i <= moves; i++) {
    await wait(ms);
    await pointer("pointermove", 200 + dx * i / moves, 400 + dy * i / moves);
  }
  await pointer("pointerup", 200 + dx, 400 + dy);
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

describe("ModelDial ring", () => {
  let reads = 0;
  const cap = () => document.querySelectorAll(".dial-ring .cap")[1];
  const turns = (el: Element | undefined) => animate.mock.calls.filter((_, k) => animate.mock.contexts[k] === el).map(([keyframes]) => keyframes.map((frame) => Number(String(frame.transform).slice(7, -4))));

  beforeEach(() => {
    reads = 0;
    const real = globalThis.getComputedStyle;
    vi.spyOn(globalThis, "getComputedStyle").mockImplementation((el, pseudo) => {
      if (!el.classList.contains("dial-stage")) return real(el, pseudo);
      reads++;
      // SAFETY: the dial reads only getPropertyValue off the stage style.
      return { getPropertyValue: (name: string) => name === "--spring" ? "0, .8, 1" : "" } as CSSStyleDeclaration;
    });
  });

  it("places the ring without reading the spring curve", async () => {
    media();
    await mount();
    await wait(50);
    expect(reads).toBe(0);
    expect(turns(cap()).at(-1)?.at(-1)).toBe(53.6 * 3.6);
  });

  it("jumps the ring under reduced motion without reading the spring curve", async () => {
    media({ reduced: true });
    await mount();
    await wait(50);
    const before = turns(cap()).length;
    await key("ArrowDown");
    expect(turns(cap())).toHaveLength(before + 1);
    expect(turns(cap()).at(-1)).toHaveLength(1);
    expect(reads).toBe(0);
  });

  it("eases a timed sweep with one spring read and resumes an interrupted one in place", async () => {
    vi.useFakeTimers({ toFake: ["performance", "requestAnimationFrame", "cancelAnimationFrame"] });
    media();
    await mount();
    await wait(50);
    const from = 53.6 * 3.6;
    await key("ArrowDown");
    expect(reads).toBe(1);
    const first = turns(cap()).at(-1)!;
    const to = first.at(-1)!;
    expect(first).toHaveLength(25);
    expect(first[0]).toBe(from);
    expect(first[12]).toBe(from + (to - from) * 0.8);
    await wait(85);
    await key("ArrowDown");
    expect(reads).toBe(2);
    expect(turns(cap()).at(-1)![0]).toBe(from + (to - from) * 0.8);
  });
});

describe("ModelDial font warm", () => {
  let load: ReturnType<typeof vi.fn<(font: string) => Promise<FontFace[]>>>;
  const trigger = (k = 0) => document.querySelectorAll<HTMLButtonElement>('[aria-haspopup="dialog"]')[k]!;
  const loaded = () => load.mock.calls.map(([font]) => font);
  const WEIGHTS = ['400 11px "JetBrains Mono"', '500 11px "JetBrains Mono"', '600 11px "JetBrains Mono"'];

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    // SAFETY: the picker only schedules function callbacks.
    vi.spyOn(window, "setTimeout").mockImplementation((fn, ms) => setTimeout(fn as () => void, ms));
    load = vi.fn(async () => []);
    Object.defineProperty(document, "fonts", { configurable: true, value: { load } });
    const host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);
  });

  afterEach(() => {
    Reflect.deleteProperty(document, "fonts");
    Reflect.deleteProperty(window, "requestIdleCallback");
    Reflect.deleteProperty(window, "cancelIdleCallback");
  });

  it("loads the font once for every closed desktop picker", async () => {
    media();
    await render(control({ open: false }), control({ open: false }));
    await wait(1999);
    expect(load).not.toHaveBeenCalled();
    await wait(1);
    expect(loaded()).toEqual(WEIGHTS);
    await wait(10000);
    expect(load).toHaveBeenCalledTimes(3);
  });

  it("waits for an idle moment when the browser has one", async () => {
    const idle: Array<() => void> = [];
    const request = vi.fn((callback: () => void, _options?: IdleRequestOptions) => idle.push(callback));
    Object.defineProperty(window, "requestIdleCallback", { configurable: true, value: request });
    Object.defineProperty(window, "cancelIdleCallback", { configurable: true, value: vi.fn() });
    media();
    await render(control({ open: false }));
    await wait(2000);
    expect(request).toHaveBeenCalledWith(expect.any(Function), { timeout: 3000 });
    expect(load).not.toHaveBeenCalled();
    idle.forEach((callback) => callback());
    expect(loaded()).toEqual(WEIGHTS);
  });

  it("skips the load once a picker opens first", async () => {
    media();
    await render(control({ open: false }), control({ open: false }));
    await wait(1000);
    await act(async () => trigger(1).click());
    expect(document.querySelector(".model-dial")).not.toBeNull();
    await wait(5000);
    await key("Escape");
    await wait(10000);
    expect(document.querySelector("[data-model-picker-content]")).toBeNull();
    expect(load).not.toHaveBeenCalled();
  });

  it("cancels on unmount and lets the next picker take over", async () => {
    media();
    await render(control({ open: false }));
    await wait(1000);
    await render();
    await wait(10000);
    expect(load).not.toHaveBeenCalled();
    await render(control({ open: false }));
    await wait(2000);
    expect(loaded()).toEqual(WEIGHTS);
  });

  it("cancels when the flag turns off", async () => {
    media();
    await render(control({ open: false }));
    await wait(1000);
    await render(control({ open: false, dial: false }));
    await wait(10000);
    expect(load).not.toHaveBeenCalled();
  });

  it.each([
    ["the flag is off", false, {}],
    ["config has not loaded", modelDialEnabled(null), {}],
    ["the desktop is too narrow", true, { wide: false }],
  ])("never loads when %s", async (_, dial, screen) => {
    media(screen);
    await render(control({ open: false, dial }));
    await wait(10000);
    expect(load).not.toHaveBeenCalled();
  });

  it("leaves the phone dial to load its font on open", async () => {
    media({ wide: false, phone: true });
    await render(control({ open: false }));
    await wait(10000);
    expect(load).not.toHaveBeenCalled();
    await act(async () => trigger().click());
    expect(document.querySelector(".dial-stage")?.hasAttribute("data-phone")).toBe(true);
  });

  it("does nothing without a font API", async () => {
    Reflect.deleteProperty(document, "fonts");
    media();
    await render(control({ open: false }));
    expect(vi.getTimerCount()).toBe(0);
    await act(async () => trigger().click());
    expect(document.querySelector(".model-dial")).not.toBeNull();
  });

  it("swallows a rejected load without retrying", async () => {
    load.mockRejectedValue(new Error("offline"));
    media();
    await render(control({ open: false }));
    await wait(2000);
    await wait(10000);
    expect(load).toHaveBeenCalledTimes(3);
  });
});
