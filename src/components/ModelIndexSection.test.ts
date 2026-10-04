import "./ProfileFields.test-dom.ts";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { I18nProvider, applyLocale } from "@/lib/i18n";
import { MODEL_RUN_COSTS } from "../../shared/model-index-data.ts";

vi.mock("@/state/store", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/state/store")>()),
  useStore: () => ({ state: { instances: [] }, dispatch: () => undefined }),
}));

import { ModelIndexSection } from "./ModelIndexSection";

let root: Root;
let host: HTMLElement;

const tab = () => host.querySelector('[role="radio"][aria-checked="true"]')?.textContent;
const press = (target: EventTarget, init: KeyboardEventInit = {}) => {
  const event = new KeyboardEvent("keydown", { code: "KeyI", altKey: true, shiftKey: true, bubbles: true, cancelable: true, ...init });
  act(() => {
    target.dispatchEvent(event);
  });
  return event;
};

beforeEach(async () => {
  applyLocale("en");
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  await act(async () => root.render(createElement(I18nProvider, null, createElement(ModelIndexSection))));
});

afterEach(async () => {
  await act(async () => root.unmount());
  document.body.innerHTML = "";
});

describe("benchmark hotkey", () => {
  it("cycles tabs with Alt+Shift+I and wraps around", () => {
    const seen = [tab()];
    for (let i = 0; i < 6; i++) {
      press(window);
      seen.push(tab());
    }
    expect(seen).toEqual(["Intelligence", "Coding", "Agentic", "General work", "Legal", "Cost", "Intelligence"]);
  });

  it("keeps the keystroke from a focused terminal", () => {
    const terminal = document.createElement("textarea");
    document.body.append(terminal);
    terminal.focus();
    const reached = vi.fn();
    terminal.addEventListener("keydown", reached);
    const event = press(terminal);
    expect(reached).not.toHaveBeenCalled();
    expect(event.defaultPrevented).toBe(true);
    expect(tab()).toBe("Coding");
  });

  it("leaves Alt+I and other chords alone", () => {
    press(window, { shiftKey: false });
    press(window, { ctrlKey: true });
    expect(tab()).toBe("Intelligence");
  });
});

describe("model filter", () => {
  it("has no Show all toggle and draws every point at full strength", () => {
    expect(host.textContent).not.toContain("Show all models");
    const faded = [...host.querySelectorAll<HTMLElement>("[data-mi-move]")].filter((el) => ["0.4", "0.5", "0.3"].includes(el.style.opacity));
    expect(faded).toHaveLength(0);
  });

  it("charts only picker models on every tab", () => {
    for (let i = 0; i < 6; i++) {
      const named = [...host.querySelectorAll('[tabindex="0"]')].map((el) => el.getAttribute("aria-label") ?? el.textContent ?? "").join("|");
      expect(named, tab() ?? "").not.toMatch(/GLM|Kimi|Qwen|DeepSeek|Inkling|Argon|Haiku/);
      press(window);
    }
  });
});

describe("cost tab", () => {
  it("shows input / output list price per 1M tokens", () => {
    for (let i = 0; i < 5; i++) press(window);
    expect(tab()).toBe("Cost");
    const opus = [...host.querySelectorAll('[tabindex="0"]')].find((el) => el.textContent?.includes("Claude Opus 5.5"));
    expect(opus?.textContent).toContain("$4 / $20");
    expect(host.textContent).toContain("List price per 1M tokens");
    expect(host.textContent).toContain("Ranked by the 7:2:1 blend");
  });
});

