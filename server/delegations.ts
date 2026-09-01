// Async peer handoff (delegate_bot).
//
// A bot that finishes one task can hand the NEXT task to a peer without
// blocking its own turn — the source bot's turn.completed fires after it
// settles, and the queued delegation runs then. The peer gets a fresh
// depth-1 turn (depth cap still blocks A→B→C chains, see index.ts).
//
// Visiblity rides on the same comms-visibility helpers ask_bot uses
// (channel mirror + 1:1 chips) so a delegated exchange looks like an
// exchanged one. The optional approval gate (A2) is checked at drain
// time, never at queue time, because the user might have just turned
// approvePeerComms on between queueing and draining.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";

import { writeFileAtomic } from "./atomic.ts";
import { getOrCreateChannel, mirrorExchange, type CommsBus } from "./comms-visibility.ts";
import { DATA_DIR } from "./config.ts";
import { newId } from "./contracts.ts";
import { requestPeerApproval, type ApprovalBus } from "./peer-approval.ts";
import type { BotRecord, GroupRecord, Message } from "./store.ts";

export interface DelegationItem {
  toBotId: string;
  message: string;
  reason?: string;
  /** The source bot's comms depth (0 for a user-initiated turn). The
   * delegated-to bot runs at `depth + 1`, which equals MAX_COMMS_DEPTH
   * (= 1) for a user turn — so the peer has no agents integration, and
   * recursive delegation is structurally impossible. */
  depth: number;
}

interface PendingDelegationItem extends DelegationItem {
  /** The bot that queued this item. Required for shared room threads. */
  fromBotId?: string;
  /** Stable acknowledgement key for crash-safe removal from the queue —
   * and the task id the delegating bot uses with check/wait_delegation. */
  id: string;
  /** Busy-target retries so far. The item stays queued (not canceled) while
   * the target is busy, and is retried when any of the target's turns
   * settles — up to MAX_BUSY_ATTEMPTS. */
  attempts: number;
}

export type DelegationOutcome = "done" | "failed" | "denied" | "busy_gave_up" | "dropped" | "error";

/** The durable terminal record of one handoff: what the delegating bot reads
 * back with check_delegation / wait_delegation. Bounded and pruned — this is
 * a receipt drawer, not a transcript. */
export interface DelegationReceipt {
  id: string;
  sourceThreadId: string;
  toBotId: string;
  toBotName: string;
  status: DelegationOutcome;
  /** the peer's reply on success; the failure name otherwise (bounded) */
  result?: string;
  finishedAt: number;
}

export type QueueResult = "ok" | "no_target" | "self" | "too_deep" | "too_many";

interface PendingDelegationSnapshot {
  sourceThreadId: string;
  sourceBotId?: string;
  toBotId: string;
  reason?: string;
}

/** What queueDelegation hands back: the verdict, and on success the task id
 * the delegating bot can later read back with check/wait_delegation. */
export interface QueuedDelegation {
  result: QueueResult;
  id?: string;
}

/** Per source-thread queue. Persisted to delegations.json on every change
 * and reloaded at boot: a handoff queued right before a restart runs after
 * it. (Provider PERMISSIONS still die with the process — nobody can answer
 * for an unattended bot — but queued work is not a permission; the target
 * and approvePeerComms are re-checked at drain time as always.) */
const pendingDelegations = new Map<string, PendingDelegationItem[]>();
const drainingThreads = new Set<string>();
/** Threads whose drain was requested WHILE a drain was already running.
 * Dropping such a request loses real work: the waiting-on retry fires the
 * moment a busy target settles, and that can land mid-drain. */
const queuedRedrains = new Set<string>();
const DELEGATIONS_FILE = join(DATA_DIR, "delegations.json");
const RECEIPTS_FILE = join(DATA_DIR, "delegation-receipts.json");
const MAX_RECEIPTS = 100;
const RECEIPT_MAX_AGE_MS = 48 * 60 * 60 * 1000;
const RESULT_MAX_CHARS = 4_000;
const persistedFromBotId = z.string().min(1).optional().catch(undefined);
export const MAX_BUSY_ATTEMPTS = 3;

let receipts: DelegationReceipt[] = [];

function saveReceipts(): void {
  try {
    writeFileAtomic(RECEIPTS_FILE, JSON.stringify(receipts, null, 2), { mode: 0o600 });
  } catch (error) {
    console.error("delegations: could not persist receipts", error);
  }
}

/** Record one terminal outcome. Newest first; pruned by count and age so the
 * drawer can never grow without bound. */
