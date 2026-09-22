// ACP driver contract tests, run against the scripted fake ACP CLI in
// server/testing/fake-acp-cli.ts. Covers the shared acp/core.ts runtime via
// its two harness shims (grok = fail-closed auth, gemini = lenient auth):
// normalize the ACP handshake into canonical events, keep argv/env hygiene,
// broker permission asks, and settle interrupts/crashes cleanly.
//
// The fake CLI is a shebang script Windows cannot exec directly —
// resolveCliSpawn turns it into `node <script>`, so these run everywhere.
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ensureDirs, PROVIDER_CREDENTIAL_ENV, WORKSPACE_CREDENTIAL_ENV } from "../../config.ts";
import type { ProviderDriver, ProviderInstance } from "../../contracts.ts";
import { recordEvents, type EventRecorder } from "../../testing/events.ts";
import { createAcpDriver, probeCliVersion, skipSubscriptionAuthForLocalInject, wslSessionPaths, type AcpSupport } from "./core.ts";
import { toWslPath } from "../../env-path.ts";
import { GrokAgentDriver, grokSupport } from "./grok.ts";
import { GeminiAgentDriver } from "./gemini.ts";
import { KimiAgentDriver } from "./kimi.ts";
import { DroidAgentDriver } from "./droid.ts";
import { CursorAgentDriver } from "./cursor.ts";
import { MuseAgentDriver } from "./muse.ts";
import { readGrokBillingRpc } from "../../usage-refresh.ts";
import { removeTempDir } from "../../testing/cleanup.ts";
import { ProviderRegistry } from "../../harness/registry.ts";
import * as procs from "../../procs.ts";

const FAKE_CLI = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "testing", "fake-acp-cli.ts");

/** Every credential this process could be holding, plus two nobody has heard
 * of yet - the allowlist has to exclude those for the same reason, under
 * whichever name their provider ships them. */
const FOREIGN_CREDENTIALS = [
  ...PROVIDER_CREDENTIAL_ENV,
  ...WORKSPACE_CREDENTIAL_ENV,
  "ACME_API_KEY",
  "NEWPROVIDER_TOKEN",
  "AWS_ACCESS_KEY_ID",
  "AWS_SECRET_ACCESS_KEY",
  "AWS_SESSION_TOKEN",
];

/** A harness that exists only in tests: it exercises the opt-in session-config
 *  model hook so PR 1 can prove the core capability without shipping a visible
 *  engine. Real harnesses live in their own file. */
const SELECT_MODEL_SUPPORT: AcpSupport = {
  driverKind: "selectModelTest",
  displayName: "Select Model Test",
  models: { default: "m-one", options: [{ id: "m-one", label: "One" }, { id: "m-two", label: "Two" }] },
  defaultCli: "fake-select-model",
  nativeSource: "test.acp",
  loginNote: "never reached",
  selectModel: { configId: "model" },
  spawnArgs: () => [],
  pickAuthMethod: () => null,
  authFailure: "continue",
  isAuthenticated: () => true,
};
const SelectModelDriver = createAcpDriver(SELECT_MODEL_SUPPORT);

/** Proves transformEnv can vary with the instance config. */
const EnvPolicyDriver = createAcpDriver({
  ...SELECT_MODEL_SUPPORT,
  driverKind: "envPolicyTest",
  selectModel: undefined,
  transformEnv: (env, config) => {
    env.TEST_POLICY = config.fullAuto ? "auto" : "ask";
  },
});

/** Proves snapshot() awaits an async isAuthenticated. */
const AsyncAuthDriver = createAcpDriver({
  ...SELECT_MODEL_SUPPORT,
  driverKind: "asyncAuthTest",
  selectModel: undefined,
  isAuthenticated: async () => true,
});

const ClassifiedErrorDriver = createAcpDriver({
  ...SELECT_MODEL_SUPPORT,
  driverKind: "classifiedErrorTest",
  selectModel: undefined,
  classifyError: (error) =>
    error && typeof error === "object" && (error as { code?: unknown }).code === -32000
      ? "invalid_credentials"
      : undefined,
});

describe("skipSubscriptionAuthForLocalInject", () => {
  it("is true only for a host:: inject id", () => {
    expect(skipSubscriptionAuthForLocalInject("omlx::MiniMax-M3-4bit")).toBe(true);
    expect(skipSubscriptionAuthForLocalInject("unsloth::orcarouter/Qwen3.8-27B-Uncensored-GGUF")).toBe(true);
    expect(skipSubscriptionAuthForLocalInject("grok-4.6")).toBe(false);
    expect(skipSubscriptionAuthForLocalInject(undefined)).toBe(false);
  });
});

describe("wslSessionPaths", () => {
  const server = (command: string, args: string[] = []) => ({ name: "agents", command, args, env: [] });

  it("maps the session cwd and every server command onto the WSL mount", () => {
    expect(
      wslSessionPaths("C:\\work\\proj", [
        server("C:\\tools\\agent-server.exe", ["--port", "8080"]),
        server("D:/tools/other.exe"),
      ]),
    ).toEqual({
      cwd: "/mnt/c/work/proj",
      servers: [
        { name: "agents", command: "/mnt/c/tools/agent-server.exe", args: ["--port", "8080"], env: [] },
        { name: "agents", command: "/mnt/d/tools/other.exe", args: [], env: [] },
      ],
    });
  });

  it("leaves POSIX values and non-path args alone", () => {
    expect(wslSessionPaths("/home/ed/proj", [server("/usr/local/bin/agent-server", ["--port", "8080"])])).toEqual({
      cwd: "/home/ed/proj",
      servers: [{ name: "agents", command: "/usr/local/bin/agent-server", args: ["--port", "8080"], env: [] }],
    });
  });
});


