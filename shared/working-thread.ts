/** Shared policy for visible run-now and which thread a busy bot is actually on. */

export type ActiveRunStatus = "queued" | "running" | "waiting";

const ACTIVE = new Set<string>(["queued", "running", "waiting"]);
const LIVE = new Set<string>(["running", "waiting"]);

export function isActiveRunStatus(status: string): status is ActiveRunStatus {
  return ACTIVE.has(status);
}

export function activeRunForRoutine<T extends { routineId: string; status: string }>(
  runs: readonly T[],
  routineId: string,
): T | undefined {
  return runs.find((run) => run.routineId === routineId && isActiveRunStatus(run.status));
}

export function activeRunForBot<T extends { botId: string; status: string }>(
  runs: readonly T[],
  botId: string,
): T | undefined {
  return runs.find((run) => run.botId === botId && isActiveRunStatus(run.status));
}

export function liveRunForBot<T extends { botId: string; status: string }>(
  runs: readonly T[],
  botId: string,
): T | undefined {
  return runs.find((run) => run.botId === botId && LIVE.has(run.status));
}

export type RunNowClick = "ignore" | "focus-active" | "start";

export function runNowClick(input: {
  inFlightRoutineId: string | null;
  routineId: string;
  activeRun?: { id: string } | null;
}): RunNowClick {
  if (input.inFlightRoutineId === input.routineId) return "ignore";
  if (input.activeRun) return "focus-active";
  return "start";
}

export function workingThreadId(input: {
  busy: boolean;
  viewedThreadId: string;
  liveRoutineThreadId?: string | null;
}): string | null {
  if (input.liveRoutineThreadId) return input.liveRoutineThreadId;
  return input.busy ? input.viewedThreadId : null;
}

export function canSwitchWhileWorking(targetThreadId: string, working: string | null): boolean {
  return working == null || targetThreadId === working;
}

export function canDeleteWhileWorking(targetThreadId: string, working: string | null): boolean {
  return working == null || targetThreadId !== working;
}

export function liveCalendarSelection<
  Routine extends { id: string },
  Run extends { id: string; routineId: string; status: string; scheduledFor: number },
>(
  selected: { id: string; at: number; routine: Routine | null; run: Run | null },
  routines: readonly Routine[],
  runs: readonly Run[],
) {
  const routine = selected.routine
    ? routines.find((candidate) => candidate.id === selected.routine?.id) ?? selected.routine
    : null;
  const selectedRun = selected.run
    ? runs.find((run) => run.id === selected.run?.id) ?? selected.run
    : null;
  if (!selectedRun && routine) {
    const active = activeRunForRoutine(runs, routine.id);
    if (active) {
      return { id: `run-${active.id}`, at: active.scheduledFor, routine, run: active };
    }
  }
  return { ...selected, routine, run: selectedRun };
}

export function routineWorkingElsewhere(
  viewedThreadId: string,
  run: { routineName: string; status: string; threadId?: string } | null | undefined,
): { name: string; threadId?: string; status: ActiveRunStatus } | null {
  if (!run || !isActiveRunStatus(run.status)) return null;
  if (run.threadId && run.threadId === viewedThreadId) return null;
  return { name: run.routineName, threadId: run.threadId, status: run.status };
}