export function recordDelegationReceipt(receipt: Omit<DelegationReceipt, "finishedAt"> & { finishedAt?: number }): void {
  const now = Date.now();
  const bounded: DelegationReceipt = {
    id: receipt.id,
    sourceThreadId: receipt.sourceThreadId,
    toBotId: receipt.toBotId,
    toBotName: receipt.toBotName,
    status: receipt.status,
    finishedAt: receipt.finishedAt ?? now,
  };
  if (receipt.result !== undefined) bounded.result = receipt.result.slice(0, RESULT_MAX_CHARS);
  receipts = [bounded, ...receipts.filter((existing) => existing.id !== bounded.id)]
    .filter((existing) => now - existing.finishedAt <= RECEIPT_MAX_AGE_MS)
    .slice(0, MAX_RECEIPTS);
  saveReceipts();
}

export function findDelegationReceipt(id: string): DelegationReceipt | null {
  return receipts.find((receipt) => receipt.id === id) ?? null;
}

/** A still-queued task's routing info, or null once it dispatched/settled. */
export function pendingDelegationInfo(id: string): { sourceThreadId: string; toBotId: string; attempts: number } | null {
  for (const [sourceThreadId, items] of pendingDelegations) {
    const item = items.find((candidate) => candidate.id === id);
    if (item) return { sourceThreadId, toBotId: item.toBotId, attempts: item.attempts };
  }
  return null;
}

/** Source threads holding a handoff that already waited on this busy bot at
 * least once — the set a target's settling turn re-drains. Fresh items
 * (attempts 0) are excluded: they run when their SOURCE turn settles, and
 * draining them early would start the peer before the delegator finished. */
export function threadsWaitingOn(toBotId: string): string[] {
  return [...pendingDelegations.entries()]
    .filter(([, items]) => items.some((item) => item.toBotId === toBotId && item.attempts > 0))
    .map(([threadId]) => threadId);
}

function savePending(): void {
  try {
    writeFileAtomic(DELEGATIONS_FILE, JSON.stringify(Object.fromEntries(pendingDelegations), null, 2), { mode: 0o600 });
  } catch (error) {
    console.error("delegations: could not persist queue", error);
  }
}

/** Load what a previous process left queued. Missing or corrupt → empty. */
export function _loadPending(): void {
  pendingDelegations.clear();
  try {
    const raw = JSON.parse(readFileSync(DELEGATIONS_FILE, "utf8")) as Record<string, unknown>;
    for (const [threadId, list] of Object.entries(raw)) {
      if (!Array.isArray(list)) continue;
      const items = list.flatMap((value): PendingDelegationItem[] => {
        if (!value || typeof value !== "object") return [];
        const item = value as Partial<PendingDelegationItem>;
        if (
          typeof item.toBotId !== "string" ||
          typeof item.message !== "string" ||
          !Number.isFinite(item.depth)
        ) return [];
        const loaded: PendingDelegationItem = {
          id: typeof item.id === "string" && item.id ? item.id : newId(),
          toBotId: item.toBotId,
          message: item.message,
          depth: Math.max(0, Math.trunc(item.depth!)),
          attempts: Number.isFinite(item.attempts) ? Math.max(0, Math.trunc(item.attempts!)) : 0,
        };
        const fromBotId = persistedFromBotId.parse(item.fromBotId);
        if (fromBotId) loaded.fromBotId = fromBotId;
        if (typeof item.reason === "string") loaded.reason = item.reason;
        return [loaded];
      });
      if (items.length) pendingDelegations.set(threadId, items);
    }
  } catch {
    /* fresh install, or unreadable — start empty */
  }
  receipts = [];
  try {
    const rawReceipts = JSON.parse(readFileSync(RECEIPTS_FILE, "utf8"));
    if (Array.isArray(rawReceipts)) {
      const now = Date.now();
      const loaded: DelegationReceipt[] = [];
      for (const value of rawReceipts) {
        if (!value || typeof value !== "object" || Array.isArray(value)) continue;
        // SAFETY: the Partial view only names candidate fields; every one is
        // narrowed below before a receipt is constructed from the narrowed
        // locals, so nothing unvalidated survives into `receipts`.
        const candidate = value as Partial<DelegationReceipt>;
        const { id, sourceThreadId, toBotId, toBotName, status, result, finishedAt } = candidate;
        if (typeof id !== "string" || !id) continue;
        if (typeof sourceThreadId !== "string" || typeof toBotId !== "string") continue;
        if (typeof toBotName !== "string" || typeof status !== "string") continue;
        if (!Number.isFinite(finishedAt) || now - finishedAt! > RECEIPT_MAX_AGE_MS) continue;
        const receipt: DelegationReceipt = { id, sourceThreadId, toBotId, toBotName, status, finishedAt: finishedAt! };
        if (typeof result === "string") receipt.result = result;
        loaded.push(receipt);
      }
      receipts = loaded.slice(0, MAX_RECEIPTS);
    }
  } catch {
    /* no receipts yet */
  }
}

