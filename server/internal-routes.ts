import { randomUUID } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { basename } from "node:path";
import { z } from "zod";

import { CREDENTIAL_TARGETS, credentialIsConfigured, customCredentialId, customCredentialTarget, isCredentialTargetId, isReusableCredentialRequest, parseCustomService, type CredentialId, type CredentialTargetId } from "../shared/credential-request.ts";
import { EXTENDED_REACTIONS } from "../shared/reactions.ts";
import type { AskReply } from "./ask-bot.ts";
import type { watchAskHold } from "./ask-hold.ts";
import { askUserRequestSchema, postAskUser } from "./ask-user.ts";
import { importLocalImage, saveImage, type SavedAttachment } from "./attachments.ts";
import { peerMessagePrompt } from "./chief-of-staff.ts";
import { claimAsk, MAX_ASKS_PER_TURN } from "./comms-budget.ts";
import { getOrCreateChannel, mirrorExchange, mirrorReply, postPeerReply, type CommsBus } from "./comms-visibility.ts";
import * as composio from "./composio.ts";
import type { ComputerControl } from "./computer-control.ts";
import { DATA_DIR, type AppConfig } from "./config.ts";
import { appendDecision } from "./decision-log.ts";
import { pollDelegation, queueDelegation, resolveDelegationId, type DelegatedTurn, type QueueResult } from "./delegations.ts";
import { generateImageFile, generateImageRequestSchema } from "./generate-image.ts";
import { googleAccountRoute, type GoogleAccount } from "./google-account.ts";
import { json, readBody } from "./http-helpers.ts";
import type { KeepGoing } from "./keep-going.ts";
import { callApi, callApiRequestSchema, recordKeyUse } from "./key-broker.ts";
import { buildNotification, type Notification } from "./notify.ts";
import { requestPeerApproval, type ApprovalBus } from "./peer-approval.ts";
import type { RoutineRequestService } from "./routine-requests.ts";
import type { RoutineManager, RoutineRun } from "./routines.ts";
import { agentRoster, sectionKey, type BotRecord, type GroupRecord, type Store } from "./store.ts";
import { isRecoveryFlushReason } from "./task-recovery-flush.ts";
import { foldCompletedNextAction } from "./task-state-fold.ts";
import { assignTaskNextAction, groundTaskArtifacts, taskStateNotice, taskStateUpdateError, taskStateUpdateSchema, type TaskResumePacket } from "./task-state.ts";
import { workspaceDir } from "./workspace.ts";

type InternalRouteDeps = {
  cfg: AppConfig;
  utilityParentPort: object | undefined;
  googleAccount: GoogleAccount;
  MAX_COMMS_DEPTH: number;
  MAX_WORKSPACE_BOTS: number;
  computerControl: ComputerControl;
  askBotAndWait: (targetBotId: string, message: string, depth: number, fromBotId?: string, peer?: { sender: BotRecord; channel?: GroupRecord; sourceThreadId: string; transcriptText?: string }) => Promise<AskReply>;
  checkedMemberIds: (value: unknown) => { ok: true; memberIds: string[] } | { ok: false; error: string };
  store: Store;
  keepGoing: KeepGoing;
  wireBot: (bot: BotRecord) => Record<string, unknown>;
  broadcast: (payload: Record<string, unknown>) => void;
  taskPacketForWrite: (threadId: string) => TaskResumePacket | null;
  persistTaskPacket: (packet: TaskResumePacket) => TaskResumePacket | null;
  notify: (notification: Notification | null, turnMs?: number, routineRun?: RoutineRun | null) => void;
  routines: RoutineManager;
  delegationWatch: Map<string, DelegatedTurn & { endTakeover?: () => void }>;
  askHold: ReturnType<typeof watchAskHold>;
  routineSourceThread: (run: RoutineRun) => string | null;
  routineRequests: RoutineRequestService;
  routineTimeZone: () => string;
  agentRoutine: (routine: ReturnType<RoutineManager["listRoutines"]>[number], latestRun?: RoutineRun) => Record<string, unknown>;
  commsBus: CommsBus;
  approvalBus: ApprovalBus;
  CONNECTOR_SLUG: RegExp;
  connectorThread: (botId: string, threadId: string) => ReturnType<Store["conversationForBot"]>;
  botOutputRoots: (bot: BotRecord, threadId: string, groupId?: string) => string[];
  routineProposalPersistence: (botId: string, threadId: string) => { ok: false; status: number; error: string } | { ok: true };
  maybeResumeConnectors: (botId: string, threadId: string, resumeKey: string) => boolean;
};

