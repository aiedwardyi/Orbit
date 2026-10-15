import { afterEach, describe, expect, it, vi } from "vitest";

import { steersSend } from "./send-deliver.ts";
import { _resetSteerQueue, drainSteeredMessages, foldQueuedSends, queueMark, queueSteeredMessage } from "./steer-queue.ts";
import type { BotRecord, Message } from "./store.ts";

afterEach(_resetSteerQueue);

const steering = { capabilities: { queueing: true }, steer: async () => true };

describe("steersSend", () => {
  it("keeps after-turn sends through both preparation folds and drains them once", () => {
    const bot = { id: "bot", threadId: "thread", busy: true } as BotRecord;
    const messages: Message[] = [];
    const store = {
      bot: () => bot,
      appendMessage: (_threadId: string, message: Omit<Message, "id" | "at">) => {
        const saved = { ...message, id: `m${messages.length}`, at: 1 };
        messages.push(saved);
        return saved;
      },
      patchMessage: () => null,
    };
    const claim = queueMark();
    queueSteeredMessage(bot.id, bot.threadId, "later", { after: true });
    queueSteeredMessage(bot.id, bot.threadId, "first");
    expect(foldQueuedSends(store, bot.id, bot.threadId, claim)).toEqual(["first"]);
    queueSteeredMessage(bot.id, bot.threadId, "second");
    expect(foldQueuedSends(store, bot.id, bot.threadId, claim)).toEqual(["second"]);
    expect(messages.map((message) => message.text)).toEqual(["first", "second"]);
    const run = vi.fn();
    drainSteeredMessages(store, run);
    expect(run).not.toHaveBeenCalled();
    bot.busy = false;
    drainSteeredMessages(store, run);
    drainSteeredMessages(store, run);
    expect(run).toHaveBeenCalledTimes(1);
    expect(messages.map((message) => message.text)).toEqual(["first", "second", "later"]);
    expect(messages[2].steered).toBeUndefined();
  });

  it("steers a busy steering engine as before", () => {
    expect(steersSend(steering, true, false)).toBe(true);
  });

  it("leaves an after-this-turn send to the queue", () => {
    expect(steersSend(steering, true, true)).toBe(false);
  });

  it("never steers an idle bot", () => {
    expect(steersSend(steering, false, false)).toBe(false);
  });

  it("never steers an engine that cannot", () => {
    expect(steersSend({ capabilities: { queueing: false }, steer: steering.steer }, true, false)).toBe(false);
    expect(steersSend({ capabilities: { queueing: true } }, true, false)).toBe(false);
    expect(steersSend(undefined, true, false)).toBe(false);
  });
});
