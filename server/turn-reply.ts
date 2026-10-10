// A collector waiting on one turn's reply. Bus subscribers each see every
// event, so the persistence guard dropping a stopped turn's late text does
// not stop it reaching a collector; each collector applies the same rule.
import type { RuntimeEvent } from "./contracts.ts";
import { ENGINE_SUMMARY_PREFIX } from "./replies.ts";

export type TurnReplyStep = { text: string } | "completed" | null;

export function ownTurnReply(stale: (threadId: string, turnId: string | undefined) => boolean) {
  let own: string | undefined;
  return {
    claim(turnId: string | undefined) {
      own ??= turnId;
    },
    fold(e: RuntimeEvent): TurnReplyStep {
      // the fold settles its own turn before collectors run, so completion
      // is matched by id, never by the stale rule
      if (e.type === "turn.completed") return !e.turnId || e.turnId === own ? "completed" : null;
      if (stale(e.threadId, e.turnId)) return null;
      if (e.type === "turn.started") own ??= e.turnId;
      if (e.type !== "item.completed" || e.itemType !== "assistant_text") return null;
      own ??= e.turnId;
      if (e.turnId && e.turnId !== own) return null;
      return { text: e.summarized ? `${ENGINE_SUMMARY_PREFIX}${e.text}` : e.text };
    },
  };
}

/** Per thread, the turn's engine summaries. A turn that wrote no other text
 * shows them at its end, or it would look empty. */
export function turnSummaries() {
  const turns = new Map<string, { turnId?: string; ids: string[]; replied: boolean }>();
  return {
    note(threadId: string, turnId: string | undefined, messageId: string, summarized: boolean) {
      let turn = turns.get(threadId);
      if (!turn || (turn.turnId && turnId && turn.turnId !== turnId)) turns.set(threadId, (turn = { turnId, ids: [], replied: false }));
      turn.turnId ??= turnId;
      if (summarized) turn.ids.push(messageId);
      else turn.replied = true;
    },
    settle(threadId: string, turnId: string | undefined): string[] {
      const turn = turns.get(threadId);
      if (!turn || (turn.turnId && turnId && turn.turnId !== turnId)) return [];
      turns.delete(threadId);
      return turn.replied ? [] : turn.ids;
    },
  };
}
