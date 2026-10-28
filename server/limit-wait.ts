import { randomUUID } from "node:crypto";

import { sameModelSelection } from "../shared/model-selection.ts";
import type { ModelSelection } from "./contracts.ts";
import { LimitWaitStore, type LimitWait, type UsageWaitView } from "./limit-wait-store.ts";
import { wakeClock } from "./pc-wake.ts";
import type { RateLimitsReport } from "./rate-limits-store.ts";
import { TASK_RESUME_PROMPT } from "./turn-context.ts";

const MINUTE = 60_000;
const PROBES = [5, 15, 30, 60, 120, 240];
const MARGIN = 30_000;
type Current = { threadId: string; controlKey: string; busy: boolean };
type Tracked = { botId: string; threadId: string; selection: ModelSelection; controlKey: string; ownerDeviceId: string; origin: LimitWait["origin"]; waitId?: string; turnId?: string; failure?: { resetsAt: number | null; messageId: string; requiredWindows: string[] } };
type Deps = {
  file?: string; store?: LimitWaitStore; now?(): number; deviceId(): string;
  current(botId: string, instanceId?: string): Current | null;
  canRead?(selection: ModelSelection): boolean;
  usage(row: LimitWait): Promise<{ report?: RateLimitsReport; error?: string; retryAt: number }>;
  dispatch(row: LimitWait, prompt: string): Promise<void>;
  changed?(row: LimitWait, view: UsageWaitView): void;
  released?(row: LimitWait): void;
};

export class LimitWaits {
  readonly store: LimitWaitStore;
  private readonly deps: Deps;
  private readonly now: () => number;
  private readonly wake = wakeClock(10_000);
  private readonly turns = new Map<string, Tracked>();
  private readonly faulted = new Map<string, string>();
  private readonly lastDispatch = new Map<string, number>();
  private pulse?: Promise<void>;

  constructor(deps: Deps) {
    this.deps = deps;
    this.store = deps.store ?? new LimitWaitStore(deps.file);
    this.now = deps.now ?? Date.now;
  }

  track(botId: string, threadId: string, selection: ModelSelection, waitId?: string, origin: LimitWait["origin"] = {}): void {
    const current = this.deps.current(botId, selection.instanceId);
    if (current?.threadId === threadId) this.turns.set(threadId, { botId, threadId, selection: { ...selection }, controlKey: current.controlKey, ownerDeviceId: this.deps.deviceId(), waitId, origin });
  }

  bind(threadId: string, turnId?: string): void {
    const turn = this.turns.get(threadId);
    if (turn) turn.turnId = turnId;
  }

  messageId(threadId: string): string | undefined {
    const id = this.turns.get(threadId)?.waitId;
    return id ? this.store.get(id)?.messageId : undefined;
  }

  failed(threadId: string, turnId: string | undefined, resetsAt: number | null, messageId: string, requiredWindows: string[]): void {
    const turn = this.turns.get(threadId);
    if (turn && turn.turnId === turnId) turn.failure = { resetsAt, messageId, requiredWindows };
  }

  settled(threadId: string, turnId: string | undefined, ok: boolean): void {
    const turn = this.turns.get(threadId);
    if (!turn || turn.turnId !== turnId) return;
    this.turns.delete(threadId);
    const previous = turn.waitId ? this.store.get(turn.waitId) : undefined;
    if (!turn.failure || ok) {
      if (previous) this.save({ ...previous, state: "manual" }, ok);
      return;
    }
    const current = this.deps.current(turn.botId, turn.selection.instanceId);
    if (current?.threadId !== threadId || current.controlKey !== turn.controlKey || turn.ownerDeviceId !== this.deps.deviceId() || (turn.waitId && !previous)) return;
    const now = this.now();
    const reset = turn.failure.resetsAt;
    const row: LimitWait = { botId: turn.botId, threadId, selection: turn.selection, controlKey: turn.controlKey,
      ownerDeviceId: turn.ownerDeviceId, origin: turn.origin, ...turn.failure, turnId: turnId ?? "", id: previous?.id ?? randomUUID(),
      createdAt: previous?.createdAt ?? now, expiresAt: previous?.expiresAt ?? now + 8 * 24 * 60 * MINUTE,
      attempts: previous?.attempts ?? 0, probe: previous?.probe ?? 0, weekly: reset !== null && reset - now > 5 * 60 * MINUTE,
      state: (previous?.attempts ?? 0) >= 3 ? "manual" : "waiting",
      nextCheckAt: reset === null ? now + PROBES[0]! * MINUTE : reset + MARGIN,
    };
    this.save(row);
  }

