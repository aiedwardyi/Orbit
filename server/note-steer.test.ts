import { chmodSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";

import { ensureDirs } from "./config.ts";
import { paneNotesForTurn, paneNoteText } from "./context-compaction.ts";
import type { ProviderInstance } from "./contracts.ts";
import { ClaudeDriver } from "./drivers/claude.ts";
import { NoteSteerer, steerUntilTaken } from "./note-steer.ts";
import { composeUserTurnPrompt, userTurnReactionKeys } from "./replies.ts";
import { Store } from "./store.ts";
import { recordEvents, type EventRecorder } from "./testing/events.ts";

const FAKE_CLI = join(dirname(fileURLToPath(import.meta.url)), "testing", "fake-claude-cli.ts");

interface HarnessState {
  live?: string;
  busy: boolean;
  canSteer: boolean;
  enabled: boolean;
  paused: boolean;
}

function harness(overrides: { live?: string; steer?: (text: string) => Promise<boolean>; wake?: () => void } = {}) {
  const store = new Store(() => ({ instanceId: "claude", model: "claude-sonnet-5" }));
  const bot = store.createBot();
  const state: HarnessState = { live: "turn-1", busy: true, canSteer: true, enabled: true, paused: false, ...overrides };
  const steer = vi.fn(overrides.steer ?? (async () => true));
  const wake = vi.fn(overrides.wake ?? (() => {}));
  const steerer = new NoteSteerer({
    enabled: () => state.enabled,
    paused: () => state.paused,
    liveTurn: () => state.live,
    busy: () => state.busy,
    steer: (_botId, _threadId, text) => (state.canSteer ? steer(text) : undefined),
    messages: (threadId) => store.activePath(threadId),
    deliveredId: (botId, threadId) => store.taskByThread(botId, threadId)?.paneNotesDeliveredId ?? undefined,
    markDelivered: (botId, threadId, noteId) => store.markPaneNotesDelivered(botId, threadId, noteId),
    wake,
  });
  const note = (text: string) => store.appendMessage(bot.threadId, { role: "bot", kind: "note", text });
  const delivered = () => store.taskByThread(bot.id, bot.threadId)?.paneNotesDeliveredId;
  const nextPrefix = () => paneNotesForTurn(store.activePath(bot.threadId), new Set(), delivered() ?? undefined, false).notes;
  const arrive = (pane?: string) => steerer.noteArrived(bot.id, bot.threadId, pane);
  return { store, bot, state, steer, wake, note, delivered, nextPrefix, arrive };
}

describe("NoteSteerer", () => {
  it("steers a note into the busy teacher's live turn with the prefix text and skips the wake", async () => {
    const { steer, wake, note, delivered, nextPrefix, arrive } = harness();
    const stored = note("[pane worker01] DONE: verified");
    await arrive("worker01");
    expect(steer).toHaveBeenCalledExactlyOnceWith(paneNoteText(stored.text!));
    expect(delivered()).toBe(stored.id);
    expect(wake).not.toHaveBeenCalled();
    expect(nextPrefix()).toEqual([]);
  });

  it("delivers two notes from the same tick once each, in storage order", async () => {
    const { steer, wake, note, delivered, arrive } = harness();
    const first = note("[pane a] first");
    const second = note("[pane b] second");
    await Promise.all([arrive("a"), arrive("b")]);
    expect(steer).toHaveBeenCalledExactlyOnceWith([paneNoteText(first.text!), paneNoteText(second.text!)].join("\n\n"));
    expect(delivered()).toBe(second.id);
    expect(wake).not.toHaveBeenCalled();
  });

  it("waits for an in-flight steer before steering the next note", async () => {
    let release: (ok: boolean) => void = () => {};
    const { steer, note, delivered, arrive } = harness({
      steer: () => new Promise<boolean>((resolve) => (release = resolve)),
    });
    const first = note("[pane a] first");
    const pending = arrive("a");
    await vi.waitFor(() => expect(steer).toHaveBeenCalledTimes(1));
    const second = note("[pane b] second");
    const next = arrive("b");
    await Promise.resolve();
    expect(steer).toHaveBeenCalledTimes(1);
    release(true);
    await pending;
    await vi.waitFor(() => expect(steer).toHaveBeenCalledTimes(2));
    release(true);
    await next;
    expect(steer.mock.calls.map(([text]) => text)).toEqual([paneNoteText(first.text!), paneNoteText(second.text!)]);
    expect(delivered()).toBe(second.id);
  });

  it("falls back to one wake when the steer is rejected", async () => {
    const { wake, note, delivered, nextPrefix, arrive } = harness({ steer: async () => false });
    const stored = note("[pane worker01] DONE");
    await arrive("worker01");
    expect(wake).toHaveBeenCalledOnce();
    expect(delivered()).toBeUndefined();
    expect(nextPrefix()).toEqual([paneNoteText(stored.text!)]);
  });

  it("falls back to one wake when the steer throws", async () => {
    const { wake, note, delivered, arrive } = harness({ steer: async () => Promise.reject(new Error("stdin closed")) });
    note("[pane worker01] DONE");
    await arrive("worker01");
    expect(wake).toHaveBeenCalledOnce();
    expect(delivered()).toBeUndefined();
  });

  it("steers a note held earlier together with a new one, oldest first", async () => {
    const { store, bot, steer, wake, note, delivered, arrive } = harness();
    store.appendMessage(bot.threadId, { role: "user", kind: "text", text: "Run the workers" });
    const held = note("[pane a] held while the pane was closed");
    store.markPaneNotesSkipped(bot.id, bot.threadId, held.id);
    const fresh = note("[pane b] new");
    await arrive("b");
    expect(steer).toHaveBeenCalledExactlyOnceWith([paneNoteText(held.text!), paneNoteText(fresh.text!)].join("\n\n"));
    expect(delivered()).toBe(fresh.id);
    expect(wake).not.toHaveBeenCalled();
  });

  it("leaves an idle bot, a turn still claiming or dispatching, a turn on another thread and an engine without steer to the wake", async () => {
    for (const setup of [
      (state: HarnessState) => (state.live = undefined),
      (state: HarnessState) => (state.canSteer = false),
    ]) {
      const { state, steer, wake, note, delivered, arrive } = harness();
      setup(state);
      note("[pane a] DONE");
      await arrive("a");
      expect(steer).not.toHaveBeenCalled();
      expect(wake).toHaveBeenCalledExactlyOnceWith(expect.any(String), expect.any(String), "a");
      expect(delivered()).toBeUndefined();
    }
  });

  it("marks a steer the turn took as it ended, while no new turn has started", async () => {
    const { state, wake, note, delivered, arrive } = harness({
      steer: async () => {
        state.live = undefined;
        state.busy = false;
        return true;
      },
    });
    const stored = note("[pane a] DONE");
    await arrive("a");
    expect(delivered()).toBe(stored.id);
    expect(wake).not.toHaveBeenCalled();
  });

  it("leaves the watermark to a turn that started mid-steer", async () => {
    const { store, bot, state, wake, note, delivered, arrive } = harness({
      steer: async () => {
        state.live = undefined;
        return true;
      },
    });
    const earlier = note("[pane a] earlier");
    store.markPaneNotesDelivered(bot.id, bot.threadId, earlier.id);
    note("[pane b] DONE");
    await arrive("b");
    expect(delivered()).toBe(earlier.id);
    expect(wake).toHaveBeenCalledOnce();
  });

  it("leaves a note to the wake when sharing is off or wakes are paused", async () => {
    for (const setup of [
      (state: HarnessState) => (state.enabled = false),
      (state: HarnessState) => (state.paused = true),
    ]) {
      const { state, steer, wake, note, delivered, arrive } = harness();
      setup(state);
      note("[pane a] DONE");
      await arrive("a");
      expect(steer).not.toHaveBeenCalled();
      expect(wake).toHaveBeenCalledExactlyOnceWith(expect.any(String), expect.any(String), "a");
      expect(delivered()).toBeUndefined();
    }
  });

  it("marks a note the CLI ran itself as a new turn after the failed one", async () => {
    const { state, wake, note, delivered, arrive } = harness({
      steer: async () => {
        state.live = "turn-2";
        return true;
      },
    });
    const stored = note("[pane a] DONE");
    await arrive("a");
    expect(delivered()).toBe(stored.id);
    expect(wake).not.toHaveBeenCalled();
  });

  it("keeps a newer watermark a turn set while the steer was in flight", async () => {
    let newer = "";
    const { store, bot, state, wake, note, delivered, arrive } = harness({
      steer: async () => {
        newer = note("[pane b] later").id;
        store.markPaneNotesDelivered(bot.id, bot.threadId, newer);
        state.live = undefined;
        state.busy = false;
        return true;
      },
    });
    note("[pane a] DONE");
    await arrive("a");
    expect(delivered()).toBe(newer);
    expect(wake).not.toHaveBeenCalled();
  });

  it("still steers the next note after a run whose wake threw", async () => {
    const results = [false, true];
    const { steer, note, delivered, arrive } = harness({
      steer: async () => results.shift()!,
      wake: () => {
        throw new Error("wake failed");
      },
    });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    note("[pane a] first");
    await arrive("a").catch(() => {});
    const second = note("[pane b] second");
    await arrive("b").catch(() => {});
    expect(steer).toHaveBeenCalledTimes(2);
    expect(delivered()).toBe(second.id);
    warn.mockRestore();
  });

  it("wakes once when the wake itself throws", async () => {
    const { wake, note, arrive } = harness({
      steer: async () => false,
      wake: () => {
        throw new Error("wake failed");
      },
    });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    note("[pane a] DONE");
    await arrive("a").catch(() => {});
    expect(wake).toHaveBeenCalledOnce();
    expect(warn).toHaveBeenCalledOnce();
    warn.mockRestore();
  });

  it("replays a steered note as history in a fresh provider session, not as new", async () => {
    const { store, bot, note, delivered, arrive } = harness();
    note("[pane a] DONE");
    await arrive("a");
    const path = store.activePath(bot.threadId);
    const inline = paneNotesForTurn(path, new Set(), delivered() ?? undefined, true, true, 200_000);
    expect(inline.notes).toEqual([]);
    expect(inline.ids).toEqual([]);
    expect(paneNotesForTurn(path, new Set(), delivered() ?? undefined, true, false).notes).toEqual([]);
  });
});

describe("steering into the Claude driver (fake CLI)", () => {
  let instance: ProviderInstance | undefined;
  let recorder: EventRecorder | undefined;

  const dispose = async () => {
    recorder?.stop();
    await instance?.dispose();
    instance = undefined;
  };
  afterEach(dispose);

  // fail-steer waits for the steer after its first request; hang never requests
  async function liveTurn(mode: "hang" | "fail-steer", failSteer = "") {
    ensureDirs();
    chmodSync(FAKE_CLI, 0o755);
    const claude = await ClaudeDriver.create({
      instanceId: "claude-steer",
      displayName: "Claude",
      enabled: true,
      environment: { FAKE_CLAUDE_MODE: mode, FAKE_CLAUDE_FAIL_STEER: failSteer },
      config: { cli: FAKE_CLI, permissionMode: "bypassPermissions" },
    });
    instance = claude;
    const adapter = claude.adapter;
    const events = recordEvents(adapter);
    recorder = events;
    const store = new Store(() => ({ instanceId: "claude-steer", model: "claude-fake" }));
    const bot = store.createBot();
    let live: string | undefined;
    adapter.onEvent((event) => {
      if (event.type === "turn.started") live = event.turnId;
      if (event.type === "turn.completed" && event.turnId === live) live = undefined;
    });
    await adapter.sendTurn({ threadId: bot.threadId, text: "work", model: "claude-fake" });
    await events.until((event) => event.type === (mode === "hang" ? "session.started" : "content.delta"));
    let written: Promise<boolean> | undefined;
    const wake = vi.fn();
    const steerer = new NoteSteerer({
      enabled: () => true,
      paused: () => false,
      liveTurn: () => live,
      busy: (_botId, threadId) => adapter.hasSession(threadId),
      steer: (_botId, threadId, text) => steerUntilTaken({
        capabilities: adapter.capabilities,
        steer: (id, body, consumed) => (written = adapter.steer!(id, body, consumed)),
      }, threadId, text),
      messages: (threadId) => store.activePath(threadId),
      deliveredId: (botId, threadId) => store.taskByThread(botId, threadId)?.paneNotesDeliveredId ?? undefined,
      markDelivered: (botId, threadId, noteId) => store.markPaneNotesDelivered(botId, threadId, noteId),
      wake,
    });
    const delivered = () => store.taskByThread(bot.id, bot.threadId)?.paneNotesDeliveredId;
    const nextPrefix = () => paneNotesForTurn(store.activePath(bot.threadId), new Set(), delivered() ?? undefined, false).notes;
    const arrive = () => {
      const stored = store.appendMessage(bot.threadId, { role: "bot", kind: "note", text: "[pane abcdef01] DONE: worker finished" });
      return { stored, arrived: steerer.noteArrived(bot.id, bot.threadId, "abcdef01") };
    };
    const steered = async () => {
      await vi.waitFor(() => expect(written).toBeDefined());
      return written;
    };
    return { adapter, events, store, bot, wake, delivered, nextPrefix, arrive, steered };
  }

  it("keeps a note Stop cut off before the model's next request for the next turn", async () => {
    const { adapter, bot, wake, delivered, nextPrefix, arrive, steered } = await liveTurn("hang");
    const { stored, arrived } = arrive();
    await expect(steered()).resolves.toBe(true);
    await adapter.interruptTurn(bot.threadId);
    await arrived;
    expect(delivered()).toBeUndefined();
    expect(wake).toHaveBeenCalledOnce();
    expect(nextPrefix()).toEqual([paneNoteText(stored.text!)]);
  });

  it("leaves a note to the wake when the CLI dies after a failed turn, before its next request", async () => {
    const { wake, delivered, nextPrefix, arrive } = await liveTurn("fail-steer", "exit");
    const { stored, arrived } = arrive();
    await arrived;
    expect(delivered()).toBeUndefined();
    expect(wake).toHaveBeenCalledOnce();
    expect(nextPrefix()).toEqual([paneNoteText(stored.text!)]);
  });

  it("spends a note the CLI answers itself after a failed turn", async () => {
    const { events, wake, delivered, nextPrefix, arrive } = await liveTurn("fail-steer");
    const { stored, arrived } = arrive();
    await arrived;
    await vi.waitFor(() => expect(events.events.filter((event) => event.type === "turn.completed")).toHaveLength(2));
    expect(events.events.filter((event) => event.type === "turn.completed").map((event) => event.type === "turn.completed" && event.ok)).toEqual([false, true]);
    expect(delivered()).toBe(stored.id);
    expect(wake).not.toHaveBeenCalled();
    expect(nextPrefix()).toEqual([]);
  });

  it("never replays a note the model took in before its turn failed", async () => {
    const { events, wake, delivered, nextPrefix, arrive } = await liveTurn("fail-steer", "carried");
    const { stored, arrived } = arrive();
    await arrived;
    await expect(events.until((event) => event.type === "turn.completed")).resolves.toMatchObject({ ok: false });
    expect(delivered()).toBe(stored.id);
    expect(wake).not.toHaveBeenCalled();
    expect(nextPrefix()).toEqual([]);
  });

  it("keeps a steered reaction pending until the model takes it in", async () => {
    for (const [mode, failSteer, pending] of [["hang", "", true], ["fail-steer", "carried", false]] as const) {
      const { adapter, events, store, bot } = await liveTurn(mode, failSteer);
      const answer = store.appendMessage(bot.threadId, { role: "bot", kind: "text", text: "An earlier answer" });
      store.toggleReaction(bot.threadId, answer.id, "👍", "user");
      const opts = () => ({ messages: store.activePath(bot.threadId), delivered: store.taskByThread(bot.id, bot.threadId)?.reactionsDelivered });
      const steeredOpts = opts();
      const prompt = composeUserTurnPrompt("user correction", steeredOpts);
      const reactions = userTurnReactionKeys(steeredOpts);
      expect(prompt).toContain("👍");
      await expect(adapter.steer!(bot.threadId, prompt, (taken) => {
        if (taken) store.addReactionsDelivered(bot.id, bot.threadId, reactions);
      })).resolves.toBe(true);
      if (mode === "hang") await adapter.interruptTurn(bot.threadId);
      await events.until((event) => event.type === "turn.completed");
      expect(composeUserTurnPrompt("next", opts()).includes("👍")).toBe(pending);
      await dispose();
    }
  });
});
