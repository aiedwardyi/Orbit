import { mkdirSync, rmSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { DATA_DIR } from "./config.ts";
import { prepareModelContext } from "./context-compaction.ts";
import { Store } from "./store.ts";
import {
  buildTurnContext,
  engineIsFresh,
  shouldRecycleProviderSession,
} from "./turn-context.ts";

describe("provider session recycle after Orbit compaction", () => {
  beforeEach(() => {
    rmSync(DATA_DIR, { recursive: true, force: true });
    mkdirSync(DATA_DIR, { recursive: true });
  });

  afterEach(() => {
    rmSync(DATA_DIR, { recursive: true, force: true });
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
});