export function createInternalRoutes(deps: InternalRouteDeps) {
  const {
    cfg,
    utilityParentPort,
    googleAccount,
    MAX_COMMS_DEPTH,
    MAX_WORKSPACE_BOTS,
    computerControl,
    askBotAndWait,
    checkedMemberIds,
    store,
    keepGoing,
    wireBot,
    broadcast,
    taskPacketForWrite,
    persistTaskPacket,
    notify,
    routines,
    delegationWatch,
    askHold,
    routineSourceThread,
    routineRequests,
    routineTimeZone,
    agentRoutine,
    commsBus,
    approvalBus,
    CONNECTOR_SLUG,
    connectorThread,
    botOutputRoots,
    routineProposalPersistence,
    maybeResumeConnectors,
  } = deps;
  const routineRequestSourceSchema = {
    fromBotId: z.string().min(1).max(128),
    fromThreadId: z.string().min(1).max(128),
  };
  const routineRequestEnvelopeSchema = z.discriminatedUnion("action", [
    z.object({ ...routineRequestSourceSchema, action: z.literal("create"), routine: z.unknown() }).strict(),
    z.object({
      ...routineRequestSourceSchema,
      action: z.literal("update"),
      routineId: z.unknown(),
      changes: z.unknown(),
    }).strict(),
    ...(["pause", "resume", "run_now", "delete"] as const).map((action) =>
      z.object({ ...routineRequestSourceSchema, action: z.literal(action), routineId: z.unknown() }).strict()
    ),
  ]);
  return {
    googleAccountChange: async (req: IncomingMessage, res: ServerResponse, method: "PUT" | "DELETE") => {
      const result = await googleAccountRoute(method, Boolean(utilityParentPort), () => readBody(req), googleAccount);
      return json(res, result.status, result.body);
    },
    taskState: async (req: IncomingMessage, res: ServerResponse) => {
      const raw = await readBody(req);
      const clipped: string[] = [];
      const parsed = taskStateUpdateSchema(clipped).safeParse(raw);
      if (!parsed.success) return json(res, 400, { error: taskStateUpdateError(parsed.error, raw) });
      const body = parsed.data;
      const bot = store.bot(body.fromBotId);
      if (!bot) return json(res, 403, { error: "unknown sender" });
      const conversation = store.conversationForBot(bot.id, body.fromThreadId);
      if (!conversation) return json(res, 403, { error: "source conversation does not belong to sender" });
      const task = store.taskByThread(bot.id, body.fromThreadId);
      const groupTask = conversation.group
        ? store.groupTaskByThread(conversation.group.id, body.fromThreadId)
        : undefined;
      const current = taskPacketForWrite(body.fromThreadId);
      if (!current) return json(res, 409, { error: "task record is not ready" });
      const taskCwd = task?.cwd ?? groupTask?.pinnedCwd;
      if (body.artifacts?.length && !taskCwd) {
        return json(res, 400, { error: "this task has no working folder for artifacts" });
      }
      const folder = taskCwd ?? "";
      const { kept: artifacts, dropped } = groundTaskArtifacts(body.artifacts ?? [], folder);

      const next = structuredClone(current);
      // Dropping the anchor is how the bot claims a field: a later instruction
      // re-seeds only what still matches its anchor, and matching text alone
      // must not hand a bot-curated goal or plan back to the harness. Each
      // write claims its own field only, or a plan-only call (the form the
      // tool asks for when the goal is unchanged) would freeze the goal.
      if (body.goal !== undefined) {
        next.goal = body.goal;
        delete next.instructionGoal;
      }
      if (body.plan !== undefined) {
        next.plan = body.plan;
        delete next.instructionStep;
      }
      if (body.completed_note !== undefined && next.completed.at(-1)?.note !== body.completed_note) {
        next.completed.push({ note: body.completed_note, at: Date.now() });
      }
      if (body.next_action !== undefined) assignTaskNextAction(next, body.next_action);
      foldCompletedNextAction(next);
      if (body.blockers !== undefined) {
        next.blockers = [
          ...next.blockers.filter((blocker) => blocker.kind === "approval"),
          ...body.blockers,
        ];
      }
      for (const artifact of artifacts) {
        if (!next.artifacts.some((existing) => existing.ref === artifact.ref)) next.artifacts.push(artifact);
      }
      next.updatedAt = Date.now();
      next.updatedBy = "bot";
      if (!isRecoveryFlushReason(current.flushReason)) next.flushReason = "progress";
      next.turnsAtWrite = task?.usage?.turns ?? next.turnsAtWrite;
      const saved = persistTaskPacket(next);
      if (saved && body.pause_automatic_wakes) {
        store.patchBot(bot.id, { paneWakePaused: true });
        keepGoing.pause(bot.id, "bot-paused");
      }
      return saved
        ? json(res, 200, { ok: true, updatedAt: saved.updatedAt, nextAction: saved.nextAction, automaticWakesPaused: bot.paneWakePaused === true, notice: taskStateNotice(clipped, dropped, folder) })
        : json(res, 409, { error: "task record could not be saved" });
    },
    agents: async (res: ServerResponse, url: URL) => {
      const self = url.searchParams.get("self");
      const sender = self ? store.bot(self) : null;
      if (!sender) return json(res, 403, { error: "unknown sender" });
      // title/description included so a "chief of staff"-style bot can
      // judge the team (who does what, who has no job description yet)
      const bots = agentRoster(store.bots, sender)
        .map((b) => ({
          id: b.id,
          name: b.name,
          section: sectionKey(b.section) || undefined,
          model: b.modelSelection.model,
          busy: !!b.busy,
          title: b.title || undefined,
          description: b.description || undefined,
        }));
      return json(res, 200, { bots });
    },
    listRoutines: async (res: ServerResponse, url: URL) => {
      const fromBotId = String(url.searchParams.get("fromBotId") ?? "");
      const from = store.bot(fromBotId);
      if (!from) return json(res, 403, { error: "unknown sender" });
      const fromThreadId = String(url.searchParams.get("fromThreadId") ?? from.threadId);
      if (!connectorThread(from.id, fromThreadId)) {
        return json(res, 403, { error: "source conversation does not belong to sender" });
      }
      const latestRuns = new Map<string, RoutineRun>();
      // listRuns is newest-first. Keep the first receipt per definition so
      // the agent can answer "did it run?" from scheduler truth rather
      // than guessing from conversation history.
      for (const run of routines!.listRuns()) {
        if (run.botId === from.id && !latestRuns.has(run.routineId)) latestRuns.set(run.routineId, run);
      }
      return json(res, 200, {
        now: new Date().toISOString(),
        timeZone: routineTimeZone(),
        routines: routines!.listRoutines()
          .filter((routine) => routine.botId === from.id)
          .slice(0, 100)
          .map((routine) => agentRoutine(routine, latestRuns.get(routine.id))),
      });
    },
    proposeRoutine: async (req: IncomingMessage, res: ServerResponse) => {
      const parsed = routineRequestEnvelopeSchema.safeParse(await readBody(req));
      if (!parsed.success) return json(res, 400, { error: "invalid routine proposal" });
      const body = parsed.data;
      const fromBotId = body.fromBotId;
      const from = store.bot(fromBotId);
      if (!from) return json(res, 403, { error: "unknown sender" });
      const fromThreadId = body.fromThreadId;
      const owner = connectorThread(from.id, fromThreadId);
      if (!owner) return json(res, 403, { error: "source conversation does not belong to sender" });
      const persistence = routineProposalPersistence(from.id, fromThreadId);
      if (!persistence.ok) {
        return json(res, persistence.status, { error: persistence.error });
      }
      const proposedInput = body.action === "create"
        ? { action: body.action, routine: body.routine }
        : body.action === "update"
          ? { action: body.action, routineId: body.routineId, changes: body.changes }
          : { action: body.action, routineId: body.routineId };
      const proposed = await routineRequests.propose({
        botId: from.id,
        threadId: fromThreadId,
        proposal: proposedInput,
        from: owner.group ? { botId: from.id, name: from.name, color: from.color } : undefined,
      });
      const proposedCard = store.messagesFor(fromThreadId).find((message) => message.id === proposed.messageId)?.card;
      appendDecision(DATA_DIR, {
        threadId: fromThreadId,
        requestId: proposed.requestId,
        botId: from.id,
        botName: from.name,
        tool: proposedCard?.tool,
        // Audit what the human was actually shown, not the shorter tool
        // response returned to the model.
        summary: proposedCard?.subtitle ?? proposed.summary,
        decision: "card-shown",
        source: "routine",
      });
      return json(res, 201, proposed);
    },
    askBot: async (req: IncomingMessage, res: ServerResponse) => {
      const body = await readBody(req);
      const fromBotId = String(body.fromBotId ?? "");
      const toBotId = String(body.toBotId ?? "");
      const message = String(body.message ?? "").trim();
      const depth = Number(body.depth ?? 0) || 0;
      if (!toBotId || !message) return json(res, 400, { error: "toBotId and message required" });
      if (toBotId === fromBotId) return json(res, 400, { error: "a bot cannot message itself" });
      if (depth >= MAX_COMMS_DEPTH) return json(res, 200, { error: "message chains are limited to one hop" });
      const target = store.bot(toBotId);
      if (!target) return json(res, 404, { error: "no such bot" });
      if (target.busy) return json(res, 200, { busy: true });
      // An unknown sender used to fall through: no mirroring AND no
      // approval, while still running the peer turn. That made an
      // unresolvable id the cheapest way past the gate, so it is now a
      // hard refusal - every peer turn has an accountable sender.
      const from = store.bot(fromBotId);
      if (!from) return json(res, 403, { error: "unknown sender" });
      const fromThreadId = String(body.fromThreadId ?? from.threadId);
      if (!connectorThread(from.id, fromThreadId)) {
        return json(res, 403, { error: "source thread does not belong to sender" });
      }
      // Depth stops recursion, not breadth. The claim happens before the
      // approval card so a turn cannot open unbounded cards either.
      if (!claimAsk(fromThreadId)) {
        return json(res, 200, {
          limit: `This turn has already used its ${MAX_ASKS_PER_TURN} teammate messages. Work with the replies you have, or hand the rest off with delegate_bot.`,
        });
      }
      let currentFrom = from;
      let currentTarget = target;

      // the exchange is mirrored into a bot⇄bot channel: it shows up in
      // the sidebar like any room, keeps the pair's full history, and the
      // user can open it and chip in. Both 1:1 threads get a clickable
      // chip that opens the channel, so bot-to-bot turns are never
      // invisible (they cost the user tokens).
      //
      // per-bot approval gate: a chief-of-staff bot without this on is
      // free to coordinate; one with it on must wait for a human card
      // (15-min timeout → deny) before its peer turn starts. The channel
      // and the chips are created only AFTER the verdict, so a denied
      // contact leaves no trace of an exchange that never happened.
      if (from.approvePeerComms) {
        const verdict = await requestPeerApproval(
          approvalBus,
          from,
          target,
          message,
          "ask_bot",
          fromThreadId,
        );
        if (verdict !== "allow") return json(res, 200, { error: "denied by user" });
        // The card may have been open for minutes. Re-read both records so
        // deleted bots cannot recreate transcripts through stale objects.
        const freshFrom = store.bot(fromBotId);
        const freshTarget = store.bot(toBotId);
        if (!freshFrom || !freshTarget) return json(res, 404, { error: "no such bot" });
        if (!connectorThread(freshFrom.id, fromThreadId)) {
          return json(res, 404, { error: "source task no longer exists" });
        }
        if (freshTarget.busy) return json(res, 200, { busy: true });
        currentFrom = freshFrom;
        currentTarget = freshTarget;
      }
      const channel = getOrCreateChannel(store, currentFrom, currentTarget);
      mirrorExchange(commsBus, currentFrom, currentTarget, message, channel, fromThreadId);
      const prefixed = peerMessagePrompt(currentFrom, message, "ask");
      const reply = await askBotAndWait(toBotId, prefixed, depth, fromBotId, {
        sender: currentFrom,
        channel,
        sourceThreadId: fromThreadId,
        transcriptText: message,
      });
      // the peer's real reply reaches the channel and this thread when its turn ends
      if (reply.taskId) return json(res, 200, { botName: currentTarget.name, text: reply.text, taskId: reply.taskId, shown: false });
      // a harness note (no text, no start) is not the peer's message
      if (reply.replied) mirrorReply(commsBus, currentTarget, reply.text, channel);
      const shown = reply.replied && postPeerReply(commsBus, currentFrom, currentTarget, reply.text, channel, fromThreadId);
      return json(res, 200, { botName: currentTarget.name, text: reply.text, shown });
    },
    react: async (req: IncomingMessage, res: ServerResponse) => {
      const body = await readBody(req);
      const fromBotId = String(body.fromBotId ?? "");
      const fromThreadId = String(body.fromThreadId ?? "");
      const emoji = String(body.emoji ?? "").trim();
      const from = store.bot(fromBotId);
      if (!from) return json(res, 403, { error: "unknown sender" });
      if (!connectorThread(from.id, fromThreadId)) {
        return json(res, 403, { error: "source thread does not belong to sender" });
      }
      const target = store.activePath(fromThreadId).findLast((m) => m.role === "user" && m.kind === "text");
      if (!target) return json(res, 200, { error: "no user message to react to yet" });
      if (!(EXTENDED_REACTIONS as readonly string[]).includes(emoji) && !target.reactions?.some((reaction) => reaction.emoji === emoji && reaction.by === fromBotId)) {
        return json(res, 400, { error: "unsupported emoji" });
      }
      const patched = store.toggleReaction(fromThreadId, target.id, emoji, fromBotId);
      if (!patched) return json(res, 404, { error: "message not found" });
      return json(res, 200, { ok: true });
    },
    setKeepGoing: async (req: IncomingMessage, res: ServerResponse) => {
      const body = await readBody(req);
      const from = store.bot(String(body.fromBotId ?? ""));
      if (!from) return json(res, 403, { error: "unknown sender" });
      if (typeof body.on !== "boolean") return json(res, 400, { error: "on must be true or false" });
      const fromThreadId = String(body.fromThreadId ?? "");
      const result = keepGoing.fromTool(from.id, fromThreadId, body.on, body.on ? taskPacketForWrite(fromThreadId) : null, body.start_after);
      if ("error" in result) return json(res, 403, result);
      broadcast({ kind: "bot", bot: wireBot(from) });
      return json(res, 200, result);
    },
    askUser: async (req: IncomingMessage, res: ServerResponse) => {
      const body = await readBody(req);
      const result = postAskUser(
        {
          bot: (id) => store.bot(id),
          conversation: connectorThread,
          appendMessage: (threadId, message) => store.appendMessage(threadId, message),
          alertThread: (bot, threadId) => {
            // A routine run's alert opens the conversation that owns the routine.
            const run = routines?.activeRunForBot(bot.id);
            return (run?.threadId === threadId && routineSourceThread(run)) || threadId;
          },
          notifyQuestion: (bot, target, question) => notify(buildNotification("question", bot, target, question)),
          whenSettled: (botId, threadId, post) => askHold.whenSettled(botId, threadId, post),
        },
        askUserRequestSchema.parse(body),
      );
      return json(res, result.status, result.body);
    },
    showImage: async (req: IncomingMessage, res: ServerResponse) => {
      const body = await readBody(req);
      const fromBotId = String(body.fromBotId ?? "");
      const fromThreadId = String(body.fromThreadId ?? "");
      const from = store.bot(fromBotId);
      if (!from) return json(res, 403, { error: "unknown sender" });
      if (!fromThreadId) return json(res, 400, { error: "no active thread" });
      const owner = connectorThread(from.id, fromThreadId);
      if (!owner) return json(res, 403, { error: "source thread does not belong to sender" });
      const roots = [
        store.taskByThread(from.id, fromThreadId)?.cwd,
        owner.group ? store.groupTaskByThread(owner.group.id, fromThreadId)?.pinnedCwd : undefined,
        from.cwd,
        workspaceDir(from.id),
      ].filter((root): root is string => Boolean(root));
      let saved: ReturnType<typeof importLocalImage>;
      try {
        saved = importLocalImage(String(body.path ?? ""), roots);
      } catch (e) {
        return json(res, (e as { status?: number }).status ?? 400, { error: (e as Error).message });
      }
      const caption = typeof body.caption === "string" ? body.caption.trim().slice(0, 500) : "";
      const message = store.appendMessage(fromThreadId, {
        role: "bot",
        kind: "screen",
        ...(owner.group ? { from: { botId: from.id, name: from.name, color: from.color } } : {}),
        image: saved.name,
        shown: true,
        ...(caption ? { text: caption } : {}),
      });
      return json(res, 201, { messageId: message.id, url: `/api/attachments/${saved.name}` });
    },
    generateImage: async (req: IncomingMessage, res: ServerResponse) => {
      const body = await readBody(req);
      const fromBotId = String(body.fromBotId ?? "");
      const fromThreadId = String(body.fromThreadId ?? "");
      const from = store.bot(fromBotId);
      if (!from) return json(res, 403, { error: "unknown sender" });
      if (!fromThreadId) return json(res, 400, { error: "no active thread" });
      const owner = connectorThread(from.id, fromThreadId);
      if (!owner) return json(res, 403, { error: "source thread does not belong to sender" });
      const parsed = generateImageRequestSchema.safeParse(body);
      if (!parsed.success) {
        return json(res, 400, { error: "needs a prompt (max 4000 chars) and a supported size and quality" });
      }
      const roots = botOutputRoots(from, fromThreadId, owner.group?.id);
      let generated: Awaited<ReturnType<typeof generateImageFile>>;
      try {
        generated = await generateImageFile(cfg.imageGen?.key ?? "", parsed.data, roots);
      } catch (e) {
        return json(res, (e as { status?: number }).status ?? 500, { error: (e as Error).message });
      }
      recordKeyUse(DATA_DIR, "openaiImageApiKey", from.id);
      if (body.show === false) return json(res, 201, { path: generated.path });
      // Generation is slow; the conversation may be gone by now.
      const current = connectorThread(from.id, fromThreadId);
      if (!current) return json(res, 201, { path: generated.path, showError: "the conversation is gone" });
      let shown: SavedAttachment;
      try {
        shown = saveImage(generated.bytes, "image/png");
      } catch (e) {
        return json(res, 201, { path: generated.path, showError: (e as Error).message });
      }
      const name = basename(shown.path);
      const message = store.appendMessage(fromThreadId, {
        role: "bot",
        kind: "screen",
        ...(current.group ? { from: { botId: from.id, name: from.name, color: from.color } } : {}),
        image: name,
        shown: true,
      });
      return json(res, 201, { path: generated.path, messageId: message.id, url: `/api/attachments/${name}` });
    },
    callKeyApi: async (req: IncomingMessage, res: ServerResponse) => {
      const body = await readBody(req);
      const fromThreadId = String(body.fromThreadId ?? "");
      const from = store.bot(String(body.fromBotId ?? ""));
      if (!from) return json(res, 403, { error: "unknown sender" });
      if (!fromThreadId) return json(res, 400, { error: "no active thread" });
      const owner = connectorThread(from.id, fromThreadId);
      if (!owner) return json(res, 403, { error: "source thread does not belong to sender" });
      const parsed = callApiRequestSchema.safeParse(body);
      if (!parsed.success) return json(res, 400, { error: "needs credential_id, method, and url; headers must be strings" });
      try {
        const result = await callApi(parsed.data, cfg, botOutputRoots(from, fromThreadId, owner.group?.id));
        recordKeyUse(DATA_DIR, parsed.data.credentialId, from.id);
        return json(res, 200, result);
      } catch (e) {
        return json(res, (e as { status?: number }).status ?? 500, { error: (e as Error).message });
      }
    },
    delegationStatus: async (res: ServerResponse, delegationMatch: RegExpMatchArray, url: URL) => {
      const fromBotId = String(url.searchParams.get("fromBotId") ?? "");
      const fromThreadId = String(url.searchParams.get("fromThreadId") ?? "");
      const from = store.bot(fromBotId);
      if (!from || !connectorThread(from.id, fromThreadId)) return json(res, 403, { error: "unknown sender" });
      const runningIds = [...delegationWatch.values()].filter((watch) => watch.sourceThreadId === fromThreadId && watch.taskId).map((watch) => watch.taskId!);
      const resolved = resolveDelegationId(delegationMatch[1], fromThreadId, runningIds);
      if ("error" in resolved) {
        return json(res, resolved.error === "too_short" ? 400 : 409, {
          error: resolved.error === "too_short"
            ? "unknown task id; a prefix needs at least 8 characters"
            : "that task id prefix matches more than one delegation; use more characters",
        });
      }
      const taskId = resolved.id;
      const waitMs = Math.min(Math.max(Number(url.searchParams.get("wait_ms")) || 0, 0), 240_000);
      const polled = await pollDelegation(
        taskId,
        from.id,
        fromThreadId,
        waitMs,
        (id) => [...delegationWatch.values()].find((watch) => watch.taskId === id),
        (botId) => store.bot(botId)?.name ?? botId,
      );
      return json(res, polled.code, polled.body);
    },
    delegateBot: async (req: IncomingMessage, res: ServerResponse) => {
      const body = await readBody(req);
      const fromBotId = String(body.fromBotId ?? "");
      const toBotId = String(body.toBotId ?? "");
      const message = String(body.message ?? "").trim();
      const reason = typeof body.reason === "string" && body.reason.trim() ? body.reason.trim() : undefined;
      const depth = Number(body.depth ?? 0) || 0;
      if (!toBotId || !message) return json(res, 400, { error: "toBotId and message required" });
      const from = store.bot(fromBotId);
      if (!from) return json(res, 404, { error: "no such bot" });
      const target = store.bot(toBotId);
      if (!target) return json(res, 404, { error: "no such bot" });
      const fromThreadId = String(body.fromThreadId ?? from.threadId);
      if (!connectorThread(from.id, fromThreadId)) {
        return json(res, 403, { error: "source thread does not belong to sender" });
      }
      const queued = queueDelegation(
        commsBus,
        from,
        { toBotId, message, reason, depth },
        MAX_COMMS_DEPTH,
        fromThreadId,
      );
      if (queued.result !== "ok" || !queued.id) {
        // the agent reads this string - a bare enum ("too_deep") tells it
        // nothing about what to do instead
        const said: Record<Exclude<QueueResult, "ok">, string> = {
          self: "a bot cannot delegate to itself",
          too_deep: "delegation chains are limited to one hop - do this one yourself",
          no_target: "no such bot",
          too_many: "too many delegations queued on this turn - finish some first",
        };
        return json(res, 200, { error: said[queued.result === "ok" ? "no_target" : queued.result] });
      }
      const targetName = store.bot(toBotId)?.name ?? toBotId;
      return json(res, 200, {
        queued: true,
        taskId: queued.id,
        message: from.approvePeerComms
          ? `Queued for review - @${targetName} will only pick it up if the user approves after your turn finishes.`
          : `Delegation queued - @${targetName} will pick it up after your current turn finishes.`,
      });
    },
    createBot: async (req: IncomingMessage, res: ServerResponse) => {
      const body = await readBody(req);
      const fromBotId = String(body.fromBotId ?? "");
      const chief = store.bot(fromBotId);
      if (!chief) return json(res, 403, { error: "unknown sender" });
      const fromThreadId = String(body.fromThreadId ?? chief.threadId);
      if (!connectorThread(chief.id, fromThreadId)) {
        return json(res, 403, { error: "source conversation does not belong to sender" });
      }
      if (!chief.chiefOfStaff) {
        return json(res, 403, { error: "only a section's Chief of Staff can create operator bots" });
      }
      if (store.bots.length >= MAX_WORKSPACE_BOTS) {
        return json(res, 409, { error: `this workspace is limited to ${MAX_WORKSPACE_BOTS} bots` });
      }
      const name = String(body.name ?? "").trim();
      const role = String(body.role ?? "").trim();
      const instructions = String(body.instructions ?? "").trim();
      if (!name || !role || !instructions) {
        return json(res, 400, { error: "name, role, and instructions are required" });
      }
      if (name.length > 80) return json(res, 400, { error: "name must be at most 80 characters" });
      if (role.length > 120) return json(res, 400, { error: "role must be at most 120 characters" });
      if (instructions.length > 1_000) {
        return json(res, 400, { error: "instructions must be at most 1000 characters" });
      }
      const duplicate = store.bots.find(
        (candidate) =>
          !candidate.hidden &&
          sectionKey(candidate.section) === sectionKey(chief.section) &&
          candidate.name.trim().toLowerCase() === name.toLowerCase(),
      );
      if (duplicate) {
        return json(res, 409, { error: `@${duplicate.name} already exists in this section; use list_bots` });
      }
      const created = store.createBot(
        {
          name,
          title: role,
          description: instructions,
          modelSelection: { ...chief.modelSelection },
          section: chief.section,
        },
        { seedMessages: false },
      );
      const safeBot = store.patchBot(created.id, {
        composio: false,
        autoApprove: false,
        approvePeerComms: false,
      })!;
      return json(res, 201, {
        id: safeBot.id,
        name: safeBot.name,
        title: safeBot.title,
        section: safeBot.section || "General",
        model: safeBot.modelSelection.model,
      });
    },
    createChannel: async (req: IncomingMessage, res: ServerResponse) => {
      const body = await readBody(req);
      if (!body || typeof body !== "object" || Array.isArray(body)) {
        return json(res, 400, { error: "channel must be a JSON object" });
      }
      const fromBotId = String(body.fromBotId ?? "");
      const sender = store.bot(fromBotId);
      if (!sender) return json(res, 403, { error: "unknown sender" });
      const fromThreadId = String(body.fromThreadId ?? sender.threadId);
      if (!connectorThread(sender.id, fromThreadId)) {
        return json(res, 403, { error: "source conversation does not belong to sender" });
      }
      if (!Array.isArray(body.memberIds) || body.memberIds.length === 0) {
        return json(res, 400, { error: "a channel needs at least one bot" });
      }
      const roster = checkedMemberIds(body.memberIds);
      if (!roster.ok) return json(res, 400, { error: roster.error });
      const memberIds = [...new Set([sender.id, ...roster.memberIds])];
      for (const id of memberIds) {
        const member = store.bot(id);
        if (!member || member.hidden) {
          return json(res, 400, { error: `unknown channel member: ${id}` });
        }
      }
      if (body.name !== undefined && typeof body.name !== "string") {
        return json(res, 400, { error: "channel name must be a string" });
      }
      const name = typeof body.name === "string" && body.name.trim()
        ? body.name.trim()
        : `${store.bot(memberIds[0])!.name} & co.`;
      if (name.length > 100) return json(res, 400, { error: "channel name must be at most 100 characters" });
      // The room joins the sender's section, always. Sections are the
      // user's own filing - a free-text section here lets a bot invent
      // sidebar sections and file the user's rooms into them.
      const section = sender.section;
      let bulletin = "";
      if (body.bulletin !== undefined) {
        if (typeof body.bulletin !== "string") return json(res, 400, { error: "bulletin must be a string" });
        bulletin = body.bulletin.trim();
        if (bulletin.length > 12_000) {
          return json(res, 400, { error: "setup.bulletin must be at most 12000 characters" });
        }
      }
      // A room the user asked for is usable the moment it exists - the
      // setup step would only stand between them and the bots they just
      // asked to assemble. The lead is the one decision worth taking off
      // the sender: memberIds[0] is always the sender, so picking it made
      // every bot-opened room answer to the bot that opened it.
      const lead = memberIds.find((id) => id !== sender.id) ?? sender.id;
      const group = store.createGroup(name, memberIds, false, section, {
        bulletin,
        defaultResponder: { kind: "member", botId: lead },
        completed: true,
      });
      return json(res, 201, {
        id: group.id,
        name: group.name,
        memberIds: group.memberIds,
        section: group.section || "General",
        threadId: group.threadId,
      });
    },
    requestCredential: async (req: IncomingMessage, res: ServerResponse) => {
      const body = await readBody(req);
      const fromBotId = String(body.fromBotId ?? "");
      const from = store.bot(fromBotId);
      if (!from) return json(res, 403, { error: "unknown sender" });
      const fromThreadId = String(body.fromThreadId ?? from.threadId);
      const owner = connectorThread(from.id, fromThreadId);
      if (!owner) return json(res, 403, { error: "source conversation does not belong to sender" });
      // A custom key is always asked again: a second card for the same host replaces it.
      const custom = body.credentialId === "custom" ? parseCustomService(body.service) : undefined;
      if (custom && "error" in custom) return json(res, 400, { error: custom.error });
      if (!custom && !isCredentialTargetId(body.credentialId)) {
        return json(res, 400, { error: "unsupported credential id" });
      }
      const service = custom?.service;
      const credentialId: CredentialId = service ? customCredentialId(service.host) : body.credentialId as CredentialTargetId;
      const target = service ? customCredentialTarget(service) : CREDENTIAL_TARGETS[body.credentialId as CredentialTargetId];
      if (!service && credentialIsConfigured(cfg, credentialId)) {
        return json(res, 200, { alreadyConfigured: true, label: target.label });
      }
      const existing = store.messagesFor(fromThreadId).find((message) =>
        isReusableCredentialRequest(message, credentialId, from.id, Boolean(owner.group)) &&
        JSON.stringify(message.secret?.service) === JSON.stringify(service)
      );
      if (existing) {
        return json(res, 200, { messageId: existing.id, label: target.label });
      }
      const reason = typeof body.reason === "string" ? body.reason.trim().slice(0, 240) : "";
      const message = store.appendMessage(fromThreadId, {
        role: "bot",
        kind: "secret",
        ...(owner.group ? { from: { botId: from.id, name: from.name, color: from.color } } : {}),
        secret: {
          target: credentialId,
          label: target.label,
          description: reason ? `${target.description} ${reason}` : target.description,
          placeholder: target.placeholder,
          helpUrl: target.helpUrl,
          requestKey: randomUUID(),
          ...(service ? { service } : {}),
        },
      });
      return json(res, 201, { messageId: message.id, label: target.label });
    },
    connectorMcp: async (req: IncomingMessage, res: ServerResponse) => {
      const body = await readBody(req);
      const upstream = await composio.relayMcp(
        cfg,
        body,
        Array.isArray(req.headers["mcp-session-id"])
          ? req.headers["mcp-session-id"][0]
          : req.headers["mcp-session-id"],
      );
      const headers: Record<string, string> = {
        "content-type": upstream.contentType,
        "cache-control": "no-store",
      };
      if (upstream.transportSessionId) headers["mcp-session-id"] = upstream.transportSessionId;
      res.writeHead(upstream.status, headers);
      return res.end(Buffer.from(upstream.bytes));
    },
    computerControlRoute: async (req: IncomingMessage, res: ServerResponse, url: URL, method: string) => {
      const botId = url.searchParams.get("botId") ?? "";
      const bot = store.bot(botId);
      if (!bot) return json(res, 404, { error: "no such bot" });
      if (method === "GET") {
        const snapshot = computerControl.snapshot(botId);
        return json(res, 200, { held: snapshot.held, helpOpen: snapshot.helpReason !== null });
      }
      if (method === "POST") {
        const body = await readBody(req);
        const { snapshot, requestId } = computerControl.requestHelpLease(botId, body.reason);
        // worth a buzz: the bot is blocked on the person's hands, which
        // is exactly the "blocked on you" rule notify.ts encodes
        notify(
          buildNotification("takeover", bot, bot.threadId, snapshot.helpReason ?? "asked you to take over"),
        );
        return json(res, 200, { held: snapshot.held, helpOpen: snapshot.helpReason !== null, requestId });
      }
      if (method === "DELETE") {
        const body = await readBody(req);
        const snapshot = computerControl.expireHelp(botId, body.requestId);
        return json(res, 200, { held: snapshot.held, helpOpen: snapshot.helpReason !== null });
      }
      return json(res, 405, { error: "method not allowed" });
    },
    connectorRequest: async (req: IncomingMessage, res: ServerResponse) => {
      const body = await readBody(req);
      const botId = String(body.botId ?? "");
      const threadId = String(body.threadId ?? "");
      const resumeKey = String(body.resumeKey ?? "");
      const slugs: string[] = Array.isArray(body.slugs)
        ? [...new Set<string>(body.slugs.map((slug: unknown) => String(slug).toLowerCase()).filter((slug: string) => CONNECTOR_SLUG.test(slug)))]
        : [];
      const owner = connectorThread(botId, threadId);
      if (!owner) return json(res, 403, { error: "conversation does not belong to this bot" });
      if (!/^[\w-]{8,100}$/.test(resumeKey)) return json(res, 400, { error: "invalid resume key" });
      if (!slugs.length || slugs.length > 12) return json(res, 400, { error: "one to twelve valid apps are required" });
      if (!composio.configured(cfg) || owner.bot.composio === false) {
        return json(res, 409, { error: "connected apps are not enabled for this bot" });
      }
      const connectionState: Record<string, { connected?: boolean }> = await composio.connectionStatus(cfg, slugs).catch(() => ({}));
      const messageIds: string[] = [];
      for (const slug of slugs) {
        const existing = store.messagesFor(threadId).find(
          (message) => message.connector?.resumeKey === resumeKey && message.connector.slug === slug,
        );
        if (existing) {
          messageIds.push(existing.id);
          continue;
        }
        const toolkit = await composio.toolkitCard(cfg, slug);
        const connected = connectionState[slug]?.connected === true;
        const message = store.appendMessage(threadId, {
          role: "bot",
          kind: "connector",
          ...(owner.group ? { from: { botId: owner.bot.id, name: owner.bot.name, color: owner.bot.color } } : {}),
          connector: {
            slug,
            label: toolkit.label,
            description: toolkit.blurb || `Connect ${toolkit.label} so the bot can continue`,
            status: connected ? "connected" : "required",
            resumeKey,
          },
        });
        messageIds.push(message.id);
      }
      maybeResumeConnectors(botId, threadId, resumeKey);
      return json(res, 200, { messageIds });
    },
  };
}
