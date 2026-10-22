import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  cancelQueuedSends,
  drainSteeredMessages,
  isSendCancelled,
  queueRoomParticipation,
  queueSteeredMessage,
  withQueuedSend,
  _queuedCount,
  _resetSteerQueue,
  type SteerStore,
} from "./steer-queue.ts";
import type { BotRecord, Message } from "./store.ts";

function fakeBot(id: string, threadId: string): BotRecord {
  return {
    id,
    threadId,
    name: id,
    title: "",
    description: "",
    notifications: false,
    color: "green",
    unread: false,
    modelSelection: { instanceId: "fake", model: "fake-model" },
    resumeCursors: {},
    busy: true,
    createdAt: 0,
  };
}

function fakeStore(bots: BotRecord[]): SteerStore & { messages: Message[] } {
  const messages: Message[] = [];
  return {
    messages,
    bot: (id) => bots.find((b) => b.id === id) ?? null,
    appendMessage: (threadId, message) => {
      const full: Message = { id: `m${messages.length + 1}-${threadId}`, at: Date.now(), ...message };
      messages.push(full);
      return full;
    },
    patchMessage: () => null,
  };
}

describe("user stop on queued sends", () => {
  afterEach(() => {
    _resetSteerQueue();
  });

  it("cancels every waiting send instead of draining it and returns them in order", () => {
    const bot = fakeBot("stop-bot", "stop-thread");
    const store = fakeStore([bot]);
    const first = queueSteeredMessage(bot.id, bot.threadId, "first", { sendId: "send_first_0000000000" });
    const second = queueSteeredMessage(bot.id, "stop-side-task", "second");
    const third = queueSteeredMessage(bot.id, bot.threadId, "third", { sendId: "send_third_0000000000", after: true });

    expect(cancelQueuedSends(bot.id)).toEqual([
      { threadId: "stop-thread", queueId: first.id, sendId: "send_first_0000000000", text: "first" },
      { threadId: "stop-side-task", queueId: second.id, sendId: undefined, text: "second" },
      { threadId: "stop-thread", queueId: third.id, sendId: "send_third_0000000000", text: "third" },
    ]);
    bot.busy = false;
    const run = vi.fn();
    drainSteeredMessages(store, run);
    expect(run).not.toHaveBeenCalled();
    expect(store.messages).toEqual([]);
    expect(cancelQueuedSends(bot.id)).toEqual([]);
  });

  it("keeps a late retry of a returned send from queueing again", () => {
    const bot = fakeBot("late-bot", "late-thread");
    queueSteeredMessage(bot.id, bot.threadId, "late", { sendId: "send_late_00000000000" });
    cancelQueuedSends(bot.id);
    expect(queueSteeredMessage(bot.id, bot.threadId, "late", { sendId: "send_late_00000000000" })).toMatchObject({
      skipped: true,
      cancelled: true,
    });
  });

  it("hands back a Send now still in flight so it cannot start after Stop", async () => {
    const bot = fakeBot("now-bot", "now-thread");
    const queued = queueSteeredMessage(bot.id, bot.threadId, "now", { sendId: "send_now_000000000000" });
    let steered!: () => void;
    const steer = new Promise<void>((resolve) => { steered = resolve; });
    const promotion = withQueuedSend(bot.id, bot.threadId, queued.id, "send_now_000000000000", async () => {
      await steer;
      return isSendCancelled("send_now_000000000000")
        ? { ok: true as const, cancelled: true as const }
        : { ok: true as const, started: true as const };
    });
    expect(cancelQueuedSends(bot.id)).toEqual([
      { threadId: bot.threadId, queueId: queued.id, sendId: "send_now_000000000000", text: "now" },
    ]);
    steered();
    await expect(promotion).resolves.toEqual({ ok: true, cancelled: true });
    expect(_queuedCount(bot.threadId)).toBe(0);
  });

  it("leaves other bots and room waits alone", () => {
    const bot = fakeBot("own-bot", "own-thread");
    queueSteeredMessage("other-bot", "other-thread", "theirs");
    queueRoomParticipation(bot.id, "room-thread", { groupId: "room" });
    queueSteeredMessage(bot.id, bot.threadId, "mine");
    expect(cancelQueuedSends(bot.id).map((send) => send.text)).toEqual(["mine"]);
    expect(_queuedCount("other-thread")).toBe(1);
    expect(_queuedCount("room-thread")).toBe(1);
  });

  it("is what the bot Stop route does before it releases the bot", () => {
    const source = readFileSync(new URL("./index.ts", import.meta.url), "utf8");
    const route = source.slice(source.indexOf("/^\\/api\\/bots\\/([\\w-]+)\\/interrupt$/"), source.indexOf("// ── tasks: a bot's separate contexts"));
    const [routine, turn] = route.split("const instance = registry.get(bot.modelSelection.instanceId);");
    for (const branch of [routine!, turn!]) {
      const cancel = branch.indexOf("const returned = cancelQueuedSends(bot.id);");
      expect(cancel).toBeGreaterThan(-1);
      expect(branch.indexOf("releaseInterruptedBot(")).toBeGreaterThan(cancel);
      expect(branch).toContain("return json(res, 200, { ok: true, returned });");
    }
  });
});
