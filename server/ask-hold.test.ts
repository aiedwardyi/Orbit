// An ask_user card waits for the asking turn's reply: every settle path
// releases it, the cap and shutdown never lose it, and an idle asker posts
// at once.
import { afterEach, describe, expect, it, vi } from "vitest";

import { ASK_HOLD_CAP_MS, watchAskHold } from "./ask-hold.ts";
import { askUserRequestSchema, postAskUser, type AskUserRequest } from "./ask-user.ts";
import type { ModelSelection, RuntimeEvent, RuntimeEventListener } from "./contracts.ts";
import { Store } from "./store.ts";

const selection = (): ModelSelection => ({ instanceId: "claude", model: "claude-sonnet-5" });

function harness() {
  const store = new Store(selection);
  const listeners: RuntimeEventListener[] = [];
  const hold = watchAskHold(store, {
    subscribe: (listener) => {
      listeners.push(listener);
      return () => {};
    },
  });
  const bot = store.createBot({ name: "Ada" });
  const log: string[] = [];
  store.onChange((change) => {
    if (change.type !== "message") return;
    const { message } = change;
    log.push(message.card?.askUser ? `card:${message.card.subtitle}` : `${message.kind}:${message.text ?? ""}`);
  });
  const alerts: Array<{ target: string; question: string }> = [];
  let routineSource: string | null = null;
  const ask = (body: Partial<AskUserRequest>) =>
    postAskUser(
      {
        bot: (id) => store.bot(id),
        conversation: (botId, threadId) => store.conversationForBot(botId, threadId),
        appendMessage: (threadId, message) => store.appendMessage(threadId, message),
        alertThread: (_bot, threadId) => routineSource ?? threadId,
        notifyQuestion: (_bot, target, question) => {
          alerts.push({ target, question });
          log.push(`alert:${question}`);
        },
        whenSettled: (botId, threadId, post) => hold.whenSettled(botId, threadId, post),
      },
      askUserRequestSchema.parse({ fromBotId: bot.id, fromThreadId: bot.threadId, ...body }),
    );
  const publish = (type: "turn.completed" | "session.exited", threadId = bot.threadId) => {
    const base = { threadId, eventId: "e", provider: "claude", createdAt: "" } as const;
    const event: RuntimeEvent = type === "turn.completed" ? { ...base, type, ok: true } : { ...base, type };
    for (const listener of listeners) listener(event);
  };
  const setRoutineSource = (threadId: string | null) => {
    routineSource = threadId;
  };
  return { store, hold, bot, log, alerts, ask, publish, setRoutineSource };
}

afterEach(() => {
  vi.useRealTimers();
});

