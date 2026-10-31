// A phone's cold open downloads every chat's newest page; only the one on
// screen needs it. The rest page in when opened (ChatView's fill paging).
import type { Message } from "./store.ts";

export const OPEN_CHAT_HEADER = "x-open-chat";
const OFFSCREEN_TAIL = 30;

const isPrompt = (message: Message) => message.role === "user" && message.kind === "text" && !message.from;
const isAsk = (message: Message) => message.kind === "options" && Boolean(message.card?.askUser) && !message.card?.requestId;
const isOpenRequest = (message: Message) =>
  message.kind === "options" && Boolean(message.card?.requestId) && !message.card?.answered && !message.card?.dismissed;
const isPreview = (message: Message) =>
  !(message.role === "bot" && message.summarized) && message.kind !== "activity" && message.kind !== "screen";

/** Rows for a chat off screen: a short tail, reaching back to every row its sidebar row reads (glow, unread count, preview, worker status). */
export function offscreenLimit(messages: readonly Message[], limit: number, chat: { unread?: boolean; readAt?: number }): number {
  const floor = Math.max(0, messages.length - limit);
  let rows = Math.min(limit, OFFSCREEN_TAIL);
  let prompt = false, ask = false, user = false, preview = false, read = !chat.unread;
  for (let i = messages.length - 1; i >= floor; i--) {
    const message = messages[i]!;
    const keep = (!prompt && isPrompt(message)) || (!prompt && !ask && isAsk(message)) || (!preview && isPreview(message))
      || (!read && (chat.readAt === undefined ? !user : message.at > chat.readAt))
      || isOpenRequest(message) || message.kind === "launch" || message.kind === "note";
    if (keep) rows = Math.max(rows, messages.length - i);
    prompt ||= isPrompt(message);
    ask ||= isAsk(message);
    user ||= message.role === "user";
    preview ||= isPreview(message);
    read ||= chat.readAt === undefined ? user : message.at <= chat.readAt;
  }
  return read ? rows : limit;
}
