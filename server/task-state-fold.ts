import type { TaskResumePacket } from "./task-state.ts";

interface StampInput {
  now: number;
  lastEventId?: string;
  turnsAtWrite?: number;
}

function firstLine(text: string): string {
  return text.trim().split("\n")[0]!.trim();
}

function recoveryReason(packet: TaskResumePacket): TaskResumePacket["flushReason"] | null {
  return ["crash", "stop", "shutdown"].includes(packet.flushReason) ? packet.flushReason : null;
}

function stamped(
  packet: TaskResumePacket,
  reason: TaskResumePacket["flushReason"],
  input: StampInput,
): TaskResumePacket {
  const next = structuredClone(packet);
  next.updatedAt = input.now;
  next.updatedBy = "harness";
  next.flushReason = reason;
  if (input.lastEventId) next.lastEventId = input.lastEventId;
  if (input.turnsAtWrite !== undefined) next.turnsAtWrite = input.turnsAtWrite;
  return next;
}

export function seedTaskResumePacket(input: {
  botId: string;
  threadId: string;
  text: string;
  messageId: string;
  now: number;
  turnsAtWrite: number;
}): TaskResumePacket {
  const goal = input.text.trim();
  const nextAction = firstLine(goal);
  return {
    v: 1,
    threadId: input.threadId,
    botId: input.botId,
    goal,
    plan: [{ step: nextAction, status: "active" }],
    completed: [],
    evidence: [{ kind: "message", ref: input.messageId, note: "Task instruction" }],
    artifacts: [],
    blockers: [],
    nextAction,
    updatedAt: input.now,
    updatedBy: "harness",
    flushReason: "progress",
    turnsAtWrite: input.turnsAtWrite,
  };
}

export function recordTaskInstruction(
  packet: TaskResumePacket,
  input: { text: string; messageId: string } & StampInput,
): TaskResumePacket {
  const next = stamped(packet, "progress", input);
  const action = firstLine(input.text);
  if (action) next.nextAction = action;
  if (!next.plan.length && action) next.plan = [{ step: action, status: "active" }];
  if (!next.evidence.some((item) => item.kind === "message" && item.ref === input.messageId)) {
    next.evidence.push({ kind: "message", ref: input.messageId, note: "Task instruction" });
  }
  return next;
}

export function recordTaskEvidence(
  packet: TaskResumePacket,
  input: {
    kind: TaskResumePacket["evidence"][number]["kind"];
    ref: string;
    note?: string;
  } & StampInput,
): TaskResumePacket {
  const next = stamped(packet, recoveryReason(packet) ?? "progress", input);
  if (!next.evidence.some((item) => item.kind === input.kind && item.ref === input.ref)) {
    const evidence: TaskResumePacket["evidence"][number] = { kind: input.kind, ref: input.ref };
    if (input.note?.trim()) evidence.note = input.note.trim();
    next.evidence.push(evidence);
  }
  return next;
}

export function recordTaskBlocker(
  packet: TaskResumePacket,
  input: {
    kind: TaskResumePacket["blockers"][number]["kind"];
    note: string;
  } & StampInput,
): TaskResumePacket {
  const next = stamped(packet, recoveryReason(packet) ?? "approval", input);
  const note = input.note.trim();
  if (note && !next.blockers.some((item) => item.kind === input.kind && item.note === note)) {
    next.blockers.push({ kind: input.kind, note });
  }
  return next;
}

export function clearTaskBlockers(
  packet: TaskResumePacket,
  input: { kind: TaskResumePacket["blockers"][number]["kind"] } & StampInput,
): TaskResumePacket {
  const next = stamped(packet, recoveryReason(packet) ?? "approval", input);
  next.blockers = next.blockers.filter((item) => item.kind !== input.kind);
  return next;
}

export function recordTaskCompletion(
  packet: TaskResumePacket,
  input: {
    ok: boolean;
    reply: string;
    messageId?: string;
  } & StampInput,
): TaskResumePacket {
  const interrupted = !input.ok ? recoveryReason(packet) : null;
  const next = stamped(packet, interrupted ?? "turn-end", input);
  const reply = input.reply.trim();
  if (input.ok && reply) next.completed.push({ note: reply, at: input.now });
  if (input.messageId && !next.evidence.some((item) => item.ref === input.messageId)) {
    next.evidence.push({ kind: "message", ref: input.messageId, note: "Settled reply" });
  }
  next.blockers = next.blockers.filter(
    (item) => item.kind !== "approval" && item.kind !== "input" && item.kind !== "engine",
  );
  if (!input.ok && !interrupted) {
    next.blockers.push({ kind: "engine", note: "The last turn ended before completing." });
  }
  return next;
}

export function stampTaskResumePacket(
  packet: TaskResumePacket,
  reason: TaskResumePacket["flushReason"],
  input: StampInput,
): TaskResumePacket {
  return stamped(packet, reason, input);
}
