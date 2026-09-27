export function unreadConversationCount(
  bots: Array<{ hidden?: boolean; unread?: boolean }>,
  groups: Array<{ unread?: boolean }>,
): number {
  return bots.filter((bot) => !bot.hidden && bot.unread).length + groups.filter((group) => group.unread).length;
}

/** Unread count for the collapsed sidebar's reopen button: the open conversation never counts. */
export function collapsedUnreadCount(
  bots: Array<{ id: string; hidden?: boolean; unread?: boolean }>,
  groups: Array<{ id: string; unread?: boolean }>,
  currentId: string,
): number {
  return unreadConversationCount(
    bots.filter((bot) => bot.id !== currentId),
    groups.filter((group) => group.id !== currentId),
  );
}

export function formatCollapsedUnreadBadge(count: number): string | null {
  if (count <= 0) return null;
  return count > 9 ? "9+" : String(count);
}
