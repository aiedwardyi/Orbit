import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { afterEach, describe, expect, it, vi } from "vitest";

import * as recovery from "./task-recovery-flush.ts";
import {
  _resetSteerQueue,
  cancelSteeredMessage,
  continueQueuedDrainIfIdle,
  drainSteeredMessages,
  hasQueuedSendBefore,
  queueMark,
  queueSteeredMessage,
} from "./steer-queue.ts";
import type { BotRecord, Message } from "./store.ts";

// Windows CI checks out CRLF; the slice markers below are written with \n.
const source = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "index.ts"), "utf8").replace(/\r\n/g, "\n");
const parsed = ts.createSourceFile("index.ts", source, ts.ScriptTarget.Latest, true);

function load(name: string, deps: Record<string, unknown>) {
  const node = parsed.statements.find((statement) =>
    (ts.isFunctionDeclaration(statement) && statement.name?.text === name)
    || (ts.isVariableStatement(statement) && statement.declarationList.declarations.some((item) => item.name.getText(parsed) === name)));
  if (!node) return undefined;
  const javascript = ts.transpileModule(node.getText(parsed), { compilerOptions: { target: ts.ScriptTarget.ESNext } }).outputText;
  return new Function(...Object.keys(deps), `${javascript}\nreturn ${name};`)(...Object.values(deps));
}

function route(pattern: string, deps: Record<string, unknown>) {
  const from = source.indexOf(`    m = path.match(${pattern});`);
  expect(from).toBeGreaterThan(0);
  const body = source.slice(from, source.indexOf('\n    m = path.match(', from + 1));
  const javascript = ts.transpileModule(`async function invoke(path) { const req = {}; const res = {}; const method = "POST"; let m; ${body} }`, {
    compilerOptions: { target: ts.ScriptTarget.ESNext },
  }).outputText;
  return new Function(...Object.keys(deps), `${javascript}\nreturn invoke;`)(...Object.values(deps));
}

function interruptRig() {
  const interruptedTurnIds = new Set<string>();
  const liveTurnIdByThread = new Map<string, string>();
  const pendingInterruptThreads = load("pendingInterruptThreads", { PendingTurnInterrupts: recovery.PendingTurnInterrupts, interruptedTurnIds });
  const deps = { interruptedTurnIds, liveTurnIdByThread, pendingInterruptThreads, turnInterruptedAt: new Map(), tickTurnClock: () => 1 };
  return {
    interruptedTurnIds,
    liveTurnIdByThread,
    started: (threadId: string, botId: string, epoch: number) => pendingInterruptThreads.started?.(threadId, botId, epoch),
    mark: load("markThreadInterrupted", deps),
    bind: load("bindInterruptedTurn", deps),
    stale: load("staleTurnEvent", { interruptedTurnIds, liveTurnIdByThread, settledTurnIdByThread: new Map(), disownedTurnIds: new Set() }),
  };
}

