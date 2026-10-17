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
