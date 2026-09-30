// Bot⇄bot comms visibility: channel creation, message mirroring, and
// per-thread chips. Extracted from /api/internal/ask-bot so delegations
// (delegate_bot) and any future peer flow reuse the same UX without a copy.

import { type BotRecord, type GroupRecord, type Message, type Store } from "./store.ts";

/** What a peer-exchange helper needs from the outside world:
 * the store (for persisted messages + groups) and the SSE broadcasters
 * so chat clients see the change without waiting for a refresh. */
export interface CommsBus {
  store: Store;
  /** SSE broadcast (kind: "message" envelope). */
  broadcast: (payload: Record<string, unknown>) => void;
  /** SSE broadcast (kind: "group" envelope) for a single group. */
}

/** Find or create the bot⇄bot channel for the pair. The channel keeps
 * the pair's full exchange, lives in the sidebar like any room, and the
 * user can open it to chip in.
 *
 * Only a NEW channel takes the sender's section. An existing one is a room
 * the user may have renamed and filed themselves, and re-filing it on the
 * next ask_bot moves a room out from under them without asking. */
export function getOrCreateChannel(store: Store, from: BotRecord, target: BotRecord): GroupRecord {
  const existing = store.dmGroup(from.id, target.id);
  if (existing) return existing;
  return store.createGroup(`${from.name} ⇄ ${target.name}`, [from.id, target.id], true, from.section);
}

type CommLink = NonNullable<Message["comm"]>;

/** The chip link to a pair channel, as seen from `peer`'s side. */
export function commLink(channel: GroupRecord | undefined, peer: BotRecord): CommLink | undefined {
  return channel
    ? { groupId: channel.id, withBotId: peer.id, withName: peer.name, withColor: peer.color }
    : undefined;
}

/** The one chip per queued handoff in the sender's thread, keyed by handoff id.
 * Memory only: a restart drops the queue, so nothing outlives its chip. */
const delegationChips = new Map<string, { threadId: string; messageId: string }>();

export function trackDelegationChip(itemId: string, threadId: string, messageId: string): void {
  delegationChips.set(itemId, { threadId, messageId });
}

/** Rewrite a handoff's chip in place; false when it has none. A set `ok` is a
 * terminal state, so it also retires the chip. */
export function patchDelegationChip(
  bus: CommsBus,
  itemId: string | undefined,
  tool: NonNullable<Message["tool"]>,
  comm?: CommLink,
): boolean {
  const chip = itemId ? delegationChips.get(itemId) : undefined;
  if (!itemId || !chip) return false;
  const patch: Partial<Message> = { tool };
  if (comm) patch.comm = comm;
  if (!bus.store.patchMessage(chip.threadId, chip.messageId, patch)) return false;
  if (tool.ok !== undefined) delegationChips.delete(itemId);
  return true;
}

/** Mirror `from`'s outgoing message into the channel, drop chips into
 * both 1:1 threads linking to the channel, and bump the channel's unread
 * count. The chips are what make bot-to-bot turns observable — those
 * turns cost the user tokens, and a hidden exchange is exactly the kind
 * of mistake peer coordination is supposed to avoid. */
export function mirrorExchange(
  bus: CommsBus,
  from: BotRecord,
  target: BotRecord,
  message: string,
  channel: GroupRecord | undefined,
  sourceThreadId = from.threadId,
  sourceChip = true,
): void {
  const note = (threadId: string, m: Omit<Message, "id" | "at">) => {
    bus.store.appendMessage(threadId, m);
    return message;
  };
  if (channel) {
    note(channel.threadId, {
      role: "bot",
      kind: "text",
      text: message,
      from: { botId: from.id, name: from.name, color: from.color },
    });
  }
  const sourceActivity: Omit<Message, "id" | "at"> = {
    role: "bot",
    kind: "activity",
    tool: { name: `Messaged @${target.name}` },
    comm: channel
      ? { groupId: channel.id, withBotId: target.id, withName: target.name, withColor: target.color }
      : undefined,
  };
  if (sourceThreadId !== from.threadId) {
    sourceActivity.from = { botId: from.id, name: from.name, color: from.color };
  }
  if (sourceChip) note(sourceThreadId, sourceActivity);
  note(target.threadId, {
    role: "bot",
    kind: "activity",
    tool: { name: `Message from @${from.name}` },
    comm: channel
      ? { groupId: channel.id, withBotId: from.id, withName: from.name, withColor: from.color }
      : undefined,
  });
  if (channel) {
    bus.store.patchGroup(channel.id, { unread: true });
  }
}

