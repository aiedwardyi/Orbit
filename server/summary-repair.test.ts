import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { Message } from "./store.ts";
import { createSummaryRepair } from "./summary-repair.ts";
import type { ContextCompactionV1 } from "../shared/context-compaction.ts";

const NOTICE = "Model summary unavailable; full transcript retained by Wink.";
const MINUTE = 60_000;

const message = (id: string, text: string, patch: Partial<Message> = {}): Message => ({
  id,
  at: 1_000,
  role: "user",
  kind: "text",
  text,
  ...patch,
});

const compaction = (id: string, value: ContextCompactionV1): Message => ({
  id,
  at: 10_000,
  role: "bot",
  kind: "compaction",
  compaction: value,
});

const row = (prefix: string, patch: Partial<ContextCompactionV1>): ContextCompactionV1 => ({
  v: 1,
  summary: "good summary",
  coveredThroughId: `${prefix}m4`,
  firstKeptId: `${prefix}m5`,
  contextWindow: 8_192,
  estimatedTokensBefore: 900,
  sourceMessageCount: 5,
  ...patch,
});

function fallbackThread(prefix: string, text = "work item"): Message[] {
  const history = Array.from({ length: 20 }, (_, index) =>
    message(`${prefix}m${index}`, `${text} ${index}`, { role: index % 2 ? "bot" : "user" }));
  return [
    ...history.slice(0, 10),
    compaction(`${prefix}cg`, row(prefix, {})),
    ...history.slice(10),
    compaction(`${prefix}cf`, row(prefix, {
      summary: `${NOTICE}\nfallback digest`,
      coveredThroughId: `${prefix}m14`,
      firstKeptId: `${prefix}m15`,
      sourceMessageCount: 15,
    })),
    message(`${prefix}m20`, "latest"),
  ];
}

function setup(generateText?: (prompt: string, opts?: { signal?: AbortSignal }) => Promise<string>) {
  const threads = new Map<string, Message[]>();
  const appended: Array<{ threadId: string; compaction: ContextCompactionV1 }> = [];
  const state = { busy: false, generateText };
  const store = {
    activePath: (threadId: string) => threads.get(threadId) ?? [],
    messagesFor: (threadId: string) => threads.get(threadId) ?? [],
    appendCompaction: (threadId: string, value: ContextCompactionV1) => {
      const added = compaction(`repair-${appended.length}`, value);
      threads.get(threadId)!.push(added);
      appended.push({ threadId, compaction: value });
      return added;
    },
  };
  const repair = createSummaryRepair({
    store,
    instanceFor: async () => ({ driverKind: "claude", generateText: state.generateText, textModel: "claude-haiku-5-5", textTimeoutMs: 90_000 }),
    busy: () => state.busy,
    taskRecordText: () => "Goal: repair",
    userName: () => "User",
  });
  return { threads, appended, state, repair };
}

function deferred() {
  const calls: Array<{ prompt: string; resolve: (text: string) => void; reject: (error: Error) => void }> = [];
  const generateText = (prompt: string) =>
    new Promise<string>((resolve, reject) => {
      calls.push({ prompt, resolve, reject });
    });
  return { calls, generateText };
}

const settle = () => vi.advanceTimersByTimeAsync(0);

