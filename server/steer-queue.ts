// Waiting user sends stay off the active transcript until the bot is idle.
// Room waits keep live callbacks; their user lines are already in the transcript.
// Stop preserves user sends; stopping a group discards its room waits.

import { mkdirSync, readFileSync, renameSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";

import { writeFileAtomic } from "./atomic.ts";
import { DATA_DIR } from "./config.ts";
import { newId } from "./contracts.ts";
import { parseJson } from "./schema.ts";
import type { BotRecord, Message, Store } from "./store.ts";

/** The slice of Store this module needs — narrow so tests can fake it. */
export interface SteerStore {
  bot(id: string): BotRecord | null;
  appendMessage(threadId: string, message: Omit<Message, "id" | "at">): Message;
  patchMessage(threadId: string, messageId: string, patch: Partial<Message>): Message | null;
}

interface SteerItem {
  kind?: "steer";
  messageId: string;
  seq: number;
  text: string;
  prompt: string;
  replyToId?: string;
  sendId?: string;
  after?: boolean;
}

interface RoomItem {
  kind: "room";
  messageId: string;
  groupId: string;
  hop: number;
  cardContinuation?: string;
  onDispatchError?: (message: string) => void;
  instructionId?: string;
}

type QueueItem = SteerItem | RoomItem;

interface QueueEntry {
  /** Kept beside the threadId because the settle that frees the bot can
   * happen on a DIFFERENT thread (a room turn) — drain matches on "this
   * queue's bot is idle now", which needs the bot, not the settling thread. */
  botId: string;
  threadId: string;
  items: QueueItem[];
}

const queues = new Map<string, QueueEntry>(); // botId + threadId → waiting work
const cancelledSendIds = new Set<string>();
const runningSendIds = new Map<string, string>(); // botId → sendId
let queueSeq = 0;

/** Same shape as parseSendId — client sendIds are UUIDs, not a `send_` prefix. */
const SEND_ID_SHAPE = /^[A-Za-z0-9_-]{16,80}$/;

const QUEUE_FILE = join(DATA_DIR, "queued-sends.json");
const savedQueueSchema = z.array(z.object({
  botId: z.string(),
  threadId: z.string(),
  items: z.array(z.object({
    messageId: z.string(),
    seq: z.number().int().nonnegative(),
    text: z.string(),
    prompt: z.string(),
    replyToId: z.string().optional(),
    sendId: z.string().optional(),
    after: z.boolean().optional(),
  })),
}));

function saveQueuedSends(): void {
  const pending = [...queues.values()].flatMap((entry) => {
    const items = entry.items.filter((item) => !isRoomItem(item) && !isSendCancelled(item.sendId));
    return items.length ? [{ botId: entry.botId, threadId: entry.threadId, items }] : [];
  });
  mkdirSync(DATA_DIR, { recursive: true });
  writeFileAtomic(QUEUE_FILE, JSON.stringify(pending), { mode: 0o600 });
}

function saveQueueAfterAppend(): void {
  try {
    saveQueuedSends();
  } catch (error) {
    console.warn(`[queue] Could not save queue cleanup: ${error}`.replace(/\s+/g, " "));
  }
}

export function initializeSteerQueue(store: Pick<Store, "bot" | "taskByThread" | "messagesFor" | "onChange">): void {
  let pending: z.infer<typeof savedQueueSchema>;
  try {
    pending = savedQueueSchema.parse(parseJson(readFileSync(QUEUE_FILE, "utf8")));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      const badFile = join(DATA_DIR, `queued-sends.bad-${Date.now()}.json`);
      let recovery = `moved to ${badFile}`;
      try {
        renameSync(QUEUE_FILE, badFile);
      } catch (renameError) {
        recovery = `quarantine failed: ${renameError}`;
      }
      console.warn(`[queue] Could not load waiting sends; ${recovery}; starting empty: ${error}`.replace(/\s+/g, " "));
    }
    pending = [];
  }
  queues.clear();
  for (const entry of pending) {
    for (const item of entry.items) queueSeq = Math.max(queueSeq, item.seq);
    if (!store.bot(entry.botId) || !store.taskByThread(entry.botId, entry.threadId)) continue;
    const messages = store.messagesFor(entry.threadId);
    const items = entry.items.filter((item) => !messages.some((message) =>
      (item.sendId && message.sendId === item.sendId) || message.queueId === item.messageId));
    if (items.length) queues.set(entryKey(entry.botId, entry.threadId), { ...entry, items });
  }
  if (pending.length) saveQueuedSends();
  store.onChange((change) => {
    if (change.type !== "bot.deleted" && change.type !== "thread.deleted") return;
    let changed = false;
    for (const [key, entry] of queues) {
      if (change.type === "bot.deleted" ? entry.botId !== change.botId : entry.threadId !== change.threadId) continue;
      queues.delete(key);
      changed = true;
    }
    if (changed) saveQueuedSends();
  });
}