function rig(options: { preparing?: boolean; live?: boolean; error?: Error; rejectBusy?: boolean; room?: boolean; priorRoom?: boolean } = {}) {
  let finishPreparation!: () => void;
  const preparation = new Promise<void>((resolve) => { finishPreparation = resolve; });
  const claims = new Map<string, string>();
  const interrupts = interruptRig();
  let epoch = 0;
  let live = options.live ?? false;
  let summarized = false;
  const starts: string[] = [];
  const frames: Record<string, unknown>[] = [];
  const messages: Message[] = [];
  const bot = {
    id: "bot-1", threadId: "thread-1", busy: false,
    modelSelection: { instanceId: "fake", model: "fake" },
  } as BotRecord;
  const group = { id: "group-1", threadId: bot.threadId, busyBotId: null };
  const groupQueues = new Map<string, Promise<void>>();
  const groupTaskResumes = new Map();
  const operations: { cancelled: boolean }[] = [];
  let finishRoom!: () => void;
  let finishPriorRoom!: () => void;
  if (options.priorRoom) groupQueues.set(group.id, new Promise((resolve) => { finishPriorRoom = resolve; }));
  const store = {
    bot: () => bot,
    botByThread: () => bot,
    conversationForBot: () => ({ bot, group: options.room ? group : undefined }),
    group: () => group,
    groups: [],
    patchBot: (_id: string, patch: Partial<BotRecord>) => Object.assign(bot, patch),
    appendMessage: (_threadId: string, message: Omit<Message, "id" | "at">) => {
      const appended = { ...message, id: `m${messages.length}`, at: 0 };
      messages.push(appended);
      return appended;
    },
    patchMessage: () => null,
  };
  const busyRejection = (message: string) => Object.assign(new Error(message), { status: 409, code: "BOT_BUSY" });
  const botHasActiveTurn = () => claims.size > 0 || bot.busy || live;
  let drainQueuedSends = () => {};
  const paneWake = { settled: vi.fn() };
  let rejectBusy = options.rejectBusy ?? false;
  const startTurn = load("startTurn", {
    store,
    tryClaimTurnStart: (botId: string, threadId: string) => {
      if (claims.has(botId)) return false;
      claims.set(botId, threadId);
      return true;
    },
    busyRejection,
    startClaimedTurn: async (_botId: string, text: string) => {
      const turnEpoch = epoch;
      if (text === "original") {
        await preparation;
        summarized = true;
        if (turnEpoch !== epoch) return;
      }
      if (rejectBusy) {
        rejectBusy = false;
        live = true;
        throw busyRejection("still stopping");
      }
      if (options.error) throw options.error;
      starts.push(text);
      bot.busy = true;
      interrupts.started(bot.threadId, bot.id, turnEpoch);
      interrupts.bind(bot.threadId, `turn-${starts.length}`, bot.id, turnEpoch);
    },
    turnStartClaims: claims,
    queueMicrotask,
    continueQueuedDrainIfIdle,
    drainQueuedSends: () => drainQueuedSends(),
    paneWake,
    botHasActiveTurn,
  });
  const noop = () => {};
  const taskResumes = load("taskResumes", {
    TaskResumeScheduler: recovery.TaskResumeScheduler,
    groupTaskResumes,
    botHasActiveTurn,
    hasQueuedSendBefore,
    store,
    startTurn,
    resumePaneWakes: noop,
    TASK_RESUME_PROMPT: "resume",
    isBusyRejection: (error: { code?: string }) => error?.code === "BOT_BUSY",
    broadcast: (frame: Record<string, unknown>) => frames.push(frame),
    queueMicrotask,
    drainQueuedSends: () => drainQueuedSends(),
    runGroupMemberTurn: async (_groupId: string, _threadId: string, _botId: string, _hop: number, _spoken: Set<string>, prompt: string) => {
      await startTurn(bot.id, prompt, { threadId: bot.threadId });
      await new Promise<void>((resolve) => { finishRoom = resolve; });
    },
  });
  drainQueuedSends = load("drainQueuedSends", {
    taskResumes, store, drainSteeredMessages, continueQueuedDrainIfIdle, startTurn, botHasActiveTurn,
    markChatLatency: noop, drainWaitingOn: noop, commsBus: {}, approvalBus: {}, runDelegatedTurn: noop,
  });
  const startGroupCardContinuation = load("startGroupCardContinuation", {
    groupTaskResumes, groupQueues,
    beginGroupTurnOperation: () => { const operation = { cancelled: false }; operations.push(operation); return operation; },
    finishGroupTurnOperation: () => {},
    drainQueuedSends: () => drainQueuedSends(),
    runGroupMemberTurn: () => startTurn(bot.id, "resume"),
  });
  const invoke = route('/^\\/api\\/bots\\/([\\w-]+)\\/tasks\\/([\\w-]+)\\/resume$/', {
    store, startTurn, taskResumes, queueMark, drainQueuedSends, startGroupCardContinuation,
    groupIsWorking: () => claims.size > 0 || groupTaskResumes.size > 0,
    json: (_res: unknown, status: number, body: unknown) => ({ status, body }),
    taskPacketForWrite: () => ({ flushReason: "stop" }),
    isRecoveryFlushReason: () => true,
    isCompletedTaskRecord: () => false,
    resumePaneWakes: noop,
    TASK_RESUME_PROMPT: "resume",
  });
  const stop = route('/^\\/api\\/bots\\/([\\w-]+)\\/interrupt$/', {
    store, taskResumes, botHasActiveTurn,
    readBody: async () => ({}), routines: { activeRunForBot: () => null },
    registry: { get: () => undefined },
    bumpTurnEpoch: () => ++epoch,
    markThreadInterrupted: interrupts.mark,
    flushInterruptedTask: noop, closeOpenApprovals: noop,
    releaseInterruptedBot: () => { bot.busy = false; },
    json: (_res: unknown, status: number, body: unknown) => ({ status, body }),
  });
  const subscriber = source.slice(source.indexOf('bus.subscribe((event: RuntimeEvent) => {\n  if (event.type !== "turn.completed") return;\n  providerReload.settled'));
  const fold = ts.transpileModule(subscriber.slice(0, subscriber.indexOf('\n});') + 4), {
    compilerOptions: { target: ts.ScriptTarget.ESNext },
  }).outputText;
  let settle!: (event: { type: string; threadId: string }) => void;
  new Function("bus", "providerReload", "drainQueuedSends", "paneWake", "routines", "followPendingSyncImports", "store", "syncMemory", fold)(
    { subscribe: (fn: typeof settle) => { settle = fn; } }, { settled: noop }, drainQueuedSends, paneWake, { tick: noop }, noop, store, noop,
  );
  const deleteBotFully = load("deleteBotFully", {
    registry: { get: () => undefined }, store: { ...store, deleteBot: noop },
    stopScreenPoller: noop, activeVpsThreads: new Map(), routines: { disableForBot: noop }, webhooks: { disableForBot: noop },
    lastReply: new Map(), cancelPeerApprovalsFor: noop, discardDelegations: noop, commsBus: {}, discardDelegationsFrom: noop,
    computerControl: { forget: noop }, paneWake: { forgetBot: noop }, taskResumes,
    perBotLocalVmTarget: () => ({ key: "vm" }), localVmIdles: new Map(),
    EVENTS_DIR: "events", NATIVE_DIR: "native", join: (...parts: string[]) => parts.join("/"), unlinkSync: noop,
  });
  const original = options.preparing ? startTurn(bot.id, "original") : Promise.resolve();
  const stopGroup = route('/^\\/api\\/groups\\/([\\w-]+)\\/interrupt$/', {
    store, taskResumes,
    readBody: async () => ({}),
    cancelGroupTurnOperations: () => operations.forEach((operation) => { operation.cancelled = true; }),
    cancelQueuedRoomParticipations: noop,
    registry: { get: () => undefined },
    closeOpenApprovals: noop,
    json: (_res: unknown, status: number, body: unknown) => ({ status, body }),
  });
  return {
    bot, starts, frames, messages, interrupts,
    resume: () => invoke("/api/bots/bot-1/tasks/thread-1/resume"),
    stop: () => stop("/api/bots/bot-1/interrupt"),
    stopGroup: () => stopGroup("/api/groups/group-1/interrupt"),
    deleteBot: () => deleteBotFully(bot),
    finishPriorRoom: async () => { finishPriorRoom(); await flush(); },
    sendToRoom: (text: string) => {
      const next = (groupQueues.get(group.id) ?? Promise.resolve()).then(async () => { await startTurn(bot.id, text); });
      groupQueues.set(group.id, next);
    },
    finishPreparation: async () => { finishPreparation(); await original; await flush(); },
    settle: async () => { live = false; bot.busy = false; finishRoom?.(); settle({ type: "turn.completed", threadId: bot.threadId }); await flush(); },
    summarized: () => summarized,
  };
}

