// Sidebar drag-to-reorder. The sidebar sorts pinned bots first and groups by
// section, so a drop only lands inside the dragged bot's own group; anything
// else would snap back on the next render. Sections also order by first
// appearance, so a drop only reshuffles its own group's slots.
import type { Bot } from "@/state/store";

type OrderedBot = Pick<Bot, "id"> & Partial<Pick<Bot, "section" | "pinned" | "chiefOfStaff" | "hidden">>;

const sameGroup = (a: OrderedBot, b: OrderedBot) =>
  !a.chiefOfStaff &&
  !b.chiefOfStaff &&
  !a.hidden &&
  !b.hidden &&
  (a.section ?? "") === (b.section ?? "") &&
  Boolean(a.pinned) === Boolean(b.pinned);

/** Every bot id after moving `fromId` into `toId`'s slot, or null for a drop the sidebar would undo. */
export function botOrderAfterDrop(bots: readonly OrderedBot[], fromId: string, toId: string): string[] | null {
  const from = bots.find((bot) => bot.id === fromId);
  const to = bots.find((bot) => bot.id === toId);
  if (!from || !to || from === to || !sameGroup(from, to)) return null;
  const slots = bots.flatMap((bot, index) => (sameGroup(bot, from) ? [index] : []));
  const group = slots.map((index) => bots[index]!.id);
  const target = group.indexOf(toId);
  group.splice(group.indexOf(fromId), 1);
  // Removing first shifts a lower target up one, so a drag down lands after it and a drag up before it.
  group.splice(target, 0, fromId);
  const ids = bots.map((bot) => bot.id);
  for (const [index, slot] of slots.entries()) ids[slot] = group[index]!;
  return ids;
}
