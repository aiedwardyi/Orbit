// The picker lives inside the transcript scroller, so the scroller's overflow
// clips it. No z-index escapes an ancestor's clip, so the check that matters is
// whether each button's centre still lands inside the scroller's client box -
// a point outside it is painted over by the composer chrome and `elementFromPoint`
// hands the click to that instead. `getBoundingClientRect()` on the picker
// reports the UNCLIPPED layout rect and looks healthy either way, which is how
// this shipped.
import "./ProfileFields.test-dom.ts";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import { EXTENDED_REACTIONS } from "../../shared/reactions";

vi.mock("@/state/store", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/state/store")>();
  return {
    ...actual,
    useStore: () => ({ state: {}, dispatch: () => undefined }),
  };
});

import { ReactionBar } from "./Reactions";
import type { Message } from "@/state/store";

type Box = { top: number; bottom: number; left: number; right: number };
type Placement = "above" | "below";

// Picker chrome, straight off the classes in Reactions.tsx.
const WIDTH = 218; // w-[218px]
const BORDER = 1;
const PAD = 8; // p-2
const CELL = 28; // size-7
const GAP = 2; // gap-0.5
const COLS = 6; // grid-cols-6
const OFFSET = 6; // mt-1.5 / mb-1.5
const ROWS = Math.ceil(EXTENDED_REACTIONS.length / COLS);
const HEIGHT = 2 * BORDER + 2 * PAD + ROWS * CELL + (ROWS - 1) * GAP;

const ANCHOR_H = 28;
// 886x663 window: chat header above, composer dock below.
const PANE: Box = { top: 96, bottom: 520, left: 0, right: 886 };

let scroller: Box = PANE;
let anchor: Box = { top: 0, bottom: 0, left: 0, right: 0 };

// Installed on the prototype rather than per element: the picker only exists
// after it opens, which is after the layout effect that measures it has run.
// Restored afterwards so a later file in this worker gets its own geometry.
const OVERRIDES = ["getBoundingClientRect", "offsetWidth", "offsetHeight"] as const;
const saved = new Map<string, PropertyDescriptor | undefined>();

// happy-dom has no layout, so its ResizeObserver never fires. This one is
// driven by hand: `growAnchor` is the streaming bubble resizing the rail.
const observing: Array<() => void> = [];
let savedResizeObserver: unknown;

class TestResizeObserver {
  constructor(private readonly cb: () => void) {
    observing.push(cb);
  }
  observe() {}
  unobserve() {}
  disconnect() {
    const at = observing.indexOf(this.cb);
    if (at >= 0) observing.splice(at, 1);
  }
}

/** Move the anchor the way a growing bubble does - no scroll, no resize. */
function growAnchor(bottom: number) {
  anchorAt(bottom);
  for (const cb of [...observing]) cb();
}

beforeAll(() => {
  const proto = HTMLElement.prototype;
  savedResizeObserver = (globalThis as Record<string, unknown>).ResizeObserver;
  (globalThis as Record<string, unknown>).ResizeObserver = TestResizeObserver;
  for (const key of OVERRIDES) saved.set(key, Object.getOwnPropertyDescriptor(proto, key));
  Object.defineProperty(proto, "getBoundingClientRect", {
    configurable: true,
    writable: true,
    value: function (this: HTMLElement) {
      const box = this.hasAttribute("data-orbit-transcript")
        ? scroller
        : this.hasAttribute("data-reaction-bar")
          ? anchor
          : { top: 0, bottom: 0, left: 0, right: 0 };
      return { ...box, x: box.left, y: box.top, width: box.right - box.left, height: box.bottom - box.top };
    },
  });
  for (const [key, value] of [["offsetWidth", WIDTH], ["offsetHeight", HEIGHT]] as const) {
    Object.defineProperty(proto, key, {
      configurable: true,
      get(this: HTMLElement) {
        return this.hasAttribute("data-reaction-picker") ? value : 0;
      },
    });
  }
});

afterAll(() => {
  const proto = HTMLElement.prototype as unknown as Record<string, unknown>;
  for (const key of OVERRIDES) {
    const descriptor = saved.get(key);
    if (descriptor) Object.defineProperty(proto, key, descriptor);
    else delete proto[key];
  }
  (globalThis as Record<string, unknown>).ResizeObserver = savedResizeObserver;
});

function placementOf(picker: Element): Placement {
  const opensUp = picker.className.includes("bottom-full");
  const opensDown = picker.className.includes("top-full");
  if (opensUp === opensDown) throw new Error(`picker has no single vertical anchor: ${picker.className}`);
  return opensUp ? "above" : "below";
}

