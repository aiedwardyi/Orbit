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

import {
  deleteTaskResumePacket,
  readTaskResumePacket,
  TASK_STATE_MAX_BYTES,
  writeTaskResumePacket,
  type TaskResumePacket,
} from "./task-state.ts";

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
    const saved = writeTaskResumePacket(packet(), { dir });

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

  it("replaces an old packet without leaving temporary files", () => {
    writeTaskResumePacket(packet(), { dir });
    writeTaskResumePacket(packet({ nextAction: "Publish after approval" }), { dir });

    expect(readTaskResumePacket("thread-1", { dir })?.nextAction).toBe("Publish after approval");
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
