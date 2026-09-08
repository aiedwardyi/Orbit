import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { liveActivityLabel } from "./live-activity";
import {
  applyStreamDelta,
  buffersForTurn,
  hydrationTurnThread,
  nextStreamState,
  nextTurnSignals,
  streamResetFor,
  turnPhase,
  turnStageLabel,
  type TurnStreamState,
  type TurnSignals,
} from "./turn-stage";
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

  it("treats a received stream as progress even when the redacted payload is empty", () => {
    // StreamSecretMasker holds the last 96 chars and emits "" until the tail
    // flushes at a turn boundary, which is after the settled bubble hid the label.
    expect(turnPhase({ signal: "started", lastMessage: user, streaming: "" })).toBe("responding");
    expect(turnPhase({ signal: "started", lastMessage: user, reasoning: "" })).toBe("reasoning");
    expect(turnPhase({ signal: "started", lastMessage: user, reasoning: "", streaming: "" })).toBe("responding");
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

  it("drops a signal left by a turn that died without turn.completed", () => {
    // The stall watchdog and a provider reload both settle killed turns
    // silently; the next send is the only boundary that always arrives.
    expect(phaseAfter(["started", "sent"])).toBe("preparing");
    expect(phaseAfter(["retrying", "sent"])).toBe("preparing");
    expect(phaseAfter(["started", "sent", "started"])).toBe("waiting");
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
    expect(nextTurnSignals(signals, "t2", "sent")).toBe(signals);
    expect(nextTurnSignals(signals, "t2", "edited")).toBe(signals);
    expect(nextTurnSignals(signals, "t1", "hydrated")).toBe(signals);
  });

  it("backfills started from a busy snapshot without clobbering a live retry", () => {
    // /api/events resumed:false hydrates busy bots from /api/bots; signal is
    // not in that snapshot, so an already-dispatched turn would read Preparing.
    expect(nextTurnSignals({}, "t1", "hydrated")["t1"]).toBe("started");
    expect(turnPhase({ signal: nextTurnSignals({}, "t1", "hydrated")["t1"], lastMessage: user })).toBe("waiting");
    expect(nextTurnSignals({ t1: "retrying" }, "t1", "hydrated")["t1"]).toBe("retrying");
    expect(nextTurnSignals({ idle: "started" }, "t1", "hydrated")).toEqual({ idle: "started", t1: "started" });
  });
});

describe("applyStreamDelta", () => {
  it("records the stream kind even when the held delta is empty", () => {
    expect(turnPhase({ signal: "started", lastMessage: user, ...applyStreamDelta({}, "assistant_text", "") })).toBe(
      "responding",
    );
    expect(turnPhase({ signal: "started", lastMessage: user, ...applyStreamDelta({}, "reasoning_text", "") })).toBe(
      "reasoning",
    );
    expect(applyStreamDelta({}, "assistant_text", "Hi").streaming).toBe("Hi");
  });
});

describe("nextStreamState", () => {
  it("drops leftover stream text when a send starts the next turn", () => {
    // A provider reload or the stall-watchdog fallback can kill a turn after
    // it emitted reasoning or partial text, with no turn.completed. Clearing
    // only the signal leaves turnPhase reading Responding or Thinking.
    const prev = { streaming: { t1: "partial" }, reasoning: { t1: "hmm" }, signal: { t1: "started" as const } };
    const next = nextStreamState(prev, "t1", "sent");
    expect(turnPhase({ signal: next.signal["t1"], lastMessage: user, streaming: next.streaming["t1"], reasoning: next.reasoning["t1"] })).toBe(
      "preparing",
    );
    expect(next.streaming).not.toHaveProperty("t1");
    expect(next.reasoning).not.toHaveProperty("t1");
  });

  it("keeps stream text while a retry is announced", () => {
    const prev = { streaming: { t1: "The" }, reasoning: {}, signal: { t1: "started" as const } };
    const next = nextStreamState(prev, "t1", "retrying");
    expect(next.streaming["t1"]).toBe("The");
    expect(turnPhase({ signal: next.signal["t1"], lastMessage: user, streaming: next.streaming["t1"] })).toBe(
      "responding",
    );
  });
});