describe("SPEED4 warm session reuse (fake CLI)", () => {
  let instance: ProviderInstance;
  let recorder: EventRecorder;
  let scratch: string;

  const WarmGrok = createAcpDriver({
    ...grokSupport,
    // Deterministic identity so fake-CLI tests do not depend on ~/.grok/auth.json.
    warmSessionIdentity: () => "speed4-test-identity",
    warmIdleMs: 200,
    isAuthenticated: () => true,
  });

  // Dump/late paths via create().env. Leave FAKE_ACP_MODE on live process.env
  // so mid-test mode switches (hang -> happy) reach cold respawns.
  const fakeEnv = (): Record<string, string> => {
    const env: Record<string, string> = {};
    for (const key of [
      "FAKE_ACP_RPC_DUMP",
      "FAKE_ACP_DUMP",
      "FAKE_ACP_LATE_CHUNK_MS",
      "FAKE_ACP_LATE_SESSION_ID",
      "FAKE_ACP_LATE_REPLAY",
      "FAKE_ACP_LATE_TEXT",
      "FAKE_ACP_BILLING_DELAY_MS",
      "FAKE_ACP_BILLING_END",
      "FAKE_ACP_BILLING_PERCENT",
    ]) {
      const value = process.env[key];
      if (value) env[key] = value;
    }
    return env;
  };

  const createWarm = async (mode = "happy", fullAuto = false) => {
    if (mode) process.env.FAKE_ACP_MODE = mode;
    instance = await WarmGrok.create({
      instanceId: "speed4-warm",
      displayName: "SPEED4 Warm",
      environment: fakeEnv(),
      enabled: true,
      config: { cli: FAKE_CLI, fullAuto, workspace: scratch },
    });
    recorder = recordEvents(instance.adapter);
  };

  beforeEach(() => {
    ensureDirs();
    chmodSync(FAKE_CLI, 0o755);
    scratch = mkdtempSync(join(tmpdir(), "omb-speed4-"));
  });

  afterEach(async () => {
    recorder?.stop();
    await instance?.dispose();
    delete process.env.FAKE_ACP_MODE;
    delete process.env.FAKE_ACP_SESSION_ID;
    delete process.env.FAKE_ACP_DUMP;
    delete process.env.FAKE_ACP_RPC_DUMP;
    delete process.env.FAKE_ACP_LATE_CHUNK_MS;
    delete process.env.FAKE_ACP_LATE_SESSION_ID;
    delete process.env.FAKE_ACP_LATE_REPLAY;
    delete process.env.FAKE_ACP_LATE_TEXT;
    delete process.env.FAKE_ACP_BILLING_DELAY_MS;
    delete process.env.FAKE_ACP_BILLING_END;
    delete process.env.FAKE_ACP_BILLING_PERCENT;
    await removeTempDir(scratch);
  });

  const rpcMethods = () => {
    const raw = readFileSync(process.env.FAKE_ACP_RPC_DUMP!, "utf8").trim();
    if (!raw) return [] as string[];
    try {
      return JSON.parse(raw) as string[];
    } catch {
      return [] as string[];
    }
  };

  const waitForRpc = async (pred: (methods: string[]) => boolean, timeoutMs = 5_000) => {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      const methods = rpcMethods();
      if (pred(methods)) return methods;
      await new Promise((r) => setTimeout(r, 20));
    }
    return rpcMethods();
  };

  const sessionIdFor = (turnId: string) => {
    const started = recorder.events.find((e) => e.type === "session.started" && e.turnId === turnId) as any;
    expect(started?.sessionId).toEqual(expect.any(String));
    return started?.sessionId as string;
  };

  it("runs two consecutive prompts on one child without re-initialize/load", async () => {
    process.env.FAKE_ACP_RPC_DUMP = join(scratch, "warm-rpc.json");
    writeFileSync(process.env.FAKE_ACP_RPC_DUMP, "[]");
    await createWarm();
    const t1 = await instance.adapter.sendTurn({ threadId: "t-warm", text: "one", system: "persona-a" });
    await recorder.until((e) => e.type === "turn.completed" && e.turnId === t1.turnId);
    const sessionId = sessionIdFor(t1.turnId);

    const t2 = await instance.adapter.sendTurn({
      threadId: "t-warm",
      text: "two",
      system: "persona-b-with-task-state",
      resumeCursor: sessionId,
    });
    expect(t2.turnId).not.toBe(t1.turnId);
    await recorder.until((e) => e.type === "turn.completed" && e.turnId === t2.turnId);

    const rpc = await waitForRpc((m) => m.filter((x) => x === "session/prompt").length >= 2);
    expect(rpc.filter((m) => m === "initialize")).toHaveLength(1);
    expect(rpc.filter((m) => m === "session/new")).toHaveLength(1);
    expect(rpc.filter((m) => m === "session/load")).toHaveLength(0);
    expect(rpc.filter((m) => m === "session/prompt").length).toBeGreaterThanOrEqual(2);
    // Distinct Orbit turnIds; same provider session; system text change did not invalidate reuse.
    expect(sessionIdFor(t2.turnId)).toBe(sessionId);
    expect(recorder.events.filter((e) => e.type === "content.delta" && e.turnId === t2.turnId).length).toBeGreaterThan(0);
  });

  it("starts fresh when model, effort, approval, cwd, or tools change", async () => {
    process.env.FAKE_ACP_RPC_DUMP = join(scratch, "drift-rpc.json");
    writeFileSync(process.env.FAKE_ACP_RPC_DUMP, "[]");
    await createWarm();
    const t1 = await instance.adapter.sendTurn({
      threadId: "t-drift",
      text: "one",
      model: "grok-4.6",
      effort: "low",
      approval: "ask",
      cwd: scratch,
    });
    await recorder.until((e) => e.type === "turn.completed" && e.turnId === t1.turnId);
    const sessionId = sessionIdFor(t1.turnId);

    // Model change must cold-start.
    writeFileSync(process.env.FAKE_ACP_RPC_DUMP, "[]");
    const t2 = await instance.adapter.sendTurn({
      threadId: "t-drift",
      text: "two",
      model: "grok-4.5",
      effort: "low",
      approval: "ask",
      cwd: scratch,
      resumeCursor: sessionId,
    });
    await recorder.until((e) => e.type === "turn.completed" && e.turnId === t2.turnId);
    // Model mismatch discards warm and cold-starts (load if resumeCursor set, else new).
    const afterModel = rpcMethods();
    expect(afterModel.filter((m) => m === "initialize").length).toBeGreaterThanOrEqual(1);
    expect(afterModel.includes("session/load") || afterModel.includes("session/new")).toBe(true);

    const session2 = sessionIdFor(t2.turnId);
    writeFileSync(process.env.FAKE_ACP_RPC_DUMP, "[]");
    const t3 = await instance.adapter.sendTurn({
      threadId: "t-drift",
      text: "three",
      model: "grok-4.5",
      effort: "high",
      approval: "ask",
      cwd: scratch,
      resumeCursor: session2,
    });
    await recorder.until((e) => e.type === "turn.completed" && e.turnId === t3.turnId);
    // Effort drift → another cold session/new (rpc dump rewritten by new process).
    expect(rpcMethods().includes("session/new") || rpcMethods().includes("initialize")).toBe(true);
  });

  it("isolates two bot instances (no cross-bot warm pooling)", async () => {
    process.env.FAKE_ACP_MODE = "happy";
    const a = await WarmGrok.create({
      instanceId: "speed4-a",
      displayName: "A",
      environment: { ...fakeEnv(), FAKE_ACP_SESSION_ID: "fake-session-a" },
      enabled: true,
      config: { cli: FAKE_CLI, fullAuto: false, workspace: scratch },
    });
    const b = await WarmGrok.create({
      instanceId: "speed4-b",
      displayName: "B",
      environment: { ...fakeEnv(), FAKE_ACP_SESSION_ID: "fake-session-b" },
      enabled: true,
      config: { cli: FAKE_CLI, fullAuto: false, workspace: scratch },
    });
    const ra = recordEvents(a.adapter);
    const rb = recordEvents(b.adapter);
    try {
      const ta = await a.adapter.sendTurn({ threadId: "thread-a", text: "a1" });
      await ra.until((e) => e.type === "turn.completed" && e.turnId === ta.turnId);
      const tb = await b.adapter.sendTurn({ threadId: "thread-b", text: "b1" });
      await rb.until((e) => e.type === "turn.completed" && e.turnId === tb.turnId);
      const sa = (ra.events.find((e) => e.type === "session.started") as any).sessionId;
      const sb = (rb.events.find((e) => e.type === "session.started") as any).sessionId;
      // Follow-ups stay on their own instance/thread.
      await a.adapter.sendTurn({ threadId: "thread-a", text: "a2", resumeCursor: sa });
      await ra.until((e) => e.type === "turn.completed" && e.turnId !== ta.turnId);
      await b.adapter.sendTurn({ threadId: "thread-b", text: "b2", resumeCursor: sb });
      await rb.until((e) => e.type === "turn.completed" && e.turnId !== tb.turnId);
      expect(sa).toBeTruthy();
      expect(sb).toBeTruthy();
      expect(sa).not.toBe(sb);
    } finally {
      ra.stop();
      rb.stop();
      await a.dispose();
      await b.dispose();
    }
  });

  it("does not reuse when resumeCursor is missing or different", async () => {
    process.env.FAKE_ACP_RPC_DUMP = join(scratch, "cursor-rpc.json");
    writeFileSync(process.env.FAKE_ACP_RPC_DUMP, "[]");
    await createWarm();
    const t1 = await instance.adapter.sendTurn({ threadId: "t-cursor", text: "one" });
    await recorder.until((e) => e.type === "turn.completed" && e.turnId === t1.turnId);
    const sessionId = sessionIdFor(t1.turnId);
    const promptsAfterT1 = rpcMethods().filter((m) => m === "session/prompt").length;

    // Missing cursor (compaction) → kill warm + cold respawn. A new process
    // overwrites the rpc dump, so prompt count resets instead of accumulating.
    // Distinct FAKE_ACP_SESSION_ID reaches the cold child via process.env (same
    // mid-test switch pattern as FAKE_ACP_MODE), so we can assert a new session.
    process.env.FAKE_ACP_SESSION_ID = "fake-session-after-compact";
    const t2 = await instance.adapter.sendTurn({ threadId: "t-cursor", text: "compacted" });
    await recorder.until((e) => e.type === "turn.completed" && e.turnId === t2.turnId);
    const afterMissing = await waitForRpc((m) => m.includes("session/new") || m.includes("initialize"));
    expect(afterMissing.filter((m) => m === "session/prompt").length).toBeLessThanOrEqual(promptsAfterT1);
    expect(afterMissing.includes("session/new") || afterMissing.includes("initialize")).toBe(true);
    expect(sessionIdFor(t2.turnId)).toBeTruthy();
    expect(sessionIdFor(t2.turnId)).not.toBe(sessionId);

    // Different cursor → session/load (or new after failed load) on a fresh child.
    const t3 = await instance.adapter.sendTurn({
      threadId: "t-cursor",
      text: "rewind",
      resumeCursor: "other-session-id",
      resumeFallback: { text: "fallback" },
    });
    await recorder.until((e) => e.type === "turn.completed" && e.turnId === t3.turnId);
    const afterDiff = await waitForRpc((m) => m.includes("session/load") || m.includes("session/new"));
    expect(afterDiff.includes("session/load") || afterDiff.includes("session/new")).toBe(true);
    expect(sessionId).toBeTruthy();
  });

  it("recovers with a cold spawn after stopAll kills the warm child", async () => {
    process.env.FAKE_ACP_RPC_DUMP = join(scratch, "kill-rpc.json");
    writeFileSync(process.env.FAKE_ACP_RPC_DUMP, "[]");
    await createWarm();
    const t1 = await instance.adapter.sendTurn({ threadId: "t-kill", text: "one" });
    await recorder.until((e) => e.type === "turn.completed" && e.turnId === t1.turnId);
    const sessionId = sessionIdFor(t1.turnId);
    const promptsBeforeKill = rpcMethods().filter((m) => m === "session/prompt").length;
    await instance.adapter.stopAll();
    const t2 = await instance.adapter.sendTurn({ threadId: "t-kill", text: "two", resumeCursor: sessionId });
    await recorder.until((e) => e.type === "turn.completed" && e.turnId === t2.turnId);
    const rpc = await waitForRpc((m) => m.includes("initialize") || m.includes("session/load") || m.includes("session/new"));
    // New process overwrote the dump (not an accumulated warm follow-up).
    expect(rpc.filter((m) => m === "session/prompt").length).toBeLessThanOrEqual(promptsBeforeKill);
    expect(rpc.includes("session/load") || rpc.includes("session/new") || rpc.includes("initialize")).toBe(true);
  });

  it("recovers after a poisoned RPC failure without duplicate generation", async () => {
    await createWarm("fail-after-text");
    const t1 = await instance.adapter.sendTurn({ threadId: "t-poison", text: "boom" });
    const done1 = await recorder.until((e) => e.type === "turn.completed" && e.turnId === t1.turnId);
    expect(done1).toMatchObject({ ok: false });
    process.env.FAKE_ACP_MODE = "happy";
    process.env.FAKE_ACP_RPC_DUMP = join(scratch, "poison-rpc.json");
    writeFileSync(process.env.FAKE_ACP_RPC_DUMP, "[]");
    const t2 = await instance.adapter.sendTurn({ threadId: "t-poison", text: "recover" });
    const done2 = await recorder.until((e) => e.type === "turn.completed" && e.turnId === t2.turnId);
    expect(done2).toMatchObject({ ok: true });
    expect(rpcMethods().filter((m) => m === "session/prompt").length).toBeGreaterThanOrEqual(1);
  });

  it("cancel then send starts a fresh turn", async () => {
    // Use stock hang interrupt path (same as existing ACP suite).
    await createWarm("hang");
    const t1 = await instance.adapter.sendTurn({ threadId: "t-cancel", text: "hang" });
    await recorder.until((e) => e.type === "content.delta" || e.type === "turn.started");
    await instance.adapter.interruptTurn("t-cancel");
    const done1 = await recorder.until((e) => e.type === "turn.completed" && e.turnId === t1.turnId, 15_000);
    expect(["cancelled", "exit_before_result"]).toContain((done1 as any).stopReason);
    process.env.FAKE_ACP_MODE = "happy";
    const t2 = await instance.adapter.sendTurn({ threadId: "t-cancel", text: "after" });
    const done2 = await recorder.until((e) => e.type === "turn.completed" && e.turnId === t2.turnId);
    expect(done2).toMatchObject({ ok: true });
    expect(t2.turnId).not.toBe(t1.turnId);
  });

  it("cancel while billing readiness is pending does not retry the canceled prompt", async () => {
    await createWarm("billing-hang");
    const t1 = await instance.adapter.sendTurn({ threadId: "t-bill-cancel", text: "one" });
    await recorder.until((e) => e.type === "turn.completed" && e.turnId === t1.turnId);
    const sessionId = sessionIdFor(t1.turnId);
    const completedBefore = recorder.events.filter((e) => e.type === "turn.completed").length;

    // Next turn blocks on ready (hanging billing). Interrupt must cancel, not recurse.
    const pending = instance.adapter.sendTurn({
      threadId: "t-bill-cancel",
      text: "should-not-run",
      resumeCursor: sessionId,
    });
    // Give the await-ready path a tick, then cancel via the reserved active entry.
    await new Promise((r) => setTimeout(r, 50));
    await instance.adapter.interruptTurn("t-bill-cancel");
    const { turnId } = await pending;
    const done = await recorder.until((e) => e.type === "turn.completed" && e.turnId === turnId);
    expect(done).toMatchObject({ stopReason: "cancelled" });
    expect(turnId).not.toBe(t1.turnId);
    expect(recorder.events.filter((e) => e.type === "turn.completed").length).toBe(completedBefore + 1);
  });

  it("allows an immediate follow-up send from a turn.completed listener", async () => {
    process.env.FAKE_ACP_RPC_DUMP = join(scratch, "sync-rpc.json");
    writeFileSync(process.env.FAKE_ACP_RPC_DUMP, "[]");
    await createWarm();
    let follow: Promise<{ turnId: string }> | null = null;
    let sessionId = "";
    const unsub = instance.adapter.onEvent((e) => {
      if (e.type === "session.started") sessionId = (e as any).sessionId;
      if (e.type === "turn.completed" && (e as any).ok && !follow && sessionId) {
        follow = instance.adapter.sendTurn({
          threadId: "t-sync",
          text: "from-callback",
          resumeCursor: sessionId,
        });
      }
    });
    try {
      const t1 = await instance.adapter.sendTurn({ threadId: "t-sync", text: "one" });
      await recorder.until((e) => e.type === "turn.completed" && e.turnId === t1.turnId);
      expect(follow).toBeTruthy();
      const t2 = await follow!;
      await recorder.until((e) => e.type === "turn.completed" && e.turnId === t2.turnId);
      const rpc = await waitForRpc((m) => m.filter((x) => x === "session/prompt").length >= 2);
      expect(rpc.filter((m) => m === "session/prompt").length).toBeGreaterThanOrEqual(2);
      expect(rpc.filter((m) => m === "initialize").length).toBe(1);
    } finally {
      unsub();
    }
  });

  it("evicts an idle warm child after TTL", async () => {
    const ShortTtl = createAcpDriver({
      ...grokSupport,
      warmSessionIdentity: () => "speed4-ttl-identity",
      warmIdleMs: 80,
      isAuthenticated: () => true,
    });
    process.env.FAKE_ACP_MODE = "happy";
    process.env.FAKE_ACP_RPC_DUMP = join(scratch, "ttl-rpc.json");
    writeFileSync(process.env.FAKE_ACP_RPC_DUMP, "[]");
    instance = await ShortTtl.create({
      instanceId: "speed4-ttl",
      displayName: "TTL",
      environment: fakeEnv(),
      enabled: true,
      config: { cli: FAKE_CLI, fullAuto: false, workspace: scratch },
    });
    recorder = recordEvents(instance.adapter);
    const t1 = await instance.adapter.sendTurn({ threadId: "t-ttl", text: "one" });
    await recorder.until((e) => e.type === "turn.completed" && e.turnId === t1.turnId);
    const sessionId = sessionIdFor(t1.turnId);
    const promptsAfterT1 = rpcMethods().filter((m) => m === "session/prompt").length;
    // 80ms TTL needs real margin here: under CI scheduler contention the eviction
    // setTimeout can fire late, so a short wait races it and flakes.
    await new Promise((r) => setTimeout(r, 800));
    const t2 = await instance.adapter.sendTurn({ threadId: "t-ttl", text: "two", resumeCursor: sessionId });
    await recorder.until((e) => e.type === "turn.completed" && e.turnId === t2.turnId);
    const after = await waitForRpc((m) => m.includes("initialize") || m.includes("session/load") || m.includes("session/new"));
    // TTL eviction kills the idle child; the follow-up is a cold respawn that
    // overwrites the rpc dump instead of accumulating another prompt on it.
    expect(after.filter((m) => m === "session/prompt").length).toBeLessThanOrEqual(promptsAfterT1);
    expect(after.includes("initialize") || after.includes("session/new") || after.includes("session/load")).toBe(true);
  });

  it("dispose kills owned warm children", async () => {
    process.env.FAKE_ACP_RPC_DUMP = join(scratch, "dispose-rpc.json");
    writeFileSync(process.env.FAKE_ACP_RPC_DUMP, "[]");
    await createWarm();
    const t1 = await instance.adapter.sendTurn({ threadId: "t-dispose", text: "one" });
    await recorder.until((e) => e.type === "turn.completed" && e.turnId === t1.turnId);
    await instance.dispose();
    // Recreate — prior warm must be gone (new process / initialize).
    process.env.FAKE_ACP_RPC_DUMP = join(scratch, "dispose-rpc2.json");
    writeFileSync(process.env.FAKE_ACP_RPC_DUMP, "[]");
    await createWarm();
    const t2 = await instance.adapter.sendTurn({ threadId: "t-dispose", text: "two" });
    await recorder.until((e) => e.type === "turn.completed" && e.turnId === t2.turnId);
    const rpc = await waitForRpc((m) => m.includes("initialize"));
    expect(rpc.filter((m) => m === "initialize").length).toBeGreaterThanOrEqual(1);
  });

  it("preserves billing across warm reuse", async () => {
    process.env.FAKE_ACP_BILLING_END = new Date(Date.now() + 3 * 24 * 60 * 60 * 1000).toISOString();
    await createWarm("happy");
    const t1 = await instance.adapter.sendTurn({ threadId: "t-bill", text: "one" });
    await recorder.until((e) => e.type === "turn.completed" && e.turnId === t1.turnId);
    await recorder.until((e) => e.type === "account.rate-limits.updated");
    const sessionId = sessionIdFor(t1.turnId);
    const t2 = await instance.adapter.sendTurn({ threadId: "t-bill", text: "two", resumeCursor: sessionId });
    await recorder.until((e) => e.type === "turn.completed" && e.turnId === t2.turnId);
    // Second billing update for the follow-up turn.
    await recorder.until(
      (e) => e.type === "account.rate-limits.updated" && e.turnId === t2.turnId,
    );
  });

  it("preserves permission asks on a warm follow-up", async () => {
    // Child mode is fixed at spawn — keep permission mode for both turns.
    await createWarm("permission");
    const t1 = await instance.adapter.sendTurn({ threadId: "t-perm", text: "ask-1" });
    const opened1 = await recorder.until((e) => e.type === "request.opened" && e.turnId === t1.turnId);
    await instance.adapter.respondToRequest!("t-perm", (opened1 as any).requestId, { behavior: "allow" });
    await recorder.until((e) => e.type === "turn.completed" && e.turnId === t1.turnId);
    const sessionId = sessionIdFor(t1.turnId);
    const t2 = await instance.adapter.sendTurn({ threadId: "t-perm", text: "ask-2", resumeCursor: sessionId });
    const opened2 = await recorder.until((e) => e.type === "request.opened" && e.turnId === t2.turnId);
    await instance.adapter.respondToRequest!("t-perm", (opened2 as any).requestId, { behavior: "allow" });
    await recorder.until((e) => e.type === "turn.completed" && e.turnId === t2.turnId);
  });

  it("preserves steer on a warm follow-up", async () => {
    await createWarm("steer");
    const t1 = await instance.adapter.sendTurn({ threadId: "t-steer-warm", text: "first" });
    await recorder.until((e) => e.type === "content.delta" && e.turnId === t1.turnId);
    expect(await instance.adapter.steer!("t-steer-warm", "extra-1")).toBe(true);
    await recorder.until((e) => e.type === "turn.completed" && e.turnId === t1.turnId);
    const sessionId = sessionIdFor(t1.turnId);
    const t2 = await instance.adapter.sendTurn({ threadId: "t-steer-warm", text: "second", resumeCursor: sessionId });
    await recorder.until((e) => e.type === "content.delta" && e.turnId === t2.turnId);
    expect(await instance.adapter.steer!("t-steer-warm", "extra-2")).toBe(true);
    await recorder.until((e) => e.type === "turn.completed" && e.turnId === t2.turnId);
  });

  it("filters injected late notifications with wrong session or isReplay", async () => {
    process.env.FAKE_ACP_LATE_CHUNK_MS = "30";
    process.env.FAKE_ACP_LATE_TEXT = "LATE_WRONG";
    process.env.FAKE_ACP_LATE_SESSION_ID = "not-this-session";
    process.env.FAKE_ACP_RPC_DUMP = join(scratch, "late-rpc.json");
    writeFileSync(process.env.FAKE_ACP_RPC_DUMP, "[]");
    await createWarm();
    const t1 = await instance.adapter.sendTurn({ threadId: "t-late", text: "one" });
    await recorder.until((e) => e.type === "turn.completed" && e.turnId === t1.turnId);
    await new Promise((r) => setTimeout(r, 80));
    // Wrong-session late chunk must not appear as assistant text on t1 after settle
    // (handlers are cleared) nor leak into a follow-up before promptSent.
    const lateOnT1 = recorder.events.filter(
      (e) => e.type === "content.delta" && e.turnId === t1.turnId && (e as any).delta === "LATE_WRONG",
    );
    expect(lateOnT1).toHaveLength(0);

    // The fake CLI reads its late-event settings only when it starts. Replace
    // the warm child before testing the replay metadata gate.
    recorder.stop();
    await instance.dispose();
    delete process.env.FAKE_ACP_LATE_SESSION_ID;
    process.env.FAKE_ACP_LATE_REPLAY = "1";
    process.env.FAKE_ACP_LATE_TEXT = "LATE_REPLAY";
    await createWarm();
    const t2 = await instance.adapter.sendTurn({ threadId: "t-late", text: "two" });
    await recorder.until((e) => e.type === "turn.completed" && e.turnId === t2.turnId);
    await new Promise((r) => setTimeout(r, 80));
    const replayOnT2 = recorder.events.filter(
      (e) => e.type === "content.delta" && e.turnId === t2.turnId && (e as any).delta === "LATE_REPLAY",
    );
    expect(replayOnT2).toHaveLength(0);
  });
});


