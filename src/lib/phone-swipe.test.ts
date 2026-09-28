import "@/components/ProfileFields.test-dom.ts";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createElement, useRef } from "react";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  SWIPE_EDGE,
  dragOffset,
  hapticTick,
  lockAxis,
  neighborId,
  sidebarBotIds,
  swipeBlocked,
  swipeStep,
} from "./phone-swipe";
import { usePhoneSwipe } from "./use-phone-swipe";

const here = dirname(fileURLToPath(import.meta.url));

function fakeWindow({ width = 400, reduced = false, vibrate = vi.fn() as ((ms: number) => boolean) | undefined } = {}) {
  const matchMedia = (query: string) => ({
    matches: query.includes("reduced-motion") ? reduced : width < 768,
  });
  return { win: { matchMedia, navigator: { vibrate } } as unknown as typeof window, vibrate };
}

function setWidth(width: number) {
  (window as unknown as { happyDOM: { setViewport(v: { width: number; height: number }): void } }).happyDOM.setViewport({ width, height: 800 });
}

describe("lockAxis", () => {
  it("waits for the slop", () => {
    expect(lockAxis(4, 3)).toBeNull();
  });

  it("locks horizontal only when x leads", () => {
    expect(lockAxis(-20, 5)).toBe("x");
    expect(lockAxis(5, 20)).toBe("y");
  });

  it("gives a diagonal tie to vertical scroll", () => {
    expect(lockAxis(12, 12)).toBe("y");
  });
});

describe("swipeStep", () => {
  it("snaps back below the distance threshold", () => {
    expect(swipeStep(-100, 0.1, 400)).toBe(0);
  });

  it("goes next on a long left drag, previous on a long right drag", () => {
    expect(swipeStep(-130, 0.1, 400)).toBe(1);
    expect(swipeStep(130, 0.1, 400)).toBe(-1);
  });

  it("commits a short fast flick", () => {
    expect(swipeStep(-40, -0.8, 400)).toBe(1);
  });

  it("ignores a flick too short to be intentional", () => {
    expect(swipeStep(-12, -0.8, 400)).toBe(0);
  });

  it("cancels when the release flicks back the other way", () => {
    expect(swipeStep(-200, 0.6, 400)).toBe(0);
  });
});

describe("neighborId", () => {
  const ids = ["a", "b", "c"];

  it("follows sidebar order", () => {
    expect(neighborId(ids, "b", 1)).toBe("c");
    expect(neighborId(ids, "b", -1)).toBe("a");
  });

  it("stops at both ends without wrapping", () => {
    expect(neighborId(ids, "c", 1)).toBeNull();
    expect(neighborId(ids, "a", -1)).toBeNull();
  });

  it("does nothing for a bot missing from the list", () => {
    expect(neighborId(ids, "zz", 1)).toBeNull();
  });
});

describe("dragOffset", () => {
  it("rubber-bands past an end", () => {
    expect(dragOffset(-90, true)).toBe(-90);
    expect(dragOffset(-90, false)).toBe(-30);
  });
});

describe("sidebarBotIds", () => {
  afterEach(() => {
    document.body.innerHTML = "";
  });

  it("reads bot rows in DOM order and skips rooms", () => {
    document.body.innerHTML = `
      <div data-sidebar-row-kind="bot" data-sidebar-row-id="a"></div>
      <div data-sidebar-row-kind="group" data-sidebar-row-id="room"></div>
      <div data-sidebar-row-kind="bot" data-sidebar-row-id="b"></div>`;
    expect(sidebarBotIds()).toEqual(["a", "b"]);
  });
});

describe("swipeBlocked", () => {
  beforeEach(() => {
    setWidth(400);
  });

  afterEach(() => {
    window.getSelection()?.removeAllRanges();
    document.body.innerHTML = "";
  });

  function mount(html: string): Element {
    document.body.innerHTML = html;
    return document.querySelector("#t")!;
  }

  it("allows plain transcript content", () => {
    expect(swipeBlocked(mount(`<div><p id="t">hi</p></div>`), 200)).toBe(false);
  });

  it("blocks near either screen edge", () => {
    const target = mount(`<p id="t">hi</p>`);
    expect(swipeBlocked(target, SWIPE_EDGE - 1)).toBe(true);
    expect(swipeBlocked(target, 400 - SWIPE_EDGE + 1)).toBe(true);
  });

  it("blocks code blocks, tables and the composer", () => {
    expect(swipeBlocked(mount(`<pre><code id="t">x</code></pre>`), 200)).toBe(true);
    expect(swipeBlocked(mount(`<table><tbody><tr><td id="t">x</td></tr></tbody></table>`), 200)).toBe(true);
    expect(swipeBlocked(mount(`<div data-orbit-composer-frame><button id="t">send</button></div>`), 200)).toBe(true);
    expect(swipeBlocked(mount(`<textarea id="t"></textarea>`), 200)).toBe(true);
  });

  it("blocks inside horizontally scrollable content", () => {
    const target = mount(`<div id="wide" style="overflow-x: auto"><span id="t">wide</span></div>`);
    const wide = document.querySelector("#wide")!;
    Object.defineProperty(wide, "scrollWidth", { configurable: true, value: 900 });
    Object.defineProperty(wide, "clientWidth", { configurable: true, value: 300 });
    expect(swipeBlocked(target, 200)).toBe(true);
  });

  it("blocks while text is selected", () => {
    const target = mount(`<p id="t">select me</p>`);
    const range = document.createRange();
    range.selectNodeContents(target);
    window.getSelection()!.addRange(range);
    expect(swipeBlocked(target, 200)).toBe(true);
  });
});

