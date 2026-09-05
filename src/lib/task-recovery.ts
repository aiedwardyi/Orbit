/** Client banner eligibility for Continuity recovery. Must stay aligned with
 * the resume API: only crash / shutdown / stop packets are continuable.
 * Turn-end, progress, approval, engine-switch, and pre-compaction stay hidden. */
export const TASK_RECOVERY_FLUSH_REASONS = ["crash", "shutdown", "stop"] as const;

export type TaskRecoveryFlushReason = (typeof TASK_RECOVERY_FLUSH_REASONS)[number];

export function isTaskRecoveryVisible<T extends { flushReason: string }>(
  packet: T | undefined | null,
  botBusy: boolean | undefined,
): packet is T {
  return Boolean(
    packet && !botBusy && (TASK_RECOVERY_FLUSH_REASONS as readonly string[]).includes(packet.flushReason),
  );
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
