import { readFileSync, rmSync } from "node:fs";
import ts from "typescript";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { getOrCreateChannel, type CommsBus } from "./comms-visibility.ts";
import * as commsVisibility from "./comms-visibility.ts";
import { claimAsk, claimDelegationWake, clearAskBudget, clearDelegationWakeBudget, MAX_ASKS_PER_TURN } from "./comms-budget.ts";
import { DATA_DIR } from "./config.ts";
import { paneNotesForTurn, paneNotesSinceLastUserTurn, prepareModelContext, withoutTurnNotes } from "./context-compaction.ts";
import { _resetPending, drainDelegations, finishDelegatedTurn, queueDelegation, type DelegatedTurn } from "./delegations.ts";
import { asksSender } from "./delegate-askback.ts";
import { hasLocalUndeliveredPaneNote, isWakeNote, PANE_WAKE_DEBOUNCE_MS, PANE_WAKE_PROMPT, PaneWakeScheduler } from "./pane-wake.ts";
import * as paneWake from "./pane-wake.ts";
import { Store, type BotRecord } from "./store.ts";
import { buildTurnContext } from "./turn-context.ts";

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
    const source = readFileSync(new URL("./index.ts", import.meta.url), "utf8");
    const enabled = source.match(/const paneWake = new PaneWakeScheduler\(\{\s+enabled: (.+),/)![1];
    const javascript = ts.transpileModule(`const enabled = ${enabled};`, { compilerOptions: { target: ts.ScriptTarget.ESNext } }).outputText;
    scheduler = new PaneWakeScheduler({
      enabled: new Function("store", ...Object.keys(paneWake), `${javascript}\nreturn enabled;`)(store, ...Object.values(paneWake)),
      busy: () => busy,
      paused: (id) => store.bot(id)?.paneWakePaused === true,
      hasNotes: (threadId) => notes(threadId).notes.length > 0,
      wake: (botId, threadId) => {
        const pending = notes(threadId);
        const input = buildTurnContext({
          text: [...pending.notes, PANE_WAKE_PROMPT].join("\n\n"),
          transcript: [], rewound: false, fresh: false, replaysNatively: false,
        });
        wake(botId, input.turnText);
        store.markPaneNotesDelivered(botId, threadId, pending.newestId);
      },
      warn: () => {},
    });
    bus = { store, deviceId: "local-device", broadcast: () => {}, wakeSender: (botId, threadId) => scheduler.noteArrived(botId, threadId) };
    const queued = queueDelegation(bus, sender, { toBotId: peer.id, message: "Check this", depth: 0 }, 1);
    drainDelegations(bus, bus, sender.threadId, (toBotId, _text, _depth, sourceThreadId, channel, taskId, sourceBotId) => {
      turn = { toBotId, sourceThreadId, channelId: channel?.id, taskId, sourceBotId };
    });
    await vi.waitFor(() => expect(turn.taskId).toBe(queued.id));
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.restoreAllMocks();
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
      kind: "activity", tool: { name: "Reply from @Helper" }, comm: { peer: "reply", withBotId: peer.id, wake: true },
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

  it("wakes once with terminal sharing disabled after the sender settles", async () => {
    store.patchBot(sender.id, { shareTerminalWithChat: false });
    busy = true;
    finishDelegatedTurn(bus, turn, true, "@Sender, which branch?");
    await vi.advanceTimersByTimeAsync(PANE_WAKE_DEBOUNCE_MS);
    expect(wake).not.toHaveBeenCalled();
    busy = false;
    scheduler.settled();
    await vi.advanceTimersByTimeAsync(PANE_WAKE_DEBOUNCE_MS);
    expect(wake).toHaveBeenCalledExactlyOnceWith(sender.id, expect.stringContaining("@Sender, which branch?"));
    scheduler.noteArrived(sender.id, sender.threadId);
    await vi.advanceTimersByTimeAsync(PANE_WAKE_DEBOUNCE_MS);
    expect(wake).toHaveBeenCalledTimes(1);
    expect(store.messagesFor(sender.threadId).filter((message) => message.comm?.peer === "reply")).toHaveLength(1);
  });

  it("keeps ask-back wakes paused with terminal sharing disabled", async () => {
    store.patchBot(sender.id, { shareTerminalWithChat: false, paneWakePaused: true });
    finishDelegatedTurn(bus, turn, true, "@Sender, which branch?");
    await vi.advanceTimersByTimeAsync(PANE_WAKE_DEBOUNCE_MS);
    scheduler.settled();
    await vi.advanceTimersByTimeAsync(PANE_WAKE_DEBOUNCE_MS);
    expect(wake).not.toHaveBeenCalled();
  });

  it("keeps terminal notes disabled when terminal sharing is off", async () => {
    store.patchBot(sender.id, { shareTerminalWithChat: false });
    store.appendMessage(sender.threadId, { role: "bot", kind: "note", text: "Worker finished", origin: "local-device" });
    scheduler.noteArrived(sender.id, sender.threadId);
    await vi.advanceTimersByTimeAsync(PANE_WAKE_DEBOUNCE_MS);
    expect(wake).not.toHaveBeenCalled();
  });

  it("preserves the wake budget when posting the reply fails", async () => {
    const post = vi.spyOn(commsVisibility, "postPeerReply");
    for (let index = 0; index < MAX_ASKS_PER_TURN; index++) {
      post.mockReturnValueOnce(false);
      finishDelegatedTurn(bus, turn, true, "@Sender, which branch?");
      await vi.advanceTimersByTimeAsync(PANE_WAKE_DEBOUNCE_MS);
      expect(wake).not.toHaveBeenCalled();
      queueDelegation(bus, sender, { toBotId: peer.id, message: "Try again", depth: 0 }, 1);
      drainDelegations(bus, bus, sender.threadId, (toBotId, _text, _depth, sourceThreadId, channel, taskId, sourceBotId) => {
        turn = { toBotId, sourceThreadId, channelId: channel?.id, taskId, sourceBotId };
      });
      await vi.advanceTimersByTimeAsync(0);
    }
    finishDelegatedTurn(bus, turn, true, "@Sender, another question?");
    await vi.advanceTimersByTimeAsync(PANE_WAKE_DEBOUNCE_MS);
    expect(wake).toHaveBeenCalledExactlyOnceWith(sender.id, expect.stringContaining("@Sender, another question?"));
  });

  it("reports an ask-back it could not wake the sender for", async () => {
    const replyUnwoken = vi.fn();
    bus.replyUnwoken = replyUnwoken;
    vi.spyOn(commsVisibility, "postPeerReply").mockReturnValueOnce(false);
    finishDelegatedTurn(bus, turn, true, "@Sender, which branch?");
    expect(replyUnwoken).toHaveBeenCalledExactlyOnceWith(sender.id, "reply post failed");
    queueDelegation(bus, sender, { toBotId: peer.id, message: "Try again", depth: 0 }, 1);
    drainDelegations(bus, bus, sender.threadId, (toBotId, _text, _depth, sourceThreadId, channel, taskId, sourceBotId) => {
      turn = { toBotId, sourceThreadId, channelId: channel?.id, taskId, sourceBotId };
    });
    await vi.advanceTimersByTimeAsync(0);
    while (claimDelegationWake(sender.threadId));
    finishDelegatedTurn(bus, turn, true, "@Sender, which tag?");
    expect(replyUnwoken).toHaveBeenLastCalledWith(sender.id, "wake budget spent");
    expect(replyUnwoken).toHaveBeenCalledTimes(2);
  });

  it.each([true, false])("delivers to the original task after the sender switches tasks (terminal sharing: %s)", async (shareTerminalWithChat) => {
    store.patchBot(sender.id, { shareTerminalWithChat });
    const sourceThreadId = sender.threadId;
    store.createTask(sender.id, "Other task");
    finishDelegatedTurn(bus, turn, true, "@Sender, which branch?");
    await vi.advanceTimersByTimeAsync(PANE_WAKE_DEBOUNCE_MS);
    expect(wake).toHaveBeenCalledExactlyOnceWith(sender.id, expect.stringContaining("@Sender, which branch?"));
    expect(store.messagesFor(sourceThreadId).filter(isWakeNote)).toHaveLength(1);
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
    expect(store.messagesFor(sender.threadId).some(isWakeNote)).toBe(false);
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
    expect(store.messagesFor(sender.threadId).some(isWakeNote)).toBe(false);
  });

  it.each([false, true])("does not wake for a room reply (ask: %s)", async (ask) => {
    const room = store.createGroup("Room", [sender.id, peer.id]);
    turn.sourceThreadId = room.threadId;
    if (ask) turn.ask = true;
    finishDelegatedTurn(bus, turn, true, "@Sender, which branch?");
    await vi.advanceTimersByTimeAsync(PANE_WAKE_DEBOUNCE_MS);
    expect(wake).not.toHaveBeenCalled();
    expect(store.messagesFor(room.threadId).some(isWakeNote)).toBe(false);
  });

  it("does not turn an adopted private ask_bot reply into an ask-back", async () => {
    turn.ask = true;
    finishDelegatedTurn(bus, turn, true, "@Sender, which branch?");
    await vi.advanceTimersByTimeAsync(PANE_WAKE_DEBOUNCE_MS);
    expect(wake).not.toHaveBeenCalled();
  });

  it("re-arms only local, undelivered ask-back rows after restart", () => {
    finishDelegatedTurn(bus, turn, true, "@Sender, which branch?");
    const messages = new Store(() => ({ instanceId: "claude", model: "fake-model" })).activePath(sender.threadId);
    const reply = messages.findLast(isWakeNote)!;
    expect(hasLocalUndeliveredPaneNote(messages, undefined, "local-device")).toBe(true);
    expect(hasLocalUndeliveredPaneNote(messages, reply.id, "local-device")).toBe(false);
    expect(hasLocalUndeliveredPaneNote(messages, undefined, "local-device", reply.id)).toBe(false);
    expect(hasLocalUndeliveredPaneNote(messages, undefined, "other-device")).toBe(false);
    expect(paneNotesSinceLastUserTurn(messages, new Set(), reply.id)).toEqual([]);
    expect(paneNotesSinceLastUserTurn(messages, new Set([reply.id]))).toEqual([]);
  });

  it.each([
    ["resumed", false, false],
    ["inline replay", true, false],
    ["native replay", true, true],
  ])("carries the full activity reply exactly once in %s turn input", async (_name, fresh, replaysNatively) => {
    const reply = "@Sender, which branch should I use?\n\nKeep the full reply, including `code` and https://example.com/?detail=1.";
    finishDelegatedTurn(bus, turn, true, reply);
    const messages = store.activePath(sender.threadId);
    const prepared = await prepareModelContext({ messages, contextWindow: 200_000, taskRecordText: "" });
    if (prepared.status !== "ready") throw new Error("context not ready");
    const pending = paneNotesForTurn(messages, new Set(), undefined, fresh, !replaysNatively);
    const transcript = withoutTurnNotes(prepared.transcript, pending.notes);
    const input = buildTurnContext({
      text: [...pending.notes, PANE_WAKE_PROMPT].join("\n\n"),
      transcript, rewound: false, fresh, replaysNatively,
    });
    const delivered = [input.turnText, ...(replaysNatively ? transcript.map((message) => message.text) : [])].join("\n\n");
    expect(delivered.split(reply)).toHaveLength(2);
    expect(pending.newestId).toBe(messages.findLast(isWakeNote)!.id);
    expect(messages.filter((message) => message.kind === "note")).toHaveLength(0);
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
