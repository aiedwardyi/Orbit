import { rmSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { getOrCreateChannel, mirrorExchange, type CommsBus } from "./comms-visibility.ts";
import { DATA_DIR } from "./config.ts";
import type { ModelSelection, RuntimeEvent } from "./contracts.ts";
import { findDelegationReceipt, finishDelegatedTurn, pollDelegation, _resetPending, type DelegatedTurn } from "./delegations.ts";
import { EventBus } from "./harness/bus.ts";
import { Store, type BotRecord, type GroupRecord } from "./store.ts";
import { ownTurnReply } from "./turn-reply.ts";

process.env.OMB_ASK_BOT_TIMEOUT_MS = "300";
const { ASK_BOT_TIMEOUT_MS, waitForPeerReply } = await import("./ask-bot.ts");

const selection = (): ModelSelection => ({ instanceId: "claude", model: "fake-model" });

describe("ask_bot past its wait", () => {
  let store: Store;
  let caller: BotRecord;
  let peer: BotRecord;
  let channel: GroupRecord;
  let commsBus: CommsBus;
  let bus: EventBus;
  let busy: boolean;
  let watched: DelegatedTurn | undefined;

  beforeEach(() => {
    rmSync(DATA_DIR, { recursive: true, force: true });
    _resetPending();
    store = new Store(selection);
    caller = store.patchBot(store.createBot().id, { name: "Metaverse" })!;
    peer = store.patchBot(store.createBot().id, { name: "Pokkey" })!;
    channel = getOrCreateChannel(store, caller, peer);
    commsBus = { store, broadcast: () => {} };
    bus = new EventBus(() => {});
    busy = true;
    watched = undefined;
    mirrorExchange(commsBus, caller, peer, "Read the filings and summarize.", channel, caller.threadId);
  });
  afterEach(() => _resetPending());

  const base = () => ({ provider: "claude" as const, eventId: crypto.randomUUID(), createdAt: new Date().toISOString(), threadId: peer.threadId, turnId: "t1" });
  const text = (body: string): RuntimeEvent => ({ ...base(), type: "item.completed", itemType: "assistant_text", text: body });
  const completed = (): RuntimeEvent => ({ ...base(), type: "turn.completed", ok: true });
  const ask = (start: (onDispatchError: (message: string) => void) => Promise<void> = async () => {}) => waitForPeerReply({
    threadId: peer.threadId,
    botName: peer.name,
    userName: () => "Edward",
    subscribe: (listener) => bus.subscribe(listener),
    fold: ownTurnReply(() => false).fold,
    start,
    adopt: () => {
      if (!busy) return undefined;
      watched = { channelId: channel.id, toBotId: peer.id, taskId: "ask-task-1", sourceThreadId: caller.threadId, sourceBotId: caller.id };
      return watched.taskId;
    },
    fail: (_taskId, failureName) => void finishDelegatedTurn(commsBus, watched!, false, "", failureName),
  });
  const poll = (waitMs: number) =>
    pollDelegation("ask-task-1", caller.id, caller.threadId, waitMs, (id) => (watched?.taskId === id ? watched : undefined), () => peer.name);
  const channelTexts = () => store.messagesFor(channel.threadId).filter((m) => m.kind === "text").map((m) => m.text);
  const replyRows = () => store.messagesFor(caller.threadId).filter((m) => m.comm?.peer === "reply").map((m) => m.text);

  it("returns a reply that lands in time as today", async () => {
    const asked = ask();
    bus.publish(text("Quick answer."));
    bus.publish(completed());
    expect(await asked).toEqual({ text: "Quick answer.", replied: true });
    expect(watched).toBeUndefined();
  });

  it("hands back a task id, then the late reply reaches the receipt, the caller's thread and the channel once", async () => {
    const asked = await ask();
    expect(asked.taskId).toBe("ask-task-1");
    expect(asked.replied).toBe(false);
    expect(asked.text).toContain("Task id: ask-task-1");
    expect(asked.text).toContain("wait_delegation");
    expect(await poll(0)).toEqual({ code: 200, body: { status: "running", toBotName: "Pokkey" } });

    const reply = `Filing summary. ${"x".repeat(9_650)}`;
    const waited = poll(5_000);
    const started = Date.now();
    setTimeout(() => finishDelegatedTurn(commsBus, watched!, true, reply), 100);
    expect(await waited).toEqual({ code: 200, body: { status: "done", toBotName: "Pokkey", result: reply } });
    expect(Date.now() - started).toBeLessThan(1_500);
    expect(findDelegationReceipt("ask-task-1")?.result).toBe(reply);
    expect(replyRows()).toEqual([reply]);
    expect(channelTexts()).toEqual(["Read the filings and summarize.", reply]);
  });

  it("drops partial text from the wait and never mirrors it", async () => {
    const asked = ask();
    bus.publish(text("Reading the filings now."));
    const result = await asked;
    expect(result.taskId).toBe("ask-task-1");
    expect(result.text).not.toContain("Reading the filings");
    expect(channelTexts()).toEqual(["Read the filings and summarize."]);
  });

  it("settles a peer that fails after the wait as failed", async () => {
    await ask();
    finishDelegatedTurn(commsBus, watched!, false, "", "Delegated turn did not finish");
    expect(await poll(0)).toEqual({ code: 200, body: { status: "failed", toBotName: "Pokkey", result: "Delegated turn did not finish" } });
    expect(replyRows()).toEqual([]);
  });

  it("fails an adopted ask whose dispatch fails after start resolved", async () => {
    let dispatchError: (message: string) => void = () => {};
    const asked = ask(async (onDispatchError) => {
      dispatchError = onDispatchError;
    });
    dispatchError("still preparing");
    expect((await asked).taskId).toBe("ask-task-1");
    expect(await poll(0)).toEqual({ code: 200, body: { status: "running", toBotName: "Pokkey" } });

    dispatchError("provider unavailable");
    expect(await poll(0)).toEqual({ code: 200, body: { status: "failed", toBotName: "Pokkey", result: "Asked turn could not start: provider unavailable" } });
  });

  it("keeps the timeout note without a task id when the peer already ended", async () => {
    busy = false;
    const started = Date.now();
    expect(await ask()).toEqual({ text: "(timed out waiting for the bot to reply)", replied: false });
    expect(Date.now() - started).toBeGreaterThanOrEqual(ASK_BOT_TIMEOUT_MS - 20);
    expect(watched).toBeUndefined();
  });
});
