import { mkdirSync } from "node:fs";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { DATA_DIR } from "./config.ts";
import { knownCatalogContextWindow, prepareModelContext, supersededCompactionIds } from "./context-compaction.ts";
import { STATIC_CLAUDE_MODELS } from "./drivers/claude.ts";
import { closeMessageDb } from "./message-db.ts";
import { Store } from "./store.ts";
import { removeTempDir } from "./testing/cleanup.ts";
import {
  buildTurnContext,
  countLastTurnToolRounds,
  countSessionToolRounds,
  engineIsFresh,
  nativeSessionTokenBudget,
  PRE_COMPACT_SESSION_TOOL_ROUND_LIMIT,
  PRE_COMPACT_TOOL_ROUND_LIMIT,
  resumeSessionUnseeded,
  sessionPromptFor,
  shouldRecycleProviderSession,
} from "./turn-context.ts";

// The recycle check a user send runs, built from the store the way index.ts does.
function recycleOnSend(store: Store, botId: string, threadId: string, sendId: string, instanceId = "claude", model = "claude-opus-5-5") {
  const task = store.taskByThread(botId, threadId)!;
  const messages = store.activePath(threadId);
  const excludeIds = new Set([sendId]);
  return shouldRecycleProviderSession({
    compacted: false,
    lastTurnToolRounds: countLastTurnToolRounds(messages, excludeIds, task.providerSessionBoundId),
    sessionToolRounds: countSessionToolRounds(messages, excludeIds, task.providerSessionBoundId),
    sessionPrompt: sessionPromptFor({
      report: task.nativePrompt,
      cursor: task.resumeCursors[instanceId],
      model,
      catalogWindow: knownCatalogContextWindow(STATIC_CLAUDE_MODELS, model),
    }),
  });
}

function appendTools(store: Store, threadId: string, count: number) {
  for (let i = 0; i < count; i++) {
    store.appendMessage(threadId, { role: "bot", kind: "activity", tool: { name: `Read: file-${i}.ts`, ok: true } });
  }
}

