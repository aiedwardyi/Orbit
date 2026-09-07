// The picker lives inside the transcript scroller, so the scroller's overflow
// clips it. No z-index escapes an ancestor's clip, so the check that matters is
// whether each button's centre still lands inside the scroller's client box —
// a point outside it is painted over by the composer chrome and `elementFromPoint`
// hands the click to that instead. `getBoundingClientRect()` on the picker
// reports the UNCLIPPED layout rect and looks healthy either way, which is how
// this shipped.
import "./ProfileFields.test-dom.ts";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";

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
const SCROLLER: Box = { top: 96, bottom: 520, left: 0, right: 886 };

let anchor: Box = { top: 0, bottom: 0, left: 0, right: 0 };

const proto = HTMLElement.prototype as unknown as Record<string, unknown>;
proto.getBoundingClientRect = function (this: HTMLElement) {
  const box = this.hasAttribute("data-orbit-transcript")
    ? SCROLLER
    : this.hasAttribute("data-reaction-bar")
      ? anchor
      : { top: 0, bottom: 0, left: 0, right: 0 };
  return { ...box, x: box.left, y: box.top, width: box.right - box.left, height: box.bottom - box.top };
};
for (const [key, value] of [["offsetWidth", WIDTH], ["offsetHeight", HEIGHT]] as const) {
  Object.defineProperty(proto, key, {
    configurable: true,
    get(this: HTMLElement) {
      return this.hasAttribute("data-reaction-picker") ? value : 0;
    },
  });
}

/** Where the picker's border box lands, read off the vertical anchor it rendered with. */
function pickerBox(picker: HTMLElement): Box {
  const opensUp = picker.className.includes("bottom-full");
  const opensDown = picker.className.includes("top-full");
  if (opensUp === opensDown) throw new Error(`picker has no single vertical anchor: ${picker.className}`);
  const top = opensUp ? anchor.top - OFFSET - HEIGHT : anchor.bottom + OFFSET;
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

/** Buttons whose centre falls outside the scroller's clip box — the dead ones. */
function clipped(box: Box) {
  return buttonCentres(box).filter(
    (c) => c.x < SCROLLER.left || c.x > SCROLLER.right || c.y < SCROLLER.top || c.y > SCROLLER.bottom,
  );
}

const message: Message = { id: "m1", role: "bot", kind: "text", text: "hi", at: 0 };

async function openPicker(gapBelow: number) {
  const bottom = SCROLLER.bottom - gapBelow;
  anchor = { top: bottom - ANCHOR_H, bottom, left: 60, right: 60 + ANCHOR_H };
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
  return pickerBox(picker as HTMLElement);
}

describe("reaction picker clip box", () => {
  afterEach(() => {
    document.body.replaceChildren();
  });

  // The last message rests near the scroller's bottom edge, which is the only
  // place the picker is ever opened from in a settled thread.
  for (const gapBelow of [8, 24, 40, 80, 120]) {
    it(`keeps every reaction clickable with ${gapBelow}px below the message`, async () => {
      const box = await openPicker(gapBelow);
      const dead = clipped(box);
      expect(
        dead.map((c) => c.emoji).join(" "),
        `${dead.length}/${EXTENDED_REACTIONS.length} buttons are outside the transcript clip box ` +
          `(picker ${box.top}–${box.bottom}, scroller ${SCROLLER.top}–${SCROLLER.bottom})`,
      ).toBe("");
    });
  }

  it("still opens downward when the message has room below it", async () => {
    const box = await openPicker(300);
    expect(box.top).toBeGreaterThanOrEqual(anchor.bottom);
    expect(clipped(box)).toEqual([]);
  });
});