describe("hapticTick", () => {
  it("pulses about 10ms on a phone", () => {
    const { win, vibrate } = fakeWindow();
    hapticTick(win);
    expect(vibrate).toHaveBeenCalledWith(10);
  });

  it("stays still on desktop widths and with reduced motion", () => {
    const desktop = fakeWindow({ width: 1200 });
    hapticTick(desktop.win);
    const reduced = fakeWindow({ reduced: true });
    hapticTick(reduced.win);
    expect(desktop.vibrate).not.toHaveBeenCalled();
    expect(reduced.vibrate).not.toHaveBeenCalled();
  });

  it("is a no-op where vibrate is unsupported", () => {
    const { win } = fakeWindow({ vibrate: undefined });
    expect(() => hapticTick(win)).not.toThrow();
  });

  it("fires on send in the composer", () => {
    const composer = readFileSync(join(here, "../components/Composer.tsx"), "utf8");
    const send = composer.slice(composer.indexOf("  const send = () => {"), composer.indexOf("  const previewTerminalSend"));
    expect(send).toContain("hapticTick();");
  });
});

describe("usePhoneSwipe", () => {
  let host: HTMLDivElement;
  let root: ReturnType<typeof createRoot>;
  let select: ReturnType<typeof vi.fn<(id: string) => void>>;
  let vibrate: ReturnType<typeof vi.fn>;

  function Harness({ botId }: { botId: string }) {
    const stage = useRef<HTMLDivElement>(null);
    usePhoneSwipe(stage, botId, true, select);
    return createElement("div", { ref: stage, id: "stage" }, createElement("p", { id: "msg" }, "hello"));
  }

  function render(botId: string) {
    act(() => root.render(createElement(Harness, { botId })));
  }

  function touch(type: string, x: number, y: number, timeStamp: number) {
    const target = document.querySelector("#msg")!;
    const event = new Event(type, { bubbles: true, cancelable: true });
    const point = { clientX: x, clientY: y };
    Object.defineProperty(event, "touches", { value: type === "touchend" ? [] : [point] });
    Object.defineProperty(event, "timeStamp", { value: timeStamp });
    target.dispatchEvent(event);
  }

  function swipe(points: [number, number][]) {
    points.forEach(([x, y], index) => touch(index === 0 ? "touchstart" : "touchmove", x, y, index * 16));
    touch("touchend", 0, 0, points.length * 16);
  }

  beforeEach(() => {
    setWidth(400);
    select = vi.fn<(id: string) => void>();
    vibrate = vi.fn();
    Object.defineProperty(window.navigator, "vibrate", { configurable: true, value: vibrate });
    document.body.innerHTML = `
      <div data-sidebar-row-kind="bot" data-sidebar-row-id="a"></div>
      <div data-sidebar-row-kind="group" data-sidebar-row-id="room"></div>
      <div data-sidebar-row-kind="bot" data-sidebar-row-id="b"></div>
      <div data-sidebar-row-kind="bot" data-sidebar-row-id="c"></div>`;
    host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);
  });

  afterEach(() => {
    act(() => root.unmount());
    document.body.innerHTML = "";
    setWidth(1024);
  });

  it("switches to the next bot on a left swipe, skipping rooms", () => {
    render("a");
    swipe([[300, 200], [260, 202], [200, 204], [150, 205]]);
    expect(select).toHaveBeenCalledWith("b");
  });

  it("switches to the previous bot on a right swipe", () => {
    render("c");
    swipe([[100, 200], [140, 200], [200, 200], [260, 200]]);
    expect(select).toHaveBeenCalledWith("b");
  });

  it("lets a vertical start scroll", () => {
    render("a");
    swipe([[300, 200], [298, 240], [200, 260], [120, 270]]);
    expect(select).not.toHaveBeenCalled();
  });

  it("snaps back from a short slow drag", () => {
    render("a");
    swipe([[300, 200], [290, 200], [280, 200], [270, 200], [265, 200]]);
    expect(select).not.toHaveBeenCalled();
    expect((document.querySelector("#stage") as HTMLElement).style.transform).toBe("");
  });

  it("stops at the last bot", () => {
    render("c");
    swipe([[300, 200], [260, 200], [200, 200], [150, 200]]);
    expect(select).not.toHaveBeenCalled();
  });

  it("does nothing on desktop widths", () => {
    setWidth(1200);
    render("a");
    swipe([[300, 200], [260, 200], [200, 200], [150, 200]]);
    expect(select).not.toHaveBeenCalled();
  });

  it("vibrates when the bot changes", () => {
    render("a");
    render("b");
    expect(vibrate).toHaveBeenCalledWith(10);
  });
});
