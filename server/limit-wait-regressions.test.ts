import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";

import { writeFileAtomic } from "./atomic.ts";
import { KeepGoing, KEEP_GOING_INTERVAL_MS } from "./keep-going.ts";
import { LimitWaits } from "./limit-wait.ts";
import { LimitWaitStore, type LimitWait } from "./limit-wait-store.ts";
import { PaneWakeScheduler, PANE_WAKE_DEBOUNCE_MS } from "./pane-wake.ts";
import { createUsageRefresh } from "./usage-refresh.ts";

const dirs: string[] = [];
const MINUTE = 60_000;
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllEnvs(); for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

function harness(options: Partial<ConstructorParameters<typeof LimitWaits>[0]> = {}) {
  const dir = mkdtempSync(join(tmpdir(), "limit-wait-regressions-")); dirs.push(dir);
  const state = { now: Date.parse("2026-10-28T00:00:00Z") };
  const selection = { instanceId: "claude", model: "opus", effort: "max" as const };
  const report = () => ({ observedAt: new Date(state.now).toISOString(), windows: [
    { id: "five_hour", usedPercent: 0, resetsAt: null }, { id: "seven_day", usedPercent: 20, resetsAt: null },
  ] });
  const usage = vi.fn<ConstructorParameters<typeof LimitWaits>[0]["usage"]>(async () => ({ report: report(), retryAt: state.now + 30_000 }));
  const dispatch = vi.fn(async (_row: LimitWait) => {});
  const changed = vi.fn();
  const released = vi.fn();
  const waits = new LimitWaits({ file: join(dir, "limit-waits.json"), now: () => state.now, deviceId: () => "pc-a",
    current: () => ({ threadId: "chat", controlKey: "request", busy: false }), usage, dispatch, changed, released, ...options });
  function arm(reset: number | null = state.now + 60 * MINUTE) {
    waits.track("bot", "chat", selection); waits.bind("chat", "turn");
    waits.failed("chat", "turn", reset, "message", ["five_hour", "seven_day"]);
    waits.settled("chat", "turn", false);
    return waits.store.all()[0]!;
  }
  async function resume() {
    state.now = waits.store.all()[0]!.nextCheckAt;
    await waits.tick();
    waits.track("bot", "chat", selection, waits.store.all()[0]!.id); waits.bind("chat", "resume");
  }
  return { dir, state, selection, report, usage, dispatch, changed, released, waits, arm, resume };
}

it.each(["linux", "darwin"] as const)("H2: only promises a Claude resume when the %s usage read can run", async (platform) => {
  vi.stubEnv("CLAUDE_CODE_OAUTH_TOKEN", "");
  const environment = platform === "linux" ? { CLAUDE_CODE_OAUTH_TOKEN: "fake-token" } : {};
  const request = vi.fn(async () => Response.json({ five_hour: { utilization: 0, resets_at: null }, seven_day: { utilization: 20, resets_at: null } }));
  const h = harness({ canRead: () => platform !== "darwin" || Boolean(environment.CLAUDE_CODE_OAUTH_TOKEN) });
  const refresh = createUsageRefresh({ platform, request: request as typeof fetch, now: () => h.state.now });
  h.usage.mockImplementation(() => refresh("claudeAgent", { instanceId: "claude", environment }));
  const row = h.arm();
  expect(h.waits.view(row).state).toBe(platform === "darwin" ? "manual" : "waiting");
  h.state.now = row.nextCheckAt;
  await h.waits.tick();
  expect(h.dispatch).toHaveBeenCalledTimes(platform === "darwin" ? 0 : 1);
  expect(request).toHaveBeenCalledTimes(platform === "darwin" ? 0 : 1);
});

it("H2: moves an existing wait to manual if its usage reader becomes unavailable", async () => {
  let readable = true;
  const h = harness({ canRead: () => readable }); const row = h.arm();
  readable = false;
  h.waits.reconcile();
  expect(h.waits.view(h.waits.store.get(row.id)!).state).toBe("manual");
  expect(h.waits.held("bot")).toBe(false);
  h.state.now = row.nextCheckAt; await h.waits.tick();
  expect(h.usage).not.toHaveBeenCalled();
});

it("M1: clears the manual instruction after a successful continuation", async () => {
  const h = harness(); h.arm(); await h.resume();
  expect(h.changed).toHaveBeenLastCalledWith(expect.anything(), expect.objectContaining({ state: "dispatching" }));
  h.waits.settled("chat", "resume", true);
  expect(h.waits.store.all()).toHaveLength(0);
  expect(h.changed.mock.calls.at(-1)![1].state).not.toBe("manual");
});

it("M2: marks a weekly-bound reset at creation", () => {
  const h = harness();
  const row = h.arm(h.state.now + 3 * 24 * 60 * MINUTE);
  expect(h.waits.view(row).weekly).toBe(true);
});

