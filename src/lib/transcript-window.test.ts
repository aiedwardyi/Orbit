import { describe, expect, it } from "vitest";

import {
  TRANSCRIPT_WINDOW_SIZE,
  advanceWindow,
  expandWindowStart,
  focusWindow,
  followedTailStart,
  followedWindow,
  resolveTranscriptWindow,
  tailWindowStart,
  shouldAdvanceWindow,
} from "./transcript-window";

const thread = (total: number): number[] => Array.from({ length: total }, (_, i) => i);

describe("advanceWindow", () => {
  it("adds one page and keeps the previous lower rows", () => {
    expect(advanceWindow(0, 120, 500)).toEqual({ start: 0, end: 240 });
    expect(advanceWindow(0, 240, 500)).toEqual({ start: 120, end: 360 });
  });

  it("keeps at most two windows throughout forward paging", () => {
    let window: { start: number; end: number | null } = { start: 0, end: 120 };
    while (window.end !== null) {
      window = advanceWindow(window.start, window.end, 500);
      expect((window.end ?? 500) - window.start).toBeLessThanOrEqual(240);
    }
    expect(window).toEqual({ start: 260, end: null });
  });

  it("counts the page and cap in rendering rows", () => {
    const renders = (i: number) => i % 10 === 0;
    const window = advanceWindow(0, 1191, 5000, 120, renders);
    expect(window).toEqual({ start: 0, end: 2391 });
    const next = advanceWindow(window.start, window.end!, 5000, 120, renders);
    expect(thread(next.end! - next.start).filter((i) => renders(i + next.start))).toHaveLength(240);
  });

  it("keeps hidden trailing rows when it becomes a live tail", () => {
    expect(advanceWindow(0, 240, 500, 120, (i) => i < 300)).toEqual({ start: 60, end: null });
  });
});

describe("shouldAdvanceWindow", () => {
  it("starts before the lower edge enters the viewport", () => {
    expect(shouldAdvanceWindow(true, 300, 400)).toBe(true);
    expect(shouldAdvanceWindow(true, 401, 400)).toBe(false);
  });

  it("ignores upward movement and transcripts without layout", () => {
    expect(shouldAdvanceWindow(false, 0, 400)).toBe(false);
    expect(shouldAdvanceWindow(true, 0, 0)).toBe(false);
  });
});

describe("tailWindowStart", () => {
  it("shows everything when the thread is shorter than the window", () => {
    expect(tailWindowStart(10)).toBe(0);
  });

  it("shows everything when the thread is exactly one window", () => {
    expect(tailWindowStart(TRANSCRIPT_WINDOW_SIZE)).toBe(0);
  });

  it("starts one window back from the tail of a long thread", () => {
    expect(tailWindowStart(300)).toBe(180);
  });

  it("is zero for an empty thread", () => {
    expect(tailWindowStart(0)).toBe(0);
  });

  it("counts only rows that render", () => {
    expect(tailWindowStart(300, 4, (i) => i % 3 === 0)).toBe(288);
  });

  it("reaches back past a tail of hidden rows to the last text", () => {
    expect(tailWindowStart(370, TRANSCRIPT_WINDOW_SIZE, (i) => i < 50)).toBe(0);
  });
});

describe("expandWindowStart", () => {
  it("pulls the boundary back by one window per click", () => {
    expect(expandWindowStart(300)).toBe(180);
  });

  it("clamps an expansion past the start of the thread to zero", () => {
    expect(expandWindowStart(60)).toBe(0);
  });

  it("stays at zero once fully expanded", () => {
    expect(expandWindowStart(0)).toBe(0);
  });
});

describe("resolveTranscriptWindow", () => {
  it("keeps a short thread fully visible with nothing hidden", () => {
    const result = resolveTranscriptWindow(thread(10), tailWindowStart(10));
    expect(result.visible).toHaveLength(10);
    expect(result.hiddenCount).toBe(0);
    expect(result.startIndex).toBe(0);
    expect(result.laterCount).toBe(0);
  });

  it("windows a long thread to its tail", () => {
    const result = resolveTranscriptWindow(thread(300), tailWindowStart(300));
    expect(result.visible).toHaveLength(TRANSCRIPT_WINDOW_SIZE);
    expect(result.visible[0]).toBe(180);
    expect(result.visible.at(-1)).toBe(299);
    expect(result.hiddenCount).toBe(180);
  });

  it("grows the window when messages append past an anchored boundary", () => {
    const start = tailWindowStart(300);
    const result = resolveTranscriptWindow(thread(310), start);
    // the boundary must not slide forward: rows on screen stay on screen
    expect(result.startIndex).toBe(start);
    expect(result.visible).toHaveLength(130);
    expect(result.visible.at(-1)).toBe(309);
  });

  it("expands by one window per step until the start of the thread", () => {
    const messages = thread(300);
    const once = resolveTranscriptWindow(messages, expandWindowStart(180));
    expect(once.visible).toHaveLength(240);
    expect(once.hiddenCount).toBe(60);
    const twice = resolveTranscriptWindow(messages, expandWindowStart(once.startIndex));
    expect(twice.visible).toHaveLength(300);
    expect(twice.hiddenCount).toBe(0);
  });

  it("falls back to a tail window when the thread shrinks under the boundary", () => {
    // branch switch / edit rewound the thread below the stored boundary
    const result = resolveTranscriptWindow(thread(150), 180);
    expect(result.startIndex).toBe(30);
    expect(result.visible).toHaveLength(TRANSCRIPT_WINDOW_SIZE);
    expect(result.hiddenCount).toBe(30);
  });

  it("resets a boundary sitting exactly at the end of the thread", () => {
    const result = resolveTranscriptWindow(thread(100), 100);
    expect(result.startIndex).toBe(0);
    expect(result.visible).toHaveLength(100);
  });

  it("resolves an empty thread to an empty window", () => {
    const result = resolveTranscriptWindow([], 0);
    expect(result.visible).toHaveLength(0);
    expect(result.hiddenCount).toBe(0);
  });

  it("respects a custom window size", () => {
    const result = resolveTranscriptWindow(thread(10), tailWindowStart(10, 4), 4);
    expect(result.visible).toHaveLength(4);
    expect(result.hiddenCount).toBe(6);
  });

  it("keeps a finite search-focus window instead of mounting through the tail", () => {
    const result = resolveTranscriptWindow(thread(1_000), 440, TRANSCRIPT_WINDOW_SIZE, 560);
    expect(result.visible).toHaveLength(TRANSCRIPT_WINDOW_SIZE);
    expect(result.visible[0]).toBe(440);
    expect(result.visible.at(-1)).toBe(559);
    expect(result.hiddenCount).toBe(440);
    expect(result.laterCount).toBe(440);
    expect(result.endIndex).toBe(560);
  });

  it("falls back to the tail if a finite window becomes invalid after a rewind", () => {
    const result = resolveTranscriptWindow(thread(100), 440, TRANSCRIPT_WINDOW_SIZE, 560);
    expect(result.visible[0]).toBe(0);
    expect(result.visible.at(-1)).toBe(99);
    expect(result.laterCount).toBe(0);
  });
});

