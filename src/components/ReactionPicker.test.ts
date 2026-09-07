// The picker hangs off a message inside the transcript scroller, so the chrome
// painted outside that scroller - the chat header above it, the usage strip
// below it - is what decides whether a button is clickable. An `absolute`
// picker is clipped by the scroller's overflow and cannot outrank chrome in an
// ancestor's stacking context, so any row that spills is dead. The check that
// matters is which element wins at each button's centre, not where the button
// says it is: `getBoundingClientRect()` reports the UNCLIPPED layout rect and
// looks healthy either way, which is how this shipped.
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
type Band = Box & { name: string };
type Placement = "above" | "below";
type Layout = { viewport: { width: number; height: number }; pane: Box; chrome: Band[] };

// Picker chrome, straight off the classes in Reactions.tsx.
const WIDTH = 218; // w-[218px]
const BORDER = 1;
const PAD = 8; // p-2
const CELL = 28; // size-7
const GAP = 2; // gap-0.5
const COLS = 6; // grid-cols-6
const OFFSET = 6; // PICKER_GAP
const ROWS = Math.ceil(EXTENDED_REACTIONS.length / COLS);
const HEIGHT = 2 * BORDER + 2 * PAD + ROWS * CELL + (ROWS - 1) * GAP;

const ANCHOR_H = 28;

/** 886x663 window: chat header above the pane, composer dock below it. */
const DESK: Layout = {
  viewport: { width: 886, height: 663 },
  pane: { top: 96, bottom: 520, left: 0, right: 886 },
  chrome: [
    { name: "chat header", top: 0, bottom: 96, left: 0, right: 886 },
    { name: "composer dock", top: 520, bottom: 663, left: 0, right: 886 },
  ],
};

// The packaged floor, measured on the shipped build: 601x480 outer, 587x443
// client, a 72px chat header and a 29px usage strip. That leaves the pane
// 250px - wide enough for the picker, but not for the picker AND a message
// sitting in the middle of it, which is where a normal wheel scroll parks one.
const FLOOR: Layout = {
  viewport: { width: 587, height: 443 },
  pane: { top: 72, bottom: 322, left: 0, right: 587 },
  chrome: [
    { name: "chat header", top: 0, bottom: 72, left: 0, right: 587 },
    { name: "usage strip", top: 322, bottom: 351, left: 0, right: 587 },
    { name: "composer", top: 351, bottom: 443, left: 0, right: 587 },
  ],
};

let layout: Layout = DESK;
let anchor: Box = { top: 0, bottom: 0, left: 0, right: 0 };

// The picker portals to document.body, so clearing the host is not enough: an
// un-unmounted root re-renders its portal and leaks an open picker into the
// next test.
const roots: Array<{ unmount: () => void }> = [];

async function cleanup() {
  await act(async () => {
    for (const root of roots.splice(0)) root.unmount();
  });
  document.body.replaceChildren();
  layout = DESK;
  observing.length = 0;
}

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

