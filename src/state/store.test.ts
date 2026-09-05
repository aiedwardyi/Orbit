import { describe, expect, it, vi } from "vitest";

import { isTaskRecoveryVisible } from "@/lib/task-recovery";
import { turnPresenceWaiting, visibleSteerEntries } from "@/lib/send-accept";
import {
  configStatusFromFrame,
  initialState,
  loadSnapshotBoundary,
  openNotificationTarget,
  reducer,
  shouldClearSelectedUnread,
  visibleNotificationThread,
  type Bot,
  type Group,
  type Message,
  type TaskResumePacket,
} from "./store";
import { openLiveEvents, type LiveEventSourceLike, type LiveEventsPlatform } from "../lib/live-events";

type SnapshotFrame =
  | { kind: "hello"; resumed: boolean; cursor: string }
  | { kind: "message"; threadId: string; message: { id: string } };

class SnapshotEventSource implements LiveEventSourceLike {
  onopen: (() => void) | null = null;
  onerror: (() => void) | null = null;
  onmessage: ((event: { data: string; lastEventId?: string }) => void) | null = null;
  close = vi.fn();

  constructor(readonly url: string) {}

  message(frame: SnapshotFrame, lastEventId = "") {
    this.onmessage?.({ data: JSON.stringify(frame), lastEventId });
  }
}

describe("replacement snapshot boundary", () => {
  it("flushes bot frames without reconnecting when a peripheral snapshot fails", async () => {
    const sources: SnapshotEventSource[] = [];
    const applied: unknown[] = [];
    const pending: unknown[] = [];
    const scheduleRetry = vi.fn();
    let hydrated = false;
    const platform: LiveEventsPlatform = {
      createEventSource: (url) => {
        const source = new SnapshotEventSource(url);
        sources.push(source);
        return source;
      },
      isOnline: () => true,
      isVisible: () => true,
      now: Date.now,
    };
    const stop = openLiveEvents(
      {
        onSnapshotRequired: async () => {
          const chatReady = await loadSnapshotBoundary(
            async () => {},
            [{ key: "webhooks", load: async () => Promise.reject(new Error("webhooks unavailable")) }],
            (part, error) => scheduleRetry(part.key, error),
          );
          if (chatReady) {
            hydrated = true;
            applied.push(...pending.splice(0));
          }
          return chatReady;
        },
        onFrame: (frame) => {
          if (hydrated) applied.push(frame);
          else pending.push(frame);
        },
        retryMinMs: 1,
        retryMaxMs: 1,
      },
      platform,
    );

    sources[0]!.message({ kind: "hello", resumed: false, cursor: "stream00:4" });
    sources[0]!.message(
      { kind: "message", threadId: "bot-thread", message: { id: "user-1" } },
      "stream00:5",
    );
    await vi.waitFor(() => expect(applied).toHaveLength(1));

    expect(applied).toEqual([
      { kind: "message", threadId: "bot-thread", message: { id: "user-1" } },
    ]);
    expect(scheduleRetry).toHaveBeenCalledWith("webhooks", expect.any(Error));
    expect(sources).toHaveLength(1);
    expect(sources[0]!.close).not.toHaveBeenCalled();
    stop();
  });
});

