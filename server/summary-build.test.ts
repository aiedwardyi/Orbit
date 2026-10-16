import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { isFallbackSummary, prepareModelContext } from "./context-compaction.ts";
import type { Message } from "./store.ts";
import { createSummaryBuild, inlineSummarizer } from "./summary-build.ts";
import type { ContextCompactionV1 } from "../shared/context-compaction.ts";

const MINUTE = 60_000;
const WINDOW = 200_000;

const message = (id: string, text: string, patch: Partial<Message> = {}): Message => ({
  id,
  at: 1_000,
  role: "user",
  kind: "text",
  text,
  ...patch,
});

// Over the 60 user-turn cap, under the token budget: the summary input fits one batch.
function overBudgetThread(prefix: string, turns = 70): Message[] {
  return Array.from({ length: turns }, (_, index) => [
    message(`${prefix}u${index}`, `request ${index}`),
    message(`${prefix}b${index}`, `outcome ${index}`, { role: "bot" }),
  ]).flat();
}

function setup(generateText?: (prompt: string, opts?: { signal?: AbortSignal }) => Promise<string>) {
  const threads = new Map<string, Message[]>();
  const appended: Array<{ threadId: string; id: string; compaction: ContextCompactionV1 }> = [];
  const state = { busy: false, generateText };
  const store = {
    activePath: (threadId: string) => [...(threads.get(threadId) ?? [])],
    activeLeaf: (threadId: string) => threads.get(threadId)?.at(-1)?.id ?? null,
    messagesFor: (threadId: string) => threads.get(threadId) ?? [],
    appendCompaction: (threadId: string, value: ContextCompactionV1) => {
      const added: Message = { id: `build-${appended.length}`, at: 10_000, role: "bot", kind: "compaction", compaction: value };
      threads.get(threadId)!.push(added);
      appended.push({ threadId, id: added.id, compaction: value });
      return added;
    },
  };
  const build = createSummaryBuild({
    store,
    sendInputs: async () => ({
      instance: { driverKind: "claude", generateText: state.generateText, textModel: "claude-haiku-5-5", textTimeoutMs: 90_000 },
      contextWindow: WINDOW,
      taskRecordText: "Goal: build",
    }),
    busy: () => state.busy,
    userName: () => "User",
  });
  const sendPrepares = (threadId: string, userId: string, inline?: { summarize: ((prompt: string) => Promise<string>) | undefined }) => {
    const summarize = inline ? inline.summarize : vi.fn(async () => "SUMMARY\ninline");
    return prepareModelContext({
      messages: store.activePath(threadId),
      contextWindow: WINDOW,
      taskRecordText: "Goal: build",
      excludeIds: new Set([userId]),
      summarize,
    }).then((prepared) => ({ prepared, summarize }));
  };
  return { threads, appended, state, build, store, sendPrepares };
}

function deferred() {
  const calls: Array<{ prompt: string; signal?: AbortSignal; resolve: (text: string) => void; reject: (error: Error) => void }> = [];
  const generateText = (prompt: string, opts?: { signal?: AbortSignal }) =>
    new Promise<string>((resolve, reject) => {
      calls.push({ prompt, signal: opts?.signal, resolve, reject });
    });
  return { calls, generateText };
}

const tick = () => vi.advanceTimersByTimeAsync(0);
const claudeSend = { generateText: async () => "SUMMARY\ninline", textTimeoutMs: 90_000 };

