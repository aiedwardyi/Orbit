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
