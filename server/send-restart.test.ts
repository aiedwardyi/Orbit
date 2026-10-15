import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

let dir: string;
let closeDb = () => {};

async function boot() {
  closeDb();
  vi.resetModules();
  const { Store } = await import("./store.ts");
  const queue = await import("./steer-queue.ts");
  ({ closeMessageDb: closeDb } = await import("./message-db.ts"));
  const store = new Store(() => ({ instanceId: "fake", model: "fake" }));
  queue.initializeSteerQueue?.(store);
  return { queue, store };
}

function savedQueue() {
  return JSON.parse(readFileSync(join(dir, "queued-sends.json"), "utf8"));
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "orbit-send-restart-"));
  vi.stubEnv("OMB_DATA_DIR", dir);
});

afterEach(() => {
  closeDb();
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  rmSync(dir, { recursive: true, force: true });
});

describe("waiting sends across restart", () => {
  it.each([false, true])("persists the receipt and delivery mode before returning, after=%s", async (after) => {
    const { queue, store } = await boot();
    const bot = store.createBot();
    const receipt = queue.queueSteeredMessage(bot.id, bot.threadId, "다음에 요약해 줘", {
      after, sendId: "restart-send-000001", replyToId: "reply", prompt: "prompt with reply",
    });
    expect(savedQueue()).toMatchObject([{
      botId: bot.id, threadId: bot.threadId,
      items: [{ messageId: receipt.id, text: "다음에 요약해 줘", after, sendId: "restart-send-000001", replyToId: "reply", prompt: "prompt with reply" }],
    }]);
    const restarted = await boot();
    expect(restarted.queue.queuedSteeredMessage(bot.id, bot.threadId, "restart-send-000001")).toEqual({
      id: receipt.id, text: "다음에 요약해 줘", replyToId: "reply",
    });
  });

  it("drains a restored after-turn send once when idle", async () => {
    const { queue, store } = await boot();
    const bot = store.createBot();
    store.patchBot(bot.id, { busy: true });
    const receipt = queue.queueSteeredMessage(bot.id, bot.threadId, "later", {
      after: true, sendId: "restart-send-000002", prompt: "later prompt",
    });
    const restarted = await boot();
    expect(restarted.store.bot(bot.id)?.busy).toBe(false);
    expect(restarted.queue._queuedCount(bot.threadId)).toBe(1);
    const run = vi.fn();
    restarted.queue.drainSteeredMessages(restarted.store, run);
    restarted.queue.drainSteeredMessages(restarted.store, run);
    expect(run).toHaveBeenCalledTimes(1);
    expect(run).toHaveBeenCalledWith(bot.id, bot.threadId, "later prompt", expect.objectContaining({ queueId: receipt.id }), [expect.any(String)]);
    const again = await boot();
    again.queue.drainSteeredMessages(again.store, run);
    expect(run).toHaveBeenCalledTimes(1);
    expect(again.store.messagesFor(bot.threadId).filter((message) => message.role === "user")).toMatchObject([{ text: "later", sendId: "restart-send-000002" }]);
    expect(savedQueue()).toEqual([]);
  });

  it("keeps per-thread FIFO and sequence marks across threads and another enqueue", async () => {
    const { queue, store } = await boot();
    const bot = store.createBot();
    const threadId = bot.threadId;
    queue.queueSteeredMessage(bot.id, threadId, "first", { after: true });
    queue.queueSteeredMessage(bot.id, threadId, "second");
    store.createTask(bot.id);
    queue.queueSteeredMessage(bot.id, bot.threadId, "third", { after: true });
    const mark = queue.queueMark();
    const restarted = await boot();
    expect(restarted.queue.queueMark()).toBe(mark);
    expect(restarted.queue.hasQueuedSendBefore(bot.id, mark)).toBe(true);
    restarted.queue.queueSteeredMessage(bot.id, bot.threadId, "fourth");
    expect(restarted.queue.queueMark()).toBeGreaterThan(mark);
    const run = vi.fn();
    for (let i = 0; i < 4; i++) restarted.queue.drainSteeredMessages(restarted.store, run);
    expect(run.mock.calls.map((call) => call[2])).toEqual(["first", "third", "second", "fourth"]);
  });

  it.each(["sendId", "queueId"] as const)("drops an already appended item by %s on boot", async (identity) => {
    const { queue, store } = await boot();
    const bot = store.createBot();
    const sendId = identity === "sendId" ? "restart-send-000003" : undefined;
    const receipt = queue.queueSteeredMessage(bot.id, bot.threadId, "already saved", { after: true, sendId });
    store.appendMessage(bot.threadId, {
      role: "user", kind: "text", text: "already saved",
      ...(identity === "sendId" ? { sendId } : { queueId: receipt.id }),
    });
    const restarted = await boot();
    expect(restarted.queue._queuedCount(bot.threadId)).toBe(0);
    expect(savedQueue()).toEqual([]);
    const run = vi.fn();
    restarted.queue.drainSteeredMessages(restarted.store, run);
    expect(run).not.toHaveBeenCalled();
    expect(restarted.store.messagesFor(bot.threadId).filter((message) => message.role === "user")).toHaveLength(1);
  });

  it("keeps after-turn mode through restart and both preparation folds", async () => {
    const { queue, store } = await boot();
    const bot = store.createBot();
    queue.queueSteeredMessage(bot.id, bot.threadId, "after", { after: true });
    const restarted = await boot();
    expect(restarted.queue._queuedCount(bot.threadId)).toBe(1);
    const claim = restarted.queue.queueMark();
    restarted.queue.queueSteeredMessage(bot.id, bot.threadId, "first");
    expect(restarted.queue.foldQueuedSends(restarted.store, bot.id, bot.threadId, claim)).toEqual([]);
    const run = vi.fn();
    restarted.queue.drainSteeredMessages(restarted.store, run);
    const nextClaim = restarted.queue.queueMark();
    restarted.queue.queueSteeredMessage(bot.id, bot.threadId, "second");
    expect(restarted.queue.foldQueuedSends(restarted.store, bot.id, bot.threadId, nextClaim)).toEqual([]);
    const again = await boot();
    expect(again.queue._queuedCount(bot.threadId)).toBe(2);
    again.queue.drainSteeredMessages(again.store, run);
    again.queue.drainSteeredMessages(again.store, run);
    expect(run.mock.calls.map((call) => call[2])).toEqual(["after", "first", "second"]);
  });

  it("removes folded steers from disk while keeping after-turn sends", async () => {
    const { queue, store } = await boot();
    const bot = store.createBot();
    const claim = queue.queueMark();
    queue.queueSteeredMessage(bot.id, bot.threadId, "after", { after: true });
    queue.queueSteeredMessage(bot.id, bot.threadId, "first");
    expect(queue.foldQueuedSends(store, bot.id, bot.threadId, claim)).toEqual(["first"]);
    queue.queueSteeredMessage(bot.id, bot.threadId, "second");
    expect(queue.foldQueuedSends(store, bot.id, bot.threadId, claim)).toEqual(["second"]);
    expect(savedQueue()[0].items.map((item: { text: string }) => item.text)).toEqual(["after"]);
    const restarted = await boot();
    expect(restarted.queue._queuedCount(bot.threadId)).toBe(1);
    expect(restarted.store.messagesFor(bot.threadId).filter((message) => message.role === "user").map((message) => message.text)).toEqual(["first", "second"]);
  });

  it("waits for a busy bot and its active claim, then drains after Stop", async () => {
    const { queue, store } = await boot();
    const bot = store.createBot();
    queue.queueSteeredMessage(bot.id, bot.threadId, "correction", { after: true });
    const restarted = await boot();
    expect(restarted.queue._queuedCount(bot.threadId)).toBe(1);
    restarted.store.patchBot(bot.id, { busy: true });
    const run = vi.fn();
    restarted.queue.drainSteeredMessages(restarted.store, run);
    restarted.store.patchBot(bot.id, { busy: false });
    restarted.queue.drainSteeredMessages(restarted.store, run, () => true);
    expect(run).not.toHaveBeenCalled();
    restarted.queue.drainSteeredMessages(restarted.store, run, () => false);
    expect(run).toHaveBeenCalledTimes(1);
    expect(savedQueue()).toEqual([]);
  });

  it.each(["queueId", "sendId"] as const)("keeps cancellation by %s across restart", async (identity) => {
    const { queue, store } = await boot();
    const bot = store.createBot();
    const sendId = "restart-send-000004";
    const receipt = queue.queueSteeredMessage(bot.id, bot.threadId, "cancel", { after: true, sendId });
    expect(savedQueue()).toHaveLength(1);
    expect(queue.cancelSteeredMessage(bot.id, identity === "queueId" ? receipt.id : sendId)).toEqual({ cancelled: true });
    const restarted = await boot();
    expect(restarted.queue._queuedCount(bot.threadId)).toBe(0);
    expect(savedQueue()).toEqual([]);
  });

  it("does not restore a send marked cancelled", async () => {
    const { queue, store } = await boot();
    const bot = store.createBot();
    queue.queueSteeredMessage(bot.id, bot.threadId, "cancel", { sendId: "restart-send-000005" });
    expect(savedQueue()).toHaveLength(1);
    queue.markSendCancelled("restart-send-000005");
    expect((await boot()).queue._queuedCount(bot.threadId)).toBe(0);
  });

  it.each(["bot", "thread"] as const)("drops persisted items when their %s is deleted", async (owner) => {
    const { queue, store } = await boot();
    const bot = store.createBot();
    const threadId = bot.threadId;
    queue.queueSteeredMessage(bot.id, threadId, "delete", { after: true });
    expect(savedQueue()).toHaveLength(1);
    if (owner === "bot") store.deleteBot(bot.id);
    else {
      store.createTask(bot.id);
      store.deleteTask(bot.id, threadId);
    }
    expect(queue._queuedCount(threadId)).toBe(0);
    expect(savedQueue()).toEqual([]);
    expect((await boot()).queue._queuedCount(threadId)).toBe(0);
  });

  it("prunes stale bot and thread owners from a previous process", async () => {
    const { queue, store } = await boot();
    const bot = store.createBot();
    queue.queueSteeredMessage(bot.id, bot.threadId, "stale thread", { after: true });
    const other = store.createBot();
    queue.queueSteeredMessage(other.id, other.threadId, "stale bot", { after: true });
    const pending = readFileSync(join(dir, "queued-sends.json"), "utf8");
    store.createTask(bot.id);
    store.deleteTask(bot.id, JSON.parse(pending)[0].threadId);
    store.deleteBot(other.id);
    writeFileSync(join(dir, "queued-sends.json"), pending);
    const restarted = await boot();
    expect(restarted.queue.hasQueuedSends(bot.id)).toBe(false);
    expect(restarted.queue.hasQueuedSends(other.id)).toBe(false);
    expect(savedQueue()).toEqual([]);
  });

  it("rejects an enqueue when persistence fails without losing an earlier receipt", async () => {
    const { queue, store } = await boot();
    const bot = store.createBot();
    queue.queueSteeredMessage(bot.id, bot.threadId, "accepted", { after: true });
    const atomic = await import("./atomic.ts");
    vi.spyOn(atomic, "writeFileAtomic").mockImplementationOnce(() => { throw new Error("disk unavailable"); });
    expect(() => queue.queueSteeredMessage(bot.id, bot.threadId, "unaccepted", { after: true })).toThrow("disk unavailable");
    expect(queue._queuedCount(bot.threadId)).toBe(1);
    expect(savedQueue()[0].items.map((item: { text: string }) => item.text)).toEqual(["accepted"]);
    expect((await boot()).queue._queuedCount(bot.threadId)).toBe(1);
  });

  it("keeps a waiting item when transcript append fails", async () => {
    const { queue, store } = await boot();
    const bot = store.createBot();
    queue.queueSteeredMessage(bot.id, bot.threadId, "retry append", { after: true });
    expect(savedQueue()).toHaveLength(1);
    vi.spyOn(store, "appendMessage").mockImplementationOnce(() => { throw new Error("append failed"); });
    expect(() => queue.drainSteeredMessages(store, vi.fn())).toThrow("append failed");
    expect(queue._queuedCount(bot.threadId)).toBe(1);
    expect((await boot()).queue._queuedCount(bot.threadId)).toBe(1);
  });

  it("keeps unappended steers if a preparation fold fails", async () => {
    const { queue, store } = await boot();
    const bot = store.createBot();
    const claim = queue.queueMark();
    queue.queueSteeredMessage(bot.id, bot.threadId, "first");
    queue.queueSteeredMessage(bot.id, bot.threadId, "retry fold");
    expect(savedQueue()).toHaveLength(1);
    vi.spyOn(store, "appendMessage").mockImplementationOnce(() => { throw new Error("append failed"); });
    expect(() => queue.foldQueuedSends(store, bot.id, bot.threadId, claim)).toThrow("append failed");
    queue.queueSteeredMessage(bot.id, bot.threadId, "third", { after: true });
    const restarted = await boot();
    expect(restarted.queue._queuedCount(bot.threadId)).toBe(3);
    const run = vi.fn();
    for (let i = 0; i < 3; i++) restarted.queue.drainSteeredMessages(restarted.store, run);
    expect(run.mock.calls.map((call) => call[2])).toEqual(["first", "retry fold", "third"]);
  });
});
