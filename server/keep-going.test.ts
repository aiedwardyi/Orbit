import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";

import { estimateContextTokens } from "./context-compaction.ts";
import {
  inBenchWindow,
  KEEP_GOING_DAILY_CAP,
  KEEP_GOING_INTERVAL_MS,
  KEEP_GOING_RULES,
  KEEP_GOING_USAGE_FRESH_MS,
  KeepGoing,
  keepGoingTurnOptions,
  type KeepGoingDeps,
  type KeepGoingSkip,
} from "./keep-going.ts";
import type { RateLimitsReport } from "./rate-limits-store.ts";
import type { TaskResumePacket } from "./task-state.ts";

// 12:00 in Seoul
const NOON_KST = Date.parse("2026-10-20T03:00:00Z");
type Plan = TaskResumePacket["plan"];

function packetWith(plan: Plan, blockers: TaskResumePacket["blockers"] = []): TaskResumePacket {
  return {
    v: 1, threadId: "t1", botId: "b1", goal: "ship it", plan, completed: [], evidence: [], artifacts: [], blockers,
    nextAction: "", updatedAt: 0, updatedBy: "bot", flushReason: "progress", turnsAtWrite: 0,
  };
}

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "keep-going-"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

function harness(overrides: { deviceId?: string; file?: string } = {}) {
  const state = {
    now: NOON_KST,
    deviceId: overrides.deviceId ?? "pc-a",
    threadId: "t1" as string | null,
    busy: false,
    queued: false,
    wakesPaused: false,
    packet: packetWith([{ step: "Write tests", status: "pending" }, { step: "Build UI", status: "pending" }]) as TaskResumePacket | null,
    usage: { windows: [{ id: "five_hour", usedPercent: 40, resetsAt: null }], observedAt: new Date(NOON_KST - 60_000).toISOString() } as RateLimitsReport | null,
    panes: 0 as number | null,
    dispatchError: null as Error | null,
  };
  const dispatch = vi.fn(async (..._args: Parameters<KeepGoingDeps["dispatch"]>) => {
    if (state.dispatchError) throw state.dispatchError;
  });
  const paused = vi.fn();
  const changed = vi.fn();
  const livePanes = vi.fn(async () => state.panes);
  const deps: KeepGoingDeps = {
    deviceId: () => state.deviceId,
    botThreadId: () => state.threadId,
    busy: () => state.busy,
    queuedSends: () => state.queued,
    wakesPaused: () => state.wakesPaused,
    packet: () => state.packet,
    usage: async () => state.usage,
    livePanes,
    dispatch,
    paused,
    changed,
    log: () => {},
    file: overrides.file ?? join(dir, "keep-going.json"),
    now: () => state.now,
  };
  const keepGoing = new KeepGoing(deps);
  return { state, deps, dispatch, paused, changed, livePanes, keepGoing };
}

function setPlan(h: ReturnType<typeof harness>, plan: Plan) {
  h.state.packet = packetWith(plan);
}

