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
    const turns: Turns = { ids: times.map((_, t) => `m${t}`), at: times, words: times.map((_, t) => `turn ${t}`), media: times.map(() => 0), first: "m0", version: 1, stale: false, seen: { count: 0 } };
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
      glyph: () => document.createElement("i"),
      mediaWords: () => "",
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
    const turns: Turns = { ids: times.map((_, t) => `m${t}`), at: times, words: times.map((_, t) => `turn ${t}`), media: times.map(() => 0), first: "m0", version: 1, stale: false, seen: { count: 0 } };
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
      glyph: () => document.createElement("i"),
      mediaWords: () => "",
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

describe("zoom grab", () => {
  async function mount() {
    vi.useFakeTimers();
    vi.stubGlobal("ResizeObserver", class {
      observe() {}
      disconnect() {}
    });
    vi.spyOn(HTMLElement.prototype, "offsetWidth", "get").mockReturnValue(1000);
    vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockReturnValue(1000);
    vi.spyOn(HTMLElement.prototype, "clientHeight", "get").mockReturnValue(800);
    const zone = document.createElement("div");
    const scroller = document.createElement("div");
    const host = document.createElement("div");
    zone.append(scroller, host);
    document.body.append(zone);
    const chat = { top: 12_000, height: 20_000 };
    Object.defineProperty(scroller, "scrollHeight", { get: () => chat.height });
    Object.defineProperty(scroller, "scrollTop", { get: () => chat.top, set: (v: number) => (chat.top = v) });
    const times = Array.from({ length: 40 }, (_, t) => at(16, 0) + t * 600_000);
    const turns: Turns = { ids: times.map((_, t) => `m${t}`), at: times, words: times.map((_, t) => `turn ${t}`), media: times.map(() => 0), first: "m0", version: 1, stale: false, seen: { count: 0 } };
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
      glyph: () => document.createElement("i"),
      mediaWords: () => "",
    });
    rail.setThread("t");
    rail.setEnabled(true);
    await vi.advanceTimersByTimeAsync(50);
    const strip = host.querySelector<HTMLElement>("[data-turn-rail-strip]")!;
    const card = host.querySelector<HTMLElement>("[data-turn-card]")!;
    zone.dispatchEvent(new PointerEvent("pointermove", { pointerType: "mouse", clientX: 980, clientY: 400 }));
    await vi.advanceTimersByTimeAsync(50);
    expect(strip.getAttribute("aria-valuemax")).toBe("40");
    const mouse = (type: string, clientY: number) => strip.dispatchEvent(new PointerEvent(type, { pointerType: "mouse", pointerId: 1, clientX: 985, clientY }));
    // following, the mark sits on the latest turn at the rail's foot: rail y 768, client y 784
    return { rail, strip, card, chat, jumps, mouse };
  }

  afterEach(() => vi.useRealTimers());

  it("grabs on a press within 12 px of the mark, with a grab cursor, and not elsewhere", async () => {
    const ui = await mount();
    ui.mouse("pointerenter", 784 - 11);
    expect(ui.strip.classList.contains("grab")).toBe(true);
    ui.mouse("pointermove", 784 - 14);
    expect(ui.strip.classList.contains("grab")).toBe(false);
    ui.mouse("pointerdown", 784 - 14);
    expect(ui.strip.classList.contains("grabbing")).toBe(false);
    ui.mouse("pointerup", 784 - 14);

    ui.mouse("pointermove", 784 - 11);
    ui.mouse("pointerdown", 784 - 11);
    expect(ui.strip.classList.contains("grabbing")).toBe(true);
    expect(ui.chat.top).toBe(12_000);
    ui.mouse("pointerup", 784 - 11);
    expect(ui.strip.classList.contains("grabbing")).toBe(false);
    ui.rail.destroy();
  });

  it("moves the chat at the scrollbar's pace over the mounted rows while held", async () => {
    const ui = await mount();
    ui.mouse("pointerenter", 784);
    ui.mouse("pointerdown", 784);
    // thumb 768 * 800 / 20000 = 30.72 px, so 19200 px of chat over 737.28 px of track
    const pace = 19_200 / (768 - 30.72);
    ui.mouse("pointermove", 734);
    expect(ui.chat.top).toBeCloseTo(12_000 - 50 * pace, 3);
    ui.mouse("pointermove", 584);
    expect(ui.chat.top).toBeCloseTo(12_000 - 200 * pace, 3);
    ui.mouse("pointerup", 584);
    ui.rail.destroy();
  });

  it("folds a page that lands mid-drag into the drag's base", async () => {
    const ui = await mount();
    ui.mouse("pointerenter", 784);
    ui.mouse("pointerdown", 784);
    const pace = 19_200 / (768 - 30.72);
    ui.mouse("pointermove", 684);
    const before = ui.chat.top;
    // an older page lands above and anchoring keeps the rows in view
    ui.chat.height += 6_000;
    ui.chat.top += 6_000;
    ui.mouse("pointermove", 634);
    expect(ui.chat.top).toBeCloseTo(before + 6_000 - 50 * pace, 3);
    ui.mouse("pointerup", 634);
    ui.rail.destroy();
  });

  it("moves nothing on the press or the release, and the release neither opens the card nor jumps", async () => {
    const ui = await mount();
    ui.mouse("pointerenter", 784);
    ui.mouse("pointerdown", 784);
    expect(ui.chat.top).toBe(12_000);
    ui.mouse("pointermove", 700);
    const held = ui.chat.top;
    expect(held).toBeLessThan(12_000);
    ui.mouse("pointerup", 700);
    ui.strip.click();
    expect(ui.chat.top).toBe(held);
    await vi.advanceTimersByTimeAsync(400);
    expect(ui.chat.top).toBe(held);
    expect(ui.card.classList.contains("live")).toBe(false);
    expect(ui.jumps).toEqual([]);
    ui.rail.destroy();
  });
});

