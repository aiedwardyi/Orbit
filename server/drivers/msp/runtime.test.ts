// MSP driver contract tests, run against the scripted fake MSP host in
// server/testing/fake-msp-cli.ts: session/start carries the model, text
// folds into canonical events, interrupts and crashes settle cleanly.
import { chmodSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { ensureDirs } from "../../config.ts";
import type { ProviderInstance } from "../../contracts.ts";
import { removeTempDir } from "../../testing/cleanup.ts";
import { recordEvents, type EventRecorder } from "../../testing/events.ts";
import { MspMuseAgentDriver } from "./muse.ts";

const FAKE_CLI = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "testing", "fake-msp-cli.ts");

describe("MSP turns (fake host)", () => {
  let instance: ProviderInstance;
  let recorder: EventRecorder;
  let scratch: string;

  const create = async (mode?: string, fullAuto = false) => {
    if (mode) process.env.FAKE_MSP_MODE = mode;
    process.env.META_API_KEY = "meta-key";
    instance = await MspMuseAgentDriver.create({
      instanceId: "msp-test",
      displayName: "MSP Test",
      environment: {},
      enabled: true,
      config: { cli: FAKE_CLI, fullAuto },
    });
    recorder = recordEvents(instance.adapter);
  };

  const V7 = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

  beforeEach(() => {
    ensureDirs();
    chmodSync(FAKE_CLI, 0o755);
    scratch = mkdtempSync(join(tmpdir(), "omb-msp-test-"));
  });

  afterEach(async () => {
    delete process.env.FAKE_MSP_MODE;
    delete process.env.FAKE_MSP_DUMP;
    delete process.env.FAKE_MSP_STATE;
    delete process.env.FAKE_MSP_RPC_DUMP;
    delete process.env.FAKE_MSP_USAGE;
    delete process.env.FAKE_MSP_USAGE_CHANGED;
    delete process.env.META_API_KEY;
    recorder?.stop();
    await instance?.dispose();
    removeTempDir(scratch);
  });

  it("starts a session with the requested model and folds text", async () => {
    const dump = join(scratch, "muse-model.json");
    process.env.FAKE_MSP_DUMP = dump;
    await create();
    await instance.adapter.sendTurn({ threadId: "t-model", text: "hi", model: "muse-spark-1.3" });
    expect(await recorder.until((e) => e.type === "turn.completed")).toMatchObject({ ok: true });
    expect(JSON.parse(readFileSync(`${dump}.config.json`, "utf8"))).toContainEqual({
      method: "session/start",
      modelId: "muse-spark-1.3",
    });
    expect(JSON.parse(readFileSync(`${dump}.turn.json`, "utf8"))).toEqual([{ type: "text", text: "hi" }]);
    expect(recorder.events).toContainEqual(
      expect.objectContaining({ type: "session.started", sessionId: "fake-msp-session" }),
    );
    expect(recorder.events).toContainEqual(
      expect.objectContaining({ type: "content.delta", delta: "hello from fake msp" }),
    );
    expect(recorder.events).toContainEqual(
      expect.objectContaining({ type: "item.completed", text: "hello from fake msp" }),
    );
  });

  it("folds stable usage/changed notifications into account windows", async () => {
    const payload = {
      observedAtMs: 1_790_000_000_000,
      tier: "pro",
      window: { usedPercent: 22, windowDurationMins: 300, resetsAtMs: 1_790_000_000_000 },
      weekly: { usedPercent: 61, resetsAtMs: 1_790_172_800_000 },
    };
    process.env.FAKE_MSP_USAGE_CHANGED = JSON.stringify(payload);
    await create();
    await instance.adapter.sendTurn({ threadId: "t-usage", text: "hi" });
    expect(await recorder.until((e) => e.type === "account.rate-limits.updated")).toMatchObject({
      type: "account.rate-limits.updated",
      observedAt: new Date(payload.observedAtMs).toISOString(),
      windows: [
        { id: "five_hour", usedPercent: 22, windowMinutes: 300, resetsAt: 1_790_000_000_000 },
        { id: "seven_day", usedPercent: 61, windowMinutes: 10_080, resetsAt: 1_790_172_800_000 },
      ],
    });
    expect(await recorder.until((e) => e.type === "turn.completed")).toMatchObject({ ok: true });
  });

  it("reads the cached usage snapshot before settling a completed turn", async () => {
    const payload = {
      observedAtMs: 1_790_000_000_100,
      tier: "pro",
      window: { usedPercent: 23, windowDurationMins: 300, resetsAtMs: 1_790_000_000_000 },
      weekly: { usedPercent: 62, resetsAtMs: 1_790_172_800_000 },
    };
    process.env.FAKE_MSP_USAGE = JSON.stringify(payload);
    await create();
    await instance.adapter.sendTurn({ threadId: "t-usage-read", text: "hi" });
    expect(await recorder.until((e) => e.type === "account.rate-limits.updated")).toMatchObject({
      type: "account.rate-limits.updated",
      observedAt: new Date(payload.observedAtMs).toISOString(),
      windows: [
        { id: "five_hour", usedPercent: 23 },
        { id: "seven_day", usedPercent: 62 },
      ],
    });
    expect(await recorder.until((e) => e.type === "turn.completed")).toMatchObject({ ok: true });
  });

  it("omits modelId when no model is picked", async () => {
    const dump = join(scratch, "muse-nomodel.json");
    process.env.FAKE_MSP_DUMP = dump;
    await create();
    await instance.adapter.sendTurn({ threadId: "t-nomodel", text: "hi" });
    expect(await recorder.until((e) => e.type === "turn.completed")).toMatchObject({ ok: true });
    expect(JSON.parse(readFileSync(`${dump}.config.json`, "utf8"))).toContainEqual({
      method: "session/start",
      modelId: null,
    });
  });

  it("forwards effort verbatim as reasoningEffort on turn/start", async () => {
    const dump = join(scratch, "muse-effort.json");
    process.env.FAKE_MSP_DUMP = dump;
    await create();
    await instance.adapter.sendTurn({ threadId: "t-effort", text: "hi", effort: "ultra" });
    expect(await recorder.until((e) => e.type === "turn.completed")).toMatchObject({ ok: true });
    expect(JSON.parse(readFileSync(`${dump}.turn-params.json`, "utf8"))).toMatchObject({
      reasoningEffort: "ultra",
    });
  });

  it("sends literal max without mapping it to ultra", async () => {
    const dump = join(scratch, "muse-effort-max.json");
    process.env.FAKE_MSP_DUMP = dump;
    await create();
    await instance.adapter.sendTurn({ threadId: "t-effort-max", text: "hi", effort: "max" });
    expect(await recorder.until((e) => e.type === "turn.completed")).toMatchObject({ ok: true });
    expect(JSON.parse(readFileSync(`${dump}.turn-params.json`, "utf8"))).toMatchObject({
      reasoningEffort: "max",
    });
  });

  it("omits reasoningEffort when effort is unset", async () => {
    const dump = join(scratch, "muse-effort-unset.json");
    process.env.FAKE_MSP_DUMP = dump;
    await create();
    await instance.adapter.sendTurn({ threadId: "t-effort-unset", text: "hi" });
    expect(await recorder.until((e) => e.type === "turn.completed")).toMatchObject({ ok: true });
    // SAFETY: the fake writes msg.params verbatim; only the effort key is read.
    const params = JSON.parse(readFileSync(`${dump}.turn-params.json`, "utf8")) as { reasoningEffort?: string };
    expect(params).not.toHaveProperty("reasoningEffort");
  });

  it("omits reasoningEffort when effort is none", async () => {
    const dump = join(scratch, "muse-effort-none.json");
    process.env.FAKE_MSP_DUMP = dump;
    await create();
    await instance.adapter.sendTurn({ threadId: "t-effort-none", text: "hi", effort: "none" });
    expect(await recorder.until((e) => e.type === "turn.completed")).toMatchObject({ ok: true });
    // SAFETY: the fake writes msg.params verbatim; only the effort key is read.
    const params = JSON.parse(readFileSync(`${dump}.turn-params.json`, "utf8")) as { reasoningEffort?: string };
    expect(params).not.toHaveProperty("reasoningEffort");
  });

  it("resumes a remembered session instead of starting one", async () => {
    const rpcDump = join(scratch, "muse-resume-rpc.json");
    process.env.FAKE_MSP_RPC_DUMP = rpcDump;
    await create();
    await instance.adapter.sendTurn({ threadId: "t-resume", text: "again", resumeCursor: "old-session" });
    expect(await recorder.until((e) => e.type === "turn.completed")).toMatchObject({ ok: true });
    const methods = JSON.parse(readFileSync(rpcDump, "utf8")) as string[];
    expect(methods).toContain("session/resume");
    expect(methods).not.toContain("session/start");
    expect(recorder.events).toContainEqual(
      expect.objectContaining({ type: "session.started", sessionId: "old-session" }),
    );
  });

  it("settles a hung turn as cancelled on interrupt", async () => {
    const rpcDump = join(scratch, "muse-interrupt-rpc.json");
    process.env.FAKE_MSP_RPC_DUMP = rpcDump;
    await create("hang");
    await instance.adapter.sendTurn({ threadId: "t-hang", text: "hi" });
    await recorder.until((e) => e.type === "session.started");
    await instance.adapter.interruptTurn("t-hang");
    expect(await recorder.until((e) => e.type === "turn.completed")).toMatchObject({
      ok: true,
      stopReason: "cancelled",
    });
    expect(JSON.parse(readFileSync(rpcDump, "utf8"))).toContain("turn/interrupt");
    expect(instance.adapter.hasSession("t-hang")).toBe(false);
  });

  it("fails the turn when the host exits early", async () => {
    await create("exit-early");
    await instance.adapter.sendTurn({ threadId: "t-exit", text: "hi" });
    await recorder.until((e) => e.type === "runtime.error");
    expect(await recorder.until((e) => e.type === "turn.completed")).toMatchObject({ ok: false });
  });

  it("keeps streamed text when the turn fails after it", async () => {
    await create("fail-after-text");
    await instance.adapter.sendTurn({ threadId: "t-fail", text: "hi" });
    expect(await recorder.until((e) => e.type === "turn.completed")).toMatchObject({ ok: false });
    expect(recorder.events).toContainEqual(
      expect.objectContaining({ type: "content.delta", delta: "half a report, then a crash" }),
    );
  });

  it("rejects a second turn while one is in flight", async () => {
    await create("hang");
    await instance.adapter.sendTurn({ threadId: "t-busy", text: "first" });
    await expect(instance.adapter.sendTurn({ threadId: "t-busy", text: "second" })).rejects.toThrow(
      /already running/,
    );
    await instance.adapter.interruptTurn("t-busy");
    await recorder.until((e) => e.type === "turn.completed");
  });

  it("decides an approval with the approved choice and requirement", async () => {
    const dump = join(scratch, "muse-approve.json");
    process.env.FAKE_MSP_DUMP = dump;
    await create("approval");
    await instance.adapter.sendTurn({ threadId: "t-approve", text: "hi" });
    const opened = await recorder.until((e) => e.type === "request.opened");
    expect(opened).toMatchObject({ requestType: "permission", tool: "shell" });
    expect(await instance.adapter.respondToRequest("t-approve", opened.requestId!, { behavior: "allow" })).toBe(
      "allowed-once",
    );
    expect(await recorder.until((e) => e.type === "turn.completed")).toMatchObject({ ok: true });
    const [decide] = JSON.parse(readFileSync(`${dump}.decide.json`, "utf8"));
    expect(decide).toMatchObject({
      method: "approval/decide",
      params: {
        approvalId: "fake-approval-1",
        choiceId: "allow-once",
        requirementId: { approvalId: "fake-approval-1", sourceIndex: 0 },
      },
    });
    expect(decide.params.commandId).toMatch(V7);
    // The resolved event trails the decide ack by a microtask; await it.
    expect(await recorder.until((e) => e.type === "request.resolved")).toMatchObject({
      behavior: "allow",
      source: "user",
    });
  });

  it("decides the denied choice on deny", async () => {
    const dump = join(scratch, "muse-deny.json");
    process.env.FAKE_MSP_DUMP = dump;
    await create("approval");
    await instance.adapter.sendTurn({ threadId: "t-deny", text: "hi" });
    const opened = await recorder.until((e) => e.type === "request.opened");
    expect(await instance.adapter.respondToRequest("t-deny", opened.requestId!, { behavior: "deny" })).toBe(
      "rejected",
    );
    await recorder.until((e) => e.type === "turn.completed");
    const [decide] = JSON.parse(readFileSync(`${dump}.decide.json`, "utf8"));
    expect(decide.params).toMatchObject({ choiceId: "deny" });
  });

  it("settles a deny as user-denied when the decide settlement fails, without failing the turn", async () => {
    const dump = join(scratch, "muse-denyfail.json");
    process.env.FAKE_MSP_DUMP = dump;
    await create("approval-decide-fails");
    await instance.adapter.sendTurn({ threadId: "t-denyfail", text: "hi" });
    const opened = await recorder.until((e) => e.type === "request.opened");
    expect(await instance.adapter.respondToRequest("t-denyfail", opened.requestId!, { behavior: "deny" })).toBe(
      "rejected",
    );
    // The card settles as denied by the user — the one outcome message —
    // instead of failing the turn over the host's settlement internals.
    expect(await recorder.until((e) => e.type === "request.resolved")).toMatchObject({
      behavior: "deny",
      source: "user",
    });
    const [decide] = JSON.parse(readFileSync(`${dump}.decide.json`, "utf8"));
    expect(decide.params).toMatchObject({ choiceId: "deny" });
    // The turn is still alive: interrupting it settles as cancelled, and no
    // runtime.error (ledger/fence internals) ever surfaced.
    await instance.adapter.interruptTurn("t-denyfail");
    expect(await recorder.until((e) => e.type === "turn.completed")).toMatchObject({
      ok: true,
      stopReason: "cancelled",
    });
    expect(recorder.events.map((e) => e.type)).not.toContain("runtime.error");
  });

  it("answers the receipt for an id-bearing approval request", async () => {
    const dump = join(scratch, "muse-approval-rpc.json");
    process.env.FAKE_MSP_DUMP = dump;
    await create("approval-request");
    await instance.adapter.sendTurn({ threadId: "t-approval-rpc", text: "hi" });
    const opened = await recorder.until((e) => e.type === "request.opened");
    await instance.adapter.respondToRequest("t-approval-rpc", opened.requestId!, { behavior: "allow" });
    await recorder.until((e) => e.type === "turn.completed");
    const calls = JSON.parse(readFileSync(`${dump}.decide.json`, "utf8"));
    expect(calls).toContainEqual({ method: "approval/receipt", result: {} });
    expect(calls).toContainEqual(expect.objectContaining({ method: "approval/decide" }));
  });

  it("auto-allows without a card in fullAuto", async () => {
    const dump = join(scratch, "muse-auto.json");
    process.env.FAKE_MSP_DUMP = dump;
    await create("approval", true);
    await instance.adapter.sendTurn({ threadId: "t-auto", text: "hi" });
    expect(await recorder.until((e) => e.type === "turn.completed")).toMatchObject({ ok: true });
    expect(recorder.events.map((e) => e.type)).not.toContain("request.opened");
    const [decide] = JSON.parse(readFileSync(`${dump}.decide.json`, "utf8"));
    expect(decide.params).toMatchObject({ choiceId: "allow-once" });
  });

  it("answers a userInput question", async () => {
    const dump = join(scratch, "muse-ui.json");
    process.env.FAKE_MSP_DUMP = dump;
    await create("userinput");
    await instance.adapter.sendTurn({ threadId: "t-ui", text: "hi" });
    const opened = await recorder.until((e) => e.type === "request.opened");
    expect(opened).toMatchObject({ requestType: "question" });
    expect(
      await instance.adapter.respondToRequest("t-ui", opened.requestId!, { behavior: "answer", message: "A" }),
    ).toBe("answered");
    await recorder.until((e) => e.type === "turn.completed");
    const [answer] = JSON.parse(readFileSync(`${dump}.decide.json`, "utf8"));
    expect(answer).toMatchObject({
      method: "userInput/answer",
      params: { userInputId: "fake-ui-1", answers: [{ questionId: "q1", freeText: "A" }] },
    });
  });

  it("cancels a userInput question on deny", async () => {
    const dump = join(scratch, "muse-uicancel.json");
    process.env.FAKE_MSP_DUMP = dump;
    await create("userinput");
    await instance.adapter.sendTurn({ threadId: "t-uicancel", text: "hi" });
    const opened = await recorder.until((e) => e.type === "request.opened");
    expect(await instance.adapter.respondToRequest("t-uicancel", opened.requestId!, { behavior: "deny" })).toBe(
      "rejected",
    );
    await recorder.until((e) => e.type === "turn.completed");
    const [cancel] = JSON.parse(readFileSync(`${dump}.decide.json`, "utf8"));
    expect(cancel).toMatchObject({ method: "userInput/cancel", params: { userInputId: "fake-ui-1" } });
  });

  it("falls back to a fresh session with fallback text when resume is rejected", async () => {
    const dump = join(scratch, "muse-resumefail.json");
    process.env.FAKE_MSP_DUMP = dump;
    process.env.FAKE_MSP_RPC_DUMP = join(scratch, "muse-resumefail-rpc.json");
    await create("resume-fails");
    await instance.adapter.sendTurn({
      threadId: "t-resumefail",
      text: "original",
      resumeCursor: "gone-session",
      resumeFallback: { text: "fallback hi" },
    });
    expect(await recorder.until((e) => e.type === "turn.completed")).toMatchObject({ ok: true });
    const methods = JSON.parse(readFileSync(join(scratch, "muse-resumefail-rpc.json"), "utf8")) as string[];
    expect(methods).toContain("session/resume");
    expect(methods).toContain("session/start");
    expect(JSON.parse(readFileSync(`${dump}.turn.json`, "utf8"))).toEqual([{ type: "text", text: "fallback hi" }]);
    expect(recorder.events).toContainEqual(
      expect.objectContaining({ type: "session.started", sessionId: "fake-msp-session" }),
    );
  });

  it.each(["resume-poisoned", "resume-poisoned-rpc"])(
    "recovers poisoned history (%s) with one fresh session and the fallback text",
    async (mode) => {
      const dump = join(scratch, `muse-poison-${mode}.json`);
      process.env.FAKE_MSP_DUMP = dump;
      await create(mode);
      await instance.adapter.sendTurn({
        threadId: "t-poison",
        text: "original",
        resumeCursor: "foreign-session",
        resumeFallback: { text: "fallback hi" },
      });
      expect(await recorder.until((e) => e.type === "turn.completed")).toMatchObject({ ok: true });
      expect(recorder.events.filter((e) => e.type === "session.started").map((e) => (e as { sessionId?: string }).sessionId))
        .toEqual(["foreign-session", "fake-msp-session"]);
      expect(JSON.parse(readFileSync(`${dump}.turn.json`, "utf8"))).toEqual([{ type: "text", text: "fallback hi" }]);
    },
  );

  it("pins a new model via setModel and the switch sticks", async () => {
    const dump = join(scratch, "muse-switch.json");
    process.env.FAKE_MSP_DUMP = dump;
    process.env.FAKE_MSP_STATE = join(scratch, "muse-switch-state.json");
    await create();
    expect(instance.adapter.capabilities.sessionModelSwitch).toBe("in-session");

    await instance.adapter.sendTurn({ threadId: "t-switch", text: "hi", model: "muse-spark-1.3" });
    const first = await recorder.until((e) => e.type === "turn.completed");
    expect(first).toMatchObject({ ok: true });
    const started = recorder.events.find((e) => e.type === "session.started");
    if (started?.type !== "session.started") throw new Error("no session started");

    const second = await instance.adapter.sendTurn({
      threadId: "t-switch",
      text: "again",
      resumeCursor: started.sessionId,
      model: "muse-spark-1.3-contributor",
    });
    expect(
      await recorder.until((e) => e.type === "turn.completed" && (e as { turnId?: string }).turnId === second.turnId),
    ).toMatchObject({ ok: true });
    const calls = JSON.parse(readFileSync(`${dump}.config.json`, "utf8")) as Array<{
      method: string;
      params: Record<string, unknown>;
    }>;
    const set = calls.find((c) => c.method === "session/setModel");
    expect(set?.params).toMatchObject({
      sessionId: "fake-msp-session",
      model: { modelId: "muse-spark-1.3-contributor" },
    });
    expect(set?.params.commandId).toMatch(V7);

    await instance.adapter.sendTurn({ threadId: "t-switch", text: "third", resumeCursor: started.sessionId });
    await recorder.until(
      (e) => e.type === "turn.completed" && (e as { turnId?: string }).turnId !== second.turnId && e !== first,
    );
    const lastStarted = [...recorder.events].reverse().find((e) => e.type === "session.started");
    expect(lastStarted).toMatchObject({ sessionId: "fake-msp-session", model: "muse-spark-1.3-contributor" });
  });

  it("skips setModel when the session already runs the model", async () => {
    const dump = join(scratch, "muse-samemodel.json");
    process.env.FAKE_MSP_DUMP = dump;
    process.env.FAKE_MSP_STATE = join(scratch, "muse-samemodel-state.json");
    await create();
    await instance.adapter.sendTurn({ threadId: "t-same", text: "hi", model: "muse-spark-1.3" });
    await recorder.until((e) => e.type === "turn.completed");
    const started = recorder.events.find((e) => e.type === "session.started");
    if (started?.type !== "session.started") throw new Error("no session started");
    const retry = await instance.adapter.sendTurn({
      threadId: "t-same",
      text: "again",
      resumeCursor: started.sessionId,
      model: "muse-spark-1.3",
    });
    expect(
      await recorder.until((e) => e.type === "turn.completed" && (e as { turnId?: string }).turnId === retry.turnId),
    ).toMatchObject({ ok: true });
    const calls = JSON.parse(readFileSync(`${dump}.config.json`, "utf8")) as Array<{ method: string }>;
    expect(calls.map((c) => c.method)).not.toContain("session/setModel");
  });

  it("maps an authRequired mid-turn failure to setup", async () => {
    await create("auth-failure");
    await instance.adapter.sendTurn({ threadId: "t-authfail", text: "hi" });
    const error = await recorder.until((e) => e.type === "runtime.error");
    expect(error).toMatchObject({ message: "login expired", setup: true });
    expect(await recorder.until((e) => e.type === "turn.completed")).toMatchObject({
      ok: false,
      stopReason: "auth_required",
    });
  });
});