/** Where the picker's border box lands for a given vertical anchor. */
function boxFor(placement: Placement): Box {
  const top = placement === "above" ? anchor.top - OFFSET - HEIGHT : anchor.bottom + OFFSET;
  return { top, bottom: top + HEIGHT, left: anchor.left, right: anchor.left + WIDTH };
}

function buttonCentres(box: Box) {
  const colW = (WIDTH - 2 * BORDER - 2 * PAD - (COLS - 1) * GAP) / COLS;
  return EXTENDED_REACTIONS.map((emoji, i) => ({
    emoji,
    x: box.left + BORDER + PAD + (i % COLS) * (colW + GAP) + CELL / 2,
    y: box.top + BORDER + PAD + Math.floor(i / COLS) * (CELL + GAP) + CELL / 2,
  }));
}

/** Buttons whose centre falls outside the scroller's clip box - the dead ones. */
function clipped(placement: Placement) {
  return buttonCentres(boxFor(placement)).filter(
    (c) => c.x < scroller.left || c.x > scroller.right || c.y < scroller.top || c.y > scroller.bottom,
  );
}

const message: Message = { id: "m1", role: "bot", kind: "text", text: "hi", at: 0 };

function anchorAt(bottom: number) {
  anchor = { top: bottom - ANCHOR_H, bottom, left: 60, right: 60 + ANCHOR_H };
}

async function openPicker(gapBelow: number, pane: Box = PANE) {
  scroller = pane;
  anchorAt(pane.bottom - gapBelow);
  const host = document.createElement("div");
  host.setAttribute("data-orbit-transcript", "");
  document.body.append(host);
  const root = createRoot(host);
  await act(async () => {
    root.render(createElement(ReactionBar, { threadId: "t1", message }));
  });
  await act(async () => {
    host.querySelector("button")?.click();
  });
  const picker = host.querySelector("[data-reaction-picker]");
  if (!picker) throw new Error("picker did not open");
  return { host, picker };
}

describe("reaction picker clip box", () => {
  afterEach(() => {
    document.body.replaceChildren();
    scroller = PANE;
    observing.length = 0;
  });

  // The last message rests near the scroller's bottom edge, which is the only
  // place the picker is ever opened from in a settled thread.
  for (const gapBelow of [8, 24, 40, 80, 120]) {
    it(`keeps every reaction clickable with ${gapBelow}px below the message`, async () => {
      const { picker } = await openPicker(gapBelow);
      const dead = clipped(placementOf(picker));
      expect(
        dead.map((c) => c.emoji).join(" "),
        `${dead.length}/${EXTENDED_REACTIONS.length} buttons are outside the transcript clip box`,
      ).toBe("");
    });
  }

  it("still opens downward when the message has room below it", async () => {
    const { picker } = await openPicker(300);
    expect(placementOf(picker)).toBe("below");
    expect(clipped("below")).toEqual([]);
  });

  it("recomputes placement when the transcript scrolls under an open picker", async () => {
    const { host, picker } = await openPicker(8);
    expect(placementOf(picker)).toBe("above");
    // Scroll the message up to the top of the pane: the room above is gone.
    anchorAt(scroller.top + 8 + ANCHOR_H);
    await act(async () => {
      host.dispatchEvent(new Event("scroll"));
    });
    expect(placementOf(picker)).toBe("below");
    expect(clipped(placementOf(picker))).toEqual([]);
  });

  it("recomputes placement when a streaming bubble moves the anchor without a scroll", async () => {
    const { picker } = await openPicker(8);
    expect(placementOf(picker)).toBe("above");
    // The reply below keeps streaming: the rail rides up the pane while
    // scrollTop holds, so neither scroll nor resize fires.
    await act(async () => {
      growAnchor(scroller.top + 8 + ANCHOR_H);
    });
    expect(placementOf(picker)).toBe("below");
    expect(clipped(placementOf(picker))).toEqual([]);
  });

  it("closes when the message it points at scrolls out of the clip box", async () => {
    const { host } = await openPicker(8);
    // Far enough that the reaction bar itself is past the scroller's edge:
    // there is no anchor left on screen for the picker to hang off.
    anchorAt(scroller.bottom + 40 + ANCHOR_H);
    await act(async () => {
      host.dispatchEvent(new Event("scroll"));
    });
    expect(host.querySelector("[data-reaction-picker]")).toBeNull();
  });

  it("takes the roomier side when the transcript is shorter than the picker", async () => {
    // A small window with an expanded composer leaves a pane neither side fits in.
    const short: Box = { top: 96, bottom: 96 + 170, left: 0, right: 886 };
    const { picker } = await openPicker(8, short);
    expect(placementOf(picker)).toBe("above");
    expect(clipped("above").length).toBeLessThan(clipped("below").length);
  });
});
