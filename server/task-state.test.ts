import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";

import { isCompletedTaskRecord } from "../shared/task-resume.ts";
import {
  assignTaskNextAction,
  deleteTaskResumePacket,
  readTaskResumePacket,
  TASK_STATE_MAX_BYTES,
  taskArtifactError,
  taskStateUpdateEnvelopeSchema,
  taskStateUpdateError,
  writeTaskResumePacket,
  type TaskResumePacket,
} from "./task-state.ts";
import { recordTaskCompletion, seedTaskResumePacket } from "./task-state-fold.ts";

const packet = (overrides: Partial<TaskResumePacket> = {}): TaskResumePacket => ({
  v: 1,
  threadId: "thread-1",
  botId: "bot-1",
  goal: "Prepare the weekly competitor brief",
  plan: [
    { step: "Research launches", status: "done" },
    { step: "Write the report", status: "active" },
  ],
  completed: [{ note: "Collected primary sources", at: 100 }],
  evidence: [{ kind: "url", ref: "https://example.com/source", note: "Launch notes" }],
  artifacts: [{ ref: "reports/weekly.md", label: "Draft report" }],
  blockers: [],
  nextAction: "Finish the comparison table",
  updatedAt: 200,
  updatedBy: "harness",
  flushReason: "turn-end",
  lastEventId: "event-1",
  turnsAtWrite: 3,
  ...overrides,
});

describe("task resume packets", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "orbit-task-state-"));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("writes and reads one packet per task", () => {
    const saved = writeTaskResumePacket(
      packet({ instructionAction: "Write the report", nextActionInstructionId: "message-1" }),
      { dir },
    );
    expect(saved.instructionAction).toBe("Write the report");
    expect(saved.nextActionInstructionId).toBe("message-1");

    expect(readTaskResumePacket("thread-1", { dir })).toEqual(saved);
    expect(JSON.parse(readFileSync(join(dir, "thread-1.json"), "utf8"))).toEqual(saved);
  });

  it("redacts secrets before they reach disk", () => {
    writeTaskResumePacket(packet({
      goal: "Use token=abcdefgh12345678 to prepare the brief",
      evidence: [{ kind: "tool", ref: "event-1", note: "Bearer abcdefghijklmnop" }],
    }), { dir });

    const raw = readFileSync(join(dir, "thread-1.json"), "utf8");
    expect(raw).not.toContain("abcdefgh12345678");
    expect(raw).not.toContain("abcdefghijklmnop");
    expect(raw).toContain("redacted");
  });

  it("keeps the newest bounded entries and never writes more than 16 KiB", () => {
    const completed = Array.from({ length: 80 }, (_, index) => ({
      note: `${index}:${"x".repeat(400)}`,
      at: index,
    }));
    const evidence = Array.from({ length: 80 }, (_, index) => ({
      kind: "tool" as const,
      ref: `event-${index}-${"y".repeat(600)}`,
      note: `${index}:${"z".repeat(400)}`,
    }));

    const saved = writeTaskResumePacket(packet({ completed, evidence }), { dir });
    const size = statSync(join(dir, "thread-1.json")).size;

    expect(size).toBeLessThanOrEqual(TASK_STATE_MAX_BYTES);
    expect(saved.completed.at(-1)?.at).toBe(79);
    expect(saved.evidence.at(-1)?.ref).toContain("event-79-");
    expect(saved.completed.length).toBeLessThanOrEqual(30);
    expect(saved.evidence.length).toBeLessThanOrEqual(30);
  });

  it("keeps bot milestones across more than 30 settled turns", () => {
    let current = seedTaskResumePacket({
      botId: "bot-1",
      threadId: "thread-1",
      text: "Prepare the report",
      messageId: "message-1",
      now: 100,
      turnsAtWrite: 0,
    });
    for (let index = 0; index < 35; index++) {
      current.completed.push({ note: `Milestone ${index}`, at: index });
      current = recordTaskCompletion(current, {
        ok: true,
        reply: `Long reply ${index}: ${"details ".repeat(100)}`,
        now: 200 + index,
      });
    }

    const saved = writeTaskResumePacket(current, { dir });
    expect(saved.completed).toHaveLength(30);
    expect(saved.completed[0]?.note).toBe("Milestone 5");
    expect(saved.completed.at(-1)?.note).toBe("Milestone 34");
  });

  it("replaces an old packet without leaving temporary files", () => {
    writeTaskResumePacket(packet(), { dir });
    writeTaskResumePacket(packet({ nextAction: "Publish after approval" }), { dir });

    expect(readTaskResumePacket("thread-1", { dir })?.nextAction).toBe("Publish after approval");
    writeTaskResumePacket(packet({ nextAction: "" }), { dir });
    expect(readTaskResumePacket("thread-1", { dir })?.nextAction).toBe("");
    expect(existsSync(join(dir, "thread-1.json"))).toBe(true);
    expect(readFileSync(join(dir, "thread-1.json"), "utf8")).not.toContain("Finish the comparison table");
  });

  it("treats unknown versions and malformed files as absent without deleting them", () => {
    const path = join(dir, "thread-1.json");
    writeFileSync(path, JSON.stringify({ v: 2, threadId: "thread-1" }));
    const unknown = readFileSync(path, "utf8");

    expect(readTaskResumePacket("thread-1", { dir })).toBeNull();
    expect(readFileSync(path, "utf8")).toBe(unknown);

    writeFileSync(path, "not json");
    expect(readTaskResumePacket("thread-1", { dir })).toBeNull();
    expect(readFileSync(path, "utf8")).toBe("not json");
  });

  it("ignores oversized and symbolic-link records", () => {
    const path = join(dir, "thread-1.json");
    writeFileSync(path, "x".repeat(TASK_STATE_MAX_BYTES + 1));
    expect(readTaskResumePacket("thread-1", { dir })).toBeNull();

    if (process.platform !== "win32") {
      const target = join(dir, "target.json");
      writeFileSync(target, JSON.stringify(packet()));
      rmSync(path);
      symlinkSync(target, path);
      expect(readTaskResumePacket("thread-1", { dir })).toBeNull();
    }
  });

  it("deletes only a valid task sidecar", () => {
    writeTaskResumePacket(packet(), { dir });

    expect(deleteTaskResumePacket("thread-1", { dir })).toBe(true);
    expect(deleteTaskResumePacket("thread-1", { dir })).toBe(false);
    expect(() => deleteTaskResumePacket("../outside", { dir })).toThrow("invalid task thread id");
  });

  it.skipIf(process.platform === "win32")("writes private file permissions", () => {
    mkdirSync(dir, { recursive: true });
    const path = join(dir, "thread-1.json");
    writeFileSync(path, "old");
    chmodSync(path, 0o644);

    writeTaskResumePacket(packet(), { dir });

    expect(statSync(path).mode & 0o777).toBe(0o600);
  });
});

