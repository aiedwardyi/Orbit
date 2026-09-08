// One shimmer label per real wait phase. The 1:1 bubble deliberately pops in
// whole, so this label is the only thing separating a slow provider from a
// wedged one. Every phase below reads a signal the client already receives.
import type { Message } from "@/state/store";
import { t } from "./i18n";

/** Last turn-lifecycle runtime event seen on a thread. Cleared each turn. */
export type TurnSignal = "started" | "retrying";

export type TurnSignals = Readonly<Record<string, TurnSignal>>;

/** What just happened to a thread, in the vocabulary of the live event stream. */
export type TurnEvent = "started" | "retrying" | "settled-message" | "rewound" | "completed" | "sent";

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

/**
 * The signal is turn-scoped, and a settled assistant message is not a turn
 * boundary: a bot finishes a preamble and keeps working, so clearing there
 * would drop a running turn back to "Preparing".
 *
 * "sent" is what bounds the scope. A turn can die without ever emitting
 * turn.completed — the stall watchdog's grace fallback and a provider reload
 * both settle killed turns silently — so the next send that starts a turn
 * drops whatever the last one left behind, whichever way it ended.
 */
export function nextTurnSignals(signals: TurnSignals, threadId: string, event: TurnEvent): TurnSignals {
  switch (event) {
    case "settled-message":
      return signals;
    case "started":
    case "retrying":
      return signals[threadId] === event ? signals : { ...signals, [threadId]: event };
    case "rewound":
    case "completed":
    case "sent": {
      if (!(threadId in signals)) return signals;
      const { [threadId]: _ended, ...rest } = signals;
      return rest;
    }
    default: {
      // `satisfies` is erased at runtime; this branch must still return signals.
      const unhandled: never = event;
      void unhandled;
      return signals;
    }
  }
}

/**
 * A tool call closes the model's reasoning block, but not the stream: only
 * settled assistant text does that. Leaving the reasoning buffer set past a
 * tool pins the label to "Thinking" for the whole post-tool model wait.
 */
export function streamResetFor(message: { role?: string; kind?: string }): "stream" | "reasoning" | null {
  if (message.role === "bot" && message.kind === "text") return "stream";
  if (message.kind === "activity") return "reasoning";
  return null;
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
    default:
      return phase satisfies never;
  }
}