/** Close a handoff's loop in the sender's thread: patch its chip in place, or
 * fall back to the room row when the chip is gone. Either way one row, never two.
 * False means the sender's thread got nothing (a 1:1 whose chip is gone). */
export function settleDelegationChip(
  bus: CommsBus,
  target: BotRecord,
  sourceThreadId: string,
  channel: GroupRecord | undefined,
  itemId: string | undefined,
  name: string,
  ok: boolean,
): boolean {
  if (!patchDelegationChip(bus, itemId, { name, ok }, commLink(channel, target))) {
    return mirrorOutcomeToRoom(bus, target, sourceThreadId, channel, name, ok);
  }
  const room = bus.store.groupByThread(sourceThreadId);
  if (room) bus.store.patchGroup(room.id, { unread: true });
  return true;
}

/** Mirror `target`'s reply into the channel so the channel stays the
 * single authoritative record of the exchange. The 1:1 threads already
 * carry their own chips from `mirrorExchange`. */
export function mirrorReply(
  bus: CommsBus,
  target: BotRecord,
  reply: string,
  channel: GroupRecord | undefined,
): void {
  if (!channel || !reply.trim()) return;
  bus.store.appendMessage(channel.threadId, {
    role: "bot",
    kind: "text",
    text: reply,
    from: { botId: target.id, name: target.name, color: target.color },
  });
  bus.store.patchGroup(channel.id, { unread: true });
}

/** Close a handoff's loop where it was ASKED for. A delegation queued from a
 * room runs in the target's own 1:1 and mirrors into the pair channel, so the
 * room is left holding a "Delegated to @X" chip and never learns how it ended.
 * A 1:1 source already carries that chip, and the pair channel gets the
 * mirror itself — neither takes a second copy. */
export function mirrorOutcomeToRoom(
  bus: CommsBus,
  target: BotRecord,
  sourceThreadId: string,
  channel: GroupRecord | undefined,
  name: string,
  ok: boolean,
): boolean {
  const room = bus.store.groupByThread(sourceThreadId);
  if (!room) return false;
  // the channel gets its own mirror, so that row is the sender's too
  if (room.id === channel?.id) return true;
  bus.store.appendMessage(sourceThreadId, {
    role: "bot",
    kind: "activity",
    tool: { name, ok },
    from: { botId: target.id, name: target.name, color: target.color },
    comm: channel
      ? { groupId: channel.id, withBotId: target.id, withName: target.name, withColor: target.color }
      : undefined,
  });
  // appendMessage does not touch the flag the sidebar's room dot reads, so
  // without this the outcome is invisible to anyone reading another thread.
  bus.store.patchGroup(room.id, { unread: true });
  return true;
}

/** Mirror a terminal activity note into the channel — for async handoffs
 * whose terminal state is not a reply (turn failed, was stopped, or never
 * started). Prior art (A2A, MCP Tasks) is unanimous that every terminal
 * state of an async handoff should be visible where the human is looking,
 * and the channel is that place. */
export function mirrorActivity(
  bus: CommsBus,
  from: BotRecord,
  channel: GroupRecord | undefined,
  name: string,
  ok: boolean,
): void {
  if (!channel) return;
  bus.store.appendMessage(channel.threadId, {
    role: "bot",
    kind: "activity",
    tool: { name, ok },
    from: { botId: from.id, name: from.name, color: from.color },
  });
  bus.store.patchGroup(channel.id, { unread: true });
}