describe("ACP decodeConfig", () => {
  it("requires an explicit boolean to opt into prewarm", () => {
    expect(GrokAgentDriver.decodeConfig({ prewarm: true }).prewarm).toBe(true);
    expect(GrokAgentDriver.decodeConfig({ prewarm: "true" }).prewarm).toBe(false);
  });
  it("resolves a dynamic model catalog when a support provides one", async () => {
    const support: AcpSupport = {
      driverKind: "dynamic-test",
      displayName: "Dynamic Test",
      models: { default: "fallback", options: [{ id: "fallback", label: "Fallback" }] },
      defaultCli: FAKE_CLI,
      nativeSource: "dynamic-test.acp",
      loginNote: "not authenticated",
      spawnArgs: () => [],
      pickAuthMethod: () => null,
      authFailure: "continue",
      isAuthenticated: () => true,
      resolveModels: async () => ({
        default: "dynamic-model",
        options: [{ id: "dynamic-model", label: "Dynamic model" }],
      }),
    };
    const driver = createAcpDriver(support);
    const instance = await driver.create({
      instanceId: "dynamic-test",
      displayName: "Dynamic Test",
      environment: {},
      enabled: true,
      config: driver.defaultConfig(),
    });
    expect(instance.models).toEqual({
      default: "dynamic-model",
      options: [{ id: "dynamic-model", label: "Dynamic model" }],
    });
    await instance.dispose();
  });
  it("grok defaults to the grok binary", () => {
    expect(GrokAgentDriver.decodeConfig({})).toEqual({ cli: "grok", fullAuto: false, prewarm: false, workspace: undefined });
  });
  it("grok declares official installers including Windows PowerShell", () => {
    expect(GrokAgentDriver.install?.command).toEqual({
      darwin: "curl -fsSL https://x.ai/cli/install.sh | bash",
      linux: "curl -fsSL https://x.ai/cli/install.sh | bash",
      win32: "irm https://x.ai/cli/install.ps1 | iex",
    });
    expect(GrokAgentDriver.install?.docsUrl).toBe("https://x.ai/cli");
    expect(GrokAgentDriver.install?.signInCommand).toBe("grok login");
  });
  it("gemini defaults to the gemini binary", () => {
    expect(GeminiAgentDriver.decodeConfig(undefined)).toEqual({ cli: "gemini", fullAuto: false, prewarm: false, workspace: undefined });
  });
  it("kimi defaults to the kimi binary and declares cross-platform setup", () => {
    expect(KimiAgentDriver.decodeConfig(undefined)).toEqual({ cli: "kimi", fullAuto: false, prewarm: false, workspace: undefined });
    expect(KimiAgentDriver.install?.command).toMatchObject({
      darwin: expect.stringContaining("install.sh"),
      linux: expect.stringContaining("install.sh"),
      win32: expect.stringContaining("install.ps1"),
    });
    expect(KimiAgentDriver.install?.signInCommand).toBe("kimi login");
  });
  it("droid defaults to the droid binary and declares cross-platform setup", () => {
    expect(DroidAgentDriver.decodeConfig(undefined)).toEqual({ cli: "droid", fullAuto: false, prewarm: false, workspace: undefined });
    expect(DroidAgentDriver.install?.command).toMatchObject({
      darwin: expect.stringContaining("factory.ai/cli"),
      linux: expect.stringContaining("factory.ai/cli"),
      win32: expect.stringContaining("factory.ai/cli"),
    });
    expect(DroidAgentDriver.install?.signInCommand).toBe("droid");
  });
  it("cursor defaults to its unambiguous binary and declares cross-platform setup", () => {
    expect(CursorAgentDriver.decodeConfig(undefined)).toEqual({
      cli: "cursor-agent",
      fullAuto: false,
      prewarm: false,
      workspace: undefined,
    });
    expect(CursorAgentDriver.install?.command).toMatchObject({
      darwin: expect.stringContaining("cursor.com/install"),
      linux: expect.stringContaining("cursor.com/install"),
      win32: expect.stringContaining("cursor.com/install"),
    });
    expect(CursorAgentDriver.install?.signInCommand).toBe("cursor-agent login");
  });
  it("fullAuto only when explicitly true", () => {
    expect(GrokAgentDriver.decodeConfig({ fullAuto: "yes" }).fullAuto).toBe(false);
    expect(GrokAgentDriver.decodeConfig({ fullAuto: true }).fullAuto).toBe(true);
  });

  it("does not advertise or accept local CUA in full-auto mode", async () => {
    const fullAuto = await GrokAgentDriver.create({
      instanceId: "grok-full-auto",
      displayName: "Grok Full Auto",
      environment: {},
      enabled: true,
      config: { cli: FAKE_CLI, fullAuto: true },
    });
    expect(fullAuto.adapter.capabilities.localComputerMcp).toBe(false);
    await expect(
      fullAuto.adapter.sendTurn({
        threadId: "t-full-auto-local",
        text: "click",
        integrations: {
          localComputer: {
            command: "/cua-driver",
            args: ["mcp"],
            env: {},
            platform: "linux",
            scope: "local-computer",
          },
        },
      }),
    ).rejects.toThrow(/interactive provider approvals/);
    await fullAuto.dispose();
  });
});

