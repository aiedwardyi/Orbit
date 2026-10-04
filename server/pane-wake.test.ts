import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { paneNotesForTurn, paneNotesSinceLastUserTurn } from "./context-compaction.ts";
import { hasLocalUndeliveredPaneNote, PANE_WAKE_DEBOUNCE_MS, PANE_WAKE_HOURLY_CAP, PaneWakeScheduler } from "./pane-wake.ts";
import { Store, type Message } from "./store.ts";

function harness(overrides: { enabled?: boolean; busy?: boolean; hasNotes?: boolean; paused?: boolean } = {}) {
  const state = { enabled: true, busy: false, hasNotes: true, paused: false, ...overrides };
  const wake = vi.fn();
  const warn = vi.fn();
  const scheduler = new PaneWakeScheduler({
    enabled: () => state.enabled,
    busy: () => state.busy,
    paused: () => state.paused,
    hasNotes: () => state.hasNotes,
    wake,
    warn,
    now: () => Date.now(),
  });
  return { state, wake, warn, scheduler };
}

describe("PaneWakeScheduler", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("holds pending and later notes after an explicit pause without delivering them", async () => {
    const { state, wake, scheduler } = harness({ busy: true });
    scheduler.noteArrived("teacher", "t1");
    state.paused = true;
    state.busy = false;
    scheduler.settled();
    await vi.advanceTimersByTimeAsync(PANE_WAKE_DEBOUNCE_MS);
    scheduler.noteArrived("teacher", "t1");
    await vi.advanceTimersByTimeAsync(PANE_WAKE_DEBOUNCE_MS);
    expect(wake).not.toHaveBeenCalled();
    expect(state.hasNotes).toBe(true);

    state.paused = false;
    state.hasNotes = false;
    scheduler.settled();
    await vi.advanceTimersByTimeAsync(PANE_WAKE_DEBOUNCE_MS);
    expect(wake).not.toHaveBeenCalled();
    state.hasNotes = true;
    scheduler.noteArrived("teacher", "t1");
    await vi.advanceTimersByTimeAsync(PANE_WAKE_DEBOUNCE_MS);
    expect(wake).toHaveBeenCalledExactlyOnceWith("teacher", "t1");
  });

  it("preserves a pause and its reports across restart for the next user turn", async () => {
    const selection = () => ({ instanceId: "claude", model: "claude-sonnet-5" });
    let store = new Store(selection);
    const bot = store.createBot();
    store.patchBot(bot.id, { paneWakePaused: true });
    const note = store.appendMessage(bot.threadId, { role: "bot", kind: "note", text: "[pane worker01] DONE: verified" });
    store = new Store(selection);
    expect(store.bot(bot.id)?.paneWakePaused).toBe(true);
    const wake = vi.fn();
    const scheduler = new PaneWakeScheduler({
      enabled: () => true,
      busy: () => false,
      paused: (id) => store.bot(id)?.paneWakePaused === true,
      hasNotes: () => true,
      wake,
      warn: vi.fn(),
    });
    scheduler.noteArrived(bot.id, bot.threadId);
    await vi.advanceTimersByTimeAsync(PANE_WAKE_DEBOUNCE_MS);
    expect(wake).not.toHaveBeenCalled();
    store.patchBot(bot.id, { paneWakePaused: false });
    const user = store.appendMessage(bot.threadId, { role: "user", kind: "text", text: "Continue" });
    const pending = paneNotesForTurn(store.activePath(bot.threadId), new Set([user.id]), undefined, false);
    expect(pending.newestId).toBe(note.id);
    expect(pending.notes.join("\n")).toContain("DONE: verified");
    store.markPaneNotesDelivered(bot.id, bot.threadId, pending.newestId);
    expect(new Store(selection).bot(bot.id)?.paneWakePaused).toBe(false);
  });

  it("wakes an idle bot after the debounce", async () => {
    const { wake, scheduler } = harness();
    scheduler.noteArrived("teacher", "t1");
    await vi.advanceTimersByTimeAsync(PANE_WAKE_DEBOUNCE_MS - 1);
    expect(wake).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(wake).toHaveBeenCalledExactlyOnceWith("teacher", "t1");
  });

  it("coalesces a burst into one wake", async () => {
    const { wake, scheduler } = harness();
    scheduler.noteArrived("teacher", "t1");
    await vi.advanceTimersByTimeAsync(1_000);
    scheduler.noteArrived("teacher", "t1");
    scheduler.noteArrived("teacher", "t1");
    await vi.advanceTimersByTimeAsync(PANE_WAKE_DEBOUNCE_MS * 3);
    expect(wake).toHaveBeenCalledOnce();
  });

  it("defers a busy bot to one wake after it settles", async () => {
    const { state, wake, scheduler } = harness({ busy: true });
    scheduler.noteArrived("teacher", "t1");
    await vi.advanceTimersByTimeAsync(PANE_WAKE_DEBOUNCE_MS);
    scheduler.noteArrived("teacher", "t1");
    await vi.advanceTimersByTimeAsync(PANE_WAKE_DEBOUNCE_MS * 3);
    expect(wake).not.toHaveBeenCalled();

    state.busy = false;
    scheduler.settled();
    scheduler.settled();
    await vi.advanceTimersByTimeAsync(PANE_WAKE_DEBOUNCE_MS);
    expect(wake).toHaveBeenCalledOnce();
    scheduler.settled();
    await vi.advanceTimersByTimeAsync(PANE_WAKE_DEBOUNCE_MS);
    expect(wake).toHaveBeenCalledOnce();
  });

  it("wakes a busy-deferred note once a failed dispatch leaves the bot idle", async () => {
    const { state, wake, scheduler } = harness({ busy: true });
    scheduler.noteArrived("teacher", "t1");
    await vi.advanceTimersByTimeAsync(PANE_WAKE_DEBOUNCE_MS * 3);
    expect(wake).not.toHaveBeenCalled();

    state.busy = false;
    scheduler.settled();
    await vi.advanceTimersByTimeAsync(PANE_WAKE_DEBOUNCE_MS);
    expect(wake).toHaveBeenCalledExactlyOnceWith("teacher", "t1");
  });

  it("skips the wake when a user turn already delivered the notes", async () => {
    const { state, wake, scheduler } = harness({ busy: true });
    scheduler.noteArrived("teacher", "t1");
    await vi.advanceTimersByTimeAsync(PANE_WAKE_DEBOUNCE_MS);
    state.busy = false;
    state.hasNotes = false;
    scheduler.settled();
    await vi.advanceTimersByTimeAsync(PANE_WAKE_DEBOUNCE_MS);
    expect(wake).not.toHaveBeenCalled();
  });

  it("still wakes when a mid-turn steer follows the note", async () => {
    const messages: Message[] = [
      { id: "u0", role: "user", kind: "text", text: "Run worker", at: 1 },
      { id: "note", role: "bot", kind: "note", text: "[pane worker01] DONE: result 42", at: 2 },
    ];
    let busy = true;
    const wake = vi.fn();
    const scheduler = new PaneWakeScheduler({
      enabled: () => true,
      busy: () => busy,
      hasNotes: () => paneNotesSinceLastUserTurn(messages, new Set()).length > 0,
      wake,
      warn: vi.fn(),
    });
    scheduler.noteArrived("teacher", "t1");
    await vi.advanceTimersByTimeAsync(PANE_WAKE_DEBOUNCE_MS);
    messages.push({ id: "steer", role: "user", kind: "text", text: "Also check the build", steered: true, at: 3 });
    busy = false;
    scheduler.settled();
    await vi.advanceTimersByTimeAsync(PANE_WAKE_DEBOUNCE_MS);
    expect(wake).toHaveBeenCalledExactlyOnceWith("teacher", "t1");
  });

  it("never wakes with the share-terminal gate off", async () => {
    const { wake, scheduler } = harness({ enabled: false });
    scheduler.noteArrived("teacher", "t1");
    await vi.advanceTimersByTimeAsync(PANE_WAKE_DEBOUNCE_MS);
    expect(wake).not.toHaveBeenCalled();
  });

  it("caps wakes per bot per hour, warns, and wakes once a slot frees", async () => {
    const { wake, warn, scheduler } = harness();
    for (let i = 0; i < PANE_WAKE_HOURLY_CAP + 1; i++) {
      scheduler.noteArrived("teacher", "t1");
      await vi.advanceTimersByTimeAsync(PANE_WAKE_DEBOUNCE_MS);
    }
    expect(wake).toHaveBeenCalledTimes(PANE_WAKE_HOURLY_CAP);
    expect(warn).toHaveBeenCalledOnce();

    scheduler.noteArrived("teacher", "t1");
    scheduler.settled();
    await vi.advanceTimersByTimeAsync(PANE_WAKE_DEBOUNCE_MS * 2);
    expect(wake).toHaveBeenCalledTimes(PANE_WAKE_HOURLY_CAP);

    await vi.advanceTimersByTimeAsync(60 * 60 * 1000);
    expect(wake).toHaveBeenCalledTimes(PANE_WAKE_HOURLY_CAP + 1);
    expect(warn).toHaveBeenCalledOnce();
  });

  it("drops the capped retry when a user turn delivered the notes", async () => {
    const { state, wake, scheduler } = harness();
    for (let i = 0; i < PANE_WAKE_HOURLY_CAP + 1; i++) {
      scheduler.noteArrived("teacher", "t1");
      await vi.advanceTimersByTimeAsync(PANE_WAKE_DEBOUNCE_MS);
    }
    state.hasNotes = false;
    await vi.advanceTimersByTimeAsync(60 * 60 * 1000);
    expect(wake).toHaveBeenCalledTimes(PANE_WAKE_HOURLY_CAP);
  });

  it("holds a capped retry that finds the bot busy until it settles", async () => {
    const { state, wake, scheduler } = harness();
    for (let i = 0; i < PANE_WAKE_HOURLY_CAP + 1; i++) {
      scheduler.noteArrived("teacher", "t1");
      await vi.advanceTimersByTimeAsync(PANE_WAKE_DEBOUNCE_MS);
    }
    state.busy = true;
    await vi.advanceTimersByTimeAsync(60 * 60 * 1000);
    expect(wake).toHaveBeenCalledTimes(PANE_WAKE_HOURLY_CAP);

    state.busy = false;
    scheduler.settled();
    await vi.advanceTimersByTimeAsync(PANE_WAKE_DEBOUNCE_MS);
    expect(wake).toHaveBeenCalledTimes(PANE_WAKE_HOURLY_CAP + 1);
  });

  it("forgetBot cancels a capped retry", async () => {
    const { wake, scheduler } = harness();
    for (let i = 0; i < PANE_WAKE_HOURLY_CAP + 1; i++) {
      scheduler.noteArrived("teacher", "t1");
      await vi.advanceTimersByTimeAsync(PANE_WAKE_DEBOUNCE_MS);
    }
    scheduler.forgetBot("teacher");
    await vi.advanceTimersByTimeAsync(60 * 60 * 1000);
    expect(wake).toHaveBeenCalledTimes(PANE_WAKE_HOURLY_CAP);
  });

  it("forgetBot drops a pending wake and the hourly tally", async () => {
    const { wake, warn, scheduler } = harness();
    for (let i = 0; i < PANE_WAKE_HOURLY_CAP; i++) {
      scheduler.noteArrived("teacher", "t1");
      await vi.advanceTimersByTimeAsync(PANE_WAKE_DEBOUNCE_MS);
    }
    scheduler.noteArrived("teacher", "t1");
    scheduler.forgetBot("teacher");
    await vi.advanceTimersByTimeAsync(PANE_WAKE_DEBOUNCE_MS);
    expect(wake).toHaveBeenCalledTimes(PANE_WAKE_HOURLY_CAP);

    scheduler.noteArrived("teacher", "t1");
    await vi.advanceTimersByTimeAsync(PANE_WAKE_DEBOUNCE_MS);
    expect(wake).toHaveBeenCalledTimes(PANE_WAKE_HOURLY_CAP + 1);
    expect(warn).not.toHaveBeenCalled();
  });
});

