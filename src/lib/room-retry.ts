import type { Message } from "@/state/store";

export interface RoomRetryPayload {
  messageId: string;
  text: string;
  replyToId?: string;
  threadId?: string;
}

export function roomRetry(
  messages: Message[],
  busyBotId?: string | null,
  threadId?: string,
): RoomRetryPayload | null {
  if (busyBotId) return null;
  const last = messages.at(-1);
  if (!last) return null;
  const isError =
    last.kind === "activity" &&
    (Boolean(last.tool?.usageLimit) || Boolean(last.tool?.name?.startsWith("error:")));
  if (!isError || last.tool?.setup) return null;

  const lastUser = [...messages].reverse().find((m) => m.role === "user" && m.kind === "text" && Boolean(m.text?.trim()));
  if (!lastUser?.text) return null;

  return {
    messageId: last.id,
    text: lastUser.text,
    replyToId: lastUser.replyToId,
    threadId: threadId ?? (lastUser as { threadId?: string }).threadId,
  };
}
