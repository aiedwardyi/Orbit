import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import {
  idleReopenStampReason,
  lastUserInstruction,
  packetAfterInterruption,
  shouldStampRecoveryDismiss,
  shutdownStampsForClose,
  turnCompletionDisposition,
} from "./task-recovery-flush.ts";
import { seedTaskResumePacket } from "./task-state-fold.ts";

const indexSource = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "index.ts"), "utf8");

const seed = () => seedTaskResumePacket({
  botId: "bot-1",
  threadId: "thread-1",
  text: "Prepare a weekly competitor brief",
  messageId: "message-1",
  now: 100,
  turnsAtWrite: 0,
});

describe("task recovery interruption flush", () => {
  it("stamps an existing packet stop or crash without widening eligibility", () => {
    const stopped = packetAfterInterruption(seed(), "stop", { now: 300, turnsAtWrite: 1 });
    const crashed = packetAfterInterruption(seed(), "crash", { now: 400, turnsAtWrite: 1 });

    expect(stopped).toMatchObject({
      goal: "Prepare a weekly competitor brief",
      flushReason: "stop",
      updatedAt: 300,
      turnsAtWrite: 1,
    });
    expect(crashed).toMatchObject({ flushReason: "crash", updatedAt: 400 });
  });

  it("seeds a stop or crash packet from the last user instruction when none exists", () => {
    const instruction = lastUserInstruction([
      { id: "quiz", role: "bot", kind: "options", at: 50 },
      { id: "message-2", role: "user", kind: "text", text: "Finish the weekly brief", at: 200 },
    ]);
    expect(instruction).toEqual({
      text: "Finish the weekly brief",
      messageId: "message-2",
      at: 200,
    });

    const created = packetAfterInterruption(null, "stop", { now: 300, turnsAtWrite: 0 }, {
      botId: "bot-1",
      threadId: "thread-1",
      text: instruction!.text,
      messageId: instruction!.messageId,
      now: instruction!.at,
      turnsAtWrite: 0,
    });

    expect(created).toMatchObject({
      botId: "bot-1",
      threadId: "thread-1",
      goal: "Finish the weekly brief",
      nextAction: "Finish the weekly brief",
      flushReason: "stop",
    });
    expect(packetAfterInterruption(null, "crash", { now: 1, turnsAtWrite: 0 })).toBeNull();
  });
});

describe("normal-reopen shutdown stamps", () => {
  const turnEnd = { flushReason: "turn-end", goal: "Publish the brief", botId: "bot-1" };
  const progress = { flushReason: "progress", goal: "Publish the brief", botId: "bot-1" };
  const stopped = { flushReason: "stop", goal: "Publish the brief", botId: "bot-1" };

  it("stamps shutdown for an idle forever thread with a settled record", () => {
    expect(idleReopenStampReason(turnEnd)).toBe("shutdown");
    expect(idleReopenStampReason({ flushReason: "approval", goal: "Wait for login" })).toBe("shutdown");
    expect(idleReopenStampReason({ flushReason: "engine-switch", goal: "Keep going" })).toBe("shutdown");
    expect(idleReopenStampReason({ flushReason: "pre-compaction", goal: "Keep going" })).toBe("shutdown");
  });

  it("does not invent a record for empty or new bots, or re-nag a dismissed thread", () => {
    expect(idleReopenStampReason(null)).toBeNull();
    expect(idleReopenStampReason(progress)).toBeNull();
  });

  it("leaves crash, stop, and shutdown packets for those paths", () => {
    expect(idleReopenStampReason({ flushReason: "crash", goal: "Recover" })).toBeNull();
    expect(idleReopenStampReason(stopped)).toBeNull();
    expect(idleReopenStampReason({ flushReason: "shutdown", goal: "Recover" })).toBeNull();
  });

  it("collects busy interrupt stamps and idle forever-chat reopen without widening live turn-end", () => {
    const packets: Record<string, { flushReason: string; goal: string; botId: string } | null> = {
      "idle-thread": turnEnd,
      "dismissed-thread": progress,
      "empty-thread": null,
      "stopped-thread": stopped,
      "busy-thread": { flushReason: "progress", goal: "In flight", botId: "busy" },
      "room-idle": { ...turnEnd, botId: "idle" },
      "room-busy": { flushReason: "progress", goal: "Room turn", botId: "speaker" },
    };

    expect(shutdownStampsForClose({
      bots: [
        { id: "idle", busy: false, threadId: "idle-thread" },
        { id: "new", busy: false, threadId: "empty-thread" },
        { id: "dismissed", busy: false, threadId: "dismissed-thread" },
        { id: "stopped", busy: false, threadId: "stopped-thread" },
        { id: "busy", busy: true, threadId: "busy-thread", activeThreadId: "busy-thread" },
        { id: "speaker", busy: true, threadId: "speaker-dm" },
        { id: "routine", busy: true, threadId: "viewed-thread", activeThreadId: "viewed-thread" },
      ],
      groups: [
        { threadId: "room-idle", busyBotId: null, memberIds: ["idle"] },
        { threadId: "room-busy", busyBotId: "speaker", memberIds: ["speaker", "idle"] },
      ],
      routineThreadByBotId: { routine: "routine-thread" },
      packetFor: (threadId) => packets[threadId] ?? null,
    })).toEqual([
      { threadId: "busy-thread", botId: "busy", reason: "shutdown" },
      { threadId: "routine-thread", botId: "routine", reason: "shutdown" },
      { threadId: "room-busy", botId: "speaker", reason: "shutdown" },
      { threadId: "idle-thread", botId: "idle", reason: "shutdown" },
      { threadId: "room-idle", botId: "idle", reason: "shutdown" },
    ]);
    expect(idleReopenStampReason(progress)).toBeNull();
    expect(indexSource).toMatch(/hostShutdown[\s\S]*shutdownStampsForClose[\s\S]*taskPacketForWrite/);
    expect(indexSource).toContain("if (packet && !hostShutdownStarted)");
  });
});