  held(botId: string): boolean { return this.store.all().some((row) => row.botId === botId && !this.faulted.has(row.id) && (row.state === "waiting" || row.state === "dispatching")); }

  view(row: LimitWait): UsageWaitView {
    return { id: row.id, ownerDeviceId: row.ownerDeviceId, state: this.faulted.has(row.id) ? "manual" : row.state, weekly: row.weekly, resumesAt: row.resetsAt === null ? null : row.nextCheckAt };
  }

  cancel(botId: string, waitId?: string, preserveTurn = false): void {
    if (waitId && !this.store.all().some((row) => row.id === waitId && row.botId === botId && row.ownerDeviceId === this.deps.deviceId())) return;
    for (const [id, bot] of this.faulted) if (bot === botId && (!waitId || id === waitId)) this.faulted.delete(id);
    for (const [thread, turn] of this.turns) if (turn.botId === botId) {
      const current = preserveTurn ? this.deps.current(botId, turn.selection.instanceId) : null;
      if (current?.threadId === thread) { turn.controlKey = current.controlKey; turn.waitId = undefined; }
      else this.turns.delete(thread);
    }
    for (const row of this.store.all()) if (row.botId === botId && (!waitId || row.id === waitId) && row.ownerDeviceId === this.deps.deviceId()) {
      if (!this.save({ ...row, state: "manual" }, true)) throw new Error("Usage wait cancellation could not be saved");
    }
  }

  reconcile(): void {
    for (const row of this.store.all()) {
      if (row.ownerDeviceId !== this.deps.deviceId()) continue;
      if (!this.valid(row)) this.cancel(row.botId, row.id);
      else if (row.state === "waiting" && this.deps.canRead?.(row.selection) === false) this.save({ ...row, state: "manual" });
      else this.deps.changed?.(row, this.view(row));
    }
  }

  canDispatch(id: string, selection: ModelSelection): boolean {
    const row = this.store.get(id);
    if (!row || row.state !== "dispatching" || this.faulted.has(id)) return false;
    if (this.valid(row) && sameModelSelection(row.selection, selection)) return true;
    this.cancel(row.botId, id);
    return false;
  }

  dispatchFailed(id: string): void {
    const row = this.store.get(id);
    if (row?.state === "dispatching") { this.turns.delete(row.threadId); this.save({ ...row, state: "manual" }); }
  }

  tick(): Promise<void> {
    this.wake(this.now());
    if (!this.pulse) this.pulse = this.check().finally(() => { this.pulse = undefined; });
    return this.pulse;
  }

  private valid(row: LimitWait): boolean {
    const current = this.deps.current(row.botId, row.selection.instanceId);
    return row.ownerDeviceId === this.deps.deviceId() && current?.threadId === row.threadId && current.controlKey === row.controlKey && this.now() < row.expiresAt;
  }

