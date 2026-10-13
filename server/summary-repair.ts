import type { ProviderInstance } from "./contracts.ts";
import {
  repairModelContext,
  repairTarget,
  type SummaryCallRecord,
  type SummaryCallResult,
} from "./context-compaction.ts";
import type { Store } from "./store.ts";
import type { ContextCompactionV1 } from "../shared/context-compaction.ts";

const MAX_REPAIR_RUNS = 3;
const REPAIR_BACKOFF_MS = [10 * 60_000, 60 * 60_000];
const MAX_REPAIR_BATCHES = 4;
const REPAIR_CALL_TIMEOUT_MS = 240_000;
const REPAIR_RUN_TIMEOUT_MS = 8 * 60_000;
const BREAKER_TIMEOUTS = 3;
const BREAKER_PAUSE_MS = 30 * 60_000;

type RepairInstance = Pick<ProviderInstance, "driverKind" | "generateText" | "textModel" | "textTimeoutMs">;

export interface SummaryCallContext {
  botId: string;
  threadId: string;
  phase: "compact" | "repair";
  engine: string;
  model: string | null;
  run: number;
  deadlineMs: number | null;
}

/** One line per summarizer attempt; never prompt, output or error text. */
export function logSummaryCall(context: SummaryCallContext, record: SummaryCallRecord): void {
  const line = `[summary] ${JSON.stringify({
    botId: context.botId,
    threadId: context.threadId,
    phase: context.phase,
    engine: context.engine,
    model: context.model,
    run: context.run,
    batch: record.batch,
    batches: record.batches,
    attempt: record.attempt,
    inTokens: record.inTokens,
    outBudget: record.outBudget,
    outTokens: record.outTokens,
    deadlineMs: context.deadlineMs,
    elapsedMs: record.elapsedMs,
    result: record.result,
  })}`;
  if (record.result === "ok") console.info(line);
  else console.warn(line);
}

export interface SummaryRepairDeps {
  store: Pick<Store, "activePath" | "messagesFor" | "appendCompaction">;
  instanceFor(botId: string, threadId: string): Promise<RepairInstance | null | undefined>;
  busy(botId: string, threadId: string): boolean;
  taskRecordText(threadId: string, contextWindow: number): string;
  userName(): string;
}

export interface SummaryRepair {
  /** Call when a 1:1 turn settles; a clean chain returns without a provider call. */
  onSettled(botId: string, threadId: string): void;
  /** Resolves once the queue is empty. */
  idle(): Promise<void>;
  dispose(): void;
}

interface ActiveRun {
  threadId: string;
  done: Promise<void>;
  controller?: AbortController;
}

function abortable<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise((resolve, reject) => {
    const onAbort = () => reject(new Error("summary repair aborted"));
    if (signal.aborted) return onAbort();
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(resolve, reject).finally(() => signal.removeEventListener("abort", onAbort));
  });
}