describe("notification routing", () => {
  const bots = [{ id: "bot-1", threadId: "main-thread", tasks: [{ threadId: "detached-thread" }] }];
  const groups = [{
    id: "room-1",
    threadId: "room-thread",
    tasks: [
      { threadId: "room-thread", title: "Current", createdAt: 1 },
      { threadId: "older-room-thread", title: "Older", createdAt: 0 },
    ],
  }];

  it("selects the bot and switches to the notification's exact task", () => {
    const dispatch = vi.fn();

    openNotificationTarget(dispatch, { botId: "bot-1", threadId: "detached-thread" }, { bots, groups });

    expect(dispatch.mock.calls.map(([action]) => action)).toEqual([
      { type: "select", id: "bot-1" },
      { type: "switchTask", botId: "bot-1", threadId: "detached-thread" },
    ]);
  });

  it("opens the room when the thread is a group's — never a bot task switch that would 404", () => {
    // room approval/question notifications carry the asker bot with the
    // GROUP's thread id; the exact destination is the room itself
    const dispatch = vi.fn();

    openNotificationTarget(dispatch, { botId: "bot-1", threadId: "room-thread" }, { bots, groups });

    expect(dispatch.mock.calls.map(([action]) => action)).toEqual([{ type: "select", id: "room-1" }]);
  });

  it("opens the room and restores the exact inactive channel task", () => {
    const dispatch = vi.fn();

    openNotificationTarget(dispatch, { botId: "bot-1", threadId: "older-room-thread" }, { bots, groups });

    expect(dispatch.mock.calls.map(([action]) => action)).toEqual([
      { type: "select", id: "room-1" },
      { type: "switchGroupTask", groupId: "room-1", threadId: "older-room-thread" },
    ]);
  });

  it("lands on a plain bot select for a thread it cannot place, not an error", () => {
    const dispatch = vi.fn();

    openNotificationTarget(dispatch, { botId: "bot-1", threadId: "deleted-task-thread" }, { bots, groups });

    expect(dispatch.mock.calls.map(([action]) => action)).toEqual([{ type: "select", id: "bot-1" }]);
  });

  it("identifies only the exact chat thread currently on screen", () => {
    expect(visibleNotificationThread({
      activeView: "chat",
      selectedId: "bot-1",
      bots,
      groups,
    })).toBe("main-thread");
    expect(visibleNotificationThread({
      activeView: "chat",
      selectedId: "room-1",
      bots,
      groups,
    })).toBe("room-thread");
    expect(visibleNotificationThread({
      activeView: "routines",
      selectedId: "bot-1",
      bots,
      groups,
    })).toBeNull();
  });

  it("clears unread only when that exact conversation is visible", () => {
    const owner = { id: "bot-1", unread: true };
    const visible = { activeView: "chat" as const, selectedId: "bot-1", workspaceOpen: false };
    expect(shouldClearSelectedUnread(visible, owner)).toBe(true);
    expect(shouldClearSelectedUnread({ ...visible, activeView: "routines" }, owner)).toBe(false);
    expect(shouldClearSelectedUnread({ ...visible, selectedId: "room-1" }, owner)).toBe(false);
    expect(shouldClearSelectedUnread({ ...visible, workspaceOpen: true }, owner)).toBe(false);
    expect(shouldClearSelectedUnread(visible, { ...owner, unread: false })).toBe(false);
  });

  const coveredBot = {
    id: "bot-1",
    threadId: "t1",
    name: "Echo",
    title: "",
    description: "",
    notifications: true,
    color: "green",
    unread: true,
    modelSelection: { instanceId: "x", model: "y" },
    messages: [],
  } satisfies Bot;

  const coveredRoom = {
    id: "room-1",
    threadId: "room-thread",
    name: "Case Lab",
    memberIds: [],
    defaultResponder: { kind: "everyone" },
    bulletin: "",
    unread: true,
    createdAt: 1,
    messages: [],
  } satisfies Group;

  it("clears the badge when a workspace closes over the visible chat", () => {
    const open = { ...initialState, bots: [coveredBot], selectedId: "bot-1", workspaceOpen: true };
    expect(reducer(open, { type: "setWorkspaceOpen", open: false }).bots[0]?.unread).toBe(false);
    const away = { ...open, activeView: "routines" as const };
    expect(reducer(away, { type: "setWorkspaceOpen", open: false }).bots[0]?.unread).toBe(true);
    const room = { ...initialState, groups: [coveredRoom], selectedId: "room-1", workspaceOpen: true };
    expect(reducer(room, { type: "setWorkspaceOpen", open: false }).groups[0]?.unread).toBe(false);
  });

  it("keeps the badge when the covered conversation is reselected", () => {
    const open = { ...initialState, bots: [coveredBot], selectedId: "bot-1", workspaceOpen: true };
    expect(reducer(open, { type: "select", id: "bot-1" }).bots[0]?.unread).toBe(true);
    expect(reducer({ ...open, workspaceOpen: false }, { type: "select", id: "bot-1" }).bots[0]?.unread).toBe(false);
  });
});

describe("config status frames", () => {
  it("keeps the room turn timeout with the existing config fields", () => {
    expect(
      configStatusFromFrame({
        xai: { configured: true },
        gemini: { configured: true },
        composio: { configured: true, mode: "managed" },
        box: { configured: false },
        vps: { configured: true, sshAlias: "homelab" },
        rooms: { turnTimeoutMinutes: 20 },
        localVm: { mode: "per-bot", maxInstances: 3 },
        opencodeGo: { configured: true },
        tts: { configured: true, ready: true, voice: "Ada" },
        profile: { name: "Ian", email: "ian@example.test" },
        features: { skillRecorder: true },
      }),
    ).toEqual({
      xai: { configured: true },
      gemini: { configured: true },
      composio: { configured: true, mode: "managed" },
      box: { configured: false },
      vps: { configured: true, sshAlias: "homelab" },
      rooms: { turnTimeoutMinutes: 20 },
      localVm: { mode: "per-bot", maxInstances: 3 },
      opencodeGo: { configured: true },
      tts: { configured: true, ready: true, voice: "Ada" },
      profile: { name: "Ian", email: "ian@example.test" },
      features: { skillRecorder: true },
    });
  });
});