describe("summary build after settle", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.spyOn(console, "info").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("builds after settle when over budget", async () => {
    const generateText = vi.fn(async () => "SUMMARY\nbuilt");
    const { threads, appended, build, sendPrepares } = setup(generateText);
    threads.set("t", overBudgetThread("a"));

    build.onSettled("bot", "t");
    await build.idle();

    expect(generateText).toHaveBeenCalledOnce();
    expect(appended).toHaveLength(1);
    expect(appended[0]!.compaction).toMatchObject({ summary: "built", contextWindow: WINDOW });
    const lines = vi.mocked(console.info).mock.calls.map((call) => String(call[0])).filter((line) => line.startsWith("[summary] "));
    expect(JSON.parse(lines[0]!.slice("[summary] ".length))).toMatchObject({ botId: "bot", threadId: "t", phase: "build", run: 1, deadlineMs: 240_000, result: "ok" });

    threads.get("t")!.push(message("next", "next question"));
    const { prepared, summarize } = await sendPrepares("t", "next");
    expect(summarize).not.toHaveBeenCalled();
    expect(prepared).toMatchObject({ status: "ready", compactionId: appended[0]!.id });
  });

  it("no call under budget", async () => {
    const generateText = vi.fn(async () => "SUMMARY\nnever");
    const { threads, appended, build } = setup(generateText);
    threads.set("t", overBudgetThread("a", 6));

    build.onSettled("bot", "t");
    await build.idle();

    expect(generateText).not.toHaveBeenCalled();
    expect(appended).toEqual([]);
  });

  it("leaves a fallback chain to the repair", async () => {
    const generateText = vi.fn(async () => "SUMMARY\nbuilt");
    const { threads, appended, build, sendPrepares } = setup(generateText);
    threads.set("t", overBudgetThread("a"));
    threads.get("t")!.push(message("send", "next question"));
    const { prepared } = await sendPrepares("t", "send", { summarize: undefined });
    expect(prepared.status === "ready" && isFallbackSummary(prepared.compaction!.summary)).toBe(true);
    if (prepared.status !== "ready") return;
    threads.get("t")!.push(
      { id: "fallback", at: 2_000, role: "bot", kind: "compaction", compaction: prepared.compaction! },
      ...overBudgetThread("b"),
    );

    build.onSettled("bot", "t");
    await build.idle();

    expect(generateText).not.toHaveBeenCalled();
    expect(appended).toEqual([]);
  });

  it("lands nothing when the leaf moved", async () => {
    const { calls, generateText } = deferred();
    const { threads, appended, build } = setup(generateText);
    threads.set("t", overBudgetThread("a"));

    build.onSettled("bot", "t");
    await tick();
    expect(calls).toHaveLength(1);
    threads.get("t")!.push(message("note", "[pane 1] worker output", { kind: "note" }));
    calls[0]!.resolve("SUMMARY\nbuilt");
    await build.idle();

    expect(appended).toEqual([]);
    const dropped = vi.mocked(console.info).mock.calls.map((call) => String(call[0])).find((line) => line.startsWith("[summary-build] dropped "));
    expect(JSON.parse(dropped!.slice("[summary-build] dropped ".length))).toEqual({ botId: "bot", threadId: "t", reason: "leaf-moved" });
  });

  it("holds while busy and lands at the next settle", async () => {
    const { calls, generateText } = deferred();
    const { threads, appended, state, build } = setup(generateText);
    threads.set("t", overBudgetThread("a"));
    state.busy = true;

    build.onSettled("bot", "t");
    await build.idle();
    expect(calls).toHaveLength(0);

    state.busy = false;
    build.onSettled("bot", "t");
    await tick();
    expect(calls).toHaveLength(1);
    state.busy = true;
    calls[0]!.resolve("SUMMARY\nbuilt");
    await build.idle();
    expect(appended).toEqual([]);

    build.onSettled("bot", "t");
    expect(appended).toEqual([]);
    state.busy = false;
    build.onSettled("bot", "t");
    await build.idle();

    expect(calls).toHaveLength(1);
    expect(appended.map((item) => item.compaction.summary)).toEqual(["built"]);
  });

  it("send during build waits then reuses the row without a second summarize call", async () => {
    const { calls, generateText } = deferred();
    const { threads, appended, state, build, sendPrepares } = setup(generateText);
    threads.set("t", overBudgetThread("a"));

    build.onSettled("bot", "t");
    await tick();
    expect(calls).toHaveLength(1);
    state.busy = true;
    threads.get("t")!.push(message("send", "next question"));
    let waited = false;
    const settled = build.settle("t", claudeSend, 90_000, () => true).then(() => {
      waited = true;
    });
    await tick();
    expect(waited).toBe(false);
    calls[0]!.resolve("SUMMARY\nbuilt");
    await settled;

    expect(appended).toHaveLength(1);
    const { prepared, summarize } = await sendPrepares("t", "send");
    expect(summarize).not.toHaveBeenCalled();
    expect(prepared).toMatchObject({ status: "ready", compactionId: appended[0]!.id });
    expect(calls).toHaveLength(1);
  });

  it("a switch to an engine without generateText mid-build waits 0", async () => {
    const { calls, generateText } = deferred();
    const { threads, appended, state, build } = setup(generateText);
    threads.set("t", overBudgetThread("a"));

    build.onSettled("bot", "t");
    await tick();
    state.busy = true;
    threads.get("t")!.push(message("send", "next on Codex"));
    const summarizes = vi.fn(() => true);
    const settled = build.settle("t", { generateText: undefined, textTimeoutMs: undefined }, 90_000, summarizes);

    expect(calls[0]!.signal?.aborted).toBe(true);
    expect(await settled).toBe(0);
    expect(summarizes).not.toHaveBeenCalled();
    calls[0]!.resolve("SUMMARY\nlate");
    await build.idle();
    expect(appended).toEqual([]);
  });

  it("an engine without textTimeoutMs waits 0", async () => {
    const { calls, generateText } = deferred();
    const { threads, appended, state, build } = setup(generateText);
    threads.set("t", overBudgetThread("a"));

    build.onSettled("bot", "t");
    await tick();
    state.busy = true;
    threads.get("t")!.push(message("send", "next on agy"));
    const settled = build.settle("t", { generateText: async () => "SUMMARY\nagy", textTimeoutMs: undefined }, 90_000, () => true);

    expect(calls[0]!.signal?.aborted).toBe(true);
    expect(await settled).toBe(0);
    await build.idle();
    expect(appended).toEqual([]);
  });

  it("a send whose context fits waits 0 and lands nothing", async () => {
    const { calls, generateText } = deferred();
    const { threads, appended, state, build } = setup(generateText);
    threads.set("t", overBudgetThread("a"));

    build.onSettled("bot", "t");
    await tick();
    state.busy = true;
    threads.get("t")!.push(message("send", "next on a bigger window"));
    const settled = build.settle("t", claudeSend, 90_000, () => false);

    expect(calls[0]!.signal?.aborted).toBe(true);
    expect(await settled).toBe(0);
    await build.idle();
    expect(appended).toEqual([]);
  });

  it("cap aborts the build and the send falls back inline", async () => {
    const { calls, generateText } = deferred();
    const { threads, appended, state, build, sendPrepares } = setup(generateText);
    threads.set("t", overBudgetThread("a"));

    build.onSettled("bot", "t");
    await tick();
    state.busy = true;
    threads.get("t")!.push(message("send", "next question"));
    const settled = build.settle("t", claudeSend, 90_000, () => true);
    await vi.advanceTimersByTimeAsync(90_000);
    const waited = await settled;

    expect(waited).toBe(90_000);
    expect(calls[0]!.signal?.aborted).toBe(true);
    expect(appended).toEqual([]);
    // The wait used the whole 90 s summary deadline: no second call, today's deterministic fallback at once.
    const instance = { generateText: vi.fn(async () => "SUMMARY\nsecond"), textTimeoutMs: 90_000 };
    const summarize = inlineSummarizer(instance, waited);
    expect(summarize).toBeUndefined();
    const { prepared } = await sendPrepares("t", "send", { summarize });
    expect(instance.generateText).not.toHaveBeenCalled();
    expect(prepared.status).toBe("ready");
    expect(prepared.status === "ready" && isFallbackSummary(prepared.compaction!.summary)).toBe(true);

    calls[0]!.resolve("SUMMARY\nlate");
    await build.idle();
    expect(appended).toEqual([]);
  });

  it("failure lands no row", async () => {
    const generateText = vi.fn(async () => {
      throw new Error("provider unavailable");
    });
    const { threads, appended, build } = setup(generateText);
    threads.set("t", overBudgetThread("a"));

    build.onSettled("bot", "t");
    await build.idle();
    expect(generateText).toHaveBeenCalledTimes(1);
    expect(appended).toEqual([]);

    await vi.advanceTimersByTimeAsync(9 * MINUTE);
    build.onSettled("bot", "t");
    await build.idle();
    expect(generateText).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(MINUTE);
    await build.idle();
    expect(generateText).toHaveBeenCalledTimes(2);

    await vi.advanceTimersByTimeAsync(60 * MINUTE);
    build.onSettled("bot", "t");
    await build.idle();
    expect(generateText).toHaveBeenCalledTimes(2);
    expect(appended).toEqual([]);
  });

  it("dispose aborts", async () => {
    const { calls, generateText } = deferred();
    const { threads, appended, build } = setup(generateText);
    threads.set("t", overBudgetThread("a"));

    build.onSettled("bot", "t");
    await tick();
    expect(calls).toHaveLength(1);
    build.dispose();
    await build.idle();

    expect(calls[0]!.signal?.aborted).toBe(true);
    calls[0]!.resolve("SUMMARY\nlate");
    await tick();
    expect(appended).toEqual([]);
    build.onSettled("bot", "t");
    await build.idle();
    expect(calls).toHaveLength(1);
  });

  it("send-after queued at settle reuses the build", async () => {
    const { calls, generateText } = deferred();
    const { threads, appended, state, build, sendPrepares } = setup(generateText);
    threads.set("t", overBudgetThread("a"));

    // The drain subscriber runs right after the main fold: it appends the held
    // line and claims the bot before the build's first await returns.
    build.onSettled("bot", "t");
    const drained = message("drained", "DRAINED-LINE ".repeat(25_000));
    threads.get("t")!.push(drained);
    state.busy = true;
    const settled = build.settle("t", claudeSend, 90_000, () => true);
    await tick();

    expect(calls).toHaveLength(1);
    expect(calls[0]!.prompt).not.toContain("DRAINED-LINE");
    calls[0]!.resolve("SUMMARY\nbuilt");
    await settled;

    expect(appended).toHaveLength(1);
    expect(appended[0]!.compaction.coveredThroughId).not.toBe("drained");
    const { prepared, summarize } = await sendPrepares("t", "drained");
    expect(summarize).not.toHaveBeenCalled();
    expect(prepared).toMatchObject({ status: "ready", compactionId: appended[0]!.id });
  });
});