function rememberCancelledSend(id: string): void {
  if (!id) return;
  cancelledSendIds.add(id);
  // FIFO cap. A cancel older than 256 later ones can be forgotten and a
  // still-in-flight POST could start — more than one session ever queues.
  if (cancelledSendIds.size > 256) {
    const first = cancelledSendIds.values().next().value;
    if (first) cancelledSendIds.delete(first);
  }
}

function entryKey(botId: string, threadId: string): string {
  return `${botId}\n${threadId}`;
}

export interface QueuedSteer {
  id: string;
  skipped?: true;
  cancelled?: true;
}

export type CancelSteerResult =
  | { cancelled: true }
  | { cancelled: false; running: true }
  | { cancelled: false; running: false };

export function markSendCancelled(sendId: string): void {
  rememberCancelledSend(sendId);
  saveQueuedSends();
}

export function isSendCancelled(sendId: string | undefined): boolean {
  return Boolean(sendId && cancelledSendIds.has(sendId));
}

export function markSendRunning(botId: string, sendId: string | undefined): void {
  if (sendId) runningSendIds.set(botId, sendId);
}

export function clearSendRunning(botId: string): void {
  runningSendIds.delete(botId);
}

export function runningSendId(botId: string): string | undefined {
  return runningSendIds.get(botId);
}

export interface RoomDrain {
  groupId: string;
  hop: number;
  cardContinuation?: string;
  onDispatchError?: (message: string) => void;
  instructionId?: string;
}

export type DrainRun = (
  botId: string,
  threadId: string,
  prompt: string,
  userMessage: Message | null,
  excludeIds: string[],
  room?: RoomDrain,
) => void | Promise<void>;

/** True while startTurn holds a claim, the bot is already working, or its
 * driver has not yet released the thread of a turn that was stopped. */
export type HasActiveTurn = (botId: string) => boolean;

function entryFor(botId: string, threadId: string): QueueEntry {
  const key = entryKey(botId, threadId);
  const entry = queues.get(key) ?? { botId, threadId, items: [] };
  // A 1:1 thread cannot legitimately change owners. Refuse to merge
  // unrelated queues even if a corrupt caller reuses a thread id. Room
  // threads key per member, so two busy members never share an entry.
  if (entry.botId !== botId) throw new Error("queued task belongs to another bot");
  return entry;
}

/** Hold a mid-turn send off the transcript until drain. */
export function queueSteeredMessage(
  botId: string,
  threadId: string,
  text: string,
  options: { prompt?: string; replyToId?: string; sendId?: string; after?: boolean } = {},
): QueuedSteer {
  if (options.sendId && cancelledSendIds.has(options.sendId)) {
    return { id: options.sendId, skipped: true, cancelled: true };
  }
  const id = newId();
  const key = entryKey(botId, threadId);
  const previous = queues.get(key);
  const entry = entryFor(botId, threadId);
  const item: SteerItem = {
    messageId: id,
    seq: (queueSeq += 1),
    text,
    prompt: options.prompt ?? text,
    replyToId: options.replyToId,
    sendId: options.sendId,
    after: options.after,
  };
  queues.set(key, { ...entry, items: [...entry.items, item] });
  try {
    saveQueuedSends();
  } catch (error) {
    if (previous) queues.set(key, previous);
    else queues.delete(key);
    throw error;
  }
  return { id };
}

