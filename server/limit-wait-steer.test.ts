import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { afterEach, expect, it, vi } from "vitest";

import { createBotChatRoutes } from "./bot-chat-routes.ts";
import { LimitWaits } from "./limit-wait.ts";
import { SendSequencer } from "./send-idempotency.ts";
import { _resetSteerQueue } from "./steer-queue.ts";
import { Store } from "./store.ts";
import { lastUserInstruction } from "./task-recovery-flush.ts";

const dirs: string[] = [];
afterEach(() => { _resetSteerQueue(); for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

function harness(key: "production" | "selection-only") {
  const dir = mkdtempSync(join(tmpdir(), "audit-high3-")); dirs.push(dir);
  const selection = { instanceId: "claude", model: "opus", effort: "max" as const };
  const store = new Store(() => selection);
  const bot = store.createBot({}, { seedMessages: false });
  store.appendMessage(bot.threadId, { role: "user", kind: "text", text: "finish this long task" });
  const now = Date.parse("2026-10-28T00:00:00Z");
  const waits = new LimitWaits({
    file: join(dir, "limit-waits.json"), now: () => now, deviceId: () => "pc-a",
    current: () => {
      const current = store.bot(bot.id);
      if (!current || !store.taskByThread(bot.id, current.threadId)) return null;
      const parts = key === "production"
        ? [current.modelSelection, current.pendingModelSelection, lastUserInstruction(store.activePath(current.threadId))?.messageId]
        : [current.modelSelection];
      return { threadId: current.threadId, controlKey: JSON.stringify(parts), busy: false };
    },
    usage: vi.fn(), dispatch: vi.fn(async () => {}),
  });
  const prelude = readFileSync(new URL("./index.ts", import.meta.url), "utf8").split("store.onChange((change) => {")[1]!.split("  switch (change.type) {")[0]!;
  const onChange = new Function("change", "store", "limitWaits", "console", prelude);
  store.onChange((change) => onChange(change, store, waits, console));
  const steer = vi.fn(async () => true);
  const interruptTurn = vi.fn(async () => {});
  const noop = () => {};
  const routes = createBotChatRoutes({
    cfg: {}, threadSyncGate: { enabled: false }, store, registry: new Map([["claude", { adapter: { capabilities: { queueing: true }, steer, interruptTurn } }]]),
    wireBot: () => ({}), wireTask: () => ({}),
    sendSequencer: new SendSequencer(), startTurn: vi.fn(async () => ({})), noteTalked: noop, pullSyncedThread: noop, resolveReplyTarget: () => undefined,
    ensureChatLatency: noop, markChatLatency: noop, broadcast: noop, clearUnattended: noop, resumePaneWakes: noop,
    botHasActiveTurn: () => Boolean(store.bot(bot.id)?.busy), paneNoteTurnThreads: new Set(), busyResumeThreads: new Set(), drainQueuedSends: noop,
    routines: { activeRunForBot: () => null }, taskResumes: { forgetBot: noop }, closeOpenApprovals: noop,
    bumpTurnEpoch: () => 1, markThreadInterrupted: noop, flushInterruptedTask: noop, releaseInterruptedBot: noop,
    cancelUsageWait: (botId: string, id?: string, preserveTurn?: boolean) => waits.cancel(botId, id, preserveTurn),
  } as unknown as Parameters<typeof createBotChatRoutes>[0]);
  async function send(body: object) {
    let status = 0;
    let data: Record<string, unknown> = {};
    const res = { writeHead: (code: number) => { status = code; }, end: (raw: string) => { data = JSON.parse(raw); } } as unknown as ServerResponse;
    await routes.send(Readable.from([JSON.stringify(body)]) as IncomingMessage, res, ["", bot.id] as RegExpMatchArray);
    return { status, data };
  }
  return { bot, store, waits, selection, send, now, steer };
}

it.each([
  ["no steer (control)", "production", false],
  ["steer, production control key", "production", true],
  ["steer, selection-only control key", "selection-only", true],
] as const)("the live turn's usage limit still creates a wait: %s", async (_name, key, steered) => {
  const h = harness(key);
  h.waits.track(h.bot.id, h.bot.threadId, h.selection);
  h.waits.bind(h.bot.threadId, "turn-1");
  h.store.setActivity(h.bot.id, "working");
  if (steered) {
    const response = await h.send({ text: "also update the docs when you are done" });
    expect(response.data.steered).toBe(true);
    expect(h.steer).toHaveBeenCalledTimes(1);
  }
  h.waits.failed(h.bot.threadId, "turn-1", h.now + 3_600_000, "limit-message", ["five_hour", "seven_day"]);
  h.store.setActivity(h.bot.id, "idle");
  h.waits.settled(h.bot.threadId, "turn-1", false);
  expect(h.waits.store.all()).toHaveLength(1);
});
