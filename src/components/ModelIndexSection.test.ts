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
});