describe("inline summarizer after a build wait", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.spyOn(console, "info").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("settle returns the wait", async () => {
    const { calls, generateText } = deferred();
    const { threads, appended, state, build } = setup(generateText);
    threads.set("t", overBudgetThread("a"));
    expect(await build.settle("t", claudeSend, 90_000, () => true)).toBe(0);

    build.onSettled("bot", "t");
    await tick();
    state.busy = true;
    threads.get("t")!.push(message("send", "next question"));
    const settled = build.settle("t", claudeSend, 90_000, () => true);
    await vi.advanceTimersByTimeAsync(5_000);
    calls[0]!.resolve("SUMMARY\nbuilt");

    expect(await settled).toBe(5_000);
    expect(appended).toHaveLength(1);
    expect(await build.settle("t", claudeSend, 90_000, () => true)).toBe(0);
  });

  it("budget used up means no summarize call and the fallback path", async () => {
    const { threads, sendPrepares } = setup();
    threads.set("t", overBudgetThread("a"));
    threads.get("t")!.push(message("send", "next question"));
    const instance = { generateText: vi.fn(async () => "SUMMARY\nsecond"), textTimeoutMs: 90_000 };

    const summarize = inlineSummarizer(instance, 90_000);
    expect(summarize).toBeUndefined();
    expect(inlineSummarizer(instance, 120_000)).toBeUndefined();
    const { prepared } = await sendPrepares("t", "send", { summarize });

    expect(instance.generateText).not.toHaveBeenCalled();
    expect(prepared.status).toBe("ready");
    expect(prepared.status === "ready" && isFallbackSummary(prepared.compaction!.summary)).toBe(true);
  });

  it("a build that fails partway leaves the inline call the remainder", async () => {
    const { calls, generateText } = deferred();
    const { threads, appended, state, build } = setup(generateText);
    threads.set("t", overBudgetThread("a"));

    build.onSettled("bot", "t");
    await tick();
    state.busy = true;
    threads.get("t")!.push(message("send", "next question"));
    const settled = build.settle("t", claudeSend, 90_000, () => true);
    await vi.advanceTimersByTimeAsync(30_000);
    calls[0]!.reject(new Error("provider unavailable"));
    const waited = await settled;

    expect(waited).toBe(30_000);
    expect(appended).toEqual([]);
    const instance = { generateText: vi.fn(async () => "SUMMARY\nsecond"), textTimeoutMs: 90_000 };
    await inlineSummarizer(instance, waited)!("prompt");
    expect(instance.generateText).toHaveBeenCalledWith("prompt", { timeoutMs: 60_000 });
  });

  it("no wait means today's call with no timeout override", async () => {
    const instance = { generateText: vi.fn(async () => "SUMMARY\nsecond"), textTimeoutMs: 90_000 };
    await inlineSummarizer(instance, 0)!("prompt");
    expect(instance.generateText).toHaveBeenCalledWith("prompt");
    expect(inlineSummarizer({ generateText: undefined, textTimeoutMs: 90_000 }, 0)).toBeUndefined();
  });

  it("an undeclared deadline leaves nothing to debit after a wait", async () => {
    const instance = { generateText: vi.fn(async () => "SUMMARY\nsecond"), textTimeoutMs: undefined };
    expect(inlineSummarizer(instance, 50_000)).toBeUndefined();
    await inlineSummarizer(instance, 0)!("prompt");
    expect(instance.generateText).toHaveBeenCalledWith("prompt");
  });
});