describe("ACP turns (fake CLI)", () => {
  let instance: ProviderInstance;
  let recorder: EventRecorder;
  let scratch: string;

  const create = async (driver = GrokAgentDriver, mode?: string, fullAuto = false) => {
    if (mode) process.env.FAKE_ACP_MODE = mode;
    instance = await driver.create({
      instanceId: "acp-test",
      displayName: "ACP Test",
      environment: {},
      enabled: true,
      config: { cli: FAKE_CLI, fullAuto },
    });
    recorder = recordEvents(instance.adapter);
  };

  beforeEach(() => {
    ensureDirs();
    chmodSync(FAKE_CLI, 0o755);
    scratch = mkdtempSync(join(tmpdir(), "omb-acp-test-"));
  });

  it("steers Grok through an acknowledged interjection in the running prompt", async () => {
    await create(GrokAgentDriver, "steer");
    expect(instance.adapter.capabilities.queueing).toBe(true);
    expect(await instance.adapter.steer!("missing", "extra")).toBe(false);
    await instance.adapter.sendTurn({ threadId: "t-steer", text: "first" });
    await recorder.until((e) => e.type === "content.delta");
    expect(await instance.adapter.steer!("t-steer", "extra")).toBe(true);
    await recorder.until((e) => e.type === "turn.completed");
    expect(recorder.events.filter((e) => e.type === "turn.started")).toHaveLength(1);
    expect(recorder.events).toContainEqual(expect.objectContaining({ type: "content.delta", delta: "extra" }));
    expect(recorder.events).toContainEqual(expect.objectContaining({ type: "item.completed", text: "working" }));
    expect(recorder.events).toContainEqual(expect.objectContaining({ type: "item.completed", text: "extra" }));
    expect(await instance.adapter.steer!("t-steer", "late")).toBe(false);
  });

  it("does not mistake a removed Grok prompt for a delivered interjection", async () => {
    await create(GrokAgentDriver, "steer-removed");
    await instance.adapter.sendTurn({ threadId: "t-removed", text: "first" });
    await recorder.until((e) => e.type === "content.delta");
    expect(await instance.adapter.steer!("t-removed", "extra")).toBe(false);
    await instance.adapter.interruptTurn("t-removed");
    await recorder.until((e) => e.type === "turn.completed");
  });

  it("waits for a Grok interjection notice that trails its prompt result", async () => {
    await create(GrokAgentDriver, "steer-result-first");
    await instance.adapter.sendTurn({ threadId: "t-result-first", text: "first" });
    await recorder.until((e) => e.type === "content.delta");
    expect(await instance.adapter.steer!("t-result-first", "extra")).toBe(true);
    expect(await recorder.until((e) => e.type === "turn.completed")).toMatchObject({ ok: true, stopReason: null });
    expect(recorder.events.filter((e) => e.type === "turn.started")).toHaveLength(1);
    expect(recorder.events.filter((e) => e.type === "item.completed" && e.itemType === "assistant_text" && e.text === "extra")).toHaveLength(1);
  });

  it("keeps a Grok steer that outlives the running prompt inside the same turn", async () => {
    await create(GrokAgentDriver, "steer-original-first");
    await instance.adapter.sendTurn({ threadId: "t-original-first", text: "first" });
    await recorder.until((e) => e.type === "content.delta");
    expect(await instance.adapter.steer!("t-original-first", "extra")).toBe(true);
    // accepted when the first prompt ends, before the queued one answers
    expect(recorder.events).toContainEqual(expect.objectContaining({ type: "item.completed", text: "working" }));
    expect(recorder.events).not.toContainEqual(expect.objectContaining({ type: "content.delta", delta: "extra" }));
    expect(await recorder.until((e) => e.type === "turn.completed")).toMatchObject({ ok: true, stopReason: null });
    expect(recorder.events.filter((e) => e.type === "turn.started")).toHaveLength(1);
    expect(recorder.events.filter((e) => e.type === "item.completed" && e.itemType === "assistant_text" && e.text === "extra")).toHaveLength(1);
  });

  it("does not advertise steering on unproven ACP engines", async () => {
    await create(GeminiAgentDriver);
    expect(instance.adapter.capabilities.queueing).not.toBe(true);
    expect(instance.adapter.steer).toBeUndefined();
  });

  afterEach(async () => {
    delete process.env.FAKE_ACP_MODE;
    delete process.env.FAKE_ACP_DUMP;
    delete process.env.FAKE_ACP_RPC_DUMP;
    delete process.env.XAI_API_KEY;
    delete process.env.META_API_KEY;
    delete process.env.CURSOR_API_KEY;
    delete process.env.CURSOR_AUTH_TOKEN;
    delete process.env.BOX_TOKEN;
    delete process.env.OMB_TTS_KEY;
    delete process.env.FAKE_ACP_MODELS;
    delete process.env.FAKE_ACP_MODEL_STICKS;
    delete process.env.FAKE_ACP_USAGE_ROOT;
    delete process.env.FAKE_ACP_PERMISSION_KINDS;
    delete process.env.FAKE_ACP_BILLING_PERCENT;
    delete process.env.FAKE_ACP_BILLING_END;
    for (const name of FOREIGN_CREDENTIALS) delete process.env[name];
    recorder?.stop();
    await instance?.dispose();
    await removeTempDir(scratch);
  });

  it("normalizes a full turn into the canonical event sequence", async () => {
    await create();
    const { turnId } = await instance.adapter.sendTurn({ threadId: "t-happy", text: "hi", model: "grok-4.5" });
    await recorder.until((e) => e.type === "turn.completed");

    const types = recorder.events.map((e) => e.type);
    expect(types).toEqual([
      "turn.started",
      "session.started",
      "content.delta",
      "item.completed", // assistant_text before the tool, not summed on settle
      "item.started", // tool tc-1
      "item.completed", // tool tc-1 done
      "thread.token-usage.updated",
      "turn.completed",
    ]);
    expect(recorder.events.every((e) => e.turnId === turnId && e.provider === "grokAgent")).toBe(true);
    const usage = recorder.events.find((e) => e.type === "thread.token-usage.updated")!;
    expect(usage).toMatchObject({ input: 10, output: 5 });
    const text = recorder.events.find((e) => e.type === "item.completed" && (e as any).itemType === "assistant_text")!;
    expect((text as any).text).toBe("hello from fake acp");
    const done = recorder.events.at(-1)!;
    expect(done).toMatchObject({ type: "turn.completed", ok: true });
    expect(instance.adapter.hasSession("t-happy")).toBe(false);
  });

  it("lets an ambiently-authenticated Muse session past the handshake with no ACP authenticate step", async () => {
    // The harness advertises no authMethods (live `muse serve` initialize
    // carries none either), so pickAuthMethod is null; the META_API_KEY /
    // stored login is the whole credential and must reach session/new.
    process.env.META_API_KEY = "meta-key";
    await create(MuseAgentDriver, "no-auth");
    await instance.adapter.sendTurn({ threadId: "t-muse-ambient-auth", text: "hi", model: "muse-spark-1.3" });
    const done = await recorder.until((e) => e.type === "turn.completed");
    expect(done).toMatchObject({ ok: true });
    expect(recorder.events).not.toContainEqual(expect.objectContaining({ type: "runtime.error" }));
  });

  it("translates Windows MCP commands for the WSL-crossing Muse driver", async () => {
    // The local spawn stays Windows-side, so the turn cwd must exist here;
    // the Windows-shaped server command is what crosses translated. cwd
    // mapping itself is covered by wslSessionPaths below (a Windows cwd
    // cannot spawn a child off-Windows to observe it through).
    process.env.META_API_KEY = "meta-key";
    await create(MuseAgentDriver);
    const dump = join(scratch, "wsl-paths.json");
    process.env.FAKE_ACP_DUMP = dump;
    await instance.adapter.sendTurn({
      threadId: "t-muse-wsl-paths",
      text: "hi",
      model: "muse-spark-1.3",
      cwd: scratch,
      integrations: { agents: { command: "C:\\tools\\agent-server.exe", args: ["--port", "8080"], env: {} } },
    });
    const done = await recorder.until((e) => e.type === "turn.completed");
    expect(done).toMatchObject({ ok: true });
    // The dump records session/new's cwd verbatim: translated on win32 where
    // the scratch dir is Windows-shaped, untouched POSIX elsewhere.
    expect(JSON.parse(readFileSync(`${dump}.cwd.json`, "utf8"))).toBe(toWslPath(scratch));
    const servers = JSON.parse(readFileSync(`${dump}.mcp.json`, "utf8"));
    expect(servers).toContainEqual(
      expect.objectContaining({ name: "agents", command: "/mnt/c/tools/agent-server.exe", args: ["--port", "8080"] }),
    );
  });

  it("sends MCP commands verbatim for drivers that stay on Windows", async () => {
    await create(GrokAgentDriver);
    const dump = join(scratch, "verbatim-paths.json");
    process.env.FAKE_ACP_DUMP = dump;
    await instance.adapter.sendTurn({
      threadId: "t-grok-verbatim-paths",
      text: "hi",
      model: "grok-4.5",
      cwd: scratch,
      integrations: { agents: { command: "C:\\tools\\agent-server.exe", args: [], env: {} } },
    });
    const done = await recorder.until((e) => e.type === "turn.completed");
    expect(done).toMatchObject({ ok: true });
    expect(JSON.parse(readFileSync(`${dump}.cwd.json`, "utf8"))).toBe(scratch);
    const servers = JSON.parse(readFileSync(`${dump}.mcp.json`, "utf8"));
    expect(servers).toContainEqual(expect.objectContaining({ name: "agents", command: "C:\\tools\\agent-server.exe" }));
  });

  it("emits each assistant text block before the tool that follows it", async () => {
    await create(GrokAgentDriver, "interleave");
    await instance.adapter.sendTurn({ threadId: "t-interleave", text: "go", model: "grok-4.5" });
    await recorder.until((e) => e.type === "turn.completed");

    const types = recorder.events.map((e) => e.type);
    expect(types).toEqual([
      "turn.started",
      "session.started",
      "content.delta",
      "item.completed", // before one
      "item.started", // tc-1
      "item.completed", // tc-1
      "content.delta",
      "item.completed", // before two
      "item.started", // tc-2
      "item.completed", // tc-2
      "content.delta",
      "thread.token-usage.updated",
      "item.completed", // after — no following tool, so settle flushes
      "turn.completed",
    ]);
    const texts = recorder.events
      .filter((e) => e.type === "item.completed" && (e as { itemType?: string }).itemType === "assistant_text")
      .map((e) => (e as { text: string }).text);
    expect(texts).toEqual(["before one", "before two", "after"]);
  });

  it("keeps nonterminal tool progress visible to the liveness watchdog", async () => {
    await create(GrokAgentDriver, "tool-progress");
    await instance.adapter.sendTurn({ threadId: "t-tool-progress", text: "go", model: "grok-4.5" });
    await recorder.until((e) => e.type === "turn.completed");

    expect(recorder.events.filter((e) => e.type === "item.updated")).toEqual([
      expect.objectContaining({ itemType: "tool", itemId: "tc-progress", tokens: 4 }),
      expect.objectContaining({ itemType: "tool", itemId: "tc-progress", tokens: null }),
    ]);
    expect(recorder.events.at(-1)).toMatchObject({ type: "turn.completed", ok: true });
  });

  it("reads token usage from the root of the prompt result", async () => {
    process.env.FAKE_ACP_USAGE_ROOT = "1";
    await create();
    await instance.adapter.sendTurn({ threadId: "t-usage-root", text: "go" });
    await recorder.until((e) => e.type === "turn.completed");

    const usage = recorder.events.find((e) => e.type === "thread.token-usage.updated");
    expect(usage).toMatchObject({ input: 10, output: 5 });
  });

  it("passes ACP stdio flags and strips foreign provider keys from the child env", async () => {
    await create();
    const dump = join(scratch, "dump.json");
    process.env.FAKE_ACP_DUMP = dump;
    process.env.XAI_API_KEY = "xai-should-not-leak";
    process.env.META_API_KEY = "meta-should-not-leak";
    process.env.CURSOR_API_KEY = "cursor-should-not-leak";
    process.env.CURSOR_AUTH_TOKEN = "cursor-token-should-not-leak";
    // workspace credentials with no CLI consumer at all — held by the
    // harness (env-injected at boot by the desktop shell), used in-process
    process.env.BOX_TOKEN = "box-should-not-leak";
    process.env.OMB_TTS_KEY = "tts-should-not-leak";

    await instance.adapter.sendTurn({ threadId: "t-hygiene", text: "go" });
    await recorder.until((e) => e.type === "turn.completed");

    const seen = JSON.parse(readFileSync(dump, "utf8"));
    expect(seen.argv).toContain("agent");
    expect(seen.argv).toContain("stdio");
    expect(seen.argv).toContain("--permission-mode");
    expect(seen.env.XAI_API_KEY).toBeUndefined();
    expect(seen.env.META_API_KEY).toBeUndefined();
    expect(seen.env.CURSOR_API_KEY).toBeUndefined();
    expect(seen.env.CURSOR_AUTH_TOKEN).toBeUndefined();
    expect(seen.env.BOX_TOKEN).toBeUndefined();
    expect(seen.env.OMB_TTS_KEY).toBeUndefined();
  });

  it("hands its children no credential it was not granted, known or not", async () => {
    await create();
    const dump = join(scratch, "dump-allowlist.json");
    process.env.FAKE_ACP_DUMP = dump;
    for (const name of FOREIGN_CREDENTIALS) process.env[name] = `${name}-must-not-leak`;

    await instance.adapter.sendTurn({ threadId: "t-cred-allowlist", text: "go" });
    await recorder.until((e) => e.type === "turn.completed");

    const seen = JSON.parse(readFileSync(dump, "utf8"));
    expect(Object.keys(seen.env).filter((name) => FOREIGN_CREDENTIALS.includes(name))).toEqual([]);
  });

  it("keeps each ACP driver's granted credentials while stripping AWS", async () => {
    const cases: Array<{ name: string; driver: ProviderDriver; keep: Record<string, string> }> = [
      { name: "gemini", driver: GeminiAgentDriver, keep: { GEMINI_API_KEY: "gemini-grant", GOOGLE_API_KEY: "google-grant" } },
      { name: "droid", driver: DroidAgentDriver, keep: { FACTORY_API_KEY: "factory-grant" } },
      { name: "cursor", driver: CursorAgentDriver, keep: { CURSOR_API_KEY: "cursor-grant", CURSOR_AUTH_TOKEN: "cursor-token-grant" } },
      {
        name: "muse",
        driver: MuseAgentDriver,
        keep: { META_API_KEY: "meta-grant" },
      },
    ];
    for (const { name, driver, keep } of cases) {
      const dump = join(scratch, `dump-grant-${name}.json`);
      const previous = Object.fromEntries(
        [...FOREIGN_CREDENTIALS, ...Object.keys(keep)].map((key) => [key, process.env[key]]),
      );
      process.env.FAKE_ACP_DUMP = dump;
      for (const key of FOREIGN_CREDENTIALS) process.env[key] = `${key}-must-not-leak`;
      for (const [key, value] of Object.entries(keep)) process.env[key] = value;
      const granted = await driver.create({
        instanceId: `acp-grant-${name}`,
        displayName: name,
        environment: {},
        enabled: true,
        config: { cli: FAKE_CLI, fullAuto: false },
      });
      try {
        await granted.snapshot();
        const seen = JSON.parse(readFileSync(dump, "utf8")) as { env: Record<string, string> };
        const observedCredentials = Object.fromEntries(
          [...new Set(FOREIGN_CREDENTIALS)]
            .filter((key) => seen.env[key] !== undefined)
            .map((key) => [key, seen.env[key]]),
        );
        expect({ driver: name, env: observedCredentials }).toEqual({ driver: name, env: keep });
      } finally {
        await granted.dispose();
        for (const key of Object.keys(previous)) {
          if (previous[key] === undefined) delete process.env[key];
          else process.env[key] = previous[key];
        }
      }
    }
  });

  it("writes Unsloth's studio token into grok config and keeps it off the child", async () => {
    const home = mkdtempSync(join(tmpdir(), "omb-acp-unsloth-"));
    mkdirSync(join(home, ".grok"), { recursive: true });
    const dump = join(scratch, "dump-unsloth.json");
    instance = await GrokAgentDriver.create({
      instanceId: "acp-unsloth",
      displayName: "ACP Test",
      environment: {
        HOME: home,
        USERPROFILE: home,
        FAKE_ACP_DUMP: dump,
        UNSLOTH_STUDIO_AUTH_TOKEN: "unsloth-grant",
      },
      enabled: true,
      config: { cli: FAKE_CLI, fullAuto: false },
    });
    recorder = recordEvents(instance.adapter);
    await instance.adapter.sendTurn({
      threadId: "t-unsloth",
      text: "go",
      model: "unsloth::Qwen3.8-27B",
    });
    await recorder.until((e) => e.type === "turn.completed");
    const toml = readFileSync(join(home, ".grok", "config.toml"), "utf8");
    expect(toml).toContain("unsloth-grant");
    const seen = JSON.parse(readFileSync(dump, "utf8")) as { env: Record<string, string> };
    expect(seen.env.UNSLOTH_STUDIO_AUTH_TOKEN).toBeUndefined();
  });

  // ACP session/new accepts stdio MCP entries, so connected apps use the
  // same harness-owned bridge as Claude and Codex.
  it("mounts connected apps as a stdio MCP server", async () => {
    await create();
    const dump = join(scratch, "composio.json");
    process.env.FAKE_ACP_DUMP = dump;
    expect(instance.adapter.capabilities.composioMcp).toBe(true);
    await instance.adapter.sendTurn({
      threadId: "t-composio",
      text: "go",
      integrations: {
        composio: {
          command: process.execPath,
          args: ["/tmp/connector-proxy.js"],
          env: { OMB_CONNECTOR_UPSTREAM_URL: "http://127.0.0.1:8799/api/internal/connectors/mcp" },
        },
      },
    });
    await recorder.until((event) => event.type === "turn.completed");
    expect(JSON.parse(readFileSync(`${dump}.mcp.json`, "utf8"))).toContainEqual({
      name: "composio",
      command: process.execPath,
      args: ["/tmp/connector-proxy.js"],
      env: [{ name: "OMB_CONNECTOR_UPSTREAM_URL", value: "http://127.0.0.1:8799/api/internal/connectors/mcp" }],
    });
  });

  it("droid takes model and autonomy over the wire, never through argv", async () => {
    // `droid exec -m <id> -o acp` ignores the flag (verified against 0.196.0),
    // so a model that only reached argv would silently run the CLI's own pick.
    instance = await DroidAgentDriver.create({
      instanceId: "droid-test",
      displayName: "Droid Test",
      environment: {},
      enabled: true,
      config: { cli: FAKE_CLI, fullAuto: true },
    });
    recorder = recordEvents(instance.adapter);
    const dump = join(scratch, "droid-dump.json");
    process.env.FAKE_ACP_DUMP = dump;

    await instance.adapter.sendTurn({ threadId: "t-droid", text: "go", model: "claude-sonnet-5" });
    await recorder.until((e) => e.type === "turn.completed");

    const seen = JSON.parse(readFileSync(dump, "utf8"));
    expect(seen.argv).toEqual(["exec", "-o", "acp"]);
    expect(seen.argv).not.toContain("-m");

    const applied = JSON.parse(readFileSync(`${dump}.config.json`, "utf8"));
    expect(applied).toEqual([
      { method: "session/set_mode", params: { sessionId: "fake-acp-session", modeId: "auto-high" } },
      { method: "session/set_model", params: { sessionId: "fake-acp-session", modelId: "claude-sonnet-5" } },
    ]);
  });

  it("droid pins read-only mode when fullAuto is off", async () => {
    instance = await DroidAgentDriver.create({
      instanceId: "droid-safe",
      displayName: "Droid Safe",
      environment: {},
      enabled: true,
      config: { cli: FAKE_CLI, fullAuto: false },
    });
    recorder = recordEvents(instance.adapter);
    const dump = join(scratch, "droid-safe.json");
    process.env.FAKE_ACP_DUMP = dump;

    await instance.adapter.sendTurn({ threadId: "t-droid-safe", text: "go" });
    await recorder.until((e) => e.type === "turn.completed");

    // Both settings are explicit even with nothing on the turn: whatever
    // ~/.factory/settings.json pinned (including a `custom:` provider with its
    // own endpoint) must never be what the session silently runs on.
    expect(JSON.parse(readFileSync(`${dump}.config.json`, "utf8"))).toEqual([
      { method: "session/set_mode", params: { sessionId: "fake-acp-session", modeId: "normal" } },
      { method: "session/set_model", params: { sessionId: "fake-acp-session", modelId: "claude-opus-5" } },
    ]);
  });

  it("droid names the rejected setting when the agent predates session config", async () => {
    // The realistic failure is version skew: an older droid answers -32601 to
    // session/set_mode, and core surfaces the RPC message verbatim. A bare
    // "method not found" tells the user nothing, so the driver wraps it.
    process.env.FAKE_ACP_MODE = "no-session-config";
    instance = await DroidAgentDriver.create({
      instanceId: "droid-old-cli",
      displayName: "Droid Old CLI",
      environment: {},
      enabled: true,
      config: { cli: FAKE_CLI, fullAuto: false },
    });
    recorder = recordEvents(instance.adapter);

    await instance.adapter.sendTurn({ threadId: "t-droid-skew", text: "go" });
    const done = await recorder.until((e) => e.type === "turn.completed");

    expect(done).toMatchObject({ ok: false, stopReason: "rpc_error" });
    const err = recorder.events.find((e) => e.type === "runtime.error")!;
    expect(err.message).toContain("session/set_mode");
    expect(err.message).toContain('autonomy mode "normal"');
    expect(err.message).toMatch(/`droid` is current/);
    // The session id still reached the client, so the thread can resume rather
    // than orphaning the session droid just created.
    expect(recorder.events.some((e) => e.type === "session.started")).toBe(true);
  });

  it("mounts local CUA only on an approval-capable ACP instance", async () => {
    await create();
    const dump = join(scratch, "local-dump.json");
    process.env.FAKE_ACP_DUMP = dump;
    await instance.adapter.sendTurn({
      threadId: "t-local",
      text: "inspect",
      integrations: {
        localComputer: {
          command: "/opt/cua driver/cua-driver",
          args: ["mcp", "--embedded", "--socket", "/run/user/1000/driver.sock"],
          env: { CUA_DRIVER_EMBEDDED: "1" },
          platform: "linux",
          generation: "generation-1",
          scope: "local-computer",
        },
      },
    });
    await recorder.until((event) => event.type === "turn.completed");
    const seen = JSON.parse(readFileSync(dump, "utf8"));
    expect(seen.mcpServers).toContainEqual({
      name: "computer",
      command: "/opt/cua driver/cua-driver",
      args: ["mcp", "--embedded", "--socket", "/run/user/1000/driver.sock"],
      env: [{ name: "CUA_DRIVER_EMBEDDED", value: "1" }],
    });
    expect(instance.adapter.capabilities.localComputerMcp).toBe(true);
  });

  it("surfaces a permission ask as request.opened and completes once allowed", async () => {
    await create(GrokAgentDriver, "permission");
    await instance.adapter.sendTurn({
      threadId: "t-perm",
      text: "go",
      integrations: {
        localComputer: {
          command: "/cua-driver",
          args: ["mcp"],
          env: {},
          platform: "linux",
          scope: "local-computer",
        },
      },
    });
    const opened = await recorder.until((e) => e.type === "request.opened");
    expect(opened).toMatchObject({
      requestType: "permission",
      tool: "shell",
      approvalScope: "local-computer",
    });

    await instance.adapter.respondToRequest("t-perm", (opened as any).requestId, { behavior: "allow" });
    const resolved = await recorder.until((e) => e.type === "request.resolved");
    expect(resolved).toMatchObject({
      behavior: "allow",
      source: "user",
      approvalScope: "local-computer",
    });
    const done = await recorder.until((e) => e.type === "turn.completed");
    expect(done).toMatchObject({ ok: true });
  });

  /** ACP lets an agent advertise `allow_always` alongside `allow_once`, in any
   *  order. A one-time answer must select the one-time option: a persistent
   *  grant lives inside the provider CLI, where this app cannot revoke it. */
  const permissionPick = async (behavior: "allow" | "deny") => {
    const dump = join(scratch, `perm-${behavior}.json`);
    process.env.FAKE_ACP_DUMP = dump;
    process.env.FAKE_ACP_PERMISSION_KINDS = "allow_always,allow_once,reject_always,reject_once";
    await create(GrokAgentDriver, "permission");
    await instance.adapter.sendTurn({ threadId: `t-${behavior}`, text: "go" });
    const opened = await recorder.until((e) => e.type === "request.opened");
    // SAFETY: until() matched type "request.opened", the variant carrying requestId.
    const outcome = await instance.adapter.respondToRequest(`t-${behavior}`, (opened as any).requestId, { behavior });
    expect(outcome).toBe(behavior === "allow" ? "allowed-once" : "rejected");
    await recorder.until((e) => e.type === "turn.completed");
    return JSON.parse(readFileSync(`${dump}.permission.json`, "utf8"));
  };

  it("answers a one-time allow with allow_once, not a persistent allow_always", async () => {
    expect(await permissionPick("allow")).toEqual(["allow_once"]);
  });

  it("answers a one-time deny with reject_once, not a persistent reject_always", async () => {
    expect(await permissionPick("deny")).toEqual(["reject_once"]);
  });

  /** fullAuto answers with nobody watching, so a persistent grant taken here
   *  is the one that would never be noticed. */
  it("auto-approves with allow_once when the agent lists allow_always first", async () => {
    const dump = join(scratch, "perm-auto.json");
    process.env.FAKE_ACP_DUMP = dump;
    process.env.FAKE_ACP_PERMISSION_KINDS = "allow_always,allow_once,reject_always,reject_once";
    await create(GrokAgentDriver, "permission", true);
    await instance.adapter.sendTurn({ threadId: "t-auto", text: "go" });
    await recorder.until((e) => e.type === "turn.completed");
    expect(JSON.parse(readFileSync(`${dump}.permission.json`, "utf8"))).toEqual(["allow_once"]);
  });

  /** An agent offering only a persistent grant gets no answer at all: selecting
   *  allow_always would hand it a grant this app never recorded and cannot
   *  revoke, so the ask cancels loudly instead. */
  it("cancels the ask when the agent advertises no one-time allow", async () => {
    const dump = join(scratch, "perm-persistent.json");
    process.env.FAKE_ACP_DUMP = dump;
    process.env.FAKE_ACP_PERMISSION_KINDS = "allow_always,reject_always";
    await create(GrokAgentDriver, "permission");
    await instance.adapter.sendTurn({ threadId: "t-persistent", text: "go" });
    const opened = await recorder.until((e) => e.type === "request.opened");
    // SAFETY: until() matched type "request.opened", the variant carrying requestId.
    // "allowed-once" here would put a user-approved row in the decision log
    // for a call that never ran: nothing was granted, so nothing is reportable
    expect(await instance.adapter.respondToRequest("t-persistent", (opened as any).requestId, { behavior: "allow" })).toBe(
      "unavailable",
    );
    expect(await recorder.until((e) => e.type === "request.resolved")).toMatchObject({
      behavior: "deny",
      source: "system",
    });
    await recorder.until((e) => e.type === "turn.completed");
    expect(JSON.parse(readFileSync(`${dump}.permission.json`, "utf8"))).toEqual([null]);
    const err = recorder.events.find((e) => e.type === "runtime.error")!;
    expect(err.message).toContain('offered no "allow_once" permission option');
  });

  /** The deny side of the same guarantee, and the quiet one: a persistent
   *  reject still denies, so the resolution reads "deny" either way and
   *  `source` is the only field separating this from an honest deny. */
  it("cancels the ask when the agent advertises no one-time reject", async () => {
    const dump = join(scratch, "perm-persistent-deny.json");
    process.env.FAKE_ACP_DUMP = dump;
    process.env.FAKE_ACP_PERMISSION_KINDS = "allow_always,reject_always";
    await create(GrokAgentDriver, "permission");
    await instance.adapter.sendTurn({ threadId: "t-persistent-deny", text: "go" });
    const opened = await recorder.until((e) => e.type === "request.opened");
    // SAFETY: until() matched type "request.opened", the variant carrying requestId.
    // the call did not run and the human asked for that, so this stays a denial
    expect(await instance.adapter.respondToRequest("t-persistent-deny", (opened as any).requestId, { behavior: "deny" })).toBe(
      "rejected",
    );
    expect(await recorder.until((e) => e.type === "request.resolved")).toMatchObject({
      behavior: "deny",
      source: "system",
    });
    await recorder.until((e) => e.type === "turn.completed");
    expect(JSON.parse(readFileSync(`${dump}.permission.json`, "utf8"))).toEqual([null]);
    const err = recorder.events.find((e) => e.type === "runtime.error")!;
    expect(err.message).toContain('offered no "reject_once" permission option');
  });

  /** fullAuto answers on its own arm, which returns before the human ever
   *  hears about the ask, so the same guarantee needs pinning twice: this is
   *  the one path where nothing else would notice it lapse. */
  it("cancels in fullAuto when the agent advertises no one-time allow", async () => {
    const dump = join(scratch, "perm-auto-persistent.json");
    process.env.FAKE_ACP_DUMP = dump;
    process.env.FAKE_ACP_PERMISSION_KINDS = "allow_always,reject_always";
    await create(GrokAgentDriver, "permission", true);
    await instance.adapter.sendTurn({ threadId: "t-auto-persistent", text: "go" });
    await recorder.until((e) => e.type === "turn.completed");
    // no request.opened: this answered on the fullAuto arm, not the human one
    expect(recorder.events.some((e) => e.type === "request.opened")).toBe(false);
    expect(JSON.parse(readFileSync(`${dump}.permission.json`, "utf8"))).toEqual([null]);
    const err = recorder.events.find((e) => e.type === "runtime.error")!;
    expect(err.message).toContain('offered no "allow_once" permission option');
  });

  /** The owner's report: an exhausted Grok week renders a red "Internal
   *  error" chip. The provider names the cause in `data`, so the chip must
   *  read as a usage limit — and stay retryable, because the window rolls. */
  it("grok reports an exhausted subscription as a usage limit, not a crash", async () => {
    await create(GrokAgentDriver, "usage-limit");
    await instance.adapter.sendTurn({ threadId: "t-usage", text: "go" });
    await recorder.until((e) => e.type === "turn.completed");
    const err = recorder.events.find((e) => e.type === "runtime.error")!;
    expect(err).toMatchObject({ usageLimit: { resetsAt: null } });
    expect(err.setup).toBeUndefined();
  });

  /** The harder half: the rejection says only "Internal error". The account's
   *  own billing call is the evidence, and it is on a path the error side
   *  never took — a failed turn used to skip the billing read entirely. */
  it("grok reads billing on a bare failure and classifies a full week as a usage limit", async () => {
    const end = new Date(Date.now() + 3 * 24 * 60 * 60 * 1000).toISOString();
    process.env.FAKE_ACP_BILLING_PERCENT = "100";
    process.env.FAKE_ACP_BILLING_END = end;
    await create(GrokAgentDriver, "usage-limit-silent");
    await instance.adapter.sendTurn({ threadId: "t-usage-silent", text: "go" });
    await recorder.until((e) => e.type === "turn.completed");
    const err = recorder.events.find((e) => e.type === "runtime.error")!;
    expect(err).toMatchObject({ usageLimit: { resetsAt: Date.parse(end) } });
  });

  /** The billing probe is awaited, so the child can die inside it. Whoever
   *  settles first owns the failure; the loser must stay quiet rather than
   *  post a second chip after the turn already completed. */
  it("does not report twice when the child dies inside the billing probe", async () => {
    await create(GrokAgentDriver, "usage-limit-close");
    await instance.adapter.sendTurn({ threadId: "t-usage-close", text: "go" });
    await recorder.until((e) => e.type === "turn.completed");
    await new Promise((resolve) => setTimeout(resolve, 500));
    expect(recorder.events.filter((e) => e.type === "runtime.error")).toHaveLength(1);
    expect(recorder.events.filter((e) => e.type === "turn.completed")).toHaveLength(1);
    expect(recorder.events.at(-1)).toMatchObject({ type: "turn.completed" });
  });

  /** A provider that already explained the failure keeps its explanation:
   *  billing sitting at 100% is corroboration for an opaque error, never a
   *  reason to overwrite one the provider named. */
  it.each([
    ["a named non-limit type", "usage-limit-typed"],
    ["a JSON-RPC protocol error", "usage-limit-protocol"],
  ])("does not relabel %s as a spent plan", async (_label, mode) => {
    process.env.FAKE_ACP_BILLING_PERCENT = "100";
    await create(GrokAgentDriver, mode);
    await instance.adapter.sendTurn({ threadId: `t-ruled-out-${mode}`, text: "go" });
    await recorder.until((e) => e.type === "turn.completed");
    const err = recorder.events.find((e) => e.type === "runtime.error")!;
    expect(err.usageLimit).toBeUndefined();
  });

  /** The named-rate-limit path needs the same guard the probe got: a local
   *  endpoint's throttle is not the grok.com account's spent week. */
  it("does not read a local inject's throttle as a spent subscription", async () => {
    process.env.FAKE_ACP_MODE = "usage-limit";
    mkdirSync(join(scratch, ".grok"), { recursive: true });
    instance = await GrokAgentDriver.create({
      instanceId: "acp-test",
      displayName: "ACP Test",
      environment: { HOME: scratch, GROK_HOME: join(scratch, ".grok") },
      enabled: true,
      config: { cli: FAKE_CLI, fullAuto: false },
    });
    recorder = recordEvents(instance.adapter);
    await instance.adapter.sendTurn({ threadId: "t-usage-local-429", text: "go", model: "omlx::MiniMax-M3-4bit" });
    await recorder.until((e) => e.type === "turn.completed");
    const err = recorder.events.find((e) => e.type === "runtime.error")!;
    expect(err.usageLimit).toBeUndefined();
  });

  /** configureSession is awaited inside the same try as the prompt, so its
   *  rejections land in the same catch. They carry an actionable message and
   *  must not be relabelled "your plan is used up" by a full billing window. */
  it("does not blame a spent plan for a failure that happened before the prompt", async () => {
    process.env.FAKE_ACP_BILLING_PERCENT = "100";
    await create(GrokAgentDriver, "set-model-invalid-params");
    await instance.adapter.sendTurn({ threadId: "t-usage-config", text: "go", model: "grok-4.6" });
    await recorder.until((e) => e.type === "turn.completed");
    const err = recorder.events.find((e) => e.type === "runtime.error")!;
    expect(err.usageLimit).toBeUndefined();
    expect(err.message).toContain("session/set_model");
  });

  /** A local `host::model` turn never spent the grok.com subscription, so
   *  its failure must not be explained with that account's billing. */
  it("skips the billing probe for a local inject turn", async () => {
    process.env.FAKE_ACP_BILLING_PERCENT = "100";
    mkdirSync(join(scratch, ".grok"), { recursive: true });
    process.env.FAKE_ACP_MODE = "usage-limit-silent";
    instance = await GrokAgentDriver.create({
      instanceId: "acp-test",
      displayName: "ACP Test",
      environment: { HOME: scratch, GROK_HOME: join(scratch, ".grok") },
      enabled: true,
      config: { cli: FAKE_CLI, fullAuto: false },
    });
    recorder = recordEvents(instance.adapter);
    await instance.adapter.sendTurn({ threadId: "t-usage-local", text: "go", model: "omlx::MiniMax-M3-4bit" });
    await recorder.until((e) => e.type === "turn.completed");
    const err = recorder.events.find((e) => e.type === "runtime.error")!;
    expect(err.usageLimit).toBeUndefined();
  });

  it("leaves a bare failure alone while the week still has room", async () => {
    await create(GrokAgentDriver, "usage-limit-silent");
    await instance.adapter.sendTurn({ threadId: "t-usage-room", text: "go" });
    await recorder.until((e) => e.type === "turn.completed");
    const err = recorder.events.find((e) => e.type === "runtime.error")!;
    expect(err.message).toBe("Internal error");
    expect(err.usageLimit).toBeUndefined();
  });

  it("grok fails closed when the CLI advertises no cached_token (needs login)", async () => {
    await create(GrokAgentDriver, "no-auth");
    await instance.adapter.sendTurn({ threadId: "t-auth", text: "go" });
    const done = await recorder.until((e) => e.type === "turn.completed");
    expect(done).toMatchObject({ ok: false, stopReason: "auth_required" });
    const err = recorder.events.find((e) => e.type === "runtime.error")!;
    expect(err.message).toMatch(/not signed in/);
  });

  it("grok local inject does not require grok.com login", async () => {
    process.env.FAKE_ACP_MODE = "no-auth";
    mkdirSync(join(scratch, ".grok"), { recursive: true });
    instance = await GrokAgentDriver.create({
      instanceId: "acp-test",
      displayName: "ACP Test",
      environment: { HOME: scratch, GROK_HOME: join(scratch, ".grok") },
      enabled: true,
      config: { cli: FAKE_CLI, fullAuto: false },
    });
    recorder = recordEvents(instance.adapter);
    await instance.adapter.sendTurn({
      threadId: "t-local-auth",
      text: "go",
      model: "omlx::MiniMax-M3-4bit",
    });
    const done = await recorder.until((e) => e.type === "turn.completed");
    expect(done).toMatchObject({ ok: true });
    expect(recorder.events.some((e) => e.type === "runtime.error")).toBe(false);
  });

  it("gemini proceeds through a missing auth method (lenient login)", async () => {
    await create(GeminiAgentDriver, "no-auth");
    await instance.adapter.sendTurn({ threadId: "t-lenient", text: "go" });
    const done = await recorder.until((e) => e.type === "turn.completed");
    expect(done).toMatchObject({ ok: true });
    expect(recorder.events.some((e) => e.provider === "geminiAgent")).toBe(true);
  });

  it("rejects a second turn while one is in flight", async () => {
    await create(GrokAgentDriver, "hang");
    await instance.adapter.sendTurn({ threadId: "t-busy", text: "one" });
    await recorder.until((e) => e.type === "session.started");
    await expect(instance.adapter.sendTurn({ threadId: "t-busy", text: "two" })).rejects.toThrow(/already running/);
    await instance.adapter.interruptTurn("t-busy");
    await recorder.until((e) => e.type === "turn.completed");
  });

  it("rejects a second turn that arrives before the first spawns", async () => {
    await create(GeminiAgentDriver);
    const first = instance.adapter.sendTurn({ threadId: "t-race", text: "one" });
    await expect(instance.adapter.sendTurn({ threadId: "t-race", text: "two" })).rejects.toThrow(/already running/);
    await first;
    const done = await recorder.until((e) => e.type === "turn.completed");
    expect(done).toMatchObject({ ok: true });
  });

  it("interrupt settles a hung turn as cancelled", async () => {
    await create(GrokAgentDriver, "hang");
    await instance.adapter.sendTurn({ threadId: "t-int", text: "go" });
    await recorder.until((e) => e.type === "session.started");
    await instance.adapter.interruptTurn("t-int");
    const done = await recorder.until((e) => e.type === "turn.completed");
    expect(done).toMatchObject({ type: "turn.completed" });
  });

  it("an exit before result becomes runtime.error + failed turn", async () => {
    await create(GrokAgentDriver, "exit-early");
    await instance.adapter.sendTurn({ threadId: "t-crash", text: "go" });
    const done = await recorder.until((e) => e.type === "turn.completed");
    expect(done).toMatchObject({ ok: false });
    expect(recorder.events.some((e) => e.type === "runtime.error")).toBe(true);
  });

  it("preserves ACP error codes for provider setup classification", async () => {
    await create(ClassifiedErrorDriver, "auth-required");
    await instance.adapter.sendTurn({ threadId: "t-auth-required", text: "go" });
    const done = await recorder.until((e) => e.type === "turn.completed");

    expect(done).toMatchObject({ ok: false, stopReason: "auth_required" });
    expect(recorder.events.find((e) => e.type === "runtime.error")).toMatchObject({ setup: true });
  });

  it("selectModel confirms the requested model before prompting", async () => {
    process.env.FAKE_ACP_MODELS = "m-one,m-two";
    await create(SelectModelDriver);
    await instance.adapter.sendTurn({ threadId: "t-model", text: "go", model: "m-two" });

    const started = await recorder.until((e) => e.type === "session.started");
    expect(started).toMatchObject({ model: "m-two" });
    const done = await recorder.until((e) => e.type === "turn.completed");
    expect(done).toMatchObject({ ok: true });
  });

  it("a model the session does not advertise fails the turn instead of running another", async () => {
    process.env.FAKE_ACP_MODELS = "m-one,m-two";
    await create(SelectModelDriver);
    await instance.adapter.sendTurn({ threadId: "t-bad-model", text: "go", model: "m-nope" });

    const done = await recorder.until((e) => e.type === "turn.completed");
    expect(done).toMatchObject({ ok: false });
    const err = recorder.events.find((e) => e.type === "runtime.error")!;
    expect(err.message).toMatch(/model not found/);
    // nothing was generated: the prompt is never sent
    expect(recorder.events.some((e) => e.type === "content.delta")).toBe(false);
  });

  // The unadvertised-model test above rides the fake's -32602, so it settles in
  // `request()` and never reaches the guard. This one is the silent case the
  // guard was written for: the agent acknowledges the switch and keeps its old
  // model, which no error surfaces.
  it("a model switch acknowledged but not applied fails the turn", async () => {
    process.env.FAKE_ACP_MODELS = "m-one,m-two";
    process.env.FAKE_ACP_MODEL_STICKS = "1";
    await create(SelectModelDriver);
    await instance.adapter.sendTurn({ threadId: "t-stuck-model", text: "go", model: "m-two" });

    const done = await recorder.until((e) => e.type === "turn.completed");
    expect(done).toMatchObject({ ok: false });
    const err = recorder.events.find((e) => e.type === "runtime.error")!;
    expect(err.message).toMatch(/did not switch to m-two \(still m-one\)/);
    // the whole point: no paid turn is spent on the wrong model
    expect(recorder.events.some((e) => e.type === "content.delta")).toBe(false);
  });

  it("selects the model on a resumed session too, not just a new one", async () => {
    process.env.FAKE_ACP_MODELS = "m-one,m-two";
    await create(SelectModelDriver);
    await instance.adapter.sendTurn({
      threadId: "t-resume-model",
      text: "go",
      model: "m-two",
      // deliberately NOT "fake-acp-session", the id session/new returns: with
      // that cursor a session/load that threw and fell back to session/new
      // would emit the same sessionId and this test could not fail
      resumeCursor: "resumed-thread-1",
    });

    // session/load feeds the same sessionResult as session/new, so the model
    // hook must fire on a resumed thread as well
    const started = await recorder.until((e) => e.type === "session.started");
    expect(started).toMatchObject({ sessionId: "resumed-thread-1", model: "m-two" });
    const done = await recorder.until((e) => e.type === "turn.completed");
    expect(done).toMatchObject({ ok: true });
  });

  it("uses portable context when a remembered session cannot load", async () => {
    const dump = join(scratch, "resume-fallback.json");
    process.env.FAKE_ACP_DUMP = dump;
    await create(GrokAgentDriver, "load-fails");
    await instance.adapter.sendTurn({
      threadId: "t-resume-fallback",
      text: "continue",
      resumeCursor: "missing-session",
      resumeFallback: { text: "durable task record and recent work\n\ncontinue" },
    });

    const started = await recorder.until((event) => event.type === "session.started");
    expect(started).toMatchObject({ sessionId: "fake-acp-session" });
    await recorder.until((event) => event.type === "turn.completed");
    const prompt = JSON.parse(readFileSync(dump, "utf8")).prompt;
    expect(prompt).toEqual([{ type: "text", text: "durable task record and recent work\n\ncontinue" }]);
  });

  it("applyTurnEnv sees the picker model after resolveTurnModel", async () => {
    const dump = join(scratch, "turn-env.json");
    process.env.FAKE_ACP_DUMP = dump;
    const TurnEnvDriver = createAcpDriver({
      ...SELECT_MODEL_SUPPORT,
      driverKind: "turnEnvTest",
      selectModel: undefined,
      resolveTurnModel: (model) => (model ? `resolved/${model}` : model),
      applyTurnEnv: (env, { model, requestedModel }) => {
        env.TEST_TURN_MODEL = `${model ?? ""}|${requestedModel ?? ""}`;
      },
    });
    instance = await TurnEnvDriver.create({
      instanceId: "turn-env-test",
      displayName: undefined,
      environment: {},
      enabled: true,
      config: { cli: FAKE_CLI, fullAuto: false },
    });
    recorder = recordEvents(instance.adapter);

    await instance.adapter.sendTurn({
      threadId: "t-turn-env",
      text: "go",
      model: "ollama::ornith:35b-bf16",
    });
    await recorder.until((e) => e.type === "turn.completed");

    expect(JSON.parse(readFileSync(dump, "utf8")).env.TEST_TURN_MODEL).toBe(
      "resolved/ollama::ornith:35b-bf16|ollama::ornith:35b-bf16",
    );
  });

  it("transformEnv sees the instance config", async () => {
    const dump = join(scratch, "policy.json");
    process.env.FAKE_ACP_DUMP = dump;
    instance = await EnvPolicyDriver.create({
      instanceId: "policy-test",
      displayName: undefined,
      environment: {},
      enabled: true,
      config: { cli: FAKE_CLI, fullAuto: true },
    });
    recorder = recordEvents(instance.adapter);

    await instance.adapter.sendTurn({ threadId: "t-policy", text: "go" });
    await recorder.until((e) => e.type === "turn.completed");

    expect(JSON.parse(readFileSync(dump, "utf8")).env.TEST_POLICY).toBe("auto");
  });

  it("forwards Grok's weekly billing as account.rate-limits.updated", async () => {
    const end = new Date(Date.now() + 3 * 24 * 60 * 60 * 1000).toISOString();
    process.env.FAKE_ACP_BILLING_END = end;
    await create(GrokAgentDriver);
    expect(instance.adapter.capabilities.rateLimits).toBe(true);
    await instance.adapter.sendTurn({ threadId: "t-billing", text: "hi" });
    await recorder.until((e) => e.type === "turn.completed");
    await recorder.until((e) => e.type === "account.rate-limits.updated");
    expect(recorder.events.filter((e) => e.type === "account.rate-limits.updated")).toMatchObject([
      { windows: [{ id: "seven_day", usedPercent: 42, resetsAt: Date.parse(end), windowMinutes: 10_080 }] },
    ]);
  });

  it("filters foreign credentials from the billing child", async () => {
    const dump = join(scratch, "billing-env.json");
    await readGrokBillingRpc(FAKE_CLI, {
      ...process.env,
      FAKE_ACP_DUMP: dump,
      OPENAI_API_KEY: "foreign-secret",
      XAI_API_KEY: "api-secret",
      AWS_SECRET_ACCESS_KEY: "workspace-secret",
    });
    const { env } = JSON.parse(readFileSync(dump, "utf8"));
    expect(env.OPENAI_API_KEY).toBeUndefined();
    expect(env.XAI_API_KEY).toBeUndefined();
    expect(env.AWS_SECRET_ACCESS_KEY).toBeUndefined();
  });

  it("requires cached-token auth before billing", async () => {
    const dump = join(scratch, "signed-out.json");
    await expect(readGrokBillingRpc(FAKE_CLI, {
      ...process.env,
      FAKE_ACP_MODE: "no-auth",
      FAKE_ACP_RPC_DUMP: dump,
    })).rejects.toThrow("signin");
    expect(JSON.parse(readFileSync(dump, "utf8"))).toEqual(["initialize"]);
  });

  it("keeps early billing CLI exits as refresh failures", async () => {
    await expect(readGrokBillingRpc(FAKE_CLI, {
      ...process.env,
      FAKE_ACP_MODE: "exit-early",
    })).rejects.toThrow("refresh");
  });

  it.each(["happy", "billing-fail", "billing-hang"])("reads %s billing after completing the turn", async (mode) => {
    const dump = join(scratch, "billing-order.json");
    instance = await GrokAgentDriver.create({
      instanceId: "billing-order",
      displayName: "Billing",
      environment: { FAKE_ACP_MODE: mode, FAKE_ACP_RPC_DUMP: dump },
      enabled: true,
      config: { cli: FAKE_CLI, fullAuto: false },
    });
    recorder = recordEvents(instance.adapter);
    await instance.adapter.sendTurn({ threadId: "t-billing-order", text: "hi" });
    expect(await recorder.until((e) => e.type === "turn.completed", 2_000)).toMatchObject({ ok: true });
    await expect.poll(() => JSON.parse(readFileSync(dump, "utf8"))).toContain("_x.ai/billing");
    const methods: string[] = JSON.parse(readFileSync(dump, "utf8"));
    expect(methods.indexOf("_x.ai/billing")).toBeGreaterThan(methods.indexOf("session/prompt.result"));
    expect(recorder.events.some((e) => e.type === "runtime.error")).toBe(false);
    if (mode === "happy") {
      await recorder.until((e) => e.type === "account.rate-limits.updated");
      const types = recorder.events.map((e) => e.type);
      expect(types.indexOf("account.rate-limits.updated")).toBeGreaterThan(types.indexOf("turn.completed"));
    }
  });

  it("rejects the unsupported billing method spelling", async () => {
    const dump = join(scratch, "unsupported-billing.json");
    process.env.FAKE_ACP_RPC_DUMP = dump;
    await create(createAcpDriver({ ...SELECT_MODEL_SUPPORT, billingMethod: "x.ai/billing" }));
    await instance.adapter.sendTurn({ threadId: "t-unsupported-billing", text: "hi" });
    await recorder.until((e) => e.type === "turn.completed");
    await expect.poll(() => JSON.parse(readFileSync(dump, "utf8"))).toContain("x.ai/billing.error");
    expect(recorder.events.some((e) => e.type === "account.rate-limits.updated")).toBe(false);
  });

  it("does not advertise rate limits on other ACP engines", async () => {
    await create(GeminiAgentDriver);
    expect(instance.adapter.capabilities.rateLimits).not.toBe(true);
  });

  it("declares effort levels for Grok only", async () => {
    await create(GrokAgentDriver);
    // Declared list is the union incl. xhigh (grok.ts); per-model gating in shared/model-effort.ts.
    expect(instance.adapter.capabilities.effortLevels).toEqual(["low", "medium", "high", "xhigh"]);

    await create(GeminiAgentDriver);
    expect(instance.adapter.capabilities.effortLevels).toBeUndefined();

    await create(KimiAgentDriver);
    expect(instance.adapter.capabilities.effortLevels).toBeUndefined();
  });

  it("passes effort to Grok, and omits the flag when unset", async () => {
    const withEffort = join(scratch, "grok-effort.json");
    await create(GrokAgentDriver);
    process.env.FAKE_ACP_DUMP = withEffort;
    await instance.adapter.sendTurn({ threadId: "t-effort", text: "hi", effort: "high" });
    await recorder.until((e) => e.type === "turn.completed");

    const seen = JSON.parse(readFileSync(withEffort, "utf8"));
    expect(seen.argv).toContain("--reasoning-effort");
    expect(seen.argv[seen.argv.indexOf("--reasoning-effort") + 1]).toBe("high");

    const without = join(scratch, "grok-no-effort.json");
    await create(GrokAgentDriver);
    process.env.FAKE_ACP_DUMP = without;
    await instance.adapter.sendTurn({ threadId: "t-no-effort", text: "hi" });
    await recorder.until((e) => e.type === "turn.completed");

    expect(JSON.parse(readFileSync(without, "utf8")).argv).not.toContain("--reasoning-effort");
  });

  it("declares Max for Muse and keeps serve argv flag-free", async () => {
    process.env.META_API_KEY = "meta-key";
    await create(MuseAgentDriver);
    expect(instance.adapter.capabilities.effortLevels).toEqual(["low", "medium", "high", "xhigh", "max"]);

    for (const [index, model] of ["muse-spark-1.3", "muse-spark-1.3-contributor"].entries()) {
      const dump = join(scratch, `muse-max-${index}.json`);
      await create(MuseAgentDriver);
      process.env.FAKE_ACP_DUMP = dump;
      await instance.adapter.sendTurn({ threadId: "t-muse-max", text: "hi", model, effort: "max" });
      await recorder.until((e) => e.type === "turn.completed");
      expect(JSON.parse(readFileSync(dump, "utf8")).argv).toEqual(["serve"]);
    }
    const keptDump = join(scratch, "muse-xhigh.json");
    await create(MuseAgentDriver);
    process.env.FAKE_ACP_DUMP = keptDump;
    await instance.adapter.sendTurn({ threadId: "t-muse-xhigh", text: "hi", model: "muse-spark-1.3", effort: "xhigh" });
    await recorder.until((e) => e.type === "turn.completed");
    expect(JSON.parse(readFileSync(keptDump, "utf8")).argv).toEqual(["serve"]);
  });

  it("puts Grok -m after agent so ACP stdio binds the local slug", async () => {
    const dump = join(scratch, "grok-argv-order.json");
    await create(GrokAgentDriver);
    process.env.FAKE_ACP_DUMP = dump;
    await instance.adapter.sendTurn({ threadId: "t-argv", text: "hi", model: "grok-4.5", effort: "high" });
    await recorder.until((e) => e.type === "turn.completed");

    const argv = JSON.parse(readFileSync(dump, "utf8")).argv as string[];
    const agent = argv.indexOf("agent");
    const modelFlag = argv.indexOf("-m");
    const stdio = argv.indexOf("stdio");
    expect(agent).toBeGreaterThan(-1);
    expect(modelFlag).toBeGreaterThan(agent);
    expect(stdio).toBeGreaterThan(modelFlag);
    expect(argv[modelFlag + 1]).toBe("grok-4.5");
    expect(argv.indexOf("--reasoning-effort")).toBeGreaterThan(agent);
    expect(argv.indexOf("--permission-mode")).toBeLessThan(agent);
  });

  it("offers the approval chip unless fullAuto means nothing ever asks", async () => {
    await create(GrokAgentDriver);
    expect(instance.adapter.capabilities.askApproval).toBe(true);
    const fullAuto = await GrokAgentDriver.create({
      instanceId: "grok-full-auto-chip",
      displayName: "Grok",
      environment: {},
      enabled: true,
      config: { cli: FAKE_CLI, fullAuto: true },
    });
    expect(fullAuto.adapter.capabilities.askApproval).toBe(false);
    await fullAuto.dispose();
  });

  it("offers the approval chip for Gemini unless fullAuto means nothing ever asks", async () => {
    await create(GeminiAgentDriver);
    expect(instance.adapter.capabilities.askApproval).toBe(true);
    const fullAuto = await GeminiAgentDriver.create({
      instanceId: "gemini-full-auto-chip",
      displayName: "Gemini",
      environment: {},
      enabled: true,
      config: { cli: FAKE_CLI, fullAuto: true },
    });
    expect(fullAuto.adapter.capabilities.askApproval).toBe(false);
    await fullAuto.dispose();
  });
});

