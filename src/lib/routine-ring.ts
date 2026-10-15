import type { RoutineRun } from "@/lib/routines";
import { runThread } from "../../shared/working-thread";

type RingRun = Pick<RoutineRun, "runOn" | "status" | "threadId" | "sourceThreadId" | "seenAt">;

const RINGS = new Set(["running", "waiting", "completed"]);

/** A local run that fired in its chat and has not been opened there yet. */
export function isRinging(run: RingRun): boolean {
  return run.runOn !== "cloud" && !run.threadId && RINGS.has(run.status) && !run.seenAt;
}

export function ringingRuns<T extends RingRun>(runs: readonly T[], threadId: string): T[] {
  return runs.filter((run) => isRinging(run) && runThread(run) === threadId);
}

export function routineRinging(runs: readonly RingRun[], threadId: string): boolean {
  return runs.some((run) => isRinging(run) && runThread(run) === threadId);
}

/** anyChatNeedsYou for the ring: any listed chat but the open one. */
export function anyRoutineRinging(
  runs: readonly RingRun[],
  chats: Iterable<{ id: string; threadId: string; hidden?: boolean }>,
  exceptId?: string,
): boolean {
  for (const chat of chats) {
    if (chat.id !== exceptId && !chat.hidden && routineRinging(runs, chat.threadId)) return true;
  }
  return false;
}
