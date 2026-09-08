import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { liveActivityLabel } from "./live-activity";
import { turnPhase, turnStageLabel } from "./turn-stage";
import type { Message } from "@/state/store";

const here = dirname(fileURLToPath(import.meta.url));
const chatView = readFileSync(join(here, "../components/ChatView.tsx"), "utf8");
const groupView = readFileSync(join(here, "../components/GroupView.tsx"), "utf8");
const store = readFileSync(join(here, "../state/store.tsx"), "utf8");

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

describe("wiring", () => {
  it("stages the 1:1 label and leaves rooms alone", () => {
    expect(chatView).toContain("turnStageLabel");
    expect(chatView).toContain("turnPhase");
    expect(groupView).not.toContain("turnStageLabel");
  });

  it("keeps the pop-in: no streamed text is rendered into the 1:1 answer", () => {
    expect(chatView).not.toMatch(/\{\s*streaming\s*\}/);
  });

  it("scopes the signal to the turn, not to a settled message", () => {
    // clearStream also runs when a preamble settles mid-turn; only these two
    // sites may drop the signal, or a working bot falls back to Preparing.
    expect(store.match(/setTurnSignal\([^,]+, undefined\)/g)).toHaveLength(2);
    expect(store).toMatch(/turn\.completed[\s\S]{0,200}setTurnSignal\([^,]+, undefined\)/);
  });
});