describe("task rename", () => {
  it("updates the task title in local state immediately", () => {
    const bot = {
      id: "echo",
      threadId: "t1",
      name: "Echo",
      title: "",
      description: "",
      notifications: true,
      color: "green",
      unread: false,
      modelSelection: { instanceId: "x", model: "y" },
      messages: [],
      tasks: [
        { threadId: "t1", title: "New task", createdAt: 1 },
        { threadId: "t2", title: "Other", createdAt: 2 },
      ],
    } satisfies Bot;
    const next = reducer(
      { ...initialState, bots: [bot] },
      { type: "renameTask", botId: bot.id, threadId: "t1", title: "Renamed" },
    );
    expect(next.bots[0]?.tasks?.find((task) => task.threadId === "t1")?.title).toBe("Renamed");
    expect(next.bots[0]?.tasks?.find((task) => task.threadId === "t2")?.title).toBe("Other");
  });

  it("updates a channel task title in local state immediately", () => {
    const group = {
      id: "room",
      threadId: "room-task-1",
      name: "Launch",
      memberIds: [],
      defaultResponder: { kind: "everyone" },
      bulletin: "",
      unread: false,
      createdAt: 1,
      messages: [],
      tasks: [
        { threadId: "room-task-1", title: "New task", createdAt: 1 },
        { threadId: "room-task-2", title: "Other", createdAt: 2 },
      ],
    } satisfies Group;
    const next = reducer(
      { ...initialState, groups: [group] },
      { type: "renameGroupTask", groupId: group.id, threadId: "room-task-1", title: "Renamed" },
    );
    expect(next.groups[0]?.tasks?.find((task) => task.threadId === "room-task-1")?.title).toBe("Renamed");
    expect(next.groups[0]?.tasks?.find((task) => task.threadId === "room-task-2")?.title).toBe("Other");
  });
});

describe("Teach a skill feature flag", () => {
  const config = configStatusFromFrame({
    composio: { configured: false },
    box: { configured: false },
    vps: { configured: false, sshAlias: "" },
    rooms: { turnTimeoutMinutes: 5 },
    localVm: { mode: "shared", maxInstances: 2 },
    features: { skillRecorder: true },
  });

  it("does not open the recorder while the experiment is disabled", () => {
    expect(reducer(initialState, { type: "showSkillRecorder" }).activeView).toBe("chat");
  });

  it("opens after opt-in and returns to chat when disabled", () => {
    const enabled = reducer({ ...initialState, config }, { type: "showSkillRecorder" });
    expect(enabled.activeView).toBe("skill-recorder");

    const disabled = reducer(enabled, {
      type: "configStatus",
      config: { ...config, features: { skillRecorder: false } },
    });
    expect(disabled.activeView).toBe("chat");
  });
});

describe("onboarding quiz", () => {
  const quizCard = {
    title: "What do you mostly want help with?",
    subtitle: "Pick whatever's closest; we can always expand from there.",
    options: ["Work & projects"],
  };
  const bot = {
    id: "echo",
    threadId: "t1",
    name: "Echo",
    title: "",
    description: "",
    notifications: true,
    color: "green",
    unread: false,
    modelSelection: { instanceId: "x", model: "y" },
    messages: [
      { id: "g", role: "bot", kind: "text", text: "Hey", at: 1 },
      { id: "q", role: "bot", kind: "options", card: quizCard, at: 2 },
    ],
    activeLeafId: "q",
  } satisfies Bot;

  it("hides the quiz as soon as the person sends a message", () => {
    const state = { ...initialState, bots: [bot], selectedId: bot.id };
    const next = reducer(state, { type: "send", botId: bot.id, text: "Hi bro" });
    expect(next.bots[0]?.messages.find((message) => message.id === "q")?.card?.dismissed).toBe(true);
  });

  it("hides the quiz when they pick an option", () => {
    const state = { ...initialState, bots: [bot], selectedId: bot.id };
    const next = reducer(state, { type: "answerCard", botId: bot.id, messageId: "q", answer: "Work & projects" });
    expect(next.bots[0]?.messages.find((message) => message.id === "q")?.card).toMatchObject({
      answered: "Work & projects",
      dismissed: true,
    });
  });

  it("hides the quiz when they ignore it", () => {
    const state = { ...initialState, bots: [bot], selectedId: bot.id };
    const next = reducer(state, { type: "dismissCard", botId: bot.id, messageId: "q" });
    expect(next.bots[0]?.messages.find((message) => message.id === "q")?.card?.dismissed).toBe(true);
  });

  it("leaves a live permission card in place", () => {
    const askBot: Bot = {
      ...bot,
      messages: [
        ...bot.messages,
        {
          id: "ask",
          role: "bot",
          kind: "options",
          card: {
            title: "Approval needed",
            subtitle: "rm",
            options: ["Allow", "Deny"],
            requestId: "r1",
            tool: "Bash",
          },
          at: 3,
        },
      ],
      activeLeafId: "ask",
    };
    const state = { ...initialState, bots: [askBot], selectedId: askBot.id };
    const next = reducer(state, { type: "send", botId: askBot.id, text: "ok" });
    expect(next.bots[0]?.messages.find((message) => message.id === "ask")?.card?.dismissed).toBeUndefined();
    expect(next.bots[0]?.messages.find((message) => message.id === "q")?.card?.dismissed).toBe(true);
  });
});

