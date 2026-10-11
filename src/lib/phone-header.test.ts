import { describe, expect, it } from "vitest";

import { phoneHeaderSlots } from "./phone-header";

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
