// Antigravity driver contract tests, run against the scripted fake `agy` CLI
// in server/testing/fake-agy-cli.ts: normalize the print-mode stream-json turn
// into canonical events, and report availability from `agy --version`.
//
// The fake CLI is a shebang script Windows cannot exec directly;
// spawnCli resolves it to `node <script>`, so these run everywhere.
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import * as auth from "./antigravity-auth.ts";

import { ensureDirs, PROVIDER_CREDENTIAL_ENV, WORKSPACE_CREDENTIAL_ENV } from "../config.ts";
import type { ProviderInstance } from "../contracts.ts";
import { SPAWNED_PROXIES } from "../proxy-paths.ts";
import { recordEvents, type EventRecorder } from "../testing/events.ts";
import {
  ANTIGRAVITY_COMPUTER_MCP_KEY,
  AntigravityDriver,
  antigravityComputerMcpServer,
  antigravityStreamUserLine,
  buildAntigravityTurnArgv,
  composeAntigravityPrompt,
  ensureAntigravityComputerMcp,
  estimateWin32CmdlineLength,
  isAgyAccountError,
  measureAntigravityTransportLengths,
  readAntigravityModelCatalog,
  STATIC_ANTIGRAVITY_MODELS,
  WIN32_CREATEPROCESS_CMDLINE_MAX,
} from "./antigravity.ts";
import { describeSpawnFailure } from "../procs.ts";

const FAKE_CLI = join(dirname(fileURLToPath(import.meta.url)), "..", "testing", "fake-agy-cli.ts");

const createSignIn = auth.antigravitySignIn;
beforeEach(() => {
  vi.spyOn(auth, "antigravitySignIn").mockImplementation(() => createSignIn(async () => true));
});
afterEach(() => vi.restoreAllMocks());

/** Every credential this process could be holding, plus two nobody has heard
 * of yet — the allowlist has to exclude those for the same reason, under
 * whichever name their provider ships them. */
const FOREIGN_CREDENTIALS = [
  ...PROVIDER_CREDENTIAL_ENV,
  ...WORKSPACE_CREDENTIAL_ENV,
  "ACME_API_KEY",
  "NEWPROVIDER_TOKEN",
  "AWS_ACCESS_KEY_ID",
  "AWS_SECRET_ACCESS_KEY",
];