it("M3: a manual wait releases Keep Going and retained worker reports", async () => {
  vi.useFakeTimers();
  const h = harness(); h.arm(); await h.resume();
  h.waits.settled("chat", "resume", false);
  expect(h.waits.store.all()[0]!.state).toBe("manual");
  expect(h.waits.held("bot")).toBe(false);
  const kg = new KeepGoing({ file: join(h.dir, "keep-going.json"), now: () => h.state.now, deviceId: () => "pc-a", botThreadId: () => "chat", busy: () => false,
    queuedSends: () => false, wakesPaused: () => h.waits.held("bot"), packet: () => null, usage: async () => h.report(), livePanes: async () => 0,
    dispatch: vi.fn(), paused: vi.fn(), changed: vi.fn(), log: vi.fn() });
  kg.enable("bot", "chat", null); h.state.now += KEEP_GOING_INTERVAL_MS;
  expect(await kg.check("bot")).not.toEqual({ skipped: "wakes-paused" });
  const wake = vi.fn();
  const panes = new PaneWakeScheduler({ enabled: () => true, busy: () => h.waits.held("bot"), hasNotes: () => true, wake, warn: vi.fn() });
  panes.noteArrived("bot", "chat"); await vi.advanceTimersByTimeAsync(PANE_WAKE_DEBOUNCE_MS);
  expect(wake).toHaveBeenCalledTimes(1); panes.forgetBot("bot");
});

it("M4: cancels a claim when the resolved selection changes at the provider boundary", async () => {
  const h = harness(); const row = h.arm();
  h.dispatch.mockImplementationOnce(async () => {
    expect(h.waits.canDispatch(row.id, { ...h.selection, instanceId: "codex" })).toBe(false);
  });
  h.state.now = row.nextCheckAt; await h.waits.tick();
  expect(h.waits.store.get(row.id)).toBeUndefined();
  expect(h.waits.held("bot")).toBe(false);
});

it("L4: Cancel re-arms a worker-report burst that found the wait held", async () => {
  vi.useFakeTimers();
  const h = harness(); const row = h.arm(); const wake = vi.fn();
  const panes = new PaneWakeScheduler({ enabled: () => true, busy: () => h.waits.held("bot"), hasNotes: () => true, wake, warn: vi.fn() });
  h.released.mockImplementation((released: LimitWait) => panes.noteArrived(released.botId, released.threadId));
  panes.noteArrived("bot", "chat"); await vi.advanceTimersByTimeAsync(PANE_WAKE_DEBOUNCE_MS);
  expect(wake).not.toHaveBeenCalled(); h.waits.cancel("bot", row.id);
  await vi.advanceTimersByTimeAsync(PANE_WAKE_DEBOUNCE_MS);
  expect(wake).toHaveBeenCalledTimes(1); panes.forgetBot("bot");
});

it("L5: retains a known reset after an inconclusive post-wake read and retries at retryAt", async () => {
  const h = harness(); const row = h.arm(); h.state.now = row.nextCheckAt;
  h.usage.mockRejectedValueOnce(new Error("offline")); await h.waits.tick();
  expect(h.waits.store.get(row.id)).toMatchObject({ resetsAt: row.resetsAt, nextCheckAt: h.state.now + 30_000, probe: 0 });
  h.state.now += 30_000; await h.waits.tick();
  expect(h.dispatch).toHaveBeenCalledTimes(1);
});

it.each(['{"v":2,"rows":[]}', '{broken', '{"v":1,"rows":[{}]}'])("L9: starts empty with an unreadable wait file: %s", (content) => {
  const h = harness(); const file = join(h.dir, "corrupt.json"); writeFileSync(file, content);
  vi.spyOn(console, "error").mockImplementation(() => {});
  expect(new LimitWaitStore(file).all()).toEqual([]);
  expect(console.error).toHaveBeenCalled();
});

it.each(["cancel", "reconcile"])("L10: a failed %s in the store listener still reaches the broadcast switch", (operation) => {
  const source = readFileSync(new URL("./index.ts", import.meta.url), "utf8");
  // Importing index.ts boots the server; execute only the listener's prelude.
  const prelude = source.split("store.onChange((change) => {")[1]!.split("  switch (change.type) {")[0]!;
  const run = new Function("change", "store", "limitWaits", "console", `${prelude}\nreturn 'broadcast';`);
  const h = harness(); const file = join(h.dir, "limit-waits.json");
  let fail = false;
  const store = new LimitWaitStore(file, (...args) => { if (fail) throw new Error("disk full"); writeFileAtomic(...args); });
  let valid = true;
  const tracked = harness({ store, current: () => valid ? { threadId: "chat", controlKey: "request", busy: false } : null });
  tracked.arm(); fail = true;
  if (operation === "reconcile") valid = false;
  vi.spyOn(console, "error").mockImplementation(() => {});
  const change = operation === "cancel" ? { type: "message", threadId: "chat", message: { role: "user" } } : { type: "bot" };
  expect(run(change, { botByThread: () => ({ id: "bot" }) }, tracked.waits, console)).toBe("broadcast");
  expect(tracked.waits.held("bot")).toBe(false);
});