describe("KeepGoing gate", () => {
  const cases: Array<[KeepGoingSkip, (h: ReturnType<typeof harness>) => void]> = [
    ["off", (h) => h.keepGoing.disable("b1")],
    ["not-owner", (h) => { h.state.deviceId = "pc-b"; }],
    ["paused", (h) => h.keepGoing.pause("b1", "bot-paused")],
    ["wakes-paused", (h) => { h.state.wakesPaused = true; }],
    ["task-changed", (h) => { h.state.threadId = "t2"; }],
    ["busy", (h) => { h.state.busy = true; }],
    ["queued", (h) => { h.state.queued = true; }],
    ["bench", (h) => { h.state.now = Date.parse("2026-10-20T19:00:00Z"); }],
    ["no-task-record", (h) => { h.state.packet = null; }],
    ["blockers", (h) => { h.state.packet = packetWith(h.state.packet!.plan, [{ kind: "input", note: "which repo?" }]); }],
    ["no-approved-step", (h) => setPlan(h, [{ step: "Write tests", status: "done" }, { step: "Build UI", status: "done" }])],
    ["usage-unknown", (h) => { h.state.usage = null; }],
    ["usage-stale", (h) => { h.state.usage = { ...h.state.usage!, observedAt: new Date(NOON_KST - 2 * 60 * 60_000 - 1).toISOString() }; }],
    ["usage-low", (h) => { h.state.usage = { ...h.state.usage!, windows: [...h.state.usage!.windows, { id: "seven_day", usedPercent: 80, resetsAt: null }] }; }],
    ["panes-unknown", (h) => { h.state.panes = null; }],
    ["workers-running", (h) => { h.state.panes = 1; }],
  ];

  it.each(cases)("skips with %s and starts nothing", async (reason, arrange) => {
    const h = harness();
    h.keepGoing.enable("b1", "t1", h.state.packet);
    arrange(h);
    await expect(h.keepGoing.check("b1")).resolves.toEqual({ skipped: reason });
    expect(h.dispatch).not.toHaveBeenCalled();
  });

  it("skips at the daily cap", async () => {
    const h = harness();
    h.keepGoing.enable("b1", "t1", h.state.packet);
    for (let i = 0; i < KEEP_GOING_DAILY_CAP; i++) {
      h.keepGoing.enable("b1", "t1", h.state.packet);
      await expect(h.keepGoing.check("b1")).resolves.toEqual({ dispatched: "Write tests" });
      h.state.now += 60_000;
    }
    await expect(h.keepGoing.check("b1")).resolves.toEqual({ skipped: "daily-cap" });
    expect(h.dispatch).toHaveBeenCalledTimes(KEEP_GOING_DAILY_CAP);
    // the next Seoul day starts a new count
    h.state.now = Date.parse("2026-10-20T20:00:00Z");
    h.state.usage = { ...h.state.usage!, observedAt: new Date(h.state.now).toISOString() };
    h.keepGoing.enable("b1", "t1", h.state.packet);
    await expect(h.keepGoing.check("b1")).resolves.toEqual({ dispatched: "Write tests" });
  });

  it("starts the first approved pending step when every gate passes", async () => {
    const h = harness();
    h.keepGoing.enable("b1", "t1", h.state.packet);
    await expect(h.keepGoing.check("b1")).resolves.toEqual({ dispatched: "Write tests" });
    expect(h.dispatch).toHaveBeenCalledTimes(1);
    expect(h.dispatch.mock.calls[0]![1]).toContain('"Write tests"');
    expect(h.keepGoing.receipts("b1")).toEqual([
      expect.objectContaining({ at: NOON_KST, step: "Write tests", outcome: "pending" }),
    ]);
  });
});

describe("KeepGoing dispatch", () => {
  it("marks the turn unattended and resumes the current chat", async () => {
    const h = harness();
    h.keepGoing.enable("b1", "t1", h.state.packet);
    await h.keepGoing.check("b1");
    expect(h.dispatch.mock.calls[0]![2]).toEqual({ threadId: "t1", cardContinuation: true, unattended: true, keepGoingWake: true });
    expect(keepGoingTurnOptions("t9").unattended).toBe(true);
    expect(keepGoingTurnOptions("t9")).not.toHaveProperty("automationSource");
  });

  it("drops the receipt when the bot turns out to be busy at dispatch", async () => {
    const h = harness();
    h.keepGoing.enable("b1", "t1", h.state.packet);
    h.state.dispatchError = Object.assign(new Error("busy"), { code: "BOT_BUSY" });
    await expect(h.keepGoing.check("b1")).resolves.toEqual({ skipped: "busy" });
    expect(h.keepGoing.receipts("b1")).toEqual([]);
  });
});

