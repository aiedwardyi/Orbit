import { describe, expect, it } from "vitest";

import {
  activeRunForRoutine,
  canDeleteWhileWorking,
  canSwitchWhileWorking,
  liveCalendarSelection,
  routineWorkingElsewhere,
  runNowClick,
  workingThreadId,
} from "../../shared/working-thread";

const queued = {
  id: "run-q",
  routineId: "routine-1",
  routineName: "Morning brief",
  botId: "bot-1",
  status: "queued" as const,
  scheduledFor: 100,
};

const running = {
  ...queued,
  id: "run-r",
  status: "running" as const,
  threadId: "exec-thread",
};

describe("runNowClick", () => {
  it("ignores a second click while the same routine is already in flight", () => {
    expect(runNowClick({ inFlightRoutineId: "routine-1", routineId: "routine-1" })).toBe("ignore");
  });

  it("focuses an already queued or running run instead of starting another", () => {
    expect(runNowClick({ inFlightRoutineId: null, routineId: "routine-1", activeRun: queued })).toBe("focus-active");
    expect(runNowClick({ inFlightRoutineId: null, routineId: "routine-1", activeRun: running })).toBe("focus-active");
  });

  it("starts only when nothing is queued, running, or waiting", () => {
    expect(runNowClick({ inFlightRoutineId: null, routineId: "routine-1" })).toBe("start");
  });
});

describe("activeRunForRoutine", () => {
  it("returns the queued, running, or waiting run and ignores settled receipts", () => {
    const runs = [
      { ...queued, id: "done", status: "completed" as const },
      queued,
    ];
    expect(activeRunForRoutine(runs, "routine-1")?.id).toBe("run-q");
    expect(activeRunForRoutine(runs, "routine-other")).toBeUndefined();
  });
});

describe("workingThreadId", () => {
  it("uses the live routine thread when work is detached from the open chat", () => {
    expect(workingThreadId({
      busy: true,
      viewedThreadId: "chat-thread",
      liveRoutineThreadId: "exec-thread",
    })).toBe("exec-thread");
  });

  it("uses the open chat when the bot is busy with no detached routine", () => {
    expect(workingThreadId({
      busy: true,
      viewedThreadId: "chat-thread",
      liveRoutineThreadId: null,
    })).toBe("chat-thread");
  });

  it("is idle when nothing is working", () => {
    expect(workingThreadId({
      busy: false,
      viewedThreadId: "chat-thread",
      liveRoutineThreadId: null,
    })).toBeNull();
  });
});

describe("switch and delete while a routine is running", () => {
  it("allows aligning the open chat to the working thread, not leaving it", () => {
    expect(canSwitchWhileWorking("exec-thread", "exec-thread")).toBe(true);
    expect(canSwitchWhileWorking("chat-thread", "exec-thread")).toBe(false);
    expect(canSwitchWhileWorking("chat-thread", null)).toBe(true);
  });

  it("blocks deleting the working thread and allows deleting an unchecked idle thread", () => {
    expect(canDeleteWhileWorking("exec-thread", "exec-thread")).toBe(false);
    expect(canDeleteWhileWorking("chat-thread", "exec-thread")).toBe(true);
  });
});

describe("liveCalendarSelection", () => {
  it("attaches a silent run-now onto the scheduled slot so queued/running is visible", () => {
    const selected = liveCalendarSelection(
      { id: "next-routine-1", at: 200, routine: { id: "routine-1", name: "Morning brief" }, run: null },
      [{ id: "routine-1", name: "Morning brief" }],
      [running],
    );
    expect(selected.run?.id).toBe("run-r");
    expect(selected.id).toBe("run-run-r");
  });

  it("keeps a settled receipt on screen instead of swapping in a later run", () => {
    const done = { ...queued, id: "run-done", status: "completed" as const };
    const selected = liveCalendarSelection(
      { id: "run-run-done", at: 50, routine: { id: "routine-1", name: "Morning brief" }, run: done },
      [{ id: "routine-1", name: "Morning brief" }],
      [done, running],
    );
    expect(selected.run?.id).toBe("run-done");
  });
});

describe("routineWorkingElsewhere", () => {
  it("names the routine that is queued or running on another thread of the same bot", () => {
    expect(routineWorkingElsewhere("chat-thread", running)).toEqual({
      name: "Morning brief",
      threadId: "exec-thread",
      status: "running",
    });
    expect(routineWorkingElsewhere("chat-thread", queued)).toEqual({
      name: "Morning brief",
      threadId: undefined,
      status: "queued",
    });
    expect(routineWorkingElsewhere("exec-thread", running)).toBeNull();
  });
});