describe("ACP create-time CLI probe prefetch", () => {
  let instance: ProviderInstance;
  let scratch: string;

  beforeEach(() => {
    ensureDirs();
    chmodSync(FAKE_CLI, 0o755);
    scratch = mkdtempSync(join(tmpdir(), "omb-acp-prefetch-"));
  });

  afterEach(async () => {
    delete process.env.FAKE_ACP_MODE;
    delete process.env.FAKE_ACP_VERSION_COUNT_FILE;
    await instance?.dispose();
    await removeTempDir(scratch);
  });

  it("opted-in prewarm caches --version for the first sendTurn", async () => {
    const countFile = join(scratch, "version-count.txt");
    writeFileSync(countFile, "0");
    process.env.FAKE_ACP_VERSION_COUNT_FILE = countFile;
    process.env.FAKE_ACP_MODE = "happy";

    instance = await GrokAgentDriver.create({
      instanceId: "acp-prefetch",
      displayName: "ACP Prefetch",
      environment: {},
      enabled: true,
      config: { cli: FAKE_CLI, fullAuto: true, prewarm: true },
    });

    await expect.poll(() => Number(readFileSync(countFile, "utf8"))).toBeGreaterThanOrEqual(1);
    const afterCreate = Number(readFileSync(countFile, "utf8"));
    expect(afterCreate).toBeGreaterThanOrEqual(1);

    const recorder = recordEvents(instance.adapter);
    await instance.adapter.sendTurn({ threadId: "t-prefetch", text: "hi" });
    await recorder.until((e) => e.type === "turn.completed");
    recorder.stop();

    const afterTurn = Number(readFileSync(countFile, "utf8"));
    expect(afterTurn).toBe(afterCreate);
  });
});