describe("cross-client bot creation", () => {
  it("adds an announced bot before its greeting frames arrive", () => {
    const announced = {
      id: "phone-bot",
      threadId: "phone-thread",
      name: "Scout",
      title: "",
      description: "",
      notifications: true,
      color: "green",
      unread: false,
      modelSelection: { instanceId: "codex", model: "default" },
    } satisfies Omit<Bot, "messages">;

    const added = reducer(initialState, { type: "botPatched", bot: announced });

    expect(added.bots).toEqual([{ ...announced, messages: [] }]);

    const greeting = {
      id: "greeting",
      role: "bot",
      kind: "text",
      text: "Hey — I'm Scout. Nice to meet you.",
      at: 2,
    } satisfies Message;
    const greeted = reducer(added, {
      type: "messageAdded",
      threadId: announced.threadId,
      message: greeting,
    });

    expect(greeted.bots[0]?.messages).toEqual([greeting]);
  });
});

describe("task recovery state", () => {
  it("folds a live task packet into only its owning task", () => {
    const bot = {
      id: "echo",
      threadId: "t1",
      name: "Echo",
      title: "",
      description: "",
      notifications: true,
      color: "green",
      unread: false,
      modelSelection: { instanceId: "x", model: "y" },
      messages: [],
      tasks: [
        { threadId: "t1", title: "Current", createdAt: 1 },
        { threadId: "t2", title: "Other", createdAt: 2 },
      ],
    } satisfies Bot;
    const packet = {
      v: 1,
      threadId: "t1",
      botId: bot.id,
      goal: "Publish the brief",
      plan: [{ step: "Verify citations", status: "active" }],
      completed: [],
      evidence: [],
      artifacts: [],
      blockers: [],
      nextAction: "Verify citations",
      updatedAt: 100,
      updatedBy: "harness",
      flushReason: "crash",
      turnsAtWrite: 2,
    } satisfies TaskResumePacket;

    const next = reducer({ ...initialState, bots: [bot] }, { type: "taskPacket", threadId: "t1", packet });

    expect(next.bots[0]?.tasks?.find((task) => task.threadId === "t1")?.taskState).toEqual(packet);
    expect(next.bots[0]?.tasks?.find((task) => task.threadId === "t2")?.taskState).toBeUndefined();
  });

  it("shows recovery after a stop flush once the bot goes idle", () => {
    const bot = {
      id: "echo",
      threadId: "t1",
      name: "Echo",
      title: "",
      description: "",
      notifications: true,
      color: "green",
      unread: false,
      busy: true,
      activity: "working",
      modelSelection: { instanceId: "x", model: "y" },
      messages: [],
      tasks: [{ threadId: "t1", title: "Current", createdAt: 1 }],
    } satisfies Bot;
    const packet = {
      v: 1,
      threadId: "t1",
      botId: bot.id,
      goal: "Publish the brief",
      plan: [{ step: "Verify citations", status: "active" }],
      completed: [],
      evidence: [],
      artifacts: [],
      blockers: [],
      nextAction: "Verify citations",
      updatedAt: 100,
      updatedBy: "harness",
      flushReason: "stop",
      turnsAtWrite: 2,
    } satisfies TaskResumePacket;

    const flushed = reducer({ ...initialState, bots: [bot] }, { type: "taskPacket", threadId: "t1", packet });
    const flushedBot = flushed.bots[0]!;
    expect(isTaskRecoveryVisible(flushedBot.tasks?.[0]?.taskState, flushedBot.busy)).toBe(false);

    const idle = reducer(flushed, {
      type: "botPatched",
      bot: { ...flushedBot, busy: false, activity: "idle" },
    });
    const idleBot = idle.bots[0]!;
    expect(isTaskRecoveryVisible(idleBot.tasks?.[0]?.taskState, idleBot.busy)).toBe(true);
    expect(idleBot.tasks?.[0]?.taskState?.flushReason).toBe("stop");
  });

  it("folds a room stop packet onto the channel task and shows recovery once idle", () => {
    const group = {
      id: "two-bots",
      threadId: "room-1",
      name: "Two bots",
      memberIds: ["echo"],
      defaultResponder: { kind: "everyone" as const },
      bulletin: "",
      unread: false,
      createdAt: 1,
      busyBotId: "echo",
      working: true,
      messages: [],
      tasks: [{ threadId: "room-1", title: "Current", createdAt: 1 }],
    } satisfies Group;
    const packet = {
      v: 1,
      threadId: "room-1",
      botId: "echo",
      goal: "Publish the brief",
      plan: [{ step: "Verify citations", status: "active" }],
      completed: [],
      evidence: [],
      artifacts: [],
      blockers: [],
      nextAction: "Verify citations",
      updatedAt: 100,
      updatedBy: "harness",
      flushReason: "stop",
      turnsAtWrite: 1,
    } satisfies TaskResumePacket;

    const flushed = reducer({ ...initialState, groups: [group] }, { type: "taskPacket", threadId: "room-1", packet });
    const flushedRoom = flushed.groups[0]!;
    expect(flushedRoom.tasks?.find((task) => task.threadId === "room-1")?.taskState).toEqual(packet);
    expect(flushedRoom.taskState).toEqual(packet);
    expect(isTaskRecoveryVisible(flushedRoom.taskState, Boolean(flushedRoom.busyBotId))).toBe(false);

    const idle = reducer(flushed, {
      type: "groupPatched",
      group: { id: group.id, busyBotId: null, working: false },
    });
    const idleRoom = idle.groups[0]!;
    expect(isTaskRecoveryVisible(idleRoom.taskState, Boolean(idleRoom.busyBotId))).toBe(true);
    expect(idleRoom.taskState?.flushReason).toBe("stop");
  });
});

