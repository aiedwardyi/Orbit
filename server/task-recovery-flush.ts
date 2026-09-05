import {
  seedTaskResumePacket,
  stampTaskResumePacket,
} from "./task-state-fold.ts";
import type { TaskResumePacket } from "./task-state.ts";

export const RECOVERY_FLUSH_REASONS = ["crash", "shutdown", "stop"] as const;

export type RecoveryFlushReason = (typeof RECOVERY_FLUSH_REASONS)[number];

export function isRecoveryFlushReason(reason: string): reason is RecoveryFlushReason {
  return (RECOVERY_FLUSH_REASONS as readonly string[]).includes(reason);
}

export function lastUserInstruction(
  messages: ReadonlyArray<{ id: string; role: string; kind?: string; text?: string; at: number }>,
): { text: string; messageId: string; at: number } | null {
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i]!;
    if (message.role !== "user" || (message.kind !== undefined && message.kind !== "text")) continue;
    const text = message.text?.trim();
    if (!text) continue;
    return { text: message.text!, messageId: message.id, at: message.at };
  }
  return null;
}

export function packetAfterInterruption(
  packet: TaskResumePacket | null,
  reason: RecoveryFlushReason,
  stamp: { now: number; turnsAtWrite: number },
  seed?: {
    botId: string;
    threadId: string;
    text: string;
    messageId: string;
    now: number;
    turnsAtWrite: number;
  } | null,
): TaskResumePacket | null {
  if (packet) return stampTaskResumePacket(packet, reason, stamp);
  if (!seed?.text.trim()) return null;
  return stampTaskResumePacket(seedTaskResumePacket(seed), reason, stamp);
}
