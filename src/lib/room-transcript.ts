// Which room transcript rows render, and where a speaker label or a day
// divider belongs. A room hides successful tool activity unless Show tool
// calls is on, so clustering against the previous ITEM drops the label off a
// bot's first visible line and the bubble reads as the previous speaker's.
import type { TranscriptItem } from "./activity-runs";
import type { Message } from "@/state/store";

export interface RoomTranscriptOptions {
  showToolCalls: boolean;
  /** the newest reply, animating in above the transcript instead of inside it */
  emergingId?: string | null;
}

export interface RoomTranscriptRow {
  visible: boolean;
  newDay: boolean;
  cluster: boolean;
}

/** Mirrors the row Transcript renders for one message. A failed step and a
 * bot⇄bot chip stay whatever the setting says: one is the reason to look, the
 * other is a link to another conversation, not tool work. */
function messageVisible(message: Message, showToolCalls: boolean): boolean {
  switch (message.kind) {
    case "text":
      return Boolean(message.text);
    case "activity":
      return Boolean(
        message.tool &&
          (message.comm ||
            message.tool.ok === false ||
            message.tool.name.startsWith("error:") ||
            showToolCalls),
      );
    case "secret":
      return Boolean(message.secret && message.from?.botId);
    case "connector":
      return Boolean(message.connector && message.from?.botId);
    case "options":
      return Boolean(message.card?.requestId && message.card.tool);
    case "routine.run":
      return true;
    default:
      return false;
  }
}

export function roomTranscriptRows(
  items: TranscriptItem[],
  options: RoomTranscriptOptions,
): RoomTranscriptRow[] {
  let prev: Message | undefined;
  return items.map((item) => {
    const first = item.kind === "run" ? item.messages[0] : item.message;
    const visible =
      item.kind === "run"
        ? options.showToolCalls
        : first.id !== options.emergingId && messageVisible(first, options.showToolCalls);
    if (!visible) return { visible, newDay: false, cluster: false };
    const newDay = !prev || new Date(prev.at).toDateString() !== new Date(first.at).toDateString();
    const cluster = !prev || prev.role !== first.role || prev.from?.botId !== first.from?.botId || newDay;
    prev = item.kind === "run" ? item.messages.at(-1) : item.message;
    return { visible, newDay, cluster };
  });
}
