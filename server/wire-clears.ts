// JSON drops undefined and clients merge bot and room frames, so a field a
// PATCH clears must go out as null or every other open client keeps it.
import type { BotRecord, GroupRecord } from "./store.ts";

export const botClears = (
  bot: Pick<BotRecord, "pinnedMessageId" | "section" | "mascotStyle" | "browserProfile" | "lastProjectCwd" | "projectNotes">,
) => ({
  pinnedMessageId: bot.pinnedMessageId ?? null,
  section: bot.section ?? null,
  mascotStyle: bot.mascotStyle ?? null,
  browserProfile: bot.browserProfile ?? null,
  rememberedProjectCwd: bot.lastProjectCwd ?? null,
  projectNotes: bot.projectNotes ?? null,
});

export const groupClears = (group: Pick<GroupRecord, "pinnedMessageId" | "section" | "cwd">) => ({
  pinnedMessageId: group.pinnedMessageId ?? null,
  section: group.section ?? null,
  cwd: group.cwd ?? null,
});
