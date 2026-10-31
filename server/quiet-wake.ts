import type { RuntimeEvent } from "./contracts.ts";
import type { RoutineRun, RoutineRunTrigger } from "./routines.ts";

type WakeOptions = { paneNoteWake?: boolean; keepGoingWake?: boolean; automationSource?: RoutineRunTrigger };

export function createQuietWakeTurns() {
  const turns = new Map<string, { pending: string; streaming: boolean }>();
  const start = (threadId: string, opts: WakeOptions | undefined, folded: readonly string[]) => {
    turns.delete(threadId);
    if (!folded.length && (opts?.paneNoteWake || opts?.keepGoingWake || opts?.automationSource !== undefined)) {
      turns.set(threadId, { pending: "", streaming: false });
    }
  };
  const hidden = (threadId: string, text: string | undefined): boolean =>
    turns.has(threadId) && (!text?.trim() || text.trim() === "·");
  return {
    start,
    startRoom(threadId: string, botId: string, continuation: boolean, runs: readonly Pick<RoutineRun, "status" | "botId" | "threadId" | "sourceThreadId" | "triggerSource">[]) {
      const run = continuation ? runs.find((run) => ["running", "waiting"].includes(run.status)
        && (run.threadId ?? run.sourceThreadId) === threadId && run.botId === botId) : undefined;
      start(threadId, run ? { automationSource: run.triggerSource ?? "schedule" } : undefined, []);
    },
    delete(threadId: string) {
      turns.delete(threadId);
    },
    hidden,
    routineUnread(threadId: string, status: RoutineRun["status"], output: string | undefined): boolean {
      return status !== "completed" || !hidden(threadId, output);
    },
    broadcast(event: RuntimeEvent): RuntimeEvent | null {
      const turn = turns.get(event.threadId);
      if (!turn) return event;
      if (event.type === "item.completed" && event.itemType === "assistant_text") {
        turn.pending = "";
        turn.streaming = false;
      }
      if (event.type !== "content.delta" || (event.streamKind ?? "assistant_text") !== "assistant_text" || turn.streaming) return event;
      const delta = turn.pending + event.delta;
      if (!delta.trim() || delta.trim() === "·") {
        turn.pending = delta;
        return null;
      }
      turn.pending = "";
      turn.streaming = true;
      return { ...event, delta };
    },
  };
}

export const quietWakeTurns = createQuietWakeTurns();