/** Source threads with something queued — what a boot drain iterates. */
export function pendingThreads(): string[] {
  return [...pendingDelegations.keys()];
}

/** Read-only metadata for the local Team Map. Task prompts stay private;
 * the UI only needs to know who handed work to whom and the optional label. */
export function pendingDelegationSnapshot(): PendingDelegationSnapshot[] {
  return [...pendingDelegations.entries()].flatMap(([sourceThreadId, items]) =>
    items.map((item) => {
      const snapshot: PendingDelegationSnapshot = { sourceThreadId, toBotId: item.toBotId };
      if (item.fromBotId) snapshot.sourceBotId = item.fromBotId;
      if (item.reason) snapshot.reason = item.reason;
      return snapshot;
    }),
  );
}

/** How many handoffs one turn may queue. Small on purpose: this is the only
 * thing standing between a confused bot and a fan-out of real turns. */
const MAX_QUEUED_PER_THREAD = 4;

function appendDelegationActivity(
  bus: CommsBus,
  sourceThreadId: string,
  tool: NonNullable<Message["tool"]>,
  from?: BotRecord | null,
): void {
  const activity: Omit<Message, "id" | "at"> = { role: "bot", kind: "activity", tool };
  if (from && sourceThreadId !== from.threadId) {
    activity.from = { botId: from.id, name: from.name, color: from.color };
  }
  bus.store.appendMessage(sourceThreadId, activity);
}

/** Validate and enqueue a delegation. Pushes a "Delegated to @B: reason"
 * chip to the source thread so the user can see what was queued. */
export function queueDelegation(
  bus: CommsBus,
  from: BotRecord,
  item: DelegationItem,
  maxDepth: number,
  sourceThreadId = from.threadId,
): QueuedDelegation {
  if (item.toBotId === from.id) return { result: "self" };
  if (item.depth >= maxDepth) return { result: "too_deep" };
  const target = bus.store.bot(item.toBotId);
  if (!target) return { result: "no_target" };
  const list = pendingDelegations.get(sourceThreadId) ?? [];
  // Async handoff removes the backpressure that ask_bot got for free by
  // making the caller wait. Without a cap, one turn can queue unboundedly
  // and fan out into as many real turns on the next settle.
  if (list.length >= MAX_QUEUED_PER_THREAD) return { result: "too_many" };
  const id = newId();
  list.push({ ...item, id, fromBotId: from.id, attempts: 0 });
  pendingDelegations.set(sourceThreadId, list);
  savePending();
  const label = `Delegated to @${target.name}${item.reason ? `: ${item.reason}` : ""}`;
  appendDelegationActivity(bus, sourceThreadId, { name: label }, from);
  return { result: "ok", id };
}

/** Drain queued delegations for a source thread (called on its
 * turn.completed). Each item is processed independently: a deny, a busy
 * target, or an error in one does not stop the rest. The actual start
 * of the target turn is delegated to `runTarget` so delegations.ts
 * stays free of harness-level concerns (commsDepth is the only thing
 * the caller needs). */
