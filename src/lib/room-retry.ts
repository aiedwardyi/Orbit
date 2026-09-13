import type { Group, Message } from "@/state/store";
import { roomRespondersForComposer } from "./group-routing";

export interface RoomRetryPayload {
  messageId: string;
  text: string;
  replyToId?: string;
  threadId: string;
}

export function roomRetry<T extends { id: string; name: string; hidden?: boolean }>(
  messages: Message[],
  members: T[],
  group: Pick<Group, "defaultResponder" | "dm">,
  threadId: string,
  busyBotId?: string | null,
  options?: { allowSetup?: boolean },
): RoomRetryPayload | null {
  if (busyBotId) return null;
  const last = messages.at(-1);
  if (!last) return null;
  const isError =
    last.kind === "activity" &&
    (Boolean(last.tool?.usageLimit) || Boolean(last.tool?.name?.startsWith("error:")));
  if (!isError) return null;
  if (last.tool?.setup && !options?.allowSetup) return null;
  if (!last.from?.botId) return null;

  const lastUser = [...messages].reverse().find((m) => m.role === "user" && m.kind === "text" && Boolean(m.text?.trim()));
  if (!lastUser?.text) return null;

  let responders = roomRespondersForComposer(lastUser.text, members, group);
  if (!responders.length && group.dm) {
    const availableMembers = members.filter((member) => !member.hidden);
    const lastSpeakerId = [...messages]
      .reverse()
      .find((msg) => msg.kind === "text" && msg.from)?.from?.botId;
    const lastMember = availableMembers.find((b) => b.id === lastSpeakerId) ?? availableMembers[0];
    responders = lastMember ? [lastMember] : [];
  }
  if (responders.length !== 1 || responders[0].id !== last.from.botId) return null;

  return {
    messageId: last.id,
    text: lastUser.text,
    replyToId: lastUser.replyToId,
    threadId,
  };
}
