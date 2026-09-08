// One shimmer label per real wait phase. The 1:1 bubble deliberately pops in
// whole, so this label is the only thing separating a slow provider from a
// wedged one. Every phase below reads a signal the client already receives.
import type { Message } from "@/state/store";
import { t } from "./i18n";

/** Last turn-lifecycle runtime event seen on a thread. Cleared each turn. */
export type TurnSignal = "started" | "retrying";

export type TurnPhase = "preparing" | "waiting" | "retrying" | "reasoning" | "tool" | "responding";

/**
 * Ordered so that evidence of progress outranks evidence of setup: a retry
 * announcement is never withdrawn, so without this a post-retry turn would
 * read "Reconnecting" while it was already answering.
 */
export function turnPhase(input: {
  signal?: TurnSignal;
  lastMessage?: Message;
  streaming?: string;
  reasoning?: string;
}): TurnPhase {
  const tool = input.lastMessage?.kind === "activity" ? input.lastMessage.tool : undefined;
  if (input.streaming) return "responding";
  if (tool && tool.ok === undefined) return "tool";
  if (input.reasoning) return "reasoning";
  if (input.signal === "retrying") return "retrying";
  if (input.signal === "started") return "waiting";
  return "preparing";
}

/** `toolLabel` stays authoritative for tools: it honours Show tool calls. */
export function turnStageLabel(phase: TurnPhase, toolLabel: string): string {
  switch (phase) {
    case "responding":
      return t("activity.responding");
    case "tool":
      return toolLabel;
    case "reasoning":
      return t("activity.thinking");
    case "retrying":
      return t("activity.reconnecting");
    case "waiting":
      return t("activity.waitingModel");
    case "preparing":
      return t("activity.preparing");
  }
}
