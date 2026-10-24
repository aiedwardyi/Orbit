import { unlinkSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { join } from "node:path";
import { z } from "zod";

import { askUserCardPatchSchema } from "./ask-user.ts";
import { validateBotCwd } from "./bot-cwd.ts";
import { EVENTS_DIR, NATIVE_DIR } from "./config.ts";
import type { ProviderRegistry } from "./harness/registry.ts";
import { json, readBody } from "./http-helpers.ts";
import { canChangeRoomCwd, repinRoomCwd } from "./room-cwd.ts";
import { acceptedSendMatch, parseSendId, sendFingerprint, type SendSequencer } from "./send-idempotency.ts";
import { cancelQueuedRoomParticipations } from "./steer-queue.ts";
import type { GroupDefaultResponder, GroupRecord, Message, Store } from "./store.ts";
import type { RecoveryFlushReason, TaskResumeScheduler } from "./task-recovery-flush.ts";

type GroupRouteDeps = {
  store: Store;
  registry: ProviderRegistry;
  createGroupTaskRequestSchema: z.ZodType<{ title?: string }>;
  checkedMemberIds: (value: unknown) => { ok: true; memberIds: string[] } | { ok: false; error: string };
  checkedGroupResponder: (value: unknown, memberIds: string[]) => GroupDefaultResponder | null;
  publicGroupState: (group: GroupRecord) => Record<string, unknown>;
  groupIsWorking: (group: GroupRecord) => boolean;
  groupWithThread: (group: GroupRecord) => Record<string, unknown>;
  broadcast: (payload: Record<string, unknown>) => void;
  lastReply: Map<string, { text: string; messageId: string }>;
  sendSequencer: SendSequencer;
  resolveReplyTarget: (threadId: string, value: unknown) => Message | undefined;
  startGroupTurn: (groupId: string, text: string, replyTo?: Message, sendId?: string) => Message;
  cancelGroupTurnOperations: (groupId: string, threadId: string) => void;
  taskResumes: TaskResumeScheduler;
  bumpTurnEpoch: (botId: string) => number;
  markThreadInterrupted: (threadId: string, botId: string, epoch: number) => void;
  flushInterruptedTask: (threadId: string, botId: string, reason: RecoveryFlushReason) => void;
  closeOpenApprovals: (threadId: string) => void;
  releaseInterruptedBot: (botId: string, threadId: string) => void;
};

export function createGroupRoutes(deps: GroupRouteDeps) {
  const {
    store,
    registry,
    createGroupTaskRequestSchema,
    checkedMemberIds,
    checkedGroupResponder,
    publicGroupState,
    groupIsWorking,
    groupWithThread,
    broadcast,
    lastReply,
    sendSequencer,
    resolveReplyTarget,
    startGroupTurn,
    cancelGroupTurnOperations,
    taskResumes,
    bumpTurnEpoch,
    markThreadInterrupted,
    flushInterruptedTask,
    closeOpenApprovals,
    releaseInterruptedBot,
  } = deps;
  const channelTaskBlocked = (group: GroupRecord) =>
    groupIsWorking(group) ||
    store.groupTasks(group.id).some((task) =>
      store.messagesFor(task.threadId).some(
        (message) =>
          message.kind === "options" &&
          message.card?.requestId &&
          !message.card.answered &&
          !message.card.dismissed,
      ),
    );
  return {
    order: async (req: IncomingMessage, res: ServerResponse) => {
      const parsed = z.object({ groupIds: z.array(z.string()) }).safeParse(await readBody(req));
      if (!parsed.success || !store.reorderGroups(parsed.data.groupIds)) {
        return json(res, 400, { error: "groupIds must list every group exactly once" });
      }
      return json(res, 200, { groupIds: parsed.data.groupIds });
    },
    create: async (req: IncomingMessage, res: ServerResponse) => {
      const body = await readBody(req);
      if (!body || typeof body !== "object" || Array.isArray(body)) {
        return json(res, 400, { error: "channel must be a JSON object" });
      }
      const roster = checkedMemberIds(body.memberIds);
      if (!roster.ok) return json(res, 400, { error: roster.error });
      const { memberIds } = roster;
      if (body.name !== undefined && typeof body.name !== "string") {
        return json(res, 400, { error: "channel name must be a string" });
      }
      const name = body.name?.trim() || `${store.bot(memberIds[0])!.name} & co.`;
      if (name.length > 100) return json(res, 400, { error: "channel name must be at most 100 characters" });
      let section: string | undefined;
      if (body.section !== undefined && body.section !== null) {
        if (typeof body.section !== "string") return json(res, 400, { error: "context must be a string" });
        section = body.section.trim() || undefined;
        if (section && section.length > 60) {
          return json(res, 400, { error: "context must be at most 60 characters" });
        }
      }
      let setup:
        | { bulletin: string; defaultResponder: GroupDefaultResponder; completed: true }
        | undefined;
      if (body.setup !== undefined) {
        if (!body.setup || typeof body.setup !== "object" || Array.isArray(body.setup)) {
          return json(res, 400, { error: "setup must be an object" });
        }
        const requested = body.setup as { bulletin?: unknown; defaultResponder?: unknown };
        if (typeof requested.bulletin !== "string") {
          return json(res, 400, { error: "setup.bulletin must be a string" });
        }
        if (requested.bulletin.length > 12_000) {
          return json(res, 400, { error: "setup.bulletin must be at most 12000 characters" });
        }
        const responder = checkedGroupResponder(requested.defaultResponder, memberIds);
        if (!responder) return json(res, 400, { error: "invalid setup.defaultResponder" });
        setup = { bulletin: requested.bulletin, defaultResponder: responder, completed: true };
      }
      const group = store.createGroup(name, memberIds, false, section, setup);
      return json(res, 201, { group: { ...publicGroupState(group), messages: [] } });
    },
    setup: async (req: IncomingMessage, res: ServerResponse, m: RegExpMatchArray) => {
      const group = store.group(m[1]);
      if (!group) return json(res, 404, { error: "no such room" });
      if (group.dm) return json(res, 400, { error: "direct-message channels do not have room setup" });
      const body = await readBody(req);
      if (body.action !== "complete" && body.action !== "skip") {
        return json(res, 400, { error: "action must be complete or skip" });
      }
      if (group.setupCompletedAt != null || group.setupSkippedAt != null) {
        return json(res, 200, { group: publicGroupState(group) });
      }
      if (store.messagesFor(group.threadId).length > 0) {
        return json(res, 409, { error: "room setup must be finished before the first message" });
      }

      const patch: Partial<Pick<GroupRecord, "cwd" | "defaultResponder" | "bulletin" | "setupCompletedAt" | "setupSkippedAt">> = {};
      if (body.action === "complete") {
        const checked = validateBotCwd(body.cwd ?? null);
        if (!checked.ok) return json(res, 400, { error: checked.error });
        if (typeof body.bulletin !== "string") return json(res, 400, { error: "bulletin must be a string" });
        if (body.bulletin.length > 12_000) return json(res, 400, { error: "bulletin must be at most 12000 characters" });
        const value = body.defaultResponder as { kind?: unknown; botId?: unknown } | null;
        let responder: GroupDefaultResponder | null = null;
        if (value?.kind === "everyone") responder = { kind: "everyone" };
        else if (value?.kind === "mentions") responder = { kind: "mentions" };
        else if (value?.kind === "member" && typeof value.botId === "string" && group.memberIds.includes(value.botId)) {
          responder = { kind: "member", botId: value.botId };
        }
        if (!responder) return json(res, 400, { error: "invalid default responder" });
        patch.cwd = checked.cwd ?? undefined;
        patch.defaultResponder = responder;
        patch.bulletin = body.bulletin;
        patch.setupCompletedAt = Date.now();
      } else {
        patch.setupSkippedAt = Date.now();
      }
      const updated = store.patchGroup(m[1], patch);
      if (!updated) return json(res, 404, { error: "no such room" });
      return json(res, 200, { group: publicGroupState(updated) });
    },
    createTask: async (req: IncomingMessage, res: ServerResponse, m: RegExpMatchArray) => {
      const group = store.group(m[1]);
      if (!group) return json(res, 404, { error: "no such channel" });
      if (group.dm) return json(res, 400, { error: "bot-to-bot channels keep one canonical conversation" });
      if (channelTaskBlocked(group)) {
        return json(res, 409, { error: "this channel is working or waiting on you - finish that turn first" });
      }
      const body = await readBody(req);
      if (!body || typeof body !== "object" || Array.isArray(body)) {
        return json(res, 400, { error: "body must be a JSON object" });
      }
      const request = createGroupTaskRequestSchema.safeParse(body);
      if (!request.success) return json(res, 400, { error: "title must be text" });
      const task = store.createGroupTask(group.id, request.data.title);
      if (!task) return json(res, 500, { error: "couldn't create that task" });
      const fresh = groupWithThread(store.group(group.id)!);
      broadcast({ kind: "group", group: fresh });
      return json(res, 201, { group: fresh, task });
    },
    switchTask: async (res: ServerResponse, m: RegExpMatchArray, url: URL) => {
      const group = store.group(m[1]);
      if (!group) return json(res, 404, { error: "no such channel" });
      if (group.dm) return json(res, 400, { error: "bot-to-bot channels keep one canonical conversation" });
      if (channelTaskBlocked(group)) {
        return json(res, 409, { error: "this channel is working or waiting on you - finish that turn first" });
      }
      const switched = store.switchGroupTask(group.id, m[2]);
      if (!switched) return json(res, 404, { error: "no such channel task" });
      const fresh = groupWithThread(switched);
      broadcast({ kind: "group", group: fresh });
      const responseGroup = url.searchParams.get("messages") === "0"
        ? publicGroupState(switched)
        : fresh;
      return json(res, 200, { group: responseGroup });
    },
    patchTask: async (req: IncomingMessage, res: ServerResponse, m: RegExpMatchArray) => {
      const group = store.group(m[1]);
      if (!group) return json(res, 404, { error: "no such channel" });
      if (group.dm) return json(res, 400, { error: "bot-to-bot channels keep one canonical conversation" });
      if (channelTaskBlocked(group)) {
        return json(res, 409, { error: "this channel is working or waiting on you - finish that turn first" });
      }
      const body = await readBody(req);
      if (!body || typeof body !== "object" || Array.isArray(body)) {
        return json(res, 400, { error: "body must be a JSON object" });
      }
      const task = store.renameGroupTask(m[1], m[2], String(body.title ?? ""));
      if (!task) return json(res, 404, { error: "no such channel task" });
      return json(res, 200, { task });
    },
    deleteTask: async (res: ServerResponse, m: RegExpMatchArray) => {
      const group = store.group(m[1]);
      if (!group) return json(res, 404, { error: "no such channel" });
      if (group.dm) return json(res, 400, { error: "bot-to-bot channels keep one canonical conversation" });
      if (channelTaskBlocked(group)) {
        return json(res, 409, { error: "this channel is working or waiting on you - finish that turn first" });
      }
      if (!store.groupTaskByThread(group.id, m[2])) return json(res, 404, { error: "no such channel task" });
      lastReply.delete(m[2]);
      const updated = store.deleteGroupTask(group.id, m[2]);
      if (!updated) return json(res, 400, { error: "a channel keeps at least one task" });
      const fresh = groupWithThread(updated);
      broadcast({ kind: "group", group: fresh });
      return json(res, 200, { group: fresh });
    },
    patch: async (req: IncomingMessage, res: ServerResponse, m: RegExpMatchArray) => {
      const body = await readBody(req);
      if (!body || typeof body !== "object" || Array.isArray(body)) {
        return json(res, 400, { error: "body must be a JSON object" });
      }
      const existing = store.group(m[1]);
      if (!existing) return json(res, 404, { error: "no such room" });
      if (
        channelTaskBlocked(existing) &&
        (body.memberIds !== undefined || body.defaultResponder !== undefined || body.bulletin !== undefined)
      ) {
        return json(res, 409, { error: "this channel is working or waiting on you - finish that turn first" });
      }
      const patch: Record<string, unknown> = {};
      if (body.name !== undefined) {
        if (typeof body.name !== "string") return json(res, 400, { error: "room name must be a string" });
        const name = body.name.trim();
        if (!name) return json(res, 400, { error: "room name must not be empty" });
        if (name.length > 100) return json(res, 400, { error: "room name must be at most 100 characters" });
        patch.name = name;
      }
      if (body.bulletin !== undefined) {
        if (typeof body.bulletin !== "string") return json(res, 400, { error: "bulletin must be a string" });
        if (body.bulletin.length > 12_000) {
          return json(res, 400, { error: "bulletin must be at most 12000 characters" });
        }
        patch.bulletin = body.bulletin;
      }
      if (body.unread !== undefined) {
        if (typeof body.unread !== "boolean") return json(res, 400, { error: "unread must be true or false" });
        patch.unread = body.unread;
      }
      if (body.memberIds !== undefined) {
        // A DM is the pair it was opened for; only real rooms have a roster.
        if (existing.dm) return json(res, 400, { error: "direct-message channels cannot change members" });
        const roster = checkedMemberIds(body.memberIds);
        if (!roster.ok) return json(res, 400, { error: roster.error.replace("channel", "room") });
        patch.memberIds = roster.memberIds;
      }
      if (body.defaultResponder !== undefined) {
        const memberIds = (patch.memberIds as string[] | undefined) ?? existing.memberIds;
        const responder = checkedGroupResponder(body.defaultResponder, memberIds);
        if (!responder) return json(res, 400, { error: "invalid default responder" });
        patch.defaultResponder = responder;
      }
      if (body.cwd !== undefined) {
        if (existing.dm) return json(res, 400, { error: "direct-message channels cannot have a working folder" });
        if (!canChangeRoomCwd(existing.pinnedCwd)) {
          return json(res, 409, { error: "the room's working folder is fixed after its first turn" });
        }
        const checked = validateBotCwd(body.cwd);
        if (!checked.ok) return json(res, 400, { error: checked.error });
        patch.cwd = checked.cwd ?? undefined;
      }
      // one pinned message per room; null/"" clears. The id is not
      // validated against the transcript here - a pin whose message was
      // edited away or deleted simply resolves to nothing in the UI.
      if (body.pinnedMessageId !== undefined) {
        if (body.pinnedMessageId === null || body.pinnedMessageId === "") patch.pinnedMessageId = undefined;
        else if (typeof body.pinnedMessageId === "string" && /^[\w-]+$/.test(body.pinnedMessageId)) {
          patch.pinnedMessageId = body.pinnedMessageId;
        } else return json(res, 400, { error: "pinnedMessageId must be a message id" });
      }
      // same contract as a bot's sidebar section: null/"" clears, 60 chars max
      if (body.section !== undefined) {
        if (body.section === null) patch.section = undefined;
        else if (typeof body.section !== "string") return json(res, 400, { error: "section must be a string" });
        else {
          const trimmed = body.section.trim();
          if (!trimmed) patch.section = undefined;
          else if (trimmed.length > 60) return json(res, 400, { error: "section must be at most 60 characters" });
          else patch.section = trimmed;
        }
      }
      if (body.cwd !== undefined) repinRoomCwd(store, existing, patch.cwd as string | undefined);
      const group = store.patchGroup(m[1], patch);
      if (!group) return json(res, 404, { error: "no such room" });
      return json(res, 200, { group: publicGroupState(group) });
    },
    read: async (res: ServerResponse, m: RegExpMatchArray) => {
      const group = store.patchGroup(m[1], { unread: false });
      if (!group) return json(res, 404, { error: "no such room" });
      broadcast({ kind: "group", group: publicGroupState(group) });
      return json(res, 200, { group: publicGroupState(group) });
    },
    remove: async (res: ServerResponse, m: RegExpMatchArray) => {
      const group = store.group(m[1]);
      if (!group) return json(res, 404, { error: "no such room" });
      if (groupIsWorking(group)) {
        return json(res, 409, { error: "this channel is working - stop that turn first" });
      }
      const threadIds = new Set([group.threadId, ...(group.tasks ?? []).map((task) => task.threadId)]);
      for (const threadId of threadIds) lastReply.delete(threadId);
      store.deleteGroup(group.id);
      for (const threadId of threadIds) {
        for (const dir of [EVENTS_DIR, NATIVE_DIR]) {
          try {
            unlinkSync(join(dir, `${threadId}.ndjson`));
          } catch {}
        }
      }
      return json(res, 200, { ok: true });
    },
    postMessage: async (req: IncomingMessage, res: ServerResponse, m: RegExpMatchArray) => {
      const body = await readBody(req);
      if (!body || typeof body !== "object" || Array.isArray(body)) {
        return json(res, 400, { error: "body must be a JSON object" });
      }
      const text = String(body.text ?? "").trim();
      if (!text) return json(res, 400, { error: "text required" });
      const group = store.group(m[1]);
      if (!group) return json(res, 404, { error: "no such group" });
      if (body.threadId !== undefined && (typeof body.threadId !== "string" || !/^[\w-]+$/.test(body.threadId))) {
        return json(res, 400, { error: "threadId must be a task id" });
      }
      const threadId = body.threadId ?? group.threadId;
      const ownsThread = group.dm
        ? group.threadId === threadId
        : Boolean(store.groupTaskByThread(group.id, threadId));
      if (!ownsThread) {
        return json(res, 409, { error: "the channel switched tasks before it could receive the message" });
      }
      const sendId = parseSendId(body.sendId);
      const replyTo = resolveReplyTarget(threadId, body.replyToId);
      const receipt = await sendSequencer.run(
        sendId ? `group:${group.id}:${threadId}:${sendId}` : undefined,
        sendFingerprint(text, replyTo?.id),
        async () => {
          if (sendId) {
            const accepted = acceptedSendMatch(store.messagesFor(threadId), sendId, text, replyTo?.id);
            if (accepted.kind === "conflict") {
              throw Object.assign(new Error("sendId already belongs to another message"), { status: 409 });
            }
            if (accepted.kind === "match") {
              return { ok: true as const, threadId, message: accepted.message };
            }
          }
          const current = store.group(group.id);
          if (!current) throw Object.assign(new Error("no such group"), { status: 404 });
          if (current.threadId !== threadId) {
            throw Object.assign(new Error("the channel switched tasks before it could receive the message"), {
              status: 409,
            });
          }
          const message = startGroupTurn(current.id, text, replyTo, sendId);
          return { ok: true as const, threadId, message };
        },
      );
      return json(res, 202, receipt);
    },
    interrupt: async (req: IncomingMessage, res: ServerResponse, m: RegExpMatchArray) => {
      const group = store.group(m[1]);
      if (!group) return json(res, 404, { error: "no such room" });
      const rawBody = await readBody(req);
      if (rawBody !== null && (typeof rawBody !== "object" || Array.isArray(rawBody))) {
        return json(res, 400, { error: "body must be a JSON object" });
      }
      const body = rawBody ?? {};
      if (body.threadId !== undefined && (typeof body.threadId !== "string" || !/^[\w-]+$/.test(body.threadId))) {
        return json(res, 400, { error: "threadId must be a task id" });
      }
      if (body.threadId !== undefined && body.threadId !== group.threadId) {
        return json(res, 409, { error: "the channel switched tasks before it could be interrupted" });
      }
      // Mark the whole room operation cancelled before awaiting the provider.
      // This covers setup-before-busy and responder handoffs, and makes every
      // queued responder observe cancellation before it can start.
      cancelGroupTurnOperations(group.id, group.threadId);
      taskResumes.forgetThread(group.threadId);
      cancelQueuedRoomParticipations(group.id, group.threadId);
      const busy = group.busyBotId ? store.bot(group.busyBotId) : undefined;
      const instance = busy ? registry.get(busy.modelSelection.instanceId) : undefined;
      if (busy) {
        const epoch = bumpTurnEpoch(busy.id) - 1;
        markThreadInterrupted(group.threadId, busy.id, epoch);
        flushInterruptedTask(group.threadId, busy.id, "stop");
      }
      await instance?.adapter.interruptTurn(group.threadId).catch(() => {});
      closeOpenApprovals(group.threadId);
      if (busy) releaseInterruptedBot(busy.id, group.threadId);
      return json(res, 200, { ok: true });
    },
    patchCard: async (req: IncomingMessage, res: ServerResponse, m: RegExpMatchArray) => {
      const group = store.group(m[1]);
      if (!group) return json(res, 404, { error: "no such group" });
      const existing = store.messagesFor(group.threadId).find((msg) => msg.id === m![2]);
      if (!existing?.card?.askUser) return json(res, 404, { error: "no such card" });
      const patch = askUserCardPatchSchema.parse(await readBody(req));
      const card = { ...existing.card };
      if (patch.answered !== undefined) card.answered = patch.answered;
      if (patch.dismissed) card.dismissed = true;
      const patched = store.patchMessage(group.threadId, m[2], { card });
      return json(res, 200, { message: patched });
    },
  };
}