async function flush() {
  for (let i = 0; i < 12; i++) await Promise.resolve();
}

afterEach(_resetSteerQueue);

describe("task resume during cancelled preparation", () => {
  it("holds Resume until the stopped preparation releases its claim and keeps its summary", async () => {
    const f = rig({ preparing: true });
    await f.stop();
    await expect(f.resume()).resolves.toEqual({ status: 202, body: { ok: true, pending: true } });
    expect(f.starts).toEqual([]);
    await f.finishPreparation();
    expect(f.summarized()).toBe(true);
    expect(f.starts).toEqual(["resume"]);
    await f.settle();
    expect(f.starts).toEqual(["resume"]);
  });

  it("Stop clears a held resume before the cancelled preparation settles", async () => {
    const f = rig({ preparing: true });
    await f.stop();
    expect((await f.resume()).body.pending).toBe(true);
    await f.stop();
    await f.finishPreparation();
    await f.settle();
    expect(f.starts).toEqual([]);
    expect(f.frames).toContainEqual({ kind: "task.resume", botId: f.bot.id, threadId: f.bot.threadId, error: null });
  });

  it("coalesces double clicks to one resumed turn", async () => {
    const f = rig({ preparing: true });
    await f.stop();
    const replies = await Promise.all([f.resume(), f.resume()]);
    expect(replies.map((reply: { body: { pending: boolean } }) => reply.body.pending)).toEqual([true, true]);
    await f.finishPreparation();
    await f.settle();
    expect(f.starts).toEqual(["resume"]);
  });

  it.each([true, false])("runs Resume and a queued send in arrival order, resume first: %s", async (resumeFirst) => {
    const f = rig({ preparing: true });
    await f.stop();
    if (!resumeFirst) queueSteeredMessage(f.bot.id, f.bot.threadId, "queued send");
    expect((await f.resume()).body.pending).toBe(true);
    if (resumeFirst) queueSteeredMessage(f.bot.id, f.bot.threadId, "queued send");
    await f.finishPreparation();
    expect(f.starts).toEqual([resumeFirst ? "resume" : "queued send"]);
    await f.settle();
    expect(f.starts).toEqual(resumeFirst ? ["resume", "queued send"] : ["queued send", "resume"]);
  });

  it("drains after turn.completed when the driver still owns a stopped turn", async () => {
    const f = rig({ live: true });
    expect((await f.resume()).body.pending).toBe(true);
    expect(f.starts).toEqual([]);
    await f.settle();
    await f.settle();
    expect(f.starts).toEqual(["resume"]);
  });

  it("holds a BOT_BUSY rejection and reports real deferred errors", async () => {
    const f = rig({ rejectBusy: true });
    expect((await f.resume()).body.pending).toBe(true);
    await f.settle();
    expect(f.starts).toEqual(["resume"]);
    const failure = rig({ live: true, error: new Error("model unavailable") });
    expect((await failure.resume()).body.pending).toBe(true);
    await failure.settle();
    expect(failure.frames).toContainEqual({ kind: "task.resume", botId: failure.bot.id, threadId: failure.bot.threadId, error: "model unavailable" });
  });

  it("does not let a cancelled earlier send hold Resume behind a later send", async () => {
    const f = rig({ preparing: true });
    await f.stop();
    const earlier = queueSteeredMessage(f.bot.id, f.bot.threadId, "cancel me");
    expect((await f.resume()).body.pending).toBe(true);
    queueSteeredMessage(f.bot.id, f.bot.threadId, "later send");
    cancelSteeredMessage(f.bot.id, earlier.id);
    await f.finishPreparation();
    expect(f.starts).toEqual(["resume"]);
    await f.settle();
    expect(f.starts).toEqual(["resume", "later send"]);
  });

  it("keeps the held resume's reply and completion after preparation bails", async () => {
    const f = rig({ preparing: true });
    await f.stop();
    expect((await f.resume()).body.pending).toBe(true);
    await f.finishPreparation();
    expect(f.starts).toEqual(["resume"]);
    expect(f.interrupts.stale(f.bot.threadId, "turn-1")).toBe(false);
    expect(recovery.turnCompletionDisposition({ eventTurnId: "turn-1", interruptedTurnIds: f.interrupts.interruptedTurnIds, interruptedAt: 1, dispatchedAt: 2 }).interrupted).toBe(false);
  });
});

