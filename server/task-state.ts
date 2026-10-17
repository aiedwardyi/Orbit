import { existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, statSync, unlinkSync } from "node:fs";
import { isAbsolute, join, relative, resolve } from "node:path";

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
  nextAction: z.string().max(LIMITS.nextAction),
  /** newest instruction, and the one the newest completion settled */
  instructionId: idSchema.optional(),
  settledInstructionId: idSchema.optional(),
  /** next action the newest instruction implied; a nextAction that differs was set on purpose */
  instructionAction: z.string().max(LIMITS.nextAction).optional(),
  /** instruction a bot-set nextAction belongs to; the action stays until the bot changes it */
  nextActionInstructionId: idSchema.optional(),
  /** goal the newest instruction seeded; absent once the bot claimed the goal */
  instructionGoal: z.string().max(LIMITS.goal).optional(),
  /** the single step the newest instruction seeded; absent once the bot claimed the plan */
  instructionStep: z.string().max(LIMITS.step).optional(),
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
type TaskArtifact = z.output<typeof artifactItemSchema>;

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
  const instructionId = packet.instructionId ? clean(packet.instructionId, LIMITS.id) : undefined;
  if (instructionId) normalized.instructionId = instructionId;
  const settledId = packet.settledInstructionId ? clean(packet.settledInstructionId, LIMITS.id) : undefined;
  if (settledId) normalized.settledInstructionId = settledId;
  const instructionAction = packet.instructionAction ? clean(packet.instructionAction, LIMITS.nextAction) : undefined;
  if (instructionAction) normalized.instructionAction = instructionAction;
  const nextActionInstructionId = packet.nextActionInstructionId ? clean(packet.nextActionInstructionId, LIMITS.id) : undefined;
  if (nextActionInstructionId) normalized.nextActionInstructionId = nextActionInstructionId;
  const instructionGoal = packet.instructionGoal ? clean(packet.instructionGoal, LIMITS.goal) : undefined;
  if (instructionGoal) normalized.instructionGoal = instructionGoal;
  const instructionStep = packet.instructionStep ? clean(packet.instructionStep, LIMITS.step) : undefined;
  if (instructionStep) normalized.instructionStep = instructionStep;
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

/** Over-limit text is clipped to fit instead of rejected, except artifact refs which drop whole; `clipped` collects what was cut. */
export function taskStateUpdateSchema(clipped: string[]) {
  const clip = (path: string, text: string, max: number): string => {
    if (text.length <= max) return text;
    clipped.push(`${path} (${text.length} > ${max})`);
    return clipText(text, max);
  };
  const plan = z.array(z.object({
    step: z.string().trim().min(1),
    status: z.enum(["pending", "active", "done", "skipped"]),
  }).strict()).max(20).transform((items) =>
    items.map((item, index) => ({ ...item, step: clip(`plan.${index}.step`, item.step, LIMITS.step) })),
  ).refine(
    (items) => items.filter((item) => item.status === "active").length <= 1,
    "at most one plan step may be active",
  );
  // Empty string clears. Whitespace-only is rejected before trim.
  const nextAction = z.string().refine(
    (value) => value === "" || /\S/.test(value),
  ).trim().transform((text) => clip("next_action", text, LIMITS.nextAction));
  const blockers = z.array(z.object({
    kind: z.enum(["login", "input", "engine"]),
    note: z.string().trim().min(1),
  }).strict()).max(10).transform((items) =>
    items.map((item, index) => ({ ...item, note: clip(`blockers.${index}.note`, item.note, LIMITS.note) })),
  );
  const artifacts = z.array(z.object({
    ref: z.string().trim().min(1),
    label: z.string().trim().min(1),
  }).strict()).max(20).transform((items) =>
    items.map((item, index) => {
      if (item.ref.length > LIMITS.ref) return item;
      return { ref: item.ref, label: clip(`artifacts.${index}.label`, item.label, LIMITS.label) };
    }),
  );
  return z.object({
    fromBotId: z.string().min(1).max(128),
    fromThreadId: z.string().min(1).max(128),
    goal: z.string().trim().min(1).transform((text) => clip("goal", text, LIMITS.goal)).optional(),
    plan: plan.optional(),
    completed_note: z.string().trim().min(1).transform((text) => clip("completed_note", text, LIMITS.completed)).optional(),
    pause_automatic_wakes: z.literal(true).optional(),
    next_action: nextAction.optional(),
    blockers: blockers.optional(),
    artifacts: artifacts.optional(),
  }).strict().refine(
    (body) => body.goal !== undefined || body.plan !== undefined || body.completed_note !== undefined ||
      body.next_action !== undefined || body.blockers !== undefined || body.artifacts !== undefined || body.pause_automatic_wakes === true,
    "at least one task field is required",
  );
}

/** Empty next_action clears the action. A real one is stamped to this instruction. */
export function assignTaskNextAction(packet: TaskResumePacket, nextAction: string): void {
  packet.nextAction = nextAction;
  if (nextAction === "") {
    delete packet.nextActionInstructionId;
    return;
  }
  if (packet.instructionId) packet.nextActionInstructionId = packet.instructionId;
  else delete packet.nextActionInstructionId;
}

const TASK_STATE_UPDATE_FIELDS = "goal, plan, completed_note, next_action, blockers, artifacts";

