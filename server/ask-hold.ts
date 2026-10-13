// An ask_user card waits for the reply of the turn that asked, so the
// transcript reads reply, then question. Bots may keep working after asking,
// so a card held past the cap posts anyway.
import type { EventBus } from "./harness/bus.ts";
import type { BotRecord, Store } from "./store.ts";

export const ASK_HOLD_CAP_MS = 30_000;

/** The asker's turn in this thread is still running. */
export function turnRunsIn(bot: Pick<BotRecord, "busy" | "activeThreadId"> | null | undefined, threadId: string): boolean {
  return Boolean(bot?.busy) && bot?.activeThreadId === threadId;
}

type Held = { botId: string; threadId: string; post: () => void; timer: ReturnType<typeof setTimeout> };

export class AskHold {
  private held: Held[] = [];
  private running: (botId: string, threadId: string) => boolean;
  private capMs: number;

  constructor(running: (botId: string, threadId: string) => boolean, capMs = ASK_HOLD_CAP_MS) {
    this.running = running;
    this.capMs = capMs;
  }

  /** Runs `post` now unless the asker's turn in that thread is running. */
  whenSettled(botId: string, threadId: string, post: () => void): void {
    if (!this.running(botId, threadId)) return post();
    const entry: Held = { botId, threadId, post, timer: setTimeout(() => this.release((h) => h === entry), this.capMs) };
    entry.timer.unref?.();
    this.held.push(entry);
  }

  /** Posts the bot's cards whose turn is no longer running. */
  settled(botId: string): void {
    this.release((h) => h.botId === botId && !this.running(h.botId, h.threadId));
  }

  /** The thread's turn ended, whatever the bot's state says. A room may have
   * another member mid-turn, so there only members no longer running release. */
  threadSettled(threadId: string, room = false): void {
    this.release((h) => h.threadId === threadId && (!room || !this.running(h.botId, h.threadId)));
  }

  flush(): void {
    this.release(() => true);
  }

  private release(match: (h: Held) => boolean): void {
    const due = this.held.filter(match);
    if (!due.length) return;
    this.held = this.held.filter((h) => !due.includes(h));
    for (const h of due) {
      clearTimeout(h.timer);
      h.post();
    }
  }
}

/** Every settle path (completion, stop, error, dispatch failure, stall) ends
 * the bot's busy state. session.exited and a superseded turn.completed may
 * not, so they release by thread. */
export function watchAskHold(
  store: Pick<Store, "bot" | "onChange" | "groupByThread">,
  bus: Pick<EventBus, "subscribe">,
  capMs = ASK_HOLD_CAP_MS,
): AskHold {
  const hold = new AskHold((botId, threadId) => turnRunsIn(store.bot(botId), threadId), capMs);
  store.onChange((change) => {
    if (change.type === "bot" || change.type === "bot.deleted") hold.settled(change.botId);
  });
  bus.subscribe((event) => {
    if (event.type === "turn.completed" || event.type === "session.exited") {
      hold.threadSettled(event.threadId, Boolean(store.groupByThread(event.threadId)));
    }
  });
  return hold;
}
