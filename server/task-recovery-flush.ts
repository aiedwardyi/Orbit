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

/** A delayed dismiss must not overwrite a newer Stop / crash packet. */
export function shouldStampRecoveryDismiss(
  current: { updatedAt: number; flushReason: string },
  requested: { updatedAt?: unknown; flushReason?: unknown },
): boolean {
  if (requested.updatedAt !== undefined && requested.updatedAt !== current.updatedAt) return false;
  if (requested.flushReason !== undefined && requested.flushReason !== current.flushReason) return false;
  return true;
}

/** Idle close may offer a reopen strip when a real forever-chat record already
 * exists and is not the live/dismissed `progress` write. Completed records
 * still stamp so the quiet saved copy can show; they are not unfinished work.
 * Crash/stop/shutdown stay on their own paths. Empty or new bots have no packet. */
export function idleReopenStampReason(
  packet: { flushReason: string; goal?: string; botId?: string } | null | undefined,
): RecoveryFlushReason | null {
  if (!packet) return null;
  if (isRecoveryFlushReason(packet.flushReason)) return null;
  if (packet.flushReason === "progress") return null;
  return "shutdown";
}

export interface ShutdownStamp {
  threadId: string;
  botId: string;
  reason: RecoveryFlushReason;
}

/** Host close: interrupt busy 1:1 and room turns, then stamp idle forever
 * threads so a normal reopen can show the quiet strip. */
export function shutdownStampsForClose(input: {
  bots: ReadonlyArray<{ id: string; busy?: boolean; threadId: string; activeThreadId?: string }>;
  groups: ReadonlyArray<{ threadId: string; busyBotId?: string | null; memberIds: readonly string[] }>;
  routineThreadByBotId?: Readonly<Record<string, string>>;
  packetFor: (threadId: string) => { flushReason: string; goal?: string; botId?: string } | null;
}): ShutdownStamp[] {
  const stamps: ShutdownStamp[] = [];
  const seen = new Set<string>();
  const add = (threadId: string, botId: string, reason: RecoveryFlushReason) => {
    if (!threadId || !botId || seen.has(threadId)) return;
    seen.add(threadId);
    stamps.push({ threadId, botId, reason });
  };

  const roomBusy = new Set(
    input.groups.flatMap((group) => (group.busyBotId ? [group.busyBotId] : [])),
  );

  for (const bot of input.bots) {
    if (!bot.busy || roomBusy.has(bot.id)) continue;
    add(
      input.routineThreadByBotId?.[bot.id] ?? bot.activeThreadId ?? bot.threadId,
      bot.id,
      "shutdown",
    );
  }

  for (const group of input.groups) {
    if (!group.busyBotId) continue;
    add(group.threadId, group.busyBotId, "shutdown");
  }

  for (const bot of input.bots) {
    if (bot.busy) continue;
    const reason = idleReopenStampReason(input.packetFor(bot.threadId));
    if (reason) add(bot.threadId, bot.id, reason);
  }

  for (const group of input.groups) {
    if (group.busyBotId) continue;
    const packet = input.packetFor(group.threadId);
    const botId = packet?.botId ?? group.memberIds[0];
    const reason = idleReopenStampReason(packet);
    if (botId && reason) add(group.threadId, botId, reason);
  }

  return stamps;
}

export function lastUserInstruction(
  messages: ReadonlyArray<{ id: string; role: string; kind?: string; text?: string; at: number }>,
): { text: string; messageId: string; at: number } | null {
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i]!;
    if (message.role !== "user" || (message.kind !== undefined && message.kind !== "text")) continue;
    const text = message.text?.trim();
    if (!text) continue;
    return { text, messageId: message.id, at: message.at };
  }
  return null;
}

/** Decide whether a turn.completed belongs to the live turn or to a Stop/crash
 * that already handed the thread to a newer dispatch. */
export function turnCompletionDisposition(input: {
  eventTurnId?: string;
  liveTurnId?: string;
  interruptedTurnIds: ReadonlySet<string>;
  interruptedAt: number;
  dispatchedAt: number;
}): { superseded: boolean; interrupted: boolean } {
  const interrupted = input.eventTurnId
    ? input.interruptedTurnIds.has(input.eventTurnId)
    : input.interruptedAt > input.dispatchedAt;
  const superseded = Boolean(
    input.eventTurnId && input.liveTurnId && input.liveTurnId !== input.eventTurnId,
  );
  return { superseded, interrupted };
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
