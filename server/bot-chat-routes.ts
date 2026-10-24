import type { IncomingMessage, ServerResponse } from "node:http";

import { credentialIsConfigured, credentialResumeOutcome } from "../shared/credential-request.ts";
import { isCompletedTaskRecord } from "../shared/task-resume.ts";
import { canSwitchWhileWorking, runThread, workingThreadId } from "../shared/working-thread.ts";
import { sameModelSelection } from "../shared/model-selection.ts";
import * as composio from "./composio.ts";
import type { AppConfig } from "./config.ts";
import type { RequestOutcome } from "./contracts.ts";
import type { ProviderRegistry } from "./harness/registry.ts";
import { json, readBody } from "./http-helpers.ts";
import { resolvePeerComms, type ApprovalBus } from "./peer-approval.ts";
import { hasPeerWatch, steerTakeover } from "./peer-takeover.ts";
import { composeUserTurnPrompt, promptWithReply, userTurnReactionKeys } from "./replies.ts";
import type { RoutineManager } from "./routines.ts";
import { steersSend } from "./send-deliver.ts";
import { acceptedSendMatch, parseSendId, sendFingerprint, type SendSequencer } from "./send-idempotency.ts";
import { sendPostReceipt, type StartedTurn } from "./send-receipt.ts";
import { cancelQueuedSends, cancelSteeredMessage, isSendCancelled, queuedSteeredMessage, queueMark, queueSteeredMessage, withQueuedSend } from "./steer-queue.ts";
import type { BotRecord, Message, Store, TaskRecord } from "./store.ts";
import { isRecoveryFlushReason, shouldStampRecoveryDismiss, type RecoveryFlushReason, type TaskResumeScheduler } from "./task-recovery-flush.ts";
import { stampTaskResumePacket } from "./task-state-fold.ts";
import type { TaskResumePacket } from "./task-state.ts";
import type { createThreadSyncV2Gate } from "./thread-sync-v2-gate.ts";
import { TASK_RESUME_PROMPT } from "./turn-context.ts";

type BotChatRouteDeps = {
  cfg: AppConfig;
  threadSyncGate: ReturnType<typeof createThreadSyncV2Gate>;
  registry: ProviderRegistry;
  store: Store;
  sendSequencer: SendSequencer;
  ensureChatLatency: (input: { sendId?: string; threadId: string; userMessageId?: string; turnId?: string }) => void;
  markChatLatency: (input: { sendId?: string; threadId: string; userMessageId?: string; turnId?: string }, stage: "post.received" | "queue.decided" | "post.receipt", ids?: { queueId?: string; turnId?: string; assistantMessageId?: string }) => void;
  wireTask: (task: TaskRecord) => Record<string, unknown>;
  wireBot: (bot: BotRecord) => Record<string, unknown>;
  pullSyncedThread: (threadId: string) => void | Promise<void>;
  noteTalked: (botId: string) => void;
  broadcast: (payload: Record<string, unknown>) => void;
  answerRequest: (threadId: string, instanceId: string, requestId: string, behavior: "allow" | "deny" | "answer", message?: string, decidedFor?: { id: string; name: string }) => Promise<RequestOutcome>;
  closeOpenApprovals: (threadId: string) => void;
  requestBehavior: (value: unknown) => "allow" | "deny" | "answer" | null;
  taskPacketForWrite: (threadId: string) => TaskResumePacket | null;
  persistTaskPacket: (packet: TaskResumePacket) => TaskResumePacket | null;
  paneNoteTurnThreads: Set<string>;
  bumpTurnEpoch: (botId: string) => number;
  markThreadInterrupted: (threadId: string, botId: string, epoch: number) => void;
  flushInterruptedTask: (threadId: string, botId: string, reason: RecoveryFlushReason) => TaskResumePacket | null;
  releaseInterruptedBot: (botId: string, threadId: string) => void;
  clearUnattended: (botId: string) => void;
  routines: RoutineManager;
  busyResumeThreads: Set<string>;
  resumePaneWakes: (botId: string) => void;
  drainQueuedSends: () => void;
  turnStartClaims: Map<string, string | undefined>;
  botHasActiveTurn: (botId: string, threadId?: string) => boolean;
  taskResumes: TaskResumeScheduler;
  startTurn: (botId: string, text: string, opts?: { threadId?: string; userMessage?: Message; replyTo?: Message; sendId?: string }) => Promise<StartedTurn>;
  resolveAndSendRoutine: (res: ServerResponse, args: { botId: string; botName?: string; threadId: string; requestId: string; behavior: string }) => boolean;
  approvalBus: ApprovalBus;
  startGroupCardContinuation: (groupId: string, threadId: string, botId: string, prompt: string) => void;
  resolveReplyTarget: (threadId: string, value: unknown) => Message | undefined;
  connectorMessage: (botId: string, threadId: string, messageId: string) => Message | null;
  maybeResumeConnectors: (botId: string, threadId: string, resumeKey: string) => boolean;
  secretMessage: (botId: string, threadId: string, messageId: string) => Message | null;
  resumeSecretCard: (botId: string, threadId: string, messageId: string, outcome: "provided" | "dismissed") => void;
};