export function drainDelegations(
  bus: CommsBus,
  approvalBus: ApprovalBus,
  threadId: string,
  runTarget: (
    toBotId: string,
    message: string,
    commsDepth: number,
    sourceThreadId: string,
    channel: GroupRecord | undefined,
    taskId: string,
    sourceBotId: string,
  ) => void | Promise<void>,
  sourceBotId?: string,
): void {
  if (drainingThreads.has(threadId)) {
    queuedRedrains.add(threadId);
    return;
  }
  const list = pendingDelegations.get(threadId);
  if (!list?.length) return;
  const privateSourceId = bus.store.botByThread(threadId)?.id;
  const itemSourceId = (item: PendingDelegationItem) => item.fromBotId ?? privateSourceId;
  const snapshot = sourceBotId
    ? list.filter((item) => itemSourceId(item) === sourceBotId)
    : [...list];
  if (!snapshot.length) return;
  drainingThreads.add(threadId);
  void (async () => {
    for (const item of snapshot) {
      let outcome: "settled" | "requeued" = "settled";
      let from: BotRecord | null = null;
      try {
        const fromId = itemSourceId(item);
        from = fromId ? bus.store.conversationForBot(fromId, threadId)?.bot ?? null : null;
        if (!from) throw new Error("source bot no longer belongs to this conversation");
        outcome = await processOne(bus, approvalBus, from, threadId, item, runTarget);
      } catch (error) {
        const why = error instanceof Error ? error.message : String(error);
        recordDelegationReceipt({
          id: item.id,
          sourceThreadId: threadId,
          toBotId: item.toBotId,
          toBotName: bus.store.bot(item.toBotId)?.name ?? item.toBotId,
          status: "error",
          result: why.slice(0, 200),
        });
        try {
          appendDelegationActivity(
            bus,
            threadId,
            { name: `error: delegation failed — ${why.slice(0, 120)}`, ok: false },
            from,
          );
        } catch (reportError) {
          console.error("delegation failed and could not be reported", reportError);
        }
      } finally {
        // A requeued item (busy target, retries left) stays for the drain
        // that the target's own settling turn will trigger.
        if (outcome !== "requeued") acknowledgeDelegation(threadId, item.id);
      }
    }
  })().finally(() => {
    drainingThreads.delete(threadId);
    // A later turn may have queued and settled while this thread was
    // waiting for approval. Only items OUTSIDE our snapshot warrant a fresh
    // drain — re-draining a just-requeued item would burn its bounded busy
    // retries in milliseconds instead of once per target settle.
    const redrainRequested = queuedRedrains.delete(threadId);
    const snapshotIds = new Set(snapshot.map((item) => item.id));
    const hasNewItems = pendingDelegations.get(threadId)?.some(
      (item) => (!sourceBotId || itemSourceId(item) === sourceBotId) && !snapshotIds.has(item.id),
    ) ?? false;
    if (redrainRequested || hasNewItems) {
      drainDelegations(bus, approvalBus, threadId, runTarget, sourceBotId);
    }
  });
}

/** Remove one terminal handoff only after approval/dispatch has settled. */
function acknowledgeDelegation(threadId: string, itemId: string): void {
  const current = pendingDelegations.get(threadId);
  if (!current) return;
  const remaining = current.filter((item) => item.id !== itemId);
  if (remaining.length) pendingDelegations.set(threadId, remaining);
  else pendingDelegations.delete(threadId);
  savePending();
}

/** Drop a thread's queued handoffs without running them, telling the user
 * they were dropped. Used when the queueing turn failed or was interrupted. */
export function discardDelegations(bus: CommsBus, threadId: string, sourceBotId?: string): void {
  const list = pendingDelegations.get(threadId);
  if (!list?.length) return;
  const privateSourceId = bus.store.botByThread(threadId)?.id;
  const dropped = sourceBotId
    ? list.filter((item) => (item.fromBotId ?? privateSourceId) === sourceBotId)
    : list;
  if (!dropped.length) return;
  const remaining = list.filter((item) => !dropped.includes(item));
  if (remaining.length) pendingDelegations.set(threadId, remaining);
  else pendingDelegations.delete(threadId);
  savePending();
  for (const item of dropped) {
    recordDelegationReceipt({
      id: item.id,
      sourceThreadId: threadId,
      toBotId: item.toBotId,
      toBotName: bus.store.bot(item.toBotId)?.name ?? item.toBotId,
      status: "dropped",
      result: "the delegating turn did not finish",
    });
  }
  // An unfiltered drop can span several room members; one status per source
  // keeps every dropped handoff attributable to the bot that queued it.
  const counts = new Map<string | undefined, number>();
  for (const item of dropped) {
    const fromId = item.fromBotId ?? privateSourceId;
    counts.set(fromId, (counts.get(fromId) ?? 0) + 1);
  }
  for (const [fromId, count] of counts) {
    const from = fromId ? bus.store.conversationForBot(fromId, threadId)?.bot : null;
    appendDelegationActivity(
      bus,
      threadId,
      { name: `${count} queued delegation${count > 1 ? "s" : ""} dropped — the turn did not finish`, ok: false },
      from,
    );
  }
}