describe("job-first bot creation", () => {
  it("opens the sheet and closes it when the created bot arrives", () => {
    const opened = reducer(initialState, { type: "newBot" });
    expect(opened.createBotOpen).toBe(true);

    const bot = {
      id: "briefing-bot",
      threadId: "briefing-thread",
      name: "Scout",
      title: "Weekly competitor brief",
      description: "Keep a weekly competitor brief.",
      notifications: true,
      color: "green",
      unread: false,
      modelSelection: { mode: "automatic", instanceId: "first", model: "default" },
      messages: [],
    } satisfies Bot;
    const added = reducer(opened, { type: "botAdded", bot, focusComposer: true });

    expect(added.createBotOpen).toBe(false);
    expect(added.selectedId).toBe(bot.id);
    expect(added.composerFocusBotId).toBe(bot.id);
    expect(reducer(added, { type: "composerFocused", botId: "another-bot" })).toBe(added);
    expect(reducer(added, { type: "composerFocused", botId: bot.id }).composerFocusBotId).toBeNull();
    expect(reducer(opened, { type: "botAdded", bot }).composerFocusBotId).toBeNull();
  });

  it("allows a later create sheet to be cancelled", () => {
    expect(reducer({ ...initialState, createBotOpen: true }, { type: "closeCreateBot" }).createBotOpen).toBe(false);
  });
});

describe("canonical message races", () => {
  it("does not rewind the active branch when POST repeats a user message after the reply", () => {
    const sent = {
      id: "sent",
      role: "user",
      kind: "text",
      text: "Ship it",
      at: 1,
      parentId: null,
    } satisfies Message;
    const reply = {
      id: "reply",
      role: "bot",
      kind: "text",
      text: "Done",
      at: 2,
      parentId: sent.id,
    } satisfies Message;
    const bot = {
      id: "race-bot",
      threadId: "race-thread",
      name: "Race",
      title: "",
      description: "",
      notifications: true,
      color: "green",
      unread: false,
      modelSelection: { instanceId: "codex", model: "default" },
      messages: [sent, reply],
      activeLeafId: reply.id,
    } satisfies Bot;
    const state = { ...initialState, bots: [bot] };

    const next = reducer(state, {
      type: "messageAdded",
      threadId: bot.threadId,
      message: sent,
    });

    expect(next).toBe(state);
    expect(next.bots[0]?.activeLeafId).toBe(reply.id);
    expect(next.bots[0]?.messages).toEqual([sent, reply]);
  });
});

describe("section Chiefs", () => {
  const bot = (id: string, section: string, chiefOfStaff = false) => ({
    id,
    threadId: `thread-${id}`,
    name: id,
    title: "",
    description: "",
    notifications: true,
    color: "green" as const,
    unread: false,
    modelSelection: { instanceId: "codex", model: "default" },
    section,
    chiefOfStaff,
  });

  it("hands off only within the patched bot's section", () => {
    const workChief = bot("work-a", "Work", true);
    const workCandidate = bot("work-b", "Work");
    const personalChief = bot("personal", "Personal", true);
    const state = {
      ...initialState,
      bots: [workChief, workCandidate, personalChief].map((candidate) => ({ ...candidate, messages: [] })),
    };

    const next = reducer(state, {
      type: "botPatched",
      bot: { ...workCandidate, chiefOfStaff: true },
    });

    expect(next.bots.find((candidate) => candidate.id === workChief.id)?.chiefOfStaff).toBe(false);
    expect(next.bots.find((candidate) => candidate.id === workCandidate.id)?.chiefOfStaff).toBe(true);
    expect(next.bots.find((candidate) => candidate.id === personalChief.id)?.chiefOfStaff).toBe(true);
  });

  it("keeps other section Chiefs during an optimistic settings update", () => {
    const workChief = bot("work-a", "Work", true);
    const workCandidate = bot("work-b", "Work");
    const personalChief = bot("personal", "Personal", true);
    const state = {
      ...initialState,
      bots: [workChief, workCandidate, personalChief].map((candidate) => ({ ...candidate, messages: [] })),
    };

    const next = reducer(state, {
      type: "updateBot",
      botId: workCandidate.id,
      patch: { chiefOfStaff: true },
    });

    expect(next.bots.find((candidate) => candidate.id === workChief.id)?.chiefOfStaff).toBe(false);
    expect(next.bots.find((candidate) => candidate.id === workCandidate.id)?.chiefOfStaff).toBe(true);
    expect(next.bots.find((candidate) => candidate.id === personalChief.id)?.chiefOfStaff).toBe(true);
  });
});

