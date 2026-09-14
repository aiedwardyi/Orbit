// Sidebar drag-to-reorder. The sidebar sorts pinned bots first and groups by
// section, so a drop only lands inside the dragged bot's own group; anything
// else would snap back on the next render. Sections also order by first
// appearance, so a drop only reshuffles its own group's slots.
//
// Group chats (rooms) render in their own per-section lists with no pinned or
// hidden split, so they reorder within their own section the same way.
import type { Bot, Group } from "@/state/store";

type OrderedBot = Pick<Bot, "id"> & Partial<Pick<Bot, "section" | "pinned" | "chiefOfStaff" | "hidden">>;

type OrderedGroup = Pick<Group, "id"> & Partial<Pick<Group, "section">>;

const sameGroup = (a: OrderedBot, b: OrderedBot) =>
  !a.chiefOfStaff &&
  !b.chiefOfStaff &&
  !a.hidden &&
  !b.hidden &&
  (a.section ?? "") === (b.section ?? "") &&
  Boolean(a.pinned) === Boolean(b.pinned);

const sameRoomSection = (a: OrderedGroup, b: OrderedGroup) => (a.section ?? "") === (b.section ?? "");

/** Every group id after moving `fromId` into `toId`'s slot, or null for a drop the sidebar would undo. */
export function groupOrderAfterDrop(
  groups: readonly OrderedGroup[],
  fromId: string,
  toId: string,
): string[] | null {
  const from = groups.find((group) => group.id === fromId);
  const to = groups.find((group) => group.id === toId);
  if (!from || !to || from === to || !sameRoomSection(from, to)) return null;
  const slots = groups.flatMap((group, index) => (sameRoomSection(group, from) ? [index] : []));
  const section = slots.map((index) => groups[index]!.id);
  const target = section.indexOf(toId);
  section.splice(section.indexOf(fromId), 1);
  // Removing first shifts a lower target up one, so a drag down lands after it and a drag up before it.
  section.splice(target, 0, fromId);
  const ids = groups.map((group) => group.id);
  for (const [index, slot] of slots.entries()) ids[slot] = section[index]!;
  return ids;
}

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
