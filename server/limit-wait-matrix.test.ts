import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import { writeFileAtomic } from "./atomic.ts";
import { KeepGoing, KEEP_GOING_INTERVAL_MS } from "./keep-going.ts";
import { LimitWaits } from "./limit-wait.ts";
import { LimitWaitStore, type LimitWait } from "./limit-wait-store.ts";
import { PaneWakeScheduler } from "./pane-wake.ts";
import { TASK_RESUME_PROMPT } from "./turn-context.ts";

const MINUTE = 60_000;
const START = Date.parse("2026-10-28T00:00:00Z");
const selection = { instanceId: "claude", model: "opus", effort: "max" as const };
type Deps = ConstructorParameters<typeof LimitWaits>[0];
type Result = Awaited<ReturnType<Deps["usage"]>>;
const dirs: string[] = [];
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

function harness(store?: LimitWaitStore) {
  const dir = mkdtempSync(join(tmpdir(), "limit-wait-matrix-"));
  dirs.push(dir);
  const state = { now: START, device: "pc-a", threadId: "chat", controlKey: "request-and-account", busy: false, exists: true };
  const report = () => ({ observedAt: new Date(state.now).toISOString(), windows: [
    { id: "five_hour", usedPercent: 0, resetsAt: null as number | null },
    { id: "seven_day", usedPercent: 50, resetsAt: null as number | null },
  ] });
  const usage = vi.fn(async (_row: LimitWait): Promise<Result> => ({ report: report(), retryAt: state.now + 30_000 }));
  const dispatch = vi.fn(async (_row: LimitWait, _prompt: string) => {});
  const changed = vi.fn();
  const deps: Deps = { file: join(dir, "limit-waits.json"), ...(store ? { store } : {}), now: () => state.now,
    deviceId: () => state.device, current: () => state.exists ? state : null, usage, dispatch, changed };
  let waits = new LimitWaits(deps);
  function arm(reset: number | null = state.now + 60 * MINUTE, waitId?: string, origin: LimitWait["origin"] = {}) {
    waits.track("bot", "chat", selection, waitId, origin);
    const turn = `turn-${waits.store.all()[0]?.attempts ?? 0}`;
    waits.bind("chat", turn);
    waits.failed("chat", turn, reset, "limit-row", ["five_hour", "seven_day"]);
    waits.settled("chat", turn, false);
    return waits.store.all()[0]!;
  }
  return { dir, state, usage, dispatch, changed, report, arm, get waits() { return waits; },
    reopen() { waits = new LimitWaits({ ...deps, store: undefined }); },
    due() { state.now = waits.store.all()[0]!.nextCheckAt; } };
}