describe("hasLocalUndeliveredPaneNote", () => {
  const messages: Message[] = [
    { id: "user", role: "user", kind: "text", text: "Run worker", at: 1 },
    { id: "local", role: "bot", kind: "note", text: "local result", origin: "home", at: 2 },
  ];

  it("wakes for a local undelivered note", () => {
    expect(hasLocalUndeliveredPaneNote(messages, undefined, "home")).toBe(true);
  });

  it("does not wake for a synced or legacy note", () => {
    const synced: Message[] = [{ ...messages[1]!, origin: "work" }];
    const legacy: Message[] = [{ ...messages[1]!, origin: undefined }];

    expect(paneNotesSinceLastUserTurn(synced, new Set()).length).toBeGreaterThan(0);
    expect(hasLocalUndeliveredPaneNote(synced, undefined, "home")).toBe(false);
    expect(hasLocalUndeliveredPaneNote(legacy, undefined, "home")).toBe(false);
  });

  it("does not wake when the local note was already delivered", () => {
    expect(hasLocalUndeliveredPaneNote(messages, "local", "home")).toBe(false);
  });
});

describe("pane wake wiring", () => {
  it("starts an attended card turn so auto mode can act on worker reports", () => {
    const index = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "index.ts"), "utf8");
    const call = index.slice(index.indexOf("startTurn(botId, PANE_WAKE_PROMPT,"), index.indexOf(".then(", index.indexOf("startTurn(botId, PANE_WAKE_PROMPT,")));
    expect(call).toContain("cardContinuation: true");
    expect(call).not.toContain("unattended");
  });
});
