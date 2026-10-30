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

type CountedMessage = { role?: string; kind?: string; summarized?: boolean; at?: number };

const isReply = (message: CountedMessage) => message.role === "bot" && message.kind === "text" && isShownMessage(message);

/** Shown replies since the chat was last read (since your last message for records without readAt); unread with none still shows 1. */
export function unreadReplyCount(
  unread: boolean | undefined,
  readAt: number | undefined,
  messages: ReadonlyArray<CountedMessage>,
): number {
  if (!unread) return 0;
  let count = 0;
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i];
    if (readAt === undefined ? message.role === "user" : (message.at ?? Infinity) <= readAt) break;
    if (isReply(message)) count += 1;
  }
  return Math.max(1, count);
}

/** Just before the last reply, so Mark as Unread counts 1. */
export function markUnreadReadAt(messages: ReadonlyArray<CountedMessage>): number | undefined {
  for (let i = messages.length - 1; i >= 0; i--) {
    const at = messages[i].at;
    if (isReply(messages[i]) && at !== undefined) return at - 1;
  }
  return undefined;
}

export function formatCollapsedUnreadBadge(count: number): string | null {
  if (count <= 0) return null;
  return count > 9 ? "9+" : String(count);
}
