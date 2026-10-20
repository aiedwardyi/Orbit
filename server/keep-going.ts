import { mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { z } from "zod";

import { writeFileAtomic } from "./atomic.ts";
import { DATA_DIR } from "./config.ts";
import type { RateLimitsReport } from "./rate-limits-store.ts";
import type { TaskResumePacket } from "./task-state.ts";

export const KEEP_GOING_INTERVAL_MS = 30 * 60_000;
export const KEEP_GOING_DAILY_CAP = 12;
export const KEEP_GOING_USAGE_FRESH_MS = 2 * 60 * 60_000;
export const KEEP_GOING_MIN_LEFT_PERCENT = 20;
const BENCH_ZONE = "Asia/Seoul";
const BENCH_FROM = 3 * 60 + 45;
const BENCH_TO = 5 * 60;
const RECEIPTS_KEPT = 40;
export const KEEP_GOING_RULES =
  `Keep going is on. Don't end a turn while an approved step waits and nothing is running: start it. No question cards or "want me to" offers: decide on merit and report what you did. Ask only for logins, deletes, money, or push/merge/release rules.`;

export type KeepGoingSkip =
  | "off"
  | "not-owner"
  | "paused"
  | "wakes-paused"
  | "task-changed"
  | "busy"
  | "queued"
  | "bench"
  | "daily-cap"
  | "no-task-record"
  | "blockers"
  | "no-approved-step"
  | "usage-unknown"
  | "usage-stale"
  | "usage-low"
  | "panes-unknown"
  | "workers-running"
  | "dispatch-failed";

export type KeepGoingResult = { dispatched: string } | { skipped: KeepGoingSkip };
export type KeepGoingView = { paused: "no-progress" | "bot-paused" | "other-pc" | "task-changed" | "usage-unknown" | "usage-stale" | null } | null;

type StepStatus = TaskResumePacket["plan"][number]["status"];

const statusSchema = z.enum(["pending", "active", "done", "skipped"]);
const receiptSchema = z.object({
  at: z.number(),
  step: z.string(),
  outcome: z.enum(["pending", "progress", "no-progress", "failed"]),
  before: z.record(z.string(), statusSchema),
});
const entrySchema = z.object({
  on: z.boolean(),
  ownerDeviceId: z.string(),
  threadId: z.string(),
  revision: z.number().int().nonnegative(),
  steps: z.array(z.string()),
  approvedAt: z.number(),
  paused: z.enum(["no-progress", "bot-paused", "usage-unknown", "usage-stale"]).optional(),
  receipts: z.array(receiptSchema),
});
const fileSchema = z.object({ v: z.literal(1), bots: z.record(z.string(), entrySchema) });

type Entry = z.infer<typeof entrySchema>;
type Receipt = z.infer<typeof receiptSchema>;

export interface KeepGoingTurnOptions {
  threadId: string;
  cardContinuation: true;
  unattended: true;
  keepGoingWake: true;
}

export interface KeepGoingDeps {
  deviceId(): string;
  /** null when the bot is gone */
  botThreadId(botId: string): string | null;
  busy(botId: string, threadId: string): boolean;
  queuedSends(botId: string): boolean;
  wakesPaused(botId: string): boolean;
  packet(threadId: string): TaskResumePacket | null;
  usage(botId: string): Promise<RateLimitsReport | null>;
  /** Live worker panes; null when the terminal bridge could not say. */
  livePanes(botId: string): Promise<number | null>;
  dispatch(botId: string, prompt: string, options: KeepGoingTurnOptions): Promise<void>;
  /** The failure rule paused this bot. */
  paused(botId: string, threadId: string): void;
  changed(botId: string): void;
  log?(line: string): void;
  file?: string;
  now?(): number;
}

export function normalizeStep(step: string): string {
  return step.trim().replace(/\s+/g, " ").toLowerCase();
}

/** Same unattended mark a scheduled routine turn gets, without its detached-task record handling. */
export function keepGoingTurnOptions(threadId: string): KeepGoingTurnOptions {
  return { threadId, cardContinuation: true, unattended: true, keepGoingWake: true };
}

export function keepGoingPrompt(step: string): string {
  return `[Keep going] Nothing is running and the user approved this plan step: "${step}". Start it now, and only this step: mark it active, launch its worker if it needs one, then end the turn.`;
}

function seoulParts(now: number): Record<string, string> {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: BENCH_ZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(now);
  return Object.fromEntries(parts.map((part) => [part.type, part.value]));
}

export function inBenchWindow(now: number): boolean {
  const parts = seoulParts(now);
  const minutes = Number(parts.hour) * 60 + Number(parts.minute);
  return minutes >= BENCH_FROM && minutes < BENCH_TO;
}

const seoulDay = (now: number) => {
  const parts = seoulParts(now);
  return `${parts.year}-${parts.month}-${parts.day}`;
};

export function usageSkip(report: RateLimitsReport | null, now: number): KeepGoingSkip | null {
  if (!report || report.windows.length === 0) return "usage-unknown";
  const observed = Date.parse(report.observedAt);
  if (!Number.isFinite(observed) || now - observed > KEEP_GOING_USAGE_FRESH_MS) return "usage-stale";
  return report.windows.every((window) => 100 - window.usedPercent > KEEP_GOING_MIN_LEFT_PERCENT) ? null : "usage-low";
}

function approvedStatuses(packet: TaskResumePacket, steps: string[]): Map<string, StepStatus> {
  const approved = new Set(steps);
  const statuses = new Map<string, StepStatus>();
  for (const item of packet.plan) {
    const key = normalizeStep(item.step);
    if (approved.has(key) && !statuses.has(key)) statuses.set(key, item.status);
  }
  return statuses;
}

function moved(packet: TaskResumePacket | null, steps: string[], before: Receipt["before"]): boolean {
  if (!packet) return false;
  for (const [key, status] of approvedStatuses(packet, steps)) {
    if ((status === "active" || status === "done" || status === "skipped") && before[key] !== status) return true;
  }
  return false;
}

const isBusyRejection = (error: unknown) => (error as { code?: unknown } | null)?.code === "BOT_BUSY";

/** Per-bot switch: every 30 minutes, with no model call, starts one approved plan step when nothing runs. */
export class KeepGoing {
  private readonly deps: KeepGoingDeps;
  private readonly file: string;
  private readonly now: () => number;
  private bots: Record<string, Entry> = {};
  private readonly lastCheck = new Map<string, number>();
  private readonly checking = new Set<string>();
  /** Bot id to the thread of its current turn, only when the user typed it. */
  private readonly userTurns = new Map<string, string>();

  constructor(deps: KeepGoingDeps) {
    this.deps = deps;
    this.file = deps.file ?? join(DATA_DIR, "keep-going.json");
    this.now = deps.now ?? Date.now;
    try {
      const parsed = fileSchema.safeParse(JSON.parse(readFileSync(this.file, "utf8")));
      if (parsed.success) this.bots = parsed.data.bots;
    } catch {
      // missing or unreadable: every switch stays off
    }
  }

  /** The user's approval: only the plan's pending steps right now count. */
  enable(botId: string, threadId: string, packet: TaskResumePacket | null): void {
    const previous = this.bots[botId];
    const now = this.now();
    this.bots[botId] = {
      on: true,
      ownerDeviceId: this.deps.deviceId(),
      threadId,
      revision: (previous?.revision ?? 0) + 1,
      steps: [...new Set((packet?.plan ?? []).filter((item) => item.status === "pending").map((item) => normalizeStep(item.step)))],
      approvedAt: now,
      receipts: previous?.receipts ?? [],
    };
    this.lastCheck.set(botId, now);
    this.save();
  }

  /** Stops future dispatch only; running work and panes are left alone. */
  disable(botId: string): void {
    const entry = this.bots[botId];
    if (!entry) return;
    entry.on = false;
    entry.revision++;
    delete entry.paused;
    this.lastCheck.delete(botId);
    this.save();
  }

  /** Turn instructions while the switch is on and unpaused. */
  rules(botId: string): string {
    const view = this.view(botId);
    return view && !view.paused ? ` ${KEEP_GOING_RULES}` : "";
  }

  turnStarted(botId: string, threadId: string, byUser: boolean): void {
    if (byUser) this.userTurns.set(botId, threadId);
    else this.userTurns.delete(botId);
  }

  /** The set_keep_going tool: on is the user's approval, so only a turn they typed may give it. */
  fromTool(botId: string, threadId: string, on: boolean, packet: TaskResumePacket | null): { ok: true } | { error: string } {
    if (!on) this.disable(botId);
    else if (this.userTurns.get(botId) !== threadId) return { error: "only a turn the user started with their own message can turn keep going on" };
    else this.enable(botId, threadId, packet);
    return { ok: true };
  }

  pause(botId: string, reason: NonNullable<Entry["paused"]>): void {
    const entry = this.bots[botId];
    if (!entry?.on || entry.paused) return;
    entry.paused = reason;
    this.save();
    this.deps.changed(botId);
  }

  view(botId: string): KeepGoingView {
    const entry = this.bots[botId];
    if (!entry?.on) return null;
    return { paused: entry.paused ?? (entry.ownerDeviceId !== this.deps.deviceId() ? "other-pc" : this.deps.botThreadId(botId) !== entry.threadId ? "task-changed" : null) };
  }

  receipts(botId: string): Receipt[] {
    return structuredClone(this.bots[botId]?.receipts ?? []);
  }

  /** Called on the routines tick; each bot is checked once per interval, never in a burst after a restart. */
  tick(): void {
    const now = this.now();
    for (const [botId, entry] of Object.entries(this.bots)) {
      if (!entry.on) continue;
      const last = this.lastCheck.get(botId);
      if (last === undefined) {
        this.lastCheck.set(botId, now);
        continue;
      }
      if (now - last < KEEP_GOING_INTERVAL_MS || this.checking.has(botId)) continue;
      this.lastCheck.set(botId, now);
      void this.check(botId).catch((error) => {
        this.log(`keep going: ${botId} check failed: ${error instanceof Error ? error.message : String(error)}`);
      });
    }
  }

  async check(botId: string): Promise<KeepGoingResult> {
    this.checking.add(botId);
    try {
      return await this.evaluate(botId);
    } finally {
      this.checking.delete(botId);
    }
  }

  private async evaluate(botId: string): Promise<KeepGoingResult> {
    const first = this.gate(botId);
    if ("skipped" in first) return this.skip(botId, first.skipped);
    const revision = this.bots[botId]!.revision;
    const report = await this.deps.usage(botId);
    // off or re-approved while usage refreshed
    if (this.bots[botId]?.on !== true || this.bots[botId]!.revision !== revision) return this.skip(botId, "off");
    const ready = this.gate(botId);
    if ("skipped" in ready) return this.skip(botId, ready.skipped);
    const usage = usageSkip(report, this.now());
    if (usage) {
      if (usage === "usage-unknown" || usage === "usage-stale") this.pause(botId, usage);
      return this.skip(botId, usage);
    }
    const current = this.bots[botId]!;
    if (current.paused === "usage-unknown" || current.paused === "usage-stale") {
      delete current.paused;
      this.save();
      this.deps.changed(botId);
    }
    const panes = await this.deps.livePanes(botId).catch(() => null);
    // the switch may have gone off, or been re-approved, while the bridge answered
    if (this.bots[botId]?.on !== true || this.bots[botId]!.revision !== revision) return this.skip(botId, "off");
    if (panes === null) return this.skip(botId, "panes-unknown");
    if (this.settle(botId, panes)) return this.skip(botId, "paused");
    if (panes > 0) return this.skip(botId, "workers-running");
    const gate = this.gate(botId);
    if ("skipped" in gate) return this.skip(botId, gate.skipped);
    const entry = this.bots[botId]!;
    const receipt: Receipt = { at: this.now(), step: gate.step, outcome: "pending", before: gate.before };
    entry.receipts = [...entry.receipts, receipt].slice(-RECEIPTS_KEPT);
    this.save();
    try {
      await this.deps.dispatch(botId, keepGoingPrompt(gate.step), keepGoingTurnOptions(entry.threadId));
    } catch (error) {
      if (isBusyRejection(error)) {
        entry.receipts = entry.receipts.filter((item) => item !== receipt);
        this.save();
        return this.skip(botId, "busy");
      }
      receipt.outcome = "failed";
      this.save();
      this.log(`keep going: ${botId} dispatch failed: ${error instanceof Error ? error.message : String(error)}`);
      return { skipped: "dispatch-failed" };
    }
    this.log(`keep going: ${botId} started "${gate.step}"`);
    return { dispatched: gate.step };
  }

  private gate(botId: string): { skipped: KeepGoingSkip } | { step: string; before: Receipt["before"] } {
    const entry = this.bots[botId];
    if (!entry?.on) return { skipped: "off" };
    if (entry.ownerDeviceId !== this.deps.deviceId()) return { skipped: "not-owner" };
    // a usage pause clears itself once usage reads fresh again
    if (entry.paused && entry.paused !== "usage-unknown" && entry.paused !== "usage-stale") return { skipped: "paused" };
    if (this.deps.wakesPaused(botId)) return { skipped: "wakes-paused" };
    const threadId = this.deps.botThreadId(botId);
    if (threadId !== entry.threadId) return { skipped: "task-changed" };
    if (this.deps.busy(botId, threadId)) return { skipped: "busy" };
    if (this.deps.queuedSends(botId)) return { skipped: "queued" };
    const now = this.now();
    if (inBenchWindow(now)) return { skipped: "bench" };
    const today = seoulDay(now);
    if (entry.receipts.filter((receipt) => seoulDay(receipt.at) === today).length >= KEEP_GOING_DAILY_CAP) {
      return { skipped: "daily-cap" };
    }
    const packet = this.deps.packet(threadId);
    if (!packet) return { skipped: "no-task-record" };
    if (packet.blockers.length > 0) return { skipped: "blockers" };
    const approved = new Set(entry.steps);
    const next = packet.plan.find((item) => item.status === "pending" && approved.has(normalizeStep(item.step)));
    if (!next) return { skipped: "no-approved-step" };
    return { step: next.step, before: Object.fromEntries(approvedStatuses(packet, entry.steps)) };
  }

  /** Grades the last dispatch; two in a row without progress pause the switch. */
  private settle(botId: string, panes: number): boolean {
    const entry = this.bots[botId]!;
    if (entry.paused) return true;
    const last = entry.receipts.at(-1);
    if (last?.outcome === "pending") {
      if (this.deps.busy(botId, entry.threadId)) return false;
      last.outcome = panes > 0 || moved(this.deps.packet(entry.threadId), entry.steps, last.before) ? "progress" : "no-progress";
      this.save();
    }
    const recent = entry.receipts.filter((receipt) => receipt.at >= entry.approvedAt).slice(-2);
    if (recent.length < 2 || !recent.every((receipt) => receipt.outcome === "no-progress" || receipt.outcome === "failed")) return false;
    entry.paused = "no-progress";
    this.save();
    this.log(`keep going: ${botId} paused after two dispatches without progress`);
    this.deps.paused(botId, entry.threadId);
    this.deps.changed(botId);
    return true;
  }

  private skip(botId: string, reason: KeepGoingSkip): KeepGoingResult {
    this.log(`keep going: ${botId} skipped (${reason})`);
    return { skipped: reason };
  }

  private log(line: string): void {
    (this.deps.log ?? console.info)(line);
  }

  private save(): void {
    try {
      mkdirSync(dirname(this.file), { recursive: true });
      writeFileAtomic(this.file, `${JSON.stringify({ v: 1, bots: this.bots }, null, 2)}\n`, { mode: 0o600 });
    } catch (error) {
      console.error("keep going: save failed", error);
    }
  }
}
