// Continuation turns: an idle bot adopts one like a user-sent turn, and a
// send that arrives meanwhile waits in the queue until it settles.
import { afterEach, describe, expect, it, vi } from "vitest";

import { foldContinuationStart, type ContinuationDeps } from "./continuation-turn.ts";
import { drainSteeredMessages, queueSteeredMessage, _queuedCount, _resetSteerQueue, type SteerStore } from "./steer-queue.ts";
import type { BotRecord, Message } from "./store.ts";
import { TurnWatchdog } from "./turn-watchdog.ts";

function fakeBot(busy = false): BotRecord {
  return {
    id: "bot-a",
    threadId: "thread-a",
    name: "bot-a",
    title: "",
    description: "",
    notifications: false,
    color: "green",
    unread: false,
    modelSelection: { instanceId: "fake", model: "fake-model" },
    resumeCursors: {},
    busy,
    createdAt: 0,
  };
}

function rig(bot: BotRecord, claimed = false) {
  const watchdog = new TurnWatchdog({ stallMs: 10_000, toolCapMs: 30_000, checkMs: 60_000, onStall: () => {} });
  const disowned: string[] = [];
  const deps: ContinuationDeps = {
    botByThread: (threadId) => (threadId === bot.threadId ? bot : null),
    claimed: () => claimed,
    adopt: (botId, threadId) => {
      bot.busy = true;
      bot.activeThreadId = threadId;
      watchdog.watch(threadId, botId);
    },
    disown: (turnId) => disowned.push(turnId),
  };
  return { watchdog, disowned, deps };
}

describe("foldContinuationStart", () => {
  afterEach(() => _resetSteerQueue());

  it("marks an idle bot busy and watches the thread", () => {
    const bot = fakeBot();
    const { watchdog, deps } = rig(bot);
    expect(foldContinuationStart({ threadId: "thread-a", turnId: "turn-late" }, deps)).toBe("adopted");
    expect(bot.busy).toBe(true);
    expect(bot.activeThreadId).toBe("thread-a");
    expect(watchdog.watching("thread-a")).toBe(true);
  });

  it("leaves a turn the harness dispatched alone", () => {
    const bot = { ...fakeBot(true), activeThreadId: "thread-a" };
    const { watchdog, disowned, deps } = rig(bot);
    expect(foldContinuationStart({ threadId: "thread-a", turnId: "turn-1" }, deps)).toBe("owned");
    expect(watchdog.watching("thread-a")).toBe(false);
    expect(disowned).toEqual([]);
  });

  it("disowns a continuation while the bot works another thread or holds a claim", () => {
    const busyElsewhere = { ...fakeBot(true), activeThreadId: "thread-b" };
    const first = rig(busyElsewhere);
    expect(foldContinuationStart({ threadId: "thread-a", turnId: "turn-late" }, first.deps)).toBe("disowned");
    expect(first.disowned).toEqual(["turn-late"]);
    expect(busyElsewhere.activeThreadId).toBe("thread-b");

    const second = rig(fakeBot(), true);
    expect(foldContinuationStart({ threadId: "thread-a", turnId: "turn-late" }, second.deps)).toBe("disowned");
  });

  it("ignores room and unknown threads", () => {
    const { deps } = rig(fakeBot());
    expect(foldContinuationStart({ threadId: "room-1", turnId: "turn-late" }, deps)).toBe("ignored");
  });

  it("holds a user send until the continuation settles", () => {
    const bot = fakeBot();
    const { deps } = rig(bot);
    const messages: Message[] = [];
    const store: SteerStore = {
      bot: (id) => (id === bot.id ? bot : null),
      appendMessage: (threadId, message) => {
        const full: Message = { id: `m${messages.length + 1}-${threadId}`, at: 0, ...message };
        messages.push(full);
        return full;
      },
      patchMessage: () => null,
    };
    foldContinuationStart({ threadId: "thread-a", turnId: "turn-late" }, deps);
    queueSteeredMessage(bot.id, bot.threadId, "next step");
    const run = vi.fn();

    drainSteeredMessages(store, run);
    expect(run).not.toHaveBeenCalled();
    expect(_queuedCount("thread-a")).toBe(1);

    // turn.completed folds the bot idle before the drain subscriber runs
    bot.busy = false;
    drainSteeredMessages(store, run);
    expect(run).toHaveBeenCalledTimes(1);
    expect(messages[0]).toMatchObject({ role: "user", text: "next step" });
  });
});
