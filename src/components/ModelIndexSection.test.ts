import "./ProfileFields.test-dom.ts";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { I18nProvider, applyLocale, localeTag } from "@/lib/i18n";
import { MODEL_INDEX_ENTRIES, MODEL_INDEX_SOURCES } from "../../shared/model-index-data.ts";

vi.mock("@/state/store", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/state/store")>()),
  useStore: () => ({ state: { instances: [] }, dispatch: () => undefined }),
}));

import { ModelIndexSection } from "./ModelIndexSection";

let root: Root;
let host: HTMLElement;

const tab = () => host.querySelector('[role="radio"][aria-checked="true"]')?.textContent;
const group = (label: string) => host.querySelector(`[role="radiogroup"][aria-label="${label}"]`);
const chosen = (label: string) => group(label)?.querySelector('[aria-checked="true"]')?.textContent;
const pick = (label: string, option: string) =>
  act(() => [...group(label)!.querySelectorAll<HTMLButtonElement>('[role="radio"]')].find((el) => el.textContent === option)!.click());
const mount = async () => {
  await act(async () => root.unmount());
  host.innerHTML = "";
  root = createRoot(host);
  await act(async () => root.render(createElement(I18nProvider, null, createElement(ModelIndexSection))));
};
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
    for (let i = 0; i < 5; i++) {
      press(window);
      seen.push(tab());
    }
    expect(seen).toEqual(["Intelligence", "Coding", "General work", "Legal", "Cost", "Intelligence"]);
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

describe("coding tabs", () => {
  it("puts Terminal-Bench first under Coding, DeepSWE second, and no Agentic tab", () => {
    expect([...group("Benchmark")!.querySelectorAll('[role="radio"]')].map((el) => el.textContent)).toEqual([
      "Intelligence",
      "Coding",
      "General work",
      "Legal",
      "Cost",
    ]);
    expect(group("Coding benchmark")).toBeNull();
    pick("Benchmark", "Coding");
    expect([...group("Coding benchmark")!.querySelectorAll('[role="radio"]')].map((el) => el.textContent)).toEqual(["Terminal-Bench", "DeepSWE"]);
    expect(chosen("Coding benchmark")).toBe("Terminal-Bench");
    expect(host.textContent).toContain("Terminal-Bench 4.0, % resolved");
    pick("Coding benchmark", "DeepSWE");
    expect(host.textContent).toContain("DeepSWE v1.1, % resolved");
  });

  it("keeps the chosen coding benchmark across view and tab switches", () => {
    pick("Benchmark", "Coding");
    pick("Coding benchmark", "DeepSWE");
    pick("Chart", "Ranked");
    expect(chosen("Coding benchmark")).toBe("DeepSWE");
    pick("Benchmark", "Legal");
    pick("Benchmark", "Coding");
    expect(chosen("Coding benchmark")).toBe("DeepSWE");
    for (let i = 0; i < 5; i++) press(window);
    expect(chosen("Coding benchmark")).toBe("DeepSWE");
    expect(host.textContent).toContain("DeepSWE v1.1, % resolved");
  });
});

describe("source freshness", () => {
  const STALE = "Not updated since";
  const sourceFor = (index: string) => {
    const source = Object.values(MODEL_INDEX_SOURCES).find((entry) => entry.index === index);
    if (!source) throw new Error(`no source for ${index}`);
    return source;
  };
  const nbDay = (iso: string) =>
    new Date(iso.slice(0, 10))
      .toLocaleDateString(localeTag("en"), { year: "numeric", month: "short", day: "numeric", timeZone: "UTC" })
      .replace(/ /g, "\u00a0");
  const atLocal = (iso: string, plusDays: number, hour: number, minute: number) => {
    const [year, month, day] = iso.slice(0, 10).split("-").map(Number);
    if (year === undefined || month === undefined || day === undefined) throw new Error(`bad date ${iso}`);
    return new Date(year, month - 1, day + plusDays, hour, minute);
  };
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("says when it was checked when the source publishes no date", () => {
    expect(host.textContent).toContain(`Checked ${nbDay(sourceFor("intelligence").retrievedAt)}`);
    expect(host.textContent).not.toContain("Source updated");
  });

  it("shows the source's own date beside the check", async () => {
    const legal = sourceFor("legal");
    if (legal.updated === null) throw new Error("legal publishes no date");
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(atLocal(legal.updated, 14, 23, 30));
    await mount();
    pick("Benchmark", "Legal");
    expect(host.textContent).toContain(`Source updated ${nbDay(legal.updated)} \u00b7 checked ${nbDay(legal.retrievedAt)}`);
    expect(host.textContent).not.toContain(STALE);
  });

  it("flags a source not updated for more than 14 days", async () => {
    const coding = sourceFor("coding");
    if (coding.updated === null) throw new Error("coding publishes no date");
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(atLocal(coding.updated, 14, 23, 30));
    await mount();
    pick("Benchmark", "Coding");
    pick("Coding benchmark", "DeepSWE");
    expect(host.textContent).toContain(`Source updated ${nbDay(coding.updated)}`);
    expect(host.textContent).not.toContain(STALE);
    vi.setSystemTime(atLocal(coding.updated, 15, 0, 30));
    await mount();
    pick("Benchmark", "Coding");
    pick("Coding benchmark", "DeepSWE");
    const badge = [...host.querySelectorAll("span")].find((el) => el.textContent === `${STALE} ${nbDay(coding.updated)}`);
    expect(badge?.className).toContain("text-warning");
  });

  it("flags a source with no published date once it was last checked more than 14 days ago", async () => {
    const CHECKED = "Not checked since";
    const checked = nbDay(sourceFor("intelligence").retrievedAt);
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(atLocal(sourceFor("intelligence").retrievedAt, 14, 23, 30));
    await mount();
    expect(host.textContent).toContain(`Checked ${checked}`);
    expect(host.textContent).not.toContain(CHECKED);
    vi.setSystemTime(atLocal(sourceFor("intelligence").retrievedAt, 15, 0, 30));
    await mount();
    const badge = [...host.querySelectorAll("span")].find((el) => el.textContent === `${CHECKED} ${checked}`);
    expect(badge?.className).toContain("text-warning");
    expect(host.textContent).not.toContain(STALE);
  });
});

