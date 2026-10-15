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

function runInChat(run: RingRun, threadId: string, tasks?: readonly { threadId: string }[]): boolean {
  if (!isRinging(run)) return false;
  const thread = runThread(run);
  if (!thread) return false;
  if (thread === threadId) return true;
  // The sidebar row is the bot or room, so an older task's ring still belongs to it.
  return tasks?.some((task) => task.threadId === thread) ?? false;
}

export function routineRinging(
  runs: readonly RingRun[],
  threadId: string,
  tasks?: readonly { threadId: string }[],
): boolean {
  return runs.some((run) => runInChat(run, threadId, tasks));
}

/** App settings and plugins cover the chat while activeView stays "chat". */
export function routineChatOnScreen(view: {
  activeView: string;
  workspaceOpen: boolean;
  appSettingsOpen: boolean;
  pluginsOpen: boolean;
}): boolean {
  return view.activeView === "chat" && !view.workspaceOpen && !view.appSettingsOpen && !view.pluginsOpen;
}

/** anyChatNeedsYou for the ring: any listed chat but the open one. */
export function anyRoutineRinging(
  runs: readonly RingRun[],
  chats: Iterable<{ id: string; threadId: string; hidden?: boolean; tasks?: readonly { threadId: string }[] }>,
  exceptId?: string,
): boolean {
  for (const chat of chats) {
    if (chat.id !== exceptId && !chat.hidden && routineRinging(runs, chat.threadId, chat.tasks)) return true;
  }
  return false;
}