describe("held room task resume", () => {
  it("waits for a cancelled room operation and stays ahead of the next room send", async () => {
    const f = rig({ room: true, preparing: true, priorRoom: true });
    await f.stop();
    expect((await f.resume()).body.pending).toBe(true);
    f.sendToRoom("later room send");
    await f.finishPreparation();
    expect(f.starts).toEqual([]);
    await f.finishPriorRoom();
    expect(f.starts).toEqual(["resume"]);
    await f.settle();
    expect(f.starts).toEqual(["resume", "later room send"]);
  });

  it("keeps an earlier room operation ahead of Resume and coalesces clicks", async () => {
    const f = rig({ room: true, priorRoom: true });
    f.sendToRoom("earlier room send");
    expect((await f.resume()).body.pending).toBe(true);
    expect((await f.resume()).body.pending).toBe(true);
    await f.finishPriorRoom();
    expect(f.starts).toEqual(["earlier room send"]);
    await f.settle();
    expect(f.starts).toEqual(["earlier room send", "resume"]);
    await f.settle();
    expect(f.starts).toEqual(["earlier room send", "resume"]);
  });

  it("room Stop clears a held resume and releases its queue reservation", async () => {
    const f = rig({ room: true, live: true });
    expect((await f.resume()).body.pending).toBe(true);
    await f.stopGroup();
    await f.settle();
    f.sendToRoom("after Stop");
    await flush();
    expect(f.starts).toEqual(["after Stop"]);
  });

  it("bot delete releases a held resume's queue reservation", async () => {
    const f = rig({ room: true, live: true });
    expect((await f.resume()).body.pending).toBe(true);
    await f.deleteBot();
    f.sendToRoom("after delete");
    await flush();
    expect(f.starts).toEqual(["after delete"]);
  });
});