describe("ask-user hold", () => {
  it("posts at once when the asker has no running turn in that thread", () => {
    const h = harness();
    expect(h.ask({ question: "Prod?" })).toMatchObject({ status: 201 });
    h.store.setActivity(h.bot.id, "working", "elsewhere");
    expect(h.ask({ question: "Staging?" })).toMatchObject({ status: 201 });
    expect(h.log).toEqual(["card:Prod?", "alert:Prod?", "card:Staging?", "alert:Staging?"]);
  });

  it("holds the card until the asking turn settles, so the reply lands first", () => {
    const h = harness();
    h.store.setActivity(h.bot.id, "working", h.bot.threadId);
    expect(h.ask({ question: "Prod or staging?" })).toEqual({ status: 202, body: { held: true } });
    h.store.setActivity(h.bot.id, "waiting-on-you");
    h.store.patchBot(h.bot.id, { unread: true });
    expect(h.log).toEqual([]);
    h.store.appendMessage(h.bot.threadId, { role: "bot", kind: "text", text: "Here is the plan." });
    h.store.setActivity(h.bot.id, "idle");
    expect(h.log).toEqual(["text:Here is the plan.", "card:Prod or staging?", "alert:Prod or staging?"]);
    expect(h.store.messagesFor(h.bot.threadId).at(-1)?.card?.askUser).toBe(true);
  });

  it.each([
    ["idle (completion, stop, dispatch failure, stall grace)", (h: ReturnType<typeof harness>) => h.store.setActivity(h.bot.id, "idle")],
    ["dead (setup error)", (h: ReturnType<typeof harness>) => h.store.setActivity(h.bot.id, "dead")],
    ["working on another thread", (h: ReturnType<typeof harness>) => h.store.setActivity(h.bot.id, "working", "next-thread")],
    ["turn.completed with the bot still busy", (h: ReturnType<typeof harness>) => h.publish("turn.completed")],
    ["session.exited", (h: ReturnType<typeof harness>) => h.publish("session.exited")],
  ])("releases on %s", (_name, settle) => {
    const h = harness();
    h.store.setActivity(h.bot.id, "working", h.bot.threadId);
    h.ask({ question: "Which?" });
    h.publish("turn.completed", "other-thread");
    h.store.setActivity(h.bot.id, "no-signal");
    expect(h.log).toEqual([]);
    settle(h);
    expect(h.log).toEqual(["card:Which?", "alert:Which?"]);
  });

  it("drops a held card whose bot was deleted", () => {
    const h = harness();
    h.store.setActivity(h.bot.id, "working", h.bot.threadId);
    h.ask({ question: "Which?" });
    h.store.deleteBot(h.bot.id);
    expect(h.log).toEqual([]);
    h.hold.flush();
    expect(h.alerts).toEqual([]);
  });

  it("releases a turn still running after the cap", () => {
    vi.useFakeTimers();
    const h = harness();
    h.store.setActivity(h.bot.id, "working", h.bot.threadId);
    h.ask({ question: "Which?" });
    vi.advanceTimersByTime(ASK_HOLD_CAP_MS - 1);
    expect(h.log).toEqual([]);
    vi.advanceTimersByTime(1);
    expect(h.log).toEqual(["card:Which?", "alert:Which?"]);
    h.store.setActivity(h.bot.id, "idle");
    expect(h.log).toHaveLength(2);
  });

  it("flushes held cards on shutdown", () => {
    const h = harness();
    h.store.setActivity(h.bot.id, "working", h.bot.threadId);
    h.ask({ question: "Which?" });
    h.hold.flush();
    expect(h.log).toEqual(["card:Which?", "alert:Which?"]);
  });

  it("releases two asks from one turn in order", () => {
    vi.useFakeTimers();
    const h = harness();
    h.store.setActivity(h.bot.id, "working", h.bot.threadId);
    h.ask({ question: "First?" });
    vi.advanceTimersByTime(1_000);
    h.ask({ question: "Second?" });
    h.store.setActivity(h.bot.id, "idle");
    expect(h.log).toEqual(["card:First?", "alert:First?", "card:Second?", "alert:Second?"]);
    vi.advanceTimersByTime(ASK_HOLD_CAP_MS);
    expect(h.log).toHaveLength(4);
  });

  it("holds a room ask until that member's room turn settles, keeping its sender", () => {
    const h = harness();
    const other = h.store.createBot({ name: "Bo" });
    const room = h.store.createGroup("Room", [h.bot.id, other.id]);
    h.log.length = 0;
    h.store.setActivity(h.bot.id, "working", room.threadId);
    expect(h.ask({ fromThreadId: room.threadId, question: "Which?" }).status).toBe(202);
    h.store.setActivity(other.id, "idle");
    expect(h.log).toEqual([]);
    h.store.appendMessage(room.threadId, { role: "bot", kind: "text", text: "Two options.", from: { botId: h.bot.id, name: "Ada", color: h.bot.color } });
    h.store.setActivity(h.bot.id, "idle");
    expect(h.log).toEqual(["text:Two options.", "card:Which?", "alert:Which?"]);
    expect(h.store.messagesFor(room.threadId).at(-1)?.from).toEqual({ botId: h.bot.id, name: "Ada", color: h.bot.color });
  });

  it("keeps a room member's card held when another member's turn completes", () => {
    const h = harness();
    const other = h.store.createBot({ name: "Bo" });
    const room = h.store.createGroup("Room", [h.bot.id, other.id]);
    h.log.length = 0;
    h.store.setActivity(h.bot.id, "working", room.threadId);
    h.store.setActivity(other.id, "working", room.threadId);
    h.ask({ fromThreadId: room.threadId, question: "Which?" });
    h.store.setActivity(other.id, "idle");
    h.publish("turn.completed", room.threadId);
    expect(h.log).toEqual([]);
    h.store.setActivity(h.bot.id, "idle");
    expect(h.log).toEqual(["card:Which?", "alert:Which?"]);
  });

  it("keeps the alert target read when the bot asked", () => {
    const h = harness();
    h.store.setActivity(h.bot.id, "working", h.bot.threadId);
    h.setRoutineSource("routine-source");
    h.ask({ question: "Which?" });
    h.setRoutineSource(null);
    h.store.setActivity(h.bot.id, "idle");
    expect(h.alerts).toEqual([{ target: "routine-source", question: "Which?" }]);
  });

  it("never holds an engine ask or approval card", () => {
    const h = harness();
    h.store.setActivity(h.bot.id, "working", h.bot.threadId);
    h.ask({ question: "Which?" });
    h.store.appendMessage(h.bot.threadId, { role: "bot", kind: "options", card: { title: "Approve?", subtitle: "", options: ["Allow"], requestId: "r1" } });
    expect(h.log).toEqual(["options:"]);
  });
});
