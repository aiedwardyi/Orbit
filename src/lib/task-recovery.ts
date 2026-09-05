/** Client banner eligibility for Continuity recovery. Must stay aligned with
 * the resume API: only crash / shutdown / stop packets are continuable.
 * Shutdown includes a normal idle reopen stamp. Turn-end, progress,
 * approval, engine-switch, and pre-compaction stay hidden in-session. */
export const TASK_RECOVERY_FLUSH_REASONS = ["crash", "shutdown", "stop"] as const;

export type TaskRecoveryFlushReason = (typeof TASK_RECOVERY_FLUSH_REASONS)[number];

export type TaskRecoveryDismissal = {
  updatedAt: number;
  flushReason: string;
};

/** Normal idle reopen stamps shutdown. That is a saved conversation, not
 * unfinished work — Resume and nextAction stay on crash / stop. */
export function isQuietSavedConversation(
  packet: { flushReason: string } | undefined | null,
): boolean {
  return packet?.flushReason === "shutdown";
}

export function isTaskRecoveryVisible<T extends { flushReason: string; updatedAt?: number }>(
  packet: T | undefined | null,
  botBusy: boolean | undefined,
  dismissed?: TaskRecoveryDismissal | null,
): packet is T {
  if (!packet || botBusy) return false;
  if (!(TASK_RECOVERY_FLUSH_REASONS as readonly string[]).includes(packet.flushReason)) return false;
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