function setViewport({ width, height }: { width: number; height: number }) {
  for (const [key, value] of [["innerWidth", width], ["innerHeight", height]] as const) {
    Object.defineProperty(window, key, { configurable: true, writable: true, value });
  }
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
        ? layout.pane
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

/**
 * The picker's border box, read off however it actually positioned itself.
 * A `fixed` picker carries its own coordinates; an `absolute` one is placed by
 * `top-full` / `bottom-full` against the anchor and nudged by a transform.
 */
function boxOf(picker: HTMLElement): Box {
  if (picker.classList.contains("fixed")) {
    const top = Number.parseFloat(picker.style.top);
    const left = Number.parseFloat(picker.style.left);
    if (Number.isNaN(top) || Number.isNaN(left)) throw new Error("fixed picker has no coordinates");
    return { top, bottom: top + HEIGHT, left, right: left + WIDTH };
  }
  const top = placementOf(picker) === "above" ? anchor.top - OFFSET - HEIGHT : anchor.bottom + OFFSET;
  const shift = Number.parseFloat(/translateX\((-?[\d.]+)px\)/.exec(picker.style.transform)?.[1] ?? "0");
  const left = anchor.left + shift;
  return { top, bottom: top + HEIGHT, left, right: left + WIDTH };
}

function placementOf(picker: Element): Placement {
  if (!(picker instanceof HTMLElement)) throw new Error("picker is not an element");
  if (picker.classList.contains("fixed")) return boxOf(picker).top < anchor.top ? "above" : "below";
  const opensUp = picker.className.includes("bottom-full");
  const opensDown = picker.className.includes("top-full");
  if (opensUp === opensDown) throw new Error(`picker has no single vertical anchor: ${picker.className}`);
  return opensUp ? "above" : "below";
}

function buttonCentres(box: Box) {
  const colW = (WIDTH - 2 * BORDER - 2 * PAD - (COLS - 1) * GAP) / COLS;
  return EXTENDED_REACTIONS.map((emoji, i) => ({
    emoji,
    x: box.left + BORDER + PAD + (i % COLS) * (colW + GAP) + CELL / 2,
    y: box.top + BORDER + PAD + Math.floor(i / COLS) * (CELL + GAP) + CELL / 2,
  }));
}

function contains(box: Box, p: { x: number; y: number }) {
  return p.x >= box.left && p.x <= box.right && p.y >= box.top && p.y <= box.bottom;
}

/**
 * What wins the click at a point, the way `elementFromPoint` would. A picker
 * still inside the scroller is clipped by it and outranked by the chrome
 * around it; one portalled to the root at `fixed` answers only to the viewport.
 */
function coveredBy(point: { x: number; y: number }, escaped: boolean): string | null {
  const { width, height } = layout.viewport;
  if (point.x < 0 || point.x > width || point.y < 0 || point.y > height) return "off screen";
  if (escaped) return null;
  const band = layout.chrome.find((c) => contains(c, point));
  if (band) return band.name;
  return contains(layout.pane, point) ? null : "clipped by the transcript";
}

/** Buttons a user cannot click, named by whatever takes the click instead. */
function deadButtons(host: HTMLElement, picker: HTMLElement) {
  const escaped = !host.contains(picker);
  return buttonCentres(boxOf(picker))
    .map((c) => ({ ...c, by: coveredBy(c, escaped) }))
    .filter((c) => c.by !== null);
}

/**
 * A picker that never got measured, or that is still hidden, has no reachable
 * buttons at all - so every geometry check below would pass vacuously on one.
 */
function expectPlaced(picker: HTMLElement) {
  expect(picker.isConnected, "picker is not in the document").toBe(true);
  expect(picker.style.visibility, "picker is still hidden").toBe("visible");
  for (const side of ["top", "left"] as const) {
    expect(Number.parseFloat(picker.style[side]), `picker has no measured ${side}`).not.toBeNaN();
  }
  expect(picker.querySelectorAll("button")).toHaveLength(EXTENDED_REACTIONS.length);
}

function expectAllClickable(host: HTMLElement, picker: HTMLElement) {
  expectPlaced(picker);
  const dead = deadButtons(host, picker);
  expect(
    dead.map((c) => `${c.emoji} -> ${c.by}`).join(", "),
    `${dead.length} of ${EXTENDED_REACTIONS.length} buttons are not clickable`,
  ).toBe("");
}

const message: Message = { id: "m1", role: "bot", kind: "text", text: "hi", at: 0 };

function anchorAt(bottom: number) {
  anchor = { top: bottom - ANCHOR_H, bottom, left: 60, right: 60 + ANCHOR_H };
}

async function mount(anchorBottom: number, next: Layout = DESK) {
  layout = next;
  setViewport(next.viewport);
  anchorAt(anchorBottom);
  const host = document.createElement("div");
  host.setAttribute("data-orbit-transcript", "");
  document.body.append(host);
  const root = createRoot(host);
  roots.push(root);
  await act(async () => {
    root.render(createElement(ReactionBar, { threadId: "t1", message }));
  });
  await act(async () => {
    host.querySelector("button")?.click();
  });
  const picker = document.querySelector("[data-reaction-picker]");
  if (!(picker instanceof HTMLElement)) throw new Error("picker did not open");
  return { host, picker };
}

/** Open the picker on a message sitting `gapBelow` px off the pane's floor. */
function openPicker(gapBelow: number, next: Layout = DESK) {
  return mount(next.pane.bottom - gapBelow, next);
}

/** Two rails in one transcript - the picker is portalled, so they share a root. */
async function mountPair(anchorBottom: number, next: Layout = DESK) {
  layout = next;
  setViewport(next.viewport);
  anchorAt(anchorBottom);
  const host = document.createElement("div");
  host.setAttribute("data-orbit-transcript", "");
  document.body.append(host);
  const root = createRoot(host);
  roots.push(root);
  await act(async () => {
    root.render(
      createElement(
        "div",
        null,
        createElement(ReactionBar, { key: "a", threadId: "t1", message }),
        createElement(ReactionBar, { key: "b", threadId: "t1", message: { ...message, id: "m2" } }),
      ),
    );
  });
  const triggers = [...host.querySelectorAll("[data-reaction-bar] button")].filter(
    (b): b is HTMLButtonElement => b instanceof HTMLButtonElement,
  );
  if (triggers.length !== 2) throw new Error(`expected two rails, got ${triggers.length}`);
  return { host, triggers };
}

function openPickers() {
  return document.querySelectorAll("[data-reaction-picker]");
}

function mousedown(target: Element) {
  return act(async () => {
    target.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
  });
}

// The picker is portalled to the root, so an outside-click test that matches on
// a document-wide selector answers for EVERY rail on screen, not this one.
describe("reaction picker dismiss scoping", () => {
  afterEach(cleanup);

  it("closes when another message's trigger is pressed", async () => {
    const { triggers } = await mountPair(DESK.pane.bottom - 120);
    await act(async () => {
      triggers[0].click();
    });
    expect(openPickers()).toHaveLength(1);
    await mousedown(triggers[1]);
    expect(openPickers()).toHaveLength(0);
  });

  it("closes on a click that is neither its bar nor its picker", async () => {
    const { triggers } = await mountPair(DESK.pane.bottom - 120);
    await act(async () => {
      triggers[0].click();
    });
    await mousedown(document.body);
    expect(openPickers()).toHaveLength(0);
  });

  it("stays open when its own picker is pressed", async () => {
    const { triggers } = await mountPair(DESK.pane.bottom - 120);
    await act(async () => {
      triggers[0].click();
    });
    const button = document.querySelector("[data-reaction-picker] button");
    if (!button) throw new Error("picker did not open");
    await mousedown(button);
    expect(openPickers()).toHaveLength(1);
  });

  it("stays open when its own trigger is pressed", async () => {
    const { triggers } = await mountPair(DESK.pane.bottom - 120);
    await act(async () => {
      triggers[0].click();
    });
    await mousedown(triggers[0]);
    expect(openPickers()).toHaveLength(1);
  });
});

// Portalling under document.body took the picker out of the trigger's tab
// order, so focus has to be carried across by hand and handed back.
describe("reaction picker focus", () => {
  afterEach(cleanup);

  it("moves focus into the picker on open", async () => {
    const { triggers } = await mountPair(DESK.pane.bottom - 120);
    await act(async () => {
      triggers[0].click();
    });
    const picker = document.querySelector("[data-reaction-picker]");
    expect(picker?.contains(document.activeElement)).toBe(true);
  });

  it("hands focus back to the trigger on Escape", async () => {
    const { triggers } = await mountPair(DESK.pane.bottom - 120);
    await act(async () => {
      triggers[0].click();
    });
    await act(async () => {
      window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
    });
    expect(openPickers()).toHaveLength(0);
    expect(document.activeElement).toBe(triggers[0]);
  });

  it("hands focus back to the trigger after a reaction is chosen", async () => {
    const { triggers } = await mountPair(DESK.pane.bottom - 120);
    await act(async () => {
      triggers[0].click();
    });
    const button = document.querySelector("[data-reaction-picker] button");
    if (!(button instanceof HTMLButtonElement)) throw new Error("picker did not open");
    await act(async () => {
      button.click();
    });
    expect(openPickers()).toHaveLength(0);
    expect(document.activeElement).toBe(triggers[0]);
  });

  it("leaves focus where an outside click put it", async () => {
    const { triggers } = await mountPair(DESK.pane.bottom - 120);
    await act(async () => {
      triggers[0].click();
    });
    const elsewhere = document.createElement("button");
    document.body.append(elsewhere);
    await act(async () => {
      elsewhere.focus();
    });
    await mousedown(elsewhere);
    expect(openPickers()).toHaveLength(0);
    expect(document.activeElement).toBe(elsewhere);
  });
});

describe("reaction picker reachability", () => {
  afterEach(cleanup);

  // The last message rests near the scroller's bottom edge, which is the only
  // place the picker is ever opened from in a settled thread.
  for (const gapBelow of [8, 24, 40, 80, 120]) {
    it(`keeps every reaction clickable with ${gapBelow}px below the message`, async () => {
      const { host, picker } = await openPicker(gapBelow);
      expectAllClickable(host, picker);
    });
  }

  it("still opens downward when the message has room below it", async () => {
    const { host, picker } = await openPicker(300);
    expect(placementOf(picker)).toBe("below");
    expectAllClickable(host, picker);
  });

  it("opens upward off the last message rather than over the composer", async () => {
    const { picker } = await openPicker(8);
    expect(placementOf(picker)).toBe("above");
  });

  it("recomputes placement when the transcript scrolls under an open picker", async () => {
    const { host, picker } = await openPicker(8);
    expect(placementOf(picker)).toBe("above");
    // Scroll the message up to the top of the pane: the room above is gone.
    anchorAt(layout.pane.top + 8 + ANCHOR_H);
    await act(async () => {
      host.dispatchEvent(new Event("scroll"));
    });
    expect(placementOf(picker)).toBe("below");
    expectAllClickable(host, picker);
  });

  it("recomputes placement when a streaming bubble moves the anchor without a scroll", async () => {
    const { host, picker } = await openPicker(8);
    expect(placementOf(picker)).toBe("above");
    // The reply below keeps streaming: the rail rides up the pane while
    // scrollTop holds, so neither scroll nor resize fires.
    await act(async () => {
      growAnchor(layout.pane.top + 8 + ANCHOR_H);
    });
    expect(placementOf(picker)).toBe("below");
    expectAllClickable(host, picker);
  });

  it("closes when the message it points at scrolls out of the clip box", async () => {
    const { host } = await openPicker(8);
    // Far enough that the reaction bar itself is past the scroller's edge:
    // there is no anchor left on screen for the picker to hang off.
    anchorAt(layout.pane.bottom + 40 + ANCHOR_H);
    await act(async () => {
      host.dispatchEvent(new Event("scroll"));
    });
    expect(document.querySelector("[data-reaction-picker]")).toBeNull();
  });
});

// The band the shipped 601x480 build fails in. Neither side of the 250px pane
// holds the picker, so it has to leave the pane entirely - and once it does,
// it has to outrank the header and the usage strip rather than hide under them.
describe("reaction picker at the 600x480 floor", () => {
  afterEach(cleanup);

  for (let bottom = 204; bottom <= 218; bottom += 2) {
    it(`keeps every reaction clickable with the message at y=${bottom}`, async () => {
      const { host, picker } = await mount(bottom, FLOOR);
      expectAllClickable(host, picker);
    });
  }

  it("paints over the usage strip instead of under it", async () => {
    const { host, picker } = await mount(206, FLOOR);
    const box = boxOf(picker);
    expect(box.bottom).toBeGreaterThan(FLOOR.pane.bottom);
    expectAllClickable(host, picker);
  });

  it("leaves the pane rather than flipping the top row into the chat header", async () => {
    // The anchor the shipped build opens upward from, into `@container/chathead`.
    const { host, picker } = await mount(215, FLOOR);
    expect(boxOf(picker).top).toBeGreaterThanOrEqual(FLOOR.pane.top);
    expectAllClickable(host, picker);
  });

  it("still closes when the message scrolls out of the transcript", async () => {
    const { host } = await mount(206, FLOOR);
    anchorAt(FLOOR.pane.bottom + 40 + ANCHOR_H);
    await act(async () => {
      host.dispatchEvent(new Event("scroll"));
    });
    expect(document.querySelector("[data-reaction-picker]")).toBeNull();
  });

  it("takes the roomier side and stays on screen when the window itself is too short", async () => {
    // Neither the pane nor the viewport can hold the picker: nothing can save
    // every button, so take the side that shows most of it and stay in view.
    const short: Layout = {
      viewport: { width: 587, height: 200 },
      pane: { top: 40, bottom: 160, left: 0, right: 587 },
      chrome: [{ name: "chat header", top: 0, bottom: 40, left: 0, right: 587 }],
    };
    const { picker } = await mount(150, short);
    const box = boxOf(picker);
    expect(box.top).toBeGreaterThanOrEqual(0);
    expect(box.top).toBeLessThanOrEqual(short.viewport.height - HEIGHT);
  });
});