describe("pending queued chip", () => {
  const bot = {
    id: "b1",
    threadId: "t1",
    name: "Ada",
    title: "",
    description: "",
    notifications: false,
    color: "green",
    unread: false,
    modelSelection: { instanceId: "acp", model: "fake" },
  } satisfies Omit<Bot, "messages">;

  it("records queue-fallback text and drops it when that user line lands", () => {
    const withBot = reducer(initialState, { type: "botPatched", bot });
    const queued = reducer(withBot, {
      type: "pendingQueued",
      threadId: "t1",
      queueId: "q1",
      text: "later",
    });
    expect(queued.pendingQueued).toEqual({ t1: [{ queueId: "q1", text: "later" }] });
    const landed = reducer(queued, {
      type: "consumePendingQueued",
      threadId: "t1",
      queueId: "q1",
    });
    expect(landed.pendingQueued).toEqual({});
  });

  it("keeps a Shift+Enter multiline message as one entry", () => {
    const withBot = reducer(initialState, { type: "botPatched", bot });
    const queued = reducer(withBot, {
      type: "pendingQueued",
      threadId: "t1",
      queueId: "q-ml",
      text: "line one\nline two",
    });
    expect(queued.pendingQueued).toEqual({ t1: [{ queueId: "q-ml", text: "line one\nline two" }] });
    const landed = reducer(queued, {
      type: "consumePendingQueued",
      threadId: "t1",
      queueId: "q-ml",
    });
    expect(landed.pendingQueued).toEqual({});
  });

  it("leaves the chip on the old thread after a task switch", () => {
    const withBot = reducer(initialState, { type: "botPatched", bot });
    const queued = reducer(withBot, {
      type: "pendingQueued",
      threadId: "t1",
      queueId: "q-stay",
      text: "stay here",
    });
    const switched = reducer(queued, {
      type: "botPatched",
      bot: { ...bot, threadId: "t2", messages: [] },
    });
    expect(switched.pendingQueued).toEqual({ t1: [{ queueId: "q-stay", text: "stay here" }] });
    expect(switched.pendingQueued[switched.bots[0]!.threadId]).toBeUndefined();
    const drained = reducer(switched, {
      type: "consumePendingQueued",
      threadId: "t1",
      queueId: "q-stay",
    });
    expect(drained.pendingQueued).toEqual({});
  });

  it("consumes only the matching queue id when two pending lines share text", () => {
    const withBot = reducer(initialState, { type: "botPatched", bot });
    const first = reducer(withBot, {
      type: "pendingQueued",
      threadId: "t1",
      queueId: "qa",
      text: "same",
    });
    const both = reducer(first, {
      type: "pendingQueued",
      threadId: "t1",
      queueId: "qb",
      text: "same",
    });
    expect(both.pendingQueued).toEqual({
      t1: [
        { queueId: "qa", text: "same" },
        { queueId: "qb", text: "same" },
      ],
    });
    const afterOther = reducer(both, {
      type: "consumePendingQueued",
      threadId: "t1",
      queueId: "qa",
    });
    expect(afterOther.pendingQueued).toEqual({ t1: [{ queueId: "qb", text: "same" }] });
  });

  it("does not add a chip when the drain frame arrives before the POST continuation", () => {
    const withBot = reducer(initialState, { type: "botPatched", bot });
    const drained = reducer(withBot, {
      type: "consumePendingQueued",
      threadId: "t1",
      queueId: "q1",
    });
    expect(drained.pendingQueued).toEqual({});
    const late = reducer(drained, {
      type: "pendingQueued",
      threadId: "t1",
      queueId: "q1",
      text: "later",
    });
    expect(late.pendingQueued).toEqual({});
    expect(late.consumedQueueIds).toEqual({});
  });

  it("reconciles a missed drain from hydration and rejects its late POST continuation", () => {
    const withBot = reducer(initialState, { type: "botPatched", bot });
    const queued = reducer(withBot, {
      type: "pendingQueued",
      threadId: "t1",
      queueId: "q-snapshot",
      text: "already ran",
    });
    const canonical = {
      id: "m-snapshot",
      at: 100,
      role: "user",
      kind: "text",
      text: "already ran",
      queueId: "q-snapshot",
    } satisfies Message;
    const hydrated = reducer(queued, {
      type: "hydrate",
      bots: [{ ...bot, messages: [canonical] }],
      groups: [],
      computerControl: {},
    });

    expect(hydrated.pendingQueued).toEqual({});
    expect(hydrated.consumedQueueIds["q-snapshot"]).toBe(true);
    const late = reducer(hydrated, {
      type: "pendingQueued",
      threadId: "t1",
      queueId: "q-snapshot",
      text: "already ran",
    });
    expect(late.pendingQueued).toEqual({});
    expect(late.consumedQueueIds["q-snapshot"]).toBeUndefined();
  });

  it("bounds unmatched queue tombstones from other clients", () => {
    const withBot = reducer(initialState, { type: "botPatched", bot });
    let state = withBot;
    for (let index = 0; index < 100; index += 1) {
      state = reducer(state, {
        type: "consumePendingQueued",
        threadId: "t1",
        queueId: `foreign-${index}`,
      });
    }

    expect(Object.keys(state.consumedQueueIds)).toHaveLength(64);
    expect(state.consumedQueueIds["foreign-0"]).toBeUndefined();
    expect(state.consumedQueueIds["foreign-99"]).toBe(true);

    const late = reducer(state, {
      type: "pendingQueued",
      threadId: "t1",
      queueId: "foreign-99",
      text: "already drained",
    });
    expect(late.pendingQueued).toEqual({});
    expect(late.consumedQueueIds["foreign-99"]).toBeUndefined();
  });

  it("drops a cancelled pending chip without waiting for drain", () => {
    const withBot = reducer(initialState, { type: "botPatched", bot });
    const queued = reducer(withBot, {
      type: "pendingQueued",
      threadId: "t1",
      queueId: "q-drop",
      text: "never mind",
    });
    const cancelled = reducer(queued, {
      type: "cancelQueued",
      botId: "b1",
      queueId: "q-drop",
    });
    expect(cancelled.pendingQueued).toEqual({});
  });
});

