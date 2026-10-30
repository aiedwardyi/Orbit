import { isShownMessage } from "./shown-message";
import { listedGroups } from "./sidebar-order";

export function unreadConversationCount(
  bots: Array<{ hidden?: boolean; unread?: boolean }>,
  groups: Array<{ dm?: boolean; unread?: boolean }>,
): number {
  return bots.filter((bot) => !bot.hidden && bot.unread).length + listedGroups(groups).filter((group) => group.unread).length;
}

/** Unread count for the collapsed sidebar's reopen button: the open conversation never counts. */
export function collapsedUnreadCount(
  bots: Array<{ id: string; hidden?: boolean; unread?: boolean }>,
  groups: Array<{ id: string; dm?: boolean; unread?: boolean }>,
  currentId: string,
): number {
  return unreadConversationCount(
    bots.filter((bot) => bot.id !== currentId),
    groups.filter((group) => group.id !== currentId),
  );
}

/** Shown replies after your last message; an unread chat with none still shows 1. */
export function unreadReplyCount(
  unread: boolean | undefined,
  messages: ReadonlyArray<{ role?: string; kind?: string; summarized?: boolean }>,
): number {
  if (!unread) return 0;
  let count = 0;
  for (let i = messages.length - 1; i >= 0 && messages[i].role !== "user"; i--) {
    if (messages[i].role === "bot" && messages[i].kind === "text" && isShownMessage(messages[i])) count += 1;
  }
  return Math.max(1, count);
}

export function formatCollapsedUnreadBadge(count: number): string | null {
  if (count <= 0) return null;
  return count > 9 ? "9+" : String(count);
}
