// Queue-and-steer for busy 1:1 bots, and queue-and-speak for busy room members.
//
// A message sent to a bot mid-turn used to bounce with a 409. Now it waits
// here until the bot settles, then lands in the thread and runs as its own
// follow-up turn. Several short sends stay separate queued turns — joining
// them into one prompt made forever-chat feel like a coalesced task dump.
//
// A room member who is busy elsewhere used to get a permanent "skipped this
// round" activity line. Their participation now waits here and runs as ONE
// room turn once they are idle. The user's room line is already on the
// thread — drain must not append another, or in-flight tool events of the
// other conversation can hang off the wrong leaf.
//
// The queue is memory-only and is NOT in `messages[]` while the current
// turn is running: appending immediately would make the queued line the
// active leaf, so remaining tool/assistant events of *this* turn would
// hang off a user line the model has not seen. Restart loses the queue
// (same as delegations / approvals). The composer shows a pending chip
// until drain appends 1:1 words; a queued room member just speaks later.
//
// Unlike the delegation drain, an interrupted or failed turn does NOT
// discard this queue: delegations are a bot's fan-out (dropping them on
// Stop is a safety property), but these are the user's own words —
// stop-then-steer (queue a correction, hit Stop, the correction runs) is
// the feature.

import { newId } from "./contracts.ts";
import type { BotRecord, Message } from "./store.ts";

/** The slice of Store this module needs — narrow so tests can fake it. */
export interface SteerStore {
  bot(id: string): BotRecord | null;
  appendMessage(threadId: string, message: Omit<Message, "id" | "at">): Message;
  patchMessage(threadId: string, messageId: string, patch: Partial<Message>): Message | null;
}

interface SteerItem {
  kind?: "steer";
  messageId: string;
  text: string;
  prompt: string;
  replyToId?: string;
  sendId?: string;
}

interface RoomItem {
  kind: "room";
  messageId: string;
  groupId: string;
  hop: number;
  cardContinuation?: string;
  onDispatchError?: (message: string) => void;
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

/** Same shape as parseSendId — client sendIds are UUIDs, not a `send_` prefix. */
const SEND_ID_SHAPE = /^[A-Za-z0-9_-]{16,80}$/;

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
}

export type DrainRun = (
  botId: string,
  threadId: string,
  prompt: string,
  userMessage: Message | null,
  excludeIds: string[],
  room?: RoomDrain,
) => void | Promise<void>;

/** True while startTurn holds a claim or the bot is already working. */
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
  options: { prompt?: string; replyToId?: string; sendId?: string } = {},
): QueuedSteer {
  if (options.sendId && cancelledSendIds.has(options.sendId)) {
    return { id: options.sendId, skipped: true, cancelled: true };
  }
  const id = newId();
  const entry = entryFor(botId, threadId);
  entry.items.push({
    messageId: id,
    text,
    prompt: options.prompt ?? text,
    replyToId: options.replyToId,
    sendId: options.sendId,
  });
  queues.set(entryKey(botId, threadId), entry);
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
      const appended = store.appendMessage(entry.threadId, {
        role: "user",
        kind: "text",
        text: item.text,
        replyToId: item.replyToId,
        sendId: item.sendId,
        queueId: item.messageId,
      });
      void run(entry.botId, entry.threadId, item.prompt, appended, [appended.id]);
      continue;
    }

    const room = roomItems[0];
    if (!room) continue;
    const roomDrain: RoomDrain = { groupId: room.groupId, hop: room.hop };
    if (room.cardContinuation) roomDrain.cardContinuation = room.cardContinuation;
    if (room.onDispatchError) roomDrain.onDispatchError = room.onDispatchError;
    void run(entry.botId, entry.threadId, "", null, [], roomDrain);
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