describe("ACP create-time handshake prewarm", () => {
  let instance: ProviderInstance;
  let scratch: string;

  beforeEach(() => {
    ensureDirs();
    chmodSync(FAKE_CLI, 0o755);
    scratch = mkdtempSync(join(tmpdir(), "omb-acp-hs-prewarm-"));
  });

  afterEach(async () => {
    delete process.env.FAKE_ACP_MODE;
    delete process.env.FAKE_ACP_RPC_DUMP;
    await instance?.dispose();
    vi.restoreAllMocks();
    await removeTempDir(scratch);
  });

  it("does not spawn CLIs when the registry loads instances without prewarm opt-in", async () => {
    const spawn = vi.spyOn(procs, "spawnCli");
    const exec = vi.spyOn(procs, "execCli");
    const registry = new ProviderRegistry([GrokAgentDriver, GeminiAgentDriver]);
    try {
      await registry.load({
        grok: { driver: GrokAgentDriver.driverKind, config: { cli: FAKE_CLI } },
        gemini: { driver: GeminiAgentDriver.driverKind, config: { cli: FAKE_CLI } },
        disabled: { driver: GrokAgentDriver.driverKind, enabled: false, config: { cli: FAKE_CLI, prewarm: true } },
      });
      expect(registry.instances()).toHaveLength(3);
      expect([exec.mock.calls.length, spawn.mock.calls.length]).toEqual([0, 0]);
    } finally {
      await registry.disposeAll();
    }
  });

  it("reuses an opted-in background handshake on the first turn", async () => {
    const rpcDump = join(scratch, "rpc.json");
    writeFileSync(rpcDump, "[]");
    process.env.FAKE_ACP_RPC_DUMP = rpcDump;
    process.env.FAKE_ACP_MODE = "happy";

    instance = await GrokAgentDriver.create({
      instanceId: "acp-hs-prewarm",
      displayName: "ACP Handshake Prewarm",
      environment: {},
      enabled: true,
      config: { cli: FAKE_CLI, fullAuto: true, workspace: scratch, prewarm: true },
    });

    await expect.poll(() => JSON.parse(readFileSync(rpcDump, "utf8"))).toContain("authenticate");
    const afterCreate = JSON.parse(readFileSync(rpcDump, "utf8")) as string[];
    expect(afterCreate).toContain("initialize");
    expect(afterCreate.filter((m) => m === "initialize")).toHaveLength(1);
    expect(afterCreate).not.toContain("session/new");

    const recorder = recordEvents(instance.adapter);
    await instance.adapter.sendTurn({ threadId: "t-hs-prewarm", text: "hi" });
    await recorder.until((e) => e.type === "turn.completed");
    recorder.stop();

    let afterTurn: string[] = [];
    await expect.poll(() => (afterTurn = JSON.parse(readFileSync(rpcDump, "utf8")))).toContain("session/prompt");
    expect(afterTurn.filter((m) => m === "initialize")).toHaveLength(1);
    expect(afterTurn).toContain("session/new");
    expect(afterTurn).toContain("session/prompt");
  });

  it("returns from create while the opted-in handshake is blocked", async () => {
    const rpcDump = join(scratch, "rpc.json");
    writeFileSync(rpcDump, "[]");
    process.env.FAKE_ACP_RPC_DUMP = rpcDump;
    process.env.FAKE_ACP_MODE = "initialize-hang";
    instance = await GrokAgentDriver.create({
      instanceId: "acp-hs-blocked",
      displayName: "ACP Handshake Blocked",
      environment: {},
      enabled: true,
      config: { cli: FAKE_CLI, fullAuto: true, workspace: scratch, prewarm: true },
    });
    await expect.poll(() => JSON.parse(readFileSync(rpcDump, "utf8"))).toEqual(["initialize"]);
  });

  it("does not discard a handshake already borrowed by a concurrent turn", async () => {
    const spawn = vi.spyOn(procs, "spawnCli");
    const rpcDump = join(scratch, "rpc.json");
    writeFileSync(rpcDump, "[]");
    process.env.FAKE_ACP_RPC_DUMP = rpcDump;
    const otherCwd = join(scratch, "other");
    mkdirSync(otherCwd);
    instance = await GrokAgentDriver.create({
      instanceId: "acp-hs-concurrent",
      displayName: "ACP Handshake Concurrent",
      environment: {},
      enabled: true,
      config: { cli: FAKE_CLI, fullAuto: true, workspace: scratch, prewarm: true },
    });
    await expect.poll(() => JSON.parse(readFileSync(rpcDump, "utf8"))).toContain("authenticate");
    const recorder = recordEvents(instance.adapter);
    const turns = await Promise.all([
      instance.adapter.sendTurn({ threadId: "t-hs-first", text: "one" }),
      instance.adapter.sendTurn({ threadId: "t-hs-second", text: "two", cwd: otherCwd }),
    ]);
    for (const turn of turns) {
      await recorder.until((e) => e.type === "turn.completed" && e.turnId === turn.turnId);
      expect(recorder.events.find((e) => e.type === "turn.completed" && e.turnId === turn.turnId)).toMatchObject({ ok: true });
    }
    recorder.stop();
    expect(spawn.mock.calls.length).toBe(2);
  });

  it("expires an unclaimed prewarm child and cold-spawns the next turn", async () => {
    const spawn = vi.spyOn(procs, "spawnCli");
    const Driver = createAcpDriver({ ...grokSupport, warmIdleMs: 500 });
    instance = await Driver.create({
      instanceId: "acp-hs-idle",
      displayName: "ACP Handshake Idle",
      environment: {},
      enabled: true,
      config: { cli: FAKE_CLI, fullAuto: true, workspace: scratch, prewarm: true },
    });
    await expect.poll(() => spawn.mock.results.length).toBe(1);
    const child = spawn.mock.results[0].value;
    await expect.poll(() => child.exitCode !== null || child.signalCode !== null).toBe(true);

    const recorder = recordEvents(instance.adapter);
    await instance.adapter.sendTurn({ threadId: "t-hs-expired", text: "hi" });
    await recorder.until((e) => e.type === "turn.completed");
    recorder.stop();
    expect(spawn.mock.calls.length).toBe(2);
  });

  it("clears the prewarm timer when a turn borrows the child", async () => {
    const spawn = vi.spyOn(procs, "spawnCli");
    const rpcDump = join(scratch, "rpc.json");
    writeFileSync(rpcDump, "[]");
    process.env.FAKE_ACP_RPC_DUMP = rpcDump;
    process.env.FAKE_ACP_MODE = "hang";
    const Driver = createAcpDriver({ ...grokSupport, warmIdleMs: 500 });
    instance = await Driver.create({
      instanceId: "acp-hs-borrowed",
      displayName: "ACP Handshake Borrowed",
      environment: {},
      enabled: true,
      config: { cli: FAKE_CLI, fullAuto: true, workspace: scratch, prewarm: true },
    });
    await expect.poll(() => JSON.parse(readFileSync(rpcDump, "utf8"))).toContain("authenticate");
    await instance.adapter.sendTurn({ threadId: "t-hs-borrowed", text: "hi" });
    await expect.poll(() => JSON.parse(readFileSync(rpcDump, "utf8"))).toContain("session/prompt");
    await new Promise((resolve) => setTimeout(resolve, 600));
    expect(spawn.mock.calls.length).toBe(1);
    const child = spawn.mock.results[0].value;
    expect(child.exitCode).toBeNull();
    expect(child.signalCode).toBeNull();
    expect(child.killed).toBe(false);
  });

  it("prepare() prewarms one CLI after a cold create without config.prewarm", async () => {
    const spawn = vi.spyOn(procs, "spawnCli");
    const exec = vi.spyOn(procs, "execCli");
    const rpcDump = join(scratch, "rpc-prepare.json");
    writeFileSync(rpcDump, "[]");
    process.env.FAKE_ACP_RPC_DUMP = rpcDump;
    process.env.FAKE_ACP_MODE = "happy";

    instance = await GrokAgentDriver.create({
      instanceId: "acp-hs-prepare",
      displayName: "ACP Handshake Prepare",
      environment: {},
      enabled: true,
      config: { cli: FAKE_CLI, fullAuto: true, workspace: scratch },
    });

    expect([exec.mock.calls.length, spawn.mock.calls.length]).toEqual([0, 0]);
    expect(instance.prepare).toBeTypeOf("function");
    await instance.prepare!();
    await expect.poll(() => JSON.parse(readFileSync(rpcDump, "utf8"))).toContain("initialize");
    expect(spawn.mock.calls.length).toBe(1);
    expect(JSON.parse(readFileSync(rpcDump, "utf8"))).not.toContain("session/new");
  });

  it.each(["happy", "initialize-hang"])("deduplicates 8 concurrent prepares and disposes every child (%s)", async (mode) => {
    const spawn = vi.spyOn(procs, "spawnCli");
    process.env.FAKE_ACP_MODE = mode;
    instance = await GrokAgentDriver.create({
      instanceId: "acp-hs-prepare-concurrent",
      displayName: "ACP Handshake Concurrent",
      environment: {},
      enabled: true,
      config: { cli: FAKE_CLI, fullAuto: true, workspace: scratch },
    });
    let settled = 0;
    const prepares = Array.from({ length: 8 }, () => instance.prepare!().finally(() => settled++));
    try {
      await expect.poll(() => spawn.mock.results.length).toBeGreaterThan(0);
      if (mode === "happy") await Promise.all(prepares);
      await instance.dispose();
      expect(settled).toBe(8);
      await expect.poll(() => spawn.mock.results.filter(({ value }) => value.exitCode === null && value.signalCode === null)).toHaveLength(0);
      expect(spawn).toHaveBeenCalledTimes(1);
    } finally {
      for (const { value } of spawn.mock.results) procs.killCliTree(value);
      await Promise.all(prepares);
    }
  });

  it("awaits pending authentication on dispose without spawning", async () => {
    let release!: (authenticated: boolean) => void;
    const authenticated = new Promise<boolean>((resolve) => { release = resolve; });
    const auth = vi.fn(() => authenticated);
    const spawn = vi.spyOn(procs, "spawnCli");
    const Driver = createAcpDriver({ ...grokSupport, requireAuthenticationBeforeSpawn: true, isAuthenticated: auth });
    instance = await Driver.create({
      instanceId: "acp-hs-prepare-auth",
      displayName: "ACP Handshake Auth",
      environment: {},
      enabled: true,
      config: { cli: FAKE_CLI, fullAuto: true, workspace: scratch },
    });
    const prepares = Array.from({ length: 8 }, () => instance.prepare!());
    await expect.poll(() => auth.mock.calls.length).toBeGreaterThan(0);
    let disposed = false;
    const disposing = instance.dispose().then(() => { disposed = true; });
    try {
      await Promise.resolve();
      expect(disposed).toBe(false);
      expect(auth).toHaveBeenCalledTimes(1);
    } finally {
      release(true);
      await Promise.all([...prepares, disposing]);
    }
    expect(spawn).not.toHaveBeenCalled();
  });

  it("prepare() warms again after the idle child expires", async () => {
    const spawn = vi.spyOn(procs, "spawnCli");
    const Driver = createAcpDriver({ ...grokSupport, warmIdleMs: 500 });
    instance = await Driver.create({
      instanceId: "acp-hs-prepare-expired",
      displayName: "ACP Handshake Expired",
      environment: {},
      enabled: true,
      config: { cli: FAKE_CLI, fullAuto: true, workspace: scratch },
    });
    await instance.prepare!();
    const child = spawn.mock.results[0].value;
    await expect.poll(() => child.exitCode !== null || child.signalCode !== null).toBe(true);
    await instance.prepare!();
    expect(spawn).toHaveBeenCalledTimes(2);
  });

  it("prepare() is a no-op when a handshake child is already warm", async () => {
    const spawn = vi.spyOn(procs, "spawnCli");
    const rpcDump = join(scratch, "rpc-prepare-once.json");
    writeFileSync(rpcDump, "[]");
    process.env.FAKE_ACP_RPC_DUMP = rpcDump;
    process.env.FAKE_ACP_MODE = "happy";

    instance = await GrokAgentDriver.create({
      instanceId: "acp-hs-prepare-once",
      displayName: "ACP Handshake Prepare Once",
      environment: {},
      enabled: true,
      config: { cli: FAKE_CLI, fullAuto: true, workspace: scratch, prewarm: true },
    });
    await expect.poll(() => JSON.parse(readFileSync(rpcDump, "utf8"))).toContain("initialize");
    const afterCreate = spawn.mock.calls.length;
    await instance.prepare!();
    await instance.prepare!();
    expect(spawn.mock.calls.length).toBe(afterCreate);
  });
});