/** Hold a room member's turn until the bot is idle. Same member + thread
 * coalesces to one participation so two room lines while busy cannot
 * double-fire after settle. */
export function queueRoomParticipation(
  botId: string,
  threadId: string,
  options: {
    groupId: string;
    hop?: number;
    cardContinuation?: string;
    onDispatchError?: (message: string) => void;
    instructionId?: string;
  },
): QueuedSteer {
  const entry = entryFor(botId, threadId);
  const existing = entry.items.find((item): item is RoomItem => item.kind === "room");
  if (existing) {
    existing.hop = Math.min(existing.hop, options.hop ?? 0);
    if (!existing.cardContinuation && options.cardContinuation) {
      existing.cardContinuation = options.cardContinuation;
    }
    existing.onDispatchError ??= options.onDispatchError;
    existing.instructionId ??= options.instructionId;
    return { id: existing.messageId };
  }
  const id = newId();
  entry.items.push({
    kind: "room",
    messageId: id,
    groupId: options.groupId,
    hop: options.hop ?? 0,
    cardContinuation: options.cardContinuation,
    onDispatchError: options.onDispatchError,
    instructionId: options.instructionId,
  });
  queues.set(entryKey(botId, threadId), entry);
  return { id };
}

function isRoomItem(item: QueueItem): item is RoomItem {
  return item.kind === "room";
}

/** Drain every queue whose bot is idle: append the next held 1:1 line
 * (leaf is now the finished turn's last item), then one run for that
 * send. Remaining 1:1 lines stay queued for the next settle so multi-send
 * stays one turn each. Room items do not append — the user line is already
 * on the room thread. `userMessage` is the appended 1:1 line so startTurn
 * does not duplicate it; `excludeIds` is that drained line so
 * transcript-replay adapters do not also see it in the prompt. Entries
 * leave the map BEFORE running so a settle racing another settle can never
 * fire the same item twice. A bot with both a 1:1 wait and a room wait
 * yields one run per settle so the two cannot start together. */
export function drainSteeredMessages(
  store: SteerStore,
  run: DrainRun,
  hasActiveTurn?: HasActiveTurn,
): void {
  const draining = new Set<string>();
  // deleting only the entry being visited is safe under Map iteration
  for (const [key, entry] of queues) {
    const bot = store.bot(entry.botId);
    if (!bot) {
      // the bot was deleted while messages waited — nothing left to steer
      queues.delete(key);
      saveQueuedSends();
      continue;
    }
    // busy, or startTurn has claimed this bot but has not flipped busy yet
    if (bot.busy || hasActiveTurn?.(entry.botId) || draining.has(entry.botId)) continue;
    // committed to draining: the entry leaves the map before anything runs,
    // so a settle racing another settle can never fire the same queue twice
    queues.delete(key);
    draining.add(entry.botId);

    const steerItems = entry.items.filter((item): item is SteerItem => !isRoomItem(item) && !isSendCancelled(item.sendId));
    const roomItems = entry.items.filter(isRoomItem);
    if (steerItems.length) {
      const [item, ...rest] = steerItems;
      if (!item) continue;
      if (rest.length || roomItems.length) {
        // leftover 1:1 lines stay ahead of a same-entry room wait; production
        // keys 1:1 and room separately, so this mix is rare
        queues.set(key, { botId: entry.botId, threadId: entry.threadId, items: [...rest, ...roomItems] });
      }
      // queueId is the pending-chip identity from the 202; append still
      // assigns a fresh transcript id so replay/exclude keep using message.id.
      let appended: Message;
      try {
        appended = store.appendMessage(entry.threadId, {
          role: "user",
          kind: "text",
          text: item.text,
          replyToId: item.replyToId,
          sendId: item.sendId,
          queueId: item.messageId,
        });
      } catch (error) {
        queues.set(key, entry);
        throw error;
      }
      // Remove the receipt only after the transcript append is durable.
      saveQueueAfterAppend();
      void run(entry.botId, entry.threadId, item.prompt, appended, [appended.id]);
      continue;
    }

    saveQueuedSends();
    const room = roomItems[0];
    if (!room) continue;
    const roomDrain: RoomDrain = { groupId: room.groupId, hop: room.hop };
    if (room.cardContinuation) roomDrain.cardContinuation = room.cardContinuation;
    if (room.onDispatchError) roomDrain.onDispatchError = room.onDispatchError;
    if (room.instructionId) roomDrain.instructionId = room.instructionId;
    void run(entry.botId, entry.threadId, "", null, [], roomDrain);
  }
}

