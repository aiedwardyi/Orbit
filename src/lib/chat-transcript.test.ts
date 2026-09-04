import { describe, expect, it } from "vitest";

import { groupActivityRuns } from "./activity-runs";
import { chatTranscriptRows } from "./chat-transcript";
import type { Message } from "@/state/store";

let seq = 0;
const at = (day: number, hour = 12) => new Date(2026, 0, day, hour).getTime();

const say = (text: string, when = at(1)): Message =>
  ({ id: `m${++seq}`, at: when, role: "bot", kind: "text", text });
const user = (text: string, when = at(1)): Message =>
  ({ id: `u${++seq}`, at: when, role: "user", kind: "text", text });
const step = (name: string, ok = true, when = at(1)): Message =>
  ({ id: `t${++seq}`, at: when, role: "bot", kind: "activity", tool: { name, ok } });

const rows = (messages: Message[], showToolCalls = false, emergingId?: string | null) =>
  chatTranscriptRows(groupActivityRuns(messages), { showToolCalls, emergingId, transcript: messages });

describe("chatTranscriptRows", () => {
  it("keeps the day divider on the first visible line after hidden activity crosses midnight", () => {
    const result = rows([
      say("Late.", at(1, 23)),
      step("Read", true, at(2, 0)),
      say("Early.", at(2, 0)),
    ]);
    expect(result.map((row) => row.visible)).toEqual([true, false, true]);
    expect(result[2].newDay).toBe(true);
  });

  it("keeps the day divider after a hidden folded run crosses midnight", () => {
    const result = rows([
      say("Late.", at(1, 23)),
      step("Read", true, at(2, 0)),
      step("Grep", true, at(2, 0)),
      say("Early.", at(2, 0)),
    ]);
    expect(result.map((row) => row.visible)).toEqual([true, false, true]);
    expect(result[2].newDay).toBe(true);
  });

  it("does not invent a divider when hidden activity stays on the same calendar day", () => {
    const result = rows([
      say("One.", at(1, 12)),
      step("Read", true, at(1, 13)),
      say("Two.", at(1, 14)),
    ]);
    expect(result.map((row) => row.visible)).toEqual([true, false, true]);
    expect(result[2].newDay).toBe(false);
  });

  it("puts the divider on the visible run when tool calls are shown", () => {
    const result = rows(
      [
        say("Late.", at(1, 23)),
        step("Read", true, at(2, 0)),
        step("Grep", true, at(2, 0)),
        say("Early.", at(2, 0)),
      ],
      true,
    );
    expect(result.map((row) => row.visible)).toEqual([true, true, true]);
    expect(result.map((row) => row.newDay)).toEqual([true, true, false]);
  });

  it("hides a failed tool step while tool calls are hidden", () => {
    const result = rows([
      say("Late.", at(1, 23)),
      step("Bash", false, at(2, 0)),
      say("That failed.", at(2, 0)),
    ]);
    expect(result.map((row) => row.visible)).toEqual([true, false, true]);
    expect(result[2].newDay).toBe(true);
  });

  it("lets a turn-level error own the divider while tool calls are hidden", () => {
    const err: Message = {
      id: `e${++seq}`,
      at: at(2, 0),
      role: "bot",
      kind: "activity",
      tool: { name: "error: provider failed", ok: false },
    };
    const result = rows([say("Late.", at(1, 23)), err, say("That failed.", at(2, 0))]);
    expect(result.map((row) => row.visible)).toEqual([true, true, true]);
    expect(result.map((row) => row.newDay)).toEqual([true, true, false]);
  });

  it("hides computer-use screen frames while tool calls are hidden", () => {
    const frame: Message = {
      id: `s${++seq}`,
      at: at(1, 13),
      role: "bot",
      kind: "screen",
      png: "frame",
    };
    const hidden = rows([say("One.", at(1, 12)), frame, say("Two.", at(1, 14))]);
    expect(hidden.map((row) => row.visible)).toEqual([true, false, true]);
    const shown = rows([say("One.", at(1, 12)), frame, say("Two.", at(1, 14))], true);
    expect(shown.map((row) => row.visible)).toEqual([true, true, true]);
  });

  it("skips the emerging reply, which renders above the transcript", () => {
    const emerging = say("Popping in.", at(2, 0));
    const result = rows([say("Late.", at(1, 23)), emerging], false, emerging.id);
    expect(result.map((row) => row.visible)).toEqual([true, false]);
  });

  it("hides MCP agent tool walls when tool calls are off", () => {
    const result = rows([
      user("hey"),
      step("mcp__agents__create_bot"),
      step("mcp__agents__list_bots"),
      say("Hi."),
    ]);
    expect(result.map((row) => row.visible)).toEqual([true, false, true]);
  });

  it("does not let a talked-past onboarding card suppress the next day divider", () => {
    const quiz: Message = {
      id: "quiz",
      at: at(2, 0),
      role: "bot",
      kind: "options",
      card: { title: "What will you use this for?", subtitle: "Pick one.", options: ["Work"] },
    };
    const spoken = user("Work.", at(2, 0));
    const result = rows([say("Late.", at(1, 23)), quiz, spoken]);
    expect(result.map((row) => row.visible)).toEqual([true, false, true]);
    expect(result[2].newDay).toBe(true);
  });
});
