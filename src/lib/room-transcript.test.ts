import { describe, expect, it } from "vitest";

import { groupActivityRuns } from "./activity-runs";
import { roomTranscriptRows } from "./room-transcript";
import type { Message } from "@/state/store";

let seq = 0;
const at = (day: number, hour = 12) => new Date(2026, 0, day, hour).getTime();
const from = (botId: string) => ({ botId, name: botId, color: "blue" } as const);

const say = (botId: string, text: string, when = at(1)): Message =>
  ({ id: `m${++seq}`, at: when, role: "bot", kind: "text", text, from: from(botId) });
const step = (botId: string, name: string, ok = true, when = at(1)): Message =>
  ({ id: `t${++seq}`, at: when, role: "bot", kind: "activity", tool: { name, ok }, from: from(botId) });
const secret = (botId?: string): Message => {
  const message: Message = {
    id: `s${++seq}`,
    at: at(1),
    role: "bot",
    kind: "secret",
    secret: {
      target: "xaiApiKey",
      label: "API key",
      description: "Connect the provider.",
      placeholder: "Key",
      helpUrl: "https://example.com",
      requestKey: "request-key",
    },
  };
  if (botId) message.from = from(botId);
  return message;
};
const connector = (botId?: string): Message => {
  const message: Message = {
    id: `c${++seq}`,
    at: at(1),
    role: "bot",
    kind: "connector",
    connector: {
      slug: "github",
      label: "GitHub",
      description: "Connect GitHub.",
      status: "required",
      resumeKey: "resume-key",
    },
  };
  if (botId) message.from = from(botId);
  return message;
};

const rows = (messages: Message[], showToolCalls = false) =>
  roomTranscriptRows(groupActivityRuns(messages), { showToolCalls });

