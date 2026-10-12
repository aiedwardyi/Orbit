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