describe("task state update", () => {
  it("clears a next action when the update sends an empty string", () => {
    const empty = taskStateUpdateEnvelopeSchema.safeParse({
      fromBotId: "bot-1",
      fromThreadId: "thread-1",
      next_action: "",
    });
    expect(empty.success).toBe(true);
    if (!empty.success) return;
    const settled = packet({
      instructionId: "message-2",
      settledInstructionId: "message-2",
      nextAction: "Run the full export",
      nextActionInstructionId: "message-1",
      flushReason: "turn-end",
    });
    assignTaskNextAction(settled, empty.data.next_action ?? "");
    expect(settled.nextAction).toBe("");
    expect(settled.nextActionInstructionId).toBeUndefined();
    expect(isCompletedTaskRecord(settled)).toBe(true);

    const spaces = taskStateUpdateEnvelopeSchema.safeParse({
      fromBotId: "bot-1",
      fromThreadId: "thread-1",
      next_action: "   ",
    });
    expect(spaces.success).toBe(false);

    const padded = taskStateUpdateEnvelopeSchema.safeParse({
      fromBotId: "bot-1",
      fromThreadId: "thread-1",
      next_action: "  Verify citations  ",
    });
    expect(padded.success).toBe(true);
    if (padded.success) expect(padded.data.next_action).toBe("Verify citations");
  });
});

describe("taskStateUpdateError", () => {
  const schema = z.object({
    goal: z.string().optional(),
    plan: z.array(z.object({ step: z.string().min(1) }).strict()).optional(),
  }).strict();
  const error = (body: unknown) => {
    const parsed = schema.safeParse(body);
    if (parsed.success) throw new Error("expected a parse failure");
    return taskStateUpdateError(parsed.error);
  };

  it("names an unknown field and the allowed ones", () => {
    const text = error({ goal: "ship", notes: "x" });
    expect(text).toContain("unknown field notes");
    expect(text).toContain("allowed: goal, plan, completed_note, next_action, blockers, artifacts");
  });

  it("names the failing path", () => {
    expect(error({ plan: "step one" })).toMatch(/: plan: /);
    expect(error({ plan: [{ step: "" }] })).toMatch(/: plan\.0\.step: /);
  });

  it("bounds the detail length", () => {
    const text = error({ ["x".repeat(1000)]: 1 });
    expect(text.length).toBeLessThan(400);
  });

  it("names the field, its limit and the length sent", () => {
    const schema = z.object({
      goal: z.string().max(500).optional(),
      plan: z.array(z.object({ step: z.string().max(200) }).strict()).max(20).optional(),
    }).strict();
    const fail = (body: unknown) => {
      const parsed = schema.safeParse(body);
      if (parsed.success) throw new Error("expected a parse failure");
      return taskStateUpdateError(parsed.error, body);
    };
    const goal = "x".repeat(501);
    expect(fail({ goal })).toContain("goal: 501 characters, limit 500");
    const plan = Array.from({ length: 21 }, () => ({ step: "a" }));
    expect(fail({ plan })).toContain("plan: 21 items, limit 20");
    expect(fail({ plan: [{ step: "y".repeat(201) }] })).toContain("plan.0.step: 201 characters, limit 200");
  });

  it("does not count an inherited constructor or toString", () => {
    const schema = z.object({ goal: z.string().max(5) }).strict();
    const parsed = schema.safeParse({ goal: "123456" });
    if (parsed.success) throw new Error("expected a parse failure");
    const at = (key: string, body: object) => {
      const issue = parsed.error.issues[0];
      if (!issue) throw new Error("expected an issue");
      return taskStateUpdateError(new z.ZodError([{ ...issue, path: [key] }]), body);
    };
    const inherited: object = Object.create({ constructor: "c".repeat(40), toString: "t".repeat(30) });
    expect(at("constructor", inherited)).toContain("constructor: limit 5");
    expect(at("constructor", inherited)).not.toContain("40");
    expect(at("toString", inherited)).toContain("toString: limit 5");
    expect(at("toString", inherited)).not.toContain("30");
    expect(at("constructor", { constructor: "c".repeat(40) })).toContain("constructor: 40 characters, limit 5");
  });
});

describe("taskArtifactError", () => {
  it("names the rejected refs and the working folder", () => {
    const text = taskArtifactError(["../out.md", "/tmp/b.png"], "/work/demo");
    expect(text).toContain("working folder /work/demo");
    expect(text).toContain("rejected: ../out.md, /tmp/b.png");
  });
});