describe("roomTranscriptRows", () => {
  it("labels a bot whose first visible line follows its own hidden step", () => {
    const result = rows([
      say("defense", "Here is the argument."),
      step("challenge", "Read"),
      say("challenge", "That misses the point."),
    ]);
    expect(result.map((row) => row.visible)).toEqual([true, false, true]);
    expect(result[2].cluster).toBe(true);
  });

  it("labels a bot whose first visible line follows its own hidden run", () => {
    const result = rows([
      say("defense", "Here is the argument."),
      step("challenge", "Read"),
      step("challenge", "Grep"),
      say("challenge", "That misses the point."),
    ]);
    expect(result.map((row) => row.visible)).toEqual([true, false, true]);
    expect(result[2].cluster).toBe(true);
  });

  it("labels the first bot line in a room that opens with hidden activity", () => {
    const result = rows([step("challenge", "Read"), say("challenge", "Starting now.")]);
    expect(result.map((row) => row.visible)).toEqual([false, true]);
    expect(result[1].cluster).toBe(true);
  });

  it("does not relabel a bot that keeps talking across its own hidden activity", () => {
    const result = rows([say("defense", "One."), step("defense", "Read"), say("defense", "Two.")]);
    expect(result[2].cluster).toBe(false);
  });

  it("keeps a bot-to-bot chip visible and opens its sender's cluster with it", () => {
    const chip: Message = {
      ...step("challenge", "Messaged @Defense"),
      comm: { groupId: "g1", withBotId: "defense", withName: "Defense", withColor: "blue" },
    };
    const result = rows([say("defense", "Here is the argument."), chip, say("challenge", "On it.")]);
    expect(result.map((row) => row.visible)).toEqual([true, true, true]);
    expect(result[1].cluster).toBe(true);
    expect(result[2].cluster).toBe(false);
  });

  it("hides an empty bot line, so it cannot take the speaker label", () => {
    const result = rows([say("defense", "One."), say("challenge", ""), say("challenge", "Two.")]);
    expect(result.map((row) => row.visible)).toEqual([true, false, true]);
    expect(result[2].cluster).toBe(true);
  });

  it("skips the emerging reply, which renders above the transcript", () => {
    const emerging = say("challenge", "Popping in.");
    const result = roomTranscriptRows(groupActivityRuns([say("defense", "One."), emerging]), {
      showToolCalls: false,
      emergingId: emerging.id,
    });
    expect(result.map((row) => row.visible)).toEqual([true, false]);
  });

  it("keeps emerging text outside a visible activity run", () => {
    const emerging = say("challenge", "Popping in.");
    const items = groupActivityRuns([
      step("challenge", "Read"),
      step("challenge", "Grep"),
      emerging,
    ]);
    expect(items.map((item) => item.kind)).toEqual(["run", "message"]);
    expect(
      roomTranscriptRows(items, { showToolCalls: true, emergingId: emerging.id }).map(
        (row) => row.visible,
      ),
    ).toEqual([true, false]);
  });

  it("keeps the day divider on the first visible line after activity crosses midnight", () => {
    const result = rows([
      say("defense", "Late.", at(1, 23)),
      step("defense", "Read", true, at(2, 0)),
      say("defense", "Early.", at(2, 0)),
    ]);
    expect(result[2].newDay).toBe(true);
    expect(result[2].cluster).toBe(true);
  });

  it("hides computer-use screen frames while tool calls are hidden", () => {
    const frame: Message = {
      id: `s${++seq}`,
      at: at(1),
      role: "bot",
      kind: "screen",
      png: "frame",
      from: from("challenge"),
    };
    const hidden = rows([say("defense", "One."), frame, say("challenge", "Two.")]);
    expect(hidden.map((row) => row.visible)).toEqual([true, false, true]);
    expect(hidden[2].cluster).toBe(true);
    const shown = rows([say("defense", "One."), frame, say("challenge", "Two.")], true);
    expect(shown.map((row) => row.visible)).toEqual([true, true, true]);
  });

  it("hides a failed tool step while tool calls are hidden", () => {
    const result = rows([
      say("defense", "Here is the argument."),
      step("challenge", "Bash", false),
      say("challenge", "That failed."),
    ]);
    expect(result.map((row) => row.visible)).toEqual([true, false, true]);
    expect(result[2].cluster).toBe(true);
  });

  it("keeps a turn-level error visible and labelled while tool calls are hidden", () => {
    const err: Message = {
      id: `e${++seq}`,
      at: at(1),
      role: "bot",
      kind: "activity",
      tool: { name: "error: provider failed", ok: false },
      from: from("challenge"),
    };
    const result = rows([say("defense", "Here is the argument."), err, say("challenge", "That failed.")]);
    expect(result.map((row) => row.visible)).toEqual([true, true, true]);
    expect(result[1].cluster).toBe(true);
    expect(result[2].cluster).toBe(false);
  });

  it("keeps cards that the tool-call setting does not gate visible", () => {
    const approval: Message = {
      id: "c1",
      at: at(1),
      role: "bot",
      kind: "options",
      from: from("challenge"),
      card: { title: "Allow Bash?", subtitle: "git status", options: [], requestId: "r1", tool: "Bash" },
    };
    const result = rows([say("defense", "One."), approval, say("challenge", "Two.")]);
    expect(result.map((row) => row.visible)).toEqual([true, true, true]);
    expect(result[1].cluster).toBe(true);
    expect(result[2].cluster).toBe(false);
  });

  it("shows secret cards only when their room sender is known", () => {
    const result = rows([say("defense", "One."), secret(), secret("challenge")]);
    expect(result.map((row) => row.visible)).toEqual([true, false, true]);
    expect(result[2].cluster).toBe(true);
  });

  it("shows connector cards only when their room sender is known", () => {
    const result = rows([say("defense", "One."), connector(), connector("challenge")]);
    expect(result.map((row) => row.visible)).toEqual([true, false, true]);
    expect(result[2].cluster).toBe(true);
  });

  it("keeps activity and labels unchanged when tool calls are shown", () => {
    const result = rows(
      [
        say("defense", "Here is the argument."),
        step("challenge", "Read"),
        say("challenge", "That misses the point."),
      ],
      true,
    );
    expect(result.map((row) => row.visible)).toEqual([true, true, true]);
    expect(result.map((row) => row.cluster)).toEqual([true, true, false]);
  });
});