/** The latest enqueue so far; a turn reads it at its claim. */
export function queueMark(): number {
  return queueSeq;
}

export function hasQueuedSendBefore(botId: string, order: number): boolean {
  for (const entry of queues.values()) {
    if (entry.botId !== botId) continue;
    if (entry.items.some((item) => !isRoomItem(item) && item.seq <= order && !isSendCancelled(item.sendId))) return true;
  }
  return false;
}

/** Take post-claim steers for preparation; older and after-turn sends stay queued. */
export function takeQueuedSteers(
  botId: string,
  threadId: string,
  since: number,
): Array<{ id: string; text: string; prompt: string; replyToId?: string; sendId?: string }> {
  const key = entryKey(botId, threadId);
  const entry = queues.get(key);
  if (!entry || entry.botId !== botId) return [];
  const steerItems = entry.items.filter((item): item is SteerItem => !isRoomItem(item));
  if (!steerItems.length) return [];
  if (steerItems.some((item) => item.seq <= since && !isSendCancelled(item.sendId))) return [];
  const held = entry.items.filter((item) => isRoomItem(item) || (item.after && !isSendCancelled(item.sendId)));
  if (held.length) queues.set(key, { botId, threadId, items: held });
  else queues.delete(key);
  return steerItems
    .filter((item) => !item.after && !isSendCancelled(item.sendId))
    .map((item) => ({ id: item.messageId, text: item.text, prompt: item.prompt, replyToId: item.replyToId, sendId: item.sendId }));
}

/** Persist this thread's waiting sends as steered user lines and return
 * their prompts in send order, for the turn about to dispatch. */
export function foldQueuedSends(
  store: Pick<SteerStore, "appendMessage">,
  botId: string,
  threadId: string,
  since: number,
): string[] {
  const key = entryKey(botId, threadId);
  const entry = queues.get(key);
  const appended = new Set<string>();
  try {
    const prompts = takeQueuedSteers(botId, threadId, since).map((item) => {
      store.appendMessage(threadId, {
        role: "user",
        kind: "text",
        text: item.text,
        replyToId: item.replyToId,
        sendId: item.sendId,
        queueId: item.id,
        steered: true,
      });
      appended.add(item.id);
      return item.prompt;
    });
    if (entry) saveQueueAfterAppend();
    return prompts;
  } catch (error) {
    if (entry) {
      const items = entry.items.filter((item) => !appended.has(item.messageId));
      if (items.length) queues.set(key, { ...entry, items });
    }
    throw error;
  }
}

