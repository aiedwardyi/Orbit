import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  nextOccurrence,
  RoutineManager,
  routineBotState,
  routineRunCard,
  routineTriggerIsUnattended,
  type RoutineManagerOptions,
  type RoutineSchedule,
} from "./routines.ts";

const dirs: string[] = [];

function tempFile() {
  const dir = mkdtempSync(join(tmpdir(), "omb-routines-"));
  dirs.push(dir);
  return join(dir, "routines.json");
}

function harness(start = new Date(2026, 7, 17, 8, 0, 0).getTime()) {
  let now = start;
  let bot: "ready" | "busy" | "missing" = "ready";
  let task = 0;
  const started: Array<{ botId: string; threadId: string; prompt: string }> = [];
  const runOns: string[] = [];
  const triggerSources: string[] = [];
  const taskActivations: boolean[] = [];
  const emitted: any[] = [];
  const changed: any[] = [];
  const failed: any[] = [];
  const options: RoutineManagerOptions = {
    file: tempFile(),
    now: () => now,
    emit: (payload) => emitted.push(payload),
    botState: () => bot,
    createTask: (_botId, _title, activate = false) => {
      taskActivations.push(activate);
      return { threadId: `thread-${++task}` };
    },
    startTurn: async (botId, threadId, prompt, runOn, triggerSource) => {
      started.push({ botId, threadId, prompt });
      runOns.push(runOn);
      triggerSources.push(triggerSource);
    },
    startChatTurn: async (run, line) => {
      started.push({ botId: run.botId, threadId: run.sourceThreadId!, prompt: line });
      runOns.push(run.runOn);
      triggerSources.push(run.triggerSource!);
    },
    // the server posts each card in its source chat, else the bot's 1:1
    onRunChanged: (run) => {
      changed.push(run);
      return run.webhookId ? null : { threadId: run.sourceThreadId ?? "bot-chat", messageId: `card-${run.id}` };
    },
    onRunFailed: (run) => failed.push(run),
  };
  const manager = new RoutineManager(options);
  return {
    manager,
    options,
    emitted,
    started,
    runOns,
    triggerSources,
    taskActivations,
    changed,
    failed,
    setNow: (value: number) => (now = value),
    setBot: (value: typeof bot) => (bot = value),
  };
}

