import { describe, expect, it } from "vitest";

import { isTaskRecoveryVisible, roomRecoveryBusy, roomRecoveryPacket } from "./task-recovery";

const packet = (flushReason: string) => ({ flushReason });

describe("task recovery banner eligibility", () => {
  it("shows only when a packet exists, the bot is idle, and flushReason is crash, shutdown, or stop", () => {
    expect(isTaskRecoveryVisible(packet("crash"), false)).toBe(true);
    expect(isTaskRecoveryVisible(packet("shutdown"), false)).toBe(true);
    expect(isTaskRecoveryVisible(packet("stop"), false)).toBe(true);
  });

  it("shows the quiet strip after a stop flush once the bot is idle", () => {
    const stopped = packet("stop");
    expect(isTaskRecoveryVisible(stopped, true)).toBe(false);
    expect(isTaskRecoveryVisible(stopped, false)).toBe(true);
  });

  it("does not widen to turn-end, progress, engine-switch, approval, or other reopen reasons", () => {
    for (const reason of ["turn-end", "progress", "approval", "engine-switch", "pre-compaction"]) {
      expect(isTaskRecoveryVisible(packet(reason), false)).toBe(false);
    }
    expect(isTaskRecoveryVisible(undefined, false)).toBe(false);
    expect(isTaskRecoveryVisible(packet("crash"), true)).toBe(false);
    expect(isTaskRecoveryVisible(packet("stop"), true)).toBe(false);
  });

  it("shows a room strip after Stop once the channel is idle, without widening eligibility", () => {
    const stopped = { threadId: "room-1", taskState: packet("stop") };
    const room = {
      threadId: "room-1",
      busyBotId: null as string | null,
      working: false,
      tasks: [stopped, { threadId: "older", taskState: packet("crash") }],
    };
    const visible = roomRecoveryPacket(room);
    expect(visible).toEqual(packet("stop"));
    expect(isTaskRecoveryVisible(visible, roomRecoveryBusy(room, false))).toBe(true);

    expect(isTaskRecoveryVisible(visible, roomRecoveryBusy({ ...room, busyBotId: "speaker" }, false))).toBe(false);
    expect(isTaskRecoveryVisible(visible, roomRecoveryBusy(room, true))).toBe(false);
    expect(isTaskRecoveryVisible(roomRecoveryPacket({
      threadId: "room-1",
      taskState: packet("turn-end"),
      tasks: [{ threadId: "room-1", taskState: packet("turn-end") }],
    }), false)).toBe(false);
    expect(roomRecoveryPacket({ threadId: "dm-1", taskState: packet("crash") })).toEqual(packet("crash"));
    expect(roomRecoveryPacket({
      threadId: "room-2",
      taskState: packet("stop"),
      tasks: [{ threadId: "room-2" }],
    })).toBeUndefined();
  });
});