describe("provider session recycle after Wink compaction", () => {
  // Close SQLite before wiping DATA_DIR — Windows EPERM-locks an open
  // messages.db, and a naked afterEach rmSync races the global close hook.
  beforeEach(async () => {
    closeMessageDb();
    await removeTempDir(DATA_DIR);
    mkdirSync(DATA_DIR, { recursive: true });
  });

  it("does not resume a stale Claude cursor once Wink compacted the thread", async () => {
    const store = new Store(() => ({ instanceId: "claude", model: "claude-sonnet-5" }));
    const bot = store.createBot({}, { seedMessages: false });
    const old = store.appendMessage(bot.threadId, { role: "user", kind: "text", text: "old work produced report.json" });
    const recent = store.appendMessage(bot.threadId, { role: "bot", kind: "text", text: "recent verification passed" });
    store.appendCompaction(bot.threadId, {
      v: 1,
      summary: "Earlier work produced report.json and the installer.",
      coveredThroughId: old.id,
      firstKeptId: recent.id,
      contextWindow: 8_192,
      estimatedTokensBefore: 900,
      sourceMessageCount: 1,
    });
    store.setResumeCursor(bot.id, "claude", "fat-session-abc", bot.threadId);
    store.markTaskDispatched(bot.id, bot.threadId, "claude", "claude-sonnet-5");

    const task = store.taskByThread(bot.id, bot.threadId)!;
    const prepared = await prepareModelContext({
      messages: store.activePath(bot.threadId),
      contextWindow: 8_192,
      taskRecordText: "Goal: Ship the release",
    });
    expect(prepared.status).toBe("ready");
    if (prepared.status !== "ready") return;

    const fresh = engineIsFresh({
      instanceId: "claude",
      model: "claude-sonnet-5",
      lastInstanceId: task.lastInstanceId,
      lastModel: task.lastModel,
      sessionModelSwitch: "in-session",
      resumeCursors: task.resumeCursors,
      transcript: prepared.transcript,
      hasPriorUserTurn: true,
    });
    expect(fresh).toBe(false);
    expect(task.resumeCursors.claude).toBe("fat-session-abc");

    const recycled = shouldRecycleProviderSession({ compacted: prepared.compacted, rewound: false });
    const { resume, turnText } = buildTurnContext({
      text: "continue the release",
      transcript: prepared.transcript,
      rewound: false,
      fresh,
      recycled,
      recycleReason: recycled ? "compaction" : undefined,
      replaysNatively: false,
    });

    expect(recycled).toBe(true);
    expect(resume).toBe(false);
    expect(turnText).toContain("Wink compacted this conversation");
    expect(turnText).toContain("[Wink durable context summary]");
    expect(turnText).toContain("recent verification passed");
    expect(turnText.endsWith("continue the release")).toBe(true);

    store.clearResumeCursors(bot.id, bot.threadId);
    expect(store.taskByThread(bot.id, bot.threadId)?.resumeCursors.claude).toBeUndefined();
    expect(store.bot(bot.id)?.resumeCursors.claude).toBeUndefined();

    const nextTask = store.taskByThread(bot.id, bot.threadId)!;
    const nextFresh = engineIsFresh({
      instanceId: "claude",
      model: "claude-sonnet-5",
      lastInstanceId: nextTask.lastInstanceId,
      lastModel: nextTask.lastModel,
      sessionModelSwitch: "in-session",
      resumeCursors: nextTask.resumeCursors,
      transcript: prepared.transcript,
      hasPriorUserTurn: true,
    });
    const nextRecycled = shouldRecycleProviderSession({ compacted: prepared.compacted, rewound: false });
    const next = buildTurnContext({
      text: "and then ship it",
      transcript: prepared.transcript,
      rewound: false,
      fresh: nextFresh,
      recycled: nextRecycled,
      recycleReason: nextRecycled ? "compaction" : undefined,
      replaysNatively: false,
    });
    expect(nextFresh).toBe(true);
    expect(nextRecycled).toBe(true);
    expect(next.resume).toBe(false);
    expect(next.turnText).toContain("Wink compacted this conversation");
    expect(next.turnText).not.toContain("joining this conversation");
  });

  it("still resumes Stop recovery when Wink has not compacted yet", () => {
    const resume = shouldRecycleProviderSession({ compacted: false, rewound: false });
    const out = buildTurnContext({
      text: "continue",
      transcript: [{ role: "user", text: "keep going" }],
      rewound: false,
      fresh: false,
      recycled: resume,
      replaysNatively: false,
      recovering: true,
      taskRecord: {
        goal: "Keep going",
        plan: [],
        completed: [],
        blockers: [],
        nextAction: "Keep going",
      },
    });
    expect(out.resume).toBe(true);
    expect(out.turnText).toContain("Wink task record");
    expect(out.turnText).not.toContain("Wink compacted this conversation");
  });

  it("recycles a fat uncompacted Claude soak on the next user send", async () => {
    const store = new Store(() => ({ instanceId: "claude", model: "claude-sonnet-5" }));
    const bot = store.createBot({}, { seedMessages: false });
    const ask = store.appendMessage(bot.threadId, { role: "user", kind: "text", text: "inspect the tree" });
    for (let i = 0; i < PRE_COMPACT_TOOL_ROUND_LIMIT; i++) {
      store.appendMessage(bot.threadId, {
        role: "bot",
        kind: "activity",
        tool: { name: `Read: file-${i}.ts`, ok: true },
      });
    }
    store.appendMessage(bot.threadId, { role: "bot", kind: "text", text: "tree inspected" });
    const next = store.appendMessage(bot.threadId, { role: "user", kind: "text", text: "now commit" });
    store.setResumeCursor(bot.id, "claude", "fat-soak-session", bot.threadId);
    store.markTaskDispatched(bot.id, bot.threadId, "claude", "claude-sonnet-5");
    store.addTaskUsage(bot.id, bot.threadId, { input: 90_000, output: 800, costUsd: null });

    const prepared = await prepareModelContext({
      messages: store.activePath(bot.threadId),
      contextWindow: 200_000,
      taskRecordText: "Goal: Inspect then commit",
      excludeIds: new Set([next.id]),
    });
    expect(prepared.status).toBe("ready");
    if (prepared.status !== "ready") return;
    expect(prepared.compacted).toBe(false);

    const lastTurnToolRounds = countLastTurnToolRounds(store.activePath(bot.threadId), new Set([next.id]));
    const sessionToolRounds = countSessionToolRounds(store.activePath(bot.threadId), new Set([next.id]));
    expect(lastTurnToolRounds).toBe(PRE_COMPACT_TOOL_ROUND_LIMIT);
    expect(sessionToolRounds).toBe(PRE_COMPACT_TOOL_ROUND_LIMIT);

    const recycled = shouldRecycleProviderSession({
      compacted: prepared.compacted,
      rewound: false,
      recovering: false,
      lastTurnToolRounds,
      sessionToolRounds,
      lastTurnInputTokens: store.taskByThread(bot.id, bot.threadId)?.usage?.lastInput,
      nativeTokenBudget: nativeSessionTokenBudget(200_000),
    });
    const { resume, turnText } = buildTurnContext({
      text: "now commit",
      transcript: prepared.transcript,
      rewound: false,
      fresh: false,
      recycled,
      recycleReason: recycled && !prepared.compacted ? "session-fat" : undefined,
      replaysNatively: false,
    });

    expect(recycled).toBe(true);
    expect(resume).toBe(false);
    expect(turnText).toContain("fresh provider session");
    expect(turnText).not.toContain("Wink compacted this conversation");
    expect(turnText).toContain("tree inspected");
    expect(ask.text).toBe("inspect the tree");

    store.clearResumeCursors(bot.id, bot.threadId);
    expect(store.taskByThread(bot.id, bot.threadId)?.resumeCursors.claude).toBeUndefined();
  });

  it("keeps native resume after Stop on the same uncompacted fat soak", async () => {
    const store = new Store(() => ({ instanceId: "claude", model: "claude-sonnet-5" }));
    const bot = store.createBot({}, { seedMessages: false });
    store.appendMessage(bot.threadId, { role: "user", kind: "text", text: "inspect the tree" });
    for (let i = 0; i < PRE_COMPACT_TOOL_ROUND_LIMIT; i++) {
      store.appendMessage(bot.threadId, {
        role: "bot",
        kind: "activity",
        tool: { name: `Read: file-${i}.ts`, ok: true },
      });
    }
    const next = store.appendMessage(bot.threadId, { role: "user", kind: "text", text: "continue" });
    store.setResumeCursor(bot.id, "claude", "fat-soak-session", bot.threadId);
    store.markTaskDispatched(bot.id, bot.threadId, "claude", "claude-sonnet-5");

    const prepared = await prepareModelContext({
      messages: store.activePath(bot.threadId),
      contextWindow: 200_000,
      taskRecordText: "Goal: Inspect then commit",
      excludeIds: new Set([next.id]),
    });
    expect(prepared.status).toBe("ready");
    if (prepared.status !== "ready") return;

    const recycled = shouldRecycleProviderSession({
      compacted: prepared.compacted,
      rewound: false,
      recovering: true,
      lastTurnToolRounds: countLastTurnToolRounds(store.activePath(bot.threadId), new Set([next.id])),
      sessionToolRounds: countSessionToolRounds(store.activePath(bot.threadId), new Set([next.id])),
      lastTurnInputTokens: 90_000,
      nativeTokenBudget: nativeSessionTokenBudget(200_000),
    });
    const out = buildTurnContext({
      text: "continue",
      transcript: prepared.transcript,
      rewound: false,
      fresh: false,
      recycled,
      recycleReason: recycled && !prepared.compacted ? "session-fat" : undefined,
      replaysNatively: false,
      recovering: true,
      taskRecord: {
        goal: "Inspect then commit",
        plan: [],
        completed: [],
        blockers: [],
        nextAction: "Continue the soak",
      },
    });

    expect(prepared.compacted).toBe(false);
    expect(recycled).toBe(false);
    expect(out.resume).toBe(true);
    expect(out.turnText).toContain("Wink task record");
    expect(out.turnText).not.toContain("fresh provider session");
    expect(store.taskByThread(bot.id, bot.threadId)?.resumeCursors.claude).toBe("fat-soak-session");
  });

  it("leaves the native budget off for a driver whose input is an invocation total", () => {
    // Claude's catalog now states 200k, but its turn `input` sums every tool
    // round's cache read, so the window comparison stays gated off.
    const knownWindow = knownCatalogContextWindow(STATIC_CLAUDE_MODELS, "claude-sonnet-5-5");
    expect(knownWindow).toBe(200_000);
    const gated = (turnInputIsPromptSize: boolean) =>
      shouldRecycleProviderSession({
        compacted: false,
        lastTurnToolRounds: 2,
        sessionToolRounds: 2,
        lastTurnInputTokens: 300_000,
        nativeTokenBudget:
          turnInputIsPromptSize && knownWindow ? nativeSessionTokenBudget(knownWindow) : 0,
      });
    expect(gated(false)).toBe(false);
    expect(gated(true)).toBe(true);
  });

  it("resumes a slim follow-up after a session-fat recycle watermark", async () => {
    const store = new Store(() => ({ instanceId: "claude", model: "claude-sonnet-5" }));
    const bot = store.createBot({}, { seedMessages: false });
    store.appendMessage(bot.threadId, { role: "user", kind: "text", text: "inspect the tree" });
    for (let i = 0; i < PRE_COMPACT_TOOL_ROUND_LIMIT; i++) {
      store.appendMessage(bot.threadId, {
        role: "bot",
        kind: "activity",
        tool: { name: `Read: file-${i}.ts`, ok: true },
      });
    }
    const recycledSend = store.appendMessage(bot.threadId, { role: "user", kind: "text", text: "now commit" });
    store.setResumeCursor(bot.id, "claude", "new-session", bot.threadId);
    store.markTaskDispatched(bot.id, bot.threadId, "claude", "claude-sonnet-5");
    store.addTaskUsage(bot.id, bot.threadId, { input: 12_000, output: 200, costUsd: null });
    store.markProviderSessionBound(bot.id, bot.threadId, recycledSend.id);

    const followUp = store.appendMessage(bot.threadId, { role: "user", kind: "text", text: "and push" });
    const excludeIds = new Set([followUp.id]);
    const sessionToolRounds = countSessionToolRounds(
      store.activePath(bot.threadId),
      excludeIds,
      store.taskByThread(bot.id, bot.threadId)?.providerSessionBoundId,
    );
    expect(sessionToolRounds).toBe(0);
    expect(store.taskByThread(bot.id, bot.threadId)?.usage?.lastInput).toBeUndefined();
    expect(shouldRecycleProviderSession({
      compacted: false,
      lastTurnToolRounds: countLastTurnToolRounds(store.activePath(bot.threadId), excludeIds),
      sessionToolRounds,
      lastTurnInputTokens: store.taskByThread(bot.id, bot.threadId)?.usage?.lastInput,
      nativeTokenBudget: 0,
    })).toBe(false);
  });

  it("resumes the next pane wake after a pane-wake recycle", async () => {
    const store = new Store(() => ({ instanceId: "claude", model: "claude-sonnet-5" }));
    const bot = store.createBot({}, { seedMessages: false });
    store.appendMessage(bot.threadId, { role: "user", kind: "text", text: "run the workers" });
    for (let i = 0; i < PRE_COMPACT_SESSION_TOOL_ROUND_LIMIT; i++) {
      store.appendMessage(bot.threadId, {
        role: "bot",
        kind: "activity",
        tool: { name: `Read: file-${i}.ts`, ok: true },
      });
    }
    const note = store.appendMessage(bot.threadId, { role: "bot", kind: "note", text: "[pane] DONE" });
    store.markProviderSessionBound(bot.id, bot.threadId, store.activePath(bot.threadId).at(-1)!.id);
    store.appendMessage(bot.threadId, { role: "bot", kind: "activity", tool: { name: "Bash: git log", ok: true } });

    const messages = store.activePath(bot.threadId);
    const boundId = store.taskByThread(bot.id, bot.threadId)?.providerSessionBoundId;
    expect(boundId).toBe(note.id);
    expect(shouldRecycleProviderSession({
      compacted: false,
      lastTurnToolRounds: countLastTurnToolRounds(messages, undefined, boundId),
      sessionToolRounds: countSessionToolRounds(messages, undefined, boundId),
      nativeTokenBudget: 0,
    })).toBe(false);
  });
});

