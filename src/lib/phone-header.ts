export type PhoneHeaderSlot = {
  showEffort: boolean;
  showLabel: boolean;
  nameMin: number;
};

/** Give-up order on a phone: effort word, then the name down to `floor`, then the whole model label. */
export function phoneHeaderSlots(name: number, floor: number): PhoneHeaderSlot[] {
  const shrunk = Math.min(name, floor);
  const slots: PhoneHeaderSlot[] = [
    { showEffort: true, showLabel: true, nameMin: name },
    { showEffort: false, showLabel: true, nameMin: name },
  ];
  if (name > floor) slots.push({ showEffort: false, showLabel: true, nameMin: floor });
  slots.push({ showEffort: false, showLabel: false, nameMin: shrunk });
  return slots;
}

export type PhoneHeaderBox = {
  left: number;
  right: number;
  top: number;
  bottom: number;
};

/** Chip border box must clear the menu button by this many px. */
export const PHONE_HEADER_MENU_GAP = 4;

/** needs-you-glow ::after reach (14px blur + 3px spread) when computed style is empty. */
export const PHONE_MENU_GLOW_PX = 17;

/** How far a computed box-shadow paints past its border box. */
export function boxShadowReach(shadow: string): number {
  if (!shadow || shadow === "none") return 0;
  let reach = 0;
  const lengths = /(-?\d*\.?\d+)px\s+(-?\d*\.?\d+)px\s+(-?\d*\.?\d+)px(?:\s+(-?\d*\.?\d+)px)?/g;
  for (const match of shadow.matchAll(lengths)) {
    const ox = Math.abs(Number(match[1]));
    const oy = Math.abs(Number(match[2]));
    const blur = Math.abs(Number(match[3]));
    const spread = match[4] === undefined ? 0 : Number(match[4]);
    reach = Math.max(reach, ox + blur + spread, oy + blur + spread);
  }
  return reach;
}

function axisGap(start: number, end: number, otherStart: number, otherEnd: number): number {
  if (end <= otherStart) return otherStart - end;
  if (otherEnd <= start) return start - otherEnd;
  return Math.max(start, otherStart) - Math.min(end, otherEnd);
}

/** True when the chip's border box stays 4px off the menu box. Negative axis gap means overlap. */
export function phoneHeaderChipClearsMenu(
  chip: PhoneHeaderBox,
  menu: PhoneHeaderBox,
  gap = PHONE_HEADER_MENU_GAP,
): boolean {
  const horizontal = axisGap(chip.left, chip.right, menu.left, menu.right);
  const vertical = axisGap(chip.top, chip.bottom, menu.top, menu.bottom);
  return horizontal >= gap || vertical >= gap;
}
