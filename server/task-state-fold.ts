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
    /** User Stop (or an equivalent interrupt) — keep crash/stop/shutdown even
     * when the adapter reports the torn-down turn as ok. A later Resume turn
     * must omit this so a real completion can settle as turn-end. */
    interrupted?: boolean;
  } & StampInput,
): TaskResumePacket {
  const recovery = recoveryReason(packet);
  const keepRecovery = input.interrupted ? recovery ?? "stop" : !input.ok ? recovery : null;
  const next = stamped(packet, keepRecovery ?? "turn-end", input);
  const reply = input.reply.trim();
  if (input.ok && !input.interrupted) {
    // An empty reply still settles the task. With no completed entry the
    // record never reads finished, so the strip keeps offering Resume.
    next.completed.push({ note: reply || "Settled without a reply.", at: input.now });
    next.nextAction = "";
  }
  if (input.messageId && !next.evidence.some((item) => item.ref === input.messageId)) {
    next.evidence.push({ kind: "message", ref: input.messageId, note: "Settled reply" });
  }
  next.blockers = next.blockers.filter(
    (item) => item.kind !== "approval" && item.kind !== "input" && item.kind !== "engine",
  );
  if (!input.ok && !keepRecovery) {
    next.blockers.push({ kind: "engine", note: "The last turn ended before completing." });
  }
  if (input.ok && !input.interrupted) foldCompletedNextAction(next);
  return next;
}

/** After verified completion, do not leave that same work as the next action. */
export function foldCompletedNextAction(packet: TaskResumePacket): TaskResumePacket {
  const action = firstLine(packet.nextAction);
  const done = packet.plan.filter((item) => item.status === "done").map((item) => firstLine(item.step));
  const completed = packet.completed.map((item) => firstLine(item.note));
  if (!action || (!done.includes(action) && !completed.includes(action))) return packet;
  const finished = new Set([...done, ...completed]);
  const pending = packet.plan.find(
    (item) => item.status === "pending" && !finished.has(firstLine(item.step)),
  );
  const active = packet.plan.find(
    (item) =>
      item.status === "active" &&
      firstLine(item.step) !== action &&
      !finished.has(firstLine(item.step)),
  );
  packet.nextAction = firstLine(pending?.step ?? active?.step ?? "Continue from the conversation");
  return packet;
}

export function stampTaskResumePacket(
  packet: TaskResumePacket,
  reason: TaskResumePacket["flushReason"],
  input: StampInput,
): TaskResumePacket {
  return stamped(packet, reason, input);
}
