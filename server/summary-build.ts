import { applicableCompaction, buildCompaction, planCompaction, repairTarget } from "./context-compaction.ts";
import type { ProviderInstance } from "./contracts.ts";
import type { Message, Store } from "./store.ts";
import { abortable, logSummaryCall, type SummaryCallContext } from "./summary-repair.ts";
import type { ContextCompactionV1 } from "../shared/context-compaction.ts";

const MAX_BUILD_RUNS = 2;
const BUILD_RETRY_MS = 10 * 60_000;
const BUILD_CALL_TIMEOUT_MS = 240_000;
const BUILD_RUN_TIMEOUT_MS = 8 * 60_000;

type BuildInstance = Pick<ProviderInstance, "driverKind" | "generateText" | "textModel" | "textTimeoutMs">;

/** What the next send would hand prepareModelContext for this path. */
export interface SendInputs {
  instance: BuildInstance;
  contextWindow: number;
  taskRecordText: string;
  excludeIds?: ReadonlySet<string>;
  reserveTokens?: number;
}

export interface SummaryBuildDeps {
  store: Pick<Store, "activePath" | "activeLeaf" | "messagesFor" | "appendCompaction">;
  sendInputs(botId: string, threadId: string, messages: Message[]): Promise<SendInputs | null | undefined>;
  busy(botId: string, threadId: string): boolean;
  userName(): string;
}

export interface SummaryBuild {
  /** Call when a 1:1 turn settles; a path under budget returns without a provider call. */
  onSettled(botId: string, threadId: string): void;
  inflight(threadId: string): boolean;
  /** Waits up to capMs for this thread's build and lands it, or drops it when the send's engine would not summarize with it; resolves to the ms waited, which comes out of the send's own summary deadline. */
  settle(
    threadId: string,
    instance: Pick<ProviderInstance, "generateText" | "textTimeoutMs">,
    capMs: number,
    summarizes: () => boolean,
  ): Promise<number>;
  /** Resolves once the queue is empty. */
  idle(): Promise<void>;
  dispose(): void;
}

interface Built {
  botId: string;
  threadId: string;
  leafId: string;
  leafIndex: number;
  previousId: string | null;
  compaction: ContextCompactionV1;
}

interface ActiveRun {
  threadId: string;
  done: Promise<void>;
  controller: AbortController;
}

/** The send's inline summarizer after waiting on a build: the wait comes out of the engine's deadline, and none left means today's deterministic fallback with no call. */
export function inlineSummarizer(
  instance: Pick<ProviderInstance, "generateText" | "textTimeoutMs">,
  waitedMs: number,
): ((prompt: string) => Promise<string>) | undefined {
  if (!instance.generateText) return undefined;
  if (waitedMs <= 0) return (prompt) => instance.generateText!(prompt);
  const remaining = (instance.textTimeoutMs ?? 0) - waitedMs;
  if (remaining <= 0) return undefined;
  return (prompt) => instance.generateText!(prompt, { timeoutMs: remaining });
}

