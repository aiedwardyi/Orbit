import { existsSync, lstatSync, mkdirSync, readFileSync, unlinkSync } from "node:fs";
import { join } from "node:path";

import { z } from "zod";

import { writeFileAtomic } from "./atomic.ts";
import { DATA_DIR } from "./config.ts";
import type { ThreadId } from "./contracts.ts";
import { redactSecretsInText } from "./redact.ts";

export const TASK_STATE_DIR = join(DATA_DIR, "task-state");
export const TASK_STATE_MAX_BYTES = 16_384;

const LIMITS = {
  id: 160,
  goal: 500,
  step: 200,
  completed: 300,
  ref: 500,
  note: 300,
  label: 200,
  nextAction: 300,
  plan: 20,
  completedItems: 30,
  evidence: 30,
  artifacts: 20,
  blockers: 10,
} as const;

const idSchema = z.string().min(1).max(LIMITS.id).regex(/^[A-Za-z0-9_-]+$/);
const planItemSchema = z.object({
  step: z.string().min(1).max(LIMITS.step),
  status: z.enum(["pending", "active", "done", "skipped"]),
}).strict();
const completedItemSchema = z.object({
  note: z.string().min(1).max(LIMITS.completed),
  at: z.number().int().nonnegative(),
}).strict();
const evidenceItemSchema = z.object({
  kind: z.enum(["message", "tool", "file", "url"]),
  ref: z.string().min(1).max(LIMITS.ref),
  note: z.string().min(1).max(LIMITS.note).optional(),
}).strict();
const artifactItemSchema = z.object({
  ref: z.string().min(1).max(LIMITS.ref),
  label: z.string().min(1).max(LIMITS.label),
}).strict();
const blockerItemSchema = z.object({
  kind: z.enum(["approval", "login", "input", "engine"]),
  note: z.string().min(1).max(LIMITS.note),
}).strict();

const taskResumePacketSchema = z.object({
  v: z.literal(1),
  threadId: idSchema,
  botId: idSchema,
  goal: z.string().min(1).max(LIMITS.goal),
  plan: z.array(planItemSchema).max(LIMITS.plan),
  completed: z.array(completedItemSchema).max(LIMITS.completedItems),
  evidence: z.array(evidenceItemSchema).max(LIMITS.evidence),
  artifacts: z.array(artifactItemSchema).max(LIMITS.artifacts),
  blockers: z.array(blockerItemSchema).max(LIMITS.blockers),
  nextAction: z.string().min(1).max(LIMITS.nextAction),
  updatedAt: z.number().int().nonnegative(),
  updatedBy: z.enum(["harness", "bot"]),
  flushReason: z.enum([
    "turn-end",
    "progress",
    "approval",
    "stop",
    "engine-switch",
    "crash",
    "pre-compaction",
    "shutdown",
  ]),
  lastEventId: idSchema.optional(),
  turnsAtWrite: z.number().int().nonnegative(),
}).strict();

export type TaskResumePacket = z.output<typeof taskResumePacketSchema>;

export interface TaskStateOptions {
  dir?: string;
}

function clean(value: string, max: number): string {
  return redactSecretsInText(value.trim()).slice(0, max);
}

function taskStatePath(threadId: ThreadId, dir: string): string {
  const checked = idSchema.safeParse(threadId);
  if (!checked.success) throw new Error("invalid task thread id");
  return join(dir, `${checked.data}.json`);
}