describe("KeepGoing approval receipt", () => {
  it("never counts a step the bot added after approval until the user approves again", async () => {
    const h = harness();
    setPlan(h, [{ step: "Write tests", status: "pending" }]);
    h.keepGoing.enable("b1", "t1", h.state.packet);
    setPlan(h, [{ step: "Write tests", status: "done" }, { step: "Push to main", status: "pending" }]);
    await expect(h.keepGoing.check("b1")).resolves.toEqual({ skipped: "no-approved-step" });
    expect(h.dispatch).not.toHaveBeenCalled();

    h.keepGoing.disable("b1");
    h.keepGoing.enable("b1", "t1", h.state.packet);
    await expect(h.keepGoing.check("b1")).resolves.toEqual({ dispatched: "Push to main" });
  });

  it("matches approved steps by normalized text", async () => {
    const h = harness();
    setPlan(h, [{ step: "  Write   Tests ", status: "pending" }]);
    h.keepGoing.enable("b1", "t1", h.state.packet);
    setPlan(h, [{ step: "write tests", status: "pending" }]);
    await expect(h.keepGoing.check("b1")).resolves.toEqual({ dispatched: "write tests" });
  });

  it("does not approve steps that were already done or active", async () => {
    const h = harness();
    setPlan(h, [{ step: "Write tests", status: "active" }]);
    h.keepGoing.enable("b1", "t1", h.state.packet);
    setPlan(h, [{ step: "Write tests", status: "pending" }]);
    await expect(h.keepGoing.check("b1")).resolves.toEqual({ skipped: "no-approved-step" });
  });
});

describe("KeepGoing failure pause", () => {
  it("pauses after two dispatches in a row without progress and says so once", async () => {
    const h = harness();
    h.keepGoing.enable("b1", "t1", h.state.packet);
    await expect(h.keepGoing.check("b1")).resolves.toEqual({ dispatched: "Write tests" });
    h.state.now += KEEP_GOING_INTERVAL_MS;
    await expect(h.keepGoing.check("b1")).resolves.toEqual({ dispatched: "Write tests" });
    h.state.now += KEEP_GOING_INTERVAL_MS;
    await expect(h.keepGoing.check("b1")).resolves.toEqual({ skipped: "paused" });
    expect(h.dispatch).toHaveBeenCalledTimes(2);
    expect(h.paused).toHaveBeenCalledTimes(1);
    expect(h.paused).toHaveBeenCalledWith("b1", "t1");
    expect(h.keepGoing.view("b1")).toEqual({ paused: "no-progress" });
    expect(h.keepGoing.receipts("b1").map((receipt) => receipt.outcome)).toEqual(["no-progress", "no-progress"]);

    h.state.now += KEEP_GOING_INTERVAL_MS;
    await expect(h.keepGoing.check("b1")).resolves.toEqual({ skipped: "paused" });
    expect(h.paused).toHaveBeenCalledTimes(1);
  });

  it("counts a step moving to active or a launched worker as progress", async () => {
    const h = harness();
    h.keepGoing.enable("b1", "t1", h.state.packet);
    await h.keepGoing.check("b1");
    setPlan(h, [{ step: "Write tests", status: "active" }, { step: "Build UI", status: "pending" }]);
    h.state.now += KEEP_GOING_INTERVAL_MS;
    await expect(h.keepGoing.check("b1")).resolves.toEqual({ dispatched: "Build UI" });
    h.state.panes = 1;
    h.state.now += KEEP_GOING_INTERVAL_MS;
    await expect(h.keepGoing.check("b1")).resolves.toEqual({ skipped: "workers-running" });
    h.state.panes = 0;
    h.state.now += KEEP_GOING_INTERVAL_MS;
    await expect(h.keepGoing.check("b1")).resolves.toEqual({ dispatched: "Build UI" });
    expect(h.keepGoing.receipts("b1").map((receipt) => receipt.outcome)).toEqual(["progress", "progress", "pending"]);
    expect(h.paused).not.toHaveBeenCalled();
  });

  it("counts failed dispatches toward the pause and starts fresh after re-approval", async () => {
    const h = harness();
    h.keepGoing.enable("b1", "t1", h.state.packet);
    h.state.dispatchError = new Error("engine down");
    await h.keepGoing.check("b1");
    await h.keepGoing.check("b1");
    await expect(h.keepGoing.check("b1")).resolves.toEqual({ skipped: "paused" });
    h.state.dispatchError = null;
    h.keepGoing.disable("b1");
    h.state.now += 1;
    h.keepGoing.enable("b1", "t1", h.state.packet);
    expect(h.keepGoing.view("b1")).toEqual({ paused: null });
    await expect(h.keepGoing.check("b1")).resolves.toEqual({ dispatched: "Write tests" });
  });

  it("keeps receipts across a restart", async () => {
    const h = harness();
    h.keepGoing.enable("b1", "t1", h.state.packet);
    await h.keepGoing.check("b1");
    const reloaded = new KeepGoing(h.deps);
    expect(reloaded.receipts("b1")).toEqual([expect.objectContaining({ step: "Write tests", outcome: "pending" })]);
  });
});

