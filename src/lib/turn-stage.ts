// One shimmer label per real wait phase. The 1:1 bubble deliberately pops in
// whole, so this label is the only thing separating a slow provider from a
// wedged one. Every phase below reads a signal the client already receives.
import type { Message } from "@/state/store";
import { t } from "./i18n";

/** Last turn-lifecycle runtime event seen on a thread. Cleared each turn. */
export type TurnSignal = "started" | "retrying";

export type TurnSignals = Readonly<Record<string, TurnSignal>>;

/** What just happened to a thread, in the vocabulary of the live event stream. */
export type TurnEvent =
  | "started"
  | "retrying"
  | "settled-message"
  | "rewound"
  | "completed"
  | "sent"
  | "hydrated"
  | "edited"
  | "dispatched";

export type TurnPhase = "preparing" | "waiting" | "retrying" | "reasoning" | "tool" | "responding";

export type StreamKind = "assistant_text" | "reasoning_text";

export type StreamBuffers = {
  streaming?: string;
  reasoning?: string;
};

export type TurnStreamState = {
  streaming: Record<string, string>;
  reasoning: Record<string, string>;
  signal: TurnSignals;
  /** Client wait generation. Bumped when a turn starts before the tail moves. */
  gen?: Record<string, number>;
  /** Identity the current buffers were written under, per thread. */
  turn?: Record<string, string>;
};

/** Identity of the wait on screen: generation plus the transcript tail. */
export function currentTurnId(
  state: Pick<TurnStreamState, "gen">,
  threadId: string,
  lastMessageId?: string,
): string {
  return `${state.gen?.[threadId] ?? 0}:${lastMessageId ?? ""}`;
}

/** Discard buffers that do not belong to this thread's current wait. */
export function buffersForTurn(
  state: Pick<TurnStreamState, "streaming" | "reasoning" | "gen" | "turn">,
  threadId: string,
  lastMessageId?: string,
): StreamBuffers {
  if ((state.turn?.[threadId] ?? "") !== currentTurnId(state, threadId, lastMessageId)) return {};
  return { streaming: state.streaming[threadId], reasoning: state.reasoning[threadId] };
}

/** Thread to backfill from a busy snapshot, or none if the work may be elsewhere. */
export function hydrationTurnThread(
  bot: { id?: string; busy?: boolean; threadId: string; workingThreadId?: string | null },
  groups: readonly { busyBotId?: string | null }[] = [],
): string | undefined {
  if (!bot.busy) return undefined;
  if (bot.workingThreadId) return bot.workingThreadId;
  if (bot.id && groups.some((group) => group.busyBotId === bot.id)) return undefined;
  return bot.threadId;
}

/** Last visible message id as frames fold, including before React commits. */
export function rememberStreamTail(tails: Record<string, string>, threadId: string, messageId: string) {
  if (tails[threadId] === messageId) return tails;
  return { ...tails, [threadId]: messageId };
}

/** Live provider turn id per thread, from lifecycle events. */
export function liveTurnIdAfter(
  live: Record<string, string>,
  threadId: string,
  event: { type: string; turnId?: string },
) {
  if ((event.type === "turn.started" || event.type === "turn.retrying") && event.turnId) {
    return live[threadId] === event.turnId ? live : { ...live, [threadId]: event.turnId };
  }
  if (event.type === "turn.completed") {
    if (event.turnId && live[threadId] && live[threadId] !== event.turnId) return live;
    if (!(threadId in live)) return live;
    const { [threadId]: _ended, ...rest } = live;
    return rest;
  }
  return live;
}

/** False when a stopped turn reports completion after a newer one is live. */
export function isCurrentTurnCompletion(
  live: Record<string, string>,
  threadId: string,
  eventTurnId?: string,
): boolean {
  const current = live[threadId];
  if (!eventTurnId || !current) return true;
  return current === eventTurnId;
}

/** Key present = that stream kind arrived; the payload may be "" while redaction holds it. */
function receivedStream(value?: string): boolean {
  return value !== undefined;
}

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
  if (receivedStream(input.streaming)) return "responding";
  if (tool && tool.ok === undefined) return "tool";
  if (receivedStream(input.reasoning)) return "reasoning";
  if (input.signal === "retrying") return "retrying";
  if (input.signal === "started") return "waiting";
  return "preparing";
}