async function processOne(
  bus: CommsBus,
  approvalBus: ApprovalBus,
  from: BotRecord,
  sourceThreadId: string,
  item: PendingDelegationItem,
  runTarget: (
    toBotId: string,
    message: string,
    commsDepth: number,
    sourceThreadId: string,
    channel: GroupRecord | undefined,
    taskId: string,
    sourceBotId: string,
  ) => void | Promise<void>,
): Promise<"settled" | "requeued"> {
  let sender = from;
  let target = bus.store.bot(item.toBotId);
  if (!target) {
    recordDelegationReceipt({
      id: item.id,
      sourceThreadId,
      toBotId: item.toBotId,
      toBotName: item.toBotId,
      status: "error",
      result: "no such bot",
    });
    appendDelegationActivity(
      bus,
      sourceThreadId,
      { name: `error: delegation to ${item.toBotId} failed — no such bot`, ok: false },
      sender,
    );
    return "settled";
  }
  if (target.busy) {
    item.attempts += 1;
    if (item.attempts < MAX_BUSY_ATTEMPTS) {
      savePending();
      appendDelegationActivity(
        bus,
        sourceThreadId,
        { name: `Delegation to @${target.name} waiting — they're busy (retry ${item.attempts}/${MAX_BUSY_ATTEMPTS} when they finish)` },
        sender,
      );
      return "requeued";
    }
    recordDelegationReceipt({
      id: item.id,
      sourceThreadId,
      toBotId: target.id,
      toBotName: target.name,
      status: "busy_gave_up",
      result: `@${target.name} stayed busy through ${MAX_BUSY_ATTEMPTS} retries`,
    });
    appendDelegationActivity(
      bus,
      sourceThreadId,
      { name: `Delegation to @${target.name} canceled — still busy after ${MAX_BUSY_ATTEMPTS} retries`, ok: false },
      sender,
    );
    return "settled";
  }
  if (sender.approvePeerComms) {
    const verdict = await requestPeerApproval(
      approvalBus,
      sender,
      target,
      item.message,
      "delegate_bot",
      sourceThreadId,
    );
    if (verdict !== "allow") {
      recordDelegationReceipt({
        id: item.id,
        sourceThreadId,
        toBotId: target.id,
        toBotName: target.name,
        status: "denied",
        result: "the user denied this handoff",
      });
      appendDelegationActivity(
        bus,
        sourceThreadId,
        { name: `Delegation to @${target.name} denied by user`, ok: false },
        sender,
      );
      return "settled";
    }
    // The approval could have been sitting for up to 15 minutes. Everything
    // checked above is a stale snapshot now: re-read both bots and re-check
    // busy, or an allow can start a second turn on a bot that is mid-turn —
    // and mirror a "Messaged @X" chip for an exchange that never happens.
    const current = bus.store.bot(item.toBotId);
    const currentSender = bus.store.conversationForBot(from.id, sourceThreadId)?.bot;
    if (!current || !currentSender) return "settled";
    if (current.busy) {
      item.attempts += 1;
      if (item.attempts < MAX_BUSY_ATTEMPTS) {
        savePending();
        appendDelegationActivity(
          bus,
          sourceThreadId,
          { name: `Delegation to @${current.name} waiting — they're busy (retry ${item.attempts}/${MAX_BUSY_ATTEMPTS} when they finish)` },
          currentSender,
        );
        return "requeued";
      }
      recordDelegationReceipt({
        id: item.id,
        sourceThreadId,
        toBotId: current.id,
        toBotName: current.name,
        status: "busy_gave_up",
        result: `@${current.name} stayed busy through ${MAX_BUSY_ATTEMPTS} retries`,
      });
      appendDelegationActivity(
        bus,
        sourceThreadId,
        { name: `Delegation to @${current.name} canceled — still busy after ${MAX_BUSY_ATTEMPTS} retries`, ok: false },
        currentSender,
      );
      return "settled";
    }
    sender = currentSender;
    target = current;
  }
  const channel = getOrCreateChannel(bus.store, sender, target);
  mirrorExchange(bus, sender, target, item.message, channel, sourceThreadId);
  const reasonLine = item.reason ? `\n\n[Reason: ${item.reason}]` : "";
  const prefixed = `[Delegated by @${sender.name}, another bot in this Orbit workspace. Do the work and reply directly.]\n\n${item.message}${reasonLine}`;
  await runTarget(item.toBotId, prefixed, item.depth + 1, sourceThreadId, channel, item.id, sender.id);
  return "settled";
}

/** Test helper: how many items remain queued for a thread. */
export function _pendingCount(threadId: string): number {
  return pendingDelegations.get(threadId)?.length ?? 0;
}

/** Test helper: forget the in-memory queue (a simulated restart). */
export function _resetPending(): void {
  pendingDelegations.clear();
  drainingThreads.clear();
  queuedRedrains.clear();
  receipts = [];
}