describe("KeepGoing off latch", () => {
  it("beats a check already waiting on the terminal bridge", async () => {
    const h = harness();
    h.keepGoing.enable("b1", "t1", h.state.packet);
    let answer!: (count: number) => void;
    h.livePanes.mockImplementationOnce(() => new Promise((resolve) => { answer = resolve; }));
    const inFlight = h.keepGoing.check("b1");
    await vi.waitFor(() => expect(answer).toBeTypeOf("function"));
    h.keepGoing.disable("b1");
    answer(0);
    await expect(inFlight).resolves.toEqual({ skipped: "off" });
    expect(h.dispatch).not.toHaveBeenCalled();
    expect(h.keepGoing.receipts("b1")).toEqual([]);
  });

  it("survives a restart and a bot's pause request", async () => {
    const h = harness();
    h.keepGoing.enable("b1", "t1", h.state.packet);
    h.keepGoing.disable("b1");
    const reloaded = new KeepGoing(h.deps);
    expect(reloaded.view("b1")).toBeNull();
    await expect(reloaded.check("b1")).resolves.toEqual({ skipped: "off" });

    h.keepGoing.enable("b1", "t1", h.state.packet);
    h.keepGoing.pause("b1", "bot-paused");
    expect(new KeepGoing(h.deps).view("b1")).toEqual({ paused: "bot-paused" });
  });
});

describe("KeepGoing bench window", () => {
  const zone = process.env.TZ;
  afterEach(() => {
    if (zone === undefined) delete process.env.TZ;
    else process.env.TZ = zone;
  });

  it.each(["America/Los_Angeles", "UTC", "Asia/Seoul"])("uses Seoul time when this PC is in %s", (tz) => {
    process.env.TZ = tz;
    expect(inBenchWindow(Date.parse("2026-10-20T18:44:00Z"))).toBe(false);
    expect(inBenchWindow(Date.parse("2026-10-20T18:45:00Z"))).toBe(true);
    expect(inBenchWindow(Date.parse("2026-10-20T19:59:00Z"))).toBe(true);
    expect(inBenchWindow(Date.parse("2026-10-20T20:00:00Z"))).toBe(false);
    expect(inBenchWindow(Date.parse("2026-10-20T03:50:00Z"))).toBe(false);
  });
});

describe("KeepGoing two PCs", () => {
  it("never dispatches from a PC that did not turn it on", async () => {
    const file = join(dir, "shared.json");
    const owner = harness({ deviceId: "pc-a", file });
    owner.keepGoing.enable("b1", "t1", owner.state.packet);
    const other = harness({ deviceId: "pc-b", file });
    expect(other.keepGoing.view("b1")).toEqual({ paused: "other-pc" });
    other.keepGoing.tick();
    other.state.now += KEEP_GOING_INTERVAL_MS;
    other.keepGoing.tick();
    await vi.waitFor(() => expect(other.livePanes).not.toHaveBeenCalled());
    await expect(other.keepGoing.check("b1")).resolves.toEqual({ skipped: "not-owner" });
    expect(other.dispatch).not.toHaveBeenCalled();
    await expect(owner.keepGoing.check("b1")).resolves.toEqual({ dispatched: "Write tests" });
  });
});