  private save(row: LimitWait, remove = false): boolean {
    const held = this.held(row.botId);
    if (row.state === "waiting" && (row.nextCheckAt >= row.expiresAt || this.deps.canRead?.(row.selection) === false)) row = { ...row, state: "manual" };
    try { this.store.set(row, remove); this.faulted.delete(row.id); }
    catch (error) { this.faulted.set(row.id, row.botId); console.error("limit-waits: save failed", error); }
    this.deps.changed?.(row, { ...this.view(row), ...(remove ? { state: "finished" as const, cancelable: false } : {}) });
    if (held && !this.held(row.botId)) this.deps.released?.(row);
    return !this.faulted.has(row.id);
  }

  private async check(): Promise<void> {
    for (const row of this.store.all()) {
      if (row.ownerDeviceId !== this.deps.deviceId() || this.faulted.has(row.id)) continue;
      if (!this.valid(row)) { this.cancel(row.botId, row.id); continue; }
      if (row.state === "waiting" && this.deps.canRead?.(row.selection) === false) { this.save({ ...row, state: "manual" }); continue; }
      if (row.state !== "waiting" || this.now() < row.nextCheckAt || this.deps.current(row.botId)?.busy) continue;
      const started = Math.max(this.now(), (this.lastDispatch.get(row.selection.instanceId) ?? 0) + 1);
      const result = await this.deps.usage(row).catch(() => ({ retryAt: this.now() + MARGIN }));
      if (this.store.get(row.id) !== row || this.faulted.has(row.id) || !this.valid(row) || this.deps.current(row.botId, row.selection.instanceId)?.busy) continue;
      const report = "report" in result ? result.report : undefined;
      const windows = report?.windows.filter((window) => applicable(window.id, row.selection.model)) ?? [];
      const observed = Date.parse(report?.observedAt ?? "");
      const fresh = !("error" in result && result.error) && observed >= started && observed <= this.now()
        && windows.length > 0 && row.requiredWindows.filter((id) => applicable(id, row.selection.model)).every((id) => windows.some((window) => window.id === id))
        && windows.every((window) => Number.isFinite(window.usedPercent) && window.usedPercent >= 0);
      const spent = windows.filter((window) => window.usedPercent >= 100);
      const evidence = { ...row, requiredWindows: fresh ? [...new Set([...row.requiredWindows, ...windows.map((window) => window.id)])] : row.requiredWindows };
      if (fresh && spent.length === 0) {
        const claimed = { ...evidence, state: "dispatching" as const, attempts: row.attempts + 1 };
        if (!this.save(claimed) || !this.canDispatch(row.id, row.selection)) continue;
        this.lastDispatch.set(row.selection.instanceId, this.now());
        try { await this.deps.dispatch(claimed, TASK_RESUME_PROMPT); }
        catch { if (this.store.get(row.id) === claimed) this.save({ ...claimed, state: "manual" }); }
      } else if (fresh && spent.length && spent.every((window) => window.resetsAt !== null && window.resetsAt + MARGIN > this.now())) {
        const resetsAt = Math.max(...spent.map((window) => window.resetsAt!));
        this.save({ ...evidence, resetsAt, nextCheckAt: resetsAt + MARGIN, weekly: spent.some((window) => window.id.startsWith("seven_day") || (window.windowMinutes ?? 0) >= 10080) });
      } else if (!fresh && row.resetsAt !== null) {
        this.save({ ...row, nextCheckAt: Math.max(this.now() + MARGIN, result.retryAt) });
      } else {
        const probe = row.resetsAt === null ? row.probe + 1 : row.probe;
        const delay = probe === 0 ? PROBES[0]! : (PROBES[probe] ?? PROBES.at(-1)!) - PROBES[probe - 1]!;
        this.save({ ...row, resetsAt: null, probe, state: probe >= PROBES.length ? "manual" : "waiting", nextCheckAt: Math.max(this.now() + delay * MINUTE, result.retryAt) });
      }
    }
  }
}

function applicable(id: string, model: string): boolean {
  if (id === "seven_day_opus" && /sonnet|haiku/i.test(model)) return false;
  if (id === "seven_day_sonnet" && /opus|haiku/i.test(model)) return false;
  return true;
}