describe("score vs cost", () => {
  it("plots each effort at its own cost to run, not one list price", () => {
    const x = (effort: string) =>
      host.querySelector(`[aria-label="Claude Opus 5.5 ${effort}"]`)?.closest<HTMLElement>("[data-mi-move]")?.style.transform.match(/translate\(([\d.]+)px/)?.[1];
    const xs = ["low", "medium", "high", "xhigh", "max"].map(x);
    expect(xs.every(Boolean), xs.join()).toBe(true);
    expect(new Set(xs).size).toBe(5);
    expect(host.textContent).toContain("Cost per task, AA Intelligence Index");
  });
});

describe("score hover card", () => {
  const hoverTip = (label: string) => {
    act(() => host.querySelector<SVGElement>(`[aria-label="${label}"]`)!.focus());
    const tip = host.querySelector('[role="tooltip"]')?.textContent ?? "";
    act(() => host.querySelector<SVGElement>(`[aria-label="${label}"]`)!.blur());
    return tip;
  };

  it("shows each effort's own cost per task over one shared price", () => {
    const low = hoverTip("Claude Opus 5.5 low");
    const max = hoverTip("Claude Opus 5.5 max");
    const cost = (tip: string) => tip.match(/Cost per task(\$[\d.]+)/)?.[1];
    expect(cost(low), low).toBeDefined();
    expect(cost(max), max).toBeDefined();
    expect(cost(low)).not.toBe(cost(max));
    for (const tip of [low, max]) expect(tip).toContain("Price per 1M, in / out$4 / $20Same at every effort");
  });
});

describe("index tabs", () => {
  const scroll = (el: HTMLElement, sizes: { scrollWidth: number; clientWidth: number; scrollLeft: number }) => {
    for (const [key, value] of Object.entries(sizes)) Object.defineProperty(el, key, { configurable: true, value });
    act(() => {
      el.dispatchEvent(new Event("scroll"));
    });
    return el.style.maskImage;
  };

  it("fades the edge with more tabs past it and hides the scrollbar on touch screens", () => {
    const row = host.querySelector<HTMLElement>('[role="radiogroup"]')!;
    expect(scroll(row, { scrollWidth: 500, clientWidth: 300, scrollLeft: 0 })).toMatch(/^linear-gradient\(to right, black, .*transparent\)$/);
    expect(scroll(row, { scrollWidth: 500, clientWidth: 300, scrollLeft: 100 })).toMatch(/^linear-gradient\(to right, transparent, .*transparent\)$/);
    expect(scroll(row, { scrollWidth: 500, clientWidth: 300, scrollLeft: 200 })).toMatch(/^linear-gradient\(to right, transparent, .*black\)$/);
    expect(scroll(row, { scrollWidth: 300, clientWidth: 300, scrollLeft: 0 })).toBe("");
    expect(row.className).toContain("pointer-coarse:[scrollbar-width:none]");
  });
});

describe("score vs cost axis", () => {
  const rebuild = async (width: number) => {
    vi.stubGlobal(
      "ResizeObserver",
      class {
        constructor(private cb: (entries: unknown[]) => void) {}
        observe = () => this.cb([{ contentRect: { width } }]);
        disconnect = () => undefined;
      },
    );
    await act(async () => root.unmount());
    host.innerHTML = "";
    root = createRoot(host);
    await act(async () => root.render(createElement(I18nProvider, null, createElement(ModelIndexSection))));
  };
  const ticks = () =>
    [...host.querySelectorAll<SVGGElement>("g[data-mi-enter]")]
      .filter((g) => g.querySelector("line")?.hasAttribute("y1") && !g.hasAttribute("data-mi-leave"))
      .map((g) => ({ label: g.textContent ?? "", x: Number(g.style.transform.match(/translate\(([\d.]+)px/)?.[1]) }));
  const caption = () => [...host.querySelectorAll("text")].find((el) => el.textContent?.includes("Cost per task"))!;
  afterEach(() => vi.unstubAllGlobals());

  it("spans the cheapest to the dearest cost per task, with a one-line caption, at the narrowest desktop width", async () => {
    await rebuild(454);
    const usd = (model: string, effort: string) => MODEL_RUN_COSTS.find((c) => c.model === model && c.effort === effort)!.usd;
    const labels = ticks().map((tick) => tick.label);
    const values = labels.map((label) => Number(label.slice(1)));
    expect(labels.join(), "no k suffix").not.toMatch(/k/);
    expect(values.every(Number.isFinite), labels.join()).toBe(true);
    expect(values[0]!).toBeLessThanOrEqual(usd("gpt-6-luna", "low"));
    expect(values[values.length - 1]!).toBeGreaterThanOrEqual(usd("claude-fable-5", "max"));
    expect(caption().querySelectorAll("tspan")).toHaveLength(0);
  });

  it("keeps labels apart and the caption inside the card at phone widths", async () => {
    for (const width of [320, 360, 376, 420]) {
      await rebuild(width);
      const shown = ticks();
      expect(shown.length, String(width)).toBeGreaterThanOrEqual(2);
      shown.slice(1).forEach((tick, i) => {
        const prev = shown[i]!;
        const half = ((prev.label.length + tick.label.length) * 6) / 2;
        expect(tick.x - prev.x, `${width}: ${prev.label} ${tick.label}`).toBeGreaterThanOrEqual(half);
      });
      const tspans = [...caption().querySelectorAll("tspan")];
      if (width <= 360) expect(tspans.length, String(width)).toBeGreaterThan(1);
      for (const line of tspans.length ? tspans : [caption()]) {
        expect((line.textContent ?? "").length * 6, `${width}: ${line.textContent}`).toBeLessThanOrEqual(width - 36);
      }
    }
  });

  it("centres every caption line inside the plot and keeps the unit note whole", async () => {
    for (const width of [320, 360, 420]) {
      await rebuild(width);
      const axis = [...host.querySelectorAll("line")].find((line) => line.hasAttribute("x1") && line.hasAttribute("y1"))!;
      const [left, right] = [Number(axis.getAttribute("x1")), Number(axis.getAttribute("x2"))];
      const tspans = [...caption().querySelectorAll("tspan")];
      const lines = tspans.length ? tspans : [caption()];
      for (const line of lines) {
        const centre = Number(line.getAttribute("x") ?? caption().getAttribute("x"));
        const half = ((line.textContent ?? "").length * 6 * 11) / 10.5 / 2;
        expect(centre - half, `${width}: ${line.textContent}`).toBeGreaterThanOrEqual(left);
        expect(centre + half, `${width}: ${line.textContent}`).toBeLessThanOrEqual(right);
      }
      expect(lines.some((line) => line.textContent?.includes("(USD, log scale)")), `${width}: ${lines.map((l) => l.textContent).join(" | ")}`).toBe(true);
    }
  });

  it("never draws wider than a narrow phone gives it", async () => {
    await rebuild(260);
    expect(host.querySelector("svg[role=img]")?.getAttribute("width")).toBe("260");
  });

  it("gives phones a taller plot than desktop at the same width, never a shorter one", async () => {
    const svgHeight = () => Number(host.querySelector("svg[role=img]")?.getAttribute("height"));
    const media = vi.spyOn(window, "matchMedia");
    const heights = async (width: number) => {
      // SAFETY: the chart reads only `matches` from its media queries.
      media.mockReturnValue({ matches: false } as MediaQueryList);
      await rebuild(width);
      const desktop = svgHeight();
      // SAFETY: the chart reads only `matches` from its media queries.
      media.mockImplementation((query) => ({ matches: query.includes("max-width") }) as MediaQueryList);
      await rebuild(width);
      return { desktop, phone: svgHeight() };
    };
    try {
      const narrow = await heights(294);
      expect(narrow.phone - narrow.desktop).toBeGreaterThanOrEqual(30);
      const wide = await heights(640);
      expect(wide.phone).toBe(wide.desktop);
    } finally {
      media.mockRestore();
    }
  });

  it("measures labels in the font the app is drawn in", async () => {
    const fonts: string[] = [];
    const ctx = {
      set font(value: string) {
        fonts.push(value);
      },
      measureText: (text: string) => ({ width: text.length * 6 }),
    };
    // SAFETY: the chart only sets `font` and calls `measureText` on its 2D context.
    const getContext = vi.spyOn(window.HTMLCanvasElement.prototype, "getContext").mockReturnValue(ctx as never);
    document.documentElement.style.fontFamily = "serif";
    document.body.style.fontFamily = '"Space Grotesk", sans-serif';
    try {
      await rebuild(360);
      expect(fonts.length).toBeGreaterThan(0);
      expect(fonts.at(-1)).toContain("Space Grotesk");
    } finally {
      getContext.mockRestore();
      document.documentElement.style.fontFamily = "";
      document.body.style.fontFamily = "";
    }
  });
});

describe("full screen chart", () => {
  const rebuild = async (phone: boolean, size: { width: number; height: number }) => {
    vi.stubGlobal(
      "ResizeObserver",
      class {
        constructor(private cb: (entries: unknown[]) => void) {}
        observe = () => this.cb([{ contentRect: size }]);
        disconnect = () => undefined;
      },
    );
    // SAFETY: isPhone only reads .matches
    vi.spyOn(window, "matchMedia").mockImplementation((query) => ({ matches: phone && query.includes("max-width") }) as MediaQueryList);
    await act(async () => root.unmount());
    host.innerHTML = "";
    root = createRoot(host);
    await act(async () => root.render(createElement(I18nProvider, null, createElement(ModelIndexSection))));
  };
  const button = (label: string) => host.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`);
  const svg = () => host.querySelector("svg[role=img]")!;
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("offers full screen on phones only", async () => {
    await rebuild(false, { width: 640, height: 400 });
    expect(button("Full screen")).toBeNull();
    await rebuild(true, { width: 360, height: 400 });
    expect(button("Full screen")).not.toBeNull();
  });

  it("fills the screen with the chart, then closes back into the card", async () => {
    await rebuild(true, { width: 780, height: 330 });
    const inline = svg().getAttribute("height");
    act(() => button("Full screen")!.click());
    expect(svg().getAttribute("width")).toBe("780");
    expect(svg().getAttribute("height")).toBe("330");
    act(() => button("Exit full screen")!.click());
    expect(button("Exit full screen")).toBeNull();
    expect(svg().getAttribute("height")).toBe(inline);
  });

  it("closes when Back leaves full screen before the request settles", async () => {
    await rebuild(true, { width: 780, height: 330 });
    let shown: Element | null = null;
    const request = vi.fn(() => new Promise<void>(() => undefined));
    const original = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "requestFullscreen");
    Object.defineProperty(document, "fullscreenElement", { configurable: true, get: () => shown });
    Object.defineProperty(HTMLElement.prototype, "requestFullscreen", { configurable: true, value: request });
    try {
      act(() => button("Full screen")!.click());
      expect(request).toHaveBeenCalledTimes(1);
      shown = svg();
      act(() => void document.dispatchEvent(new Event("fullscreenchange")));
      shown = null;
      act(() => void document.dispatchEvent(new Event("fullscreenchange")));
      expect(button("Exit full screen")).toBeNull();
    } finally {
      Reflect.deleteProperty(document, "fullscreenElement");
      if (original) Object.defineProperty(HTMLElement.prototype, "requestFullscreen", original);
      else Reflect.deleteProperty(HTMLElement.prototype, "requestFullscreen");
    }
  });
});