describe("KeepGoing tick", () => {
  it("checks each bot once per interval and never right after a restart", async () => {
    const h = harness();
    h.keepGoing.enable("b1", "t1", h.state.packet);
    h.state.now += KEEP_GOING_INTERVAL_MS - 1;
    h.keepGoing.tick();
    expect(h.livePanes).not.toHaveBeenCalled();
    h.state.now += 1;
    h.keepGoing.tick();
    await vi.waitFor(() => expect(h.dispatch).toHaveBeenCalledTimes(1));

    const restarted = new KeepGoing(h.deps);
    h.state.now += KEEP_GOING_INTERVAL_MS * 3;
    restarted.tick();
    await Promise.resolve();
    expect(h.dispatch).toHaveBeenCalledTimes(1);
  });
});

describe("KeepGoing rules block", () => {
  it("rides the turn instructions only while the switch is on", () => {
    const h = harness();
    expect(h.keepGoing.rules("b1")).toBe("");
    h.keepGoing.enable("b1", "t1", h.state.packet);
    expect(h.keepGoing.rules("b1")).toBe(` ${KEEP_GOING_RULES}`);
    expect(KEEP_GOING_RULES).toContain("Ask only for logins, deletes, money, or push/merge/release rules.");
    expect(estimateContextTokens([{ text: KEEP_GOING_RULES }]) - 6).toBeLessThanOrEqual(100);
    h.keepGoing.disable("b1");
    expect(h.keepGoing.rules("b1")).toBe("");
  });
});

describe("KeepGoing set_keep_going", () => {
  it("refuses on from a turn the user did not start", () => {
    const h = harness();
    h.keepGoing.turnStarted("b1", "t1", false);
    expect(h.keepGoing.fromTool("b1", "t1", true, h.state.packet)).toEqual({ error: expect.stringContaining("user") });
    h.keepGoing.turnStarted("b1", "t1", true);
    expect(h.keepGoing.fromTool("b1", "t2", true, h.state.packet)).toHaveProperty("error");
    expect(h.keepGoing.view("b1")).toBeNull();
  });

  it("snapshots the approval from a turn the user started", async () => {
    const h = harness();
    h.keepGoing.turnStarted("b1", "t1", true);
    expect(h.keepGoing.fromTool("b1", "t1", true, h.state.packet)).toEqual({ ok: true });
    expect(h.keepGoing.view("b1")).toEqual({ paused: null });
    setPlan(h, [{ step: "Write tests", status: "done" }, { step: "Build UI", status: "pending" }, { step: "Push to main", status: "pending" }]);
    await expect(h.keepGoing.check("b1")).resolves.toEqual({ dispatched: "Build UI" });
    setPlan(h, [{ step: "Build UI", status: "done" }, { step: "Push to main", status: "pending" }]);
    await expect(h.keepGoing.check("b1")).resolves.toEqual({ skipped: "no-approved-step" });
  });

  it("turns off from any turn", () => {
    const h = harness();
    h.keepGoing.enable("b1", "t1", h.state.packet);
    h.keepGoing.turnStarted("b1", "t9", false);
    expect(h.keepGoing.fromTool("b1", "t9", false, null)).toEqual({ ok: true });
    expect(h.keepGoing.view("b1")).toBeNull();
  });
});

describe("KeepGoing dispatch failure", () => {
  it("logs the failure only and reports it as a skip", async () => {
    const log = vi.fn();
    const h = harness();
    h.deps.log = log;
    h.keepGoing.enable("b1", "t1", h.state.packet);
    h.state.dispatchError = new Error("engine down");
    await expect(h.keepGoing.check("b1")).resolves.toEqual({ skipped: "dispatch-failed" });
    expect(log.mock.calls.map(([line]) => line)).toEqual(["keep going: b1 dispatch failed: engine down"]);
    expect(h.keepGoing.receipts("b1")).toEqual([expect.objectContaining({ outcome: "failed" })]);
  });
});