const requestCard: Message = {
  id: "opt",
  at: 3,
  role: "bot",
  kind: "options",
  card: { title: "Allow?", subtitle: "", options: ["Allow", "Deny"], requestId: "r1" },
};
const resolvedCard: Message = {
  ...requestCard,
  card: { ...requestCard.card!, answered: "Allow" },
};

const streamOf = (partial: Partial<TurnStreamState>): TurnStreamState => ({
  streaming: {},
  reasoning: {},
  signal: {},
  gen: {},
  turn: {},
  ...partial,
});

const phaseOn = (state: TurnStreamState, last: Message) =>
  turnPhase({
    signal: state.signal["t1"],
    lastMessage: last,
    ...buffersForTurn(state, "t1", last.id),
  });

describe("turn-scoped buffers", () => {
  it("drops leftover stream text when an edit starts the next turn", () => {
    // A killed turn left partial tokens. editMessage never passes through
    // the send-only boundary, so the next wait must not inherit them.
    const killed = streamOf({
      streaming: { t1: "partial" },
      reasoning: { t1: "hmm" },
      signal: { t1: "started" },
      turn: { t1: `0:${user.id}` },
    });
    const next = nextStreamState(killed, "t1", "edited");
    expect(phaseOn(next, user)).toBe("preparing");
    expect(next.streaming).not.toHaveProperty("t1");
    expect(next.reasoning).not.toHaveProperty("t1");
  });

  it("returns Waiting after a request card interrupts reasoning and is resolved", () => {
    // request.opened appends an options message; request.resolved only
    // patches the card. The pre-card reasoning is not this wait's.
    const duringReasoning = streamOf({
      reasoning: { t1: "hmm" },
      signal: { t1: "started" },
      turn: { t1: `0:${user.id}` },
    });
    expect(phaseOn(duringReasoning, user)).toBe("reasoning");
    expect(phaseOn(duringReasoning, requestCard)).toBe("waiting");
    expect(phaseOn(duringReasoning, resolvedCard)).toBe("waiting");
  });

  it("lets a running tool win after a non-resumable busy snapshot follows a delta", () => {
    // Client saw assistant text, disconnected, snapshot ends in a running
    // tool. Streaming outranks tools, so a kept buffer would read Responding.
    const prev = streamOf({
      streaming: { t1: "The" },
      signal: { t1: "started" },
      turn: { t1: `0:${user.id}` },
    });
    const next = nextStreamState(prev, "t1", "hydrated");
    expect(phaseOn(next, runningTool)).toBe("tool");
    expect(next.streaming).not.toHaveProperty("t1");
  });

  it("does not stamp started on a personal thread when the bot is busy in a channel", () => {
    const thread = hydrationTurnThread({ id: "bot-1", busy: true, threadId: "personal" }, [
      { busyBotId: "bot-1" },
    ]);
    expect(thread).toBeUndefined();
    expect(turnPhase({ lastMessage: user, signal: thread ? "started" : undefined })).toBe("preparing");
  });

  it("still backfills started when the busy work is on this thread", () => {
    expect(hydrationTurnThread({ id: "bot-1", busy: true, threadId: "personal" }, [])).toBe("personal");
    expect(
      turnPhase({ lastMessage: user, signal: nextTurnSignals({}, "personal", "hydrated")["personal"] }),
    ).toBe("waiting");
  });
});

describe("streamResetFor", () => {
  it("ends the reasoning block at a tool, and the whole stream only at settled text", () => {
    expect(streamResetFor(runningTool)).toBe("reasoning");
    expect(streamResetFor(doneTool)).toBe("reasoning");
    expect(streamResetFor({ role: "bot", kind: "text" })).toBe("stream");
    expect(streamResetFor(user)).toBe(null);
  });

  it("lets the model-wait phase come back after a tool finishes", () => {
    // reasoning -> tool starts -> tool settles ok. Without the reset the
    // pre-tool reasoning string pins the label to Thinking for the rest of it.
    const client = { signal: nextTurnSignals({}, "t1", "started")["t1"], reasoning: "hmm" };
    expect(turnPhase({ ...client, lastMessage: user })).toBe("reasoning");

    const reset = streamResetFor(runningTool) === "reasoning" ? { signal: client.signal } : client;
    expect(turnPhase({ ...reset, lastMessage: runningTool })).toBe("tool");
    expect(turnPhase({ ...reset, lastMessage: doneTool })).toBe("waiting");
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
