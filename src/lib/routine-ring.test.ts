import { describe, expect, it } from "vitest";

import * as ring from "./routine-ring";

const run = (patch: Partial<Parameters<typeof ring.routineRinging>[0][number]> = {}) => ({
  runOn: "maus" as const,
  status: "completed" as const,
  sourceThreadId: "old-task",
  ...patch,
});

describe("routine rings", () => {
  it("rings a run whose chat is an inactive task of the bot", () => {
    const runs = [run()];
    expect(ring.routineRinging(runs, "active-thread")).toBe(false);
    expect(ring.routineRinging(runs, "active-thread", [{ threadId: "old-task" }])).toBe(true);
    expect(ring.anyRoutineRinging(runs, [{ id: "bot", threadId: "active-thread", tasks: [{ threadId: "old-task" }] }])).toBe(true);
  });

  it("does not ring a detached or already seen task", () => {
    const tasks = [{ threadId: "old-task" }];
    expect(ring.routineRinging([run({ threadId: "exec" })], "active-thread", tasks)).toBe(false);
    expect(ring.routineRinging([run({ seenAt: 5 })], "active-thread", tasks)).toBe(false);
    expect(ring.ringingRuns([run()], "active-thread")).toEqual([]);
  });

  it("treats app settings and plugins as covering the chat", () => {
    const onScreen = ring.routineChatOnScreen;
    expect(typeof onScreen).toBe("function");
    const view = { activeView: "chat", workspaceOpen: false, appSettingsOpen: false, pluginsOpen: false };
    expect(onScreen?.(view)).toBe(true);
    expect(onScreen?.({ ...view, appSettingsOpen: true })).toBe(false);
    expect(onScreen?.({ ...view, pluginsOpen: true })).toBe(false);
    expect(onScreen?.({ ...view, activeView: "routines" })).toBe(false);
    expect(onScreen?.({ ...view, workspaceOpen: true })).toBe(false);
  });
});
