import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { estimateContextTokens, paneNotesForTurn, planCompaction, planSummaryGrace, prepareModelContext, routineCardsSinceLastUserTurn, withoutTurnNotes } from "./context-compaction.ts";
import { composeUserTurnPrompt, userTurnReactionKeys } from "./replies.ts";
import { _resetSteerQueue, foldQueuedSends, queueMark, queueSteeredMessage } from "./steer-queue.ts";
import type { Message } from "./store.ts";
import { createSummaryBuild, type SummaryWait } from "./summary-build.ts";
import { buildResumeFallback, buildTurnContext, withSystemChanges } from "./turn-context.ts";
import type { ContextCompactionV1 } from "../shared/context-compaction.ts";

// Execute the production folds and dispatch without booting the server.
const source = readFileSync(new URL("./index.ts", import.meta.url), "utf8");
const preparation = source.slice(source.indexOf("  const folded = currentTurnEpoch"), source.indexOf("\n  const persona = [", source.indexOf("  const folded = currentTurnEpoch")));
const marker = "const started = await dispatchAdapterTurn(threadId, async () => {";
const start = source.indexOf(marker) + marker.length;
const dispatch = source.slice(start, source.indexOf("\n      });\n      bindInterruptedTurn", start)).replace("(base: string)", "(base)");
const runDispatch = new Function("scope", `with (scope) { return (async () => {${preparation}\nreturn (async () => {${dispatch}})();})(); }`);

beforeEach(() => {
  vi.useFakeTimers();
  vi.spyOn(console, "info").mockImplementation(() => {});
});