describe("interrupt ownership", () => {
  it("keeps a newer room turn live when the stopped dispatch returns its id late", () => {
    const threadId = "room-1";
    const f = interruptRig();
    f.started(threadId, "bot-1", 0);
    f.mark(threadId, "bot-1", 0);
    f.liveTurnIdByThread.set(threadId, "new-turn");
    const room = parsed.statements.find((node) => ts.isFunctionDeclaration(node) && node.name?.text === "runClaimedGroupMemberTurn")!;
    let binding!: ts.ArrowFunction;
    function visit(node: ts.Node) {
      if (ts.isArrowFunction(node) && node.body.getText(parsed).includes("bindInterruptedTurn")) binding = node;
      node.forEachChild(visit);
    }
    visit(room);
    const javascript = ts.transpileModule(`const bind = ${binding.getText(parsed)};`, { compilerOptions: { target: ts.ScriptTarget.ESNext } }).outputText;
    new Function("bindInterruptedTurn", "threadId", "bot", "epoch", "currentTurnEpoch", "isCancelled", "liveTurnIdByThread", "reply", `${javascript}\nreturn bind;`)(
      f.bind, threadId, { id: "bot-1" }, 0, () => 1, () => true, f.liveTurnIdByThread, { claim: () => {} },
    )({ turnId: "stopped-turn" });
    expect(f.liveTurnIdByThread.get(threadId)).toBe("new-turn");
    expect(f.stale(threadId, "new-turn")).toBe(false);
    expect(f.interruptedTurnIds.has("stopped-turn")).toBe(true);
  });

  it.each(["thread-1", "room-1"])("does not mark the next turn after Stop during preparation on %s", (threadId) => {
    const f = interruptRig();
    f.mark(threadId, "bot-1", 0);
    f.started(threadId, "bot-1", 1);
    f.bind(threadId, "next-turn", "bot-1", 1);
    expect(f.stale(threadId, "next-turn")).toBe(false);
    expect(recovery.turnCompletionDisposition({ eventTurnId: "next-turn", interruptedTurnIds: f.interruptedTurnIds, interruptedAt: 1, dispatchedAt: 2 }).interrupted).toBe(false);
  });

  it.each(["thread-1", "room-1"])("binds Stop to its dispatched epoch when a newer turn id arrives first on %s", (threadId) => {
    const f = interruptRig();
    f.started(threadId, "bot-1", 0);
    f.mark(threadId, "bot-1", 0);
    f.started(threadId, "bot-1", 1);
    f.bind(threadId, "new-turn", "bot-1", 1);
    expect(f.stale(threadId, "new-turn")).toBe(false);
    f.bind(threadId, "stopped-turn", "bot-1", 0);
    expect(f.stale(threadId, "stopped-turn")).toBe(true);
    expect(f.interruptedTurnIds.has("stopped-turn")).toBe(true);
  });
});
