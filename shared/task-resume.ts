/** Shared Continuity helpers: completed conversation vs unfinished work. */

export function firstTaskLine(text: string): string {
  return text.trim().split("\n")[0]!.trim();
}

export function isPlanFinished(packet: { plan?: ReadonlyArray<{ status: string }> }): boolean {
  const plan = packet.plan ?? [];
  return plan.length > 0 && plan.every((item) => item.status === "done" || item.status === "skipped");
}

export interface TaskCompletionShape {
  v?: number;
  flushReason?: string;
  goal?: string;
  nextAction?: string;
  completed?: readonly unknown[];
  blockers?: readonly unknown[];
  plan?: ReadonlyArray<{ status: string }>;
}

/** Saved work whose output is already recorded — not a pending Resume. */
export function isCompletedTaskRecord(packet: TaskCompletionShape | null | undefined): boolean {
  if (!packet) return false;
  if (packet.flushReason === "crash" || packet.flushReason === "stop") return false;
  if ((packet.blockers?.length ?? 0) > 0) return false;
  if ((packet.completed?.length ?? 0) === 0) return false;
  if (isPlanFinished(packet)) return true;
  const next = packet.nextAction?.trim() ?? "";
  if (!next) return true;
  return next === firstTaskLine(packet.goal ?? "");
}

export function hasUnfinishedTaskWork(packet: TaskCompletionShape | null | undefined): boolean {
  if (!packet) return false;
  if (packet.flushReason === "crash" || packet.flushReason === "stop") return true;
  if ((packet.blockers?.length ?? 0) > 0) return true;
  if (isCompletedTaskRecord(packet)) return false;
  return Boolean(packet.nextAction?.trim());
}

/** v1 MED8 leftover: shutdown stamp still offering a stale next action. */
export function shouldDismissCompletedReopen(packet: TaskCompletionShape | null | undefined): boolean {
  return Boolean(
    packet
    && packet.v === 1
    && packet.flushReason === "shutdown"
    && packet.nextAction?.trim()
    && isCompletedTaskRecord(packet),
  );
}