/** Rebuilds fallback summaries after a turn settles, one at a time app-wide. State is in memory only. */
export function createSummaryRepair(deps: SummaryRepairDeps): SummaryRepair {
  const budgets = new Map<string, { runs: number; nextAt: number }>();
  const held = new Map<string, { botId: string; targetId: string; compaction: ContextCompactionV1 }>();
  const queue: Array<{ botId: string; threadId: string }> = [];
  let active: ActiveRun | null = null;
  let timeouts = 0;
  let pausedUntil = 0;
  let disposed = false;

  const eligible = (targetId: string) => {
    const now = Date.now();
    const budget = budgets.get(targetId);
    return now >= pausedUntil && (!budget || (budget.runs < MAX_REPAIR_RUNS && now >= budget.nextAt));
  };

  const land = (threadId: string, botId: string, targetId: string, compaction: ContextCompactionV1): boolean => {
    if (deps.busy(botId, threadId)) {
      held.set(threadId, { botId, targetId, compaction });
      return true;
    }
    held.delete(threadId);
    if (repairTarget(deps.store.activePath(threadId))?.target.messageId !== targetId) return false;
    deps.store.appendCompaction(threadId, compaction);
    return true;
  };

  const run = async (botId: string, threadId: string) => {
    const instance = await deps.instanceFor(botId, threadId);
    if (disposed || !instance?.generateText) return;
    const messages = deps.store.activePath(threadId);
    const found = repairTarget(messages);
    if (!found || !eligible(found.target.messageId)) return;
    const targetId = found.target.messageId;
    const runNumber = (budgets.get(targetId)?.runs ?? 0) + 1;
    budgets.set(targetId, { runs: runNumber, nextAt: Number.POSITIVE_INFINITY });
    const controller = new AbortController();
    if (active) active.controller = controller;
    let wallClock = false;
    const timer = setTimeout(() => {
      wallClock = true;
      controller.abort();
    }, REPAIR_RUN_TIMEOUT_MS);
    const context: SummaryCallContext = {
      botId,
      threadId,
      phase: "repair",
      engine: instance.driverKind,
      model: instance.textModel ?? null,
      run: runNumber,
      deadlineMs: instance.textTimeoutMs === undefined ? null : REPAIR_CALL_TIMEOUT_MS,
    };
    const result = await repairModelContext({
      messages,
      target: found,
      taskRecordText: deps.taskRecordText(threadId, found.target.value.contextWindow),
      userName: deps.userName(),
      referenceMessages: deps.store.messagesFor(threadId),
      maxBatches: MAX_REPAIR_BATCHES,
      signal: controller.signal,
      summarize: (prompt) =>
        abortable(instance.generateText!(prompt, { timeoutMs: REPAIR_CALL_TIMEOUT_MS, signal: controller.signal }), controller.signal),
      onSummaryCall: (record) => logSummaryCall(context, record),
    }).finally(() => clearTimeout(timer));
    if (result.status === "too-large") {
      budgets.set(targetId, { runs: MAX_REPAIR_RUNS, nextAt: Number.POSITIVE_INFINITY });
      console.warn(`[summary-repair] skipped too-large ${JSON.stringify({ botId, threadId, batches: result.batches })}`);
      return;
    }
    const end = Date.now();
    budgets.set(targetId, {
      runs: runNumber,
      nextAt: runNumber < MAX_REPAIR_RUNS ? end + REPAIR_BACKOFF_MS[runNumber - 1]! : Number.POSITIVE_INFINITY,
    });
    const outcome: SummaryCallResult = result.status === "ready" ? "ok" : wallClock ? "timeout" : result.result;
    timeouts = outcome === "timeout" ? timeouts + 1 : 0;
    if (timeouts >= BREAKER_TIMEOUTS) {
      timeouts = 0;
      pausedUntil = end + BREAKER_PAUSE_MS;
    }
    if (result.status === "ready" && !disposed) land(threadId, botId, targetId, result.compaction);
  };

  const pump = () => {
    if (active || disposed) return;
    const next = queue.shift();
    if (!next) return;
    const current: ActiveRun = { threadId: next.threadId, done: Promise.resolve() };
    active = current;
    current.done = run(next.botId, next.threadId)
      .catch((error) => {
        console.warn(`[summary-repair] run failed (${error instanceof Error ? error.name : "error"})`);
      })
      .finally(() => {
        active = null;
        pump();
      });
  };

  return {
    onSettled(botId, threadId) {
      if (disposed) return;
      const pending = held.get(threadId);
      if (pending && land(threadId, pending.botId, pending.targetId, pending.compaction)) return;
      const found = repairTarget(deps.store.activePath(threadId));
      if (!found || !eligible(found.target.messageId)) return;
      if (active?.threadId === threadId || queue.some((item) => item.threadId === threadId)) return;
      queue.push({ botId, threadId });
      pump();
    },
    async idle() {
      while (active) await active.done;
    },
    dispose() {
      disposed = true;
      queue.length = 0;
      held.clear();
      active?.controller?.abort();
    },
  };
}
