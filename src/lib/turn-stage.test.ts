import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { liveActivityLabel } from "./live-activity";
import { nextTurnSignals, turnPhase, turnStageLabel, type TurnSignals } from "./turn-stage";
import type { Message } from "@/state/store";

const here = dirname(fileURLToPath(import.meta.url));
const chatView = readFileSync(join(here, "../components/ChatView.tsx"), "utf8");
const groupView = readFileSync(join(here, "../components/GroupView.tsx"), "utf8");

const phaseAfter = (events: Parameters<typeof nextTurnSignals>[2][]) => {
  const signals = events.reduce<TurnSignals>((acc, event) => nextTurnSignals(acc, "t1", event), {});
  return turnPhase({ signal: signals["t1"], lastMessage: user });
};

const user: Message = { id: "u1", at: 1, role: "user", kind: "text", text: "hi" };
const runningTool: Message = { id: "a1", at: 2, role: "bot", kind: "activity", tool: { name: "Bash: pnpm test" } };
const doneTool: Message = { ...runningTool, tool: { name: "Bash: pnpm test", ok: true } };

const label = (phase: ReturnType<typeof turnPhase>, message?: Message, showToolCalls = false) =>
  turnStageLabel(phase, liveActivityLabel(message, showToolCalls));

describe("turnPhase", () => {
  it("is preparing until the server confirms the turn started", () => {
    expect(turnPhase({ lastMessage: user })).toBe("preparing");
  });

  it("is waiting once turn.started arrives with no output yet", () => {
    expect(turnPhase({ signal: "started", lastMessage: user })).toBe("waiting");
  });

  it("is retrying while a relaunch is announced", () => {
    expect(turnPhase({ signal: "retrying", lastMessage: user })).toBe("retrying");
  });

  it("is tool while a tool call is unsettled, and not after it settles", () => {
    expect(turnPhase({ signal: "started", lastMessage: runningTool })).toBe("tool");
    expect(turnPhase({ signal: "started", lastMessage: doneTool })).toBe("waiting");
  });

  it("separates reasoning tokens from answer tokens", () => {
    expect(turnPhase({ signal: "started", lastMessage: user, reasoning: "hmm" })).toBe("reasoning");
    expect(turnPhase({ signal: "started", lastMessage: user, streaming: "The" })).toBe("responding");
  });

  it("lets real output supersede a stale retry announcement", () => {
    expect(turnPhase({ signal: "retrying", reasoning: "hmm" })).toBe("reasoning");
    expect(turnPhase({ signal: "retrying", streaming: "The" })).toBe("responding");
    expect(turnPhase({ signal: "retrying", lastMessage: runningTool })).toBe("tool");
  });
});

describe("turnStageLabel", () => {
  it("gives the whole time-to-first-token a distinct label per phase", () => {
    const timeline = [
      turnPhase({ lastMessage: user }),
      turnPhase({ signal: "started", lastMessage: user }),
      turnPhase({ signal: "retrying", lastMessage: user }),
      turnPhase({ signal: "started", lastMessage: user, reasoning: "hmm" }),
      turnPhase({ signal: "started", lastMessage: user, streaming: "The" }),
    ];
    const labels = timeline.map((phase) => label(phase, user));
    expect(labels).toEqual(["Preparing", "Waiting for the model", "Reconnecting", "Thinking", "Responding"]);
    expect(new Set(labels).size).toBe(labels.length);
  });

  it("keeps tool verbs behind Show tool calls", () => {
    expect(label("tool", runningTool, true)).toBe("Running a command");
    expect(label("tool", runningTool, false)).toBe("Thinking");
  });
});

describe("nextTurnSignals", () => {
  it("holds the signal through a settled preamble mid-turn", () => {
    expect(phaseAfter(["started", "settled-message"])).toBe("waiting");
    expect(phaseAfter(["retrying", "settled-message"])).toBe("retrying");
  });

  it("drops the signal at the turn boundary and on a rewind", () => {
    expect(phaseAfter(["started", "completed"])).toBe("preparing");
    expect(phaseAfter(["started", "rewound"])).toBe("preparing");
  });

  it("carries the next turn's signal after the previous one ended", () => {
    expect(phaseAfter(["started", "completed", "started"])).toBe("waiting");
    expect(phaseAfter(["started", "retrying"])).toBe("retrying");
  });

  it("keeps one thread's turn out of another's", () => {
    const signals = nextTurnSignals({ other: "started" }, "t1", "started");
    expect(nextTurnSignals(signals, "t1", "completed")).toEqual({ other: "started" });
  });

  it("returns the same object when nothing changes, so the stream never re-renders", () => {
    const signals: TurnSignals = { t1: "started" };
    expect(nextTurnSignals(signals, "t1", "started")).toBe(signals);
    expect(nextTurnSignals(signals, "t1", "settled-message")).toBe(signals);
    expect(nextTurnSignals(signals, "t2", "completed")).toBe(signals);
  });
});

// Both invariants below are about JSX that never renders under the node test
// environment, so source text is the only handle on them.
describe("wiring", () => {
  it("stages the 1:1 label and leaves rooms alone", () => {
    expect(chatView).toContain("turnStageLabel");
    expect(chatView).toContain("turnPhase");
    expect(groupView).not.toContain("turnStageLabel");
  });

  it("keeps the pop-in: no streamed text is rendered into the 1:1 answer", () => {
    expect(chatView).not.toMatch(/\{\s*streaming\s*\}/);
  });
});
