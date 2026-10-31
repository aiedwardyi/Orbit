import { describe, expect, it, vi } from "vitest";

import type { ModelCatalog } from "./contracts.ts";
import {
  MODEL_CONTEXT_FALLBACK,
  contextWindowFor,
  estimateContextTokens,
  isFallbackSummary,
  knownCatalogContextWindow,
  paneNotesForTurn,
  paneNotesSinceLastUserTurn,
  planCompaction,
  prepareModelContext,
  repairModelContext,
  routineCardsSinceLastUserTurn,
  repairTarget,
  supersededCompactionIds,
  withoutTurnNotes,
  type SummaryCallRecord,
} from "./context-compaction.ts";
import { probeLocalInjects } from "./drivers/local-inject.ts";
import { PANE_WAKE_PROMPT } from "./pane-wake.ts";
import type { Message } from "./store.ts";
import { lastUserInstruction } from "./task-recovery-flush.ts";
import { REPLY_MARKER, buildResumeFallback, buildTurnContext } from "./turn-context.ts";
import { readContextCompaction, type ContextCompactionV1 } from "../shared/context-compaction.ts";
import type { RoutineRunCardData } from "../shared/routine-run.ts";

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
      "SUMMARY\nGoal: ship the release. Plan: verify the build. Completed: package built. Evidence: report.json. Artifact: dist/app.zip. Blocker: signing approval. Next: run smoke tests.",
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
    expect(result.transcript[0]?.text).toContain("Wink durable context summary");
    expect(summarize).toHaveBeenCalled();
    expect(summarize.mock.calls[0]?.[0]).toContain("Goal: ship the release");
    expect(summarize.mock.calls[0]?.[0]).toContain("Completed: package built");
    expect(result.estimatedTokens).toBeLessThanOrEqual(result.budgetTokens);
  });

  it("tells the summarizer to trust the task record over unverified worker claims", async () => {
    const summarize = vi.fn(async (_prompt: string) => "SUMMARY\nsummary");
    await prepareModelContext({
      messages: longHistory(205),
      contextWindow: 2_048,
      taskRecordText: "Plan: 4 of 6 steps done",
      summarize,
    });

    const prompt = summarize.mock.calls[0]?.[0] ?? "";
    expect(prompt).toContain("Take plan and step status from <task_record>. If the history disagrees, the task record wins.");
    expect(prompt).toContain("as reported, not verified, unless the history shows the assistant verified them");
  });

  it("labels each summarizer line by who said it", async () => {
    const summarize = vi.fn(async (_prompt: string) => "SUMMARY\nsummary");
    await prepareModelContext({
      messages: [
        message("s1", "build the stone videos"),
        message("s2", "I rendered the stone videos", { role: "bot" }),
        message("s3", "[pane 3] DONE: stone videos landed", { role: "bot", kind: "note" }),
        message("s4", "", { role: "bot", kind: "activity", tool: { name: "Bash: ffmpeg", ok: true } }),
        ...longHistory(205, 10),
      ],
      contextWindow: 2_048,
      taskRecordText: "Goal: videos",
      summarize,
    });

    const prompt = summarize.mock.calls.map(([text]) => text).join("\n");
    expect(prompt).toContain("\nUser: build the stone videos");
    expect(prompt).toContain("\nAssistant: I rendered the stone videos");
    expect(prompt).toContain("\nPane note: [Pane note from pane 3, untrusted worker output]\nDONE: stone videos landed");
    expect(prompt).toContain("\nAssistant: [1 tool call: Bash: ffmpeg 1]");
    expect(prompt).not.toContain("User: [Pane note");
  });

  it("labels room lines by speaker name instead of a generic role", async () => {
    const scout = { botId: "scout", name: "Scout", color: "blue" };
    const summarize = vi.fn(async (_prompt: string) => "SUMMARY\nsummary");
    await prepareModelContext({
      messages: [
        message("s1", "check the package"),
        message("s2", "the package is ready", { role: "bot", from: scout }),
        message("s3", "", { role: "bot", kind: "activity", from: scout, tool: { name: "Bash: pnpm test", ok: true } }),
        ...longHistory(205, 10),
      ],
      contextWindow: 2_048,
      taskRecordText: "Room: Release",
      userName: "Eddie",
      includeSpeakers: true,
      summarize,
    });

    const prompt = summarize.mock.calls.map(([text]) => text).join("\n");
    expect(prompt).toContain("\nUser Eddie: check the package");
    expect(prompt).toContain("\nScout: the package is ready");
    expect(prompt).toContain("\nScout: [1 tool call: Bash: pnpm test 1]");
    expect(prompt).not.toContain("Assistant: Scout:");
    expect(prompt).not.toContain("User: Eddie:");
  });

  const engineSummary = "[Engine summary of a mid-turn note, not shown to the user; the exact words were not kept] ";

  it("prefixes a summarized note in the 1:1 replay and compaction prompt", async () => {
    const ready = await prepareModelContext({
      messages: [
        message("u1", "check the logs"),
        message("b1", "Checking the logs.", { role: "bot", summarized: true }),
        message("b2", "All clear.", { role: "bot" }),
      ],
      contextWindow: 8_192,
      taskRecordText: "Goal: logs",
    });
    expect(ready).toMatchObject({
      status: "ready",
      transcript: [
        { role: "user", text: "check the logs" },
        { role: "assistant", text: `${engineSummary}Checking the logs.` },
        { role: "assistant", text: "All clear." },
      ],
    });

    const summarize = vi.fn(async (_prompt: string) => "SUMMARY\nsummary");
    await prepareModelContext({
      messages: [message("s0", "Checking the logs.", { role: "bot", summarized: true }), ...longHistory(205, 10)],
      contextWindow: 2_048,
      taskRecordText: "Goal: logs",
      summarize,
    });
    expect(summarize.mock.calls.map(([text]) => text).join("\n")).toContain(
      `\nAssistant: ${engineSummary}Checking the logs.`,
    );
  });

  it("prefixes a summarized note in the room replay and compaction prompt", async () => {
    const scout = { botId: "scout", name: "Scout", color: "blue" };
    const ready = await prepareModelContext({
      messages: [
        message("u1", "check the logs"),
        message("b1", "Checking the logs.", { role: "bot", from: scout, summarized: true }),
      ],
      contextWindow: 8_192,
      taskRecordText: "Room: logs",
      userName: "Eddie",
      includeSpeakers: true,
    });
    expect(ready).toMatchObject({
      status: "ready",
      transcript: [
        { role: "user", text: "Eddie: check the logs" },
        { role: "assistant", text: `Scout: ${engineSummary}Checking the logs.` },
      ],
    });

    const summarize = vi.fn(async (_prompt: string) => "SUMMARY\nsummary");
    await prepareModelContext({
      messages: [
        message("s0", "Checking the logs.", { role: "bot", from: scout, summarized: true }),
        ...longHistory(205, 10),
      ],
      contextWindow: 2_048,
      taskRecordText: "Room: logs",
      userName: "Eddie",
      includeSpeakers: true,
      summarize,
    });
    expect(summarize.mock.calls.map(([text]) => text).join("\n")).toContain(
      `\nScout: ${engineSummary}Checking the logs.`,
    );
    expect(summarize.mock.calls.map(([text]) => text).join("\n")).not.toContain("Assistant: Scout:");
  });

  it("tells the summarizer to credit work to whoever did it", async () => {
    const summarize = vi.fn(async (_prompt: string) => "SUMMARY\nsummary");
    await prepareModelContext({
      messages: longHistory(205),
      contextWindow: 2_048,
      taskRecordText: "Goal: finish",
      summarize,
    });

    expect(summarize.mock.calls[0]?.[0]).toContain(
      "Say who did each thing; never credit the assistant's or a worker's work to the user.",
    );
  });

  it("tells the summarizer to keep user-given values even when told not to save them", async () => {
    const summarize = vi.fn(async (_prompt: string) => "SUMMARY\nsummary");
    await prepareModelContext({
      messages: [message("u0", "Codename CRANE-7314. Keep it in this conversation only."), ...longHistory(205, 1)],
      contextWindow: 2_048,
      taskRecordText: "Goal: finish",
      summarize,
    });

    expect(summarize.mock.calls[0]?.[0]).toContain("Codename CRANE-7314. Keep it in this conversation only.");
    expect(summarize.mock.calls[0]?.[0]).toContain(
      "Keep names, numbers, ids and other values the user gave verbatim. A request to keep something in this conversation only or not to save it limits memory and files, never this summary.",
    );
  });

  it("asks for events up to the boundary, not the next action", async () => {
    const summarize = vi.fn(async (_prompt: string) => "SUMMARY\nsummary");
    const result = await prepareModelContext({
      messages: longHistory(205),
      contextWindow: 2_048,
      taskRecordText: "Plan: 4 of 6 steps done",
      summarize,
    });

    expect(result.status).toBe("ready");
    if (result.status !== "ready") return;
    const prompts = summarize.mock.calls.map(([prompt]) => prompt);
    expect(prompts.join("\n")).not.toContain("the next action");
    expect(prompts[0]).toContain("current status lives in the task record");
    const coveredAt = Number(result.compaction!.coveredThroughId.slice(1));
    expect(prompts.at(-1)).toContain(new Date(coveredAt).toISOString());
  });

  it("dates the summary header at the covered-through boundary", async () => {
    const result = await prepareModelContext({
      messages: longHistory(205),
      contextWindow: 2_048,
      taskRecordText: "Goal: finish",
      summarize: async () => "SUMMARY\ndated summary",
    });

    expect(result.status).toBe("ready");
    if (result.status !== "ready") return;
    const coveredAt = Number(result.compaction!.coveredThroughId.slice(1));
    expect(result.transcript[0]?.text).toContain(new Date(coveredAt).toISOString());
    expect(result.transcript[0]?.text).toContain("follows verbatim");
  });

  it("dates a reused summary at its own boundary", async () => {
    const previous: ContextCompactionV1 = {
      v: 1,
      summary: "known good summary",
      coveredThroughId: "m1",
      firstKeptId: "m2",
      contextWindow: 8_192,
      estimatedTokensBefore: 20,
      sourceMessageCount: 1,
    };
    const result = await prepareModelContext({
      messages: [message("m1", "one"), message("m2", "two", { role: "bot" }), compactionMessage("c1", "m2", previous), message("m3", "three")],
      contextWindow: 8_192,
      taskRecordText: "Goal: finish",
    });

    expect(result.status).toBe("ready");
    if (result.status !== "ready") return;
    expect(result.transcript[0]?.text).toContain(new Date(1).toISOString());
  });

  it.each([10, 10_000])("does not replay %i covered messages", async (count) => {
    let reads = 0;
    const covered = Array.from({ length: count }, (_, index): Message => ({
      id: `m${index}`,
      at: index + 1,
      role: "user",
      kind: "text",
      get text() {
        reads++;
        return "covered text";
      },
    }));
    const previous: ContextCompactionV1 = {
      v: 1,
      summary: "known good summary",
      coveredThroughId: `m${count - 1}`,
      firstKeptId: "tail",
      contextWindow: 8_192,
      estimatedTokensBefore: count * 10,
      sourceMessageCount: count,
    };
    const result = await prepareModelContext({
      messages: [...covered, message("tail", "recent work"), compactionMessage("c1", "tail", previous)],
      contextWindow: 8_192,
      taskRecordText: "Goal: finish",
    });

    expect(result.status).toBe("ready");
    if (result.status !== "ready") return;
    expect(result.compactionId).toBe("c1");
    expect(result.transcript).toHaveLength(2);
    expect(result.transcript[0]?.text).toContain(new Date(count).toISOString());
    expect(result.transcript[1]).toEqual({ role: "user", text: "recent work" });
    expect(reads).toBe(0);
  });

  it("resolves a tail reply to a covered message", async () => {
    const covered = Array.from({ length: 10 }, (_, index) => message(`m${index}`, `covered ${index}`));
    const previous: ContextCompactionV1 = {
      v: 1,
      summary: "known good summary",
      coveredThroughId: "m9",
      firstKeptId: "tail",
      contextWindow: 8_192,
      estimatedTokensBefore: 100,
      sourceMessageCount: 10,
    };
    const result = await prepareModelContext({
      messages: [...covered, message("tail", "recent work", { replyToId: "m4" }), compactionMessage("c1", "tail", previous)],
      contextWindow: 8_192,
      taskRecordText: "Goal: finish",
    });

    expect(result.status).toBe("ready");
    if (result.status !== "ready") return;
    expect(result.transcript).toHaveLength(2);
    expect(result.transcript[1]?.text).toContain("replying to User: “covered 4”");
  });

  it("does not count tool lines toward the message cap", async () => {
    const tools = Array.from({ length: 150 }, (_, index): Message => message(`t${index}`, "", {
      role: "bot",
      kind: "activity",
      tool: { name: "Read", ok: true },
    }));
    const summarize = vi.fn(async () => "unused");
    const result = await prepareModelContext({
      messages: [...longHistory(20), ...tools],
      contextWindow: 200_000,
      taskRecordText: "Goal: finish",
      summarize,
    });

    expect(result.status).toBe("ready");
    if (result.status !== "ready") return;
    expect(result.compaction).toBeUndefined();
    expect(result.transcript).toHaveLength(21);
    expect(result.transcript.at(-1)?.text).toBe("[150 tool calls: Read 150]");
    expect(summarize).not.toHaveBeenCalled();
  });

  it("counts user turns, not bot bubbles, toward the compaction cap", async () => {
    const messages = Array.from({ length: 20 }, (_, turn) => [
      message(`u${turn}`, `request ${turn}`),
      ...Array.from({ length: 10 }, (_, bubble) => message(`b${turn}-${bubble}`, `ack ${turn}.${bubble}`, { role: "bot" })),
    ]).flat();
    const summarize = vi.fn(async () => "SUMMARY\nunused");
    const result = await prepareModelContext({
      messages,
      contextWindow: 200_000,
      taskRecordText: "Goal: finish",
      summarize,
    });

    expect(result.status).toBe("ready");
    if (result.status !== "ready") return;
    expect(result.compaction).toBeUndefined();
    expect(result.transcript).toHaveLength(220);
    expect(summarize).not.toHaveBeenCalled();
  });

  it("starts the kept tail on a user message", async () => {
    const messages = Array.from({ length: 70 }, (_, turn) => [
      message(`u${turn}`, `request ${turn}`),
      ...Array.from({ length: 4 }, (_, bubble) => message(`b${turn}-${bubble}`, `ack ${turn}.${bubble}`, { role: "bot" })),
    ]).flat();
    const result = await prepareModelContext({
      messages,
      contextWindow: 200_000,
      taskRecordText: "Goal: finish",
      summarize: async () => "SUMMARY\nturns summary",
    });

    expect(result.status).toBe("ready");
    if (result.status !== "ready") return;
    expect(result.compaction).toBeDefined();
    expect(result.transcript[1]).toMatchObject({ role: "user", text: expect.stringMatching(/^request /) });
    expect(result.compaction?.firstKeptId).toMatch(/^u/);
  });

  it("folds the previous durable summary into later summaries", async () => {
    const first = await prepareModelContext({
      messages: longHistory(120),
      contextWindow: 1_024,
      taskRecordText: "Goal: finish",
      summarize: async () => "SUMMARY\nsummary one",
    });
    expect(first.status).toBe("ready");
    if (first.status !== "ready") return;
    expect(first.compaction).toBeDefined();
    expect(first.compactionId).toBeUndefined();
    if (!first.compaction) return;

    const firstRecord = compactionMessage("c1", "m119", first.compaction);
    const summarize = vi.fn(async (_prompt: string) => "SUMMARY\nsummary two");
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

  it("keeps continuity for an engine A to B to A sequence without re-summarizing", async () => {
    const history = longHistory(120);
    const first = await prepareModelContext({
      messages: history,
      contextWindow: 1_024,
      taskRecordText: "Goal: finish the release",
      summarize: async () => "SUMMARY\nengine A summary with early evidence",
    });
    expect(first.status).toBe("ready");
    if (first.status !== "ready") return;
    expect(first.compaction).toBeDefined();
    if (!first.compaction) return;

    const marker = compactionMessage("c1", "m119", first.compaction);
    const bResult = message("m120", "engine B verified the installer", { role: "bot" });
    const path = [...history, marker, bResult];
    const summarize = vi.fn(async (_prompt: string) => "unused");
    const onB = await prepareModelContext({
      messages: path,
      contextWindow: 32_768,
      taskRecordText: "Goal: finish the release",
      summarize,
    });
    expect(onB.status).toBe("ready");
    if (onB.status !== "ready") return;
    expect(summarize).not.toHaveBeenCalled();
    expect(onB.compactionId).toBe("c1");
    expect(onB.transcript[0]?.text).toContain("engine A summary with early evidence");
    expect(onB.transcript.at(-1)?.text).toContain("engine B verified the installer");

    const backOnA = await prepareModelContext({
      messages: path,
      contextWindow: 1_024,
      taskRecordText: "Goal: finish the release",
      summarize,
    });
    expect(backOnA.status).toBe("ready");
    if (backOnA.status !== "ready") return;
    expect(summarize).not.toHaveBeenCalled();
    expect(backOnA.transcript[0]?.text).toContain("engine A summary with early evidence");
    expect(backOnA.transcript.at(-1)?.text).toContain("engine B verified the installer");
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
        return "SUMMARY\nflushed summary";
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
    expect(second.compaction?.summary.split("Model summary unavailable")).toHaveLength(2);
    expect(second.compaction?.summary).not.toContain("[Previous durable summary]");
    expect(second.compaction?.summary).toContain("work item 0:");
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
    const toolItems = result.transcript.filter((item) => item.text.includes("tool call"));
    expect(toolItems).toEqual([
      { role: "assistant", text: "[1 tool call: Bash: pnpm test 1]" },
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
      "Scout: [1 tool call: Bash: pnpm test 1]",
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
    expect(knownCatalogContextWindow(catalog, "small")).toBe(4_096);
    expect(knownCatalogContextWindow(catalog, "missing")).toBeNull();
    expect(knownCatalogContextWindow({ default: "x", options: [{ id: "x", label: "X" }] }, "x")).toBeNull();
  });

  it("falls back to a window no current chat model is below", () => {
    expect(contextWindowFor({ default: "x", options: [{ id: "x", label: "X" }] }, "x")).toBeGreaterThanOrEqual(128_000);
  });

  it("gives a local model with no reported window a conservative budget", async () => {
    const fetchImpl = vi.fn(async (input: unknown) => {
      const url = String(input);
      if (url === "http://127.0.0.1:11434/v1/models") return new Response(JSON.stringify({ data: [{ id: "small:latest" }] }));
      if (url === "http://127.0.0.1:11434/api/ps") return new Response(JSON.stringify({ models: [] }));
      return new Response("", { status: 404 });
    }) as unknown as typeof fetch;
    const local = (await probeLocalInjects({}, fetchImpl)).find((model) => model.id === "ollama::small:latest")!;
    expect(local.contextWindow).toBeUndefined();
    const catalog: ModelCatalog = { default: "cloud", options: [{ id: "cloud", label: "Cloud" }, local] };
    expect(contextWindowFor(catalog, local.id)).toBeLessThanOrEqual(16_384);
    expect(contextWindowFor(catalog, "cloud")).toBe(MODEL_CONTEXT_FALLBACK);

    const result = await prepareModelContext({
      messages: [message("m1", "detail ".repeat(9000))],
      contextWindow: contextWindowFor(catalog, local.id),
      taskRecordText: "",
    });
    expect(result.status).toBe("ready");
    if (result.status !== "ready") return;
    expect(result.compacted).toBe(true);
    expect(result.estimatedTokens).toBeLessThanOrEqual(8_192);
  });

  it("keeps the summary chain when the window grows instead of replaying the whole history", async () => {
    const previous: ContextCompactionV1 = {
      v: 1,
      summary: "small-window summary",
      coveredThroughId: "m9",
      firstKeptId: "m10",
      contextWindow: 16_384,
      estimatedTokensBefore: 9_000,
      sourceMessageCount: 1_000,
    };
    const summarize = vi.fn(async (_prompt: string) => "SUMMARY\ngrown-window summary");
    const result = await prepareModelContext({
      messages: [...longHistory(12), compactionMessage("c1", "m11", previous), ...longHistory(128, 12)],
      contextWindow: 200_000,
      taskRecordText: "Goal: finish",
      summarize,
    });

    expect(result.status).toBe("ready");
    if (result.status !== "ready") return;
    expect(summarize.mock.calls.length).toBeLessThanOrEqual(1);
    expect(summarize.mock.calls[0]?.[0]).toContain("small-window summary");
    expect(summarize.mock.calls[0]?.[0]).not.toContain("work item 0");
    expect(result.compaction?.previousCompactionId).toBe("c1");
    expect(result.compaction?.sourceMessageCount).toBeGreaterThan(1_000);
  });

  it("compacts three large pastes on a 16k window but not on a 200k window", async () => {
    const pastes = [
      message("m1", "paste one: " + "x".repeat(30_000)),
      message("m2", "paste two: " + "y".repeat(30_000)),
      message("m3", "paste three: " + "z".repeat(30_000)),
    ];
    const summarize = async () => "SUMMARY\npasted three large files";

    const wide = await prepareModelContext({
      messages: pastes,
      contextWindow: 200_000,
      taskRecordText: "Goal: review the pastes",
      summarize,
    });
    expect(wide.status).toBe("ready");
    if (wide.status !== "ready") return;
    expect(wide.compacted).toBe(false);
    expect(wide.compaction).toBeUndefined();
    expect(wide.budgetTokens).toBe(100_000);
    expect(wide.transcript).toHaveLength(3);

    const narrow = await prepareModelContext({
      messages: pastes,
      contextWindow: 16_384,
      taskRecordText: "Goal: review the pastes",
      summarize,
    });
    expect(narrow.status).toBe("ready");
    if (narrow.status !== "ready") return;
    expect(narrow.compaction?.summary).toContain("pasted three large files");
  });

  it("keeps small-window context within its deterministic budget", async () => {
    const result = await prepareModelContext({
      messages: longHistory(180),
      contextWindow: 1_024,
      taskRecordText: "Goal: bounded",
      summarize: async () => "SUMMARY\nbounded summary",
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
        return "SUMMARY\nsegmented summary";
      },
    });

    expect(result.status).toBe("ready");
    expect(prompts.length).toBeGreaterThan(1);
    expect(prompts.join("\n")).toContain("BEGIN-");
    expect(prompts.join("\n")).toContain("-END");
    expect(prompts.join("\n")).not.toContain("shortened for model context");
  });

  it("trims an oversized summary after its last whole line and lands it", async () => {
    const records: SummaryCallRecord[] = [];
    const reply = Array.from({ length: 1_000 }, (_, index) => `line ${index}: alpha beta gamma`).join("\n");
    const result = await prepareModelContext({
      messages: longHistory(130),
      contextWindow: 128_000,
      taskRecordText: "Goal: preserve valid state",
      summarize: async () => `SUMMARY\n${reply}`,
      onSummaryCall: (record) => records.push(record),
    });

    expect(result.status).toBe("ready");
    if (result.status !== "ready") return;
    const lines = result.compaction!.summary.split("\n");
    expect(lines.at(-1)).toBe("[summary trimmed to fit]");
    expect(lines.length).toBeGreaterThan(100);
    expect(reply.startsWith(`${lines.slice(0, -1).join("\n")}\n`)).toBe(true);
    expect(records.map((record) => record.result)).toEqual(["trimmed"]);
    expect(estimateContextTokens(result.transcript.slice(0, 1))).toBeLessThanOrEqual(records[0]!.outBudget);
  });

  it("trims a single oversized line at its last whitespace, else at a character", async () => {
    for (const [reply, kept] of [["word ".repeat(9_000), /^(word )*word$/], ["x".repeat(30_000), /^x+$/]] as const) {
      const records: SummaryCallRecord[] = [];
      const result = await prepareModelContext({
        messages: longHistory(130),
        contextWindow: 128_000,
        taskRecordText: "Goal: preserve valid state",
        summarize: async () => `SUMMARY\n${reply}`,
        onSummaryCall: (record) => records.push(record),
      });

      expect(result.status).toBe("ready");
      if (result.status !== "ready") return;
      const [head, marker, ...rest] = result.compaction!.summary.split("\n");
      expect(head).toMatch(kept);
      expect(marker).toBe("[summary trimmed to fit]");
      expect(rest).toEqual([]);
      expect(estimateContextTokens(result.transcript.slice(0, 1))).toBeLessThanOrEqual(records[0]!.outBudget);
    }
  });

  it("asks for the summary size in words under the token budget", async () => {
    const records: SummaryCallRecord[] = [];
    const summarize = vi.fn(async (_prompt: string) => "SUMMARY\nsummary");
    await prepareModelContext({
      messages: longHistory(130),
      contextWindow: 128_000,
      taskRecordText: "Goal: fit",
      summarize,
      onSummaryCall: (record) => records.push(record),
    });

    const ask = /^Start with the line SUMMARY, then plain text only, and keep it under (\d+) words\.$/m.exec(summarize.mock.calls[0]![0]);
    expect(Number(ask?.[1])).toBeGreaterThan(0);
    expect(Number(ask?.[1])).toBeLessThan(records[0]!.outBudget);
    expect(summarize.mock.calls[0]![0]).not.toContain("estimated tokens");
  });

  it("cuts fallback sections at whole lines", async () => {
    const result = await prepareModelContext({
      messages: longHistory(120),
      contextWindow: 2_048,
      taskRecordText: "Goal: finish the release",
    });

    expect(result.status).toBe("ready");
    if (result.status !== "ready") return;
    const items = result.compaction!.summary.split("\n").filter((line) => line.includes("work item"));
    expect(items.length).toBeGreaterThan(0);
    for (const line of items) expect(line).toMatch(/^(Assistant: )?work item \d+: (detail ){17}detail ?$/);
  });

  it("cuts a first line longer than its section at a word instead of emptying the section", async () => {
    const result = await prepareModelContext({
      messages: [message("m0", `first request: ${"alpha beta ".repeat(400)}end`, { role: "user" }), ...longHistory(119, 1)],
      contextWindow: 2_048,
      taskRecordText: "Goal: finish the release",
    });

    expect(result.status).toBe("ready");
    if (result.status !== "ready") return;
    const requests = result.compaction!.summary.split("[User requests in this segment]\n")[1]!;
    expect(requests).toMatch(/^first request: (alpha beta )*alpha( beta)?\n\[shortened for model context; full transcript remains available\]/);
  });

  it("trims the previous summary in a fallback at a line start", async () => {
    const previous: ContextCompactionV1 = {
      v: 1,
      summary: Array.from({ length: 400 }, (_, index) => `fact ${index + 1}: alpha beta gamma delta`).join("\n"),
      coveredThroughId: "m9",
      firstKeptId: "m10",
      contextWindow: 8_192,
      estimatedTokensBefore: 900,
      sourceMessageCount: 5,
    };
    const result = await prepareModelContext({
      messages: [...longHistory(12), compactionMessage("c1", "m11", previous), ...longHistory(128, 12)],
      contextWindow: 8_192,
      taskRecordText: "Goal: preserve state",
    });

    expect(result.status).toBe("ready");
    if (result.status !== "ready") return;
    expect(result.compaction!.summary).toMatch(/\[earlier summary trimmed\]\nfact \d+: alpha beta gamma delta\n/);
    expect(result.compaction!.summary).toContain("fact 400: alpha beta gamma delta");
  });

  it("keeps the previous summary when the summarizer answers the chat instead", async () => {
    const previous: ContextCompactionV1 = {
      v: 1,
      summary: "known good summary",
      coveredThroughId: "m9",
      firstKeptId: "m10",
      contextWindow: 200_000,
      estimatedTokensBefore: 900,
      sourceMessageCount: 5,
    };
    const warning = vi.spyOn(console, "warn").mockImplementation(() => {});
    const summarize = vi.fn(async (_prompt: string) => "Got it, go home, I've got this.");
    try {
      const result = await prepareModelContext({
        messages: [...longHistory(12), compactionMessage("c1", "m11", previous), ...longHistory(128, 12)],
        contextWindow: 200_000,
        taskRecordText: "Goal: preserve state",
        summarize,
      });

      expect(result.status).toBe("ready");
      if (result.status !== "ready") return;
      expect(summarize).toHaveBeenCalledTimes(2);
      expect(result.compaction?.summary).toContain("known good summary");
      expect(result.compaction?.summary).not.toContain("Got it, go home");
      expect(result.compaction?.summary).toContain("work item 12");
    } finally {
      warning.mockRestore();
    }
  });

  it("retries once when the summary shrinks below the floor", async () => {
    const previous: ContextCompactionV1 = {
      v: 1,
      summary: "known good summary with evidence. ".repeat(20).trim(),
      coveredThroughId: "m9",
      firstKeptId: "m10",
      contextWindow: 200_000,
      estimatedTokensBefore: 900,
      sourceMessageCount: 5,
    };
    const summarize = vi.fn()
      .mockResolvedValueOnce("SUMMARY\nshort")
      .mockResolvedValue(`SUMMARY\n${"retried summary with the full day of evidence. ".repeat(10).trim()}`);
    const result = await prepareModelContext({
      messages: [...longHistory(12), compactionMessage("c1", "m11", previous), ...longHistory(128, 12)],
      contextWindow: 200_000,
      taskRecordText: "Goal: preserve state",
      summarize,
    });

    expect(result.status).toBe("ready");
    if (result.status !== "ready") return;
    expect(summarize).toHaveBeenCalledTimes(2);
    expect(summarize.mock.calls[1]?.[0]).toBe(summarize.mock.calls[0]?.[0]);
    expect(result.compaction?.summary).toContain("retried summary");
    expect(result.compaction?.summary).not.toContain("short");
  });

  it("keeps the previous summary whole and appends a digest when there is no summarizer", async () => {
    const previous: ContextCompactionV1 = {
      v: 1,
      summary: Array.from({ length: 100 }, (_, index) => `fact ${index + 1}: alpha beta gamma`).join("\n"),
      coveredThroughId: "m9",
      firstKeptId: "m10",
      contextWindow: 8_192,
      estimatedTokensBefore: 900,
      sourceMessageCount: 5,
    };
    const result = await prepareModelContext({
      messages: [...longHistory(12), compactionMessage("c1", "m11", previous), ...longHistory(128, 12)],
      contextWindow: 8_192,
      taskRecordText: "Goal: preserve state",
    });

    expect(result.status).toBe("ready");
    if (result.status !== "ready") return;
    expect(result.compaction?.summary).toContain("fact 1:");
    expect(result.compaction?.summary).toContain("fact 100:");
    expect(result.compaction?.summary).toContain("work item 12");
    expect(result.estimatedTokens).toBeLessThanOrEqual(result.budgetTokens);
  });

  it("keeps recent assistant answers and pane notes in the deterministic fallback", async () => {
    const messages = Array.from({ length: 61 }, (_, index) => [
      message(`u${index}`, "please inspect"),
      message(`a${index}`, index === 36 ? "Artifact: release-final.zip" : "done", { role: "bot" }),
      ...(index === 36 ? [message("note", "[pane worker] Verified checksum 9f3c", { kind: "note" })] : []),
    ]).flat();
    const result = await prepareModelContext({ messages, contextWindow: 128_000, taskRecordText: "Goal: inspect" });

    expect(result.status).toBe("ready");
    if (result.status !== "ready") return;
    expect(result.compaction?.coveredThroughId).toBe("note");
    expect(result.compaction?.firstKeptId).toBe("u37");
    expect(result.compaction?.summary).toContain("release-final.zip");
    expect(result.compaction?.summary).toContain("Verified checksum 9f3c");
    expect(result.compaction?.summary).toContain("User requests in this segment");
  });

  it("bounds fallback answer excerpts on a small window", async () => {
    const messages = Array.from({ length: 61 }, (_, index) => [
      message(`u${index}`, "please inspect"),
      message(`a${index}`, `answer ${index} ${"x".repeat(20_000)}`, { role: "bot" }),
    ]).flat();
    const result = await prepareModelContext({ messages, contextWindow: 16_384, taskRecordText: "Goal: inspect" });

    expect(result.status).toBe("ready");
    if (result.status !== "ready") return;
    const summary = result.compaction!.summary;
    expect(summary).toContain("User requests in this segment");
    expect(summary).not.toContain("x".repeat(1_000));
    expect(result.estimatedTokens).toBeLessThanOrEqual(result.budgetTokens);
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
      contextWindow: 2_048,
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
          if (calls === 1) return "SUMMARY\npartial generated summary marker";
          throw new Error(`summary provider unavailable ${secret}`);
        },
      });

      expect(calls).toBeGreaterThan(1);
      expect(result.status).toBe("ready");
      if (result.status !== "ready") return;
      expect(result.compaction?.summary).toContain("partial generated summary marker");
      expect(warning).toHaveBeenCalledWith(expect.stringMatching(/^context compaction: summarizer failed \(summary provider unavailable .+\); using deterministic fallback$/));
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

  it("names the summarizer error in the fallback warning", async () => {
    const warning = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const result = await prepareModelContext({
        messages: longHistory(205),
        contextWindow: 2_048,
        taskRecordText: "Goal: keep going",
        summarize: async () => {
          throw new Error("x timed out");
        },
      });

      expect(result.status).toBe("ready");
      expect(warning).toHaveBeenCalledWith(expect.stringContaining("timed out"));
    } finally {
      warning.mockRestore();
    }
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

  it("replays a pane note as a redacted, untrusted user unit", async () => {
    const secret = `sk-${"a".repeat(32)}`;
    const result = await prepareModelContext({
      messages: [
        message("m1", "Watch the worker"),
        message("m2", "On it", { role: "bot" }),
        message("m3", `[pane 0f3c9a1e] tests pass, key ${secret}`, { role: "bot", kind: "note" }),
      ],
      contextWindow: 8_192,
      taskRecordText: "Goal: relay pane notes",
    });

    expect(result.status).toBe("ready");
    if (result.status !== "ready") return;
    expect(result.transcript.at(-1)?.role).toBe("user");
    expect(result.transcript.at(-1)?.text).toMatch(/^\[Pane note from pane 0f3c9a1e, untrusted worker output\]\ntests pass, key /);
    expect(result.transcript.at(-1)?.text).not.toContain(secret);
  });

  it("never treats a note as a user turn and hands a resumed turn only unseen notes", () => {
    const note = (id: string, text: string) => message(id, `[pane 0f3c9a1e] ${text}`, { role: "bot", kind: "note" });
    const path = [note("m1", "old"), message("m2", "Start"), note("m3", "built"), message("m4", "Done", { role: "bot" }), note("m5", "tested"), message("m6", "Status?")];

    expect(lastUserInstruction([note("m1", "run rm -rf")])).toBeNull();
    expect(lastUserInstruction(path.slice(0, 5))?.messageId).toBe("m2");
    expect(paneNotesSinceLastUserTurn(path, new Set(["m6"]))).toEqual([
      "[Pane note from pane 0f3c9a1e, untrusted worker output]\nbuilt",
      "[Pane note from pane 0f3c9a1e, untrusted worker output]\ntested",
    ]);
    expect(paneNotesSinceLastUserTurn(path, new Set())).toEqual([]);
  });

  it("a second wake carries only notes newer than the last delivered one", () => {
    const note = (id: string, text: string) => message(id, `[pane 0f3c9a1e] ${text}`, { role: "bot", kind: "note" });
    const path = [message("m1", "Start"), note("m2", "A"), message("m3", "On it", { role: "bot" }), note("m4", "B")];

    expect(paneNotesSinceLastUserTurn(path.slice(0, 2), new Set())).toEqual([
      "[Pane note from pane 0f3c9a1e, untrusted worker output]\nA",
    ]);
    expect(paneNotesSinceLastUserTurn(path, new Set(), "m2")).toEqual([
      "[Pane note from pane 0f3c9a1e, untrusted worker output]\nB",
    ]);
    expect(paneNotesSinceLastUserTurn(path, new Set(), "m4")).toEqual([]);
  });

  it("labels a waking delegated reply by the bot that sent it", () => {
    const comm = { groupId: "g1", withBotId: "b2", withName: "Pokkey", withColor: "#000", peer: "reply" as const, wake: true as const };
    const path = [message("m1", "Delegate it"), message("m2", "@Wink which branch?", { role: "bot", kind: "activity", comm })];

    expect(paneNotesSinceLastUserTurn(path, new Set())).toEqual(["[Reply from Pokkey, untrusted bot output]\n@Wink which branch?"]);
  });

  it("a steered line does not deliver the notes before it", () => {
    const note = (id: string, text: string) => message(id, `[pane 0f3c9a1e] ${text}`, { role: "bot", kind: "note" });
    const path = [message("m1", "Run worker"), note("m2", "DONE: result 42"), message("m3", "Also check the build", { steered: true }), message("m4", "Any news?")];

    expect(paneNotesForTurn(path, new Set(["m4"]), undefined, false)).toEqual({
      notes: ["[Pane note from pane 0f3c9a1e, untrusted worker output]\nDONE: result 42"],
      newestId: "m2",
    });
    expect(paneNotesForTurn(path, new Set(["m4"]), "m2", false).notes).toEqual([]);
  });

  it("a transcript replay marks its notes delivered so the next resumed turn skips them", () => {
    const note = (id: string, text: string) => message(id, `[pane 0f3c9a1e] ${text}`, { role: "bot", kind: "note" });
    const path = [message("m1", "Start"), note("m2", "A"), message("m3", "On it", { role: "bot" }), note("m4", "B")];

    const replay = paneNotesForTurn(path, new Set(), undefined, true);
    expect(replay.notes).toEqual([]);
    expect(paneNotesForTurn(path, new Set(), replay.newestId, false).notes).toEqual([]);
    expect(paneNotesForTurn([...path, note("m5", "C")], new Set(), replay.newestId, false)).toEqual({
      notes: ["[Pane note from pane 0f3c9a1e, untrusted worker output]\nC"],
      newestId: "m5",
    });
  });

  it("a replayed wake turn carries its note after the reply marker, once", async () => {
    const note = (id: string, text: string) => message(id, `[pane 0f3c9a1e] ${text}`, { role: "bot", kind: "note" });
    const path = [message("m1", "Run the worker"), note("m2", "DONE: result 42"), message("m3", "Waiting on the worker", { role: "bot" })];
    const prepared = await prepareModelContext({ messages: path, contextWindow: 200_000, taskRecordText: "Goal: demo" });
    if (prepared.status !== "ready") throw new Error(prepared.status);
    const noteText = "[Pane note from pane 0f3c9a1e, untrusted worker output]\nDONE: result 42";

    for (const resumed of [false, true]) {
      const { notes } = paneNotesForTurn(path, new Set(), undefined, !resumed, true);
      const transcript = withoutTurnNotes(prepared.transcript, notes);
      const text = [...notes, "Current message:", PANE_WAKE_PROMPT].join("\n\n");
      const { turnText } = buildTurnContext({ text, transcript, rewound: false, fresh: !resumed, replaysNatively: false });
      const fallback = buildResumeFallback({ text, transcript });
      for (const sent of resumed ? [fallback] : [turnText]) {
        const afterMarker = sent.slice(sent.indexOf(REPLY_MARKER));
        expect(afterMarker).toContain(`${noteText}\n\nCurrent message:\n\n${PANE_WAKE_PROMPT}`);
        expect(sent.split(noteText)).toHaveLength(2);
        expect(sent).toContain("Assistant: Waiting on the worker");
      }
    }
  });

  it("an inline replay reserves its notes, keeps them out of history, and delivers the rest later", async () => {
    const note = (id: string, text: string) => message(id, `[pane 0f3c9a1e] ${text}`, { role: "bot", kind: "note" });
    const window = 16_384;
    const notes = Array.from({ length: 7 }, (_, i) => note(`m${i + 3}`, `DONE ${i} ${"x".repeat(7_801)}`));
    const path = [message("m1", "Run the workers"), message("m2", "Waiting on the workers", { role: "bot" }), ...notes];

    const batch = paneNotesForTurn(path, new Set(), undefined, true, true, window);
    const prepared = await prepareModelContext({
      messages: path,
      contextWindow: window,
      taskRecordText: "Goal: relay worker reports",
      excludeIds: new Set(batch.ids ?? []),
      reserveTokens: batch.tokens,
    });
    if (prepared.status !== "ready") throw new Error(prepared.status);
    const text = [...batch.notes, "Current message:", PANE_WAKE_PROMPT].join("\n\n");
    const transcript = withoutTurnNotes(prepared.transcript, batch.notes);
    const { turnText } = buildTurnContext({ text, transcript, rewound: false, fresh: true, replaysNatively: false });

    expect(estimateContextTokens([{ text: turnText }])).toBeLessThanOrEqual(window / 2);
    const history = turnText.slice(0, turnText.indexOf(REPLY_MARKER));
    for (const sent of batch.notes) {
      expect(turnText.split(sent)).toHaveLength(2);
      expect(history).not.toContain(sent.split("\n")[1]!.slice(0, 7));
    }

    const delivered: string[] = [];
    for (let deliveredId: string | undefined, turn = 0; turn < 7; turn++) {
      const next = paneNotesForTurn(path, new Set(), deliveredId, true, true, window);
      if (!next.notes.length) break;
      delivered.push(...next.notes);
      deliveredId = next.newestId;
    }
    expect(delivered.map((sent) => sent.split("\n")[1]!.slice(0, 6))).toEqual(notes.map((_, i) => `DONE ${i}`));
  });

  it("clips a lone note larger than its share of a small window", () => {
    const path = [message("m1", "Run it"), message("m2", `[pane 0f3c9a1e] ${"y".repeat(7_800)}`, { role: "bot", kind: "note" })];
    const batch = paneNotesForTurn(path, new Set(), undefined, true, true, 4_096);

    expect(batch.ids).toEqual(["m2"]);
    expect(batch.newestId).toBe("m2");
    expect(batch.tokens).toBeLessThanOrEqual(2_048);
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
        return `SUMMARY\nUse ${secret} for the next step`;
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
    if (result.status === "ready") {
      expect(result.compaction).toBeUndefined();
      expect(result.compactionId).toBe("c1");
      expect(result.expanded).toBeUndefined();
    }
    expect(path).toEqual(before);
  });

  it("keeps the previous summary on a grown window and only allows a bigger tail", async () => {
    const previous: ContextCompactionV1 = {
      v: 1,
      summary: "small-window summary",
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
      message("m3", "three"),
    ];
    const result = await prepareModelContext({
      messages: path,
      contextWindow: 200_000,
      taskRecordText: "Goal: keep the chain",
    });

    expect(result).toMatchObject({
      status: "ready",
      compacted: true,
      compactionId: "c1",
      transcript: [
        { role: "assistant", text: expect.stringContaining("small-window summary") },
        { role: "assistant", text: "two" },
        { role: "user", text: "three" },
      ],
    });
    if (result.status === "ready") expect(result.expanded).toBeUndefined();
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

describe("tool line folding", () => {
  const chip = (id: string, name: string, patch: Partial<NonNullable<Message["tool"]>> = {}, extra: Partial<Message> = {}): Message =>
    message(id, "", { role: "bot", kind: "activity", tool: { name, ok: true, ...patch }, ...extra });

  const busyThread = (): Message[] => Array.from({ length: 24 }, (_, turn) => {
    const tools = ["Bash", "Read", "Edit", "mcp__orbit__terminal_spawn"];
    const probe = `probe-${String(turn).padStart(2, "0")}`;
    return [
      message(`u${turn}`, `request ${turn}: ${"context ".repeat(4)}`),
      ...Array.from({ length: 40 }, (_, call) => {
        const name = call === 0 ? probe : turn === 7 && call === 5 ? "PowerShell" : tools[call % 4]!;
        return [
          chip(`t${turn}-${call}`, name, { ok: name !== "PowerShell" }),
          chip(`a${turn}-${call}`, `auto-approved ${name}: pnpm exec vitest run server/context-compaction.test.ts --reporter dot ${call}`, { approval: true }),
        ];
      }).flat(),
    ];
  }).flat();

  it("replays one line per tool run and no approval chips", async () => {
    const result = await prepareModelContext({
      messages: busyThread(),
      contextWindow: 200_000,
      taskRecordText: "Goal: ship",
    });

    expect(result.status).toBe("ready");
    if (result.status !== "ready") return;
    const text = JSON.stringify(result.transcript);
    expect(text).not.toContain("auto-approved");
    expect(text).not.toContain("mcp__");
    const toolLines = result.transcript.filter((item) => item.text.includes("tool calls"));
    expect(toolLines).toHaveLength(24);
    expect(toolLines[0]).toEqual({
      role: "assistant",
      text: "[40 tool calls: Read 10, Edit 10, terminal_spawn 10, Bash 9, probe-00 1]",
    });
    const failed = toolLines.filter((item) => item.text.includes("; failed: "));
    expect(failed).toHaveLength(1);
    expect(failed[0]?.text).toContain("probe-07 1");
    expect(failed[0]?.text).toMatch(/; failed: PowerShell 1\]$/);
    expect(result.estimatedTokens).toBeLessThan(result.budgetTokens * 0.15);
  });

  it("puts every folded turn in exactly one of the summary input and the kept tail", async () => {
    const messages = busyThread();
    const prompts: string[] = [];
    const summarize = vi.fn(async (prompt: string) => {
      prompts.push(prompt);
      return "SUMMARY\nearlier requests handled";
    });
    const result = await prepareModelContext({
      messages,
      contextWindow: 1_600,
      taskRecordText: "Goal: ship",
      summarize,
    });

    expect(result.status).toBe("ready");
    if (result.status !== "ready") return;
    const ids = messages.map((item) => item.id);
    const covered = ids.indexOf(result.compaction?.coveredThroughId ?? "");
    const firstKept = ids.indexOf(result.compaction?.firstKeptId ?? "");
    expect(covered).toBeGreaterThanOrEqual(0);
    expect(firstKept).toBeGreaterThan(covered);
    const summarized = prompts.join("\n");
    const kept = result.transcript.slice(1).map((item) => item.text).join("\n");
    expect(summarized).not.toContain("auto-approved");
    expect(summarized).toContain("\nAssistant: [40 tool calls: Read 10, Edit 10, terminal_spawn 10, Bash 9, probe-00 1]");
    for (let turn = 0; turn < 24; turn++) {
      const probe = `probe-${String(turn).padStart(2, "0")} 1`;
      const request = `request ${turn}:`;
      const isKept = ids.indexOf(`u${turn}`) > covered;
      expect([summarized.includes(probe), kept.includes(probe)]).toEqual([!isKept, isKept]);
      expect([summarized.includes(request), kept.includes(request)]).toEqual([!isKept, isKept]);
    }
  });

  it("drops a legacy approval chip and folds a failed approval like any tool", async () => {
    const result = await prepareModelContext({
      messages: [
        message("m1", "clean the build"),
        chip("m2", "Bash"),
        chip("m3", "auto-approved Bash: rm -rf dist"),
        chip("m4", "Auto mode couldn't answer: git push", { ok: false }),
      ],
      contextWindow: 8_192,
      taskRecordText: "Goal: clean",
    });

    expect(result.status).toBe("ready");
    if (result.status !== "ready") return;
    expect(result.transcript.map((item) => item.text)).toEqual([
      "clean the build",
      "[2 tool calls: Bash 1, Auto mode couldn't answer: git push 1; failed: Auto mode couldn't answer: git push 1]",
    ]);
  });

  it("counts failures per tool when the same tool also succeeds", async () => {
    const result = await prepareModelContext({
      messages: [
        message("m1", "fix the build"),
        ...Array.from({ length: 5 }, (_, i) => chip(`m${i + 2}`, "Edit", { ok: i < 3 })),
      ],
      contextWindow: 8_192,
      taskRecordText: "Goal: fix",
    });

    expect(result.status).toBe("ready");
    if (result.status !== "ready") return;
    expect(result.transcript.map((item) => item.text)).toEqual([
      "fix the build",
      "[5 tool calls: Edit 5; failed: Edit 2]",
    ]);
  });

  it("keeps two bots' tool runs apart in a room", async () => {
    const scout = { botId: "scout", name: "Scout", color: "blue" };
    const pixel = { botId: "pixel", name: "Pixel", color: "pink" };
    const result = await prepareModelContext({
      messages: [
        message("m1", "split the work"),
        chip("m2", "Bash", {}, { from: scout }),
        chip("m3", "Bash", {}, { from: scout }),
        chip("m4", "Read", {}, { from: pixel }),
        chip("m5", "mcp__composio__search", {}, { from: pixel }),
        chip("m6", "Edit", {}, { from: scout }),
      ],
      contextWindow: 8_192,
      taskRecordText: "Room: Release",
      userName: "Eddie",
      includeSpeakers: true,
    });

    expect(result.status).toBe("ready");
    if (result.status !== "ready") return;
    expect(result.transcript.map((item) => item.text)).toEqual([
      "Eddie: split the work",
      "Scout: [2 tool calls: Bash 2]",
      "Pixel: [2 tool calls: Read 1, search 1]",
      "Scout: [1 tool call: Edit 1]",
    ]);
  });

  it("applies a compaction record that ends inside a tool run", async () => {
    const previous: ContextCompactionV1 = {
      v: 1,
      summary: "earlier work",
      coveredThroughId: "a2",
      firstKeptId: null,
      contextWindow: 200_000,
      estimatedTokensBefore: 900,
      sourceMessageCount: 5,
    };
    const result = await prepareModelContext({
      messages: [
        message("u1", "build it"),
        chip("t1", "Bash"),
        chip("a1", "auto-approved Bash: pnpm build"),
        chip("t2", "Read"),
        chip("a2", "auto-approved Read: package.json"),
        compactionMessage("c1", "a2", previous),
        chip("t3", "Edit"),
        chip("a3", "auto-approved Edit: src/app.ts", { approval: true }),
        chip("t4", "Bash"),
        message("u5", "ship it"),
        chip("t5", "Bash"),
      ],
      contextWindow: 200_000,
      taskRecordText: "Goal: ship",
    });

    expect(result).toMatchObject({ status: "ready", compacted: true, compactionId: "c1" });
    if (result.status !== "ready") return;
    expect(result.transcript.map((item) => item.text)).toEqual([
      expect.stringContaining("earlier work"),
      "[2 tool calls: Edit 1, Bash 1]",
      "ship it",
      "[1 tool call: Bash 1]",
    ]);
  });
});

describe("question cards in replay", () => {
  const card = (id: string, data: Partial<NonNullable<Message["card"]>>, extra: Partial<Message> = {}): Message =>
    message(id, "", { role: "bot", kind: "options", card: { title: "Your bot has a question", subtitle: "", options: [], ...data }, ...extra });
  const chip = (id: string, name: string): Message => message(id, "", { role: "bot", kind: "activity", tool: { name, ok: true } });
  const replay = async (messages: Message[], extra: Partial<Parameters<typeof prepareModelContext>[0]> = {}) => {
    const result = await prepareModelContext({ messages, contextWindow: 200_000, taskRecordText: "Goal: ship", ...extra });
    if (result.status !== "ready") throw new Error(result.status);
    return result.transcript.map((item) => item.text);
  };

  it("replays an unanswered question card as the question only", async () => {
    expect(await replay([
      message("m1", "ship it"),
      card("m2", { subtitle: "Which region?", options: ["us", "eu"], askUser: true }),
    ])).toEqual(["ship it", "[Question card] Which region? [choices: us | eu]"]);
  });

  it("replays a permission card with its verdict", async () => {
    expect(await replay([
      message("m1", "clean the build"),
      card("m2", { title: "Approval needed", subtitle: "rm -rf dist", options: ["Allow", "Deny"], requestId: "r1", tool: "Bash", answered: "deny", dismissed: false }),
    ])).toEqual(["clean the build", "[Approval card] rm -rf dist [choices: Allow | Deny] [answered: deny]"]);
  });

  it("attributes a room question to the member who asked", async () => {
    const scout = { botId: "scout", name: "Scout", color: "blue" };
    expect(await replay([
      message("m1", "plan the launch"),
      card("m2", { subtitle: "Monday or Friday?", options: ["Monday", "Friday"], askUser: true, answered: "Friday" }, { from: scout }),
      message("m3", "Friday"),
    ], { userName: "Eddie", includeSpeakers: true })).toEqual([
      "Eddie: plan the launch",
      "Scout: [Question card] Monday or Friday? [choices: Monday | Friday]",
      "Eddie: Friday",
    ]);
  });

  it("never folds tool chips across a question card", async () => {
    expect(await replay([
      message("m1", "deploy"),
      chip("m2", "Bash"),
      card("m3", { subtitle: "Proceed?", options: ["Yes", "No"], requestId: "r1", answered: "answer", answerText: "Yes" }),
      chip("m4", "Bash"),
    ])).toEqual([
      "deploy",
      "[1 tool call: Bash 1]",
      "[Question card] Proceed? [choices: Yes | No] [answered: Yes]",
      "[1 tool call: Bash 1]",
    ]);
  });

  it("puts question cards in the summarizer input", async () => {
    const summarize = vi.fn(async (_prompt: string) => "SUMMARY\nreleased to staging");
    const result = await prepareModelContext({
      messages: [
        message("m0", "prepare the release"),
        card("m1", { subtitle: "Staging or production?", options: ["Staging", "Production"], askUser: true, answered: "Staging" }),
        ...longHistory(205, 2),
      ],
      contextWindow: 2_048,
      taskRecordText: "Goal: release",
      summarize,
    });

    expect(result.status).toBe("ready");
    expect(summarize.mock.calls[0]?.[0]).toContain("\nAssistant: [Question card] Staging or production? [choices: Staging | Production]\n");
  });

  it("bounds a long question and many choices to one line", async () => {
    const [, line] = await replay([
      message("m1", "pick one"),
      card("m2", {
        subtitle: `Which of these?\n${"very long question ".repeat(200)}`,
        options: Array.from({ length: 20 }, (_, index) => `choice ${index} ${"x".repeat(100)}`),
        requestId: "r1",
        answered: "answer",
        answerText: `choice 3\n${"y".repeat(1_000)}`,
      }),
    ]);

    expect(line).not.toContain("\n");
    expect(line).toContain("+14 more]");
    expect(line!.length).toBeLessThan(800);
  });

  it("replays an answered first-run quiz and skips cards whose answer never reaches the bot", async () => {
    expect(await replay([
      card("m1", { title: "What do you mostly want help with?", subtitle: "Pick whatever's closest.", options: ["Life admin", "Writing"], answered: "Life admin", dismissed: true }),
      message("m2", "Life admin"),
      card("m3", { title: "What do you mostly want help with?", subtitle: "Pick whatever's closest.", options: ["Life admin"], dismissed: true }),
      // SAFETY: replay only checks that a routine payload is present, never its fields.
      card("m4", { title: "Create routine", subtitle: "Daily at 9", options: ["Confirm", "Cancel"], requestId: "r2", tool: "routine", answered: "allow", routineRequest: {} as never }),
    ])).toEqual([
      "[Question card] What do you mostly want help with? [choices: Life admin | Writing]",
      "Life admin",
    ]);
  });

  it("replays the question each card kind asks", async () => {
    expect(await replay([
      card("m1", { title: "What do you mostly want help with?", subtitle: "Pick whatever's closest.", options: ["Life admin"], answered: "Life admin" }),
      card("m2", { subtitle: "Which region?", options: ["us"], askUser: true }),
      card("m3", { subtitle: "Which environment?", options: ["Staging"], requestId: "r1" }),
      card("m4", { title: "Approval needed", subtitle: "rm -rf dist", options: ["Allow", "Deny"], requestId: "r2", tool: "Bash" }),
      card("m5", { title: "@Scout wants to contact @Atlas", subtitle: "check the logs", options: ["Allow", "Deny"], requestId: "r3", tool: "ask_bot" }),
    ])).toEqual([
      "[Question card] What do you mostly want help with? [choices: Life admin]",
      "[Question card] Which region? [choices: us]",
      "[Question card] Which environment? [choices: Staging]",
      "[Approval card] rm -rf dist [choices: Allow | Deny]",
      "[Approval card] @Scout wants to contact @Atlas: check the logs [choices: Allow | Deny]",
    ]);
  });

  it("replays an unavailable or dismissed card as closed", async () => {
    expect(await replay([
      card("m1", { subtitle: "Which environment?", options: ["Staging"], requestId: "r1", answered: "unavailable", dismissed: true }),
      card("m2", { title: "Approval needed", subtitle: "rm -rf dist", options: ["Allow", "Deny"], requestId: "r2", tool: "Bash", answered: "unavailable", dismissed: true }),
      card("m3", { subtitle: "Which region?", options: ["us"], askUser: true, dismissed: true }),
    ])).toEqual([
      "[Question card] Which environment? [choices: Staging] [closed, no answer]",
      "[Approval card] rm -rf dist [choices: Allow | Deny] [closed, no answer]",
      "[Question card] Which region? [choices: us] [closed, no answer]",
    ]);
  });

  it("keeps a question card beside its answer in the deterministic fallback", async () => {
    const result = await prepareModelContext({
      messages: [
        message("m0", "prepare the release"),
        card("m1", { subtitle: "Staging or production?", options: ["Staging", "Production"], askUser: true, answered: "Staging" }),
        message("m2", "Staging"),
        ...Array.from({ length: 300 }, (_, index) => [
          card(`q${index}`, { subtitle: `Check ${index}?`, options: ["Yes", "No"], askUser: true }),
          message(`u${index}`, "please inspect"),
          message(`a${index}`, "done", { role: "bot" }),
        ]).flat(),
      ],
      contextWindow: 16_384,
      taskRecordText: "Goal: release",
    });

    expect(result.status).toBe("ready");
    if (result.status !== "ready") return;
    expect(result.compaction!.summary).toContain("\nAssistant: [Question card] Staging or production? [choices: Staging | Production]\nStaging\n");
    expect(result.estimatedTokens).toBeLessThanOrEqual(result.budgetTokens);
  });
});

describe("routine cards in replay", () => {
  const at = new Date(2026, 9, 15, 12, 30).getTime();
  const routineCard = (id: string, data: Partial<RoutineRunCardData> = {}): Message =>
    message(id, "Routine card", {
      role: "bot",
      kind: "routine.run",
      routineRun: {
        runId: `run-${id}`,
        routineId: "routine-1",
        routineName: "Daily 20-min tool to try",
        status: "completed",
        runOn: "maus",
        scheduledFor: at,
        instruction: "Send Eddie one tool to try",
        ...data,
      },
    });
  const fired = "[Routine card] Daily 20-min tool to try fired 2026-10-15 12:30: Send Eddie one tool to try";
  const replay = async (messages: Message[], extra: Partial<Parameters<typeof prepareModelContext>[0]> = {}) => {
    const result = await prepareModelContext({ messages, contextWindow: 200_000, taskRecordText: "Goal: ship", ...extra });
    if (result.status !== "ready") throw new Error(result.status);
    return result.transcript;
  };

  it("replays a routine card as one bounded line", async () => {
    const secret = `sk-ant-api03-${"abcdefghijklmnopqrstuvwxyz0123456789"}`;
    const transcript = await replay([
      message("m1", "morning"),
      routineCard("m2"),
      message("m3", "Try Raycast today.", { role: "bot" }),
      routineCard("m4", { status: "missed" }),
      routineCard("m5", { runOn: "cloud", executionThreadId: "vm-thread", summary: "Built 3 pages.\nAll green." }),
      routineCard("m6", { status: "failed", startedAt: at, error: "provider crashed" }),
      routineCard("m7", { status: "queued" }),
      routineCard("m8", { status: "cancelled" }),
      routineCard("m9", { instruction: `Use ${secret}\n${"step ".repeat(500)}`, runOn: "cloud", summary: "y".repeat(5_000) }),
    ]);

    expect(transcript.slice(0, 6)).toEqual([
      { role: "user", text: "morning" },
      { role: "user", text: fired },
      { role: "assistant", text: "Try Raycast today." },
      { role: "user", text: "[Routine card] Daily 20-min tool to try missed 2026-10-15 12:30: Send Eddie one tool to try" },
      { role: "user", text: `${fired} [result: Built 3 pages. All green.]` },
      { role: "user", text: `${fired} [failed: provider crashed]` },
    ]);
    expect(transcript).toHaveLength(7);
    const long = transcript[6]!.text;
    expect(long).not.toContain("\n");
    expect(long).not.toContain(secret);
    expect(long.length).toBeLessThan(500);
  });

  it("drops a chat run that failed before it reached the bot", async () => {
    const transcript = await replay([
      message("m1", "morning"),
      routineCard("m2", { status: "failed", error: "provider instance is unavailable" }),
      routineCard("m3", { status: "failed", startedAt: at, error: "provider crashed" }),
    ]);

    expect(transcript).toEqual([
      { role: "user", text: "morning" },
      { role: "user", text: `${fired} [failed: provider crashed]` },
    ]);
  });

  it("keeps a routine card on both sides of a compaction", async () => {
    const previous: ContextCompactionV1 = {
      v: 1,
      summary: "Eddie tried Raycast after the noon routine.",
      coveredThroughId: "m2",
      firstKeptId: null,
      contextWindow: 200_000,
      estimatedTokensBefore: 20,
      sourceMessageCount: 2,
    };
    const evening = new Date(2026, 9, 15, 18, 0).getTime();
    const texts = (await replay([
      message("m1", "morning"),
      routineCard("m2"),
      compactionMessage("c1", "m2", previous),
      message("m3", "evening"),
      routineCard("m4", { scheduledFor: evening }),
    ])).map((item) => item.text);

    expect(texts[0]).toContain("Eddie tried Raycast after the noon routine.");
    expect(texts.slice(1)).toEqual([
      "evening",
      "[Routine card] Daily 20-min tool to try fired 2026-10-15 18:00: Send Eddie one tool to try",
    ]);
    expect(texts.join("\n")).not.toContain("12:30");

    const summarize = vi.fn(async (_prompt: string) => "SUMMARY\nEddie tried Raycast");
    const result = await prepareModelContext({
      messages: [message("m0", "start the routine"), routineCard("m1"), ...longHistory(205, 2)],
      contextWindow: 2_048,
      taskRecordText: "Goal: try tools",
      summarize,
    });
    expect(result.status).toBe("ready");
    expect(summarize.mock.calls[0]?.[0]).toContain(`\n${fired}\n`);
  });

  it("delivers a missed routine card on the next resumed turn", () => {
    const missed = "[Routine card] Daily 20-min tool to try missed 2026-10-15 12:30: Send Eddie one tool to try";
    const cloud = `${fired} [result: Done.]`;
    const path = [
      message("m1", "Start"),
      message("m2", "On it", { role: "bot" }),
      routineCard("m3", { status: "missed" }),
      routineCard("m4", { runOn: "cloud", summary: "Done." }),
      routineCard("m5", { runOn: "cloud", status: "running" }),
      message("m6", "Any news?"),
    ];

    expect(routineCardsSinceLastUserTurn(path, new Set(["m6"]))).toEqual([missed, cloud]);
    // a session bound at the missed card already replayed it
    expect(routineCardsSinceLastUserTurn(path, new Set(["m6"]), "m3")).toEqual([cloud]);
    // the next turn finds them behind a user turn
    expect(routineCardsSinceLastUserTurn([...path, message("m7", "Here", { role: "bot" }), message("m8", "Thanks")], new Set(["m8"]))).toEqual([]);

    // a fire turn carries earlier missed cards; later turns stop at its card
    const fire = [message("m1", "Start"), routineCard("m2", { status: "missed" }), routineCard("m3", { status: "running", startedAt: 3 })];
    expect(routineCardsSinceLastUserTurn(fire, new Set(["m3"]))).toEqual([missed]);
    expect(routineCardsSinceLastUserTurn([...fire, message("m4", "Try Raycast", { role: "bot" }), message("m5", "ok")], new Set(["m5"]))).toEqual([]);
  });

  it("delivers a cloud result that landed after a later user turn", () => {
    const path = [
      message("m1", "Start"),
      routineCard("m2", { runOn: "cloud", summary: "Early.", finishedAt: 2 }),
      routineCard("m3", { runOn: "cloud", summary: "Done.", finishedAt: 7 }),
      message("m4", "Held line"),
      message("m5", "Ok", { role: "bot" }),
      message("m8", "Any news?"),
    ];

    expect(routineCardsSinceLastUserTurn(path, new Set(["m8"]))).toEqual([`${fired} [result: Done.]`]);
  });

  it("walks past a chat card that failed before its turn started", () => {
    const missed = "[Routine card] Daily 20-min tool to try missed 2026-10-15 12:30: Send Eddie one tool to try";
    const path = (failed: Partial<RoutineRunCardData>) => [
      message("m1", "Start"),
      routineCard("m2", { status: "missed" }),
      routineCard("m3", { status: "failed", error: "provider unavailable", ...failed }),
      message("m4", "Any news?"),
    ];

    expect(routineCardsSinceLastUserTurn(path({}), new Set(["m4"]))).toEqual([missed]);
    // a turn that started and then failed still carried it
    expect(routineCardsSinceLastUserTurn(path({ startedAt: 3 }), new Set(["m4"]))).toEqual([]);
  });
});

describe("summary repair", () => {
  const NOTICE = "Model summary unavailable; full transcript retained by Wink.";
  const row = (patch: Partial<ContextCompactionV1>): ContextCompactionV1 => ({
    v: 1,
    summary: "good summary G",
    coveredThroughId: "m4",
    firstKeptId: "m5",
    contextWindow: 8_192,
    estimatedTokensBefore: 900,
    sourceMessageCount: 5,
    ...patch,
  });
  const good = compactionMessage("cg", "m9", row({}));
  const fallbackRow = row({
    summary: `${NOTICE}\n[Previous durable summary]\ngood summary G\n[User requests in this segment]\nfallback digest`,
    coveredThroughId: "m14",
    firstKeptId: "m15",
    sourceMessageCount: 15,
    previousCompactionId: "cg",
  });
  const fallback = compactionMessage("cf", "m19", fallbackRow);
  const fallbackPath = (): Message[] => [...longHistory(10), good, ...longHistory(10, 10), fallback, ...longHistory(4, 20)];

  it("detects a deterministic fallback as a repair target", () => {
    const found = repairTarget(fallbackPath());
    expect(found?.target.messageId).toBe("cf");
    expect(found?.fallback.messageId).toBe("cf");
    expect(found?.good?.messageId).toBe("cg");
    expect(isFallbackSummary(fallbackRow.summary)).toBe(true);
  });

  it("returns clean for a model-only chain without calling the summarizer", async () => {
    const path = [
      ...longHistory(10),
      good,
      ...longHistory(10, 10),
      compactionMessage("cm", "m19", row({ summary: "model summary M", coveredThroughId: "m14", firstKeptId: "m15", previousCompactionId: "cg" })),
      ...longHistory(4, 20),
    ];
    const generateText = vi.fn(async () => "SUMMARY\nnever");
    const { createSummaryRepair } = await import("./summary-repair.ts");
    const repair = createSummaryRepair({
      store: { activePath: () => path, messagesFor: () => path, appendCompaction: vi.fn() },
      instanceFor: async () => ({ driverKind: "claude", generateText }),
      busy: () => false,
      taskRecordText: () => "Goal: keep going",
      userName: () => "User",
    });

    expect(repairTarget(path)).toBeNull();
    repair.onSettled("bot", "thread");
    await repair.idle();
    expect(generateText).not.toHaveBeenCalled();
  });

  it("repairs a fallback from the previous model summary and the original messages, not the fallback text", async () => {
    const path = fallbackPath();
    const prompts: string[] = [];
    const result = await repairModelContext({
      messages: path,
      target: repairTarget(path)!,
      taskRecordText: "Goal: repair",
      summarize: async (prompt) => {
        prompts.push(prompt);
        return "SUMMARY\nrepaired summary text";
      },
    });

    expect(result.status).toBe("ready");
    expect(prompts).toHaveLength(1);
    expect(prompts[0]).toContain("<previous_summary>\ngood summary G\n</previous_summary>");
    expect(prompts[0]).toContain("work item 5:");
    expect(prompts[0]).toContain("work item 14:");
    expect(prompts[0]).not.toContain("work item 4:");
    expect(prompts[0]).not.toContain("work item 15:");
    expect(prompts[0]).not.toContain(NOTICE);
    expect(prompts[0]).not.toContain("fallback digest");
  });

  it("repairs with an oversized reply trimmed to fit", async () => {
    const path = fallbackPath();
    const records: SummaryCallRecord[] = [];
    const result = await repairModelContext({
      messages: path,
      target: repairTarget(path)!,
      taskRecordText: "Goal: repair",
      summarize: async () => `SUMMARY\n${Array.from({ length: 400 }, (_, index) => `repaired line ${index}`).join("\n")}`,
      onSummaryCall: (record) => records.push(record),
    });

    expect(result.status).toBe("ready");
    if (result.status !== "ready") return;
    expect(result.compaction.summary).toMatch(/^repaired line 0\n[\s\S]*\nrepaired line \d+\n\[summary trimmed to fit\]$/);
    expect(records.map((record) => record.result)).toEqual(["trimmed"]);
    expect(estimateContextTokens([{ text: result.compaction.summary }])).toBeLessThan(records[0]!.outBudget);
  });

  it("starts a fallback on a fallback from the last model summary, with one notice and no nesting", async () => {
    const warning = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const result = await prepareModelContext({
        messages: [...fallbackPath(), ...longHistory(100, 24)],
        contextWindow: 8_192,
        taskRecordText: "Goal: continue",
        summarize: async () => {
          throw new Error("Claude review timed out");
        },
      });

      expect(result.status).toBe("ready");
      if (result.status !== "ready") return;
      const summary = result.compaction!.summary;
      expect(isFallbackSummary(summary)).toBe(true);
      expect(summary.split(NOTICE)).toHaveLength(2);
      expect(summary.split("[Previous durable summary]")).toHaveLength(2);
      expect(summary).toContain("[Previous durable summary]\ngood summary G\n");
      expect(summary).not.toContain("fallback digest");
      expect(summary).toContain("work item 6:");
    } finally {
      warning.mockRestore();
    }
  });

  it("keeps the fallback's coverage ids and window in the repaired compaction", async () => {
    const path = fallbackPath();
    const result = await repairModelContext({
      messages: path,
      target: repairTarget(path)!,
      taskRecordText: "Goal: repair",
      summarize: async () => "SUMMARY\nrepaired summary text",
    });

    expect(result).toEqual({
      status: "ready",
      compaction: {
        v: 1,
        summary: "repaired summary text",
        coveredThroughId: "m14",
        firstKeptId: "m15",
        contextWindow: 8_192,
        estimatedTokensBefore: 900,
        sourceMessageCount: 15,
        previousCompactionId: "cg",
      },
    });
  });

  it("applies the repaired compaction over the fallback on the same path", async () => {
    const path = fallbackPath();
    const result = await repairModelContext({
      messages: path,
      target: repairTarget(path)!,
      taskRecordText: "Goal: repair",
      summarize: async () => "SUMMARY\nrepaired summary text",
    });
    if (result.status !== "ready") throw new Error(result.status);
    const repaired = [...path, compactionMessage("cr", "m23", result.compaction)];

    const prepared = await prepareModelContext({ messages: repaired, contextWindow: 8_192, taskRecordText: "Goal: repair" });
    expect(prepared.status === "ready" && prepared.compactionId).toBe("cr");
    const text = prepared.status === "ready" ? JSON.stringify(prepared.transcript) : "";
    expect(text).toContain("repaired summary text");
    expect(text).not.toContain(NOTICE);
    expect(text).toContain("work item 15:");
    expect(repairTarget(repaired)).toBeNull();
    expect([...supersededCompactionIds(repaired, "cr")]).toEqual(["cf"]);
  });

  it("repairs a later model summary that chained from a fallback", async () => {
    const path = [
      ...fallbackPath(),
      compactionMessage("cm", "m23", row({
        summary: `chained from the fallback: ${NOTICE}`,
        coveredThroughId: "m21",
        firstKeptId: "m22",
        sourceMessageCount: 22,
        previousCompactionId: "cf",
      })),
    ];
    const found = repairTarget(path);
    expect(found?.target.messageId).toBe("cm");
    expect(found?.fallback.messageId).toBe("cf");
    expect(found?.good?.messageId).toBe("cg");

    const prompts: string[] = [];
    const result = await repairModelContext({
      messages: path,
      target: found!,
      taskRecordText: "Goal: repair",
      summarize: async (prompt) => {
        prompts.push(prompt);
        return "SUMMARY\nrepaired summary text";
      },
    });
    expect(result.status === "ready" && result.compaction.coveredThroughId).toBe("m21");
    expect(prompts.join("\n")).toContain("work item 5:");
    expect(prompts.join("\n")).toContain("work item 21:");
    expect(prompts.join("\n")).not.toContain("chained from the fallback");
  });

  it("skips repair when the span needs more than four batches", async () => {
    const path = [
      ...longHistory(45),
      compactionMessage("cf", "m44", row({ summary: `${NOTICE}\ndigest`, coveredThroughId: "m40", firstKeptId: "m41", contextWindow: 1_024 })),
    ];
    const summarize = vi.fn(async () => "SUMMARY\nnever");

    const result = await repairModelContext({ messages: path, target: repairTarget(path)!, taskRecordText: "Goal", summarize, maxBatches: 4 });
    expect(result.status).toBe("too-large");
    expect(summarize).not.toHaveBeenCalled();
  });

  it("leaves the fallback in place when a repair call times out", async () => {
    const path = fallbackPath();
    const result = await repairModelContext({
      messages: path,
      target: repairTarget(path)!,
      taskRecordText: "Goal: repair",
      summarize: async () => {
        throw new Error("Claude review timed out");
      },
    });

    expect(result).toEqual({ status: "failed", result: "timeout" });
    expect(repairTarget(path)?.target.messageId).toBe("cf");
    expect(path.find((item) => item.id === "cf")).toBe(fallback);
  });

  it("ignores a fallback that is only on an abandoned branch", () => {
    const linked = (messages: Message[]): Message[] =>
      messages.map((item, index) => ({ ...item, parentId: index ? messages[index - 1]!.id : undefined }));
    const shared = linked([...longHistory(10), good, ...longHistory(10, 10)]);
    const abandoned = linked([shared.at(-1)!, fallback, ...longHistory(2, 20)]).slice(1);
    const active = linked([shared.at(-1)!, ...longHistory(2, 30)]).slice(1);
    const all = [...shared, ...abandoned, ...active];
    const pathTo = (leafId: string): Message[] => {
      const byId = new Map(all.map((item) => [item.id, item]));
      const path: Message[] = [];
      for (let current = byId.get(leafId); current; current = current.parentId ? byId.get(current.parentId) : undefined) path.unshift(current);
      return path;
    };

    expect(repairTarget(pathTo("m21"))?.target.messageId).toBe("cf");
    expect(repairTarget(pathTo("m31"))).toBeNull();
  });

  it("reads a long path a bounded number of times however many summaries it holds", () => {
    const items: Message[] = [];
    for (let block = 0; block < 40; block++) {
      const last = block * 100 + 99;
      items.push(...longHistory(100, block * 100), compactionMessage(`c${block}`, `m${last}`, row({
        summary: block === 0 ? `${NOTICE}\nfallback digest` : `model summary ${block}`,
        coveredThroughId: `m${last - 1}`,
        firstKeptId: `m${last}`,
        sourceMessageCount: last,
      })));
    }
    let reads = 0;
    const path = new Proxy(items, {
      get(target, key, receiver) {
        if (typeof key === "string" && /^\d+$/.test(key)) reads++;
        return Reflect.get(target, key, receiver);
      },
    });

    expect(supersededCompactionIds(path, "c39").size).toBe(0);
    expect(reads).toBeLessThan(4 * items.length);
    reads = 0;
    expect(repairTarget(path)).toMatchObject({ target: { messageId: "c39" }, fallback: { messageId: "c0" }, good: null });
    expect(reads).toBeLessThan(4 * items.length);
  });

  it("reports one call record per summarizer attempt with batch, attempt and result", async () => {
    const compactRecords: SummaryCallRecord[] = [];
    const replies = ["sure, happy to help", "SUMMARY\ncompact summary"];
    const prepared = await prepareModelContext({
      messages: longHistory(130),
      contextWindow: 128_000,
      taskRecordText: "Goal: telemetry",
      summarize: async () => replies.shift()!,
      onSummaryCall: (record) => compactRecords.push(record),
    });
    expect(prepared.status === "ready" && prepared.compaction?.summary).toBe("compact summary");
    expect(compactRecords).toMatchObject([
      { batch: 1, batches: 1, attempt: 1, result: "invalid" },
      { batch: 1, batches: 1, attempt: 2, result: "ok" },
    ]);
    expect(compactRecords[0]!.inTokens).toBeGreaterThan(0);
    expect(compactRecords[1]!.outTokens).toBeGreaterThan(0);

    const repairRecords: SummaryCallRecord[] = [];
    const path = fallbackPath();
    await repairModelContext({
      messages: path,
      target: repairTarget(path)!,
      taskRecordText: "Goal: repair",
      summarize: async () => {
        throw new Error("Claude review timed out");
      },
      onSummaryCall: (record) => repairRecords.push(record),
    });
    expect(repairRecords).toEqual([
      expect.objectContaining({ batch: 1, batches: 1, attempt: 1, outTokens: 0, outBudget: 1_433, result: "timeout" }),
    ]);
  });

  it("an older reader accepts the repaired row as plain v1", async () => {
    const repairedRow = row({ summary: "repaired summary text", coveredThroughId: "m14", firstKeptId: "m15", sourceMessageCount: 15, previousCompactionId: "cg" });
    const path = [...fallbackPath(), compactionMessage("cr", "m23", repairedRow)];

    expect(readContextCompaction({ value: repairedRow })).toEqual({ status: "valid", value: repairedRow });
    const prepared = await prepareModelContext({ messages: path, contextWindow: 8_192, taskRecordText: "Goal: repair" });
    expect(prepared.status === "ready" && prepared.compactionId).toBe("cr");
    expect(JSON.stringify(prepared.status === "ready" && prepared.transcript)).not.toContain(NOTICE);
    const chained = await prepareModelContext({
      messages: [...fallbackPath(), ...longHistory(130, 24)],
      contextWindow: 128_000,
      taskRecordText: "Goal",
      summarize: async () => "SUMMARY\nnormal",
    });
    expect(chained.status === "ready" && Object.keys(chained.compaction!).sort()).toEqual(Object.keys(repairedRow).sort());
  });
});

describe("planCompaction", () => {
  it("picks the boundary prepareModelContext picks", async () => {
    const first = await prepareModelContext({
      messages: longHistory(120),
      contextWindow: 1_024,
      taskRecordText: "Goal: finish",
      summarize: async () => "SUMMARY\nsummary one",
    });
    if (first.status !== "ready" || !first.compaction) throw new Error("expected a summary");
    const settled = [...longHistory(120), compactionMessage("c1", "m119", first.compaction), ...longHistory(90, 120)];
    const note = message("n1", "[pane 1] worker output", { kind: "note" });
    const input = { contextWindow: 1_024, excludeIds: new Set(["n1"]), reserveTokens: 40 };

    const plan = planCompaction({ ...input, messages: [...settled, note] });
    expect(plan.needed).toBe(true);
    if (!plan.needed) return;
    expect(plan.previous?.messageId).toBe("c1");
    expect(plan.old.length).toBeGreaterThan(0);
    expect(plan.tail[0]?.turn).toBe(true);
    expect(plan.coveredThrough.id).toBe(plan.old.at(-1)!.id);

    const prepared = await prepareModelContext({
      ...input,
      messages: [...settled, note, message("send", "next question")],
      excludeIds: new Set(["n1", "send"]),
      taskRecordText: "Goal: finish",
      summarize: async () => "SUMMARY\nsummary two",
    });
    if (prepared.status !== "ready" || !prepared.compaction) throw new Error("expected a summary");
    expect(prepared.compaction.coveredThroughId).toBe(plan.coveredThrough.id);
    expect(prepared.compaction.firstKeptId).toBe(plan.tail[0]?.id ?? null);
    expect(prepared.budgetTokens).toBe(plan.budgetTokens);
    expect(prepared.compaction.estimatedTokensBefore).toBe(plan.estimatedTokensBefore);

    const fits = planCompaction({ messages: longHistory(6), contextWindow: 200_000 });
    expect(fits.needed).toBe(false);
    if (fits.needed || fits.status !== "fits") throw new Error("expected a fitting plan");
    expect(fits.transcript).toHaveLength(6);
  });
});

describe("summary grace context", () => {
  const summaryGrace = {
    knownWindow: 200_000,
    requestText: "current request",
    fresh: false,
    rewound: false,
    recycle: false,
    local: false,
    native: {
      instanceId: "claude", cursor: "session",
      seed: { instanceId: "claude", cursor: "session", compactionId: null as string | null },
      prompt: { first: 25_000, last: 35_000, contextWindow: 200_000 },
    },
  };
  const history = () => Array.from({ length: 70 }, (_, index) => [
    message(`gu${index}`, `request ${index}`),
    message(`gb${index}`, `outcome ${index}`, { role: "bot" }),
  ]).flat();

  it("prepares the previous summary and full later tail without another summary or flush", async () => {
    const messages = history();
    const previous = compactionMessage("previous", "gb0", {
      v: 1, summary: "earlier accepted decisions", coveredThroughId: "gb0", firstKeptId: "gu1",
      contextWindow: 200_000, estimatedTokensBefore: 1_000, sourceMessageCount: 2,
    });
    messages.splice(4, 0, previous);
    messages.push(message("current", "current request"));
    const summarize = vi.fn(async () => "SUMMARY\nduplicate");
    const beforeSummarize = vi.fn();
    const result = await prepareModelContext({
      messages, contextWindow: 200_000, taskRecordText: "Goal: preserve context", excludeIds: new Set(["current"]),
      summaryGrace: { ...summaryGrace, native: { ...summaryGrace.native, seed: { ...summaryGrace.native.seed, compactionId: "previous" } } },
      summarize, beforeSummarize,
    });
    expect(summarize).not.toHaveBeenCalled();
    expect(beforeSummarize).not.toHaveBeenCalled();
    expect(result).toMatchObject({ status: "ready", compacted: true, compactionId: "previous" });
    if (result.status !== "ready") throw new Error(result.status);
    expect(result.compaction).toBeUndefined();
    expect(result.transcript[0]!.text).toContain("earlier accepted decisions");
    expect(result.transcript.slice(1)).toEqual(messages.filter((item) => item.kind === "text" && item.id !== "current").slice(2).map((item) => ({
      role: item.role === "bot" ? "assistant" : "user", text: item.text,
    })));
    expect(result.estimatedTokens).toBe(estimateContextTokens(result.transcript));
    expect(result.estimatedTokens).toBeLessThanOrEqual(result.budgetTokens);
  });

  it("keeps unknown, small, local, fresh, rewound, unseeded and recycle paths unchanged", async () => {
    const messages = history();
    const input = { messages, contextWindow: 200_000, taskRecordText: "Goal: preserve context" };
    const summarize = vi.fn(async () => "SUMMARY\nordinary summary");
    await prepareModelContext({ ...input, summaryGrace, summarize });
    expect(summarize).not.toHaveBeenCalled();
    for (const patch of [
      { knownWindow: null }, { knownWindow: 32_768 }, { local: true }, { fresh: true }, { rewound: true }, { recycle: true },
      { native: { ...summaryGrace.native, prompt: undefined } },
      { native: { ...summaryGrace.native, cursor: undefined } },
      { native: { ...summaryGrace.native, seed: undefined } },
      { native: { ...summaryGrace.native, seed: { ...summaryGrace.native.seed, cursor: "other" } } },
      { native: { ...summaryGrace.native, seed: { ...summaryGrace.native.seed, compactionId: "other" } } },
      { native: { ...summaryGrace.native, prompt: { first: 25_000, last: 195_000, contextWindow: 200_000 } } },
    ]) {
      summarize.mockClear();
      const result = await prepareModelContext({ ...input, summaryGrace: { ...summaryGrace, ...patch }, summarize });
      expect(summarize).toHaveBeenCalledOnce();
      expect(result.status === "ready" && result.compaction?.summary).toBe("ordinary summary");
    }
  });

  it("counts the current request, task record and reserved pane notes before granting headroom", async () => {
    const messages = history();
    const input = { messages, contextWindow: 200_000, taskRecordText: "Goal: preserve context", summaryGrace };
    const summarize = vi.fn(async () => "SUMMARY\nordinary summary");
    await prepareModelContext({ ...input, summarize });
    expect(summarize).not.toHaveBeenCalled();
    for (const patch of [
      { summaryGrace: { ...summaryGrace, requestText: "large paste ".repeat(50_000) } },
      { taskRecordText: "large task record ".repeat(30_000) },
      { reserveTokens: 120_000 },
    ]) {
      summarize.mockClear();
      await prepareModelContext({ ...input, ...patch, summarize });
      expect(summarize).toHaveBeenCalled();
    }
  });
});
