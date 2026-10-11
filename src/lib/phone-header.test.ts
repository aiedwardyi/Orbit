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

  it("does not shrink a name that is already under the floor", () => {
    expect(phoneHeaderSlots(35, 64).every((slot) => slot.nameMin === 35)).toBe(true);
    expect(phoneHeaderSlots(35, 64)[1]?.showLabel).toBe(true);
    expect(phoneHeaderSlots(35, 64)[3]?.showLabel).toBe(false);
  });
});
