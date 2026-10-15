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

/** Where a run's turn lives: its detached task, else the chat it fires in. */
export function runThread(run: { threadId?: string; sourceThreadId?: string }): string | undefined {
  return run.threadId ?? run.sourceThreadId;
}

export function routineWorkingElsewhere(
  viewedThreadId: string,
  run: { routineName: string; status: string; threadId?: string; sourceThreadId?: string } | null | undefined,
): { name: string; threadId?: string; status: ActiveRunStatus } | null {
  if (!run || !isActiveRunStatus(run.status)) return null;
  const threadId = runThread(run);
  if (threadId && threadId === viewedThreadId) return null;
  return { name: run.routineName, threadId, status: run.status };
}

/** On a routine's execution thread, where "Back to chat" lands: the
 * conversation the routine reports to, else the bot's newest non-routine
 * task. A room source also moves the bot off the run thread. */
export function routineThreadReturn(input: {
  botId: string;
  viewedThreadId: string;
  tasks: readonly { threadId: string }[] | undefined;
  runs: readonly { routineName: string; status: string; threadId?: string; sourceThreadId?: string }[];
  groups: readonly { id: string; threadId: string; memberIds: readonly string[]; tasks?: readonly { threadId: string }[] }[];
}): { name: string; live: boolean; botThreadId: string | null; group: { id: string; threadId: string } | null } | null {
  const run = input.runs.find((candidate) => candidate.threadId === input.viewedThreadId);
  if (!run) return null;
  const routineThreads = new Set(input.runs.map((candidate) => candidate.threadId));
  const tasks = (input.tasks ?? []).filter((task) => !routineThreads.has(task.threadId));
  const source = run.sourceThreadId;
  const base = { name: run.routineName, live: LIVE.has(run.status) };
  if (source && tasks.some((task) => task.threadId === source)) return { ...base, botThreadId: source, group: null };
  const fallback = tasks[0]?.threadId ?? null;
  const group = source
    ? input.groups.find(
      (candidate) =>
        candidate.memberIds.includes(input.botId) &&
        (candidate.threadId === source || (candidate.tasks ?? []).some((task) => task.threadId === source)),
    )
    : undefined;
  return { ...base, botThreadId: fallback, group: group && source ? { id: group.id, threadId: source } : null };
}