describe("KeepGoing review regressions", () => {
  it("waits for usage before dispatch", async () => {
    const h = harness();
    h.keepGoing.enable("b1", "t1", h.state.packet);
    let answer!: (report: RateLimitsReport | null) => void;
    h.deps.usage = () => new Promise((resolve) => { answer = resolve; });
    const check = h.keepGoing.check("b1");
    expect(h.dispatch).not.toHaveBeenCalled();
    await vi.waitFor(() => expect(answer).toBeTypeOf("function"));
    answer(h.state.usage);
    await expect(check).resolves.toEqual({ dispatched: "Write tests" });
  });

  it.each(["off", "reapprove"])("rejects an old usage answer after %s", async (change) => {
    const h = harness();
    h.keepGoing.enable("b1", "t1", h.state.packet);
    let answer!: (report: RateLimitsReport | null) => void;
    h.deps.usage = () => new Promise((resolve) => { answer = resolve; });
    const check = h.keepGoing.check("b1");
    await vi.waitFor(() => expect(answer).toBeTypeOf("function"));
    if (change === "off") h.keepGoing.disable("b1");
    else h.keepGoing.enable("b1", "t1", h.state.packet);
    answer(h.state.usage);
    await expect(check).resolves.toEqual({ skipped: "off" });
    expect(h.dispatch).not.toHaveBeenCalled();
    expect(h.keepGoing.receipts("b1")).toEqual([]);
  });

  it.each([null, { windows: [], observedAt: new Date(NOON_KST).toISOString() }])("shows missing usage as paused (%j)", async (report) => {
    const h = harness();
    h.state.usage = report;
    h.keepGoing.enable("b1", "t1", h.state.packet);
    await expect(h.keepGoing.check("b1")).resolves.toEqual({ skipped: "usage-unknown" });
    expect(h.keepGoing.view("b1")).toEqual({ paused: "usage-unknown" });
    expect(h.changed).toHaveBeenCalledWith("b1");
    expect(new KeepGoing(h.deps).view("b1")).toEqual({ paused: "usage-unknown" });
  });

  it("shows retained stale usage as paused", async () => {
    const h = harness();
    h.state.usage!.observedAt = new Date(NOON_KST - KEEP_GOING_USAGE_FRESH_MS - 1).toISOString();
    h.keepGoing.enable("b1", "t1", h.state.packet);
    await expect(h.keepGoing.check("b1")).resolves.toEqual({ skipped: "usage-stale" });
    expect(h.keepGoing.view("b1")).toEqual({ paused: "usage-stale" });
  });

  it("shows a changed task as paused before a tick", () => {
    const h = harness();
    h.keepGoing.enable("b1", "t1", h.state.packet);
    h.state.threadId = "t2";
    expect(h.keepGoing.view("b1")).toEqual({ paused: "task-changed" });
    expect(h.keepGoing.rules("b1")).toBe("");
    h.state.threadId = "t1";
    expect(h.keepGoing.view("b1")).toEqual({ paused: null });
  });

  it.each(["bot-paused", "no-progress"] as const)("omits rules while %s", (reason) => {
    const h = harness();
    h.keepGoing.enable("b1", "t1", h.state.packet);
    h.keepGoing.pause("b1", reason);
    expect(h.keepGoing.rules("b1")).toBe("");
  });

  it("counts a skipped approved step as progress", async () => {
    const h = harness();
    h.keepGoing.enable("b1", "t1", h.state.packet);
    await h.keepGoing.check("b1");
    setPlan(h, [{ step: "Write tests", status: "skipped" }, { step: "Build UI", status: "pending" }]);
    await expect(h.keepGoing.check("b1")).resolves.toEqual({ dispatched: "Build UI" });
    expect(h.keepGoing.receipts("b1")[0]!.outcome).toBe("progress");
  });

  it("keeps a pause during the pane await without another paused card", async () => {
    const h = harness();
    h.keepGoing.enable("b1", "t1", h.state.packet);
    await h.keepGoing.check("b1");
    await h.keepGoing.check("b1");
    let answer!: (count: number) => void;
    h.livePanes.mockImplementationOnce(() => new Promise((resolve) => { answer = resolve; }));
    const check = h.keepGoing.check("b1");
    await vi.waitFor(() => expect(answer).toBeTypeOf("function"));
    h.keepGoing.pause("b1", "bot-paused");
    answer(0);
    await expect(check).resolves.toEqual({ skipped: "paused" });
    expect(h.keepGoing.view("b1")).toEqual({ paused: "bot-paused" });
    expect(h.paused).not.toHaveBeenCalled();
  });

  it("handles a scheduled check rejection and logs its bot", async () => {
    const h = harness();
    const log = vi.fn();
    h.deps.log = log;
    h.keepGoing.enable("b1", "t1", h.state.packet);
    const catchError = vi.fn((_handler: (error: unknown) => void) => Promise.resolve());
    vi.spyOn(h.keepGoing, "check").mockReturnValue({ catch: catchError } as unknown as ReturnType<KeepGoing["check"]>);
    h.state.now += KEEP_GOING_INTERVAL_MS;
    h.keepGoing.tick();
    expect(catchError).toHaveBeenCalledOnce();
    catchError.mock.calls[0]![0](new Error("disk full"));
    expect(log).toHaveBeenCalledWith("keep going: b1 check failed: disk full");
  });
});

