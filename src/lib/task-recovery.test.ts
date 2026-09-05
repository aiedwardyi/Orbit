import { describe, expect, it } from "vitest";

import { isTaskRecoveryVisible } from "./task-recovery";

const packet = (flushReason: string) => ({ flushReason });

describe("task recovery banner eligibility", () => {
  it("shows only when a packet exists, the bot is idle, and flushReason is crash, shutdown, or stop", () => {
    expect(isTaskRecoveryVisible(packet("crash"), false)).toBe(true);
    expect(isTaskRecoveryVisible(packet("shutdown"), false)).toBe(true);
    expect(isTaskRecoveryVisible(packet("stop"), false)).toBe(true);
  });

  it("does not widen to turn-end, progress, engine-switch, approval, or other reopen reasons", () => {
    for (const reason of ["turn-end", "progress", "approval", "engine-switch", "pre-compaction"]) {
      expect(isTaskRecoveryVisible(packet(reason), false)).toBe(false);
    }
    expect(isTaskRecoveryVisible(undefined, false)).toBe(false);
    expect(isTaskRecoveryVisible(packet("crash"), true)).toBe(false);
    expect(isTaskRecoveryVisible(packet("stop"), true)).toBe(false);
  });
});