describe("summary build wiring", () => {
  const index = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "index.ts"), "utf8");

  it("builds first in the main fold, settles before prepare, and disposes on shutdown", () => {
    expect(index).toMatch(/summaryBuild\.onSettled\(bot\.id, event\.threadId\);\s*summaryRepair\.onSettled\(bot\.id, event\.threadId\);/);
    expect(index).toMatch(/const summaryWaitMs = await summaryBuild\.settle\(threadId, instance, 90_000, \(\) => \{[\s\S]*?\}\)\.needed;\s*\}\);\s*const activeMessages = store\.activePath\(threadId\);/);
    expect(index.indexOf("const summaryWaitMs = await summaryBuild.settle(threadId, instance, 90_000, () => {")).toBeLessThan(index.indexOf("  const prepared = await prepareModelContext({"));
    expect(index).toMatch(/summaryBuild\.dispose\(\);\s*summaryRepair\.dispose\(\);/);
  });

  it("the 1:1 send's inline call runs on the deadline left after the wait; the room path is unchanged", () => {
    const sends = index.split("summarize: inlineSummarizer(instance, summaryWaitMs),");
    expect(sends).toHaveLength(2);
    expect(sends[0]!.lastIndexOf("const summaryWaitMs = await summaryBuild.settle(threadId, instance, 90_000, () => {")).toBeGreaterThan(sends[0]!.lastIndexOf("async function startClaimedTurn("));
    expect(index).toContain("summarize: instance.generateText ? (prompt) => instance.generateText!(prompt) : undefined,");
  });
});
