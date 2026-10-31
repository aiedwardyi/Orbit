// @vitest-environment happy-dom
import { act, createElement, useRef } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SWIPE_MOTION_MS } from "./phone-swipe";
import { useSettingsSwipe } from "./use-settings-swipe";

let host: HTMLDivElement;
let root: Root;
let reduced: boolean;
let time: number;
const back = vi.fn();
const dialog = () => host.querySelector<HTMLElement>("[data-dialog]")!;
const stage = () => host.querySelector<HTMLElement>("[data-settings-page]")!;
const list = () => host.querySelector<HTMLElement>("[data-settings-underlay]")!;

function Harness({ phone = true, page = "usage" as string | false }) {
  const ref = useRef<HTMLDivElement>(null);
  useSettingsSwipe(ref, phone, page, back);
  return createElement("div", null,
    createElement("div", { "data-settings-scrim": true }),
    createElement("div", { ref, "data-dialog": true },
      createElement("div", { "data-settings-underlay": true }, createElement("nav", { "data-settings-list": true }, "Settings")),
      page && createElement("div", { "data-settings-page": page },
        createElement("p", null, "Usage"),
        createElement("input", { type: "range" }),
        createElement("input", { type: "text" }),
        createElement("textarea"),
        createElement("div", { role: "slider" }, createElement("span")),
        createElement("div", { className: "dial-stage" }, createElement("span")),
        createElement("div", { "data-no-swipe": true }, createElement("span")),
        createElement("div", { "data-horizontal": true, style: { overflowX: "auto" } }, createElement("span")),
      ),
    ),
  );
}

function touch(type: string, x: number, y = 200, target: Element = stage() ?? list(), dt = 200) {
  time += dt;
  const event = new Event(type, { bubbles: true, cancelable: true });
  Object.defineProperties(event, {
    touches: { value: type === "touchend" || type === "touchcancel" ? [] : [{ clientX: x, clientY: y }] },
    timeStamp: { value: time },
  });
  target.dispatchEvent(event);
  return event;
}

async function render(props = {}) {
  await act(async () => root.render(createElement(Harness, props)));
}

async function release(type = "touchend", dt = 200) {
  await act(async () => { touch(type, 0, 200, stage() ?? list(), dt); vi.advanceTimersByTime(SWIPE_MOTION_MS); });
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  reduced = false;
  time = 0;
  back.mockReset();
  vi.spyOn(window, "matchMedia").mockImplementation((query) => ({ matches: query.includes("reduced-motion") && reduced } as MediaQueryList));
  host = document.body.appendChild(document.createElement("div"));
  root = createRoot(host);
});

afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  window.getSelection()?.removeAllRanges();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("Settings swipe", () => {
  it("tracks the finger 1:1 and reveals the shifted, dimmed list without reading layout on move", async () => {
    await render();
    touch("touchstart", 0);
    const width = vi.spyOn(HTMLElement.prototype, "clientWidth", "get");
    const style = vi.spyOn(window, "getComputedStyle");
    touch("touchmove", 100);
    expect(stage().style.transform).toBe("translate3d(100px, 0, 0)");
    expect(list().style.transform).toContain("translate3d(-");
    expect(Number(list().style.opacity)).toBeGreaterThan(0.8);
    expect(width).not.toHaveBeenCalled();
    expect(style).not.toHaveBeenCalled();
    expect(host.querySelector<HTMLElement>("[data-settings-list]")!.style.cssText).toBe("");
  });

  it("commits past 35 percent after the release animation", async () => {
    await render();
    touch("touchstart", 0);
    touch("touchmove", window.innerWidth * 0.36, 200, stage(), 2000);
    touch("touchend", 0);
    expect(back).not.toHaveBeenCalled();
    expect(stage().style.transition).toContain(`${SWIPE_MOTION_MS}ms`);
    await act(async () => vi.advanceTimersByTime(SWIPE_MOTION_MS));
    expect(back).toHaveBeenCalledOnce();
  });

  it("springs back below 35 percent and clears temporary styles", async () => {
    await render();
    touch("touchstart", 0);
    touch("touchmove", window.innerWidth * 0.34, 200, stage(), 2000);
    await release();
    expect(back).not.toHaveBeenCalled();
    expect(stage().style.cssText).toBe("");
    expect(list().style.transform).toBe("");
  });

  it("commits a short rightward flick", async () => {
    await render();
    touch("touchstart", 10);
    touch("touchmove", 60, 200, stage(), 30);
    await release("touchend", 10);
    expect(back).toHaveBeenCalledOnce();
  });

  it("does not treat a paused finger as a flick", async () => {
    await render();
    touch("touchstart", 10);
    touch("touchmove", 60, 200, stage(), 30);
    await release();
    expect(back).not.toHaveBeenCalled();
  });

  it.each([[2, 100], [40, 40], [-100, 2], [8, 2]])("ignores vertical, diagonal, leftward and tiny starts (%i, %i)", async (dx, dy) => {
    await render();
    touch("touchstart", 150);
    const event = touch("touchmove", 150 + dx, 200 + dy);
    expect(event.defaultPrevented).toBe(false);
    expect(stage().style.transform).toBe("");
    await release();
    expect(back).not.toHaveBeenCalled();
  });

  it.each(['input[type="range"]', 'input[type="text"]', "textarea", '[role="slider"] span', ".dial-stage span", "[data-no-swipe] span", "[data-horizontal] span"])("leaves %s in control of its drag", async (selector) => {
    await render();
    const target = stage().querySelector(selector)!;
    const horizontal = stage().querySelector("[data-horizontal]")!;
    Object.defineProperties(horizontal, { scrollWidth: { value: 600 }, clientWidth: { value: 200 } });
    touch("touchstart", 20, 200, target);
    expect(touch("touchmove", 600, 200, target).defaultPrevented).toBe(false);
    await release();
    expect(back).not.toHaveBeenCalled();
  });

  it("leaves selected text alone", async () => {
    await render();
    const range = document.createRange();
    range.selectNodeContents(stage().querySelector("p")!);
    window.getSelection()!.addRange(range);
    touch("touchstart", 20);
    touch("touchmove", 600);
    await release();
    expect(back).not.toHaveBeenCalled();
  });

  it("cancels a touch without navigating", async () => {
    await render();
    touch("touchstart", 20);
    touch("touchmove", 600);
    await release("touchcancel");
    expect(back).not.toHaveBeenCalled();
    expect(stage().style.transform).toBe("");
  });

  it("preserves text selected after a long press starts", async () => {
    await render();
    touch("touchstart", 20);
    const range = document.createRange();
    range.selectNodeContents(stage().querySelector("p")!);
    window.getSelection()!.addRange(range);
    touch("touchmove", 600);
    await release();
    expect(back).not.toHaveBeenCalled();
  });

  it("springs back when a second finger joins the drag", async () => {
    await render();
    touch("touchstart", 20);
    touch("touchmove", 600);
    const event = new Event("touchstart", { bubbles: true });
    Object.defineProperty(event, "touches", { value: [{ clientX: 600, clientY: 200 }, { clientX: 650, clientY: 200 }] });
    stage().dispatchEvent(event);
    await release();
    expect(back).not.toHaveBeenCalled();
    expect(stage().style.transform).toBe("");
  });

  it("slides the top-level dialog and fades its scrim before closing", async () => {
    await render({ page: false });
    touch("touchstart", 20);
    touch("touchmove", 600);
    expect(dialog().style.transform).toContain("580px");
    expect(Number(host.querySelector<HTMLElement>("[data-settings-scrim]")!.style.opacity)).toBeLessThan(1);
    await release();
    expect(back).toHaveBeenCalledOnce();
  });

  it("uses plain back on release with reduced motion", async () => {
    reduced = true;
    await render();
    touch("touchstart", 20);
    touch("touchmove", 600);
    expect(stage().style.transform).toBe("");
    expect(list().style.opacity).toBe("");
    touch("touchend", 600);
    expect(back).toHaveBeenCalledOnce();
    expect(stage().style.transition).toBe("");
  });

  it("attaches no touch handler on desktop", async () => {
    const listener = vi.spyOn(HTMLElement.prototype, "addEventListener");
    await render({ phone: false });
    expect(listener.mock.calls.filter(([name]) => name.startsWith("touch"))).toEqual([]);
    touch("touchstart", 20);
    touch("touchmove", 600);
    await release();
    expect(back).not.toHaveBeenCalled();
  });

  it("cancels a pending commit when the Back button changes the page", async () => {
    await render();
    touch("touchstart", 20);
    touch("touchmove", 600);
    touch("touchend", 600);
    await render({ page: false });
    await act(async () => vi.advanceTimersByTime(SWIPE_MOTION_MS));
    expect(back).not.toHaveBeenCalled();
    expect(list().style.transform).toBe("");
  });
});
