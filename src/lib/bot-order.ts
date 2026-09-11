// Sidebar drag-to-reorder. The sidebar sorts pinned bots first and groups by
// section, so a drop only lands inside the dragged bot's own group; anything
// else would snap back on the next render.
import type { Bot } from "@/state/store";

type OrderedBot = Pick<Bot, "id"> & Partial<Pick<Bot, "section" | "pinned" | "chiefOfStaff">>;

/** Every bot id after moving `fromId` into `toId`'s slot, or null for a drop the sidebar would undo. */
export function botOrderAfterDrop(bots: readonly OrderedBot[], fromId: string, toId: string): string[] | null {
  const from = bots.findIndex((bot) => bot.id === fromId);
  const to = bots.findIndex((bot) => bot.id === toId);
  if (from < 0 || to < 0 || from === to) return null;
  const [a, b] = [bots[from]!, bots[to]!];
  if (a.chiefOfStaff || b.chiefOfStaff) return null;
  if ((a.section ?? "") !== (b.section ?? "") || Boolean(a.pinned) !== Boolean(b.pinned)) return null;
  const ids = bots.map((bot) => bot.id);
  ids.splice(from, 1);
  ids.splice(to, 0, fromId);
  return ids;
}