/** Builds the next send's summary after a turn settles, one at a time app-wide, in memory only. */
export function createSummaryBuild(deps: SummaryBuildDeps): SummaryBuild {
  const budgets = new Map<string, { runs: number; nextAt: number }>();
  const held = new Map<string, Built>();
  const queue: Array<{ botId: string; threadId: string }> = [];
  const retries = new Set<ReturnType<typeof setTimeout>>();
  let active: ActiveRun | null = null;
  let disposed = false;

  const eligible = (leafId: string | null) => {
    if (!leafId) return false;
    const budget = budgets.get(leafId);
    return !budget || (budget.runs < MAX_BUILD_RUNS && Date.now() >= budget.nextAt);
  };

  const drop = (built: Built, reason: string) => {
    console.info(`[summary-build] dropped ${JSON.stringify({ botId: built.botId, threadId: built.threadId, reason })}`);
  };

  // A waiting send has already appended its own row past the leaf, so it checks the leaf by position; an idle landing wants it unmoved.
  const place = (built: Built, unmoved: boolean): boolean => {
    const path = deps.store.activePath(built.threadId);
    const leafHolds = unmoved ? deps.store.activeLeaf(built.threadId) === built.leafId : path[built.leafIndex]?.id === built.leafId;
    if (!leafHolds) {
      drop(built, "leaf-moved");
      return false;
    }
    if ((applicableCompaction(path)?.messageId ?? null) !== built.previousId) {
      drop(built, "compaction-changed");
      return false;
    }
    deps.store.appendCompaction(built.threadId, built.compaction);
    return true;
  };

  const land = (built: Built): boolean => {
    if (deps.busy(built.botId, built.threadId)) {
      held.set(built.threadId, built);
      return true;
    }
    held.delete(built.threadId);
    return place(built, true);
  };

  const retryLater = (botId: string, threadId: string) => {
    const timer = setTimeout(() => {
      retries.delete(timer);
      onSettled(botId, threadId);
    }, BUILD_RETRY_MS);
    timer.unref?.();
    retries.add(timer);
  };

  const run = async (botId: string, threadId: string, controller: AbortController) => {
    // A send that claimed the bot meanwhile prepares inline; its row is already past the leaf.
    if (deps.busy(botId, threadId)) return;
    const messages = deps.store.activePath(threadId);
    const leafId = deps.store.activeLeaf(threadId);
    // a build would chain from the fallback and void its repair
    if (!leafId || !eligible(leafId) || repairTarget(messages)) return;
    const inputs = await deps.sendInputs(botId, threadId, messages);
    if (disposed || controller.signal.aborted || !inputs?.instance.generateText) return;
    const { instance } = inputs;
    const plan = planCompaction({
      messages,
      contextWindow: inputs.contextWindow,
      excludeIds: inputs.excludeIds,
      reserveTokens: inputs.reserveTokens,
      userName: deps.userName(),
      referenceMessages: deps.store.messagesFor(threadId),
    });
    if (!plan.needed) return;
    const runNumber = (budgets.get(leafId)?.runs ?? 0) + 1;
    budgets.set(leafId, { runs: runNumber, nextAt: Number.POSITIVE_INFINITY });
    const timer = setTimeout(() => controller.abort(), BUILD_RUN_TIMEOUT_MS);
    const context: SummaryCallContext = {
      botId,
      threadId,
      phase: "build",
      engine: instance.driverKind,
      model: instance.textModel ?? null,
      run: runNumber,
      deadlineMs: instance.textTimeoutMs === undefined ? null : BUILD_CALL_TIMEOUT_MS,
    };
    const result = await buildCompaction({
      plan,
      messages,
      taskRecordText: inputs.taskRecordText,
      signal: controller.signal,
      summarize: (prompt) =>
        abortable(instance.generateText!(prompt, { timeoutMs: BUILD_CALL_TIMEOUT_MS, signal: controller.signal }), controller.signal),
      onSummaryCall: (record) => logSummaryCall(context, record),
    }).finally(() => clearTimeout(timer));
    if (disposed) return;
    if (result.status === "ready") {
      land({ botId, threadId, leafId, leafIndex: messages.length - 1, previousId: plan.previous?.messageId ?? null, compaction: result.compaction });
      return;
    }
    if (runNumber >= MAX_BUILD_RUNS) return;
    budgets.set(leafId, { runs: runNumber, nextAt: Date.now() + BUILD_RETRY_MS });
    retryLater(botId, threadId);
  };

  const pump = () => {
    if (active || disposed) return;
    const next = queue.shift();
    if (!next) return;
    const current: ActiveRun = { threadId: next.threadId, done: Promise.resolve(), controller: new AbortController() };
    active = current;
    current.done = run(next.botId, next.threadId, current.controller)
      .catch((error) => {
        console.warn(`[summary-build] run failed (${error instanceof Error ? error.name : "error"})`);
      })
      .finally(() => {
        active = null;
        pump();
      });
  };

  const onSettled = (botId: string, threadId: string) => {
    if (disposed) return;
    const pending = held.get(threadId);
    if (pending && land(pending)) return;
    if (active?.threadId === threadId || queue.some((item) => item.threadId === threadId)) return;
    if (!eligible(deps.store.activeLeaf(threadId))) return;
    queue.push({ botId, threadId });
    pump();
  };

  return {
    onSettled,
    inflight: (threadId) => active?.threadId === threadId || queue.some((item) => item.threadId === threadId),
    async settle(threadId, instance, capMs, summarizes) {
      const queued = queue.findIndex((item) => item.threadId === threadId);
      if (queued >= 0) queue.splice(queued, 1);
      const current = active?.threadId === threadId ? active : null;
      if (!current && !held.has(threadId)) return 0;
      if (!instance.generateText || instance.textTimeoutMs === undefined || !summarizes()) {
        current?.controller.abort();
        held.delete(threadId);
        return 0;
      }
      let waited = 0;
      if (current) {
        const started = Date.now();
        const cap = setTimeout(() => current.controller.abort(), capMs);
        await current.done.finally(() => clearTimeout(cap));
        waited = Date.now() - started;
      }
      const built = held.get(threadId);
      if (built) {
        held.delete(threadId);
        place(built, false);
      }
      return waited;
    },
    async idle() {
      while (active) await active.done;
    },
    dispose() {
      disposed = true;
      queue.length = 0;
      held.clear();
      for (const timer of retries) clearTimeout(timer);
      retries.clear();
      active?.controller.abort();
    },
  };
}
