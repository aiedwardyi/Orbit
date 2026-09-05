/** Client banner eligibility for Continuity recovery. Must stay aligned with
 * the resume API: only crash / shutdown / stop packets are continuable.
 * Shutdown includes a normal idle reopen stamp. Turn-end, progress,
 * approval, engine-switch, and pre-compaction stay hidden in-session.
 * A v1 MED8 leftover that still offers a stale next action is dismissed. */
import {
  shouldDismissCompletedReopen,
} from "../../shared/task-resume";

export const TASK_RECOVERY_FLUSH_REASONS = ["crash", "shutdown", "stop"] as const;

export type TaskRecoveryFlushReason = (typeof TASK_RECOVERY_FLUSH_REASONS)[number];

export type TaskRecoveryDismissal = {
  updatedAt: number;
  flushReason: string;
};

export {
  hasUnfinishedTaskWork,
  isCompletedTaskRecord,
  shouldDismissCompletedReopen,
} from "../../shared/task-resume";

export function isTaskRecoveryVisible<T extends {
  flushReason: string;
  updatedAt?: number;
  v?: number;
  nextAction?: string;
  completed?: readonly unknown[];
  blockers?: readonly unknown[];
  plan?: ReadonlyArray<{ status: string }>;
  goal?: string;
}>(
  packet: T | undefined | null,
  botBusy: boolean | undefined,
  dismissed?: TaskRecoveryDismissal | null,
): packet is T {
  if (!packet || botBusy) return false;
  if (!(TASK_RECOVERY_FLUSH_REASONS as readonly string[]).includes(packet.flushReason)) return false;
  if (shouldDismissCompletedReopen(packet)) return false;
  if (
    dismissed &&
    dismissed.flushReason === packet.flushReason &&
    dismissed.updatedAt === packet.updatedAt
  ) {
    return false;
  }
  return true;
}

/** Active room conversation packet. DMs have no tasks collection, so they
 * keep the live record on the group itself. */
export function roomRecoveryPacket<P>(
  group: { threadId: string; tasks?: Array<{ threadId: string; taskState?: P }>; taskState?: P },
): P | undefined {
  const task = group.tasks?.find((candidate) => candidate.threadId === group.threadId);
  return task ? task.taskState : group.taskState;
}

/** Room strip busy is the live speaker, not a draining cancelled operation. */
export function roomRecoveryBusy(
  group: { busyBotId?: string | null },
  speakerBusy?: boolean,
): boolean {
  return Boolean(group.busyBotId) || Boolean(speakerBusy);
}

export function completedReopenDismissals<
  T extends {
    threadId: string;
    updatedAt: number;
    flushReason: string;
    v?: number;
    nextAction?: string;
    completed?: readonly unknown[];
    blockers?: readonly unknown[];
    plan?: ReadonlyArray<{ status: string }>;
    goal?: string;
  },
>(
  packets: ReadonlyArray<T | undefined | null>,
): Record<string, { updatedAt: number; flushReason: T["flushReason"] }> {
  const dismissals: Record<string, { updatedAt: number; flushReason: T["flushReason"] }> = {};
  for (const packet of packets) {
    if (!packet) continue;
    if (!shouldDismissCompletedReopen(packet)) continue;
    dismissals[packet.threadId] = { updatedAt: packet.updatedAt, flushReason: packet.flushReason };
  }
  return dismissals;
}