export function createBotChatRoutes(deps: BotChatRouteDeps) {
  const {
    cfg,
    threadSyncGate,
    registry,
    store,
    sendSequencer,
    ensureChatLatency,
    markChatLatency,
    wireTask,
    wireBot,
    pullSyncedThread,
    noteTalked,
    broadcast,
    answerRequest,
    closeOpenApprovals,
    requestBehavior,
    taskPacketForWrite,
    persistTaskPacket,
    paneNoteTurnThreads,
    bumpTurnEpoch,
    markThreadInterrupted,
    flushInterruptedTask,
    releaseInterruptedBot,
    clearUnattended,
    routines,
    busyResumeThreads,
    resumePaneWakes,
    drainQueuedSends,
    turnStartClaims,
    botHasActiveTurn,
    taskResumes,
    startTurn,
    resolveAndSendRoutine,
    approvalBus,
    startGroupCardContinuation,
    resolveReplyTarget,
    connectorMessage,
    maybeResumeConnectors,
    secretMessage,
    resumeSecretCard,
  } = deps;
  return {
    patchCard: async (req: IncomingMessage, res: ServerResponse, m: RegExpMatchArray) => {
      const bot = store.bot(m[1]);
      if (!bot) return json(res, 404, { error: "no such bot" });
      const existing = store.messagesFor(bot.threadId).find((msg) => msg.id === m![2]);
      if (!existing?.card) return json(res, 404, { error: "no such card" });
      const body = await readBody(req);
      const patched = store.patchMessage(bot.threadId, m[2], {
        card: {
          ...existing.card,
          ...(body.answered !== undefined ? { answered: body.answered } : {}),
          ...(body.dismissed !== undefined ? { dismissed: body.dismissed } : {}),
        },
      });
      return json(res, 200, { message: patched });
    },
    send: async (req: IncomingMessage, res: ServerResponse, m: RegExpMatchArray) => {
      const body = await readBody(req);
      if (!body || typeof body !== "object" || Array.isArray(body)) {
        return json(res, 400, { error: "body must be a JSON object" });
      }
      const text = String(body.text ?? "").trim();
      if (!text) return json(res, 400, { error: "text required" });
      const bot = store.bot(m[1]);
      if (!bot) return json(res, 404, { error: "no such bot" });
      if (body.threadId !== undefined && (typeof body.threadId !== "string" || !/^[\w-]+$/.test(body.threadId))) {
        return json(res, 400, { error: "threadId must be a task id" });
      }
      noteTalked(bot.id);
      // A retry carries its original task. That lets us return the canonical
      // receipt after a task switch, while a genuinely new send still has to
      // target the task that is active now.
      const threadId = body.threadId ?? bot.threadId;
      if (!store.taskByThread(bot.id, threadId)) {
        return json(res, 409, { error: "the bot switched tasks before it could receive the message" });
      }
      if (threadSyncGate.enabled) await pullSyncedThread(threadId);
      else pullSyncedThread(threadId);
      const sendId = parseSendId(body.sendId);
      const queueId = parseSendId(body.queueId);
      if (sendId) {
        ensureChatLatency({ sendId, threadId });
        markChatLatency({ sendId, threadId }, "post.received");
      }
      const replyTo = resolveReplyTarget(threadId, body.replyToId);
      const receipt = await sendSequencer.run(
        sendId ? `bot:${bot.id}:${threadId}:${sendId}` : undefined,
        sendFingerprint(text, replyTo?.id),
        async () => withQueuedSend(bot.id, threadId, queueId, sendId, async () => {
          if (sendId) {
            const accepted = acceptedSendMatch(store.messagesFor(threadId), sendId, text, replyTo?.id);
            if (accepted.kind === "conflict") {
              throw Object.assign(new Error("sendId already belongs to another message"), { status: 409 });
            }
            if (accepted.kind === "match") {
              const canonical = {
                ok: true as const,
                threadId,
                message: accepted.message,
              };
              return accepted.message.steered
                ? { ...canonical, steered: true as const }
                : canonical;
            }
            const queued = queuedSteeredMessage(bot.id, threadId, sendId);
            if (queued) {
              if (queued.text !== text || queued.replyToId !== replyTo?.id) {
                throw Object.assign(new Error("sendId already belongs to another message"), { status: 409 });
              }
              if (queueId !== queued.id) return { ok: true as const, queued: true as const, queueId: queued.id, threadId };
            } else if (queueId) {
              return { ok: true as const, cancelled: true as const, threadId };
            }
          }

          if (sendId && isSendCancelled(sendId)) {
            return { ok: true as const, cancelled: true as const, threadId };
          }

          const currentAtStart = store.bot(bot.id);
          if (!currentAtStart) throw Object.assign(new Error("no such bot"), { status: 404 });
          if (!store.taskByThread(currentAtStart.id, threadId)) {
            throw Object.assign(new Error("the target task no longer exists"), { status: 409 });
          }
          if (currentAtStart.threadId !== threadId) {
            throw Object.assign(new Error("the bot switched tasks before it could receive the message"), {
              status: 409,
            });
          }

          // Claude can accept the message inside its live turn. A turn-start
          // claim also counts as active while prepareModelContext is running:
          // busy flips only after preparation, so without this check rapid
          // sends race the claim and receive a false busy rejection.
          if (currentAtStart.busy || botHasActiveTurn(bot.id, threadId)) {
            const adapter = registry.get(currentAtStart.modelSelection.instanceId)?.adapter;
            let steered = false;
            // a steered message takes a peer turn over when the model reads
            // it; without a read signal, when the route accepts the steer
            const takeover = steerTakeover(threadId, adapter?.capabilities.steerConsumed === true);
            if (steersSend(adapter, currentAtStart.busy, body.deliver === "after")) {
              const turnOpts = {
                replyTo,
                messages: store.activePath(threadId),
                userName: cfg.profile?.name?.trim() || "User",
                delivered: store.taskByThread(bot.id, threadId)?.reactionsDelivered,
              };
              // Reactions count only once the model took them in; an engine
              // that cannot tell leaves them to the next turn's prompt.
              const consumable = adapter.capabilities.steerConsumed === true;
              const prompt = consumable ? composeUserTurnPrompt(text, turnOpts) : promptWithReply(text, replyTo, turnOpts.userName);
              const reactions = consumable ? userTurnReactionKeys(turnOpts) : [];
              steered = await adapter
                .steer(threadId, prompt, (taken, afterReply) => {
                  if (taken) store.addReactionsDelivered(bot.id, threadId, reactions);
                  takeover.consumed(taken, afterReply);
                }, { fromUser: true, peerTurn: hasPeerWatch(threadId) })
                .catch(() => false);
            }
            // steer() is awaited adapter work. The turn can settle, the task can
            // switch, or the whole bot can be deleted before its acknowledgement
            // arrives. Re-read every ownership invariant before appending even a
            // successful steer; otherwise that late acknowledgement writes a user
            // message into a task the bot no longer owns. A conflict leaves the
            // text in the client's composer/outbox to resend deliberately.
            const current = store.bot(bot.id);
            if (!current) throw Object.assign(new Error("no such bot"), { status: 404 });
            if (!store.taskByThread(bot.id, threadId)) {
              throw Object.assign(new Error("the target task no longer exists"), { status: 409 });
            }
            if (current.threadId !== threadId) {
              throw Object.assign(new Error("the bot switched tasks before it could receive the message"), {
                status: 409,
              });
            }
            // a Stop during the steer await already handed a Send now back
            if (sendId && isSendCancelled(sendId)) return { ok: true as const, cancelled: true as const, threadId };
            if (steered) {
              if (!current.busy) {
                throw Object.assign(
                  new Error("the running turn ended before the steered message could be recorded"),
                  { status: 409 },
                );
              }
              clearUnattended(current.id);
              resumePaneWakes(current.id);
              takeover.accepted();
              // the user joined this turn, so its finish alerts
              paneNoteTurnThreads.delete(threadId);
              const message = store.appendMessage(threadId, {
                role: "user",
                kind: "text",
                text,
                replyToId: replyTo?.id,
                sendId,
                steered: true,
              });
              markChatLatency({ sendId, threadId, userMessageId: message.id }, "queue.decided");
              return { ok: true as const, steered: true as const, threadId, message };
            }
            if (!current.busy && !botHasActiveTurn(bot.id, threadId)) {
              const started = await startTurn(bot.id, text, { threadId, replyTo, sendId });
              return sendPostReceipt(started, threadId);
            }
            const queued = queueId ? { id: queueId, skipped: false } : queueSteeredMessage(current.id, threadId, text, {
              replyToId: replyTo?.id,
              sendId,
              after: body.deliver === "after",
              // Reply quote only - startTurn wraps reactions when this drains.
              prompt: promptWithReply(text, replyTo, cfg.profile?.name?.trim() || "User"),
            });
            if (queued.skipped) {
              return { ok: true as const, cancelled: true as const, threadId };
            }
            if (busyResumeThreads.has(threadId)) void adapter?.interruptTurn(threadId).catch(() => {});
            markChatLatency({ sendId, threadId }, "queue.decided", { queueId: queued.id });
            return { ok: true as const, queued: true as const, queueId: queued.id, threadId };
          }
          // Stop cleared `busy`, but the driver holds the thread for up to
          // the cancel grace and would refuse the dispatch. Queue it - that
          // is already what a send to a busy bot does, and wireBot reports
          // this bot busy for exactly this window, so erroring here while
          // telling the client "busy" is the inconsistency. Check and enqueue
          // are synchronous, so a settle cannot land between them and strand
          // the message; the drain on turn.completed takes it from there.
          if (botHasActiveTurn(bot.id, threadId)) {
            const held = queueId ? { id: queueId, skipped: false } : queueSteeredMessage(bot.id, threadId, text, {
              replyToId: replyTo?.id,
              sendId,
              after: body.deliver === "after",
              prompt: promptWithReply(text, replyTo, cfg.profile?.name?.trim() || "User"),
            });
            if (held.skipped) return { ok: true as const, cancelled: true as const, threadId };
            markChatLatency({ sendId, threadId }, "queue.decided", { queueId: held.id });
            return { ok: true as const, queued: true as const, queueId: held.id, threadId };
          }
          const started = await startTurn(bot.id, text, { threadId, replyTo, sendId });
          return sendPostReceipt(started, threadId);
        }),
      ).finally(() => { if (queueId) drainQueuedSends(); });
      markChatLatency({ sendId, threadId }, "post.receipt");
      return json(res, 202, receipt);
    },
    deleteQueued: async (res: ServerResponse, m: RegExpMatchArray) => {
      const bot = store.bot(m[1]);
      if (!bot) return json(res, 404, { error: "no such bot" });
      const queueId = m[2];
      const result = cancelSteeredMessage(bot.id, queueId);
      if (!result.cancelled) {
        if (result.running) return json(res, 200, { cancelled: false, running: true });
        return json(res, 404, { error: "no such queued message" });
      }
      return json(res, 200, { ok: true, cancelled: true });
    },
    edit: async (req: IncomingMessage, res: ServerResponse, m: RegExpMatchArray) => {
      const messageId = m[2];
      const bot = store.bot(m[1]);
      if (!bot) return json(res, 404, { error: "no such bot" });
      const body = await readBody(req);
      const text = String(body.text ?? "").trim();
      if (!text) return json(res, 400, { error: "text required" });
      // everything from here down is synchronous, so two racing edits can
      // never both get past this check: startTurn acquires the turn-start
      // claim before the next request is handled
      if (botHasActiveTurn(bot.id, bot.threadId)) {
        return json(res, 409, { error: "the bot is working - stop it before editing" });
      }
      if (body.expectedSelection && !sameModelSelection(bot.modelSelection, body.expectedSelection)) {
        return json(res, 409, { error: "the model changed before the reply could be rerun" });
      }
      const source = store.messagesFor(bot.threadId).find((msg) => msg.id === messageId);
      if (!source || source.role !== "user" || source.kind !== "text") {
        return json(res, 404, { error: "only user messages can be edited" });
      }
      if (!registry.get(bot.modelSelection.instanceId)) {
        return json(res, 409, {
          error: `provider instance "${bot.modelSelection.instanceId}" is unavailable - pick another model in settings`,
        });
      }
      const message = store.branchMessage(bot.threadId, messageId, text);
      if (!message) return json(res, 404, { error: "no such message" });
      store.patchBot(bot.id, { rewound: true });
      const replyTo = message.replyToId ? resolveReplyTarget(bot.threadId, message.replyToId) : undefined;
      await startTurn(bot.id, text, { userMessage: message, replyTo });
      return json(res, 202, { ok: true });
    },
    activeBranch: async (req: IncomingMessage, res: ServerResponse, m: RegExpMatchArray) => {
      const bot = store.bot(m[1]);
      if (!bot) return json(res, 404, { error: "no such bot" });
      if (bot.busy) return json(res, 409, { error: "the bot is working - stop it before switching versions" });
      const body = await readBody(req);
      const leaf = store.setActiveLeaf(bot.threadId, String(body.messageId ?? ""));
      if (!leaf) return json(res, 404, { error: "no such message" });
      // provider sessions still hold the other branch - next turn replays
      store.patchBot(bot.id, { rewound: true });
      return json(res, 200, { activeLeafId: leaf });
    },
    respond: async (req: IncomingMessage, res: ServerResponse, m: RegExpMatchArray) => {
      const bot = store.bot(m[1]);
      if (!bot) return json(res, 404, { error: "no such bot" });
      const body = await readBody(req);
      const behavior = requestBehavior(body.behavior);
      if (!behavior) return json(res, 400, { error: "behavior must be allow, deny, or answer" });
      if (resolveAndSendRoutine(res, {
        botId: bot.id,
        botName: bot.name,
        threadId: bot.threadId,
        requestId: String(body.requestId),
        behavior,
      })) return;
      // peer-approval intercept: harness-native cards carry a requestId
      // that lives in peer-approval's pending map. Resolve them here so
      // the provider adapter never sees a request it didn't raise.
      if (resolvePeerComms(approvalBus, String(body.requestId), behavior)) {
        return json(res, 200, { ok: true, outcome: behavior === "allow" ? "allowed-once" : "rejected" });
      }
      const outcome = await answerRequest(bot.threadId, bot.modelSelection.instanceId, String(body.requestId), behavior, body.message, { id: bot.id, name: bot.name });
      return json(res, 200, { ok: true, outcome });
    },
    prewarm: async (res: ServerResponse, m: RegExpMatchArray) => {
      const bot = store.bot(m[1]);
      if (!bot) return json(res, 404, { error: "no such bot" });
      const instance = registry.get(bot.modelSelection.instanceId);
      if (!instance) return json(res, 404, { error: "no such provider instance" });
      if (typeof instance.prepare !== "function") {
        return json(res, 200, { ok: true, prepared: false, reason: "driver has no prepare" });
      }
      void instance.prepare().catch(() => {});
      return json(res, 200, { ok: true, prepared: true });
    },
    interrupt: async (req: IncomingMessage, res: ServerResponse, m: RegExpMatchArray) => {
      const bot = store.bot(m[1]);
      if (!bot) return json(res, 404, { error: "no such bot" });
      const rawBody = await readBody(req);
      if (rawBody !== null && (typeof rawBody !== "object" || Array.isArray(rawBody))) {
        return json(res, 400, { error: "body must be a JSON object" });
      }
      const body = rawBody ?? {};
      const requireSettled = body.requireSettled === true;
      const expectedThreadId = body.threadId;
      if (expectedThreadId !== undefined && (typeof expectedThreadId !== "string" || !/^[\w-]+$/.test(expectedThreadId))) {
        return json(res, 400, { error: "threadId must be a task id" });
      }
      const routineRun = routines!.activeRunForBot(bot.id);
      if (routineRun) {
        if (expectedThreadId !== undefined && runThread(routineRun) !== expectedThreadId) {
          return json(res, 409, { error: "this bot is running a routine in another conversation" });
        }
        const inFlight = Boolean(bot.busy || botHasActiveTurn(bot.id));
        taskResumes.forgetBot(bot.id);
        const returned = cancelQueuedSends(bot.id);
        if (returned.length) broadcast({ kind: "queue.cancelled", botId: bot.id, sends: returned });
        store.patchBot(bot.id, { paneWakePaused: true });
        // a turn still preparing has no session to interrupt yet
        bumpTurnEpoch(bot.id);
        await routines!.cancelRun(routineRun.id);
        if (inFlight) releaseInterruptedBot(bot.id, runThread(routineRun) ?? bot.threadId);
        if (requireSettled) return json(res, 200, { ok: true, stopped: inFlight, returned });
        return json(res, 200, { ok: true, returned });
      }
      const instance = registry.get(bot.modelSelection.instanceId);
      // a bot busy in a ROOM is running on the room's thread - stopping it
      // from its own chat must reach that turn, not just the 1:1 thread
      const busyGroup = store.groups.find((g) => g.busyBotId === bot.id);
      if (busyGroup) {
        if (expectedThreadId !== undefined && busyGroup.threadId !== expectedThreadId) {
          return json(res, 409, { error: `this bot is working in channel ${busyGroup.id}` });
        }
      }
      if (expectedThreadId !== undefined && !busyGroup && bot.threadId !== expectedThreadId) {
        return json(res, 409, { error: "the bot switched tasks before it could be interrupted" });
      }
      const inFlight = Boolean(busyGroup || bot.busy || botHasActiveTurn(bot.id));
      if (requireSettled && !inFlight) return json(res, 200, { ok: true, stopped: false, returned: [] });
      if (requireSettled && (!instance || busyGroup)) return json(res, 409, { error: "the waiting turn cannot be interrupted" });
      taskResumes.forgetBot(bot.id);
      const returned = cancelQueuedSends(bot.id);
      if (returned.length) broadcast({ kind: "queue.cancelled", botId: bot.id, sends: returned });
      store.patchBot(bot.id, { paneWakePaused: true });
      const stoppedThreadId = busyGroup?.threadId ?? bot.activeThreadId ?? bot.threadId;
      if (inFlight) {
        const epoch = bumpTurnEpoch(bot.id) - 1;
        markThreadInterrupted(stoppedThreadId, bot.id, epoch);
        flushInterruptedTask(stoppedThreadId, bot.id, "stop");
      }
      if (busyGroup) {
        await instance?.adapter.interruptTurn(busyGroup.threadId).catch(() => {});
        closeOpenApprovals(busyGroup.threadId);
      }
      let failed = false;
      await instance?.adapter.interruptTurn(bot.threadId).catch(() => { failed = true; });
      if (requireSettled && failed) return json(res, 200, { ok: true, stopped: false, returned });
      closeOpenApprovals(bot.threadId);
      if (stoppedThreadId !== bot.threadId && stoppedThreadId !== busyGroup?.threadId) {
        await instance?.adapter.interruptTurn(stoppedThreadId).catch(() => {});
      }
      if (inFlight) releaseInterruptedBot(bot.id, stoppedThreadId);
      if (requireSettled) return json(res, 200, { ok: true, stopped: inFlight, returned });
      return json(res, 200, { ok: true, returned });
    },
    resumeTask: async (res: ServerResponse, m: RegExpMatchArray) => {
      const bot = store.bot(m[1]);
      if (!bot) return json(res, 404, { error: "no such bot" });
      const conversation = store.conversationForBot(bot.id, m[2]);
      if (!conversation) return json(res, 404, { error: "no such task" });
      if (conversation.group) {
        if (conversation.group.threadId !== m[2]) {
          return json(res, 409, { error: "switch to this channel task before continuing it" });
        }
      } else if (bot.threadId !== m[2]) {
        return json(res, 409, { error: "switch to this task before continuing it" });
      }
      const packet = taskPacketForWrite(m[2]);
      if (!packet || !isRecoveryFlushReason(packet.flushReason) || isCompletedTaskRecord(packet)) {
        return json(res, 409, { error: "this task has no interrupted work to continue" });
      }
      if (conversation.group) {
        startGroupCardContinuation(conversation.group.id, m[2], bot.id, TASK_RESUME_PROMPT);
      }
      const result = await taskResumes.request(bot.id, m[2], queueMark());
      drainQueuedSends();
      return json(res, 202, { ok: true, pending: result.pending });
    },
    taskRecovery: async (req: IncomingMessage, res: ServerResponse, m: RegExpMatchArray) => {
      const bot = store.bot(m[1]);
      if (!bot) return json(res, 404, { error: "no such bot" });
      const conversation = store.conversationForBot(bot.id, m[2]);
      if (!conversation) return json(res, 404, { error: "no such task" });
      const task = conversation.group ? undefined : store.taskByThread(bot.id, m[2]);
      if (!conversation.group && !task) return json(res, 404, { error: "no such task" });
      const body = await readBody(req);
      if (body !== null && (typeof body !== "object" || Array.isArray(body))) {
        return json(res, 400, { error: "body must be a JSON object" });
      }
      // read after the await: an earlier snapshot is compared against a packet a
      // concurrent Stop may already have replaced, and then overwrites it
      const packet = taskPacketForWrite(m[2]);
      if (!packet) return json(res, 404, { error: "this task has no saved record" });
      if (!shouldStampRecoveryDismiss(packet, body ?? {})) {
        return json(res, 200, { ok: true, skipped: true });
      }
      const saved = persistTaskPacket(stampTaskResumePacket(packet, "progress", {
        now: Date.now(),
        turnsAtWrite: task?.usage?.turns ?? packet.turnsAtWrite,
      }));
      return saved
        ? json(res, 200, { ok: true })
        : json(res, 409, { error: "task record could not be saved" });
    },
    createTask: async (res: ServerResponse, m: RegExpMatchArray, botWithThread: (bot: BotRecord) => Record<string, unknown>) => {
      const bot = store.bot(m[1]);
      if (!bot) return json(res, 404, { error: "no such bot" });
      if (botHasActiveTurn(bot.id)) {
        return json(res, 409, { error: "this bot is working - let it finish before starting a task" });
      }
      // one chat per bot: native clients and MCP create_task get the chat it already has
      const task = store.activeTask(bot.id);
      if (!task) return json(res, 500, { error: "this bot has no chat" });
      return json(res, 200, { bot: botWithThread(bot), task: wireTask(task) });
    },
    switchTask: async (res: ServerResponse, m: RegExpMatchArray, url: URL, botWithThread: (bot: BotRecord) => Record<string, unknown>) => {
      const bot = store.bot(m[1]);
      if (!bot) return json(res, 404, { error: "no such bot" });
      // Switching away from the thread that owns the live process loses
      // interrupt targeting. Aligning the open chat onto that thread is safe.
      const working = workingThreadId({
        busy: Boolean(bot.busy),
        viewedThreadId: bot.threadId,
        liveRoutineThreadId: runThread(routines!.activeRunForBot(bot.id) ?? {}),
      });
      if (!canSwitchWhileWorking(m[2], working)) {
        return json(res, 409, { error: "this bot is working - stop it before switching tasks" });
      }
      if (threadSyncGate.enabled) {
        await pullSyncedThread(m[2]);
        const current = store.bot(bot.id);
        if (!current) return json(res, 404, { error: "no such bot" });
        const claimed = turnStartClaims.get(bot.id);
        const active = claimed ?? workingThreadId({
          busy: Boolean(current.busy),
          viewedThreadId: current.threadId,
          liveRoutineThreadId: runThread(routines!.activeRunForBot(bot.id) ?? {}),
        });
        if (!canSwitchWhileWorking(m[2], active)) return json(res, 409, { error: "this bot is working - stop it before switching tasks" });
      } else pullSyncedThread(m[2]);
      const switched = store.switchTask(bot.id, m[2]);
      if (!switched) return json(res, 404, { error: "no such task" });
      const fresh = botWithThread(switched);
      broadcast({ kind: "bot", bot: fresh });
      const responseBot = url.searchParams.get("messages") === "0"
        ? { ...wireBot(switched), tasks: store.tasks(switched.id).map(wireTask) }
        : fresh;
      return json(res, 200, { bot: responseBot });
    },
    patchTask: async (req: IncomingMessage, res: ServerResponse, m: RegExpMatchArray, botWithThread: (bot: BotRecord) => Record<string, unknown>) => {
      const body = await readBody(req);
      const task = store.renameTask(m[1], m[2], String(body.title ?? ""));
      if (!task) return json(res, 404, { error: "no such task" });
      const fresh = botWithThread(store.bot(m[1])!);
      broadcast({ kind: "bot", bot: fresh });
      return json(res, 200, { task: wireTask(task) });
    },
    secretCard: async (req: IncomingMessage, res: ServerResponse, m: RegExpMatchArray) => {
      const body = await readBody(req);
      const threadId = String(body.threadId ?? "");
      const message = secretMessage(m[1], threadId, m[2]);
      if (!message?.secret) return json(res, 404, { error: "no such credential request" });
      if (m[3] === "provided") {
        if (message.secret.dismissed) return json(res, 409, { error: "this credential request was dismissed" });
        if (!credentialIsConfigured(cfg, message.secret.target)) {
          return json(res, 409, { error: `${message.secret.label} was not saved yet` });
        }
        resumeSecretCard(m[1], threadId, message.id, "provided");
        return json(res, 200, { provided: true, resumed: true });
      }
      if (m[3] === "resume") {
        const outcome = credentialResumeOutcome(message.secret);
        if (!outcome) {
          return json(res, 409, { error: "this credential request is not ready to resume" });
        }
        if (outcome === "provided" && !credentialIsConfigured(cfg, message.secret.target)) {
          return json(res, 409, { error: `${message.secret.label} is no longer configured` });
        }
        resumeSecretCard(m[1], threadId, message.id, outcome);
        return json(res, 200, { resumed: true });
      }
      if (!message.secret.provided) resumeSecretCard(m[1], threadId, message.id, "dismissed");
      return json(res, 200, { dismissed: true, resumed: true });
    },
    connectorCard: async (req: IncomingMessage, res: ServerResponse, m: RegExpMatchArray, url: URL, method: string) => {
      const body = method === "POST" ? await readBody(req) : {};
      const threadId = String(method === "GET" ? url.searchParams.get("threadId") ?? "" : body.threadId ?? "");
      const message = connectorMessage(m[1], threadId, m[2]);
      if (!message?.connector) return json(res, 404, { error: "no such connection request" });
      const connector = message.connector;
      if (m[3] === "authorize" && method === "POST") {
        store.patchMessage(threadId, message.id, {
          connector: { ...connector, status: "authorizing", error: undefined, dismissed: false },
        });
        try {
          return json(res, 200, await composio.authorizeService(cfg, connector.slug));
        } catch (error) {
          const detail = error instanceof Error ? error.message : String(error);
          store.patchMessage(threadId, message.id, {
            connector: { ...connector, status: "failed", error: detail.slice(0, 180) },
          });
          throw error;
        }
      }
      if (m[3] === "status" && method === "GET") {
        const state = (await composio.connectionStatus(cfg, [connector.slug]))[connector.slug];
        const failed = /failed|expired|revoked|error/i.test(state?.status ?? "");
        const next = {
          ...connector,
          status: state?.connected ? ("connected" as const) : failed ? ("failed" as const) : ("authorizing" as const),
          error: failed ? `Connection ${state?.status ?? "failed"}` : undefined,
        };
        store.patchMessage(threadId, message.id, { connector: next });
        if (state?.connected) maybeResumeConnectors(m[1], threadId, connector.resumeKey);
        return json(res, 200, { connected: Boolean(state?.connected), pending: Boolean(state?.pending), status: state?.status });
      }
      if (m[3] === "resume" && method === "POST") {
        const resumed = maybeResumeConnectors(m[1], threadId, connector.resumeKey);
        return resumed
          ? json(res, 200, { resumed: true })
          : json(res, 409, { error: "finish connecting every requested app first" });
      }
      if (m[3] === "dismiss" && method === "POST") {
        store.patchMessage(threadId, message.id, { connector: { ...connector, dismissed: true } });
        return json(res, 200, { dismissed: true });
      }
      return json(res, 405, { error: "method not allowed" });
    },
  };
}
