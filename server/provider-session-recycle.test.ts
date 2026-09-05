import { mkdirSync } from "node:fs";
import { beforeEach, describe, expect, it } from "vitest";

import { DATA_DIR } from "./config.ts";
import { knownCatalogContextWindow, prepareModelContext } from "./context-compaction.ts";
import { closeMessageDb } from "./message-db.ts";
import { Store } from "./store.ts";
import { removeTempDir } from "./testing/cleanup.ts";
import {
  buildTurnContext,
  countLastTurnToolRounds,
  countSessionToolRounds,
  engineIsFresh,
  nativeSessionTokenBudget,
  PRE_COMPACT_TOOL_ROUND_LIMIT,
  shouldRecycleProviderSession,
} from "./turn-context.ts";

describe("provider session recycle after Orbit compaction", () => {
  // Close SQLite before wiping DATA_DIR — Windows EPERM-locks an open
  // messages.db, and a naked afterEach rmSync races the global close hook.
  beforeEach(async () => {
    closeMessageDb();
    await removeTempDir(DATA_DIR);
    mkdirSync(DATA_DIR, { recursive: true });
  });

  it("does not resume a stale Claude cursor once Orbit compacted the thread", async () => {
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
      replaysNatively: false,
    });

    expect(recycled).toBe(true);
    expect(resume).toBe(false);
    expect(turnText).toContain("Orbit compacted this conversation");
    expect(turnText).toContain("[Orbit durable context summary]");
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
      replaysNatively: false,
    });
    expect(nextFresh).toBe(true);
    expect(nextRecycled).toBe(true);
    expect(next.resume).toBe(false);
    expect(next.turnText).toContain("Orbit compacted this conversation");
    expect(next.turnText).not.toContain("joining this conversation");
  });

  it("still resumes Stop recovery when Orbit has not compacted yet", () => {
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
    expect(out.turnText).toContain("Orbit task record");
    expect(out.turnText).not.toContain("Orbit compacted this conversation");
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
    expect(turnText).not.toContain("Orbit compacted this conversation");
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
    expect(out.turnText).toContain("Orbit task record");
    expect(out.turnText).not.toContain("fresh provider session");
    expect(store.taskByThread(bot.id, bot.threadId)?.resumeCursors.claude).toBe("fat-soak-session");
  });

  it("does not recycle a short Claude turn from lastInput against the 16k catalog fallback", () => {
    const catalog = { default: "claude-sonnet-5", options: [{ id: "claude-sonnet-5", label: "Sonnet" }] };
    const knownWindow = knownCatalogContextWindow(catalog, "claude-sonnet-5");
    expect(knownWindow).toBeNull();
    expect(shouldRecycleProviderSession({
      compacted: false,
      lastTurnToolRounds: 2,
      sessionToolRounds: 2,
      lastTurnInputTokens: 20_000,
      nativeTokenBudget: knownWindow ? nativeSessionTokenBudget(knownWindow) : 0,
    })).toBe(false);
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
});