/** Find the receipt for a retry whose message is still waiting to drain. */
export function queuedSteeredMessage(
  botId: string,
  threadId: string,
  sendId: string,
): { id: string; text: string; replyToId?: string } | null {
  const entry = queues.get(entryKey(botId, threadId));
  if (!entry || entry.botId !== botId) return null;
  const item = entry.items.find((candidate): candidate is SteerItem => !isRoomItem(candidate) && candidate.sendId === sendId);
  return item ? { id: item.messageId, text: item.text, replyToId: item.replyToId } : null;
}

/** Whether any of this bot's sends or room turns still wait to drain. */
export function hasQueuedSends(botId: string): boolean {
  for (const entry of queues.values()) {
    if (entry.botId !== botId) continue;
    if (entry.items.some((item) => isRoomItem(item) || !isSendCancelled(item.sendId))) return true;
  }
  return false;
}

/** Drop one waiting send owned by this bot so it never drains. Matches the
 * queue message id or the client sendId. A sendId that is not queued yet is
 * remembered so a late POST cannot start it. Returns `running` when that
 * send already left the queue and is in startTurn. */
export function cancelSteeredMessage(botId: string, messageId: string): CancelSteerResult {
  if (runningSendIds.get(botId) === messageId) {
    return { cancelled: false, running: true };
  }
  for (const [key, entry] of queues) {
    if (entry.botId !== botId) continue;
    const items = entry.items.filter(
      (item) => item.messageId !== messageId && (isRoomItem(item) || item.sendId !== messageId),
    );
    if (items.length === entry.items.length) continue;
    const removed = entry.items.find(
      (item) => item.messageId === messageId || (!isRoomItem(item) && item.sendId === messageId),
    );
    if (removed && !isRoomItem(removed) && removed.sendId) rememberCancelledSend(removed.sendId);
    rememberCancelledSend(messageId);
    if (items.length === 0) queues.delete(key);
    else queues.set(key, { botId: entry.botId, threadId: entry.threadId, items });
    saveQueuedSends();
    return { cancelled: true };
  }
  for (const entry of queues.values()) {
    if (entry.botId === botId) continue;
    if (entry.items.some((item) => item.messageId === messageId || (!isRoomItem(item) && item.sendId === messageId))) {
      return { cancelled: false, running: false };
    }
  }
  if (SEND_ID_SHAPE.test(messageId)) {
    rememberCancelledSend(messageId);
    return { cancelled: true };
  }
  return { cancelled: false, running: false };
}

/** Drop room participations for one stopped group task. */
export function cancelQueuedRoomParticipations(groupId: string, threadId: string): number {
  let cancelled = 0;
  for (const [key, entry] of queues) {
    const items = entry.items.filter((item) => {
      const remove = isRoomItem(item) && item.groupId === groupId && entry.threadId === threadId;
      if (remove) cancelled += 1;
      return !remove;
    });
    if (items.length === entry.items.length) continue;
    if (items.length === 0) queues.delete(key);
    else queues.set(key, { botId: entry.botId, threadId: entry.threadId, items });
  }
  return cancelled;
}

/** Test helper: drop in-memory queues and cancel/running bookkeeping. */
export function _resetSteerQueue(): void {
  queues.clear();
  cancelledSendIds.clear();
  runningSendIds.clear();
}

/** After a drained start fails, try the next queued send only if this
 * bot is still idle. A busy bot — or one whose startTurn claim is still
 * held — waits for turn.completed. Provider rejection re-drains on
 * purpose: that item is already off the queue, so walking the rest
 * writes an error chip per line instead of stalling later user words. */
export function continueQueuedDrainIfIdle(
  store: Pick<SteerStore, "bot">,
  botId: string,
  drain: () => void,
  hasActiveTurn?: HasActiveTurn,
): void {
  if (store.bot(botId)?.busy || hasActiveTurn?.(botId)) return;
  drain();
}

/** Test helper: how many messages remain queued for a thread. */
export function _queuedCount(threadId: string): number {
  let count = 0;
  for (const entry of queues.values()) {
    if (entry.threadId === threadId) count += entry.items.length;
  }
  return count;
}