describe("probeCliVersion", () => {
  const probeFor = (answers: Record<string, string | null>) => {
    const seen: string[] = [];
    const probe = async (target: string) => {
      seen.push(target);
      return answers[target] ?? null;
    };
    return { seen, probe };
  };

  it("keeps the bare CLI when it answers, without consulting the wrapper", async () => {
    const { seen, probe } = probeFor({ muse: "1.2.1" });
    const result = await probeCliVersion("muse", {}, "win32", () => "wsl muse", probe);
    expect(result).toEqual({ cli: "muse", version: "1.2.1" });
    expect(seen).toEqual(["muse"]);
  });

  it("falls back to the WSL wrapper on win32 when only the WSL login exists", async () => {
    const { seen, probe } = probeFor({ muse: null, "wsl muse": "1.2.1" });
    const result = await probeCliVersion("muse", {}, "win32", (cli) => `wsl ${cli}`, probe);
    expect(result).toEqual({ cli: "wsl muse", version: "1.2.1" });
    expect(seen).toEqual(["muse", "wsl muse"]);
  });

  it("reports unavailable when neither the bare CLI nor the wrapper answers", async () => {
    const { probe } = probeFor({ muse: null, "wsl muse": null });
    expect(await probeCliVersion("muse", {}, "win32", (cli) => `wsl ${cli}`, probe)).toBeNull();
  });

  it("reports unavailable when the driver offers no wrapper", async () => {
    const { seen, probe } = probeFor({ muse: null });
    expect(await probeCliVersion("muse", {}, "win32", undefined, probe)).toBeNull();
    expect(seen).toEqual(["muse"]);
  });

  it("never wraps off win32, so a native miss stays a miss", async () => {
    const { seen, probe } = probeFor({ muse: null, "wsl muse": "1.2.1" });
    expect(await probeCliVersion("muse", {}, "linux", (cli) => `wsl ${cli}`, probe)).toBeNull();
    expect(seen).toEqual(["muse"]);
  });

  it("resolves through the async hook after the wrapper misses, probing the winner", async () => {
    const { seen, probe } = probeFor({ "wsl muse": null, "wsl /home/ed/.local/bin/muse": "Muse Code 1.2.1" });
    const calls: string[] = [];
    const result = await probeCliVersion("wsl muse", {}, "win32", () => null, probe, async (cli) => {
      calls.push(cli);
      return "wsl /home/ed/.local/bin/muse";
    });
    expect(result).toEqual({ cli: "wsl /home/ed/.local/bin/muse", version: "Muse Code 1.2.1" });
    expect(calls).toEqual(["wsl muse"]);
    expect(seen).toEqual(["wsl muse", "wsl /home/ed/.local/bin/muse"]);
  });

  it("skips the resolver when the direct or wrapper probe already answered", async () => {
    const direct = probeFor({ muse: "1.2.1" });
    let calls = 0;
    await expect(
      probeCliVersion("muse", {}, "win32", (cli) => `wsl ${cli}`, direct.probe, async () => {
        calls++;
        return "wsl /home/ed/.local/bin/muse";
      }),
    ).resolves.toEqual({ cli: "muse", version: "1.2.1" });
    const wrapped = probeFor({ muse: null, "wsl muse": "1.2.1" });
    await expect(
      probeCliVersion("muse", {}, "win32", (cli) => `wsl ${cli}`, wrapped.probe, async () => {
        calls++;
        return "wsl /home/ed/.local/bin/muse";
      }),
    ).resolves.toEqual({ cli: "wsl muse", version: "1.2.1" });
    expect(calls).toBe(0);
    expect(direct.seen).toEqual(["muse"]);
    expect(wrapped.seen).toEqual(["muse", "wsl muse"]);
  });

  it("reports unavailable when the resolver finds nothing new", async () => {
    const { seen, probe } = probeFor({ "wsl muse": null });
    await expect(probeCliVersion("wsl muse", {}, "win32", () => null, probe, async () => null)).resolves.toBeNull();
    expect(seen).toEqual(["wsl muse"]);
    const echo = probeFor({ "wsl muse": null });
    await expect(probeCliVersion("wsl muse", {}, "win32", () => null, echo.probe, async () => "wsl muse")).resolves.toBeNull();
    expect(echo.seen).toEqual(["wsl muse"]);
  });

  it("never resolves off win32", async () => {
    const { seen, probe } = probeFor({ muse: null });
    let calls = 0;
    await expect(
      probeCliVersion("muse", {}, "linux", undefined, probe, async () => {
        calls++;
        return "wsl /home/ed/.local/bin/muse";
      }),
    ).resolves.toBeNull();
    expect(calls).toBe(0);
    expect(seen).toEqual(["muse"]);
  });
});

