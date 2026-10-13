import { describe, expect, it, vi } from "vitest";

import { paneNotesForTurn, paneNoteText } from "./context-compaction.ts";
import { NoteSteerer } from "./note-steer.ts";
import { Store } from "./store.ts";

interface HarnessState {
  live?: string;
  busy: boolean;
  canSteer: boolean;
}

function harness(overrides: { live?: string; steer?: (text: string) => Promise<boolean> } = {}) {
  const store = new Store(() => ({ instanceId: "claude", model: "claude-sonnet-5" }));
  const bot = store.createBot();
  const state: HarnessState = { live: "turn-1", busy: true, canSteer: true, ...overrides };
  const steer = vi.fn(overrides.steer ?? (async () => true));
  const wake = vi.fn();
  const steerer = new NoteSteerer({
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
