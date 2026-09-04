// Which 1:1 ChatView rows render, and where a day divider belongs. ChatView
// hides tool activity and screen frames unless Show tool calls is on, so
// dating against the previous ITEM can drop the divider off the next visible
// line. Turn-level errors stay visible so a dead engine is not a blank chat.
import { shouldHideOnboardingCard } from "@/components/OptionCard";
import { readContextCompaction } from "../../shared/context-compaction";
import { activityVisibleInChat, type TranscriptItem } from "./activity-runs";
import type { Message } from "@/state/store";

export interface ChatTranscriptOptions {
  showToolCalls: boolean;
  /** the newest reply, animating in above the transcript instead of inside it */
  emergingId?: string | null;
  /** Full active-branch transcript, used to hide a talked-past onboarding card. */
  transcript: Message[];
}

export interface ChatTranscriptRow {
  visible: boolean;
  newDay: boolean;
}

/** Mirrors the row ChatView's Transcript renders for one message. */
function messageVisible(message: Message, options: ChatTranscriptOptions): boolean {
  if (message.id === options.emergingId) return false;
  switch (message.kind) {
    case "compaction":
      return readContextCompaction({ value: message.compaction }).status !== "invalid";
    case "secret":
      return Boolean(message.secret);
    case "connector":
      return Boolean(message.connector);
    case "options":
      if (message.card?.requestId && message.card.tool) return true;
      if (shouldHideOnboardingCard(message, options.transcript)) return false;
      return Boolean(message.card);
    case "routine.run":
      return true;
    case "activity":
      return Boolean(
        message.tool?.name.startsWith("error:") || activityVisibleInChat(message, options.showToolCalls),
      );
    case "screen":
      return Boolean(message.png) && options.showToolCalls;
    default:
      return true;
  }
}

export function chatTranscriptRows(
  items: TranscriptItem[],
  options: ChatTranscriptOptions,
): ChatTranscriptRow[] {
  let prev: Message | undefined;
  return items.map((item) => {
    const first = item.kind === "run" ? item.messages[0] : item.message;
    const visible =
      item.kind === "run" ? options.showToolCalls : messageVisible(first, options);
    if (!visible) return { visible, newDay: false };
    const newDay = !prev || new Date(prev.at).toDateString() !== new Date(first.at).toDateString();
    prev = item.kind === "run" ? item.messages.at(-1) : item.message;
    return { visible, newDay };
  });
}
