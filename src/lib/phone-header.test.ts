import { describe, expect, it } from "vitest";

import { boxShadowReach, phoneHeaderChipClearsMenu, phoneHeaderSlots, transformShift, PHONE_HEADER_MENU_GAP, PHONE_HEADER_MENU_RESERVE_PX, PHONE_MENU_BUTTON_PX, PHONE_MENU_GLOW_PX } from "./phone-header";

describe("phoneHeaderSlots", () => {
  const slots = phoneHeaderSlots(101, 64);

  it("hides the effort word before the name shrinks", () => {
    expect(slots[0]).toEqual({ showEffort: true, showLabel: true, nameMin: 101 });
    expect(slots[1]).toEqual({ showEffort: false, showLabel: true, nameMin: 101 });
  });

  it("shrinks the name to the floor before dropping the model label", () => {
    expect(slots[2]).toEqual({ showEffort: false, showLabel: true, nameMin: 64 });
    expect(slots[3]).toEqual({ showEffort: false, showLabel: false, nameMin: 64 });
  });

  it("does not emit a duplicate slot when the name is already at the floor", () => {
    for (const name of [35, 64]) {
      const slots = phoneHeaderSlots(name, 64);
      expect(slots).toHaveLength(3);
      expect(slots.every((slot) => slot.nameMin === name)).toBe(true);
      expect(slots[1]).toEqual({ showEffort: false, showLabel: true, nameMin: name });
      expect(slots.at(-1)).toEqual({ showEffort: false, showLabel: false, nameMin: name });
    }
  });
});

describe("phone header menu clearance", () => {
  const chip = { left: 200, right: 340, top: 14, bottom: 44 };

  it("rejects a chip box that reaches the menu button", () => {
    expect(PHONE_HEADER_MENU_GAP).toBe(4);
    expect(phoneHeaderChipClearsMenu(chip, { left: 340, right: 370, top: 15, bottom: 45 })).toBe(false);
    expect(phoneHeaderChipClearsMenu(chip, { left: 343, right: 373, top: 15, bottom: 45 })).toBe(false);
    expect(phoneHeaderChipClearsMenu(chip, { left: 344, right: 374, top: 15, bottom: 45 })).toBe(true);
  });

  it("locks the menu reserve to the shipped 66px", () => {
    expect(PHONE_MENU_BUTTON_PX).toBe(44);
    expect(PHONE_HEADER_MENU_RESERVE_PX).toBe(66);
  });

  it("counts the menu glow in the gap", () => {
    expect(boxShadowReach("none")).toBe(0);
    expect(boxShadowReach("rgb(0, 0, 0) 0px 0px 0px 1.5px, rgb(0, 0, 0) 0px 0px 14px 3px")).toBe(17);
    expect(PHONE_MENU_GLOW_PX).toBe(17);
    const menu = { left: 350, right: 380, top: 15, bottom: 45 };
    expect(phoneHeaderChipClearsMenu(chip, menu)).toBe(true);
    const glow = PHONE_MENU_GLOW_PX;
    expect(phoneHeaderChipClearsMenu(chip, {
      left: menu.left - glow,
      right: menu.right + glow,
      top: menu.top - glow,
      bottom: menu.bottom + glow,
    })).toBe(false);
  });
});

describe("transformShift", () => {
  it("reads the translation from matrix and matrix3d values", () => {
    expect(transformShift("none")).toEqual({ x: 0, y: 0 });
    expect(transformShift("matrix(1, 0, 0, 1, 32, 0)")).toEqual({ x: 32, y: 0 });
    expect(transformShift("matrix(1, 0, 0, 1, -18.5, 4)")).toEqual({ x: -18.5, y: 4 });
    expect(transformShift("matrix3d(1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, -32, 2, 0, 1)")).toEqual({ x: -32, y: 2 });
  });
});
