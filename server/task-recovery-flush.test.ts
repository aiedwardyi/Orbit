import { describe, expect, it } from "vitest";

import {
  lastUserInstruction,
  packetAfterInterruption,
  turnCompletionDisposition,
} from "./task-recovery-flush.ts";
import { seedTaskResumePacket } from "./task-state-fold.ts";

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
});