describe("durable usage waits", () => {
  it("never reads or sends before the margin and coalesces late pulses", async () => {
    const h = harness();
    const row = h.arm();
    h.state.now = row.nextCheckAt - 1;
    await h.waits.tick();
    expect(h.usage).not.toHaveBeenCalled();
    h.state.now += 5 * 60 * MINUTE;
    await Promise.all([h.waits.tick(), h.waits.tick(), h.waits.tick()]);
    expect(h.dispatch).toHaveBeenCalledTimes(1);
    expect(h.dispatch).toHaveBeenCalledWith(expect.objectContaining({ id: row.id, selection, threadId: "chat", attempts: 1 }), TASK_RESUME_PROMPT);
  });

  it("defers the same row to a spent weekly window without spending a continuation", async () => {
    const h = harness();
    const row = h.arm();
    const weekly = START + 7 * 24 * 60 * MINUTE;
    h.due();
    const report = h.report();
    report.windows[1] = { id: "seven_day", usedPercent: 100, resetsAt: weekly };
    h.usage.mockResolvedValueOnce({ report, retryAt: h.state.now + 30_000 });
    await h.waits.tick();
    expect(h.waits.store.all()).toHaveLength(1);
    expect(h.waits.store.get(row.id)).toMatchObject({ resetsAt: weekly, nextCheckAt: weekly + 30_000, attempts: 0, weekly: true });
    expect(h.waits.view(h.waits.store.get(row.id)!)).toMatchObject({ weekly: true, resumesAt: weekly + 30_000 });
    expect(h.dispatch).not.toHaveBeenCalled();
    h.reopen();
    h.due();
    await h.waits.tick();
    expect(h.dispatch).toHaveBeenCalledTimes(1);
  });

  it("probes unknown resets at 5, 15, 30, 60, 120 and 240 minutes across restarts, then goes manual", async () => {
    const h = harness();
    h.arm(null);
    h.usage.mockImplementation(async () => ({ error: "offline", retryAt: h.state.now + 30_000 }));
    for (const [index, minutes] of [5, 15, 30, 60, 120, 240].entries()) {
      h.reopen();
      expect(h.waits.store.all()[0]).toMatchObject({ probe: index, nextCheckAt: START + minutes * MINUTE });
      h.state.now = START + minutes * MINUTE;
      await h.waits.tick();
    }
    expect(h.waits.store.all()[0]).toMatchObject({ probe: 6, state: "manual" });
    h.state.now += 24 * 60 * MINUTE;
    await h.waits.tick();
    expect(h.usage).toHaveBeenCalledTimes(6);
    expect(h.dispatch).not.toHaveBeenCalled();
  });

  it("does one overdue probe after sleep and respects the provider retryAt", async () => {
    const h = harness();
    h.arm(null);
    h.state.now += 24 * 60 * MINUTE;
    const retryAt = h.state.now + 60 * MINUTE;
    h.usage.mockResolvedValue({ error: "throttled", retryAt });
    await h.waits.tick();
    await h.waits.tick();
    expect(h.usage).toHaveBeenCalledTimes(1);
    expect(h.waits.store.all()[0]!.nextCheckAt).toBe(retryAt);
  });

  it.each(["stale", "future", "missing", "errored", "empty", "invalid", "spent-unknown"])("blocks a %s usage read", async (kind) => {
    const h = harness();
    h.arm();
    h.due();
    const report = h.report();
    if (kind === "stale") report.observedAt = new Date(h.state.now - 1).toISOString();
    if (kind === "future") report.observedAt = new Date(h.state.now + 1).toISOString();
    if (kind === "missing") report.windows.pop();
    if (kind === "empty") report.windows = [];
    if (kind === "invalid") report.windows[0]!.usedPercent = NaN;
    if (kind === "spent-unknown") report.windows[1]!.usedPercent = 100;
    h.usage.mockResolvedValueOnce({ ...(kind === "errored" ? { error: "retained after failure" } : {}), report, retryAt: h.state.now + 30_000 });
    await h.waits.tick();
    expect(h.dispatch).not.toHaveBeenCalled();
    expect(h.waits.store.all()[0]).toMatchObject({ state: "waiting", resetsAt: null });
  });

  it("blocks missing model windows and considers every applicable reported window", async () => {
    const h = harness();
    const row = h.arm();
    h.waits.store.set({ ...row, requiredWindows: [...row.requiredWindows, "seven_day_opus"] });
    h.due();
    await h.waits.tick();
    expect(h.dispatch).not.toHaveBeenCalled();
    h.due();
    const report = h.report();
    report.windows.push({ id: "seven_day_opus", usedPercent: 100, resetsAt: h.state.now + 24 * 60 * MINUTE });
    h.usage.mockResolvedValueOnce({ report, retryAt: h.state.now + 30_000 });
    await h.waits.tick();
    expect(h.dispatch).not.toHaveBeenCalled();
    expect(h.waits.store.all()[0]!.weekly).toBe(true);
  });

  it("does not apply a Sonnet-only window to an Opus continuation", async () => {
    const h = harness();
    h.arm();
    h.due();
    const report = h.report();
    report.windows.push({ id: "seven_day_sonnet", usedPercent: 100, resetsAt: null });
    h.usage.mockResolvedValueOnce({ report, retryAt: h.state.now + 30_000 });
    await h.waits.tick();
    expect(h.dispatch).toHaveBeenCalledTimes(1);
  });

  it("retains discovered bucket requirements when a later read omits one", async () => {
    const h = harness(); h.arm(); h.due();
    const report = h.report();
    report.windows.push({ id: "other:five_hour", usedPercent: 100, resetsAt: h.state.now + 60 * MINUTE });
    h.usage.mockResolvedValueOnce({ report, retryAt: h.state.now + 30_000 });
    await h.waits.tick(); h.reopen(); h.due();
    await h.waits.tick();
    expect(h.dispatch).not.toHaveBeenCalled();
  });

  it("turns an asynchronous dispatch failure into manual recovery", async () => {
    const h = harness(); const row = h.arm(); h.due();
    await h.waits.tick();
    h.waits.dispatchFailed(row.id);
    expect(h.waits.store.get(row.id)?.state).toBe("manual");
    await h.waits.tick();
    expect(h.dispatch).toHaveBeenCalledTimes(1);
  });

  it("counts re-limits on the same request and stops after three continuations", async () => {
    const h = harness();
    const original = h.arm();
    for (let attempt = 1; attempt <= 3; attempt++) {
      h.due();
      await h.waits.tick();
      expect(h.dispatch).toHaveBeenCalledTimes(attempt);
      h.arm(h.state.now + 60 * MINUTE, original.id);
      expect(h.waits.store.all()).toHaveLength(1);
      expect(h.waits.store.all()[0]).toMatchObject({ id: original.id, messageId: original.messageId, createdAt: original.createdAt, expiresAt: original.expiresAt, attempts: attempt });
      h.reopen();
    }
    expect(h.waits.store.all()[0]!.state).toBe("manual");
    h.due();
    await h.waits.tick();
    expect(h.dispatch).toHaveBeenCalledTimes(3);
  });

  it("expires eight days after the original interruption", async () => {
    const h = harness();
    const row = h.arm();
    h.reopen();
    h.state.now = row.expiresAt;
    await h.waits.tick();
    expect(h.waits.held("bot")).toBe(false);
    expect(h.usage).not.toHaveBeenCalled();
    expect(h.dispatch).not.toHaveBeenCalled();
    expect(h.changed).toHaveBeenLastCalledWith(expect.anything(), expect.objectContaining({ state: "manual" }));
  });

  it("does not promise a reset beyond the request expiry", async () => {
    const h = harness();
    const row = h.arm(START + 9 * 24 * 60 * MINUTE);
    expect(row.state).toBe("manual");
    expect(h.changed).toHaveBeenLastCalledWith(expect.anything(), expect.objectContaining({ state: "manual" }));
    await h.waits.tick();
    expect(h.usage).not.toHaveBeenCalled();
  });

  it("recovers a dispatching row as manual and never resends an ambiguous intent", async () => {
    const h = harness();
    h.arm(); h.due();
    await h.waits.tick();
    expect(JSON.parse(readFileSync(join(h.dir, "limit-waits.json"), "utf8")).rows[0].state).toBe("dispatching");
    h.reopen();
    expect(h.waits.store.all()[0]!.state).toBe("manual");
    await h.waits.tick();
    expect(h.dispatch).toHaveBeenCalledTimes(1);
  });

  it.each(["message", "stop-idle", "model", "effort", "engine", "account", "task", "delete"])("prevents dispatch after %s during a usage read", async (mutation) => {
    const h = harness();
    h.arm(); h.due();
    let resolve!: (result: Result) => void;
    h.usage.mockReturnValueOnce(new Promise<Result>((done) => { resolve = done; }));
    const checking = h.waits.tick();
    if (mutation === "message" || mutation === "stop-idle") h.waits.cancel("bot");
    else if (mutation === "task") h.state.threadId = "other-task";
    else if (mutation === "delete") h.state.exists = false;
    else h.state.controlKey = `changed-${mutation}`;
    resolve({ report: h.report(), retryAt: h.state.now + 30_000 });
    await checking;
    expect(h.dispatch).not.toHaveBeenCalled();
  });

  it("a different owner never reads, dispatches or cancels the wait", async () => {
    const h = harness();
    const row = h.arm(); h.reopen(); h.due();
    h.state.device = "pc-b";
    h.waits.cancel("bot", row.id);
    await h.waits.tick();
    expect(h.waits.store.get(row.id)?.ownerDeviceId).toBe("pc-a");
    expect(h.usage).not.toHaveBeenCalled();
    expect(h.dispatch).not.toHaveBeenCalled();
  });

  it("holds a wait if another turn claims the bot during the usage read", async () => {
    const h = harness(); h.arm(); h.due();
    h.usage.mockImplementationOnce(async () => { h.state.busy = true; return { report: h.report(), retryAt: h.state.now + 30_000 }; });
    await h.waits.tick();
    expect(h.dispatch).not.toHaveBeenCalled();
    expect(h.waits.store.all()[0]).toMatchObject({ state: "waiting", attempts: 0 });
  });

  it.each(["arm", "claim"])("sends nothing and projects manual after a failed %s write", async (stage) => {
    const dir = mkdtempSync(join(tmpdir(), "limit-wait-write-")); dirs.push(dir);
    let fail = stage === "arm";
    const write = vi.fn<typeof writeFileAtomic>((...args) => { if (fail) throw new Error("disk full"); writeFileAtomic(...args); });
    const h = harness(new LimitWaitStore(join(dir, "limit-waits.json"), write));
    vi.spyOn(console, "error").mockImplementation(() => {});
    h.arm();
    if (stage === "claim") { fail = true; h.due(); await h.waits.tick(); }
    expect(h.changed).toHaveBeenLastCalledWith(expect.anything(), expect.objectContaining({ state: "manual" }));
    expect(h.dispatch).not.toHaveBeenCalled();
    expect(h.waits.held("bot")).toBe(true);
    await h.waits.tick();
    expect(h.dispatch).not.toHaveBeenCalled();
  });

  it("persists its intent before dispatch and checks selection and cancellation at the provider boundary", async () => {
    const h = harness();
    const row = h.arm(); h.due();
    h.dispatch.mockImplementationOnce(async (claimed) => {
      expect(JSON.parse(readFileSync(join(h.dir, "limit-waits.json"), "utf8")).rows[0]).toMatchObject({ id: claimed.id, state: "dispatching", attempts: 1 });
      expect(h.waits.canDispatch(row.id, selection)).toBe(true);
      expect(h.waits.canDispatch(row.id, { ...selection, effort: "high" })).toBe(false);
      h.waits.cancel("bot");
      expect(h.waits.canDispatch(row.id, selection)).toBe(false);
    });
    await h.waits.tick();
  });

  it("does not dispatch when cancellation persistence fails during a usage read", async () => {
    const dir = mkdtempSync(join(tmpdir(), "limit-wait-cancel-write-")); dirs.push(dir);
    let fail = false;
    const h = harness(new LimitWaitStore(join(dir, "limit-waits.json"), (...args) => { if (fail) throw new Error("disk full"); writeFileAtomic(...args); }));
    vi.spyOn(console, "error").mockImplementation(() => {});
    h.arm(); h.due();
    let resolve!: (value: Result) => void;
    h.usage.mockReturnValueOnce(new Promise<Result>((done) => { resolve = done; }));
    const checking = h.waits.tick();
    fail = true;
    expect(() => h.waits.cancel("bot")).toThrow("cancellation could not be saved");
    fail = false;
    resolve({ report: h.report(), retryAt: h.state.now + 30_000 });
    await checking;
    expect(h.dispatch).not.toHaveBeenCalled();
    h.waits.cancel("bot");
    expect(h.waits.held("bot")).toBe(false);
  });

  it("holds Keep Going and pane wakes while coalescing reports into the continuation", async () => {
    vi.useFakeTimers();
    const h = harness();
    h.arm();
    const kgDispatch = vi.fn();
    const kg = new KeepGoing({ file: join(h.dir, "keep-going.json"), now: () => h.state.now, deviceId: () => "pc-a", botThreadId: () => "chat", busy: () => false,
      queuedSends: () => false, wakesPaused: () => h.waits.held("bot"), packet: () => null, usage: async () => h.report(), livePanes: async () => 0,
      dispatch: kgDispatch, paused: vi.fn(), changed: vi.fn(), log: vi.fn() });
    kg.enable("bot", "chat", null);
    h.state.now += KEEP_GOING_INTERVAL_MS;
    expect(await kg.check("bot")).toEqual({ skipped: "wakes-paused" });
    const wake = vi.fn();
    const panes = new PaneWakeScheduler({ enabled: () => true, busy: () => h.waits.held("bot"), hasNotes: () => true, wake, warn: vi.fn() });
    panes.noteArrived("bot", "chat"); panes.noteArrived("bot", "chat");
    await vi.advanceTimersByTimeAsync(3_001);
    expect(wake).not.toHaveBeenCalled();
    expect(kgDispatch).not.toHaveBeenCalled();
    h.due(); await h.waits.tick();
    expect(h.dispatch).toHaveBeenCalledTimes(1);
    panes.forgetBot("bot");
  });
});
