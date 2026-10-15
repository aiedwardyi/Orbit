import { isCompletedTaskRecord, type TaskCompletionShape } from "../shared/task-resume.ts";

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

/** A reopen only recovers work that was actually left unfinished. An idle
 *  close stamps a finished conversation too, and calling that an interruption
 *  hands the model a record that contradicts the request in front of it. */
export function isRecoveringPacket(
  packet: (TaskCompletionShape & { flushReason: string }) | null | undefined,
): boolean {
  return Boolean(packet && isRecoveryFlushReason(packet.flushReason) && !isCompletedTaskRecord(packet));
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
  stopReason?: string | null;
}): { superseded: boolean; interrupted: boolean } {
  // A room deadline and the stall watchdog interrupt the adapter directly
  // without marking the thread, and ACP cancellation settles ok:true — so the
  // terminal reason is the only thing separating those from a clean finish.
  const interrupted = input.stopReason === "cancelled" || input.stopReason === "interrupted"
    ? true
    : input.eventTurnId
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

export interface TaskResumeEntry {
  botId: string;
  threadId: string;
  order: number;
}

export interface TaskResumeDeps {
  busy(entry: TaskResumeEntry): boolean;
  earlierSend(entry: TaskResumeEntry): boolean;
  start(entry: TaskResumeEntry): Promise<unknown>;
  isBusy(error: unknown): boolean;
  settled(entry: TaskResumeEntry, error: unknown | null): void;
}

export class TaskResumeScheduler {
  private readonly pending = new Map<string, TaskResumeEntry & { starting: boolean }>();
  private readonly deps: TaskResumeDeps;

  constructor(deps: TaskResumeDeps) {
    this.deps = deps;
  }

  async request(botId: string, threadId: string, order: number): Promise<{ pending: boolean }> {
    const key = `${botId}\0${threadId}`;
    if (this.pending.has(key)) return { pending: true };
    const entry = { botId, threadId, order, starting: false };
    this.pending.set(key, entry);
    if (this.deps.busy(entry) || this.deps.earlierSend(entry)) return { pending: true };
    return this.dispatch(key, entry);
  }

  settled(): void {
    for (const [key, entry] of this.pending) {
      if (entry.starting || this.deps.busy(entry) || this.deps.earlierSend(entry)) continue;
      void this.dispatch(key, entry).catch(() => {});
    }
  }

  blocksQueuedSend(botId: string): boolean {
    return [...this.pending.values()].some((entry) => entry.botId === botId && !this.deps.earlierSend(entry));
  }

  forgetBot(botId: string): void {
    for (const [key, entry] of this.pending) {
      if (entry.botId !== botId) continue;
      this.pending.delete(key);
      this.deps.settled(entry, null);
    }
  }

  forgetThread(threadId: string): void {
    for (const [key, entry] of this.pending) {
      if (entry.threadId !== threadId) continue;
      this.pending.delete(key);
      this.deps.settled(entry, null);
    }
  }

  private async dispatch(key: string, entry: TaskResumeEntry & { starting: boolean }): Promise<{ pending: boolean }> {
    entry.starting = true;
    try {
      await this.deps.start(entry);
    } catch (error) {
      if (this.pending.get(key) !== entry) return { pending: false };
      entry.starting = false;
      if (this.deps.isBusy(error)) return { pending: true };
      this.pending.delete(key);
      this.deps.settled(entry, error);
      throw error;
    }
    if (this.pending.get(key) === entry) {
      this.pending.delete(key);
      this.deps.settled(entry, null);
    }
    return { pending: false };
  }
}

export class PendingTurnInterrupts {
  private readonly dispatched = new Map<string, { threadId: string; interrupted: boolean }>();
  private readonly interruptedTurnIds: Set<string>;

  constructor(interruptedTurnIds: Set<string>) {
    this.interruptedTurnIds = interruptedTurnIds;
  }

  started(threadId: string, botId: string, epoch: number): void {
    this.dispatched.set(`${threadId}\0${botId}\0${epoch}`, { threadId, interrupted: false });
  }

  mark(threadId: string, botId: string, epoch: number): void {
    const dispatch = this.dispatched.get(`${threadId}\0${botId}\0${epoch}`);
    if (dispatch) dispatch.interrupted = true;
  }

  bind(threadId: string, botId: string, epoch: number, turnId?: string): void {
    const key = `${threadId}\0${botId}\0${epoch}`;
    const dispatch = this.dispatched.get(key);
    this.dispatched.delete(key);
    if (dispatch?.interrupted && turnId) this.interruptedTurnIds.add(turnId);
  }

  delete(threadId: string): void {
    for (const [key, dispatch] of this.dispatched) {
      if (dispatch.threadId === threadId) this.dispatched.delete(key);
    }
  }
}