describe("provider session recycle by native prompt size", () => {
  beforeEach(async () => {
    closeMessageDb();
    await removeTempDir(DATA_DIR);
    mkdirSync(DATA_DIR, { recursive: true });
  });

  it("resumes a 30-tool Claude turn whose native prompt is only 80k", () => {
    const store = new Store(() => ({ instanceId: "claude", model: "claude-opus-5-5" }));
    const bot = store.createBot({}, { seedMessages: false });
    store.appendMessage(bot.threadId, { role: "user", kind: "text", text: "inspect the tree" });
    appendTools(store, bot.threadId, 30);
    store.appendMessage(bot.threadId, { role: "bot", kind: "text", text: "tree inspected" });
    const send = store.appendMessage(bot.threadId, { role: "user", kind: "text", text: "now commit" });
    store.setResumeCursor(bot.id, "claude", "warm-session", bot.threadId);
    store.markTaskDispatched(bot.id, bot.threadId, "claude", "claude-opus-5-5");
    store.recordNativePrompt(bot.id, bot.threadId, "claude", { first: 40_000, last: 80_000 }, 1_000_000);

    const recycled = recycleOnSend(store, bot.id, bot.threadId, send.id);
    const { resume, turnText } = buildTurnContext({
      text: "now commit",
      transcript: [],
      rewound: false,
      fresh: false,
      recycled,
      replaysNatively: false,
    });
    expect(recycled).toBe(false);
    expect(resume).toBe(true);
    expect(turnText).toBe("now commit");
  });

  it("recycles a 260k session, and the first send after it never recycles again", () => {
    const store = new Store(() => ({ instanceId: "claude", model: "claude-opus-5-5" }));
    const bot = store.createBot({}, { seedMessages: false });
    store.appendMessage(bot.threadId, { role: "user", kind: "text", text: "read the logs" });
    appendTools(store, bot.threadId, 3);
    store.appendMessage(bot.threadId, { role: "bot", kind: "text", text: "logs read" });
    store.setResumeCursor(bot.id, "claude", "fat-session", bot.threadId);
    store.markTaskDispatched(bot.id, bot.threadId, "claude", "claude-opus-5-5");
    store.recordNativePrompt(bot.id, bot.threadId, "claude", { first: 45_000, last: 260_000 }, 1_000_000);

    const recycling = store.appendMessage(bot.threadId, { role: "user", kind: "text", text: "now fix it" });
    expect(recycleOnSend(store, bot.id, bot.threadId, recycling.id)).toBe(true);
    // what index.ts does on that recycle
    store.clearResumeCursors(bot.id, bot.threadId);
    store.markProviderSessionBound(bot.id, bot.threadId, recycling.id);

    // the replayed turn died before any model call: the 260k belonged to the dropped session
    const early = store.appendMessage(bot.threadId, { role: "user", kind: "text", text: "still there?" });
    expect(recycleOnSend(store, bot.id, bot.threadId, early.id)).toBe(false);

    // the new session opened on the replay and ran a 30-tool turn
    store.setResumeCursor(bot.id, "claude", "replay-session", bot.threadId);
    appendTools(store, bot.threadId, 30);
    store.appendMessage(bot.threadId, { role: "bot", kind: "text", text: "fixed" });
    store.recordNativePrompt(bot.id, bot.threadId, "claude", { first: 140_000, last: 200_000 }, 1_000_000);
    const next = store.appendMessage(bot.threadId, { role: "user", kind: "text", text: "and test it" });
    expect(store.taskByThread(bot.id, bot.threadId)?.nativePrompt).toMatchObject({ cursor: "replay-session", first: 140_000 });
    expect(recycleOnSend(store, bot.id, bot.threadId, next.id)).toBe(false);
  });

  it("holds the loop guard for a 200k-window model whose replay alone passes the budget", () => {
    const model = "claude-haiku-4-5";
    const store = new Store(() => ({ instanceId: "claude", model }));
    const bot = store.createBot({}, { seedMessages: false });
    store.appendMessage(bot.threadId, { role: "user", kind: "text", text: "pick up the release" });
    store.setResumeCursor(bot.id, "claude", "replay-1", bot.threadId);
    store.markTaskDispatched(bot.id, bot.threadId, "claude", model);
    const send = (text: string) => store.appendMessage(bot.threadId, { role: "user", kind: "text", text }).id;

    // budget 100k; the replay opened this session at 110k
    store.recordNativePrompt(bot.id, bot.threadId, "claude", { first: 110_000, last: 110_000 }, 200_000);
    expect(recycleOnSend(store, bot.id, bot.threadId, send("one"), "claude", model)).toBe(false);
    store.recordNativePrompt(bot.id, bot.threadId, "claude", { first: 150_000, last: 150_000 }, 200_000);
    expect(store.taskByThread(bot.id, bot.threadId)?.nativePrompt?.first).toBe(110_000);
    expect(recycleOnSend(store, bot.id, bot.threadId, send("two"), "claude", model)).toBe(false);
    store.recordNativePrompt(bot.id, bot.threadId, "claude", { first: 152_000, last: 165_000 }, 200_000);
    const recycling = send("three");
    expect(recycleOnSend(store, bot.id, bot.threadId, recycling, "claude", model)).toBe(true);

    store.clearResumeCursors(bot.id, bot.threadId);
    store.markProviderSessionBound(bot.id, bot.threadId, recycling);
    store.setResumeCursor(bot.id, "claude", "replay-2", bot.threadId);
    store.recordNativePrompt(bot.id, bot.threadId, "claude", { first: 112_000, last: 118_000 }, 200_000);
    expect(recycleOnSend(store, bot.id, bot.threadId, send("four"), "claude", model)).toBe(false);
  });

  it("keeps the 24/48 tool rules for an engine that reports no prompt size", () => {
    const store = new Store(() => ({ instanceId: "grok", model: "grok-4.6" }));
    const bot = store.createBot({}, { seedMessages: false });
    store.appendMessage(bot.threadId, { role: "user", kind: "text", text: "inspect the tree" });
    appendTools(store, bot.threadId, PRE_COMPACT_TOOL_ROUND_LIMIT);
    store.appendMessage(bot.threadId, { role: "bot", kind: "text", text: "tree inspected" });
    const send = store.appendMessage(bot.threadId, { role: "user", kind: "text", text: "now commit" });
    store.setResumeCursor(bot.id, "grok", "grok-session", bot.threadId);
    store.setResumeCursor(bot.id, "claude", "claude-session", bot.threadId);
    store.markTaskDispatched(bot.id, bot.threadId, "claude", "claude-opus-5-5");
    store.recordNativePrompt(bot.id, bot.threadId, "claude", { first: 40_000, last: 90_000 }, 1_000_000);

    expect(recycleOnSend(store, bot.id, bot.threadId, send.id, "grok", "grok-4.6")).toBe(true);
    expect(recycleOnSend(store, bot.id, bot.threadId, send.id)).toBe(false);
  });
});

