export type PhoneHeaderSlot = {
  showEffort: boolean;
  showLabel: boolean;
  nameMin: number;
};

/** Give-up order on a phone: effort word, then the name down to `floor`, then the whole model label. */
export function phoneHeaderSlots(name: number, floor: number): PhoneHeaderSlot[] {
  const nameMin = Math.min(name, floor);
  return [
    { showEffort: true, showLabel: true, nameMin: name },
    { showEffort: false, showLabel: true, nameMin: name },
    { showEffort: false, showLabel: true, nameMin },
    { showEffort: false, showLabel: false, nameMin },
  ];
}