function valueAt(body: unknown, path: readonly PropertyKey[]): unknown {
  let current: unknown = body;
  for (const key of path) {
    if (typeof key === "number" && Array.isArray(current)) {
      current = current[key];
      continue;
    }
    if (typeof key === "string" && typeof current === "object" && current !== null && !Array.isArray(current)) {
      if (!Object.hasOwn(current, key)) return undefined;
      current = Reflect.get(current, key);
      continue;
    }
    return undefined;
  }
  return current;
}

export function taskStateUpdateError(error: z.ZodError, body?: unknown): string {
  const issue = error.issues[0];
  let detail = "unreadable body";
  if (issue?.code === "unrecognized_keys") detail = `unknown field ${issue.keys.join(", ")}`;
  else if (issue?.code === "too_big") {
    const sent = valueAt(body, issue.path);
    const count = typeof sent === "string" || Array.isArray(sent) ? sent.length : null;
    const unit = issue.origin === "array" ? "items" : "characters";
    const field = issue.path.length ? issue.path.map(String).join(".") : "value";
    detail = count === null ? `${field}: limit ${String(issue.maximum)}` : `${field}: ${count} ${unit}, limit ${String(issue.maximum)}`;
  } else if (issue) detail = issue.path.length ? `${issue.path.map(String).join(".")}: ${issue.message}` : issue.message;
  return `invalid task state update: ${detail.slice(0, 200)}; allowed: ${TASK_STATE_UPDATE_FIELDS}.`;
}

const CLIP_WORD_WINDOW = 40;

function pathSpanAt(text: string, index: number): { start: number; end: number } | null {
  const c = text[index];
  if (c === undefined) return null;
  let windows = false;
  let start: number | null = null;
  if (/[A-Za-z]/.test(c) && text[index + 1] === ":" && (text[index + 2] === "\\" || text[index + 2] === "/")) {
    start = index;
    windows = true;
  } else if (c === "\\" && text[index + 1] === "\\") {
    start = index;
    windows = true;
  } else if (c === "~" && text[index + 1] === "/") start = index;
  else if (c === "." && text[index + 1] === "/") start = index;
  else if (c === "." && text[index + 1] === "." && text[index + 2] === "/") start = index;
  else if ((c === "/" || c === "\\") && (index === 0 || /\s/.test(text[index - 1] ?? ""))) {
    start = index;
    windows = c === "\\";
  }
  if (start === null) return null;
  let end = start;
  while (end < text.length && !/\s/.test(text[end] ?? "")) end++;
  while (windows && end < text.length) {
    let next = end;
    let crossedLine = false;
    while (next < text.length && /\s/.test(text[next] ?? "")) {
      if (text[next] === "\n" || text[next] === "\r") { crossedLine = true; break; }
      next++;
    }
    if (crossedLine || next >= text.length) break;
    let tokenEnd = next;
    while (tokenEnd < text.length && !/\s/.test(text[tokenEnd] ?? "")) tokenEnd++;
    const token = text.slice(next, tokenEnd);
    if (!token.includes("/") && !token.includes("\\")) break;
    end = tokenEnd;
  }
  return { start, end };
}

function pathCutStart(text: string, cut: number): number | null {
  let index = 0;
  while (index < cut) {
    const span = pathSpanAt(text, index);
    if (!span) { index++; continue; }
    if (cut > span.start && cut < span.end) return span.start;
    index = span.end;
  }
  return null;
}

function clipText(text: string, max: number): string {
  let cut = text.slice(0, max - 1);
  const boundary = cut.search(/\s+\S*$/);
  if (boundary > 0 && cut.length - boundary <= CLIP_WORD_WINDOW) cut = cut.slice(0, boundary);
  else if (/[\uD800-\uDBFF]$/.test(cut)) cut = cut.slice(0, -1);
  const pathStart = pathCutStart(text, cut.length);
  if (pathStart !== null) return `${text.slice(0, pathStart).trimEnd()}…`;
  return `${cut.trimEnd()}…`;
}

function groundedTaskArtifact(cwd: string, ref: string): string | null {
  try {
    const root = realpathSync(cwd);
    const candidate = realpathSync(resolve(root, ref));
    const fromRoot = relative(root, candidate);
    if (fromRoot.startsWith("..") || isAbsolute(fromRoot) || !statSync(candidate).isFile()) return null;
    return candidate;
  } catch {
    return null;
  }
}

/** Keeps the artifacts that are files inside the task folder, resolved to their real path. */
export function groundTaskArtifacts(artifacts: TaskArtifact[], cwd: string) {
  const kept: TaskArtifact[] = [];
  const dropped: string[] = [];
  for (const artifact of artifacts) {
    if (artifact.ref.length > LIMITS.ref) { dropped.push(artifact.ref); continue; }
    const ref = groundedTaskArtifact(cwd, artifact.ref);
    if (ref) kept.push({ ref, label: artifact.label });
    else dropped.push(artifact.ref);
  }
  return { kept, dropped };
}

/** One line for the bot when an update saved with something clipped or dropped. Empty on a clean save. */
export function taskStateNotice(clipped: string[], dropped: string[], cwd: string): string {
  const parts: string[] = [];
  if (clipped.length) parts.push(`Clipped to fit: ${clipped.join(", ")}.`);
  if (dropped.length) parts.push(`Dropped artifacts that are not files inside ${cwd}: ${dropped.join(", ")}.`);
  return parts.join(" ");
}
