import { describe, expect, it, vi } from "vitest";

import type { ModelCatalog } from "./contracts.ts";
import {
  MODEL_CONTEXT_FALLBACK,
  contextWindowFor,
  estimateContextTokens,
  prepareModelContext,
} from "./context-compaction.ts";
import type { Message } from "./store.ts";
import type { ContextCompactionV1 } from "../shared/context-compaction.ts";

const message = (id: string, text: string, patch: Partial<Message> = {}): Message => ({
  id,
  at: Number(id.replace(/\D/g, "")) || 1,
  role: "user",
  kind: "text",
  text,
  ...patch,
});

const compactionMessage = (
  id: string,
  parentId: string,
  compaction: ContextCompactionV1 | unknown,
): Message => ({
  id,
  at: 10_000,
  role: "bot",
  kind: "compaction",
  parentId,
  compaction,
});

const longHistory = (count: number, start = 0): Message[] =>
  Array.from({ length: count }, (_, offset) => {
    const index = start + offset;
    return message(`m${index}`, `work item ${index}: ${"detail ".repeat(18)}`, {
      role: index % 2 === 0 ? "user" : "bot",
    });
  });

describe("provider-neutral context compaction", () => {
  it("keeps the task record and recent work after more than 200 messages", async () => {
    const summarize = vi.fn(async (_prompt: string) =>
      "Goal: ship the release. Plan: verify the build. Completed: package built. Evidence: report.json. Artifact: dist/app.zip. Blocker: signing approval. Next: run smoke tests.",
    );
    const result = await prepareModelContext({
      messages: longHistory(205),
      contextWindow: 2_048,
      taskRecordText: "Goal: ship the release\nPlan: verify the build\nCompleted: package built\nEvidence: report.json\nArtifact: dist/app.zip\nBlocker: signing approval\nNext action: run smoke tests",
      summarize,
    });

    expect(result.status).toBe("ready");
    if (result.status !== "ready") return;
    expect(result.compaction?.summary).toContain("dist/app.zip");
    expect(result.compaction?.summary).toContain("signing approval");
    expect(result.transcript.at(-1)?.text).toContain("work item 204");
    expect(result.transcript[0]?.text).toContain("Orbit durable context summary");
    expect(summarize).toHaveBeenCalled();
    expect(summarize.mock.calls[0]?.[0]).toContain("Goal: ship the release");
    expect(summarize.mock.calls[0]?.[0]).toContain("Completed: package built");
    expect(result.estimatedTokens).toBeLessThanOrEqual(result.budgetTokens);
  });

  it("folds the previous durable summary into later summaries", async () => {
    const first = await prepareModelContext({
      messages: longHistory(120),
      contextWindow: 1_024,
      taskRecordText: "Goal: finish",
      summarize: async () => "summary one",
    });
    expect(first.status).toBe("ready");
    if (first.status !== "ready") return;
    expect(first.compaction).toBeDefined();
    if (!first.compaction) return;

    const firstRecord = compactionMessage("c1", "m119", first.compaction);
    const summarize = vi.fn(async (_prompt: string) => "summary two");
    const second = await prepareModelContext({
      messages: [...longHistory(120), firstRecord, ...longHistory(90, 120)],
      contextWindow: 1_024,
      taskRecordText: "Goal: finish",
      summarize,
    });

    expect(second.status).toBe("ready");
    if (second.status !== "ready") return;
    expect(summarize.mock.calls.some(([prompt]) => prompt.includes("summary one"))).toBe(true);
    expect(second.compaction?.previousCompactionId).toBe("c1");
    expect(second.compaction?.summary).toBe("summary two");
  });

  it("rebuilds continuity for an engine A to B to A sequence", async () => {
    const history = longHistory(120);
    const first = await prepareModelContext({
      messages: history,
      contextWindow: 1_024,
      taskRecordText: "Goal: finish the release",
      summarize: async () => "engine A summary with early evidence",
    });
    expect(first.status).toBe("ready");
    if (first.status !== "ready") return;
    expect(first.compaction).toBeDefined();
    if (!first.compaction) return;

    const marker = compactionMessage("c1", "m119", first.compaction);
    const bResult = message("m120", "engine B verified the installer", { role: "bot" });
    const path = [...history, marker, bResult];
    const bPrompts: string[] = [];
    const onB = await prepareModelContext({
      messages: path,
      contextWindow: 32_768,
      taskRecordText: "Goal: finish the release",
      summarize: async (prompt) => {
        bPrompts.push(prompt);
        return "engine B summary with early evidence and installer verification";
      },
    });
    expect(onB.status).toBe("ready");
    if (onB.status !== "ready") return;
    expect(onB.compaction).toBeDefined();
    if (!onB.compaction) return;
    expect(bPrompts.some((prompt) => prompt.includes("work item 0"))).toBe(true);
    expect(bPrompts.some((prompt) => prompt.includes("engine A summary with early evidence"))).toBe(true);
    expect(onB.transcript.at(-1)?.text).toContain("engine B verified the installer");

    const bMarker = compactionMessage("c2", bResult.id, onB.compaction);
    const prompts: string[] = [];
    const backOnA = await prepareModelContext({
      messages: [...path, bMarker],
      contextWindow: 1_024,
      taskRecordText: "Goal: finish the release",
      summarize: async (prompt) => {
        prompts.push(prompt);
        return "engine A resumed with B's verification";
      },
    });
    expect(backOnA.status).toBe("ready");
    expect(prompts.some((prompt) => prompt.includes("engine B summary with early evidence"))).toBe(true);
    expect(backOnA.status === "ready" && JSON.stringify(backOnA.transcript)).toContain("engine B verified the installer");
  });

  it("flushes task state before the first summarization call", async () => {
    const order: string[] = [];
    const result = await prepareModelContext({
      messages: longHistory(120),
      contextWindow: 1_024,
      taskRecordText: "Goal: flush first",
      beforeSummarize: () => { order.push("flush"); },
      summarize: async () => {
        order.push("summarize");
        return "flushed summary";
      },
    });

    expect(result.status).toBe("ready");
    expect(order[0]).toBe("flush");
    expect(order.slice(1).every((step) => step === "summarize")).toBe(true);
  });

  it("uses durable harness context when the optional summarizer is absent", async () => {
    const secret = `sk-${"f".repeat(32)}`;
    const messages = longHistory(97);
    messages.splice(10, 0, message("tool", "", {
      role: "bot",
      kind: "activity",
      tool: { name: `Bash: pnpm test ${secret}`, ok: true },
    }));
    const beforeSummarize = vi.fn();
    const result = await prepareModelContext({
      messages,
      contextWindow: 8_192,
      taskRecordText: `Goal: ship the release\nEvidence: reports/green.json\nArtifact: dist/orbit.exe\nSecret: ${secret}`,
      beforeSummarize,
    });

    expect(result.status).toBe("ready");
    if (result.status !== "ready") return;
    expect(beforeSummarize).toHaveBeenCalledOnce();
    expect(result.compaction?.summary).toContain("reports/green.json");
    expect(result.compaction?.summary).toContain("dist/orbit.exe");
    expect(result.compaction?.summary).toContain("work item 0");
    expect(result.compaction?.summary).toContain("Bash: pnpm test");
    expect(result.compaction?.summary).not.toContain(secret);
    expect(result.transcript.at(-1)?.text).toContain("work item 96");
    expect(messages).toHaveLength(98);
  });

  it("folds a deterministic fallback through repeated compaction", async () => {
    const first = await prepareModelContext({
      messages: longHistory(120),
      contextWindow: 2_048,
      taskRecordText: "Goal: finish the release\nEvidence: first.json",
    });
    expect(first.status).toBe("ready");
    if (first.status !== "ready") return;
    expect(first.compaction).toBeDefined();
    if (!first.compaction) return;

    const marker = compactionMessage("c1", "m119", first.compaction);
    const second = await prepareModelContext({
      messages: [...longHistory(120), marker, ...longHistory(90, 120)],
      contextWindow: 2_048,
      taskRecordText: "Goal: finish the release\nEvidence: second.json",
    });

    expect(second.status).toBe("ready");
    if (second.status !== "ready") return;
    expect(second.compaction?.previousCompactionId).toBe("c1");
    expect(second.compaction?.summary).toContain("[Previous durable summary]");
    expect(second.compaction?.summary).toContain("second.json");
    expect(second.transcript.at(-1)?.text).toContain("work item 209");
  });

  it("represents each completed tool call and result as one context item", async () => {
    const result = await prepareModelContext({
      messages: [
        message("m1", "run the checks"),
        message("m2", "", { role: "bot", kind: "activity", tool: { name: "Bash: pnpm test", ok: true } }),
        message("m3", "", { role: "bot", kind: "activity", tool: { name: "Bash: still running" } }),
      ],
      contextWindow: 8_192,
      taskRecordText: "Goal: test",
    });

    expect(result.status).toBe("ready");
    if (result.status !== "ready") return;
    const toolItems = result.transcript.filter((item) => item.text.includes("Tool call and result"));
    expect(toolItems).toEqual([
      { role: "assistant", text: "[Tool call and result: Bash: pnpm test - succeeded]" },
    ]);
    expect(JSON.stringify(result.transcript)).not.toContain("still running");
  });

  it("keeps room speaker attribution in the bounded projection", async () => {
    const result = await prepareModelContext({
      messages: [
        message("m1", "check the package"),
        message("m2", "the package is ready", { role: "bot", from: { botId: "scout", name: "Scout", color: "blue" } }),
        message("m3", "", {
          role: "bot",
          kind: "activity",
          from: { botId: "scout", name: "Scout", color: "blue" },
          tool: { name: "Bash: pnpm test", ok: true },
        }),
      ],
      contextWindow: 8_192,
      taskRecordText: "Room: Release",
      userName: "Eddie",
      includeSpeakers: true,
    });

    expect(result.status).toBe("ready");
    if (result.status !== "ready") return;
    expect(result.transcript.map((item) => item.text)).toEqual([
      "Eddie: check the package",
      "Scout: the package is ready",
      "Scout: [Tool call and result: Bash: pnpm test - succeeded]",
    ]);
  });

  it("uses catalog windows and a deterministic fallback", () => {
    const catalog: ModelCatalog = {
      default: "large",
      options: [
        { id: "small", label: "Small", contextWindow: 4_096 },
        { id: "large", label: "Large", contextWindow: 128_000 },
      ],
    };
    expect(contextWindowFor(catalog, "small")).toBe(4_096);
    expect(contextWindowFor(catalog, "missing")).toBe(MODEL_CONTEXT_FALLBACK);
  });

  it("keeps small-window context within its deterministic budget", async () => {
    const result = await prepareModelContext({
      messages: longHistory(180),
      contextWindow: 1_024,
      taskRecordText: "Goal: bounded",
      summarize: async () => "bounded summary",
    });

    expect(result.status).toBe("ready");
    if (result.status !== "ready") return;
    expect(estimateContextTokens(result.transcript)).toBe(result.estimatedTokens);
    expect(result.estimatedTokens).toBeLessThanOrEqual(result.budgetTokens);
  });

  it("summarizes every segment of an oversized message", async () => {
    const prompts: string[] = [];
    const source = `BEGIN-${"work ".repeat(2_000)}-END`;
    const result = await prepareModelContext({
      messages: [message("m1", source), message("m2", "recent work", { role: "bot" })],
      contextWindow: 512,
      taskRecordText: "Goal: preserve every segment",
      summarize: async (prompt) => {
        prompts.push(prompt);
        return "segmented summary";
      },
    });

    expect(result.status).toBe("ready");
    expect(prompts.length).toBeGreaterThan(1);
    expect(prompts.join("\n")).toContain("BEGIN-");
    expect(prompts.join("\n")).toContain("-END");
    expect(prompts.join("\n")).not.toContain("shortened for model context");
  });

  it("fails instead of truncating an oversized generated summary", async () => {
    const result = await prepareModelContext({
      messages: longHistory(120),
      contextWindow: 1_024,
      taskRecordText: "Goal: preserve valid state",
      summarize: async () => "oversized ".repeat(2_000),
    });

    expect(result).toMatchObject({
      status: "failed",
      error: expect.stringContaining("exceeded the durable summary budget"),
    });
  });

  it("uses deterministic fallback without replacing a valid summary when later summarization throws", async () => {
    const previous: ContextCompactionV1 = {
      v: 1,
      summary: "known good summary",
      coveredThroughId: "m4",
      firstKeptId: "m5",
      contextWindow: 2_048,
      estimatedTokensBefore: 900,
      sourceMessageCount: 5,
    };
    const path = [
      ...longHistory(10),
      compactionMessage("c1", "m9", previous),
      ...longHistory(95, 10),
    ];
    const beforeSummarize = vi.fn();
    const result = await prepareModelContext({
      messages: path,
      contextWindow: 1_024,
      taskRecordText: "Goal: preserve state",
      beforeSummarize,
      summarize: async () => {
        throw new Error("summary provider unavailable");
      },
    });

    expect(result.status).toBe("ready");
    if (result.status !== "ready") return;
    expect(beforeSummarize).toHaveBeenCalledOnce();
    expect(result.compaction?.previousCompactionId).toBe("c1");
    expect(result.compaction?.summary).toContain("known good summary");
    expect(result.compaction?.summary).toContain("Goal: preserve state");
    expect(path.find((item) => item.id === "c1")?.compaction).toEqual(previous);
  });

  it("uses deterministic fallback when the optional summarizer returns empty", async () => {
    const beforeSummarize = vi.fn();
    const result = await prepareModelContext({
      messages: longHistory(120),
      contextWindow: 1_024,
      taskRecordText: "Goal: preserve state\nEvidence: reports/green.json\nArtifact: dist/orbit.exe",
      beforeSummarize,
      summarize: async () => "   ",
    });

    expect(result.status).toBe("ready");
    if (result.status !== "ready") return;
    expect(beforeSummarize).toHaveBeenCalledOnce();
    expect(result.compaction?.summary).toContain("Model summary unavailable");
    expect(result.compaction?.summary).toContain("reports/green.json");
    expect(result.compaction?.summary).toContain("dist/orbit.exe");
    expect(result.compaction?.summary).toContain("work item 0");
    expect(result.transcript.at(-1)?.text).toContain("work item 119");
  });

  it("preserves a partial generated summary when a later summarizer call fails", async () => {
    const secret = `sk-${"z".repeat(32)}`;
    const warning = vi.spyOn(console, "warn").mockImplementation(() => {});
    let calls = 0;
    try {
      const result = await prepareModelContext({
        messages: [
          message("m1", `BEGIN-${"work ".repeat(2_000)}-END`),
          message("m2", "recent work", { role: "bot" }),
        ],
        contextWindow: 2_048,
        taskRecordText: "Goal: preserve partial progress",
        summarize: async () => {
          calls += 1;
          if (calls === 1) return "partial generated summary marker";
          throw new Error(`summary provider unavailable ${secret}`);
        },
      });

      expect(calls).toBeGreaterThan(1);
      expect(result.status).toBe("ready");
      if (result.status !== "ready") return;
      expect(result.compaction?.summary).toContain("partial generated summary marker");
      expect(warning).toHaveBeenCalledWith("context compaction: summarizer failed; using deterministic fallback");
      expect(JSON.stringify(warning.mock.calls)).not.toContain(secret);
    } finally {
      warning.mockRestore();
    }
  });

  it("returns failed context when deterministic fallback throws", async () => {
    const input = {
      messages: longHistory(120),
      contextWindow: 1_024,
      get taskRecordText(): string {
        throw new Error("fallback summary failed");
      },
    };

    await expect(prepareModelContext(input)).resolves.toMatchObject({
      status: "failed",
      error: "Context summarization failed: fallback summary failed",
    });
  });

  it("selects the correct summary after rewind and on alternate branches", async () => {
    const base = message("m1", "shared root");
    const alpha = compactionMessage("ca", "m1", {
      v: 1,
      summary: "alpha branch summary",
      coveredThroughId: "m1",
      firstKeptId: null,
      contextWindow: 8_192,
      estimatedTokensBefore: 10,
      sourceMessageCount: 1,
    });
    const beta = compactionMessage("cb", "m1", {
      v: 1,
      summary: "beta branch summary",
      coveredThroughId: "m1",
      firstKeptId: null,
      contextWindow: 8_192,
      estimatedTokensBefore: 10,
      sourceMessageCount: 1,
    });

    const onAlpha = await prepareModelContext({ messages: [base, alpha], contextWindow: 8_192, taskRecordText: "Goal: branch" });
    const onBeta = await prepareModelContext({ messages: [base, beta], contextWindow: 8_192, taskRecordText: "Goal: branch" });
    expect(onAlpha.status === "ready" && JSON.stringify(onAlpha.transcript)).toContain("alpha branch summary");
    expect(onAlpha.status === "ready" && JSON.stringify(onAlpha.transcript)).not.toContain("beta branch summary");
    expect(onBeta.status === "ready" && JSON.stringify(onBeta.transcript)).toContain("beta branch summary");
  });

  it("resolves a reply quote without replaying its abandoned branch", async () => {
    const root = message("m1", "shared root");
    const abandoned = message("m2", "abandoned branch detail", { parentId: root.id });
    const active = message("m3", "use this answer", { parentId: root.id, replyToId: abandoned.id });
    const result = await prepareModelContext({
      messages: [root, active],
      referenceMessages: [root, abandoned, active],
      contextWindow: 8_192,
      taskRecordText: "Goal: keep branch semantics",
    });

    expect(result.status).toBe("ready");
    if (result.status !== "ready") return;
    expect(result.transcript.at(-1)?.text).toContain("replying to User: “abandoned branch detail”");
    expect(result.transcript.filter((item) => item.text === "abandoned branch detail")).toHaveLength(0);
  });

  it("replays reaction tone on the message that received it", async () => {
    const asked = message("m1", "Ship the plan?");
    const answered = message("m2", "Yes — here is the plan", {
      role: "bot",
      parentId: asked.id,
      reactions: [{ emoji: "❤️", by: "user" }],
    });
    const result = await prepareModelContext({
      messages: [asked, answered],
      contextWindow: 8_192,
      taskRecordText: "Goal: keep reaction tone",
      userName: "Milind",
    });

    expect(result.status).toBe("ready");
    if (result.status !== "ready") return;
    expect(result.transcript.at(-1)?.text).toContain("Yes — here is the plan");
    expect(result.transcript.at(-1)?.text).toContain("[reactions: ❤️ Milind — strong affection/love-it]");
  });

  it("redacts credential-like values before returning persisted state", async () => {
    const secret = `sk-${"a".repeat(32)}`;
    const prompts: string[] = [];
    const result = await prepareModelContext({
      messages: [message("m0", `credential ${secret}`), ...longHistory(119, 1)],
      contextWindow: 1_024,
      taskRecordText: `Goal: redact ${secret}`,
      summarize: async (prompt) => {
        prompts.push(prompt);
        return `Use ${secret} for the next step`;
      },
    });

    expect(result.status).toBe("ready");
    if (result.status !== "ready") return;
    expect(prompts.join("\n")).not.toContain(secret);
    expect(result.compaction?.summary).not.toContain(secret);
    expect(result.compaction?.summary).toContain("redacted");
  });

  it("leaves existing tasks without compaction data unchanged", async () => {
    const messages = [message("m1", "one"), message("m2", "two", { role: "bot" })];
    const result = await prepareModelContext({
      messages,
      contextWindow: 8_192,
      taskRecordText: "Goal: legacy",
    });

    expect(result).toMatchObject({
      status: "ready",
      compacted: false,
      transcript: [
        { role: "user", text: "one" },
        { role: "assistant", text: "two" },
      ],
    });
    if (result.status === "ready") expect(result.compaction).toBeUndefined();
  });

  it("uses raw history when the active path has only a malformed compaction marker", async () => {
    const path = [
      message("m1", "one"),
      message("m2", "two", { role: "bot" }),
      compactionMessage("bad", "m2", { v: 1, summary: "" }),
      message("m3", "three"),
    ];
    const before = structuredClone(path);
    const result = await prepareModelContext({
      messages: path,
      contextWindow: 8_192,
      taskRecordText: "Goal: recover raw history",
    });

    expect(result).toMatchObject({
      status: "ready",
      compacted: false,
      transcript: [
        { role: "user", text: "one" },
        { role: "assistant", text: "two" },
        { role: "user", text: "three" },
      ],
    });
    expect(path).toEqual(before);
  });

  it("uses an older valid compaction when a newer marker is malformed", async () => {
    const previous: ContextCompactionV1 = {
      v: 1,
      summary: "known good summary",
      coveredThroughId: "m1",
      firstKeptId: "m2",
      contextWindow: 8_192,
      estimatedTokensBefore: 20,
      sourceMessageCount: 1,
    };
    const path = [
      message("m1", "one"),
      message("m2", "two", { role: "bot" }),
      compactionMessage("c1", "m2", previous),
      compactionMessage("bad", "c1", { v: 1, summary: "broken" }),
      message("m3", "three"),
    ];
    const before = structuredClone(path);
    const result = await prepareModelContext({
      messages: path,
      contextWindow: 8_192,
      taskRecordText: "Goal: recover valid state",
    });

    expect(result).toMatchObject({
      status: "ready",
      compacted: true,
      transcript: [
        { role: "assistant", text: expect.stringContaining("known good summary") },
        { role: "assistant", text: "two" },
        { role: "user", text: "three" },
      ],
    });
    expect(path).toEqual(before);
  });

  it("blocks on an unknown future version behind a malformed marker", async () => {
    const previous: ContextCompactionV1 = {
      v: 1,
      summary: "known good summary",
      coveredThroughId: "m1",
      firstKeptId: null,
      contextWindow: 8_192,
      estimatedTokensBefore: 10,
      sourceMessageCount: 1,
    };
    const future = { v: 99, summary: "future state", extra: { keep: true } };
    const path = [
      message("m1", "one"),
      compactionMessage("c1", "m1", previous),
      compactionMessage("future", "c1", future),
      compactionMessage("bad", "future", { v: 1, summary: "broken" }),
    ];
    const before = structuredClone(path);
    const result = await prepareModelContext({
      messages: path,
      contextWindow: 8_192,
      taskRecordText: "Goal: future",
    });

    expect(result).toEqual({ status: "unsupported", messageId: "future", version: 99 });
    expect(path).toEqual(before);
  });
});