describe("accepted send chrome", () => {
  const idleBot = {
    id: "echo",
    threadId: "t1",
    name: "Echo",
    title: "",
    description: "",
    notifications: true,
    color: "green",
    unread: false,
    modelSelection: { instanceId: "x", model: "y" },
    messages: [{ id: "a1", role: "bot", kind: "text", text: "done", at: 1 }],
    activeLeafId: "a1",
  } satisfies Bot;

  it("paints Thinking even when the action omits sendId", () => {
    const next = reducer({ ...initialState, bots: [idleBot] }, { type: "send", botId: idleBot.id, text: "Hi" });
    expect(
      turnPresenceWaiting({
        busy: next.bots[0]?.busy,
        lastMessage: next.bots[0]?.messages.at(-1),
        accepted: next.acceptedSends[idleBot.threadId],
      }),
    ).toBe(true);
  });

  it("paints Thinking in the same reducer turn as an accepted idle send", () => {
    const next = reducer(
      { ...initialState, bots: [idleBot] },
      { type: "send", botId: idleBot.id, text: "Hi", sendId: "s1" },
    );
    const bot = next.bots[0]!;
    expect(
      turnPresenceWaiting({
        busy: bot.busy,
        activity: bot.activity,
        lastMessage: bot.messages.at(-1),
        accepted: next.acceptedSends[bot.threadId],
      }),
    ).toBe(true);
    expect(bot.busy).toBe(true);
  });

  it("surfaces Sends-next for a busy follow-up before the POST queueId arrives", () => {
    const busyBot = { ...idleBot, busy: true, activity: "working" as const };
    const next = reducer(
      { ...initialState, bots: [busyBot] },
      { type: "send", botId: busyBot.id, text: "and then", sendId: "s2" },
    );
    expect(visibleSteerEntries(next.pendingQueued, busyBot.threadId, next.acceptedSends[busyBot.threadId])).toEqual([
      { queueId: "s2", text: "and then" },
    ]);
    expect(
      turnPresenceWaiting({
        busy: next.bots[0]?.busy,
        lastMessage: next.bots[0]?.messages.at(-1),
        accepted: next.acceptedSends[busyBot.threadId],
      }),
    ).toBe(false);
  });

  it("keeps Thinking through a stale idle bot patch until the send is rejected", () => {
    const sent = reducer(
      { ...initialState, bots: [idleBot] },
      { type: "send", botId: idleBot.id, text: "Hi", sendId: "s1" },
    );
    const stale = reducer(sent, {
      type: "botPatched",
      bot: { ...idleBot, busy: false, activity: "idle" },
    });
    expect(
      turnPresenceWaiting({
        busy: stale.bots[0]?.busy,
        activity: stale.bots[0]?.activity,
        lastMessage: stale.bots[0]?.messages.at(-1),
        accepted: stale.acceptedSends[idleBot.threadId],
      }),
    ).toBe(true);

    const rejected = reducer(stale, {
      type: "sendRejected",
      botId: idleBot.id,
      threadId: idleBot.threadId,
      sendId: "s1",
    });
    expect(rejected.acceptedSends[idleBot.threadId]).toBeUndefined();
    expect(rejected.bots[0]?.busy).toBeFalsy();
    expect(
      turnPresenceWaiting({
        busy: rejected.bots[0]?.busy,
        lastMessage: rejected.bots[0]?.messages.at(-1),
        accepted: rejected.acceptedSends[idleBot.threadId],
      }),
    ).toBe(false);
  });

  it("keeps Thinking after POST settle until the server flips busy", () => {
    const sent = reducer(
      { ...initialState, bots: [idleBot] },
      { type: "send", botId: idleBot.id, text: "Hi", sendId: "s1" },
    );
    const settled = reducer(sent, { type: "sendSettled", threadId: idleBot.threadId, sendId: "s1" });
    expect(
      turnPresenceWaiting({
        busy: settled.bots[0]?.busy,
        lastMessage: settled.bots[0]?.messages.at(-1),
        accepted: settled.acceptedSends[idleBot.threadId],
      }),
    ).toBe(true);

    const confirmed = reducer(settled, {
      type: "botPatched",
      bot: { ...idleBot, busy: true, activity: "working" },
    });
    expect(confirmed.acceptedSends[idleBot.threadId]).toBeUndefined();
    expect(confirmed.bots[0]?.busy).toBe(true);
  });

  it("drops Thinking on an idle hydrate snapshot so chrome cannot stay locked", () => {
    const sent = reducer(
      { ...initialState, bots: [idleBot] },
      { type: "send", botId: idleBot.id, text: "Hi", sendId: "s1" },
    );
    const hydrated = reducer(sent, {
      type: "hydrate",
      bots: [idleBot],
      groups: [],
      computerControl: {},
    });
    expect(hydrated.acceptedSends[idleBot.threadId]).toBeUndefined();
    expect(hydrated.bots[0]?.busy).toBeFalsy();
  });

  it("keeps a Sends-next chip through Stop", () => {
    const busyBot = { ...idleBot, busy: true, activity: "working" as const };
    const queued = reducer(
      { ...initialState, bots: [busyBot] },
      { type: "send", botId: busyBot.id, text: "and then", sendId: "s2" },
    );
    const stopped = reducer(queued, { type: "interrupt", botId: busyBot.id });
    expect(visibleSteerEntries(stopped.pendingQueued, busyBot.threadId, stopped.acceptedSends[busyBot.threadId])).toEqual([
      { queueId: "s2", text: "and then" },
    ]);
  });

  it("forgets a cancelled Sends-next chip", () => {
    const busyBot = { ...idleBot, busy: true, activity: "working" as const };
    const queued = reducer(
      { ...initialState, bots: [busyBot] },
      { type: "send", botId: busyBot.id, text: "and then", sendId: "s2" },
    );
    const rejected = reducer(queued, {
      type: "sendRejected",
      botId: busyBot.id,
      threadId: busyBot.threadId,
      sendId: "s2",
    });
    expect(visibleSteerEntries(rejected.pendingQueued, busyBot.threadId, rejected.acceptedSends[busyBot.threadId])).toEqual(
      [],
    );
  });

  it("clears optimistic Thinking and busy on Stop", () => {
    const sent = reducer(
      { ...initialState, bots: [idleBot] },
      { type: "send", botId: idleBot.id, text: "Hi", sendId: "s1" },
    );
    const stopped = reducer(sent, { type: "interrupt", botId: idleBot.id });
    expect(stopped.acceptedSends[idleBot.threadId]).toBeUndefined();
    expect(stopped.bots[0]?.busy).toBeFalsy();
    expect(
      turnPresenceWaiting({
        busy: stopped.bots[0]?.busy,
        lastMessage: stopped.bots[0]?.messages.at(-1),
        accepted: stopped.acceptedSends[idleBot.threadId],
      }),
    ).toBe(false);
  });

  it("paints room Thinking on sendGroup before busyBotId arrives", () => {
    const room = {
      id: "r1",
      threadId: "gt1",
      name: "Launch",
      memberIds: ["echo"],
      defaultResponder: { kind: "member" as const, botId: "echo" },
      bulletin: "",
      unread: false,
      createdAt: 1,
      messages: [{ id: "a1", role: "bot" as const, kind: "text" as const, text: "done", at: 1 }],
    } satisfies Group;
    const withoutId = reducer(
      { ...initialState, bots: [idleBot], groups: [room] },
      { type: "sendGroup", groupId: room.id, text: "go" },
    );
    expect(
      turnPresenceWaiting({
        lastMessage: withoutId.groups[0]?.messages.at(-1),
        accepted: withoutId.acceptedSends[room.threadId],
      }),
    ).toBe(true);

    const next = reducer(
      { ...initialState, bots: [idleBot], groups: [room] },
      { type: "sendGroup", groupId: room.id, text: "go", sendId: "g1" },
    );
    expect(
      turnPresenceWaiting({
        lastMessage: next.groups[0]?.messages.at(-1),
        accepted: next.acceptedSends[room.threadId],
      }),
    ).toBe(true);

    const settled = reducer(next, { type: "sendSettled", threadId: room.threadId, sendId: "g1" });
    expect(
      turnPresenceWaiting({
        lastMessage: settled.groups[0]?.messages.at(-1),
        accepted: settled.acceptedSends[room.threadId],
      }),
    ).toBe(true);
  });
});

describe("resumeTask settle", () => {
  it("uses independent then branches so onSettled cannot run twice", async () => {
    const { readFileSync } = await import("node:fs");
    const store = readFileSync(new URL("./store.tsx", import.meta.url), "utf8");
    expect(store).toMatch(/done\.then\(\s*\(\) => action\.onSettled!\(null\),\s*\(error\) =>/);
    expect(store).not.toMatch(/onSettled!\(null\)\)\.catch\(/);
  });
});
