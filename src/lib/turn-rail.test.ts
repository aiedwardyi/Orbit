import { describe, expect, it } from "vitest";

import { cardLayout, dayNumbers, fitWords, lensIn, lensOut, railFrame, railPick, railPositions, rowAt } from "./turn-rail";

const at = (day: number, hour: number, minute = 0) => new Date(2026, 9, day, hour, minute).getTime();
// one width unit per character, like a monospace face
const measure = (text: string) => text.length;

describe("rail positions", () => {
  it("numbers local days so the next day is one more", () => {
    expect(Array.from(dayNumbers([at(15, 23, 59), at(16, 0, 1), at(16, 22), at(18, 9)])).map((day, _, all) => day - all[0]!)).toEqual([0, 1, 1, 3]);
  });

  it("spaces one day's turns evenly from end to end", () => {
    const pos = railPositions(dayNumbers([at(16, 9), at(16, 10), at(16, 11), at(16, 12), at(16, 13)]), 400, 5);
    expect(Array.from(pos)).toEqual([0, 100, 200, 300, 400]);
  });

  it("opens a gap where a day ends and a wider one across empty days", () => {
    const pos = railPositions(dayNumbers([at(14, 9), at(14, 10), at(15, 9), at(15, 10), at(18, 9)]), 412, 4);
    const steps = Array.from(pos).slice(1).map((p, t) => p - pos[t]!);
    expect(steps[0]).toBeCloseTo(100);
    expect(steps[1]).toBeCloseTo(104);
    expect(steps[2]).toBeCloseTo(100);
    expect(steps[3]).toBeCloseTo(108);
    expect(pos.at(-1)).toBeCloseTo(412);
  });

  it("caps day gaps at 30% of the rail when days outnumber the room", () => {
    // two turns a day, every other day
    const times = Array.from({ length: 200 }, (_, t) => at(1, 9) + Math.floor(t / 2) * 2 * 86_400_000 + (t % 2) * 3_600_000);
    const pos = railPositions(dayNumbers(times), 300, 5);
    const steps = Array.from(pos).slice(1).map((p, t) => p - pos[t]!);
    const gaps = steps.reduce((sum, step) => sum + step - steps[0]!, 0);
    expect(pos.at(-1)).toBeCloseTo(300, 2);
    expect(gaps).toBeCloseTo(90, 1);
  });

  it("puts a lone turn at the top", () => {
    expect(Array.from(railPositions(dayNumbers([at(16, 9)]), 300, 5))).toEqual([0]);
    expect(railPositions([], 300, 5)).toHaveLength(0);
  });
});

describe("rail pick", () => {
  const pos = railPositions(dayNumbers(Array.from({ length: 101 }, (_, t) => at(16, 0) + t * 60_000)), 500, 5);

  it("means the first and the latest turn within 3 px of an end", () => {
    expect(railPick(0, 500, pos, 0, 120, 0)).toBe(0);
    expect(railPick(3, 500, pos, 250, 120, 4)).toBe(0);
    expect(railPick(497, 500, pos, 250, 120, 4)).toBe(100);
    expect(railPick(500, 500, pos, 480, 120, 4)).toBe(100);
  });

  it("picks the nearest turn, through the lens when it zooms", () => {
    expect(railPick(251, 500, pos, 0, 120, 0)).toBe(50);
    // zoomed 4x at 250, the point 40 px below the center draws a turn about 10 px below it
    expect(railPick(290, 500, pos, 250, 120, 4)).toBe(52);
  });

  it("undoes the lens spread exactly", () => {
    for (const p of [130, 200, 249, 250, 251, 300, 369]) expect(lensIn(lensOut(p, 250, 120, 4), 250, 120, 4)).toBeCloseTo(p, 9);
    expect(lensOut(100, 250, 120, 4)).toBe(100);
    expect(lensOut(260, 250, 120, 0)).toBe(260);
  });
});

describe("card layout", () => {
  it("heads each day once and stacks its turns under it", () => {
    const layout = cardLayout(dayNumbers([at(14, 9), at(14, 10), at(16, 9), at(16, 10), at(16, 11)]), 32, 26);
    expect(Array.from(layout.headY)).toEqual([0, 90]);
    expect(Array.from(layout.headTurn)).toEqual([0, 2]);
    expect(Array.from(layout.rowY)).toEqual([26, 58, 116, 148, 180]);
    expect(Array.from(layout.dayOf)).toEqual([0, 0, 1, 1, 1]);
    expect(layout.length).toBe(212);
  });

  it("finds the row under a point, header gaps included", () => {
    const { rowY } = cardLayout(dayNumbers([at(14, 9), at(14, 10), at(16, 9)]), 32, 26);
    expect(rowAt(rowY, 32, 0)).toBe(0);
    expect(rowAt(rowY, 32, 70)).toBe(1);
    expect(rowAt(rowY, 32, 95)).toBe(1);
    expect(rowAt(rowY, 32, 125)).toBe(2);
    expect(rowAt(rowY, 32, 9_999)).toBe(2);
    expect(rowAt(new Float64Array(0), 32, 10)).toBe(-1);
  });
});

describe("row words", () => {
  it("keeps words that fit", () => {
    expect(fitWords("Fix the build", 20, measure)).toBe("Fix the build");
  });

  it("cuts at a word with an ellipsis and no dangling punctuation", () => {
    expect(fitWords("Profile scrolling, then fix the frame", 20, measure)).toBe("Profile scrolling…");
    expect(fitWords("Profile scrolling in a long…", 22, measure)).toBe("Profile scrolling in…");
    expect(fitWords("폰에서 키보드가 열릴 때 컴포저가 튀는…", 12, measure)).toBe("폰에서 키보드가 열릴…");
  });

  it("cuts inside a word only when the first word alone overflows", () => {
    expect(fitWords("Supercalifragilistic expialidocious", 10, measure)).toBe("Supercali…");
  });
});

describe("rail frame", () => {
  it("sits at the right edge, clear of the scrollbar", () => {
    const frame = railFrame(1440, 900, 8, false);
    expect(frame).toMatchObject({ narrow: false, mirror: false, edge: 6, top: 16, h: 868, railX: 1426, hitWidth: 34 });
  });

  it("mirrors to the left edge, away from a drawer on the right", () => {
    expect(railFrame(1440, 900, 8, true)).toMatchObject({ mirror: true, railX: 6 });
    expect(railFrame(390, 700, 0, true)).toMatchObject({ narrow: true, edge: 4, top: 12, railX: 4, hitWidth: 30 });
    expect(railFrame(390, 700, 0, false)).toMatchObject({ railX: 386, hitWidth: 30 });
  });

  it("narrows the hit strip to the room beside the column", () => {
    expect(railFrame(1000, 800, 8, false).hitWidth).toBe(30);
    expect(railFrame(900, 800, 8, false).hitWidth).toBe(18);
  });
});