describe("summary repair across native recycles", () => {
  const NOTICE = "Model summary unavailable; full transcript retained by Wink.";
  // Pokkey's overnight session-fat resets on 10-13 (FINDINGS reset ledger).
  const POKKEY_PROMPTS = [
    [119_050, 316_610],
    [124_648, 254_457],
    [126_430, 265_974],
    [132_666, 250_399],
    [134_660, 258_696],
    [135_271, 261_267],
    [137_524, 287_334],
    [137_784, 265_374],
    [138_926, 260_364],
  ] as const;

  beforeEach(async () => {
    closeMessageDb();
    await removeTempDir(DATA_DIR);
    mkdirSync(DATA_DIR, { recursive: true });
  });

  it("Pokkey 10-13: a timed-out summary replays unchanged across nine session-fat recycles, then repair replaces it", async () => {
    const warning = vi.spyOn(console, "warn").mockImplementation(() => {});
    const info = vi.spyOn(console, "info").mockImplementation(() => {});
    try {
      const store = new Store(() => ({ instanceId: "claude", model: "claude-opus-5-5" }));
      const bot = store.createBot({}, { seedMessages: false });
      const threadId = bot.threadId;
      const say = (index: number, role: "user" | "bot") =>
        store.appendMessage(threadId, { role, kind: "text", text: `${role === "user" ? "request" : "outcome"} ${index}: ${"shop detail ".repeat(8)}` });
      const prepare = (summarize?: (prompt: string) => Promise<string>) =>
        prepareModelContext({ messages: store.activePath(threadId), contextWindow: 200_000, taskRecordText: "Goal: ship the shop", summarize });
      const replayed = (transcript: Array<{ role: "user" | "assistant"; text: string }>) =>
        buildTurnContext({ text: "continue", transcript, rewound: false, fresh: false, recycled: true, recycleReason: "session-fat", replaysNatively: false }).turnText;

      // 1. model summary G
      for (let index = 0; index < 70; index++) {
        say(index, "user");
        say(index, "bot");
      }
      const first = await prepare(async () => "SUMMARY\nG: QA, patent and swipe decisions");
      if (first.status !== "ready" || !first.compaction) throw new Error("expected a model summary");
      const good = store.appendCompaction(threadId, first.compaction);

      // 2. the 22:27 summarizer timeout saves the fallback F
      for (let index = 70; index < 140; index++) {
        say(index, "user");
        say(index, "bot");
      }
      const failed = await prepare(async () => {
        throw new Error("Claude review timed out");
      });
      if (failed.status !== "ready" || !failed.compaction) throw new Error("expected a fallback summary");
      expect(failed.compaction.summary.startsWith(NOTICE)).toBe(true);
      const fallback = store.appendCompaction(threadId, failed.compaction);
      const fallbackText = failed.compaction.summary;

      // 3. nine session-fat recycles each replay F verbatim
      store.markTaskDispatched(bot.id, threadId, "claude", "claude-opus-5-5");
      for (const [index, [firstPrompt, lastPrompt]] of POKKEY_PROMPTS.entries()) {
        store.setResumeCursor(bot.id, "claude", `session-${index}`, threadId);
        store.recordNativePrompt(bot.id, threadId, "claude", { first: firstPrompt, last: lastPrompt }, 1_000_000);
        const send = say(200 + index, "user");
        expect(recycleOnSend(store, bot.id, threadId, send.id)).toBe(true);
        const summarize = vi.fn(async () => "SUMMARY\nnever");
        const prepared = await prepare(summarize);
        if (prepared.status !== "ready") throw new Error(prepared.status);
        expect(summarize).not.toHaveBeenCalled();
        expect(prepared.compactionId).toBe(fallback.id);
        expect(replayed(prepared.transcript)).toContain(fallbackText);
        store.clearResumeCursors(bot.id, threadId);
        store.markProviderSessionBound(bot.id, threadId, send.id);
        say(200 + index, "bot");
      }
      // the session the ninth recycle opened is seeded on F
      store.setResumeCursor(bot.id, "claude", "session-9", threadId);
      store.markResumeSeeded(bot.id, threadId, { instanceId: "claude", cursor: "session-9", compactionId: fallback.id });
      store.recordNativePrompt(bot.id, threadId, "claude", { first: 138_926, last: 150_000 }, 1_000_000);

      // 4. repair after the turn settles rebuilds from G and the original lines
      const prompts: string[] = [];
      const { createSummaryRepair } = await import("./summary-repair.ts");
      const repair = createSummaryRepair({
        store,
        instanceFor: async () => ({
          driverKind: "claude",
          textModel: "claude-haiku-5-5",
          textTimeoutMs: 90_000,
          generateText: async (prompt: string) => {
            prompts.push(prompt);
            return "SUMMARY\nRepaired: QA, patents, swipe, shop meals and gifts";
          },
        }),
        busy: () => false,
        taskRecordText: () => "Goal: ship the shop",
        userName: () => "User",
      });
      repair.onSettled(bot.id, threadId);
      await repair.idle();
      expect(prompts.length).toBeGreaterThan(0);
      expect(prompts[0]).toContain("G: QA, patent and swipe decisions");
      expect(prompts.join("\n")).toContain("request 70:");
      expect(prompts.join("\n")).not.toContain(NOTICE);
      const path = store.activePath(threadId);
      const repaired = path.findLast((item) => item.kind === "compaction")!;
      expect(repaired.id).not.toBe(fallback.id);
      expect(repaired.compaction).toMatchObject({
        coveredThroughId: failed.compaction.coveredThroughId,
        previousCompactionId: good.id,
      });

      // 6. the session seeded on F stays resumable: no forced recycle
      const task = store.taskByThread(bot.id, threadId)!;
      expect(resumeSessionUnseeded({
        instanceId: "claude",
        cursor: task.resumeCursors.claude,
        seed: task.resumeSeed,
        latestCompactionId: repaired.id,
        supersededIds: supersededCompactionIds(path, repaired.id),
      })).toBe(false);
      expect(recycleOnSend(store, bot.id, threadId, say(300, "user").id)).toBe(false);

      // 5. the next recycle replays R, not the notice
      say(300, "bot");
      store.recordNativePrompt(bot.id, threadId, "claude", { first: 138_926, last: 290_000 }, 1_000_000);
      expect(recycleOnSend(store, bot.id, threadId, say(301, "user").id)).toBe(true);
      const next = await prepare();
      if (next.status !== "ready") throw new Error(next.status);
      expect(next.compactionId).toBe(repaired.id);
      const turnText = replayed(next.transcript);
      expect(turnText).toContain("Repaired: QA, patents, swipe, shop meals and gifts");
      expect(turnText).not.toContain(NOTICE);
    } finally {
      warning.mockRestore();
      info.mockRestore();
    }
  });
});