describe("model filter", () => {
  it("has no Show all toggle and draws every point at full strength", () => {
    expect(host.textContent).not.toContain("Show all models");
    const faded = [...host.querySelectorAll<HTMLElement>("[data-mi-move]")].filter((el) => ["0.4", "0.5", "0.3"].includes(el.style.opacity));
    expect(faded).toHaveLength(0);
  });

  it("charts only picker models on every tab", () => {
    const named = () => [...host.querySelectorAll('[tabindex="0"]')].map((el) => el.getAttribute("aria-label") ?? el.textContent ?? "").join("|");
    for (let i = 0; i < 5; i++) {
      expect(named(), tab() ?? "").not.toMatch(/GLM|Kimi|Qwen|DeepSeek|Inkling|Haiku 4\.5/);
      if (tab() === "Coding") {
        pick("Coding benchmark", "DeepSWE");
        expect(named(), "DeepSWE").not.toMatch(/GLM|Kimi|Qwen|DeepSeek|Inkling|Haiku 4\.5/);
      }
      press(window);
    }
  });

  it("charts Argon on Legal and Cost, its only indexes with data", () => {
    const named = () => [...host.querySelectorAll('[tabindex="0"]')].map((el) => el.getAttribute("aria-label") ?? el.textContent ?? "").join("|");
    for (const benchmark of ["Intelligence", "Coding", "General work"]) {
      pick("Benchmark", benchmark);
      expect(named(), benchmark).not.toMatch(/Argon/);
      if (benchmark === "Coding") {
        pick("Coding benchmark", "DeepSWE");
        expect(named(), "DeepSWE").not.toMatch(/Argon/);
      }
    }
    for (const benchmark of ["Legal", "Cost"]) {
      pick("Benchmark", benchmark);
      expect(named(), benchmark).toMatch(/Gemini 4 Argon/);
    }
  });
});

describe("cost tab", () => {
  it("shows input / output list price per 1M tokens", () => {
    for (let i = 0; i < 4; i++) press(window);
    expect(tab()).toBe("Cost");
    const opus = [...host.querySelectorAll('[tabindex="0"]')].find((el) => el.textContent?.includes("Claude Opus 5.5"));
    expect(opus?.textContent).toContain("$4 / $20");
    expect(host.textContent).toContain("List price per 1M tokens");
    expect(host.textContent).toContain("Ranked by the 7:2:1 blend");
  });
});

describe("promo price on the cost tab", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  const costRow = async (day: [number, number, number], model: string, locale: "en" | "ko" = "en") => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date(...day, 12));
    vi.stubGlobal("localStorage", { getItem: () => locale });
    await mount();
    for (let i = 0; i < 4; i++) press(window);
    return [...host.querySelectorAll('[tabindex="0"]')].find((el) => el.textContent?.includes(model))?.textContent;
  };

  it("shows both prices with the start date before it, in English and Korean", async () => {
    expect(await costRow([2026, 10, 30], "Gemini 4 Argon")).toBe("Gemini 4 Argon$2\u00a0/\u00a0$10, $4\u00a0/\u00a0$20 from Dec\u00a01");
    expect(await costRow([2026, 11, 30], "Gemini 3.8 Flash")).toBe("Gemini 3.8 Flash$0.75\u00a0/\u00a0$3.75, $1.50\u00a0/\u00a0$7.50 from Jan\u00a01");
    expect(await costRow([2026, 10, 30], "Gemini 4 Argon", "ko")).toBe("Gemini 4 Argon$2\u00a0/\u00a0$10, 12월\u00a01일부터 $4\u00a0/\u00a0$20");
  });

  it("shows only the new price, with no promo wording, once it starts", async () => {
    expect(await costRow([2026, 11, 1], "Gemini 4 Argon")).toBe("Gemini 4 Argon$4 / $20");
    expect(await costRow([2026, 11, 1], "Gemini 4 Argon", "ko")).toBe("Gemini 4 Argon$4 / $20");
    expect(await costRow([2027, 0, 1], "Gemini 3.8 Flash")).toBe("Gemini 3.8 Flash$1.50 / $7.50");
    expect(host.textContent).not.toMatch(/ from |promo/);
  });

  it("leaves a row with no next as one price", async () => {
    expect(await costRow([2026, 10, 30], "Claude Opus 5.5")).toBe("Claude Opus 5.5$4 / $20");
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

  it("names the coding benchmark and shows the 95% interval and harness when the row has them", () => {
    pick("Benchmark", "Coding");
    const terminal = hoverTip("Claude Opus 5.5 high");
    expect(terminal).toMatch(/%Terminal-Bench/);
    expect(terminal).toContain("Cost per task");
    expect(terminal).not.toMatch(/95% CI|Harness/);
    pick("Coding benchmark", "DeepSWE");
    const tip = hoverTip("Claude Fable 5 low");
    expect(tip).toContain("59.6%DeepSWE95% CI 56.8-62.4%");
    expect(tip).toContain("Harnessmini-swe-agent");
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
    const usd = (model: string, effort: string) => MODEL_INDEX_ENTRIES.find((e) => e.index === "intelligence" && e.model === model && e.effort === effort)!.cost!;
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
