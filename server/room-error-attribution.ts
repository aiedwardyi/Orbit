// Room error attribution: the stall watchdog and provider-reload interrupts
// append `error:` activities. Without `from` the room cannot attribute them
// to a speaker, so Retry never appears. Lives outside the dispatch path so
// the rule is testable without booting the server.
import type { Message } from "./store.ts";

export interface RoomErrorBot {
  id: string;
  name: string;
  color: string;
}

type RoomErrorActivity = Omit<Message, "id" | "at">;

export function stallErrorActivity(
  bot: RoomErrorBot | null | undefined,
  minutes: number,
  isGroup: boolean,
): RoomErrorActivity {
  const activity: RoomErrorActivity = {
    role: "bot",
    kind: "activity",
    tool: { name: `error: no activity for ${minutes} minutes — the turn was stopped`, ok: false },
  };
  if (isGroup && bot) {
    activity.from = { botId: bot.id, name: bot.name, color: bot.color };
  }
  return activity;
}

export function providerReloadErrorActivity(
  bot: RoomErrorBot | null | undefined,
  isGroup: boolean,
): RoomErrorActivity {
  const activity: RoomErrorActivity = {
    role: "bot",
    kind: "activity",
    tool: { name: "error: turn interrupted — provider settings changed", ok: false },
  };
  if (isGroup && bot) {
    activity.from = { botId: bot.id, name: bot.name, color: bot.color };
  }
  return activity;
}
