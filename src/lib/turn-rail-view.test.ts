// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from "vitest";

import type { Turns } from "./turn-index";
import { createTurnRail } from "./turn-rail-view";

const at = (day: number, hour: number) => new Date(2026, 9, day, hour).getTime();

afterEach(() => {
  document.body.innerHTML = "";
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("card day headers", () => {
  it("heads no day whose rows all sit under the header slot", async () => {
    vi.stubGlobal("ResizeObserver", class {
      observe() {}
      disconnect() {}
    });
    vi.spyOn(HTMLElement.prototype, "offsetWidth", "get").mockReturnValue(1000);
    vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockReturnValue(992);
    vi.spyOn(HTMLElement.prototype, "clientHeight", "get").mockReturnValue(800);
    const zone = document.createElement("div");
    const scroller = document.createElement("div");
    const host = document.createElement("div");
    zone.append(scroller, host);
    document.body.append(zone);
    const times = [at(15, 9), at(15, 10), at(15, 11), ...Array.from({ length: 7 }, (_, t) => at(16, 9 + t))];
    const turns: Turns = { ids: times.map((_, t) => `m${t}`), at: times, words: times.map((_, t) => `turn ${t}`), first: "m0", version: 1, stale: false, seen: { count: 0 } };
    const rail = createTurnRail(host, scroller, {
      turns: async () => turns,
      catchUp: () => false,
      jump() {},
      latest() {},
      wheel() {},
      day: (ms) => `day ${new Date(ms).getDate()}`,
      time: () => "00:00",
      label: () => "",
      valueText: () => "",
    });
    rail.setThread("t");
    rail.setEnabled(true);
    const strip = host.querySelector<HTMLElement>("[data-turn-rail-strip]")!;
    await vi.waitFor(() => expect(strip.style.height).toBe("784px"));
    // the band holds the 16th's third turn mid-card, which leaves the 15th's last row under the slot
    strip.dispatchEvent(new PointerEvent("pointerenter", { pointerType: "mouse", clientY: 16 + 429 }));
    const shown = () => [...host.querySelectorAll<HTMLElement>(".turn-card-head")].filter((head) => !head.style.transform.includes("-999")).map((head) => head.textContent);
    await vi.waitFor(() => expect(shown()).toContain("day 16"));
    expect(shown()).toEqual(["day 16"]);
    rail.destroy();
  });
});

describe("hover intent", () => {
  async function mount() {
    vi.useFakeTimers();
    vi.stubGlobal("ResizeObserver", class {
      observe() {}
      disconnect() {}
    });
    vi.spyOn(HTMLElement.prototype, "offsetWidth", "get").mockReturnValue(1000);
    vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockReturnValue(992);
    vi.spyOn(HTMLElement.prototype, "clientHeight", "get").mockReturnValue(800);
    const zone = document.createElement("div");
    const scroller = document.createElement("div");
    const host = document.createElement("div");
    zone.append(scroller, host);
    document.body.append(zone);
    const times = Array.from({ length: 40 }, (_, t) => at(16, 0) + t * 600_000);
    const turns: Turns = { ids: times.map((_, t) => `m${t}`), at: times, words: times.map((_, t) => `turn ${t}`), first: "m0", version: 1, stale: false, seen: { count: 0 } };
    const jumps: string[] = [];
    const rail = createTurnRail(host, scroller, {
      turns: async () => turns,
      catchUp: () => false,
      jump: (id) => jumps.push(id),
      latest: () => jumps.push("latest"),
      wheel() {},
      day: () => "day",
      time: () => "00:00",
      label: () => "",
      valueText: () => "",
    });
    rail.setThread("t");
    rail.setEnabled(true);
    await vi.advanceTimersByTimeAsync(50);
    const strip = host.querySelector<HTMLElement>("[data-turn-rail-strip]")!;
    const card = host.querySelector<HTMLElement>("[data-turn-card]")!;
    zone.dispatchEvent(new PointerEvent("pointermove", { pointerType: "mouse", clientX: 980, clientY: 400 }));
    await vi.advanceTimersByTimeAsync(50);
    expect(strip.getAttribute("aria-valuemax")).toBe("40");
    const mouse = (el: HTMLElement, type: string, clientX: number, clientY: number) => el.dispatchEvent(new PointerEvent(type, { pointerType: "mouse", clientX, clientY }));
    const open = () => card.classList.contains("live");
    // a straight path in 8 ms steps; true if the card opened on the way
    const path = (from: [number, number], to: [number, number], speed: number, enter = true) => {
      const steps = Math.max(1, Math.ceil(Math.hypot(to[0] - from[0], to[1] - from[1]) / (speed * 8)));
      if (enter) mouse(strip, "pointerenter", ...from);
      let opened = open();
      for (let k = 1; k <= steps; k++) {
        vi.advanceTimersByTime(8);
        mouse(strip, "pointermove", from[0] + ((to[0] - from[0]) * k) / steps, from[1] + ((to[1] - from[1]) * k) / steps);
        opened ||= open();
      }
      return opened;
    };
    const wait = (ms: number) => {
      for (let t = 0; t < ms; t += 4) {
        vi.advanceTimersByTime(4);
        if (open()) return t + 4;
      }
      return Infinity;
    };
    return { rail, strip, card, jumps, mouse, open, path, wait };
  }

  afterEach(() => vi.useRealTimers());

  it.each([0.3, 1, 3])("opens nothing for a mouse that crosses the strip at %s px/ms", async (speed) => {
    const ui = await mount();
    for (const y of [40, 200, 400, 600, 760]) {
      expect(ui.path([992, y], [962, y], speed)).toBe(false);
      ui.mouse(ui.strip, "pointerleave", 961, y);
      expect(ui.wait(400)).toBe(Infinity);
    }
    expect(ui.path([992, 100], [962, 130], 1)).toBe(false);
    ui.mouse(ui.strip, "pointerleave", 961, 131);
    expect(ui.path([992, 700], [962, 680], 1)).toBe(false);
    ui.mouse(ui.strip, "pointerleave", 961, 679);
    expect(ui.wait(400)).toBe(Infinity);
    ui.rail.destroy();
  });

  it("opens once the mouse rests on the strip, and while it moves up or down", async () => {
    const ui = await mount();
    expect(ui.path([992, 300], [976, 300], 1)).toBe(false);
    expect(ui.wait(200)).toBeLessThanOrEqual(100);
    ui.mouse(ui.strip, "pointerleave", 961, 300);
    vi.advanceTimersByTime(400);
    expect(ui.open()).toBe(false);

    expect(ui.path([992, 300], [976, 300], 1)).toBe(false);
    expect(ui.path([976, 300], [977, 400], 1, false)).toBe(true);
    ui.rail.destroy();
  });

  it("does not jump on a click in the card's first moments, and opens it on a click with none open", async () => {
    const ui = await mount();
    ui.path([992, 300], [976, 300], 1);
    expect(ui.wait(200)).toBeLessThan(200);
    ui.strip.click();
    expect(ui.jumps).toEqual([]);
    expect(ui.open()).toBe(true);
    ui.mouse(ui.card, "pointermove", 900, 300);
    ui.card.click();
    expect(ui.jumps).toEqual([]);
    expect(ui.open()).toBe(true);
    vi.advanceTimersByTime(300);
    ui.card.click();
    expect(ui.jumps).toHaveLength(1);
    expect(ui.open()).toBe(false);

    ui.mouse(ui.strip, "pointerenter", 980, 300);
    ui.strip.click();
    expect(ui.open()).toBe(true);
    expect(ui.jumps).toHaveLength(1);
    vi.advanceTimersByTime(300);
    ui.strip.click();
    expect(ui.jumps).toHaveLength(2);
    ui.rail.destroy();
  });
});
