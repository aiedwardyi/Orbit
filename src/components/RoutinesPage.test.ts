import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import type { Bot } from "@/state/store";
import type { Routine } from "@/lib/routines";

vi.hoisted(() => {
  Object.defineProperty(globalThis, "window", {
    value: { ogb: undefined },
    configurable: true,
    writable: true,
  });
});

vi.mock("@/state/store", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/state/store")>();
  return {
    ...actual,
    useStore: () => ({
      state: {
        instances: [],
        config: { box: { configured: false } },
      },
      dispatch: () => undefined,
    }),
  };
});

vi.mock("@/components/Avatar", () => ({
  BotAvatar: () => null,
}));

import { openRunInChat, RoutineEditor, routineEditorSaveInput } from "./RoutinesPage";

const bot = {
  id: "bot-1",
  threadId: "t1",
  name: "Friend",
  title: "",
  description: "",
  notifications: false,
  color: "green",
  unread: false,
  modelSelection: { instanceId: "grok", model: "grok-4.6", mode: "automatic" },
} as Bot;

const schedule = { type: "daily" as const, time: "09:00", weekdays: [1, 2, 3, 4, 5] };

function editorMarkup(routine?: Routine) {
  return renderToStaticMarkup(
    createElement(RoutineEditor, {
      routine,
      bots: [bot],
      onClose: () => undefined,
    }),
  );
}

describe("Friends routine editor", () => {
  it("does not render a Calendar block duration picker on create or edit", () => {
    const createHtml = editorMarkup();
    expect(createHtml).toContain("New routine");
    expect(createHtml).not.toContain("Calendar block");
    expect(createHtml).not.toContain("15 minutes");
    expect(createHtml).not.toContain("45 minutes");
    expect(createHtml).not.toContain("1 hour");
    expect(createHtml).not.toContain("2 hours");
    expect(createHtml).not.toContain("<select");

    const editHtml = editorMarkup({
      id: "routine-1",
      name: "Morning brief",
      prompt: "Summarize overnight mail.",
      botId: bot.id,
      runOn: "maus",
      enabled: true,
      schedule,
      durationMinutes: 90,
      nextRunAt: 1,
      createdAt: 1,
      updatedAt: 1,
    });
    expect(editHtml).toContain("Edit routine");
    expect(editHtml).not.toContain("Calendar block");
    expect(editHtml).not.toContain("1.5 hours");
    expect(editHtml).not.toContain("<select");
  });

  it("creates routines with durationMinutes 30 and keeps a stored duration on edit", () => {
    expect(
      routineEditorSaveInput({
        name: "Morning brief",
        prompt: "Summarize overnight mail.",
        botId: bot.id,
        runOn: "maus",
        schedule,
      }),
    ).toMatchObject({
      durationMinutes: 30,
      enabled: true,
    });

    expect(
      routineEditorSaveInput({
        name: "Morning brief",
        prompt: "Summarize overnight mail.",
        botId: bot.id,
        runOn: "maus",
        schedule,
        routine: { durationMinutes: 90 },
      }),
    ).toMatchObject({
      durationMinutes: 90,
      enabled: undefined,
    });
  });
});

describe("routine run history", () => {
  it("Open in chat jumps to the card", () => {
    const dispatch = vi.fn();
    const state = {
      hydrated: true,
      bots: [{ id: bot.id, threadId: "t1", tasks: [{ threadId: "t1" }, { threadId: "t2" }] }],
      groups: [{ id: "room", threadId: "room-1", tasks: [{ threadId: "room-1" }, { threadId: "room-2" }] }],
    };

    openRunInChat(dispatch, state, { botId: bot.id, sourceThreadId: "t2", cardMessageId: "card-1" });
    expect(dispatch.mock.calls.map(([action]) => action)).toEqual([
      { type: "select", id: bot.id },
      { type: "switchTask", botId: bot.id, threadId: "t2" },
      { type: "focusMessage", threadId: "t2", messageId: "card-1" },
    ]);

    dispatch.mockClear();
    openRunInChat(dispatch, state, { botId: bot.id, sourceThreadId: "room-2", cardMessageId: "card-2" });
    expect(dispatch.mock.calls.map(([action]) => action)).toEqual([
      { type: "select", id: "room" },
      { type: "switchGroupTask", groupId: "room", threadId: "room-2" },
      { type: "focusMessage", threadId: "room-2", messageId: "card-2" },
    ]);
  });
});