describe("touch", () => {
  it("loads the turns when a scroll wakes the rail, so the first quick tap opens the card", async () => {
    vi.stubGlobal("matchMedia", (query: string) => ({ matches: query === "(hover: none)", media: query, addEventListener() {}, removeEventListener() {} }));
    vi.stubGlobal("ResizeObserver", class {
      observe() {}
      disconnect() {}
    });
    vi.spyOn(HTMLElement.prototype, "offsetWidth", "get").mockReturnValue(390);
    vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockReturnValue(382);
    vi.spyOn(HTMLElement.prototype, "clientHeight", "get").mockReturnValue(800);
    const zone = document.createElement("div");
    const scroller = document.createElement("div");
    const host = document.createElement("div");
    zone.append(scroller, host);
    document.body.append(zone);
    const times = Array.from({ length: 10 }, (_, t) => at(16, 9) + t * 600_000);
    const turns: Turns = { ids: times.map((_, t) => `m${t}`), at: times, words: times.map((_, t) => `turn ${t}`), media: times.map(() => 0), first: "m0", version: 1, stale: false, seen: { count: 0 } };
    let fetches = 0;
    let land!: () => void;
    const rail = createTurnRail(host, scroller, {
      turns: () => {
        fetches++;
        return new Promise<Turns>((resolve) => { land = () => resolve(turns); });
      },
      catchUp: () => false,
      jump() {},
      latest() {},
      wheel() {},
      day: () => "day",
      time: () => "00:00",
      label: () => "",
      valueText: () => "",
      glyph: () => document.createElement("i"),
      mediaWords: () => "",
    });
    rail.setThread("t");
    rail.setEnabled(true);
    rail.setFollowing(false);
    const strip = host.querySelector<HTMLElement>("[data-turn-rail-strip]")!;
    const card = host.querySelector<HTMLElement>("[data-turn-card]")!;
    await vi.waitFor(() => expect(strip.style.height).toBe("792px"));

    scroller.dispatchEvent(new Event("scroll"));
    expect(fetches).toBe(1);
    land();
    await vi.waitFor(() => expect(strip.getAttribute("aria-valuemax")).toBe("10"));

    const touch = (type: string) => strip.dispatchEvent(new PointerEvent(type, { pointerType: "touch", pointerId: 1, clientY: 400, bubbles: true, cancelable: true }));
    touch("pointerdown");
    touch("pointerup");
    expect(card.classList.contains("live")).toBe(true);
    rail.destroy();
  });
});
