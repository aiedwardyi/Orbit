import { rmSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { getOrCreateChannel, type CommsBus } from "./comms-visibility.ts";
import { claimAsk, clearAskBudget, clearDelegationWakeBudget, MAX_ASKS_PER_TURN } from "./comms-budget.ts";
import { DATA_DIR } from "./config.ts";
import { paneNotesForTurn } from "./context-compaction.ts";
import { _resetPending, drainDelegations, finishDelegatedTurn, queueDelegation, type DelegatedTurn } from "./delegations.ts";
import { asksSender } from "./delegate-askback.ts";
import { PANE_WAKE_DEBOUNCE_MS, PaneWakeScheduler } from "./pane-wake.ts";
import { Store, type BotRecord } from "./store.ts";

describe("asksSender", () => {
  it.each([
    ["@Sender, which branch?", "Sender", true],
    ["@sEnDeR: ready?", "Sender", true],
    ["@Sender, all done.", "Sender", false],
    ["Which branch?", "Sender", false],
    ["@Sender `which?`", "Sender", false],
    ["@Sender ``literal `question?` ``", "Sender", false],
    ["@Sender\n```ts\nwhich?\n```", "Sender", false],
    ["@Sender\n~~~\nwhich?\n~~~", "Sender", false],
    ["@Sender\n\n    which?", "Sender", false],
    ["@Sender https://example.com/path?query=1", "Sender", false],
    ["@Sender https://example.com/path?", "Sender", false],
    ["@Sender https://example.com/_which?_", "Sender", false],
    ["@Sender <https://example.com/path?query=1>", "Sender", false],
    ["@Sender [link](https://example.com/path?query=1)", "Sender", false],
    ["@Sender www.example.com/path?query=1", "Sender", false],
    ["@Sender [Which branch?](https://example.com/path)", "Sender", true],
    ["@Sender https://example.com/path?query=1 Which branch?", "Sender", true],
    ["@포키 어떤 브랜치를 쓸까요?", "포키", true],
    ["@Sender-other, ready?", "Sender", false],
    ["@SenderTwo, ready?", "Sender", false],
    ["@Sender (one), ready?", "Sender (one)", true],
    ["`@Sender` Which branch?", "Sender", true],
    ["Ready?", "", false],
  ])("%s (%s) => %s", (reply, senderName, expected) => {
    expect(asksSender(reply, senderName)).toBe(expected);
  });
});

describe("delegated ask-back", () => {
  let store: Store;
  let sender: BotRecord;
  let peer: BotRecord;
  let bus: CommsBus & { wakeSender(botId: string, threadId: string): void };
  let turn: DelegatedTurn;
  let scheduler: PaneWakeScheduler;
  let busy: boolean;
  const wake = vi.fn();

  beforeEach(async () => {
    rmSync(DATA_DIR, { recursive: true, force: true });
    _resetPending();
    wake.mockReset();
    busy = false;
    store = new Store(() => ({ instanceId: "claude", model: "fake-model" }));
    sender = store.patchBot(store.createBot().id, { name: "Sender" })!;
    peer = store.patchBot(store.createBot().id, { name: "Helper" })!;
    clearDelegationWakeBudget(sender.threadId);
    const notes = (threadId: string) => paneNotesForTurn(store.activePath(threadId), new Set(), store.taskByThread(sender.id, threadId)?.paneNotesDeliveredId ?? undefined, false);
    scheduler = new PaneWakeScheduler({
      enabled: (id) => Boolean(store.bot(id)),
      busy: () => busy,
      hasNotes: (threadId) => notes(threadId).notes.length > 0,
      wake: (botId, threadId) => {
        const pending = notes(threadId);
        wake(botId, pending.notes.join("\n\n"));
        store.markPaneNotesDelivered(botId, threadId, pending.newestId);
      },
      warn: () => {},
    });
    bus = { store, broadcast: () => {}, wakeSender: (botId, threadId) => scheduler.noteArrived(botId, threadId) };
    const queued = queueDelegation(bus, sender, { toBotId: peer.id, message: "Check this", depth: 0 }, 1);
    drainDelegations(bus, bus, sender.threadId, (toBotId, _text, _depth, sourceThreadId, channel, taskId, sourceBotId) => {
      turn = { toBotId, sourceThreadId, channelId: channel?.id, taskId, sourceBotId };
    });
    await vi.waitFor(() => expect(turn.taskId).toBe(queued.id));
    vi.useFakeTimers();
  });

  afterEach(() => {
    scheduler.forgetBot(sender.id);
    vi.useRealTimers();
    _resetPending();
    clearDelegationWakeBudget(sender.threadId);
    clearAskBudget(sender.threadId);
  });

  it("wakes the sender once with the full delegated question and one reply row", async () => {
    const reply = "@Sender, which branch should I use?\n\nHere are the details.";
    finishDelegatedTurn(bus, turn, true, reply);
    await vi.advanceTimersByTimeAsync(PANE_WAKE_DEBOUNCE_MS);

    expect(wake).toHaveBeenCalledExactlyOnceWith(sender.id, expect.stringContaining(reply));
    expect(store.messagesFor(sender.threadId).filter((message) => message.text === reply)).toHaveLength(1);
    expect(store.messagesFor(sender.threadId).find((message) => message.text === reply)).toMatchObject({
      kind: "note", tool: { name: "Reply from @Helper" }, comm: { peer: "reply", withBotId: peer.id },
    });
    const channel = getOrCreateChannel(store, sender, peer);
    expect(store.messagesFor(channel.threadId).filter((message) => message.text === reply)).toHaveLength(1);
    finishDelegatedTurn(bus, turn, true, reply);
    await vi.advanceTimersByTimeAsync(PANE_WAKE_DEBOUNCE_MS);
    expect(wake).toHaveBeenCalledTimes(1);
  });

  it("waits for a busy sender to settle", async () => {
    busy = true;
    finishDelegatedTurn(bus, turn, true, "@Sender, which branch?");
    await vi.advanceTimersByTimeAsync(PANE_WAKE_DEBOUNCE_MS);
    expect(wake).not.toHaveBeenCalled();
    busy = false;
    scheduler.settled();
    await vi.advanceTimersByTimeAsync(PANE_WAKE_DEBOUNCE_MS);
    expect(wake).toHaveBeenCalledTimes(1);
  });

  it("delivers to the original task after the sender switches tasks", async () => {
    const sourceThreadId = sender.threadId;
    store.createTask(sender.id, "Other task");
    finishDelegatedTurn(bus, turn, true, "@Sender, which branch?");
    await vi.advanceTimersByTimeAsync(PANE_WAKE_DEBOUNCE_MS);
    expect(wake).toHaveBeenCalledExactlyOnceWith(sender.id, expect.stringContaining("@Sender, which branch?"));
    expect(store.messagesFor(sourceThreadId).filter((message) => message.kind === "note")).toHaveLength(1);
  });

  it.each([
    ["statement", true, "@Sender, finished."],
    ["unaddressed question", true, "Which branch?"],
    ["code question", true, "@Sender `which?`"],
    ["failed delegation", false, "@Sender, which branch?"],
  ])("does not wake for a %s", async (_name, ok, reply) => {
    finishDelegatedTurn(bus, turn, ok, reply);
    await vi.advanceTimersByTimeAsync(PANE_WAKE_DEBOUNCE_MS);
    expect(wake).not.toHaveBeenCalled();
    expect(store.messagesFor(sender.threadId).some((message) => message.kind === "note")).toBe(false);
  });

  it("does not wake after the sender is deleted", async () => {
    store.deleteBot(sender.id);
    finishDelegatedTurn(bus, turn, true, "@Sender, which branch?");
    await vi.advanceTimersByTimeAsync(PANE_WAKE_DEBOUNCE_MS);
    expect(wake).not.toHaveBeenCalled();
  });

  it("does not wake for a taken-over rerun's pointer", async () => {
    turn.takenOverBy = "User";
    finishDelegatedTurn(bus, turn, true, "@Sender, which branch?");
    drainDelegations(bus, bus, sender.threadId, (toBotId, _text, _depth, sourceThreadId, channel, taskId, sourceBotId) => {
      turn = { toBotId, sourceThreadId, channelId: channel?.id, taskId, sourceBotId, takenOverBy: "User" };
    });
    await vi.advanceTimersByTimeAsync(0);
    finishDelegatedTurn(bus, turn, true, "@Sender, which branch?");
    await vi.advanceTimersByTimeAsync(PANE_WAKE_DEBOUNCE_MS);
    expect(wake).not.toHaveBeenCalled();
    expect(store.messagesFor(sender.threadId).some((message) => message.kind === "note")).toBe(false);
  });

  it.each([false, true])("does not wake for a room reply (ask: %s)", async (ask) => {
    const room = store.createGroup("Room", [sender.id, peer.id]);
    turn.sourceThreadId = room.threadId;
    if (ask) turn.ask = true;
    finishDelegatedTurn(bus, turn, true, "@Sender, which branch?");
    await vi.advanceTimersByTimeAsync(PANE_WAKE_DEBOUNCE_MS);
    expect(wake).not.toHaveBeenCalled();
    expect(store.messagesFor(room.threadId).some((message) => message.kind === "note")).toBe(false);
  });

  it("does not turn an adopted private ask_bot reply into an ask-back", async () => {
    turn.ask = true;
    finishDelegatedTurn(bus, turn, true, "@Sender, which branch?");
    await vi.advanceTimersByTimeAsync(PANE_WAKE_DEBOUNCE_MS);
    expect(wake).not.toHaveBeenCalled();
  });

  it("bounds ping-pong by the comms budget while preserving the depth cap", async () => {
    const ids = new Set([turn.taskId]);
    for (let index = 0; index <= MAX_ASKS_PER_TURN; index++) {
      finishDelegatedTurn(bus, turn, true, `@Sender, question ${index}?`);
      await vi.advanceTimersByTimeAsync(PANE_WAKE_DEBOUNCE_MS);
      clearAskBudget(sender.threadId);
      if (index === MAX_ASKS_PER_TURN) break;
      expect(wake).toHaveBeenCalledTimes(index + 1);
      expect(claimAsk(sender.threadId)).toBe(true);
      expect(queueDelegation(bus, peer, { toBotId: sender.id, message: "Recurse", depth: 1 }, 1).result).toBe("too_deep");
      const queued = queueDelegation(bus, sender, { toBotId: peer.id, message: "Follow up", depth: 0 }, 1);
      expect(queued.result).toBe("ok");
      expect(ids.has(queued.id)).toBe(false);
      ids.add(queued.id);
      drainDelegations(bus, bus, sender.threadId, (toBotId, _text, depth, sourceThreadId, channel, taskId, sourceBotId) => {
        expect(depth).toBe(1);
        turn = { toBotId, sourceThreadId, channelId: channel?.id, taskId, sourceBotId };
      });
      await vi.advanceTimersByTimeAsync(0);
    }
    expect(wake).toHaveBeenCalledTimes(MAX_ASKS_PER_TURN);
    clearDelegationWakeBudget(sender.threadId);
    queueDelegation(bus, sender, { toBotId: peer.id, message: "User's next request", depth: 0 }, 1);
    drainDelegations(bus, bus, sender.threadId, (toBotId, _text, _depth, sourceThreadId, channel, taskId, sourceBotId) => {
      turn = { toBotId, sourceThreadId, channelId: channel?.id, taskId, sourceBotId };
    });
    await vi.advanceTimersByTimeAsync(0);
    finishDelegatedTurn(bus, turn, true, "@Sender, another question?");
    await vi.advanceTimersByTimeAsync(PANE_WAKE_DEBOUNCE_MS);
    expect(wake).toHaveBeenCalledTimes(MAX_ASKS_PER_TURN + 1);
  });
});