describe("readAntigravityModelCatalog", () => {
  it("lists the three Gemini 3.8 Flash tiers ahead of older Flash entries", () => {
    const ids = STATIC_ANTIGRAVITY_MODELS.options.map((option) => option.id);
    expect(STATIC_ANTIGRAVITY_MODELS.options.filter((option) => option.id.startsWith("gemini-3.8-"))).toEqual([
      { id: "gemini-3.8-flash-high", label: "Gemini 3.8 Flash (High)", contextWindow: 1_048_576 },
      { id: "gemini-3.8-flash-medium", label: "Gemini 3.8 Flash (Medium)", contextWindow: 1_048_576 },
      { id: "gemini-3.8-flash-low", label: "Gemini 3.8 Flash (Low)", contextWindow: 1_048_576 },
    ]);
    for (const option of STATIC_ANTIGRAVITY_MODELS.options) {
      expect(option.contextWindow, option.id).toBeGreaterThanOrEqual(128_000);
    }
    // agy has no bare gemini-3.8-flash: a tier-less id is a bad request
    expect(ids).not.toContain("gemini-3.8-flash");
    expect(ids).toEqual(expect.arrayContaining([
      "gemini-3.7-flash-high",
      "gemini-3.7-flash-medium",
      "gemini-3.7-flash-low",
      "gemini-3.6-flash-high",
      "gemini-3.6-flash-medium",
      "gemini-3.6-flash-low",
    ]));
    expect(ids.some((id) => /^gemini-3\.8-pro/.test(id))).toBe(false);
    expect(ids.indexOf("gemini-3.8-flash-high")).toBeLessThan(ids.indexOf("gemini-3.7-flash-high"));
  });

  // Ids taken verbatim from `agy models` on a real 1.1.27 install (MODEL-AG-STALE).
  // Update this list only after re-running `agy models` and pasting the output —
  // PR #86 shipped a bare gemini-3.8-flash because nobody did.
  const AGY_MODELS_OUTPUT_1_1_27 = [
    "gemini-3.8-flash-high",
    "gemini-3.8-flash-medium",
    "gemini-3.8-flash-low",
    "gemini-3.7-flash-high",
    "gemini-3.7-flash-medium",
    "gemini-3.7-flash-low",
    "gemini-3.6-flash-high",
    "gemini-3.6-flash-medium",
    "gemini-3.6-flash-low",
    "gemini-3.5-flash-high",
    "gemini-3.5-flash-medium",
    "gemini-3.5-flash-low",
    "gemini-3.1-pro-low",
    "gemini-3.1-pro-high",
  ];

  // Predate the ground-truth rule (from the original driver PR #30) and are
  // absent from a current `agy models` run. Not proven fake, not reverified —
  // tracked explicitly so the catalog can't grow a new unverified id by
  // silently joining this list. Needs its own ticket to confirm or remove.
  const ANTIGRAVITY_UNVERIFIED_LEGACY_IDS = ["claude-sonnet-4-6", "claude-opus-4-6-thinking", "gpt-oss-120b-medium"];

  it("has no gemini id outside a real `agy models` run, and tracks every non-gemini id explicitly", () => {
    const ids = STATIC_ANTIGRAVITY_MODELS.options.map((option) => option.id);
    const geminiIds = ids.filter((id) => id.startsWith("gemini-"));
    const otherIds = ids.filter((id) => !id.startsWith("gemini-"));
    expect(geminiIds.slice().sort()).toEqual(AGY_MODELS_OUTPUT_1_1_27.slice().sort());
    expect(otherIds.slice().sort()).toEqual(ANTIGRAVITY_UNVERIFIED_LEGACY_IDS.slice().sort());
    // the sort above ignores position, so newest-tier-first ordering needs its own check
    expect(ids.indexOf("gemini-3.6-flash-high")).toBeLessThan(ids.indexOf("gemini-3.5-flash-high"));
    expect(ids.indexOf("gemini-3.5-flash-low")).toBeLessThan(ids.indexOf("claude-sonnet-4-6"));
  });

  it("returns the official list when settings are missing", () => {
    expect(readAntigravityModelCatalog({ HOME: join(tmpdir(), "omb-agy-missing-home") })).toEqual(
      STATIC_ANTIGRAVITY_MODELS,
    );
  });

  it("tags extra settings models as custom", () => {
    const home = mkdtempSync(join(tmpdir(), "omb-agy-catalog-"));
    mkdirSync(join(home, ".gemini", "antigravity-cli"), { recursive: true });
    writeFileSync(
      join(home, ".gemini", "antigravity-cli", "settings.json"),
      JSON.stringify({ customModels: [{ id: "local-gemini", displayName: "Local Gemini" }] }),
    );
    try {
      const catalog = readAntigravityModelCatalog({ HOME: home });
      expect(catalog.options.slice(0, STATIC_ANTIGRAVITY_MODELS.options.length)).toEqual(STATIC_ANTIGRAVITY_MODELS.options);
      expect(catalog.options.at(-1)).toEqual({ id: "local-gemini", label: "Local Gemini", custom: true });
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});

describe("Antigravity decodeConfig", () => {
  it("publishes the official installer for every supported platform", () => {
    expect(AntigravityDriver.install).toMatchObject({
      command: {
        darwin: "curl -fsSL https://antigravity.google/cli/install.sh | bash",
        linux: "curl -fsSL https://antigravity.google/cli/install.sh | bash",
        win32: "irm https://antigravity.google/cli/install.ps1 | iex",
      },
    });
  });

  it("defaults to the agy binary and fullAuto on", () => {
    expect(AntigravityDriver.decodeConfig({})).toEqual({ cli: "agy", fullAuto: true });
    expect(AntigravityDriver.decodeConfig(undefined)).toEqual({ cli: "agy", fullAuto: true });
  });
  it("fullAuto defaults to true, only false when explicitly set", () => {
    expect(AntigravityDriver.decodeConfig({}).fullAuto).toBe(true);
    expect(AntigravityDriver.decodeConfig({ fullAuto: false }).fullAuto).toBe(false);
    expect(AntigravityDriver.decodeConfig({ fullAuto: true }).fullAuto).toBe(true);
  });
  it("rejects invalid types (throws → shadow snapshot)", () => {
    expect(() => AntigravityDriver.decodeConfig({ cli: 5 })).toThrow(/invalid cli/);
    expect(() => AntigravityDriver.decodeConfig({ fullAuto: "yes" })).toThrow(/invalid fullAuto/);
  });

  it("sends sign-in to the agy command", () => {
    expect(AntigravityDriver.install?.signInCommand).toBe("agy");
  });
});

const AGY_AUTH_FAILED = "authentication failed or timed out";
const AGY_API_DISABLED =
  "Agent Platform API has not been used in project my-personal-agy-vertex before or it is disabled. Enable it by visiting https://console.developers.google.com/apis/api/aiplatform.googleapis.com/overview?project=my-personal-agy-vertex then retry. If you enabled this API recently, wait a few minutes for the action to propagate to our systems and retry.";

describe("isAgyAccountError", () => {
  it("matches auth and permission wording", () => {
    for (const text of [
      AGY_AUTH_FAILED,
      AGY_API_DISABLED,
      "unauthorized",
      "forbidden",
      "HTTP 401",
      "HTTP 403",
      "not logged in",
      "please sign in",
      "authentication failed",
      "PERMISSION_DENIED",
      "permission denied",
      "API disabled",
      "UNAUTHENTICATED: Request had invalid authentication credentials",
      "Agent Platform API has not been used in project my-project-500 before or it is disabled.",
      "Agent Platform API has not been used in project my-project-429 before or it is disabled.",
    ]) {
      expect(isAgyAccountError(text), text).toBe(true);
    }
  });

  it("ignores rate limits, quota, 5xx, and timeout-only failures", () => {
    for (const text of [
      "429 rate limit",
      "rate limit exceeded",
      "500 internal server error",
      "503",
      "5xx",
      "403 RESOURCE_EXHAUSTED: quota exceeded",
      "403 Forbidden: you have exceeded your daily quota",
      "agy watchdog timeout",
      "request timed out",
    ]) {
      expect(isAgyAccountError(text), text).toBe(false);
    }
  });
});

describe("Antigravity turns (fake CLI)", () => {
  let instance: ProviderInstance;
  let recorder: EventRecorder;

  const create = async () => {
    instance = await AntigravityDriver.create({
      instanceId: "agy-test",
      displayName: "Antigravity Test",
      environment: {},
      enabled: true,
      config: { cli: FAKE_CLI, fullAuto: true },
    });
    recorder = recordEvents(instance.adapter);
  };

  beforeEach(() => {
    ensureDirs();
    chmodSync(FAKE_CLI, 0o755);
  });

  afterEach(async () => {
    recorder?.stop();
    await instance?.dispose();
  });

  it("normalizes a full print-mode turn into the canonical event sequence", async () => {
    await create();
    expect((await instance.snapshot()).authenticated).toBe(true);
    const { turnId } = await instance.adapter.sendTurn({ threadId: "t-happy", text: "hi", model: "gemini-3.1-pro-high" });
    await recorder.until((e) => e.type === "turn.completed");

    const types = recorder.events.map((e) => e.type);
    expect(types).toEqual([
      "turn.started",
      "session.started",
      "item.started", // tool ACTIVE
      "item.completed", // tool DONE
      "thread.token-usage.updated", // agent_response usage
      "content.delta", // result.response
      "item.completed", // assistant_text
      "thread.token-usage.updated", // result usage
      "turn.completed",
    ]);
    expect(recorder.events.every((e) => e.turnId === turnId && e.provider === "antigravityAgent")).toBe(true);

    const session = recorder.events.find((e) => e.type === "session.started")!;
    expect((session as any).sessionId).toBe("conv-fake-123");

    const tool = recorder.events.find((e) => e.type === "item.completed" && (e as any).itemType === "tool")!;
    expect((tool as any).ok).toBe(true);

    const usage = recorder.events.find((e) => e.type === "thread.token-usage.updated")!;
    expect(usage).toMatchObject({ input: 105, output: 20 });

    const text = recorder.events.find((e) => e.type === "item.completed" && (e as any).itemType === "assistant_text")!;
    expect((text as any).text).toBe("done from fake agy");

    const done = recorder.events.at(-1)!;
    // result.usage is the turn total (the per-step figures precede it)
    expect(done).toMatchObject({ type: "turn.completed", ok: true, promptAccepted: true, usage: { input: 105, output: 20 } });
    expect(instance.adapter.hasSession("t-happy")).toBe(false);
    expect((await instance.snapshot()).authenticated).toBe(true);
  });

  it("does not render internal system notices from streamed or final text", async () => {
    const previous = process.env.FAKE_AGY_SYSTEM_NOTICE;
    process.env.FAKE_AGY_SYSTEM_NOTICE = "1";
    try {
      await create();
      await instance.adapter.sendTurn({ threadId: "t-system-notice", text: "hi" });
      await recorder.until((event) => event.type === "turn.completed");

      expect(recorder.events.some((event) => event.type === "content.delta")).toBe(false);
      expect(recorder.events.find((event) => event.type === "item.completed" && event.itemType === "assistant_text")).toMatchObject({
        text: "The bot stopped before finishing.",
      });
      expect(recorder.events.some((event) => JSON.stringify(event).includes("<SYSTEM_MESSAGE>"))).toBe(false);
      expect(recorder.events.at(-1)).toMatchObject({ type: "turn.completed", ok: false, stopReason: "no_final_text" });
    } finally {
      if (previous === undefined) delete process.env.FAKE_AGY_SYSTEM_NOTICE;
      else process.env.FAKE_AGY_SYSTEM_NOTICE = previous;
    }
  });

  it("reports a plain stopped note when agy returns no final text", async () => {
    const previous = process.env.FAKE_AGY_NO_FINAL;
    process.env.FAKE_AGY_NO_FINAL = "1";
    try {
      await create();
      await instance.adapter.sendTurn({ threadId: "t-no-final", text: "hi" });
      await recorder.until((event) => event.type === "turn.completed");

      expect(recorder.events.find((event) => event.type === "item.completed" && event.itemType === "assistant_text")).toMatchObject({
        text: "The bot stopped before finishing.",
      });
      expect(recorder.events.at(-1)).toMatchObject({ type: "turn.completed", ok: false, stopReason: "no_final_text" });
    } finally {
      if (previous === undefined) delete process.env.FAKE_AGY_NO_FINAL;
      else process.env.FAKE_AGY_NO_FINAL = previous;
    }
  });

  it("reports a cancelled tool as a cut-off turn even when agy says SUCCESS", async () => {
    const previous = process.env.FAKE_AGY_CANCELLED_TOOL;
    process.env.FAKE_AGY_CANCELLED_TOOL = "1";
    try {
      await create();
      await instance.adapter.sendTurn({ threadId: "t-cancelled-tool", text: "hi" });
      await recorder.until((event) => event.type === "turn.completed");

      expect(recorder.events.find((event) => event.type === "item.completed" && event.itemType === "tool")).toMatchObject({ ok: false });
      expect(recorder.events.find((event) => event.type === "item.completed" && event.itemType === "assistant_text")).toMatchObject({
        text: "The bot stopped before finishing.",
      });
      expect(recorder.events.some((event) => event.type === "content.delta")).toBe(false);
      expect(recorder.events.at(-1)).toMatchObject({ type: "turn.completed", ok: false, stopReason: "cancelled_tool" });
    } finally {
      if (previous === undefined) delete process.env.FAKE_AGY_CANCELLED_TOOL;
      else process.env.FAKE_AGY_CANCELLED_TOOL = previous;
    }
  });

  it.each([
    ["single-line", "1"],
    ["multiline", "multiline"],
  ])("uses the portable fallback for a %s diagnostic", async (label, resumeFailure) => {
    const scratch = mkdtempSync(join(tmpdir(), "omb-agy-resume-"));
    const dump = join(scratch, "dump.json");
    process.env.FAKE_AGY_DUMP = dump;
    process.env.FAKE_AGY_RESUME_FAIL = resumeFailure;
    try {
      await create();
      const { turnId } = await instance.adapter.sendTurn({
        threadId: `t-resume-fallback-${label}`,
        text: "latest prompt",
        resumeCursor: "missing-conversation",
        resumeFallback: { text: "durable task record and recent work\n\ncontinue" },
      });
      await recorder.until((event) => event.type === "turn.retrying" && event.reason === "resume_cursor");
      await recorder.until((event) => event.type === "turn.completed");
      // the relaunch is the same logical turn, so its session lands on the
      // turn id the harness holds as live
      expect(recorder.events.filter((event) => event.type === "session.started").at(-1)).toMatchObject({ turnId });
      expect(recorder.events.at(-1)).toMatchObject({ type: "turn.completed", turnId });

      const invocation = JSON.parse(readFileSync(dump, "utf8"));
      expect(invocation.argv).not.toContain("--conversation");
      expect(invocation.argv).toContain("--input-format");
      expect(invocation.argv).toContain("stream-json");
      expect(invocation.argv).not.toContain("--print");
      expect(invocation.prompt).toBe("durable task record and recent work\n\ncontinue");
      expect(recorder.events.filter((event) => event.type === "turn.completed")).toHaveLength(1);
      expect(recorder.events.at(-1)).toMatchObject({ type: "turn.completed", ok: true });
    } finally {
      delete process.env.FAKE_AGY_DUMP;
      delete process.env.FAKE_AGY_RESUME_FAIL;
      rmSync(scratch, { recursive: true, force: true });
    }
  });

  it("turns off agy's self-updater on Windows so it cannot open a console", async () => {
    const scratch = mkdtempSync(join(tmpdir(), "omb-agy-updater-"));
    const dump = join(scratch, "dump.json");
    process.env.FAKE_AGY_DUMP = dump;
    try {
      await create();
      await instance.adapter.sendTurn({ threadId: "t-updater", text: "hi" });
      await recorder.until((event) => event.type === "turn.completed");
      const { env } = JSON.parse(readFileSync(dump, "utf8"));
      expect(env.AGY_CLI_DISABLE_AUTO_UPDATE).toBe(process.platform === "win32" ? "true" : undefined);
    } finally {
      delete process.env.FAKE_AGY_DUMP;
      rmSync(scratch, { recursive: true, force: true });
    }
  });

  it("reports a user Stop mid-turn as interrupted, not a crash", async () => {
    const scratch = mkdtempSync(join(tmpdir(), "omb-agy-stop-"));
    const ready = join(scratch, "ready");
    process.env.FAKE_AGY_DELAY_MS = "10000";
    process.env.FAKE_AGY_READY_FILE = ready;
    try {
      await create();
      await instance.adapter.sendTurn({ threadId: "t-stop", text: "hi" });
      await expect.poll(() => existsSync(ready), { timeout: 3_000 }).toBe(true);
      await instance.adapter.interruptTurn("t-stop");
      await recorder.until((event) => event.type === "turn.completed");

      expect(recorder.events.some((event) => event.type === "runtime.error")).toBe(false);
      expect(recorder.events.at(-1)).toMatchObject({ type: "turn.completed", ok: false, stopReason: "interrupted" });
      expect(instance.adapter.hasSession("t-stop")).toBe(false);
    } finally {
      delete process.env.FAKE_AGY_DELAY_MS;
      delete process.env.FAKE_AGY_READY_FILE;
      rmSync(scratch, { recursive: true, force: true });
    }
  });

  it("respondToRequest resolves `unavailable` — no interactive permission channel, so the caller denies", async () => {
    await create();
    await expect(instance.adapter.respondToRequest("t-happy", "req-1", { behavior: "allow" })).resolves.toBe("unavailable");
  });

  it.each([
    ["auth", AGY_AUTH_FAILED],
    ["api", AGY_API_DISABLED],
  ])("surfaces an agy %s error as sign-in text without the stopped note", async (label, error) => {
    process.env.FAKE_AGY_RESULT_ERROR = error;
    try {
      await create();
      expect((await instance.snapshot()).authenticated).toBe(true);
      await instance.adapter.sendTurn({ threadId: `t-agy-error-${label}`, text: "hi" });
      await recorder.until((event) => event.type === "turn.completed");

      expect(recorder.events.filter((event) => event.type === "runtime.error")).toEqual([
        expect.objectContaining({ type: "runtime.error", message: error, signIn: true }),
      ]);
      expect(recorder.events.some((event) => event.type === "item.completed" && event.itemType === "assistant_text")).toBe(false);
      expect(recorder.events.at(-1)).toMatchObject({ type: "turn.completed", ok: false, stopReason: "no_final_text" });
      expect((await instance.snapshot()).authenticated).toBe(false);
      expect((await instance.snapshot({ rescan: true })).authenticated).toBe(true);
    } finally {
      delete process.env.FAKE_AGY_RESULT_ERROR;
    }
  });

  it("reports a non-account ERROR without signIn", async () => {
    process.env.FAKE_AGY_RESULT_ERROR = "429 rate limit";
    try {
      await create();
      await instance.adapter.sendTurn({ threadId: "t-agy-rate", text: "hi" });
      await recorder.until((event) => event.type === "turn.completed");

      const err = recorder.events.find((event) => event.type === "runtime.error");
      expect(recorder.events.filter((event) => event.type === "runtime.error")).toHaveLength(1);
      expect(err).toMatchObject({ type: "runtime.error", message: "429 rate limit" });
      expect(err && "signIn" in err ? err.signIn : undefined).toBeUndefined();
      expect(recorder.events.some((event) => event.type === "item.completed" && event.itemType === "assistant_text")).toBe(false);
    } finally {
      delete process.env.FAKE_AGY_RESULT_ERROR;
    }
  });
});

describe("Antigravity system text once per conversation (fake CLI)", () => {
  const persona = "You are Testy.";
  const CONV = "conv-fake-123";
  const instances: ProviderInstance[] = [];
  const recorders: EventRecorder[] = [];
  let scratch: string;

  /** An instance whose fake writes each turn's invocation to its own dump. */
  const start = async (environment: Record<string, string> = {}) => {
    const dump = join(scratch, `dump-${instances.length}.json`);
    const instance = await AntigravityDriver.create({
      instanceId: "agy-system",
      displayName: "Antigravity System",
      environment: { FAKE_AGY_DUMP: dump, ...environment },
      enabled: true,
      config: { cli: FAKE_CLI, fullAuto: true },
    });
    instances.push(instance);
    const recorder = recordEvents(instance.adapter);
    recorders.push(recorder);
    /** One turn; returns the prompt agy read from stdin. */
    return async (input: Parameters<ProviderInstance["adapter"]["sendTurn"]>[0]) => {
      const { turnId } = await instance.adapter.sendTurn(input);
      expect(await recorder.until((e) => e.type === "turn.completed" && e.turnId === turnId)).toMatchObject({ ok: true });
      return JSON.parse(readFileSync(dump, "utf8")).prompt as string;
    };
  };

  beforeEach(() => {
    ensureDirs();
    chmodSync(FAKE_CLI, 0o755);
    scratch = mkdtempSync(join(tmpdir(), "omb-agy-system-"));
  });

  afterEach(async () => {
    for (const recorder of recorders.splice(0)) recorder.stop();
    for (const instance of instances.splice(0)) await instance.dispose();
    rmSync(scratch, { recursive: true, force: true });
  });

  it("sends it on a new conversation and not again to the resumed one", async () => {
    const turn = await start();
    expect(await turn({ threadId: "t-once", text: "one", system: persona })).toBe(`${persona}\n\none`);
    expect(await turn({ threadId: "t-once", text: "two", system: persona, resumeCursor: CONV })).toBe("two");
  });

  it("re-sends a changed system once", async () => {
    const turn = await start();
    await turn({ threadId: "t-changed", text: "one", system: persona });
    const changed = `${persona} Memory: likes tea.`;
    expect(await turn({ threadId: "t-changed", text: "two", system: changed, resumeCursor: CONV })).toBe(`${changed}\n\ntwo`);
    expect(await turn({ threadId: "t-changed", text: "three", system: changed, resumeCursor: CONV })).toBe("three");
  });

  it("sends it with the fallback when the conversation cannot resume", async () => {
    const resumeFails = join(scratch, "resume-fails");
    const turn = await start({ FAKE_AGY_RESUME_FAIL_FILE: resumeFails });
    await turn({ threadId: "t-fallback", text: "one", system: persona });
    expect(await turn({ threadId: "t-fallback", text: "two", system: persona, resumeCursor: CONV })).toBe("two");
    // the relaunch starts a new conversation, which answers the same id again
    writeFileSync(resumeFails, "");
    const text = await turn({
      threadId: "t-fallback",
      text: "three",
      system: persona,
      resumeCursor: CONV,
      resumeFallback: { text: "durable summary\n\nthree" },
    });
    expect(text).toBe(`${persona}\n\ndurable summary\n\nthree`);
  });

  it("re-sends on the turn after an agy checkpoint", async () => {
    const checkpoint = join(scratch, "checkpoint");
    const turn = await start({ FAKE_AGY_CHECKPOINT_FILE: checkpoint });
    await turn({ threadId: "t-checkpoint", text: "one", system: persona });
    writeFileSync(checkpoint, "");
    expect(await turn({ threadId: "t-checkpoint", text: "two", system: persona, resumeCursor: CONV })).toBe("two");
    rmSync(checkpoint);
    expect(await turn({ threadId: "t-checkpoint", text: "three", system: persona, resumeCursor: CONV })).toBe(`${persona}\n\nthree`);
    expect(await turn({ threadId: "t-checkpoint", text: "four", system: persona, resumeCursor: CONV })).toBe("four");
  });

  it("sends it once when a new driver instance resumes an existing conversation", async () => {
    await (await start())({ threadId: "t-restart", text: "one", system: persona });
    const restarted = await start();
    expect(await restarted({ threadId: "t-restart", text: "two", system: persona, resumeCursor: CONV })).toBe(`${persona}\n\ntwo`);
    expect(await restarted({ threadId: "t-restart", text: "three", system: persona, resumeCursor: CONV })).toBe("three");
  });
});

describe("Antigravity snapshot", () => {
  it("reports available with the CLI version against the fake", async () => {
    chmodSync(FAKE_CLI, 0o755);
    const instance = await AntigravityDriver.create({
      instanceId: "agy-snap",
      displayName: undefined,
      environment: {},
      enabled: true,
      config: { cli: FAKE_CLI, fullAuto: false },
    });
    const snap = await instance.snapshot();
    expect(snap.state).toBe("available");
    expect(snap.version).toBe("1.1.12");
    expect(snap.authenticated).toBe(true);
    await instance.dispose();
  });

  it("a missing binary is unavailable", async () => {
    const instance = await AntigravityDriver.create({
      instanceId: "agy-missing",
      displayName: undefined,
      environment: {},
      enabled: true,
      config: { cli: "definitely-not-a-real-agy-binary", fullAuto: false },
    });
    const snap = await instance.snapshot();
    expect(snap.state).toBe("unavailable");
    await instance.dispose();
  });

  it("hands its children no credential it was not granted, known or not", async () => {
    const scratch = mkdtempSync(join(tmpdir(), "omb-agy-allowlist-"));
    const dump = join(scratch, "dump.json");
    const previous = Object.fromEntries(FOREIGN_CREDENTIALS.map((name) => [name, process.env[name]]));
    process.env.FAKE_AGY_DUMP = dump;
    for (const name of FOREIGN_CREDENTIALS) process.env[name] = `${name}-must-not-leak`;
    const instance = await AntigravityDriver.create({
      instanceId: "agy-allowlist",
      displayName: undefined,
      environment: {},
      enabled: true,
      config: { cli: FAKE_CLI, fullAuto: false },
    });
    try {
      await instance.snapshot();
      const seen = JSON.parse(readFileSync(dump, "utf8"));
      expect(Object.keys(seen.env).filter((name) => FOREIGN_CREDENTIALS.includes(name))).toEqual([]);
    } finally {
      await instance.dispose();
      delete process.env.FAKE_AGY_DUMP;
      for (const name of FOREIGN_CREDENTIALS) {
        if (previous[name] === undefined) delete process.env[name];
        else process.env[name] = previous[name];
      }
      rmSync(scratch, { recursive: true, force: true });
    }
  });

  it("strips workspace credentials from snapshot and helper children", async () => {
    const scratch = mkdtempSync(join(tmpdir(), "omb-agy-env-"));
    const dump = join(scratch, "dump.json");
    const names = ["XAI_API_KEY", "COMPOSIO_API_KEY", "BOX_TOKEN", "META_API_KEY", "OMB_TTS_KEY"] as const;
    const previous = Object.fromEntries(names.map((name) => [name, process.env[name]]));
    process.env.FAKE_AGY_DUMP = dump;
    for (const name of names) process.env[name] = `${name}-must-not-leak`;
    const instance = await AntigravityDriver.create({
      instanceId: "agy-env",
      displayName: undefined,
      environment: {},
      enabled: true,
      config: { cli: FAKE_CLI, fullAuto: false },
    });
    try {
      await instance.snapshot();
      for (const name of names) expect(JSON.parse(readFileSync(dump, "utf8")).env[name]).toBeUndefined();

      await instance.generateText?.("summarize safely");
      for (const name of names) expect(JSON.parse(readFileSync(dump, "utf8")).env[name]).toBeUndefined();
    } finally {
      await instance.dispose();
      delete process.env.FAKE_AGY_DUMP;
      for (const name of names) {
        if (previous[name] === undefined) delete process.env[name];
        else process.env[name] = previous[name];
      }
      rmSync(scratch, { recursive: true, force: true });
    }
  });
});

describe("Antigravity computer MCP config", () => {
  const configPath = (home: string) => join(home, ".gemini", "config", "mcp_config.json");
  const readConfig = (home: string) => JSON.parse(readFileSync(configPath(home), "utf8"));
  const boxIntegrations = {
    computer: {
      kind: "box" as const,
      boxId: "bx_1",
      token: "box-tok",
      control: { url: "http://127.0.0.1:9/control", token: "ctl-tok" },
    },
  };
  const boxEntry = () => antigravityComputerMcpServer(boxIntegrations)!;
  const staticEntries = {
    "openmausbot-agents": { command: process.execPath, args: [SPAWNED_PROXIES.agents], env: { ELECTRON_RUN_AS_NODE: "1" } },
    "openmausbot-terminal": { command: process.execPath, args: [SPAWNED_PROXIES.terminal], env: { ELECTRON_RUN_AS_NODE: "1" } },
  };
  const botIntegrations = (bot: string) => ({
    agents: {
      command: process.execPath,
      args: [SPAWNED_PROXIES.agents],
      env: {
        ELECTRON_RUN_AS_NODE: "1",
        OMB_HARNESS_URL: "http://127.0.0.1:9",
        OMB_BOT_ID: bot,
        OMB_THREAD_ID: `t-${bot}`,
        OMB_COMMS_TOKEN: "comms-tok",
        OMB_TURN_DEPTH: "0",
      },
    },
    terminal: {
      command: process.execPath,
      args: [SPAWNED_PROXIES.terminal],
      env: {
        ELECTRON_RUN_AS_NODE: "1",
        OMB_TERMINAL_URL: "http://127.0.0.1:9",
        OMB_TERMINAL_TOKEN: `grant-${bot}`,
        OMB_BOT_ID: bot,
        OMB_HARNESS_URL: "http://127.0.0.1:9",
        OMB_COMMS_TOKEN: "comms-tok",
      },
    },
  });
  const createIn = (home: string, name: string, environment: Record<string, string> = {}) =>
    AntigravityDriver.create({
      instanceId: `agy-mcp-${name}`,
      displayName: undefined,
      environment: { HOME: home, ...environment },
      enabled: true,
      config: { cli: FAKE_CLI, fullAuto: true },
    });
  const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

  it("builds the cloud-box spec on the shared computer proxy (never path-resolved locally)", () => {
    expect(antigravityComputerMcpServer(boxIntegrations)).toEqual({
      command: process.execPath,
      args: [SPAWNED_PROXIES.computer],
      env: {
        ELECTRON_RUN_AS_NODE: "1",
        OGB_BOX_ID: "bx_1",
        OGB_BOX_TOKEN: "box-tok",
        OMB_CONTROL_URL: "http://127.0.0.1:9/control",
        OMB_CONTROL_TOKEN: "ctl-tok",
      },
    });
  });

  it("passes a Local VM / VPS stdio connection through unchanged, and yields null without a computer", () => {
    expect(
      antigravityComputerMcpServer({
        localComputer: { command: "/opt/cua", args: ["--mcp"], env: { CUA_SOCKET: "/tmp/cua.sock" } },
      }),
    ).toEqual({ command: "/opt/cua", args: ["--mcp"], env: { CUA_SOCKET: "/tmp/cua.sock" } });
    expect(antigravityComputerMcpServer({})).toBeNull();
    expect(antigravityComputerMcpServer(undefined)).toBeNull();
  });

  it("upserts only its own key — the user's servers and unknown top-level keys survive", () => {
    const home = mkdtempSync(join(tmpdir(), "omb-agy-mcpcfg-"));
    try {
      mkdirSync(join(home, ".gemini", "config"), { recursive: true });
      writeFileSync(
        configPath(home),
        JSON.stringify({
          mcpServers: { "sqlite-helper": { command: "sqlite-mcp-server", args: ["/db"] } },
          futureTopLevelKey: { keep: true },
        }),
      );
      ensureAntigravityComputerMcp(boxEntry(), { HOME: home });
      let config = readConfig(home);
      expect(config.mcpServers["sqlite-helper"]).toEqual({ command: "sqlite-mcp-server", args: ["/db"] });
      expect(config.futureTopLevelKey).toEqual({ keep: true });
      expect(config.mcpServers[ANTIGRAVITY_COMPUTER_MCP_KEY]).toEqual(boxEntry());

      // A later turn on a different computer overwrites the key in place.
      ensureAntigravityComputerMcp(
        { command: "/opt/cua", args: ["--mcp"], env: { CUA_SOCKET: "/tmp/cua.sock" } },
        { HOME: home },
      );
      config = readConfig(home);
      expect(config.mcpServers[ANTIGRAVITY_COMPUTER_MCP_KEY].command).toBe("/opt/cua");
      expect(config.mcpServers["sqlite-helper"]).toEqual({ command: "sqlite-mcp-server", args: ["/db"] });
      expect(config.futureTopLevelKey).toEqual({ keep: true });
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("starts fresh from malformed JSON instead of failing the turn", () => {
    const home = mkdtempSync(join(tmpdir(), "omb-agy-mcpbad-"));
    try {
      mkdirSync(join(home, ".gemini", "config"), { recursive: true });
      writeFileSync(configPath(home), "{{{ not json");
      ensureAntigravityComputerMcp(boxEntry(), { HOME: home });
      expect(readConfig(home).mcpServers[ANTIGRAVITY_COMPUTER_MCP_KEY]).toEqual(boxEntry());
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("restricts the token-bearing config directory and file to the current user", () => {
    if (process.platform === "win32") return;
    const home = mkdtempSync(join(tmpdir(), "omb-agy-mcpperms-"));
    try {
      const directory = dirname(configPath(home));
      mkdirSync(directory, { recursive: true, mode: 0o755 });
      writeFileSync(configPath(home), "{}\n", { mode: 0o644 });

      ensureAntigravityComputerMcp(boxEntry(), { HOME: home });

      expect(statSync(directory).mode & 0o777).toBe(0o700);
      expect(statSync(configPath(home)).mode & 0o777).toBe(0o600);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("preserves concurrent config edits while restoring only its own MCP entry", () => {
    const home = mkdtempSync(join(tmpdir(), "omb-agy-mcpconcurrent-"));
    try {
      const restoreNewFile = ensureAntigravityComputerMcp(boxEntry(), { HOME: home });
      const concurrentlyCreated = readConfig(home);
      concurrentlyCreated.mcpServers["external-helper"] = { command: "external-mcp" };
      concurrentlyCreated.futureTopLevelKey = { keep: true };
      writeFileSync(configPath(home), JSON.stringify(concurrentlyCreated));

      restoreNewFile();
      expect(existsSync(configPath(home))).toBe(true);
      let restored = readConfig(home);
      expect(Object.keys(restored.mcpServers)).toEqual(["external-helper"]);
      expect(restored.mcpServers["external-helper"]).toEqual({ command: "external-mcp" });
      expect(restored.futureTopLevelKey).toEqual({ keep: true });

      const originalEntry = { command: "user-owned-mcp", args: ["--serve"] };
      writeFileSync(
        configPath(home),
        JSON.stringify({ mcpServers: { [ANTIGRAVITY_COMPUTER_MCP_KEY]: originalEntry } }),
      );
      const restoreExistingEntry = ensureAntigravityComputerMcp(boxEntry(), { HOME: home });
      const concurrentlyEdited = readConfig(home);
      concurrentlyEdited.mcpServers["another-helper"] = { command: "another-mcp" };
      writeFileSync(configPath(home), JSON.stringify(concurrentlyEdited));

      restoreExistingEntry();
      restored = readConfig(home);
      // an openmausbot-* key found at mount time is a crash leftover, never written back
      expect(restored.mcpServers).toEqual({ "another-helper": { command: "another-mcp" } });
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("restore strips a stale openmausbot-* key and keeps the user's own keys and unknown top-level keys", () => {
    const home = mkdtempSync(join(tmpdir(), "omb-agy-mcpstale-"));
    try {
      mkdirSync(join(home, ".gemini", "config"), { recursive: true });
      writeFileSync(
        configPath(home),
        JSON.stringify({
          mcpServers: {
            "sqlite-helper": { command: "sqlite-mcp-server", args: ["/db"] },
            [ANTIGRAVITY_COMPUTER_MCP_KEY]: boxEntry(),
            "openmausbot-terminal": { command: "stale", env: { OMB_TERMINAL_TOKEN: "stale-grant" } },
          },
          futureTopLevelKey: { keep: true },
        }),
      );
      const restore = ensureAntigravityComputerMcp(null, { HOME: home });
      expect(readConfig(home).mcpServers).toEqual({
        "sqlite-helper": { command: "sqlite-mcp-server", args: ["/db"] },
        ...staticEntries,
      });

      restore();
      expect(readConfig(home)).toEqual({
        mcpServers: { "sqlite-helper": { command: "sqlite-mcp-server", args: ["/db"] } },
        futureTopLevelKey: { keep: true },
      });
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("advertises computerMcp only on full-auto instances, and never localComputerMcp", async () => {
    const fullAuto = await AntigravityDriver.create({
      instanceId: "agy-caps-full",
      displayName: undefined,
      environment: {},
      enabled: true,
      config: { cli: FAKE_CLI, fullAuto: true },
    });
    const acceptEdits = await AntigravityDriver.create({
      instanceId: "agy-caps-safe",
      displayName: undefined,
      environment: {},
      enabled: true,
      config: { cli: FAKE_CLI, fullAuto: false },
    });
    try {
      expect(fullAuto.adapter.capabilities.computerMcp).toBe(true);
      // accept-edits print mode auto-denies tools that would prompt, so a
      // mount there could never fire — the capability must not be offered.
      expect(acceptEdits.adapter.capabilities.computerMcp).toBe(false);
      // The host desktop needs per-action human approval; print mode has no
      // approval channel in any mode.
      expect(fullAuto.adapter.capabilities.localComputerMcp).toBeUndefined();
      expect(acceptEdits.adapter.capabilities.localComputerMcp).toBeUndefined();
      // so the composer offers no Ask for approval chip either
      expect(fullAuto.adapter.capabilities.askApproval).toBe(false);
      expect(acceptEdits.adapter.capabilities.askApproval).toBe(false);
      expect(fullAuto.adapter.capabilities.agentsMcp).toBe(true);
      expect(acceptEdits.adapter.capabilities.agentsMcp).toBe(true);
    } finally {
      await fullAuto.dispose();
      await acceptEdits.dispose();
    }
  });

  it("uses the spawned CLI's HOME and restores the prior config when the turn exits", async () => {
    ensureDirs();
    chmodSync(FAKE_CLI, 0o755);
    const home = mkdtempSync(join(tmpdir(), "omb-agy-mcpturn-"));
    const dump = join(home, "mcp-at-spawn.json");
    const original = JSON.stringify({ mcpServers: { "sqlite-helper": { command: "sqlite-mcp-server", args: ["/db"] } } });
    mkdirSync(join(home, ".gemini", "config"), { recursive: true });
    writeFileSync(configPath(home), original);
    const instance = await AntigravityDriver.create({
      instanceId: "agy-mcp-turn",
      displayName: undefined,
      environment: { HOME: home, FAKE_AGY_DELAY_MS: "100", FAKE_AGY_MCP_DUMP: dump },
      enabled: true,
      config: { cli: FAKE_CLI, fullAuto: true },
    });
    const recorder = recordEvents(instance.adapter);
    try {
      await instance.adapter.sendTurn({
        threadId: "t-mcp-on",
        text: "click things",
        integrations: boxIntegrations,
      });
      // sendTurn resolves after the child is spawned; the write happens
      // synchronously before that spawn, so this IS the spawn-time content.
      const mounted = readConfig(home);
      expect(mounted.mcpServers[ANTIGRAVITY_COMPUTER_MCP_KEY]).toEqual(boxEntry());
      expect(mounted.mcpServers["sqlite-helper"]).toEqual({ command: "sqlite-mcp-server", args: ["/db"] });
      await recorder.until((e) => e.type === "turn.completed");
      expect(JSON.parse(readFileSync(dump, "utf8")).mcpServers[ANTIGRAVITY_COMPUTER_MCP_KEY]).toEqual(boxEntry());
      await expect.poll(() => readFileSync(configPath(home), "utf8")).toBe(original);
    } finally {
      recorder.stop();
      await instance.dispose();
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("runs computer-less turns side by side, each child carrying its own identity in env", async () => {
    ensureDirs();
    chmodSync(FAKE_CLI, 0o755);
    const home = mkdtempSync(join(tmpdir(), "omb-agy-mcpshared-"));
    const hold = join(home, "hold");
    const original = JSON.stringify({ mcpServers: { "sqlite-helper": { command: "sqlite-mcp-server" } }, futureTopLevelKey: { keep: true } });
    mkdirSync(join(home, ".gemini", "config"), { recursive: true });
    writeFileSync(configPath(home), original);
    const python = await createIn(home, "python", { FAKE_AGY_HOLD_FILE: hold, FAKE_AGY_DUMP: join(home, "python.json") });
    const teacher = await createIn(home, "teacher", { FAKE_AGY_HOLD_FILE: hold, FAKE_AGY_DUMP: join(home, "teacher.json") });
    const pythonRecorder = recordEvents(python.adapter);
    const teacherRecorder = recordEvents(teacher.adapter);
    try {
      await python.adapter.sendTurn({ threadId: "t-python", text: "one", integrations: botIntegrations("python") });
      void teacher.adapter.sendTurn({ threadId: "t-teacher", text: "two", integrations: botIntegrations("teacher") });
      await expect.poll(() => existsSync(join(home, "teacher.json")), { timeout: 3_000 }).toBe(true);
      await expect.poll(() => existsSync(join(home, "python.json")), { timeout: 3_000 }).toBe(true);
      expect([...pythonRecorder.events, ...teacherRecorder.events].some((event) => event.type === "turn.completed")).toBe(false);

      for (const bot of ["python", "teacher"]) {
        const { env } = JSON.parse(readFileSync(join(home, `${bot}.json`), "utf8"));
        expect(env).toMatchObject({ OMB_BOT_ID: bot, OMB_THREAD_ID: `t-${bot}`, OMB_COMMS_TOKEN: "comms-tok", OMB_TERMINAL_TOKEN: `grant-${bot}` });
        expect(env.ELECTRON_RUN_AS_NODE).toBeUndefined();
      }
      const mounted = readFileSync(configPath(home), "utf8");
      expect(mounted).not.toContain("OMB_");
      expect(JSON.parse(mounted)).toEqual({
        mcpServers: { "sqlite-helper": { command: "sqlite-mcp-server" }, ...staticEntries },
        futureTopLevelKey: { keep: true },
      });

      writeFileSync(hold, "");
      await pythonRecorder.until((event) => event.type === "turn.completed");
      await teacherRecorder.until((event) => event.type === "turn.completed");
      expect(pythonRecorder.events.at(-1)).toMatchObject({ ok: true });
      expect(teacherRecorder.events.at(-1)).toMatchObject({ ok: true });
      await expect.poll(() => readFileSync(configPath(home), "utf8")).toBe(original);
    } finally {
      writeFileSync(hold, "");
      pythonRecorder.stop();
      teacherRecorder.stop();
      await python.dispose();
      await teacher.dispose();
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("keeps a computer turn exclusive, and queues later turns behind a waiting one", async () => {
    ensureDirs();
    chmodSync(FAKE_CLI, 0o755);
    const home = mkdtempSync(join(tmpdir(), "omb-agy-mcplease-"));
    const holdShared = join(home, "hold-shared");
    const holdComputer = join(home, "hold-computer");
    const computerDump = join(home, "computer.json");
    const laterDump = join(home, "later.json");
    const shared = await createIn(home, "shared", { FAKE_AGY_HOLD_FILE: holdShared });
    const computer = await createIn(home, "computer", { FAKE_AGY_HOLD_FILE: holdComputer, FAKE_AGY_MCP_DUMP: computerDump });
    const later = await createIn(home, "later", { FAKE_AGY_MCP_DUMP: laterDump });
    const computerRecorder = recordEvents(computer.adapter);
    const laterRecorder = recordEvents(later.adapter);
    try {
      await shared.adapter.sendTurn({ threadId: "t-mcp-shared", text: "first" });
      let computerSpawned = false;
      const computerTurn = computer.adapter.sendTurn({ threadId: "t-mcp-computer", text: "click", integrations: boxIntegrations }).then((result) => {
        computerSpawned = true;
        return result;
      });
      await sleep(30);
      let laterSpawned = false;
      const laterTurn = later.adapter.sendTurn({ threadId: "t-mcp-later", text: "later" }).then((result) => {
        laterSpawned = true;
        return result;
      });
      await sleep(200);
      expect(computerSpawned).toBe(false);
      expect(laterSpawned).toBe(false);

      writeFileSync(holdShared, "");
      await computerTurn;
      await sleep(200);
      expect(laterSpawned).toBe(false);

      writeFileSync(holdComputer, "");
      await computerRecorder.until((event) => event.type === "turn.completed");
      await laterTurn;
      await laterRecorder.until((event) => event.type === "turn.completed");

      expect(JSON.parse(readFileSync(computerDump, "utf8")).mcpServers).toEqual({
        ...staticEntries,
        [ANTIGRAVITY_COMPUTER_MCP_KEY]: boxEntry(),
      });
      expect(JSON.parse(readFileSync(laterDump, "utf8")).mcpServers).toEqual(staticEntries);
      await expect.poll(() => existsSync(configPath(home))).toBe(false);
    } finally {
      writeFileSync(holdShared, "");
      writeFileSync(holdComputer, "");
      computerRecorder.stop();
      laterRecorder.stop();
      await shared.dispose();
      await computer.dispose();
      await later.dispose();
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("a Stop during the lock wait never spawns the turn and completes it as interrupted", async () => {
    ensureDirs();
    chmodSync(FAKE_CLI, 0o755);
    const home = mkdtempSync(join(tmpdir(), "omb-agy-mcpwaitstop-"));
    const hold = join(home, "hold");
    const waitingReady = join(home, "waiting.ready");
    const computer = await createIn(home, "holder", { FAKE_AGY_HOLD_FILE: hold });
    const waiting = await createIn(home, "waiting", { FAKE_AGY_READY_FILE: waitingReady });
    const computerRecorder = recordEvents(computer.adapter);
    const waitingRecorder = recordEvents(waiting.adapter);
    try {
      await computer.adapter.sendTurn({ threadId: "t-mcp-holder", text: "click", integrations: boxIntegrations });
      const waitingTurn = waiting.adapter.sendTurn({ threadId: "t-mcp-waiting", text: "hi" });
      await sleep(50);
      expect(waiting.adapter.hasSession("t-mcp-waiting")).toBe(true);
      await waiting.adapter.interruptTurn("t-mcp-waiting");
      await waitingRecorder.until((event) => event.type === "turn.completed", 3_000);

      const { turnId } = await waitingTurn;
      expect(waitingRecorder.events.map((event) => event.type)).toEqual(["turn.started", "turn.completed"]);
      expect(waitingRecorder.events.every((event) => event.turnId === turnId)).toBe(true);
      expect(waitingRecorder.events.at(-1)).toMatchObject({ ok: false, stopReason: "interrupted" });
      expect(waiting.adapter.hasSession("t-mcp-waiting")).toBe(false);

      writeFileSync(hold, "");
      await computerRecorder.until((event) => event.type === "turn.completed");
      await sleep(300);
      expect(existsSync(waitingReady)).toBe(false);
      await expect.poll(() => existsSync(configPath(home))).toBe(false);
    } finally {
      writeFileSync(hold, "");
      computerRecorder.stop();
      waitingRecorder.stop();
      await computer.dispose();
      await waiting.dispose();
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("reaps a child that hangs after result, restores the mount, and unblocks the next turn", async () => {
    ensureDirs();
    chmodSync(FAKE_CLI, 0o755);
    const home = mkdtempSync(join(tmpdir(), "omb-agy-mcpreaper-"));
    const firstDump = join(home, "first.json");
    const secondDump = join(home, "second.json");
    const first = await AntigravityDriver.create({
      instanceId: "agy-mcp-zombie",
      displayName: undefined,
      environment: {
        HOME: home,
        FAKE_AGY_MCP_DUMP: firstDump,
        FAKE_AGY_POST_RESULT_DELAY_MS: "10000",
        FAKE_AGY_IGNORE_SIGTERM: "1",
      },
      enabled: true,
      config: { cli: FAKE_CLI, fullAuto: true },
    });
    const second = await AntigravityDriver.create({
      instanceId: "agy-mcp-after-zombie",
      displayName: undefined,
      environment: { HOME: home, FAKE_AGY_MCP_DUMP: secondDump },
      enabled: true,
      config: { cli: FAKE_CLI, fullAuto: true },
    });
    const firstRecorder = recordEvents(first.adapter);
    const secondRecorder = recordEvents(second.adapter);
    try {
      await first.adapter.sendTurn({ threadId: "t-mcp-zombie", text: "first", integrations: boxIntegrations });
      await firstRecorder.until((event) => event.type === "turn.completed");
      expect(readConfig(home).mcpServers[ANTIGRAVITY_COMPUTER_MCP_KEY]).toEqual(boxEntry());

      let secondSpawned = false;
      const secondTurn = second.adapter.sendTurn({ threadId: "t-mcp-after-zombie", text: "second" }).then((result) => {
        secondSpawned = true;
        return result;
      });
      if (process.platform !== "win32") {
        await new Promise((resolve) => setTimeout(resolve, 2_500));
        expect(secondSpawned).toBe(false);
      }
      await secondTurn;
      await secondRecorder.until((event) => event.type === "turn.completed");

      expect(JSON.parse(readFileSync(firstDump, "utf8")).mcpServers[ANTIGRAVITY_COMPUTER_MCP_KEY]).toEqual(boxEntry());
      expect(JSON.parse(readFileSync(secondDump, "utf8"))?.mcpServers?.[ANTIGRAVITY_COMPUTER_MCP_KEY]).toBeUndefined();
      await expect.poll(() => existsSync(configPath(home))).toBe(false);
    } finally {
      firstRecorder.stop();
      secondRecorder.stop();
      await first.dispose();
      await second.dispose();
      rmSync(home, { recursive: true, force: true });
    }
  }, 10_000);

  it("force-reaps an interrupted child that ignores SIGTERM before result", async () => {
    ensureDirs();
    chmodSync(FAKE_CLI, 0o755);
    const home = mkdtempSync(join(tmpdir(), "omb-agy-mcpinterrupt-"));
    const readyFile = join(home, "ready");
    const first = await AntigravityDriver.create({
      instanceId: "agy-mcp-interrupted",
      displayName: undefined,
      environment: {
        HOME: home,
        FAKE_AGY_DELAY_MS: "10000",
        FAKE_AGY_IGNORE_SIGTERM: "1",
        FAKE_AGY_READY_FILE: readyFile,
      },
      enabled: true,
      config: { cli: FAKE_CLI, fullAuto: true },
    });
    const second = await AntigravityDriver.create({
      instanceId: "agy-mcp-after-interrupt",
      displayName: undefined,
      environment: { HOME: home },
      enabled: true,
      config: { cli: FAKE_CLI, fullAuto: true },
    });
    const secondRecorder = recordEvents(second.adapter);
    try {
      await first.adapter.sendTurn({ threadId: "t-mcp-interrupted", text: "first", integrations: boxIntegrations });
      expect(readConfig(home).mcpServers[ANTIGRAVITY_COMPUTER_MCP_KEY]).toEqual(boxEntry());
      await expect.poll(() => existsSync(readyFile), { timeout: 2_000 }).toBe(true);
      await first.adapter.interruptTurn("t-mcp-interrupted");

      let secondSpawned = false;
      const secondTurn = second.adapter.sendTurn({ threadId: "t-mcp-after-interrupt", text: "second" }).then((result) => {
        secondSpawned = true;
        return result;
      });
      if (process.platform !== "win32") {
        await new Promise((resolve) => setTimeout(resolve, 1_000));
        expect(secondSpawned).toBe(false);
      }
      await secondTurn;
      await secondRecorder.until((event) => event.type === "turn.completed");
      await expect.poll(() => existsSync(configPath(home)), { timeout: 6_000 }).toBe(false);
    } finally {
      secondRecorder.stop();
      await first.dispose();
      await second.dispose();
      rmSync(home, { recursive: true, force: true });
    }
  }, 10_000);
});


describe("Antigravity Windows long-prompt transport", () => {
  let instance: ProviderInstance;
  let recorder: EventRecorder;

  const create = async () => {
    instance = await AntigravityDriver.create({
      instanceId: "agy-enametoolong",
      displayName: "Antigravity ENAMETOOLONG",
      environment: {},
      enabled: true,
      config: { cli: FAKE_CLI, fullAuto: true },
    });
    recorder = recordEvents(instance.adapter);
  };

  beforeEach(() => {
    ensureDirs();
    chmodSync(FAKE_CLI, 0o755);
  });

  afterEach(async () => {
    recorder?.stop();
    await instance?.dispose();
    delete process.env.FAKE_AGY_DUMP;
  });

  it("keeps the prompt off argv and under the Windows cmdline ceiling", () => {
    const userText = "paste-" + "字".repeat(12_000);
    const system = "persona-" + "A".repeat(8_000);
    const continuity = "continuity-" + "B".repeat(20_000);
    const combinedSystem = `${system}\n\n${continuity}`;
    const prompt = composeAntigravityPrompt(combinedSystem, userText);
    const cwd = "C:\\Users\\mredw\\Desktop\\Orbit-worker-antigravity-enametoolong\\workspaces\\thread";
    const argv = buildAntigravityTurnArgv({ fullAuto: true, cwd, model: "gemini-3.1-pro-high" });
    const stdinLine = antigravityStreamUserLine(prompt);
    const lengths = measureAntigravityTransportLengths({
      userText,
      system: combinedSystem,
      continuity,
      toolMcpConfigJson: JSON.stringify({ mcpServers: { "openmausbot-computer": { command: "node", args: ["proxy.js"] } } }),
      cli: "agy",
      argv,
      stdinLine,
    });

    // Lengths only — prove the old --print argv path would have blown CreateProcess.
    const legacyArgv = ["--print", prompt, ...argv];
    const legacyCmdline = estimateWin32CmdlineLength("agy", legacyArgv);
    expect(legacyCmdline).toBeGreaterThan(WIN32_CREATEPROCESS_CMDLINE_MAX);
    expect(lengths.totalArgvChars).toBeLessThan(WIN32_CREATEPROCESS_CMDLINE_MAX);
    expect(lengths.stdinBytes).toBeGreaterThan(20_000);
    expect(lengths.userTextChars).toBe(userText.length);
    expect(lengths.systemChars).toBe(combinedSystem.length);
    expect(lengths.continuityChars).toBe(continuity.length);
    expect(lengths.toolMcpConfigChars).toBeGreaterThan(0);
    expect(argv).not.toContain("--print");
    expect(argv).not.toContain(prompt);
    expect(JSON.parse(stdinLine).event).toBe("user");
  });

  it("delivers a long paste over stdin and leaves continuity in the prompt body", async () => {
    const scratch = mkdtempSync(join(tmpdir(), "omb-agy-long-"));
    const dump = join(scratch, "dump.json");
    process.env.FAKE_AGY_DUMP = dump;
    const continuity = "CONTINUITY_BLOCK:" + "C".repeat(20_000);
    const userText = "LONG_PASTE:" + "한".repeat(6_000) + ' and quotes: "hello" \\path\\file';
    try {
      await create();
      await instance.adapter.sendTurn({
        threadId: "t-long-paste",
        text: userText,
        system: `persona\n\n${continuity}`,
        model: "gemini-3.1-pro-high",
      });
      await recorder.until((event) => event.type === "turn.completed");

      const invocation = JSON.parse(readFileSync(dump, "utf8"));
      expect(invocation.argv).toEqual(expect.arrayContaining(["--input-format", "stream-json", "--output-format", "stream-json"]));
      expect(invocation.argv).not.toContain("--print");
      expect(invocation.argv.some((arg: string) => arg.includes("LONG_PASTE") || arg.includes("CONTINUITY_BLOCK"))).toBe(false);
      expect(invocation.prompt).toContain("CONTINUITY_BLOCK:");
      expect(invocation.prompt).toContain("LONG_PASTE:");
      expect(invocation.prompt).toContain('"hello"');
      expect(invocation.promptChars).toBeGreaterThan(20_000);
      expect(estimateWin32CmdlineLength(FAKE_CLI, invocation.argv)).toBeLessThan(WIN32_CREATEPROCESS_CMDLINE_MAX);
      expect(recorder.events.at(-1)).toMatchObject({ type: "turn.completed", ok: true });
      expect(instance.adapter.hasSession("t-long-paste")).toBe(false);
    } finally {
      rmSync(scratch, { recursive: true, force: true });
    }
  });

  it("delivers a short message with large injected system/continuity the same way", async () => {
    const scratch = mkdtempSync(join(tmpdir(), "omb-agy-short-"));
    const dump = join(scratch, "dump.json");
    process.env.FAKE_AGY_DUMP = dump;
    const continuity = "INJECTED:" + "D".repeat(25_000);
    try {
      await create();
      await instance.adapter.sendTurn({
        threadId: "t-short-huge-context",
        text: "lets get rid of this pycache what is that",
        system: continuity,
      });
      await recorder.until((event) => event.type === "turn.completed");
      const invocation = JSON.parse(readFileSync(dump, "utf8"));
      expect(invocation.prompt.startsWith("INJECTED:")).toBe(true);
      expect(invocation.prompt.endsWith("lets get rid of this pycache what is that")).toBe(true);
      expect(invocation.argv).not.toContain(invocation.prompt);
      expect(recorder.events.at(-1)).toMatchObject({ type: "turn.completed", ok: true });
    } finally {
      rmSync(scratch, { recursive: true, force: true });
    }
  });

  it("summarizes a prompt over 40k chars through stdin, not argv", async () => {
    const scratch = mkdtempSync(join(tmpdir(), "omb-agy-summary-"));
    const dump = join(scratch, "dump.json");
    process.env.FAKE_AGY_DUMP = dump;
    const prompt = "SUMMARIZE:" + "S".repeat(40_000);
    try {
      await create();
      await expect(instance.generateText!(prompt)).resolves.toBe("done from fake agy");
      const invocation = JSON.parse(readFileSync(dump, "utf8"));
      expect(invocation.prompt).toBe(prompt);
      expect(invocation.argv).toEqual(
        expect.arrayContaining(["--input-format", "stream-json", "--output-format", "stream-json", "--model", "gemini-3.6-flash-low"]),
      );
      expect(invocation.argv).not.toContain("--dangerously-skip-permissions");
      expect(invocation.argv.some((arg: string) => arg.includes("SUMMARIZE:"))).toBe(false);
    } finally {
      rmSync(scratch, { recursive: true, force: true });
    }
  });

  it.skipIf(process.platform !== "win32")("fails one turn recoverably when remaining argv exceeds the Windows cmdline ceiling", async () => {
    await create();
    const hugeCursor = "c".repeat(WIN32_CREATEPROCESS_CMDLINE_MAX);
    await instance.adapter.sendTurn({
      threadId: "t-argv-too-long",
      text: "hi",
      resumeCursor: hugeCursor,
    });
    await recorder.until((event) => event.type === "turn.completed");
    const err = recorder.events.find((event) => event.type === "runtime.error");
    expect(err).toMatchObject({ type: "runtime.error" });
    expect(String((err as { message?: string }).message)).toMatch(/command line too long/i);
    expect(recorder.events.at(-1)).toMatchObject({ type: "turn.completed", ok: false, stopReason: "spawn_error" });
    expect(instance.adapter.hasSession("t-argv-too-long")).toBe(false);

    // Subsequent short turn still works — not stuck busy.
    await instance.adapter.sendTurn({ threadId: "t-argv-too-long", text: "hi again" });
    await recorder.until((event) => event.type === "turn.completed" && event.ok === true);
    expect(recorder.events.filter((event) => event.type === "turn.completed")).toHaveLength(2);
  });

  it("maps ENAMETOOLONG spawn failures to a clear recoverable message", () => {
    const err = Object.assign(new Error("spawn agy ENAMETOOLONG"), { code: "ENAMETOOLONG" });
    expect(describeSpawnFailure(err, "agy")).toEqual({
      message: "spawn failed: command line too long for this OS (`agy`)",
      setup: false,
    });
    const e2big = Object.assign(new Error("spawn agy E2BIG"), { code: "E2BIG" });
    expect(describeSpawnFailure(e2big, "agy").message).toMatch(/command line too long/);
  });
});