/**
 * The signal is turn-scoped, and a settled assistant message is not a turn
 * boundary: a bot finishes a preamble and keeps working, so clearing there
 * would drop a running turn back to "Preparing".
 *
 * "sent" / "edited" bound the scope. A turn can die without ever emitting
 * turn.completed - the stall watchdog's grace fallback and a provider reload
 * both settle killed turns silently - so the next client action that starts
 * a turn drops whatever the last one left behind, whichever way it ended.
 */
export function nextTurnSignals(signals: TurnSignals, threadId: string, event: TurnEvent): TurnSignals {
  switch (event) {
    case "settled-message":
      return signals;
    case "started":
    case "retrying":
      return signals[threadId] === event ? signals : { ...signals, [threadId]: event };
    case "hydrated":
      // Snapshot has busy but not StreamState.signal. Don't clobber a live retry.
      return threadId in signals ? signals : { ...signals, [threadId]: "started" };
    case "rewound":
    case "completed":
    case "sent":
    case "edited":
    case "dispatched": {
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

/** Receipt of the stream kind, independent of whether redaction held the text. */
export function applyStreamDelta(buffers: StreamBuffers, kind: StreamKind, delta: string): StreamBuffers {
  if (kind === "assistant_text") return { ...buffers, streaming: (buffers.streaming ?? "") + delta };
  return { ...buffers, reasoning: (buffers.reasoning ?? "") + delta };
}

function bumpedGen(prev: TurnStreamState, threadId: string) {
  return { ...prev.gen, [threadId]: (prev.gen?.[threadId] ?? 0) + 1 };
}

function withoutThreadBuffers(
  prev: TurnStreamState,
  threadId: string,
  signal: TurnSignals,
  gen: Record<string, number> | undefined = prev.gen,
): TurnStreamState {
  const hasTurn = Boolean(prev.turn && threadId in prev.turn);
  if (
    !(threadId in prev.streaming) &&
    !(threadId in prev.reasoning) &&
    !hasTurn &&
    signal === prev.signal &&
    gen === prev.gen
  ) {
    return prev;
  }
  const { [threadId]: _s, ...streaming } = prev.streaming;
  const { [threadId]: _r, ...reasoning } = prev.reasoning;
  const { [threadId]: _t, ...turn } = prev.turn ?? {};
  return { ...prev, streaming, reasoning, turn, signal, gen };
}

/**
 * Buffers belong to one wait. `sent` / `edited` / `dispatched` bump generation
 * because those start a turn before the transcript tail moves. `dispatched`
 * is what startTurn broadcasts, so resume/routine/delegation/drain are
 * covered without enumerating HTTP call sites. `hydrated` drops them because
 * the snapshot is authoritative and does not include ephemeral stream text.
 * `started` / `retrying` only touch the lifecycle signal, or a retry would
 * wipe the tokens that should keep the label on Responding.
 */
export function nextStreamState(prev: TurnStreamState, threadId: string, event: TurnEvent): TurnStreamState {
  const signal = nextTurnSignals(prev.signal, threadId, event);
  switch (event) {
    case "started":
    case "retrying":
      return signal === prev.signal ? prev : { ...prev, signal };
    case "hydrated":
    case "sent":
    case "edited":
    case "dispatched":
      return withoutThreadBuffers(prev, threadId, signal, bumpedGen(prev, threadId));
    case "settled-message":
    case "rewound":
    case "completed":
      return withoutThreadBuffers(prev, threadId, signal);
    default: {
      const unhandled: never = event;
      void unhandled;
      return prev;
    }
  }
}

/** Write a delta into the current wait; a different wait starts a fresh buffer. */
export function writeStreamDelta(
  prev: TurnStreamState,
  threadId: string,
  delta: StreamBuffers,
  currentTurn: string,
): TurnStreamState {
  const same = prev.turn?.[threadId] === currentTurn;
  const streaming = { ...prev.streaming };
  const reasoning = { ...prev.reasoning };
  if (delta.streaming !== undefined) {
    streaming[threadId] = (same ? (streaming[threadId] ?? "") : "") + delta.streaming;
  } else if (!same) {
    delete streaming[threadId];
  }
  if (delta.reasoning !== undefined) {
    reasoning[threadId] = (same ? (reasoning[threadId] ?? "") : "") + delta.reasoning;
  } else if (!same) {
    delete reasoning[threadId];
  }
  return { ...prev, streaming, reasoning, turn: { ...prev.turn, [threadId]: currentTurn } };
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
