import { describe, expect, it } from "vitest";

import { isCompletedTaskRecord } from "../shared/task-resume.ts";

import {
  clearTaskBlockers,
  recordTaskBlocker,
  foldCompletedNextAction,
  recordTaskCompletion,
  recordTaskEvidence,
  recordTaskInstruction,
  seedTaskResumePacket,
  stampTaskResumePacket,
} from "./task-state-fold.ts";

const seed = () => seedTaskResumePacket({
  botId: "bot-1",
  threadId: "thread-1",
  text: "Prepare a weekly competitor brief\nInclude primary sources.",
  messageId: "message-1",
  now: 100,
  turnsAtWrite: 0,
});

describe("task state folding", () => {
  it("seeds a task from the first persisted user instruction", () => {
    expect(seed()).toMatchObject({
      goal: "Prepare a weekly competitor brief\nInclude primary sources.",
      plan: [{ step: "Prepare a weekly competitor brief", status: "active" }],
      nextAction: "Prepare a weekly competitor brief",
      evidence: [{ kind: "message", ref: "message-1" }],
      flushReason: "progress",
    });
  });

  it("records later instructions without replacing the durable goal", () => {
    const updated = recordTaskInstruction(seed(), {
      text: "Add a pricing comparison",
      messageId: "message-2",
      now: 200,
    });

    expect(updated.goal).toContain("weekly competitor brief");
    expect(updated.nextAction).toBe("Add a pricing comparison");
    expect(updated.evidence.at(-1)?.ref).toBe("message-2");
  });

  it("deduplicates evidence by kind and durable reference", () => {
    const once = recordTaskEvidence(seed(), {
      kind: "tool",
      ref: "tool-message-1",
      note: "read_file",
      now: 200,
      lastEventId: "event-1",
    });
    const twice = recordTaskEvidence(once, {
      kind: "tool",
      ref: "tool-message-1",
      note: "read_file",
      now: 300,
      lastEventId: "event-2",
    });

    expect(twice.evidence.filter((item) => item.ref === "tool-message-1")).toHaveLength(1);
    expect(twice.lastEventId).toBe("event-2");
  });

  it("adds and clears typed blockers", () => {
    const blocked = recordTaskBlocker(seed(), {
      kind: "approval",
      note: "Publish the reply",
      now: 200,
      lastEventId: "event-1",
    });
    const cleared = clearTaskBlockers(blocked, {
      kind: "approval",
      now: 300,
      lastEventId: "event-2",
    });

    expect(blocked.blockers).toEqual([{ kind: "approval", note: "Publish the reply" }]);
    expect(cleared.blockers).toEqual([]);
  });

  it("records settled replies and failed turns without claiming success", () => {
    const waiting = recordTaskBlocker(seed(), {
      kind: "approval",
      note: "Publish the report",
      now: 200,
    });
    const completed = recordTaskCompletion(waiting, {
      ok: true,
      reply: "Draft complete with five cited sources.",
      messageId: "message-3",
      now: 300,
      lastEventId: "event-3",
      turnsAtWrite: 1,
    });
    const failed = recordTaskCompletion(completed, {
      ok: false,
      reply: "",
      now: 400,
      lastEventId: "event-4",
      turnsAtWrite: 2,
    });

    expect(completed.completed.at(-1)?.note).toContain("Draft complete");
    expect(completed.evidence.at(-1)?.ref).toBe("message-3");
    expect(completed.blockers).toEqual([]);
    expect(completed.nextAction).toBe("");
    expect(failed.completed).toHaveLength(1);
    expect(failed.nextAction).toBe("");
    expect(failed.blockers).toContainEqual({ kind: "engine", note: expect.any(String) });

    const failedAlone = recordTaskCompletion(seed(), {
      ok: false,
      reply: "",
      now: 250,
    });
    expect(failedAlone.nextAction).toBe("Prepare a weekly competitor brief");
    expect(failedAlone.completed).toEqual([]);
  });

  it("settles an ok turn that replied with nothing", () => {
    const settled = recordTaskCompletion(seed(), { ok: true, reply: "   ", now: 300 });

    expect(settled.nextAction).toBe("");
    expect(settled.completed).toHaveLength(1);
    expect(isCompletedTaskRecord(settled)).toBe(true);
  });

  it("clears nextAction when a turn completes so reopen cannot redo finished work", () => {
    const donePlan = {
      ...seed(),
      plan: [
        { step: "Research launches", status: "done" as const },
        { step: "Write the report", status: "done" as const },
        { step: "Verify citations", status: "done" as const },
        { step: "Publish the brief", status: "done" as const },
      ],
      nextAction: "Prepare a weekly competitor brief",
    };
    const completed = recordTaskCompletion(donePlan, {
      ok: true,
      reply: "Published the brief with four cited sources.",
      now: 400,
      turnsAtWrite: 4,
    });

    expect(completed.flushReason).toBe("turn-end");
    expect(completed.nextAction).toBe("");
    expect(completed.completed).toHaveLength(1);
  });

  it("does not keep completed work as nextAction after a successful turn", () => {
    const withDoneStep = {
      ...seed(),
      plan: [
        { step: "Prepare a weekly competitor brief", status: "done" as const },
        { step: "Add a pricing comparison", status: "pending" as const },
      ],
      nextAction: "Prepare a weekly competitor brief",
    };
    const advanced = recordTaskCompletion(withDoneStep, {
      ok: true,
      reply: "Draft complete with five cited sources.",
      now: 300,
    });
    // Successful settle clears nextAction (quiet strip); fold runs after and is a no-op.
    expect(advanced.nextAction).toBe("");
    expect(advanced.completed.at(-1)?.note).toBe("Draft complete with five cited sources.");

    const echoed = recordTaskCompletion(seed(), {
      ok: true,
      reply: "Prepare a weekly competitor brief",
      now: 300,
    });
    expect(echoed.nextAction).toBe("");
    expect(echoed.completed.at(-1)?.note).toBe("Prepare a weekly competitor brief");
  });

  it("foldCompletedNextAction skips plan steps already finished", () => {
    const packet = {
      ...seed(),
      plan: [
        { step: "A", status: "done" as const },
        { step: "B", status: "pending" as const },
        { step: "C", status: "pending" as const },
      ],
      completed: [{ note: "B", at: 100 }],
      nextAction: "A",
    };
    const folded = foldCompletedNextAction(packet);
    expect(folded.nextAction).toBe("C");
  });

  it("stamps engine switches and stops without changing task content", () => {
    const packet = seed();
    const switched = stampTaskResumePacket(packet, "engine-switch", { now: 200 });
    const stopped = stampTaskResumePacket(switched, "stop", { now: 300 });
    const lateEvidence = recordTaskEvidence(stopped, {
      kind: "tool",
      ref: "tool-message-2",
      now: 350,
    });
    const lateBlocker = recordTaskBlocker(lateEvidence, {
      kind: "approval",
      note: "Late approval",
      now: 360,
    });
    const cleared = clearTaskBlockers(lateBlocker, { kind: "approval", now: 370 });
    const settled = recordTaskCompletion(cleared, { ok: false, reply: "", now: 400 });

    expect(switched).toMatchObject({ goal: packet.goal, flushReason: "engine-switch", updatedAt: 200 });
    expect(stopped).toMatchObject({ goal: packet.goal, flushReason: "stop", updatedAt: 300 });
    expect(lateEvidence.flushReason).toBe("stop");
    expect(lateBlocker.flushReason).toBe("stop");
    expect(cleared.flushReason).toBe("stop");
    expect(settled).toMatchObject({ flushReason: "stop", blockers: [] });
  });

  it("keeps a user-stop recovery reason when the adapter settles the stopped turn as ok", () => {
    const stopped = stampTaskResumePacket(seed(), "stop", { now: 300 });
    const settled = recordTaskCompletion(stopped, {
      ok: true,
      reply: "partial draft before stop",
      now: 400,
      interrupted: true,
    });

    expect(settled.flushReason).toBe("stop");
    expect(settled.completed).toEqual([]);
    expect(settled.nextAction).toBe("Prepare a weekly competitor brief");
    expect(settled.blockers).toEqual([]);
  });
});