function normalize(packet: TaskResumePacket): TaskResumePacket {
  const normalized: TaskResumePacket = {
    v: 1,
    threadId: clean(packet.threadId, LIMITS.id),
    botId: clean(packet.botId, LIMITS.id),
    goal: clean(packet.goal, LIMITS.goal),
    plan: packet.plan.slice(-LIMITS.plan).flatMap((item) => {
      const step = clean(item.step, LIMITS.step);
      return step ? [{ step, status: item.status }] : [];
    }),
    completed: packet.completed.slice(-LIMITS.completedItems).flatMap((item) => {
      const note = clean(item.note, LIMITS.completed);
      return note ? [{ note, at: Math.max(0, Math.trunc(item.at)) }] : [];
    }),
    evidence: packet.evidence.slice(-LIMITS.evidence).flatMap((item) => {
      const ref = clean(item.ref, LIMITS.ref);
      const note = item.note ? clean(item.note, LIMITS.note) : undefined;
      if (!ref) return [];
      const entry: TaskResumePacket["evidence"][number] = { kind: item.kind, ref };
      if (note) entry.note = note;
      return [entry];
    }),
    artifacts: packet.artifacts.slice(-LIMITS.artifacts).flatMap((item) => {
      const ref = clean(item.ref, LIMITS.ref);
      const label = clean(item.label, LIMITS.label);
      return ref && label ? [{ ref, label }] : [];
    }),
    blockers: packet.blockers.slice(-LIMITS.blockers).flatMap((item) => {
      const note = clean(item.note, LIMITS.note);
      return note ? [{ kind: item.kind, note }] : [];
    }),
    nextAction: clean(packet.nextAction, LIMITS.nextAction),
    updatedAt: Math.max(0, Math.trunc(packet.updatedAt)),
    updatedBy: packet.updatedBy,
    flushReason: packet.flushReason,
    turnsAtWrite: Math.max(0, Math.trunc(packet.turnsAtWrite)),
  };
  const lastEventId = packet.lastEventId ? clean(packet.lastEventId, LIMITS.id) : undefined;
  if (lastEventId) normalized.lastEventId = lastEventId;
  return taskResumePacketSchema.parse(normalized);
}

function serializeBounded(packet: TaskResumePacket): string {
  const bounded = structuredClone(packet);
  const pruneOrder = ["completed", "evidence", "artifacts", "plan", "blockers"] as const;
  let serialized = JSON.stringify(bounded, null, 2);
  while (Buffer.byteLength(serialized, "utf8") > TASK_STATE_MAX_BYTES) {
    const removable = pruneOrder.filter((candidate) => bounded[candidate].length > 1);
    const candidates = removable.length
      ? removable
      : pruneOrder.filter((candidate) => bounded[candidate].length > 0);
    const key = candidates.sort(
      (left, right) =>
        Buffer.byteLength(JSON.stringify(bounded[right]), "utf8") -
        Buffer.byteLength(JSON.stringify(bounded[left]), "utf8"),
    )[0];
    if (!key) throw new Error("task state exceeds its storage limit");
    bounded[key].shift();
    serialized = JSON.stringify(bounded, null, 2);
  }
  return serialized;
}

export function writeTaskResumePacket(
  packet: TaskResumePacket,
  options: TaskStateOptions = {},
): TaskResumePacket {
  const normalized = normalize(packet);
  const dir = options.dir ?? TASK_STATE_DIR;
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const path = taskStatePath(normalized.threadId, dir);
  const serialized = serializeBounded(normalized);
  writeFileAtomic(path, serialized, { mode: 0o600 });
  return taskResumePacketSchema.parse(JSON.parse(serialized));
}

export function readTaskResumePacket(
  threadId: ThreadId,
  options: TaskStateOptions = {},
): TaskResumePacket | null {
  const path = taskStatePath(threadId, options.dir ?? TASK_STATE_DIR);
  try {
    const status = lstatSync(path);
    if (!status.isFile() || status.isSymbolicLink() || status.size > TASK_STATE_MAX_BYTES) return null;
    const raw = readFileSync(path, "utf8");
    if (Buffer.byteLength(raw, "utf8") > TASK_STATE_MAX_BYTES) return null;
    const parsed = taskResumePacketSchema.safeParse(JSON.parse(raw));
    return parsed.success && parsed.data.threadId === threadId ? parsed.data : null;
  } catch {
    return null;
  }
}

export function deleteTaskResumePacket(
  threadId: ThreadId,
  options: TaskStateOptions = {},
): boolean {
  const path = taskStatePath(threadId, options.dir ?? TASK_STATE_DIR);
  if (!existsSync(path)) return false;
  const status = lstatSync(path);
  if (!status.isFile() || status.isSymbolicLink()) return false;
  unlinkSync(path);
  return true;
}