afterEach(() => {
  _resetSteerQueue();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("summary grace dispatch", () => {
  it.each([
    ["preparation", "paste", true],
    ["dispatch", "paste", false],
    ["preparation", "image", false],
    ["dispatch", "image", true],
  ] as const)("waits after the %s fold adds a late %s (pinned system %s)", async (fold, kind, pinnedSystem) => {
    const messages: Message[] = Array.from({ length: 70 }, (_, index) => [
      { id: `u${index}`, at: index * 2, role: "user", kind: "text", text: `request ${index}` },
      { id: `b${index}`, at: index * 2 + 1, role: "bot", kind: "text", text: `outcome ${index} ${"x".repeat(420)}` },
    ] as Message[]).flat();
    const taskRecordText = "Goal: preserve context";
    const generateText = vi.fn(() => new Promise<string>((resolve) => setTimeout(() => resolve("SUMMARY\nretained decisions"), 80_000)));
    const instance = { driverKind: "claude", generateText, textTimeoutMs: 90_000 };
    const store = {
      activePath: () => [...messages],
      activeLeaf: () => messages.at(-1)?.id ?? null,
      messagesFor: () => messages,
      appendMessage: (_threadId: string, row: Omit<Message, "id" | "at">) => {
        const saved = { ...row, id: `m${messages.length}`, at: 1 };
        messages.push(saved);
        return saved;
      },
      appendCompaction: (_threadId: string, compaction: ContextCompactionV1) => {
        const saved: Message = { id: "summary", at: 1, role: "bot", kind: "compaction", compaction };
        messages.push(saved);
        return saved;
      },
      sessionSystem: () => "system",
      clearResumeCursors: vi.fn(),
      markProviderSessionBound: vi.fn(),
    };
    let busy = false;
    const build = createSummaryBuild({ store, sendInputs: async () => ({ instance, contextWindow: 200_000, taskRecordText }), busy: () => busy, userName: () => "User" });
    try {
      build.onSettled("bot", "thread");
      await vi.advanceTimersByTimeAsync(20_000);
      busy = true;
      const userMessage = store.appendMessage("thread", { role: "user", kind: "text", text: "next request" });
      const activeMessages = store.activePath();
      const skipTranscript = new Set([userMessage.id]);
      const input = { messages: activeMessages, contextWindow: 200_000, taskRecordText, excludeIds: skipTranscript };
      const summaryGrace = {
        knownWindow: 200_000, requestText: "next request", fresh: false, rewound: false, recycle: false, local: false,
        native: {
          instanceId: "claude", cursor: "session", seed: { instanceId: "claude", cursor: "session", compactionId: null },
          prompt: { first: 60_000, last: 80_000, contextWindow: 200_000 },
        },
      };
      const planBeforeSummary = planCompaction(input);
      const graceInputs = { plan: planBeforeSummary, grace: summaryGrace, taskRecordText };
      expect(planSummaryGrace(graceInputs).safe).toBe(true);
      let summaryWait: SummaryWait | undefined;
      const onSummaryWait = (wait: SummaryWait) => { summaryWait = { ...wait, waitedMs: (summaryWait?.waitedMs ?? 0) + wait.waitedMs }; };
      const logSummaryWait = () => {
        if (summaryWait) console.info(`[summary-wait] ${JSON.stringify(summaryWait)}`);
        summaryWait = undefined;
      };
      expect(await build.settle("thread", instance, 90_000, () => true, { sendId: "send", grace: graceInputs, onWait: onSummaryWait })).toBe(0);
      const summarize = vi.fn(async () => "SUMMARY\nduplicate");
      const prepared = await prepareModelContext({ ...input, summaryGrace, summarize });
      if (prepared.status !== "ready") throw new Error(prepared.status);
      const prepareContext = vi.fn((rows: Message[]) => prepareModelContext({ ...input, messages: rows, summarize }));
      const settle = vi.spyOn(build, "settle");
      const claimMark = queueMark();
      const payload = kind === "paste" ? "x".repeat(375_000) : '<attached-image path="shot.png" />';
      const enqueue = () => queueSteeredMessage("bot", "thread", payload);
      if (fold === "preparation") enqueue();
      const sendTurn = vi.fn(async (_turn: { text: string; transcript: Array<{ text: string }>; resumeCursor?: unknown }) => ({ turnId: "turn" }));
      const live = { adapter: { capabilities: { pinnedSystem }, sendTurn } };
      const seed = { cursor: "session" as unknown, compactionId: null as string | null };
      const scope = {
        currentTurnEpoch: () => 1, epoch: 1,
        providerReload: { started: () => { if (fold === "dispatch") enqueue(); return live; } },
        instanceId: "claude", threadId: "thread", bot: { id: "bot" }, claimMark, store, instance,
        foldQueuedSends, composeUserTurnPrompt, userTurnReactionKeys, paneNotesForTurn, routineCardsSinceLastUserTurn, withoutTurnNotes,
        buildTurnContext, buildResumeFallback, withSystemChanges, planSummaryGrace,
        clearUnattended: () => {}, resumePaneWakes: () => {}, takeOverPeerTurn: () => {}, paneNoteTurnThreads: new Set(),
        opensHostFiles: () => false, privateWorkspace: false, task: { resumeCursors: { claude: "session" } },
        persona: "system", projectFolderPrompt: () => "", projectNotesPrompt: () => "", cwd: ".",
        computerKind: undefined, integrations: {}, browserPrompt: () => "", coordinationPrompt: "", credentialPrompt: "", routinePrompt: "",
        taskStatePrompt: "", reactPrompt: "", showImagePrompt: "", detailedRepliesEnabled: () => false, cfg: {},
        ALWAYS_REPLY_INSTRUCTIONS: "", CORPUS_SEARCH_INSTRUCTIONS: "", sectionContextSystemPrompt: () => "",
        skillInstructions: "", packagePlaybooks: "", harnessPlaybookPrompt: () => "", opts: {}, tagged: [],
        text: "next request", activeMessages, skipTranscript, userMessage, replaysTranscript: false, replaysNatively: false,
        reactions: {}, rewound: false, fresh: false, recycled: false, recycleReason: undefined, modelContextWindow: 200_000,
        transcript: prepared.transcript, contextCompacted: prepared.compacted, taskRecord: undefined, durableTaskRecordText: taskRecordText,
        recovering: false, recoveryLatestUserText: "next request", latestCompactionId: null, seed,
        summarySkipped: true, summaryGrace, graceInputs, planBeforeSummary, summaryBuild: build, prepareContext,
        onSummaryWait, logSummaryWait, latencySendId: "send", isSendCancelled: () => false,
        systemSeeds: { set: () => ({}) }, systemSeed: undefined, lastTurnToolRounds: 0, sessionToolRounds: 0,
        pendingInterruptThreads: { started: () => {} }, model: "claude-opus-5-5", effort: undefined,
        leanStartup: false, isUnattended: () => false,
      };
      const dispatched = runDispatch(scope);
      await vi.advanceTimersByTimeAsync(0);
      expect(sendTurn).not.toHaveBeenCalled();
      expect(settle).toHaveBeenCalledOnce();
      const finalGrace = settle.mock.calls[0]![4]!.grace!;
      expect(finalGrace.grace.requestText).toContain(payload);
      expect(planSummaryGrace(finalGrace)).toEqual({ safe: false, reason: kind === "paste" ? "headroom" : "unknown-headroom" });
      if (kind === "paste") expect(80_000 + estimateContextTokens([{ text: finalGrace.grace.requestText }])).toBeGreaterThan(200_000);
      await vi.advanceTimersByTimeAsync(60_000);
      await dispatched;
      expect(sendTurn).toHaveBeenCalledOnce();
      const turn = sendTurn.mock.calls[0]![0];
      expect(turn.resumeCursor).toBeUndefined();
      expect(turn.text.split(payload)).toHaveLength(2);
      expect(turn.text.split("next request")).toHaveLength(2);
      expect(turn.text).toContain("retained decisions");
      expect(turn.text).toContain("[Wink compacted this conversation");
      expect(turn.transcript.some((row) => row.text.includes(payload) || row.text.includes("next request"))).toBe(false);
      expect(messages.filter((row) => row.text === payload)).toHaveLength(1);
      expect(foldQueuedSends(store, "bot", "thread", claimMark)).toEqual([]);
      expect(prepareContext).toHaveBeenCalledOnce();
      expect(store.clearResumeCursors).toHaveBeenCalledOnce();
      expect(seed).toEqual({ cursor: undefined, compactionId: "summary" });
      expect(generateText).toHaveBeenCalledOnce();
      expect(summarize).not.toHaveBeenCalled();
      const lines = vi.mocked(console.info).mock.calls.map(([line]) => String(line)).filter((line) => line.startsWith("[summary-wait] "));
      expect(lines).toHaveLength(1);
      expect(JSON.parse(lines[0]!.slice("[summary-wait] ".length))).toEqual({
        threadId: "thread", sendId: "send", mode: "waited", waitedMs: 60_000, reason: kind === "paste" ? "headroom" : "unknown-headroom",
      });
    } finally {
      build.dispose();
    }
  });
});
