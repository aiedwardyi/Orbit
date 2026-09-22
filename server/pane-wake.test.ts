import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { PANE_WAKE_DEBOUNCE_MS, PANE_WAKE_HOURLY_CAP, PaneWakeScheduler } from "./pane-wake.ts";

function harness(overrides: { enabled?: boolean; busy?: boolean; hasNotes?: boolean } = {}) {
  const state = { enabled: true, busy: false, hasNotes: true, ...overrides };
  const wake = vi.fn();
  const warn = vi.fn();
  const scheduler = new PaneWakeScheduler({
    enabled: () => state.enabled,
    busy: () => state.busy,
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

  it("never wakes with the share-terminal gate off", async () => {
    const { wake, scheduler } = harness({ enabled: false });
    scheduler.noteArrived("teacher", "t1");
    await vi.advanceTimersByTimeAsync(PANE_WAKE_DEBOUNCE_MS);
    expect(wake).not.toHaveBeenCalled();
  });

  it("caps wakes per bot per hour and warns", async () => {
    const { wake, warn, scheduler } = harness();
    for (let i = 0; i < PANE_WAKE_HOURLY_CAP + 1; i++) {
      scheduler.noteArrived("teacher", "t1");
      await vi.advanceTimersByTimeAsync(PANE_WAKE_DEBOUNCE_MS);
    }
    expect(wake).toHaveBeenCalledTimes(PANE_WAKE_HOURLY_CAP);
    expect(warn).toHaveBeenCalledOnce();

    await vi.advanceTimersByTimeAsync(60 * 60 * 1000);
    scheduler.noteArrived("teacher", "t1");
    await vi.advanceTimersByTimeAsync(PANE_WAKE_DEBOUNCE_MS);
    expect(wake).toHaveBeenCalledTimes(PANE_WAKE_HOURLY_CAP + 1);
  });
});