describe("ACP snapshot", () => {
  it("a missing binary is unavailable", async () => {
    const instance = await GrokAgentDriver.create({
      instanceId: "grok-missing",
      displayName: undefined,
      environment: {},
      enabled: true,
      config: { cli: "definitely-not-a-real-grok-binary", fullAuto: false },
    });
    const snap = await instance.snapshot();
    expect(snap.state).toBe("unavailable");
    await instance.dispose();
  });

  it("kimi checks KIMI_CODE_HOME before the child HOME", async () => {
    const scratch = mkdtempSync(join(tmpdir(), "omb-kimi-auth-"));
    const kimiHome = join(scratch, "custom-kimi-home");
    const childHome = join(scratch, "child-home");
    mkdirSync(join(childHome, ".kimi-code", "credentials"), { recursive: true });
    writeFileSync(join(childHome, ".kimi-code", "credentials", "kimi-code.json"), "{}");

    const instance = await KimiAgentDriver.create({
      instanceId: "kimi-custom-home",
      displayName: undefined,
      environment: { KIMI_CODE_HOME: kimiHome, HOME: childHome },
      enabled: true,
      config: { cli: FAKE_CLI, fullAuto: false },
    });
    try {
      expect((await instance.snapshot()).authenticated).toBe(false);
      mkdirSync(join(kimiHome, "credentials"), { recursive: true });
      writeFileSync(join(kimiHome, "credentials", "kimi-code.json"), "{}");
      expect((await instance.snapshot()).authenticated).toBe(true);
    } finally {
      await instance.dispose();
      await removeTempDir(scratch);
    }
  });

  it("droid resolves the signed-in CLI before falling back to FACTORY_API_KEY", async () => {
    const scratch = mkdtempSync(join(tmpdir(), "omb-droid-auth-"));
    // FACTORY_HOME_OVERRIDE replaces the CLI's HOME, not its data root: droid
    // writes <home>/.factory/auth.v2.file either way (verified against 0.196.0).
    const overrideHome = join(scratch, "custom-home");
    const childHome = join(scratch, "child-home");
    mkdirSync(join(childHome, ".factory"), { recursive: true });
    writeFileSync(join(childHome, ".factory", "auth.v2.file"), "{}");

    // The child env inherits process.env (core.ts childEnv), so a developer
    // machine with a real FACTORY_API_KEY exported would otherwise satisfy
    // every case here and prove nothing about the on-disk lookup.
    const make = (environment: Record<string, string>) =>
      DroidAgentDriver.create({
        instanceId: "droid-auth",
        displayName: undefined,
        environment: { FACTORY_API_KEY: "", ...environment },
        enabled: true,
        config: { cli: FAKE_CLI, fullAuto: false },
      });

    const instances: ProviderInstance[] = [];
    try {
      // FACTORY_HOME_OVERRIDE wins: the child HOME's credential must not count.
      const overridden = await make({ FACTORY_HOME_OVERRIDE: overrideHome, HOME: childHome });
      instances.push(overridden);
      expect((await overridden.snapshot()).authenticated).toBe(false);
      mkdirSync(join(overrideHome, ".factory"), { recursive: true });
      writeFileSync(join(overrideHome, ".factory", "auth.v2.file"), "{}");
      expect((await overridden.snapshot()).authenticated).toBe(true);

      // A logged-out override is not rescued by a key on the way past it, but
      // the key alone still authenticates when nothing is signed in on disk.
      const loggedOutWithKey = await make({
        FACTORY_HOME_OVERRIDE: join(scratch, "empty-home"),
        HOME: childHome,
        FACTORY_API_KEY: "fk-test",
      });
      instances.push(loggedOutWithKey);
      expect((await loggedOutWithKey.snapshot()).authenticated).toBe(true);

      const fromHome = await make({ HOME: childHome });
      instances.push(fromHome);
      expect((await fromHome.snapshot()).authenticated).toBe(true);

      // secure_auth_storage writes the keychain/keyring variant instead of
      // auth.v2.file, so a fresh macOS login has only this one.
      const keychainHome = join(scratch, "keychain-home");
      mkdirSync(join(keychainHome, ".factory"), { recursive: true });
      writeFileSync(join(keychainHome, ".factory", "auth.v2.loginkeychain"), "{}");
      const fromKeychain = await make({ HOME: keychainHome });
      instances.push(fromKeychain);
      expect((await fromKeychain.snapshot()).authenticated).toBe(true);

      const neither = await make({ HOME: join(scratch, "empty") });
      instances.push(neither);
      expect((await neither.snapshot()).authenticated).toBe(false);
    } finally {
      for (const i of instances) await i.dispose();
      await removeTempDir(scratch);
    }
  });

  it("droid reads custom models, favourites order, and the configured default", async () => {
    const scratch = mkdtempSync(join(tmpdir(), "omb-droid-models-"));
    mkdirSync(join(scratch, ".factory"), { recursive: true });
    writeFileSync(
      join(scratch, ".factory", "settings.json"),
      JSON.stringify({
        customModels: [
          { id: "custom:LMStudio-Qwen-0", displayName: "Qwen (local)" },
          { id: "custom:Azure-Opus-0", displayName: "Azure Opus" },
        ],
        modelFavorites: ["custom:Azure-Opus-0", "custom:LMStudio-Qwen-0"],
        sessionDefaultSettings: { model: "custom:LMStudio-Qwen-0" },
      }),
    );

    const instance = await DroidAgentDriver.create({
      instanceId: "droid-models",
      displayName: undefined,
      environment: { HOME: scratch },
      enabled: true,
      config: { cli: FAKE_CLI, fullAuto: false },
    });
    try {
      // favourites first in the user's own order, then the built-in slice
      expect(instance.models.options.slice(0, 2)).toEqual([
        { id: "custom:Azure-Opus-0", label: "Azure Opus", custom: true },
        { id: "custom:LMStudio-Qwen-0", label: "Qwen (local)", custom: true },
      ]);
      expect(instance.models.options.some((o) => o.id === "claude-opus-5")).toBe(true);
      expect(instance.models.default).toBe("custom:LMStudio-Qwen-0");
    } finally {
      await instance.dispose();
      await removeTempDir(scratch);
    }
  });

  it("droid falls back to the built-in catalog when settings.json is unreadable", async () => {
    const scratch = mkdtempSync(join(tmpdir(), "omb-droid-nosettings-"));
    mkdirSync(join(scratch, ".factory"), { recursive: true });
    writeFileSync(join(scratch, ".factory", "settings.json"), "{ not json");

    const instance = await DroidAgentDriver.create({
      instanceId: "droid-models-fallback",
      displayName: undefined,
      environment: { HOME: scratch },
      enabled: true,
      config: { cli: FAKE_CLI, fullAuto: false },
    });
    try {
      expect(instance.models.default).toBe("claude-opus-5");
      expect(instance.models.options.every((o) => !o.id.startsWith("custom:"))).toBe(true);
    } finally {
      await instance.dispose();
      await removeTempDir(scratch);
    }
  });

  it("kimi resolves default credentials from the child HOME", async () => {
    const scratch = mkdtempSync(join(tmpdir(), "omb-kimi-home-"));
    const credentialDir = join(scratch, ".kimi-code", "credentials");
    mkdirSync(credentialDir, { recursive: true });
    writeFileSync(join(credentialDir, "kimi-code.json"), "{}");

    const instance = await KimiAgentDriver.create({
      instanceId: "kimi-child-home",
      displayName: undefined,
      environment: { HOME: scratch },
      enabled: true,
      config: { cli: FAKE_CLI, fullAuto: false },
    });
    try {
      expect((await instance.snapshot()).authenticated).toBe(true);
    } finally {
      await instance.dispose();
      await removeTempDir(scratch);
    }
  });

  it("awaits an async isAuthenticated", async () => {
    const instance = await AsyncAuthDriver.create({
      instanceId: "async-auth",
      displayName: undefined,
      environment: {},
      enabled: true,
      config: { cli: FAKE_CLI, fullAuto: false },
    });
    try {
      // without the await this is a Promise: truthy, but not `true`
      expect((await instance.snapshot()).authenticated).toBe(true);
    } finally {
      await instance.dispose();
    }
  });
});