describe("summary repair queue", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.spyOn(console, "info").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("runs one repair at a time across bots", async () => {
    const { calls, generateText } = deferred();
    const { threads, appended, repair } = setup(generateText);
    threads.set("ta", fallbackThread("a"));
    threads.set("tb", fallbackThread("b"));

    repair.onSettled("bot-a", "ta");
    repair.onSettled("bot-b", "tb");
    repair.onSettled("bot-b", "tb");
    await settle();
    expect(calls).toHaveLength(1);

    calls[0]!.resolve("SUMMARY\nrepaired a");
    await settle();
    expect(calls).toHaveLength(2);
    calls[1]!.resolve("SUMMARY\nrepaired b");
    await repair.idle();

    expect(appended.map((item) => [item.threadId, item.compaction.summary])).toEqual([["ta", "repaired a"], ["tb", "repaired b"]]);
  });

  it("stops after three runs per fallback with 10 and 60 minute backoff", async () => {
    const generateText = vi.fn(async () => {
      throw new Error("provider unavailable");
    });
    const { threads, appended, repair } = setup(generateText);
    threads.set("t", fallbackThread("x"));
    const settleAndCount = async () => {
      repair.onSettled("bot", "t");
      await repair.idle();
      return generateText.mock.calls.length;
    };

    expect(await settleAndCount()).toBe(1);
    await vi.advanceTimersByTimeAsync(9 * MINUTE);
    expect(await settleAndCount()).toBe(1);
    await vi.advanceTimersByTimeAsync(MINUTE);
    expect(await settleAndCount()).toBe(2);
    await vi.advanceTimersByTimeAsync(59 * MINUTE);
    expect(await settleAndCount()).toBe(2);
    await vi.advanceTimersByTimeAsync(MINUTE);
    expect(await settleAndCount()).toBe(3);
    await vi.advanceTimersByTimeAsync(24 * 60 * MINUTE);
    expect(await settleAndCount()).toBe(3);
    expect(appended).toEqual([]);
  });

  it("pauses every repair for 30 minutes after three straight timeouts", async () => {
    const generateText = vi.fn(async () => {
      throw new Error("Claude review timed out");
    });
    const { threads, repair } = setup(generateText);
    for (const name of ["a", "b", "c", "d"]) threads.set(name, fallbackThread(name));

    for (const name of ["a", "b", "c"]) {
      repair.onSettled(`bot-${name}`, name);
      await repair.idle();
    }
    expect(generateText).toHaveBeenCalledTimes(3);

    repair.onSettled("bot-d", "d");
    await repair.idle();
    await vi.advanceTimersByTimeAsync(29 * MINUTE);
    repair.onSettled("bot-d", "d");
    await repair.idle();
    expect(generateText).toHaveBeenCalledTimes(3);

    await vi.advanceTimersByTimeAsync(MINUTE);
    repair.onSettled("bot-d", "d");
    await repair.idle();
    expect(generateText).toHaveBeenCalledTimes(4);
  });

  it("holds a finished repair while a turn runs and appends it at the next settle", async () => {
    const generateText = vi.fn(async () => "SUMMARY\nrepaired summary");
    const { threads, appended, state, repair } = setup(generateText);
    threads.set("t", fallbackThread("x"));
    state.busy = true;

    repair.onSettled("bot", "t");
    await repair.idle();
    expect(appended).toEqual([]);

    repair.onSettled("bot", "t");
    expect(appended).toEqual([]);
    state.busy = false;
    repair.onSettled("bot", "t");
    await repair.idle();

    expect(generateText).toHaveBeenCalledOnce();
    expect(appended.map((item) => item.compaction.summary)).toEqual(["repaired summary"]);
  });

  it("drops a finished repair when a newer compaction or rewind replaced the target", async () => {
    const { calls, generateText } = deferred();
    const { threads, appended, repair } = setup(generateText);
    threads.set("newer", fallbackThread("n"));
    threads.set("rewound", fallbackThread("r"));

    repair.onSettled("bot-n", "newer");
    repair.onSettled("bot-r", "rewound");
    await settle();
    threads.get("newer")!.push(
      message("nm21", "more work"),
      compaction("nc", row("n", { summary: "newer model summary", coveredThroughId: "nm20", firstKeptId: "nm21", previousCompactionId: "ncf" })),
    );
    calls[0]!.resolve("SUMMARY\nrepaired n");
    await settle();

    threads.set("rewound", threads.get("rewound")!.slice(0, 15));
    calls[1]!.resolve("SUMMARY\nrepaired r");
    await repair.idle();

    expect(calls).toHaveLength(2);
    expect(appended).toEqual([]);
  });

  it("does nothing for an engine without generateText", async () => {
    const { threads, appended, state, repair } = setup(undefined);
    threads.set("t", fallbackThread("x"));

    repair.onSettled("bot", "t");
    await repair.idle();
    expect(appended).toEqual([]);

    state.generateText = vi.fn(async () => "SUMMARY\nrepaired summary");
    repair.onSettled("bot", "t");
    await repair.idle();
    expect(appended).toHaveLength(1);
  });

  it("a restart mid-repair leaves the fallback and repairs on the next settle", async () => {
    const { calls, generateText } = deferred();
    const first = setup(generateText);
    first.threads.set("t", fallbackThread("x"));

    first.repair.onSettled("bot", "t");
    await settle();
    expect(calls).toHaveLength(1);
    first.repair.dispose();
    await first.repair.idle();
    calls[0]!.resolve("SUMMARY\nlate result");
    await settle();
    expect(first.appended).toEqual([]);

    const second = setup(vi.fn(async () => "SUMMARY\nrepaired summary"));
    second.threads.set("t", first.threads.get("t")!);
    second.repair.onSettled("bot", "t");
    await second.repair.idle();
    expect(second.appended.map((item) => item.compaction.summary)).toEqual(["repaired summary"]);
  });

  it("logs no prompt or summary text", async () => {
    const info = vi.mocked(console.info);
    const warn = vi.mocked(console.warn);
    const replies = [Promise.reject(new Error("ERROR-MARKER timed out")), Promise.resolve("SUMMARY\nOUTPUT-MARKER")];
    replies[0]!.catch(() => {});
    const { threads, repair } = setup(() => replies.shift()!);
    threads.set("t", fallbackThread("x", "PROMPT-MARKER"));

    repair.onSettled("bot", "t");
    await repair.idle();
    await vi.advanceTimersByTimeAsync(10 * MINUTE);
    repair.onSettled("bot", "t");
    await repair.idle();

    const lines = [...info.mock.calls, ...warn.mock.calls].map((call) => String(call[0]));
    const records = lines
      .filter((line) => line.startsWith("[summary] "))
      .map((line) => JSON.parse(line.slice("[summary] ".length)))
      .sort((a, b) => a.run - b.run);
    expect(records).toEqual([
      expect.objectContaining({ botId: "bot", threadId: "t", phase: "repair", engine: "claude", model: "claude-haiku-5-5", run: 1, attempt: 1, deadlineMs: 240_000, result: "timeout" }),
      expect.objectContaining({ phase: "repair", run: 2, attempt: 1, result: "ok" }),
    ]);
    const logged = JSON.stringify(lines);
    expect(logged).not.toContain("PROMPT-MARKER");
    expect(logged).not.toContain("OUTPUT-MARKER");
    expect(logged).not.toContain("ERROR-MARKER");
  });
});