describe("focusWindow", () => {
  it.each([
    { start: 280, end: null },
    { start: 440, end: 560 },
  ])("keeps a window that already holds the target", (window) => {
    expect(focusWindow(window, 1_000, 500)).toBe(window);
  });

  it("grows the start to a target above the window and keeps the tail", () => {
    expect(focusWindow({ start: 280, end: null }, 400, 250)).toEqual({ start: 240, end: null });
  });

  it("counts the context above a grown target in rendering rows", () => {
    expect(focusWindow({ start: 300, end: null }, 400, 200, TRANSCRIPT_WINDOW_SIZE, (i) => i % 4 === 0)).toEqual({ start: 160, end: null });
  });

  it("grows up to two windows of rendering rows", () => {
    expect(focusWindow({ start: 880, end: null }, 1_000, 770)).toEqual({ start: 760, end: null });
  });

  it("opens a bounded window once growing would pass two windows", () => {
    expect(focusWindow({ start: 880, end: null }, 1_000, 769)).toEqual({ start: 709, end: 829 });
  });

  it("sizes a bounded window by rendering rows", () => {
    const renders = (i: number) => i % 10 === 0;
    const range = focusWindow({ start: 4_800, end: null }, 5_000, 1_000, TRANSCRIPT_WINDOW_SIZE, renders);
    expect(range).toEqual({ start: 400, end: 1_591 });
    expect(Array.from({ length: range.end! - range.start }, (_, i) => range.start + i).filter(renders)).toHaveLength(TRANSCRIPT_WINDOW_SIZE);
  });

  it("opens a bounded window for a target below a finite window", () => {
    expect(focusWindow({ start: 100, end: 220 }, 1_000, 500)).toEqual({ start: 440, end: 560 });
  });

  it("opens a bounded window on a fresh jump page", () => {
    expect(focusWindow(null, 200, 100)).toEqual({ start: 40, end: 160 });
  });

  it("turns a bounded window that reaches the newest row into a full tail", () => {
    expect(focusWindow({ start: 0, end: 100 }, 300, 250)).toEqual({ start: 180, end: null });
  });
});

describe("followedTailStart", () => {
  it("keeps the boundary while the followed tail is within two windows", () => {
    expect(followedTailStart(180, 180 + TRANSCRIPT_WINDOW_SIZE * 2)).toBe(180);
  });

  it("slides to a fresh tail once appends outgrow two windows", () => {
    const total = 180 + TRANSCRIPT_WINDOW_SIZE * 2 + 1;
    expect(followedTailStart(180, total)).toBe(tailWindowStart(total));
  });

  it("slides to the counted tail when given a render filter", () => {
    const total = 180 + TRANSCRIPT_WINDOW_SIZE * 2 + 1;
    expect(followedTailStart(180, total, TRANSCRIPT_WINDOW_SIZE, (i) => i % 2 === 0)).toBe(182);
  });

  it("leaves a stale boundary past the end for resolve to handle", () => {
    expect(followedTailStart(500, 100)).toBe(500);
  });
});

describe("followedWindow", () => {
  it("lets go of opened scrollback and slides to a fresh tail", () => {
    expect(followedWindow({ start: 0, end: null, expanded: true }, 400)).toEqual({ start: tailWindowStart(400), end: null, expanded: false });
  });

  it("keeps rows within two windows when it lets go of scrollback", () => {
    expect(followedWindow({ start: 100, end: null, expanded: true }, 300)).toEqual({ start: 100, end: null, expanded: false });
  });

  it("caps a followed tail at two windows after scrollback", () => {
    let window = { start: 0, end: null, expanded: true };
    for (let total = 400; total < 1000; total++) {
      window = followedWindow(window, total);
      expect(total - window.start).toBeLessThanOrEqual(TRANSCRIPT_WINDOW_SIZE * 2);
    }
  });

  it("returns the same window when nothing moves", () => {
    const window = { start: 100, end: null };
    expect(followedWindow(window, 300)).toBe(window);
  });

  it("keeps a finite window", () => {
    const window = { start: 0, end: 200, expanded: true };
    expect(followedWindow(window, 400)).toBe(window);
  });
});