describe("turn completion disposition after stop", () => {
  it("keeps an interrupted completion when no newer turn is live", () => {
    expect(turnCompletionDisposition({
      eventTurnId: "turn-stop",
      liveTurnId: "turn-stop",
      interruptedTurnIds: new Set(["turn-stop"]),
      interruptedAt: 2,
      dispatchedAt: 1,
    })).toEqual({ superseded: false, interrupted: true });
  });

  it("does not treat a later resume completion as stale", () => {
    expect(turnCompletionDisposition({
      eventTurnId: "turn-resume",
      liveTurnId: "turn-resume",
      interruptedTurnIds: new Set(["turn-stop"]),
      interruptedAt: 2,
      dispatchedAt: 3,
    })).toEqual({ superseded: false, interrupted: false });
  });

  it("ignores a late stopped completion after a newer turn dispatched", () => {
    expect(turnCompletionDisposition({
      eventTurnId: "turn-stop",
      liveTurnId: "turn-resume",
      interruptedTurnIds: new Set(["turn-stop"]),
      interruptedAt: 2,
      dispatchedAt: 3,
    })).toEqual({ superseded: true, interrupted: true });
  });

  it("stamps a recovery dismiss only when the posted version still matches", () => {
    const current = { updatedAt: 200, flushReason: "shutdown" };
    expect(shouldStampRecoveryDismiss(current, { updatedAt: 200, flushReason: "shutdown" })).toBe(true);
    expect(shouldStampRecoveryDismiss(current, {})).toBe(true);
    expect(shouldStampRecoveryDismiss(current, { updatedAt: 199, flushReason: "shutdown" })).toBe(false);
    expect(shouldStampRecoveryDismiss(current, { updatedAt: 200, flushReason: "stop" })).toBe(false);
    expect(indexSource).toContain("shouldStampRecoveryDismiss");
  });

  it("falls back to interruption time when the event carries no turn id", () => {
    expect(turnCompletionDisposition({
      liveTurnId: "turn-stop",
      interruptedTurnIds: new Set(["turn-stop"]),
      interruptedAt: 2,
      dispatchedAt: 1,
    })).toEqual({ superseded: false, interrupted: true });
    expect(turnCompletionDisposition({
      liveTurnId: "turn-resume",
      interruptedTurnIds: new Set(["turn-stop"]),
      interruptedAt: 2,
      dispatchedAt: 3,
    })).toEqual({ superseded: false, interrupted: false });
  });
});