afterEach(() => {
  vi.restoreAllMocks();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("nextOccurrence", () => {
  it("finds the next selected weekday in local wall-clock time", () => {
    const monday = new Date(2026, 7, 17, 10, 0, 0).getTime();
    const next = nextOccurrence({ type: "daily", time: "09:30", weekdays: [1, 3] }, monday)!;
    const d = new Date(next);
    expect(d.getDay()).toBe(3);
    expect([d.getHours(), d.getMinutes()]).toEqual([9, 30]);
  });

  it("returns a one-off only while it is still in the future", () => {
    expect(nextOccurrence({ type: "once", at: 200 }, 100)).toBe(200);
    expect(nextOccurrence({ type: "once", at: 100 }, 100)).toBeNull();
  });
});

describe("RoutineManager", () => {
  it("persists definitions separately from permanent run receipts", async () => {
    const h = harness();
    const routine = h.manager.create({
      name: "Morning brief",
      prompt: "Summarize what changed",
      botId: "maus-1",
      schedule: { type: "once", at: new Date(2026, 7, 17, 8, 5).getTime() },
    });
    h.setNow(routine.nextRunAt!);
    await h.manager.tick();

    const routineFile = h.options.file;
    if (!routineFile) throw new Error("test harness did not configure routine persistence");
    let failureWasPersistedBeforeCallback = false;
    h.options.onRunFailed = (run) => {
      h.failed.push(run);
      failureWasPersistedBeforeCallback = readFileSync(routineFile, "utf8").includes('"status": "failed"');
    };
    const reloaded = new RoutineManager(h.options);
    expect(reloaded.listRoutines()).toHaveLength(1);
    expect(reloaded.listRuns()).toMatchObject([
      { routineId: routine.id, routineName: "Morning brief", status: "failed", sourceThreadId: "bot-chat" },
    ]);
    // Reload recovery truthfully marks an in-process run as interrupted.
    expect(reloaded.listRuns()[0]!.error).toContain("restarted");
    expect(failureWasPersistedBeforeCallback).toBe(true);
    expect(h.failed).toMatchObject([
      {
        routineId: routine.id,
        routineName: "Morning brief",
        status: "failed",
        sourceThreadId: "bot-chat",
        error: "Wink restarted while this routine was running",
      },
    ]);
    // never fired again after the restart
    await reloaded.tick();
    expect(h.started).toHaveLength(1);
  });

  it("persists confirmation receipts with the scheduler mutation and removes them after settlement", () => {
    const h = harness();
    const routine = h.manager.create({
      name: "Before",
      prompt: "Review the queue",
      botId: "maus-1",
      schedule: { type: "daily", time: "09:00", weekdays: [1] },
    });
    const request = {
      requestId: "request-update-1",
      messageId: "message-1",
      botId: "maus-1",
      threadId: "thread-1",
      action: "update" as const,
      fingerprintVersion: 1 as const,
      fingerprint: "a".repeat(64),
    };
    h.manager.update(routine.id, { name: "After" }, request);

    const reloaded = new RoutineManager(h.options);
    expect(reloaded.routineRequestReceipt(request.requestId)).toMatchObject({
      ...request,
      resultId: routine.id,
    });
    expect(reloaded.routineRequestReceiptOwners()).toEqual([{
      requestId: request.requestId,
      messageId: request.messageId,
      botId: request.botId,
      threadId: request.threadId,
    }]);
    expect(() => reloaded.update(routine.id, { name: "Never applied" }, {
      ...request,
      fingerprint: "b".repeat(64),
    })).toThrow(/does not match/);
    expect(reloaded.listRoutines()[0]!.name).toBe("After");

    expect(reloaded.reconcileRoutineRequestReceipts([request])).toBe(0);
    expect(reloaded.forgetRoutineRequestReceipt(request)).toBe(true);
    expect(new RoutineManager(h.options).routineRequestReceipt(request.requestId)).toBeNull();
  });

  it("persists trusted chat provenance and snapshots it onto chat runs", async () => {
    const h = harness();
    const request = {
      requestId: "request-source-thread",
      messageId: "message-source-thread",
      botId: "maus-1",
      threadId: "conversation-that-created-it",
      action: "create" as const,
      fingerprintVersion: 1 as const,
      fingerprint: "e".repeat(64),
    };
    const routine = h.manager.create({
      name: "Source report",
      prompt: "Summarize the queue",
      botId: "maus-1",
      schedule: { type: "once", at: new Date(2026, 7, 17, 8, 5).getTime() },
    }, request);

    expect(routine.sourceThreadId).toBe(request.threadId);
    const reloaded = new RoutineManager(h.options);
    expect(reloaded.listRoutines()[0]?.sourceThreadId).toBe(request.threadId);

    h.setNow(routine.nextRunAt!);
    await reloaded.tick();
    const run = reloaded.listRuns()[0]!;
    expect(run).toMatchObject({
      sourceThreadId: request.threadId,
      status: "running",
    });
    expect(run.threadId).toBeUndefined();
    expect(h.changed.map(({ status, sourceThreadId, threadId }) => ({ status, sourceThreadId, threadId })))
      .toEqual([
        { status: "queued", sourceThreadId: request.threadId, threadId: undefined },
        { status: "running", sourceThreadId: request.threadId, threadId: undefined },
      ]);
  });

  it("does not trust a calendar payload to choose another conversation", () => {
    const h = harness();
    const schedule: RoutineSchedule = { type: "daily", time: "09:00", weekdays: [1] };
    const calendarPayload = {
      name: "Calendar-owned",
      prompt: "Run without a chat source",
      botId: "maus-1",
      schedule,
      sourceThreadId: "forged-thread",
    };
    const routine = h.manager.create(calendarPayload);
    expect(routine.sourceThreadId).toBeUndefined();
  });

  it("keeps routine history when a persisted source thread is malformed", () => {
    const h = harness();
    const request = {
      requestId: "request-malformed-source",
      messageId: "message-malformed-source",
      botId: "maus-1",
      threadId: "trusted-source",
      action: "create" as const,
      fingerprintVersion: 1 as const,
      fingerprint: "2".repeat(64),
    };
    h.manager.create({
      name: "Survives malformed provenance",
      prompt: "Keep this routine",
      botId: "maus-1",
      schedule: { type: "daily", time: "09:00", weekdays: [1] },
    }, request);
    const file = h.options.file;
    if (!file) throw new Error("test harness did not configure routine persistence");
    const stored = readFileSync(file, "utf8");
    const malformed = stored.replace(`"sourceThreadId": "${request.threadId}"`, '"sourceThreadId": 42');
    expect(malformed).not.toBe(stored);
    writeFileSync(file, malformed);

    const reloaded = new RoutineManager(h.options);
    expect(reloaded.listRoutines()).toMatchObject([{
      name: "Survives malformed provenance",
      sourceThreadId: undefined,
    }]);
  });

  it("reports a chat-confirmed run-now to its invoking thread without rebinding the routine", () => {
    const h = harness();
    const createRequest = {
      requestId: "request-create-origin",
      messageId: "message-create-origin",
      botId: "maus-1",
      threadId: "original-thread",
      action: "create" as const,
      fingerprintVersion: 1 as const,
      fingerprint: "f".repeat(64),
    };
    const routine = h.manager.create({
      name: "Daily source",
      prompt: "Review it",
      botId: "maus-1",
      schedule: { type: "daily", time: "09:00", weekdays: [1] },
    }, createRequest);
    const runRequest = {
      ...createRequest,
      requestId: "request-run-now-elsewhere",
      messageId: "message-run-now-elsewhere",
      threadId: "invoking-thread",
      action: "run_now" as const,
      fingerprint: "1".repeat(64),
    };

    const run = h.manager.runNow(routine.id, runRequest)!;
    expect(run.sourceThreadId).toBe("invoking-thread");
    expect(h.manager.listRoutines()[0]?.sourceThreadId).toBe("original-thread");
  });

  it("removes unreachable recovery receipts when their conversation is deleted", () => {
    const h = harness();
    const routine = h.manager.create({
      name: "Cleanup",
      prompt: "Clean unreachable confirmations",
      botId: "maus-1",
      schedule: { type: "daily", time: "09:00", weekdays: [1] },
    });
    const request = {
      requestId: "request-orphaned-thread",
      messageId: "message-orphaned-thread",
      botId: "maus-1",
      threadId: "thread-deleted",
      action: "pause" as const,
      fingerprintVersion: 1 as const,
      fingerprint: "d".repeat(64),
    };
    h.manager.update(routine.id, { enabled: false }, request);

    expect(h.manager.forgetRoutineRequestReceiptsForThread("another-thread")).toBe(0);
    expect(h.manager.forgetRoutineRequestReceiptsForThread("thread-deleted")).toBe(1);
    expect(new RoutineManager(h.options).routineRequestReceipt(request.requestId)).toBeNull();
  });

  it("rolls back an uncommitted confirmation when the atomic file write fails", () => {
    const h = harness();
    const file = h.options.file!;
    // A directory at the destination makes the final atomic rename fail
    // after the temporary file has been written.
    mkdirSync(file);
    const request = {
      requestId: "request-create-write-failure",
      messageId: "message-write-failure",
      botId: "maus-1",
      threadId: "thread-1",
      action: "create" as const,
      fingerprintVersion: 1 as const,
      fingerprint: "c".repeat(64),
    };
    const input = {
      name: "Retry safely",
      prompt: "Check the queue",
      botId: "maus-1",
      schedule: { type: "daily" as const, time: "09:00", weekdays: [1] },
    };

    expect(() => h.manager.create(input, request)).toThrow();
    expect(h.manager.listRoutines()).toEqual([]);
    expect(h.manager.routineRequestReceipt(request.requestId)).toBeNull();
    expect(h.emitted).toEqual([]);

    rmSync(file, { recursive: true, force: true });
    rmSync(`${file}.tmp`, { force: true });
    const routine = h.manager.create(input, request);
    expect(h.manager.listRoutines()).toHaveLength(1);
    expect(h.manager.routineRequestReceipt(request.requestId)).toMatchObject({
      ...request,
      resultId: routine.id,
    });
  });

  it("reuses an already queued or running run-now instead of stacking silent duplicates", () => {
    const h = harness();
    const routine = h.manager.create({
      name: "Morning brief",
      prompt: "Write the brief",
      botId: "maus-1",
      schedule: { type: "daily", time: "09:00", weekdays: [1] },
    });

    const first = h.manager.runNow(routine.id)!;
    const second = h.manager.runNow(routine.id)!;
    const third = h.manager.runNow(routine.id)!;

    expect(second.id).toBe(first.id);
    expect(third.id).toBe(first.id);
    expect(h.manager.listRuns().filter((run) => run.routineId === routine.id && run.status === "queued")).toHaveLength(1);
  });

  it("queues behind a busy bot, then fires in its chat", async () => {
    const h = harness();
    h.setBot("busy");
    const routine = h.manager.create({
      name: "Review queue",
      prompt: "Review the queue",
      botId: "maus-2",
      schedule: { type: "once", at: new Date(2026, 7, 17, 8, 1).getTime() },
      durationMinutes: 45,
    });
    h.setNow(routine.nextRunAt!);
    await h.manager.tick();
    expect(h.manager.listRuns()[0]!.status).toBe("queued");
    expect(h.started).toHaveLength(0);

    h.setBot("ready");
    await h.manager.tick();
    expect(h.started).toEqual([
      { botId: "maus-2", threadId: "bot-chat", prompt: "[Routine] Review queue fired at 08:01 Mon Aug 17: Review the queue" },
    ]);
    expect(h.manager.listRuns()[0]).toMatchObject({ status: "running", sourceThreadId: "bot-chat" });
    expect(h.manager.activeRunForBot("maus-2")?.sourceThreadId).toBe("bot-chat");
    expect(h.taskActivations).toEqual([]);
  });

  it("cancels queued work when a routine is paused", async () => {
    const h = harness();
    h.setBot("busy");
    const routine = h.manager.create({
      name: "Pauseable check",
      prompt: "Check later",
      botId: "maus-2",
      schedule: { type: "once", at: new Date(2026, 7, 17, 8, 1).getTime() },
    });
    h.setNow(routine.nextRunAt!);
    await h.manager.tick();

    h.manager.update(routine.id, { enabled: false });
    h.setBot("ready");
    await h.manager.tick();

    expect(h.manager.listRuns()[0]).toMatchObject({ status: "cancelled" });
    expect(h.started).toHaveLength(0);
  });

  it("snapshots queued instructions so later edits do not rewrite a receipt", async () => {
    const h = harness();
    h.setBot("busy");
    const routine = h.manager.create({
      name: "Original brief",
      prompt: "Use the original instructions",
      botId: "maus-2",
      schedule: { type: "once", at: new Date(2026, 7, 17, 8, 1).getTime() },
    });
    h.setNow(routine.nextRunAt!);
    await h.manager.tick();
    h.manager.update(routine.id, { name: "Edited brief", prompt: "Use the new instructions" });

    h.setBot("ready");
    await h.manager.tick();

    expect(h.started[0]?.prompt).toBe("[Routine] Original brief fired at 08:01 Mon Aug 17: Use the original instructions");
    expect(h.manager.listRuns()[0]).toMatchObject({
      routineName: "Original brief",
      prompt: "Use the original instructions",
    });
  });

  it("snapshots and dispatches the selected execution machine", async () => {
    const h = harness();
    h.setBot("busy");
    const routine = h.manager.create({
      name: "VM review",
      prompt: "Review the project on the virtual machine",
      botId: "maus-cloud",
      runOn: "cloud",
      schedule: { type: "once", at: new Date(2026, 7, 17, 8, 1).getTime() },
    });
    h.setNow(routine.nextRunAt!);
    await h.manager.tick();
    h.manager.update(routine.id, { runOn: "maus" });

    h.setBot("ready");
    await h.manager.tick();

    expect(h.runOns).toEqual(["cloud"]);
    expect(h.manager.listRuns()[0]).toMatchObject({ runOn: "cloud" });
    expect(h.manager.listRoutines()[0]).toMatchObject({ runOn: "maus" });
  });

  it("marks schedule and webhook triggers unattended, manual attended", () => {
    expect(routineTriggerIsUnattended("schedule")).toBe(true);
    expect(routineTriggerIsUnattended("webhook")).toBe(true);
    expect(routineTriggerIsUnattended("manual")).toBe(false);
    expect(routineTriggerIsUnattended(undefined)).toBe(false);
  });

  it("dispatches scheduled runs with the unattended trigger source", async () => {
    const h = harness();
    const routine = h.manager.create({
      name: "Nightly check",
      prompt: "Check overnight",
      botId: "maus-1",
      schedule: { type: "once", at: new Date(2026, 7, 17, 8, 1).getTime() },
    });
    h.setNow(routine.nextRunAt!);
    await h.manager.tick();
    expect(h.triggerSources).toEqual(["schedule"]);
    // startClaimedTurn marks exactly these sources unattended, so a
    // scheduled turn with auto mode on still asks a human
    expect(routineTriggerIsUnattended(h.triggerSources[0] as "schedule")).toBe(true);
    expect(h.manager.listRuns()[0]).toMatchObject({ triggerSource: "schedule", manual: false });
  });

  it("dispatches run-now with the attended manual trigger source", async () => {
    const h = harness();
    const routine = h.manager.create({
      name: "Manual check",
      prompt: "Check now",
      botId: "maus-1",
      schedule: { type: "once", at: new Date(2026, 7, 17, 8, 1).getTime() },
    });
    h.manager.runNow(routine.id);
    await h.manager.tick();
    expect(h.triggerSources).toEqual(["manual"]);
    expect(routineTriggerIsUnattended(h.triggerSources[0] as "manual")).toBe(false);
    expect(h.manager.listRuns()[0]).toMatchObject({ triggerSource: "manual", manual: true });
  });

  it("opens webhook jobs in the assigned bot's live chat", async () => {
    const h = harness();
    const receivedAt = new Date(2026, 7, 17, 8, 2).getTime();
    const queued = h.manager.enqueueWebhook({
      webhookId: "hook-1",
      webhookName: "New ticket",
      prompt: "Handle ticket 42",
      botId: "maus-webhook",
      runOn: "cloud",
      deliveryId: "delivery-42",
      receivedAt,
    });
    await h.manager.tick();

    expect(queued).toMatchObject({
      routineId: "hook-1",
      webhookId: "hook-1",
      deliveryId: "delivery-42",
      triggerSource: "webhook",
      scheduledFor: receivedAt,
    });
    expect(queued).not.toHaveProperty("durationMinutes");
    expect(h.started).toEqual([{ botId: "maus-webhook", threadId: "thread-1", prompt: "Handle ticket 42" }]);
    expect(h.runOns).toEqual(["cloud"]);
    expect(h.triggerSources).toEqual(["webhook"]);
    expect(h.taskActivations).toEqual([true]);
  });

  it("folds provider lifecycle events into the calendar receipt", async () => {
    const h = harness();
    const routine = h.manager.create({
      name: "Ship report",
      prompt: "Write the report",
      botId: "maus-3",
      schedule: { type: "once", at: new Date(2026, 7, 17, 8, 1).getTime() },
    });
    h.setNow(routine.nextRunAt!);
    await h.manager.tick();
    const base = {
      eventId: "event-1",
      provider: "fake",
      threadId: "bot-chat",
      createdAt: new Date(h.manager.listRuns()[0]!.startedAt!).toISOString(),
    };
    const secret = `sk-ant-api03-${"abcdefghijklmnopqrstuvwxyz0123456789"}`;
    h.manager.handleRuntimeEvent({
      ...base,
      type: "request.opened",
      requestType: "question",
      tool: "ask",
      summary: `Choose the two actions before using ${secret}`,
    }, "maus-3");
    expect(h.manager.listRuns()[0]).toMatchObject({
      status: "waiting",
      attention: expect.stringContaining("Choose the two actions"),
    });
    expect(h.manager.listRuns()[0]!.attention).not.toContain(secret);
    h.manager.handleRuntimeEvent({ ...base, type: "request.resolved", behavior: "answer", source: "user" }, "maus-3");
    expect(h.manager.listRuns()[0]!.attention).toBeUndefined();
    h.manager.handleRuntimeEvent({ ...base, type: "item.completed", itemType: "assistant_text", text: "Report shipped." }, "maus-3");
    h.manager.handleRuntimeEvent({ ...base, type: "turn.completed", ok: true, cost: 0.02 }, "maus-3");

    expect(h.manager.listRuns()[0]).toMatchObject({
      status: "completed",
      output: "Report shipped.",
      cost: 0.02,
    });
  });

  it("keeps the real reply as output when an engine summary lands after it", async () => {
    const h = harness();
    const routine = h.manager.create({
      name: "Ship report",
      prompt: "Write the report",
      botId: "maus-3",
      schedule: { type: "once", at: new Date(2026, 7, 17, 8, 1).getTime() },
    });
    h.setNow(routine.nextRunAt!);
    await h.manager.tick();
    const base = {
      eventId: "event-1",
      provider: "fake",
      threadId: "bot-chat",
      createdAt: new Date(h.manager.listRuns()[0]!.startedAt!).toISOString(),
    };
    h.manager.handleRuntimeEvent({ ...base, type: "item.completed", itemType: "assistant_text", text: "Report shipped." }, "maus-3");
    h.manager.handleRuntimeEvent({
      ...base,
      type: "item.completed",
      itemType: "assistant_text",
      text: "I've wrapped up the report.",
      summarized: true,
    }, "maus-3");
    h.manager.handleRuntimeEvent({ ...base, type: "turn.completed", ok: true, cost: 0.02 }, "maus-3");

    expect(h.manager.listRuns()[0]).toMatchObject({ status: "completed", output: "Report shipped." });
  });

  it("reports a failed run once with its chat thread", async () => {
    const h = harness();
    const routine = h.manager.create({
      name: "Broken report",
      prompt: "Write the report",
      botId: "maus-failed",
      schedule: { type: "once", at: new Date(2026, 7, 17, 8, 1).getTime() },
    });
    h.setNow(routine.nextRunAt!);
    await h.manager.tick();

    h.manager.handleRuntimeEvent({
      eventId: "failed",
      provider: "fake",
      threadId: "bot-chat",
      createdAt: new Date().toISOString(),
      type: "turn.completed",
      ok: false,
      stopReason: "provider crashed",
    }, "maus-failed");

    expect(h.failed).toMatchObject([
      {
        routineName: "Broken report",
        botId: "maus-failed",
        sourceThreadId: "bot-chat",
        status: "failed",
        error: "provider crashed",
      },
    ]);
    expect(h.manager.listRuns()[0]).toMatchObject({ sourceThreadId: "bot-chat", status: "failed" });

    h.manager.markSeen(h.failed[0].id);
    expect(h.failed).toHaveLength(1);
  });

  it("keeps recurring history while advancing the definition", async () => {
    const h = harness();
    const routine = h.manager.create({
      name: "Daily check",
      prompt: "Check it",
      botId: "maus-4",
      schedule: { type: "daily", time: "08:05", weekdays: [1, 2, 3, 4, 5] },
    });
    h.setNow(routine.nextRunAt!);
    await h.manager.tick();
    h.manager.handleRuntimeEvent({
      eventId: "done",
      provider: "fake",
      threadId: "bot-chat",
      createdAt: new Date().toISOString(),
      type: "turn.completed",
      ok: true,
    }, "maus-4");

    expect(h.manager.listRuns()).toMatchObject([{ status: "completed" }]);
    expect(h.manager.listRoutines()[0]!.nextRunAt).toBeGreaterThan(routine.nextRunAt!);
  });

  it("settles stale occurrences and runs the newest occurrence inside the catch-up window", async () => {
    const mondayNoon = new Date(2026, 7, 17, 12, 0, 0).getTime();
    const tuesdayNine = new Date(2026, 7, 18, 9, 0, 0).getTime();
    const wednesdayNine = new Date(2026, 7, 19, 9, 0, 0).getTime();
    const wednesdayTen = new Date(2026, 7, 19, 10, 0, 0).getTime();
    const thursdayNine = new Date(2026, 7, 20, 9, 0, 0).getTime();
    const h = harness(mondayNoon);
    const routine = h.manager.create({
      name: "Daily check",
      prompt: "Check it",
      botId: "maus-catch-up",
      schedule: { type: "daily", time: "09:00", weekdays: [0, 1, 2, 3, 4, 5, 6] },
    });
    expect(routine.nextRunAt).toBe(tuesdayNine);

    h.setNow(wednesdayTen);
    await h.manager.tick();

    expect(h.manager.listRuns()).toMatchObject([
      { status: "running", scheduledFor: wednesdayNine },
      { status: "missed", scheduledFor: tuesdayNine },
    ]);
    expect(h.started).toHaveLength(1);
    expect(h.failed).toMatchObject([{ status: "missed", scheduledFor: tuesdayNine }]);
    expect(h.manager.listRoutines()[0]!.nextRunAt).toBe(thursdayNine);
  });

  it("records a missed receipt instead of launching very stale work", async () => {
    const h = harness();
    const routine = h.manager.create({
      name: "Old check",
      prompt: "Do the old thing",
      botId: "maus-5",
      schedule: { type: "once", at: new Date(2026, 7, 17, 8, 1).getTime() },
    });
    h.setNow(routine.nextRunAt! + 13 * 60 * 60_000);
    await h.manager.tick();
    expect(h.manager.listRuns()[0]).toMatchObject({ status: "missed" });
    expect(h.started).toHaveLength(0);
    expect(h.failed).toMatchObject([{ id: h.manager.listRuns()[0]!.id, status: "missed" }]);
  });

  it("keeps every missed card but toasts only once per routine per catch-up", async () => {
    const h = harness(new Date(2026, 7, 17, 12, 0, 0).getTime());
    h.manager.create({
      name: "Daily check",
      prompt: "Check it",
      botId: "maus-toast-once",
      schedule: { type: "daily", time: "09:00", weekdays: [0, 1, 2, 3, 4, 5, 6] },
    });
    // Friday 10:00: Tue, Wed and Thu 09:00 are missed, Fri 09:00 runs live.
    h.setNow(new Date(2026, 7, 21, 10, 0, 0).getTime());
    await h.manager.tick();

    expect(h.manager.listRuns().filter((run) => run.status === "missed")).toHaveLength(3);
    expect(h.changed.filter((run) => run.status === "missed")).toHaveLength(3);
    expect(h.failed).toMatchObject([{ status: "missed" }]);
  });

  it("records a missed receipt for a once routine created with a long-past time", async () => {
    const h = harness();
    const staleAt = new Date(2026, 7, 16, 6, 0, 0).getTime();
    const routine = h.manager.create({
      name: "Stale check",
      prompt: "Do the stale thing",
      botId: "maus-6",
      schedule: { type: "once", at: staleAt },
    });
    expect(routine.nextRunAt).toBe(staleAt);
    await h.manager.tick();
    expect(h.manager.listRuns()[0]).toMatchObject({ status: "missed", scheduledFor: staleAt });
    expect(h.started).toHaveLength(0);
  });

  it("runs a once routine created slightly late and records the original scheduled time", async () => {
    const h = harness();
    const lateAt = new Date(2026, 7, 17, 7, 55, 0).getTime();
    const routine = h.manager.create({
      name: "Late check",
      prompt: "Do the late thing",
      botId: "maus-7",
      schedule: { type: "once", at: lateAt },
    });
    expect(routine.nextRunAt).toBe(lateAt);
    await h.manager.tick();
    expect(h.started).toHaveLength(1);
    expect(h.manager.listRuns()[0]).toMatchObject({ status: "running", scheduledFor: lateAt });
  });

  it("fires a scheduled run as a turn in its source chat without creating a task", async () => {
    const h = harness();
    const routine = h.manager.create({
      name: "Daily 20-min tool to try",
      prompt: "Send Eddie one tool to try",
      botId: "maus-1",
      schedule: { type: "once", at: new Date(2026, 7, 17, 12, 30).getTime() },
    }, {
      requestId: "request-chat-fire",
      messageId: "message-chat-fire",
      botId: "maus-1",
      threadId: "chat-1",
      action: "create",
      fingerprintVersion: 1,
      fingerprint: "3".repeat(64),
    });
    h.setNow(routine.nextRunAt!);
    await h.manager.tick();

    expect(h.taskActivations).toEqual([]);
    expect(h.started).toEqual([{
      botId: "maus-1",
      threadId: "chat-1",
      prompt: "[Routine] Daily 20-min tool to try fired at 12:30 Mon Aug 17: Send Eddie one tool to try",
    }]);
    expect(h.triggerSources).toEqual(["schedule"]);
    const run = h.manager.listRuns()[0]!;
    expect(run).toMatchObject({ status: "running", sourceThreadId: "chat-1", cardMessageId: `card-${run.id}` });
    expect(run.threadId).toBeUndefined();
  });

  it("puts a run back in the queue on a busy rejection", async () => {
    const h = harness();
    let busy = true;
    const fired: string[] = [];
    h.options.startChatTurn = async (_run, line) => {
      if (busy) throw Object.assign(new Error("the bot is already working"), { status: 409, code: "BOT_BUSY" });
      fired.push(line);
    };
    const routine = h.manager.create({
      name: "Raced check",
      prompt: "Check it",
      botId: "maus-1",
      schedule: { type: "once", at: new Date(2026, 7, 17, 8, 1).getTime() },
    });
    h.setNow(routine.nextRunAt!);
    await h.manager.tick();

    expect(h.manager.listRuns()[0]).toMatchObject({ status: "queued" });
    expect(h.manager.listRuns()[0]!.startedAt).toBeUndefined();
    expect(h.failed).toEqual([]);

    busy = false;
    await h.manager.tick();
    await h.manager.tick();
    expect(fired).toHaveLength(1);
    expect(h.manager.listRuns()[0]).toMatchObject({ status: "running" });
  });

  it("waits while the bot has queued sends", async () => {
    const h = harness();
    let queuedSends = true;
    h.options.botState = () => routineBotState({ exists: true, activeTurn: false, queuedSends });
    const routine = h.manager.create({
      name: "Held check",
      prompt: "Check it",
      botId: "maus-1",
      schedule: { type: "once", at: new Date(2026, 7, 17, 8, 1).getTime() },
    });
    h.setNow(routine.nextRunAt!);
    await h.manager.tick();
    expect(h.started).toHaveLength(0);
    expect(h.manager.listRuns()[0]).toMatchObject({ status: "queued" });

    queuedSends = false;
    await h.manager.tick();
    expect(h.started).toHaveLength(1);
    expect(routineBotState({ exists: false, activeTurn: false, queuedSends: false })).toBe("missing");
    expect(routineBotState({ exists: true, activeTurn: true, queuedSends: false })).toBe("busy");
  });

  it("dispatches the oldest queued run first", async () => {
    const h = harness();
    const order: string[] = [];
    const dispatch = (name: string) => {
      order.push(name);
      h.setBot("busy");
    };
    h.options.startChatTurn = async (run) => dispatch(run.routineName);
    h.options.startTurn = async (_botId, _threadId, prompt) => dispatch(prompt);
    h.setBot("busy");
    const first = h.manager.create({
      name: "First",
      prompt: "First",
      botId: "maus-1",
      schedule: { type: "once", at: new Date(2026, 7, 17, 8, 1).getTime() },
    });
    const second = h.manager.create({
      name: "Second",
      prompt: "Second",
      botId: "maus-1",
      schedule: { type: "once", at: new Date(2026, 7, 17, 8, 2).getTime() },
    });
    h.setNow(first.nextRunAt!);
    await h.manager.tick();
    h.setNow(second.nextRunAt!);
    await h.manager.tick();

    h.setBot("ready");
    await h.manager.tick();
    expect(order).toEqual(["First"]);
  });

  it("folds chat-turn events matched by source thread and bot", async () => {
    const h = harness();
    const routine = h.manager.create({
      name: "Room report",
      prompt: "Write the report",
      botId: "maus-room",
      schedule: { type: "once", at: new Date(2026, 7, 17, 8, 1).getTime() },
    }, {
      requestId: "request-room",
      messageId: "message-room",
      botId: "maus-room",
      threadId: "room-thread",
      action: "create",
      fingerprintVersion: 1,
      fingerprint: "4".repeat(64),
    });
    h.setNow(routine.nextRunAt!);
    await h.manager.tick();
    const base = { eventId: "event-1", provider: "fake", threadId: "room-thread", createdAt: new Date().toISOString() };

    // another member speaking in the same room is not this run
    expect(h.manager.handleRuntimeEvent({ ...base, type: "item.completed", itemType: "assistant_text", text: "Not mine." }, "maus-other")).toBeNull();
    h.manager.handleRuntimeEvent({ ...base, type: "item.completed", itemType: "assistant_text", text: "Report done." }, "maus-room");
    h.manager.handleRuntimeEvent({ ...base, type: "turn.completed", ok: true }, "maus-room");

    expect(h.manager.listRuns()[0]).toMatchObject({ status: "completed", output: "Report done." });
  });

  it("keeps cloud runs detached and posts the result", async () => {
    const h = harness();
    const routine = h.manager.create({
      name: "VM report",
      prompt: "Build on the VM",
      botId: "maus-cloud",
      runOn: "cloud",
      schedule: { type: "once", at: new Date(2026, 7, 17, 8, 1).getTime() },
    });
    h.setNow(routine.nextRunAt!);
    await h.manager.tick();

    expect(h.taskActivations).toEqual([false]);
    expect(h.started).toEqual([{ botId: "maus-cloud", threadId: "thread-1", prompt: "Build on the VM" }]);
    const base = { eventId: "event-1", provider: "box", threadId: "thread-1", createdAt: new Date().toISOString() };
    h.manager.handleRuntimeEvent({ ...base, type: "item.completed", itemType: "assistant_text", text: "Built 3 pages." }, "maus-cloud");
    h.manager.handleRuntimeEvent({ ...base, type: "turn.completed", ok: true }, "maus-cloud");

    expect(routineRunCard(h.changed.at(-1))).toMatchObject({
      status: "completed",
      runOn: "cloud",
      executionThreadId: "thread-1",
      summary: "Built 3 pages.",
      instruction: "Build on the VM",
    });
  });

  it("falls back to the bot's chat when the source is deleted", async () => {
    const h = harness();
    const routine = h.manager.create({
      name: "Orphan report",
      prompt: "Write the report",
      botId: "maus-1",
      schedule: { type: "once", at: new Date(2026, 7, 17, 8, 1).getTime() },
    }, {
      requestId: "request-orphan",
      messageId: "message-orphan",
      botId: "maus-1",
      threadId: "deleted-chat",
      action: "create",
      fingerprintVersion: 1,
      fingerprint: "5".repeat(64),
    });
    // the server finds the source gone and posts the card in the bot's 1:1
    h.options.onRunChanged = (run) => {
      h.changed.push(run);
      return { threadId: "bot-chat", messageId: "card-orphan" };
    };
    h.setNow(routine.nextRunAt!);
    await h.manager.tick();

    expect(h.started).toEqual([{
      botId: "maus-1",
      threadId: "bot-chat",
      prompt: "[Routine] Orphan report fired at 08:01 Mon Aug 17: Write the report",
    }]);
    expect(h.manager.listRuns()[0]).toMatchObject({ sourceThreadId: "bot-chat", cardMessageId: "card-orphan" });
    h.manager.handleRuntimeEvent({ eventId: "done", provider: "fake", threadId: "bot-chat", createdAt: new Date().toISOString(), type: "turn.completed", ok: true }, "maus-1");
    expect(h.manager.listRuns()[0]).toMatchObject({ status: "completed" });
  });

  it("holds a room run while another member's turn holds the room", async () => {
    const h = harness();
    let roomBusy = true;
    h.options.botState = (_botId, threadId) => (threadId === "room-thread" && roomBusy ? "busy" : "ready");
    const routine = h.manager.create({
      name: "Room report",
      prompt: "Write the report",
      botId: "maus-room",
      schedule: { type: "once", at: new Date(2026, 7, 17, 8, 1).getTime() },
    }, {
      requestId: "request-room-busy",
      messageId: "message-room-busy",
      botId: "maus-room",
      threadId: "room-thread",
      action: "create",
      fingerprintVersion: 1,
      fingerprint: "6".repeat(64),
    });
    h.setNow(routine.nextRunAt!);
    await h.manager.tick();
    expect(h.started).toEqual([]);
    expect(h.manager.listRuns()[0]).toMatchObject({ status: "queued" });

    roomBusy = false;
    await h.manager.tick();
    expect(h.started).toMatchObject([{ botId: "maus-room", threadId: "room-thread" }]);
  });

  it("starts no clock on a run that failed before its turn", async () => {
    for (const dispatch of ["throws", "reports"] as const) {
      const h = harness();
      h.options.startChatTurn = async (_run, _line, onDispatchError) => {
        if (dispatch === "throws") throw new Error("provider unavailable");
        onDispatchError("provider unavailable");
      };
      const routine = h.manager.create({
        name: "Daily",
        prompt: "Check it",
        botId: "maus-1",
        schedule: { type: "once", at: new Date(2026, 7, 17, 8, 1).getTime() },
      });
      h.setNow(routine.nextRunAt!);
      await h.manager.tick();

      const run = h.manager.listRuns()[0]!;
      expect(run).toMatchObject({ status: "failed", error: "provider unavailable" });
      expect(run.startedAt).toBeUndefined();
      expect(routineRunCard(h.changed.at(-1)).startedAt).toBeUndefined();
    }
  });
});

// startChatTurn and the settle tick are private to index.ts, which these tests must not boot.
describe("routine server wiring", () => {
  const index = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "index.ts"), "utf8");
  const startChatTurn = index.slice(index.indexOf("startChatTurn: async"), index.indexOf("interruptTurn: async"));
  const claimedRoomTurn = index.slice(index.indexOf("async function runClaimedGroupMemberTurn("), index.indexOf("const roomContext = ["));

  it("fires a room run without queueing it in the room, awaiting its turn, or replaying its card", () => {
    expect(index).toContain("botState: (botId, threadId) => routineBotState");
    const busy = startChatTurn.indexOf("throw busyRejection(");
    expect(busy).toBeGreaterThan(-1);
    expect(busy).toBeLessThan(startChatTurn.indexOf("runGroupMemberTurn("));
    expect(startChatTurn).toContain("void runGroupMemberTurn(");
    expect(startChatTurn).not.toContain("await runGroupMemberTurn(");
    expect(startChatTurn).toContain("new Set([run.cardMessageId])");
    expect(claimedRoomTurn).toMatch(/contextWindow: modelContextWindow,\s+excludeIds,/);
  });

  it("ticks routines only after a drained room turn claims its bot", () => {
    expect(index).toContain("setTimeout(() => void routines?.tick(), 0);");
    expect(index).not.toMatch(/^\s*void routines\?\.tick\(\);\s*$/m);
  });
});
