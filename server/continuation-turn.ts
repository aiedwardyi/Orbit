// A turn.started the harness did not dispatch: a retained CLI woke on its own
// after `result` (a background task's notification) and the driver opened a
// continuation turn. An idle 1:1 bot adopts it like a user-sent turn, so the
// composer locks, the watchdog runs, and queued sends wait for its settle.

export interface ContinuationBot {
  id: string;
  busy?: boolean;
  activeThreadId?: string;
}

export interface ContinuationDeps {
  botByThread(threadId: string): ContinuationBot | null | undefined;
  /** startTurn holds this bot's claim but may not have flipped busy yet. */
  claimed(botId: string): boolean;
  adopt(botId: string, threadId: string, turnId: string): void;
  /** Busy elsewhere: its completion must not mark the bot idle. */
  disown(turnId: string): void;
}

export type ContinuationFold = "ignored" | "owned" | "adopted" | "disowned";

export function foldContinuationStart(
  event: { threadId: string; turnId?: string },
  deps: ContinuationDeps,
): ContinuationFold {
  const bot = deps.botByThread(event.threadId);
  if (!bot || !event.turnId) return "ignored";
  if (bot.busy && bot.activeThreadId === event.threadId) return "owned";
  if (bot.busy || deps.claimed(bot.id)) {
    deps.disown(event.turnId);
    return "disowned";
  }
  deps.adopt(bot.id, event.threadId, event.turnId);
  return "adopted";
}
