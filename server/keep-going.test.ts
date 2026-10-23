import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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
  keepGoingPrompt,
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

describe("KeepGoing task approval", () => {
  it("dispatches a step the bot added after approval", async () => {
    const h = harness();
    setPlan(h, [{ step: "Write tests", status: "pending" }]);
    h.keepGoing.enable("b1", "t1", h.state.packet);
    setPlan(h, [{ step: "Write tests", status: "done" }, { step: "Re-walk demo", status: "pending" }]);
    await expect(h.keepGoing.check("b1")).resolves.toEqual({ dispatched: "Re-walk demo" });
  });

  it("dispatches a reworded pending step", async () => {
    const h = harness();
    h.keepGoing.enable("b1", "t1", h.state.packet);
    setPlan(h, [{ step: "Cover the scheduler with regressions", status: "pending" }, { step: "Build UI", status: "pending" }]);
    await expect(h.keepGoing.check("b1")).resolves.toEqual({ dispatched: "Cover the scheduler with regressions" });
  });

  it("matches approved steps by normalized text", async () => {
    const h = harness();
    setPlan(h, [{ step: "  Write   Tests ", status: "pending" }]);
    h.keepGoing.enable("b1", "t1", h.state.packet);
    setPlan(h, [{ step: "write tests", status: "pending" }]);
    await expect(h.keepGoing.check("b1")).resolves.toEqual({ dispatched: "write tests" });
  });

  it.each(["active", "done"] as const)("dispatches a formerly %s step returned to pending", async (status) => {
    const h = harness();
    setPlan(h, [{ step: "Write tests", status }]);
    h.keepGoing.enable("b1", "t1", h.state.packet);
    setPlan(h, [{ step: "Write tests", status: "pending" }]);
    await expect(h.keepGoing.check("b1")).resolves.toEqual({ dispatched: "Write tests" });
  });

  it("asks for the first pending step that needs no user and turns off if none qualify", () => {
    const prompt = keepGoingPrompt("User login");
    expect(prompt).toContain("first pending step");
    expect(prompt).toContain("without the user");
    expect(prompt).toContain("set_keep_going(on: false)");
    expect(prompt).toContain("one line");
    expect(prompt).not.toContain("only this step");
    expect(prompt).not.toContain("approved this plan step");
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

  const plan: Plan = [
    { step: "Write tests", status: "pending" },
    { step: "Completed check", status: "done" },
    { step: "Ongoing check", status: "active" },
    { step: "Duplicate", status: "done" },
    { step: "Duplicate", status: "pending" },
  ];
  const changes: Array<[string, Plan]> = [
    ["done returning to pending", plan.map((item, i) => i === 1 ? { ...item, status: "pending" } : item)],
    ["an active item completing", plan.map((item, i) => i === 2 ? { ...item, status: "done" } : item)],
    ["an added item", [...plan, { step: "Re-walk demo", status: "pending" }]],
    ["a removed item", plan.filter((_, i) => i !== 1)],
    ["a reworded item", plan.map((item, i) => i === 1 ? { ...item, step: "Checked setup" } : item)],
    ["reordered items", [plan[0]!, plan[2]!, plan[1]!, ...plan.slice(3)]],
    ["a duplicate added", [...plan, plan[0]!]],
    ["a duplicate changing status", plan.map((item, i) => i === 4 ? { ...item, status: "done" } : item)],
  ];

  it.each(changes)("counts %s anywhere in the plan as progress", async (_name, next) => {
    const h = harness();
    setPlan(h, plan);
    h.keepGoing.enable("b1", "t1", h.state.packet);
    await h.keepGoing.check("b1");
    setPlan(h, next);
    await expect(h.keepGoing.check("b1")).resolves.toEqual({ dispatched: "Write tests" });
    expect(h.keepGoing.receipts("b1")[0]!.outcome).toBe("progress");
    expect(h.paused).not.toHaveBeenCalled();
  });

  it("does not count unrelated task metadata as plan progress", async () => {
    const h = harness();
    h.keepGoing.enable("b1", "t1", h.state.packet);
    await h.keepGoing.check("b1");
    h.state.packet!.nextAction = "Still writing tests";
    await h.keepGoing.check("b1");
    expect(h.keepGoing.receipts("b1")[0]!.outcome).toBe("no-progress");
  });

  it.each(["completed", "removed"])("grades plan progress when all pending items are %s", async (change) => {
    const h = harness();
    h.keepGoing.enable("b1", "t1", h.state.packet);
    await h.keepGoing.check("b1");
    setPlan(h, change === "removed" ? [] : h.state.packet!.plan.map((item) => ({ ...item, status: "done" })));
    await expect(h.keepGoing.check("b1")).resolves.toEqual({ skipped: "no-approved-step" });
    expect(h.keepGoing.receipts("b1")[0]!.outcome).toBe("progress");
    expect(h.dispatch).toHaveBeenCalledTimes(1);
  });

  it("reads old keep-going files with legacy receipts and no delay", async () => {
    const h = harness();
    writeFileSync(h.deps.file!, JSON.stringify({
      v: 1, bots: { b1: {
        on: true, ownerDeviceId: "pc-a", threadId: "t1", revision: 1,
        steps: ["write tests", "build ui"], approvedAt: NOON_KST - 60_000,
        receipts: [{ at: NOON_KST - 30_000, step: "Write tests", outcome: "pending", before: { "write tests": "pending", "build ui": "pending" } }],
      } },
    }));
    const reloaded = new KeepGoing(h.deps);
    expect(reloaded.view("b1")).toEqual({ paused: null });
    await expect(reloaded.check("b1")).resolves.toEqual({ dispatched: "Write tests" });
    expect(reloaded.receipts("b1")[0]!.outcome).toBe("no-progress");
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
    expect(KEEP_GOING_RULES).toMatch(/^Agentic Mode is on\./);
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

  it("approves the task from a turn the user started", async () => {
    const h = harness();
    h.keepGoing.turnStarted("b1", "t1", true);
    expect(h.keepGoing.fromTool("b1", "t1", true, h.state.packet)).toEqual({ ok: true });
    expect(h.keepGoing.view("b1")).toEqual({ paused: null });
    setPlan(h, [{ step: "Write tests", status: "done" }, { step: "Build UI", status: "pending" }, { step: "Re-walk demo", status: "pending" }]);
    await expect(h.keepGoing.check("b1")).resolves.toEqual({ dispatched: "Build UI" });
    setPlan(h, [{ step: "Build UI", status: "done" }, { step: "Re-walk demo", status: "pending" }]);
    await expect(h.keepGoing.check("b1")).resolves.toEqual({ dispatched: "Re-walk demo" });
  });

  it("turns off from any turn", () => {
    const h = harness();
    h.keepGoing.enable("b1", "t1", h.state.packet);
    h.keepGoing.turnStarted("b1", "t9", false);
    expect(h.keepGoing.fromTool("b1", "t9", false, null)).toEqual({ ok: true });
    expect(h.keepGoing.view("b1")).toBeNull();
  });
});

describe("KeepGoing start_after", () => {
  const startAfter = "2026-10-20T12:30:00+09:00";

  it("delays from any turn while on, survives restart, then clears at dispatch time", async () => {
    const h = harness();
    h.keepGoing.enable("b1", "t1", h.state.packet);
    h.keepGoing.turnStarted("b1", "t1", false);
    expect(h.keepGoing.fromTool("b1", "t1", true, h.state.packet, startAfter)).toEqual({ ok: true });
    expect(JSON.parse(readFileSync(h.deps.file!, "utf8")).bots.b1.startAfter).toBe(startAfter);
    const reloaded = new KeepGoing(h.deps);
    h.state.now = Date.parse(startAfter) - 1;
    await expect(reloaded.check("b1")).resolves.toEqual({ skipped: "waiting" });
    expect(h.livePanes).not.toHaveBeenCalled();
    expect(h.dispatch).not.toHaveBeenCalled();
    expect(reloaded.receipts("b1")).toEqual([]);
    h.state.now++;
    await expect(reloaded.check("b1")).resolves.toEqual({ dispatched: "Write tests" });
    expect(JSON.parse(readFileSync(h.deps.file!, "utf8")).bots.b1).not.toHaveProperty("startAfter");
  });

  it.each([false, true])("never turns an off switch on with start_after (user turn %s)", async (byUser) => {
    const h = harness();
    h.keepGoing.enable("b1", "t1", h.state.packet);
    h.keepGoing.disable("b1");
    h.keepGoing.turnStarted("b1", "t1", byUser);
    expect(h.keepGoing.fromTool("b1", "t1", true, h.state.packet, startAfter)).toHaveProperty("error");
    expect(h.keepGoing.view("b1")).toBeNull();
    await expect(h.keepGoing.check("b1")).resolves.toEqual({ skipped: "off" });
  });

  it("clears start_after when turned off", () => {
    const h = harness();
    h.keepGoing.enable("b1", "t1", h.state.packet);
    h.keepGoing.turnStarted("b1", "t1", true);
    expect(h.keepGoing.fromTool("b1", "t1", true, h.state.packet, startAfter)).toEqual({ ok: true });
    expect(JSON.parse(readFileSync(h.deps.file!, "utf8")).bots.b1.startAfter).toBe(startAfter);
    const reloaded = new KeepGoing(h.deps);
    reloaded.fromTool("b1", "t1", false, null);
    expect(JSON.parse(readFileSync(h.deps.file!, "utf8")).bots.b1).not.toHaveProperty("startAfter");
    expect(reloaded.view("b1")).toBeNull();
  });

  it.each(["tomorrow", "2026-10-20T12:30:00", "2026-10-20T12:30+09:00", "2026-02-30T12:30:00+09:00", 123])("rejects invalid start_after %j without changing approval", (value) => {
    const h = harness();
    h.keepGoing.enable("b1", "t1", h.state.packet);
    h.keepGoing.turnStarted("b1", "t1", true);
    const before = readFileSync(h.deps.file!, "utf8");
    expect(h.keepGoing.fromTool("b1", "t1", true, h.state.packet, value)).toHaveProperty("error");
    expect(readFileSync(h.deps.file!, "utf8")).toBe(before);
  });

  it.each(["not-owner", "task-changed"])("cannot change a delay after %s", (reason) => {
    const h = harness();
    h.keepGoing.enable("b1", "t1", h.state.packet);
    h.keepGoing.turnStarted("b1", "t1", true);
    if (reason === "not-owner") h.state.deviceId = "pc-b";
    else h.state.threadId = "t2";
    expect(h.keepGoing.fromTool("b1", "t1", true, h.state.packet, startAfter)).toHaveProperty("error");
  });

  it("does not let another thread set a delay", () => {
    const h = harness();
    h.keepGoing.enable("b1", "t1", h.state.packet);
    h.keepGoing.turnStarted("b1", "t2", true);
    expect(h.keepGoing.fromTool("b1", "t2", true, h.state.packet, startAfter)).toHaveProperty("error");
  });

  it("keeps the bench gate after a delay expires", async () => {
    const h = harness();
    h.keepGoing.enable("b1", "t1", h.state.packet);
    h.keepGoing.turnStarted("b1", "t1", true);
    const after = "2026-10-21T04:00:00+09:00";
    expect(h.keepGoing.fromTool("b1", "t1", true, h.state.packet, after)).toEqual({ ok: true });
    h.state.now = Date.parse(after);
    await expect(h.keepGoing.check("b1")).resolves.toEqual({ skipped: "bench" });
    h.state.now = Date.parse("2026-10-21T05:00:00+09:00");
    h.state.usage!.observedAt = new Date(h.state.now).toISOString();
    await expect(h.keepGoing.check("b1")).resolves.toEqual({ dispatched: "Write tests" });
  });

  it.each(["usage", "panes"])("invalidates a check awaiting %s when a delay is set", async (waiting) => {
    const h = harness();
    h.keepGoing.enable("b1", "t1", h.state.packet);
    h.keepGoing.turnStarted("b1", "t1", true);
    let answer!: () => void;
    if (waiting === "usage") h.deps.usage = () => new Promise((resolve) => { answer = () => resolve(h.state.usage); });
    else h.livePanes.mockImplementationOnce(() => new Promise((resolve) => { answer = () => resolve(0); }));
    const check = h.keepGoing.check("b1");
    await vi.waitFor(() => expect(answer).toBeTypeOf("function"));
    expect(h.keepGoing.fromTool("b1", "t1", true, h.state.packet, startAfter)).toEqual({ ok: true });
    answer();
    await expect(check).resolves.toEqual({ skipped: "off" });
    expect(h.dispatch).not.toHaveBeenCalled();
    h.deps.usage = async () => h.state.usage;
    await expect(h.keepGoing.check("b1")).resolves.toEqual({ skipped: "waiting" });
  });

  it("refuses a delay while paused after failed tries", async () => {
    const h = harness();
    h.keepGoing.enable("b1", "t1", h.state.packet);
    await h.keepGoing.check("b1");
    await h.keepGoing.check("b1");
    h.state.now++;
    await expect(h.keepGoing.check("b1")).resolves.toEqual({ skipped: "paused" });
    h.keepGoing.turnStarted("b1", "t1", true);
    expect(h.keepGoing.fromTool("b1", "t1", true, h.state.packet, startAfter)).toEqual({ error: expect.stringContaining("paused") });
    expect(JSON.parse(readFileSync(h.deps.file!, "utf8")).bots.b1).not.toHaveProperty("startAfter");
    h.state.now = Date.parse(startAfter);
    await expect(h.keepGoing.check("b1")).resolves.toEqual({ skipped: "paused" });
    expect(h.dispatch).toHaveBeenCalledTimes(2);
  });

  it("drops the turn rules until the delay ends", () => {
    const h = harness();
    h.keepGoing.enable("b1", "t1", h.state.packet);
    expect(h.keepGoing.fromTool("b1", "t1", true, h.state.packet, startAfter)).toEqual({ ok: true });
    h.state.now = Date.parse(startAfter) - 1;
    expect(h.keepGoing.rules("b1")).toBe("");
    h.state.now++;
    expect(h.keepGoing.rules("b1")).toBe(` ${KEEP_GOING_RULES}`);
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
    expect(log.mock.calls.map(([line]) => line)).toEqual(["Agentic Mode: b1 dispatch failed: engine down"]);
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

  it("clears a usage pause once usage reads fresh again", async () => {
    const h = harness();
    const fresh = h.state.usage;
    h.state.usage = null;
    h.keepGoing.enable("b1", "t1", h.state.packet);
    await expect(h.keepGoing.check("b1")).resolves.toEqual({ skipped: "usage-unknown" });
    h.state.usage = fresh;
    const result = await h.keepGoing.check("b1");
    expect(result).toHaveProperty("dispatched");
    expect(h.keepGoing.view("b1")).toEqual({ paused: null });
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
    expect(log).toHaveBeenCalledWith("Agentic Mode: b1 check failed: disk full");
  });
});

describe("KeepGoing server wiring", () => {
  const source = readFileSync(new URL("./index.ts", import.meta.url), "utf8").replace(/\r\n/g, "\n");
  const usageStart = source.indexOf("  usage:", source.indexOf("const keepGoing = new KeepGoing("));
  const usage = source.slice(usageStart + "  usage: ".length, source.indexOf(",\n  livePanes:", usageStart));
  const readUsage = new Function("scope", `with (scope) { return (${usage})("b1"); }`);
  const routeHandler = (file: string, name: string, params: string) => {
    const routes = readFileSync(new URL(file, import.meta.url), "utf8").replace(/\r\n/g, "\n");
    const from = routes.indexOf("\n", routes.indexOf(`    ${name}: async (`)) + 1;
    const body = routes.slice(from, routes.indexOf("\n    },", from));
    return new Function("scope", `with (scope) { return async (${params}) => {${body}\n}; }`);
  };

  it("passes start_after through the internal tool route without booting the server", async () => {
    const h = harness();
    h.keepGoing.enable("b1", "t1", h.state.packet);
    const routeStart = source.indexOf('      if (method === "POST" && path === "/api/internal/keep-going") {');
    const route = source.slice(routeStart, source.indexOf('\n      // The ask_user tool:', routeStart));
    const handle = new Function("scope", `with (scope) { return (async () => { ${route} })(); }`);
    const startAfter = "2026-10-20T12:30:00+09:00";
    const json = vi.fn();
    const scope = {
      method: "POST", path: "/api/internal/keep-going", req: {}, res: {},
      readBody: async () => ({ fromBotId: "b1", fromThreadId: "t1", on: true, start_after: startAfter }),
      store: { bot: () => ({ id: "b1", threadId: "t1" }) },
      keepGoing: h.keepGoing, taskPacketForWrite: () => h.state.packet,
      json, wireBot: vi.fn(), broadcast: vi.fn(),
    };
    Object.assign(scope, { internalRoutes: { setKeepGoing: routeHandler("./internal-routes.ts", "setKeepGoing", "req, res")(scope) } });
    await handle(scope);
    expect(json).toHaveBeenCalledWith({}, 200, { ok: true });
    await expect(h.keepGoing.check("b1")).resolves.toEqual({ skipped: "waiting" });
  });

  it("resumes paused wakes when Settings enables Keep going, including an off/on retry", async () => {
    const h = harness();
    const routeStart = source.indexOf('    m = path.match(/^\\/api\\/bots\\/([\\w-]+)\\/keep-going$/);');
    const route = source.slice(routeStart, source.indexOf('\n    m = path.match(', routeStart + 1));
    expect(routeStart).toBeGreaterThan(-1);
    const handle = new Function("scope", `with (scope) { return (async () => { ${route} })(); }`);
    const resumePaneWakes = vi.fn(() => { h.state.wakesPaused = false; });
    const scope = {
      path: "/api/bots/b1/keep-going", method: "POST", m: null, req: {}, res: {},
      readBody: async () => ({ on: true }), json: vi.fn(),
      store: { bot: () => ({ id: "b1", threadId: "t1" }) },
      keepGoing: h.keepGoing, taskPacketForWrite: () => h.state.packet,
      resumePaneWakes, wireBot: vi.fn(), broadcast: vi.fn(),
    };
    for (const retry of [false, true]) {
      if (retry) {
        scope.readBody = async () => ({ on: false });
        h.state.wakesPaused = true;
        await handle(scope);
        expect(h.state.wakesPaused).toBe(true);
      }
      h.state.wakesPaused = true;
      scope.readBody = async () => ({ on: true });
      await handle(scope);
      await expect(h.keepGoing.check("b1")).resolves.toEqual({ dispatched: "Write tests" });
      h.state.now += KEEP_GOING_INTERVAL_MS;
    }
    expect(resumePaneWakes).toHaveBeenCalledTimes(2);
    expect(resumePaneWakes).toHaveBeenCalledWith("b1");
  });

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
