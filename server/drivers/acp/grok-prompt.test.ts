import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

import { ensureDirs } from "../../config.ts";
import type { ProviderInstance, RuntimeEvent } from "../../contracts.ts";
import { Store } from "../../store.ts";
import { removeTempDir } from "../../testing/cleanup.ts";
import { recordEvents } from "../../testing/events.ts";
import { buildTurnContext, sessionPromptFor, shouldRecycleProviderSession } from "../../turn-context.ts";
import { GeminiAgentDriver } from "./gemini.ts";
import { GrokAgentDriver } from "./grok.ts";

const FAKE_CLI = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "testing", "fake-acp-cli.ts");
const MODEL = "grok-4.7";
const modelState = (window: unknown) => ({
  currentModelId: "other-model",
  availableModels: [
    { modelId: "other-model", _meta: { totalContextTokens: 8_192 } },
    { modelId: MODEL, _meta: { totalContextTokens: window } },
  ],
});

describe("Grok prompt size", () => {
  const instances: ProviderInstance[] = [];
  const scratch: string[] = [];

  afterEach(async () => {
    for (const instance of instances.splice(0)) await instance.dispose();
    for (const path of scratch.splice(0)) await removeTempDir(path);
  });

  const run = async (meta: unknown, state?: unknown, cursor?: string, driver = GrokAgentDriver) => {
    ensureDirs();
    const workspace = mkdtempSync(join(tmpdir(), "omb-grok-prompt-"));
    scratch.push(workspace);
    const instance = await driver.create({
      instanceId: "grok-prompt-test",
      displayName: "Grok",
      enabled: true,
      environment: {
        FAKE_ACP_MODE: "prompt-size",
        FAKE_ACP_DUMP: join(workspace, "prompt.json"),
        FAKE_ACP_PROMPT_META: JSON.stringify(meta),
        ...(state ? { FAKE_ACP_MODEL_STATE: JSON.stringify(state) } : {}),
      },
      config: { cli: FAKE_CLI, workspace, fullAuto: false },
    });
    instances.push(instance);
    const recorder = recordEvents(instance.adapter);
    await instance.adapter.sendTurn({ threadId: "t-grok-prompt", text: "continue", model: MODEL, resumeCursor: cursor });
    const done = await recorder.until((e) => e.type === "turn.completed") as Extract<RuntimeEvent, { type: "turn.completed" }>;
    recorder.stop();
    return { done, events: recorder.events, sentPrompt: JSON.parse(readFileSync(join(workspace, "prompt.json"), "utf8")).prompt };
  };

  it("reports exact last-call input including cache and leaves other ACP engines unchanged", async () => {
    const { done } = await run({ modelId: MODEL, inputTokens: 98_356, cachedReadTokens: 97_536, totalTokens: 98_595, usage: { inputTokens: 1_766_188 } });
    expect(done).toMatchObject({ ok: true, prompt: { first: 98_356, last: 98_356 } });
    expect(done.contextWindow).toBeUndefined();
    expect((await run({ inputTokens: 0 })).done.prompt).toEqual({ first: 0, last: 0 });
    for (const inputTokens of [undefined, null, "98356", 98_356.5, -1, Number.MAX_SAFE_INTEGER + 1]) {
      const { done: invalid } = await run({ inputTokens, totalTokens: 98_595, usage: { inputTokens: 1_766_188 } });
      expect(invalid.ok).toBe(true);
      expect(invalid.prompt).toBeUndefined();
    }
    const { done: gemini } = await run({ inputTokens: 98_356 }, modelState(256_000), undefined, GeminiAgentDriver);
    expect(gemini.ok).toBe(true);
    expect(gemini.prompt).toBeUndefined();
    expect(gemini.contextWindow).toBeUndefined();
  });

  it("reports the matching ACP model window and omits invalid or unknown windows", async () => {
    for (const window of [256_000, undefined, 0, -1, 256_000.5, "256000"]) {
      const { done } = await run({ modelId: MODEL, inputTokens: 98_356 }, modelState(window));
      expect(done.prompt).toEqual({ first: 98_356, last: 98_356 });
      expect(done.contextWindow).toBe(window === 256_000 ? window : undefined);
    }
    const { done } = await run({ inputTokens: 98_356 }, modelState(256_000));
    expect(done.contextWindow).toBe(256_000);
    const { done: unknown } = await run({ modelId: "unknown-model", inputTokens: 98_356 }, modelState(256_000));
    expect(unknown.contextWindow).toBeUndefined();
  });

  it("keeps a 60-tool Grok session at 100k, preserves its first report, and recycles after growth", async () => {
    const store = new Store(() => ({ instanceId: "grok", model: MODEL }));
    const bot = store.createBot({}, { seedMessages: false });
    store.setResumeCursor(bot.id, "grok", "resumed-grok-session", bot.threadId);
    store.markTaskDispatched(bot.id, bot.threadId, "grok", MODEL);
    for (const inputTokens of [40_000, 100_000, 260_000]) {
      const { done, events, sentPrompt } = await run({ modelId: MODEL, inputTokens }, undefined, "resumed-grok-session");
      expect(done.ok).toBe(true);
      expect(events).toContainEqual(expect.objectContaining({ type: "session.started", sessionId: "resumed-grok-session" }));
      expect(sentPrompt).toEqual([{ type: "text", text: "continue" }]);
      if (done.prompt) store.recordNativePrompt(bot.id, bot.threadId, "grok", done.prompt, done.contextWindow);
      const task = store.taskByThread(bot.id, bot.threadId)!;
      const sessionPrompt = sessionPromptFor({ report: task.nativePrompt, cursor: task.resumeCursors.grok, model: MODEL, catalogWindow: 500_000 });
      const tools = events.filter((e) => e.type === "item.completed" && e.itemType === "tool").length;
      expect(tools).toBe(60);
      const input = { compacted: false, lastTurnToolRounds: tools, sessionToolRounds: tools, sessionPrompt };
      const recycled = shouldRecycleProviderSession(input);
      expect(recycled).toBe(inputTokens === 260_000);
      expect(task.nativePrompt).toMatchObject({ cursor: "resumed-grok-session", first: 40_000, last: inputTokens });
      expect(new Store(() => ({ instanceId: "grok", model: MODEL })).taskByThread(bot.id, bot.threadId)?.nativePrompt).toMatchObject({ first: 40_000, last: inputTokens });
      const context = buildTurnContext({ text: "continue", transcript: [{ role: "assistant", text: "previous answer" }], fresh: false, rewound: false, replaysNatively: false, recycled, recycleReason: recycled ? "session-fat" : undefined });
      expect(context.resume).toBe(!recycled);
      if (!recycled) expect(context.turnText).toBe("continue");
      expect(shouldRecycleProviderSession({ ...input, compacted: true })).toBe(true);
      expect(shouldRecycleProviderSession({ ...input, rewound: true })).toBe(false);
      expect(shouldRecycleProviderSession({ ...input, recovering: true })).toBe(false);
    }
    const { done } = await run({ totalTokens: 100_000 });
    expect(done.prompt).toBeUndefined();
    expect(shouldRecycleProviderSession({ compacted: false, sessionToolRounds: 60 })).toBe(true);
  });
});