describe("KeepGoing server wiring", () => {
  const source = readFileSync(new URL("./index.ts", import.meta.url), "utf8").replace(/\r\n/g, "\n");
  const usageStart = source.indexOf("  usage:", source.indexOf("const keepGoing = new KeepGoing("));
  const usage = source.slice(usageStart + "  usage: ".length, source.indexOf(",\n  livePanes:", usageStart));
  const readUsage = new Function("scope", `with (scope) { return (${usage})("b1"); }`);

  it.each(["missing", "stale", "empty"])("refreshes and saves %s usage without replacing a newer observation", async (kind) => {
    const previous = kind === "missing" ? undefined : {
      windows: kind === "empty" ? [] : [{ id: "five_hour", usedPercent: 99, resetsAt: null }],
      observedAt: new Date(kind === "stale" ? Date.now() - KEEP_GOING_USAGE_FRESH_MS - 1 : Date.now()).toISOString(),
    };
    const report = { windows: [{ id: "five_hour", usedPercent: 20, resetsAt: null }], observedAt: new Date(Date.now() + 60_000).toISOString() };
    const rateLimitsByInstance = new Map(previous ? [["engine", previous]] : []);
    const refreshUsage = vi.fn(async () => ({ report }));
    const scheduleSaveRateLimits = vi.fn();
    const config = { config: { cli: "fake-cli" }, environment: { FAKE: "1" } };
    const scope = {
      store: { bot: () => ({ modelSelection: { instanceId: "engine" } }) },
      rateLimitsByInstance, cfg: {}, instanceConfigs: () => ({ engine: config }),
      registry: { get: () => ({ driverKind: "claude" }) }, refreshUsage, scheduleSaveRateLimits,
      KEEP_GOING_USAGE_FRESH_MS, DATA_DIR: dir, z,
    };
    expect(await readUsage(scope)).toEqual(report);
    expect(refreshUsage).toHaveBeenCalledWith("claude", { instanceId: "engine", cli: "fake-cli", environment: config.environment }, previous);
    expect(rateLimitsByInstance.get("engine")).toEqual(report);
    expect(scheduleSaveRateLimits).toHaveBeenCalledWith(rateLimitsByInstance, dir);
    rateLimitsByInstance.set("engine", { ...report, observedAt: new Date(0).toISOString() });
    refreshUsage.mockImplementationOnce(async () => {
      rateLimitsByInstance.set("engine", report);
      return { report: { ...report, observedAt: new Date(0).toISOString() } };
    });
    expect(await readUsage(scope)).toEqual(report);
    expect(scheduleSaveRateLimits).toHaveBeenCalledTimes(1);
  });
});
