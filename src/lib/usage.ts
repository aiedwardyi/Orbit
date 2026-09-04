// Turning banked token/cost figures into something a header chip can show.
// Pure, so the numbers can be tested without the components.
import type { RateLimitWindow } from "../../server/contracts.ts";
import type { MessageKey } from "./i18n-catalog";
import type { Bot, TaskUsage } from "@/state/store";

export const EMPTY_USAGE: TaskUsage = { input: 0, output: 0, costUsd: null, turns: 0 };

/** True when a stored cost is a real number (not null, NaN, or Infinity). */
export function hasFiniteCost(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

/** Sum a set of usages; cost stays null until any of them has one. */
export function sumUsage(items: Array<TaskUsage | undefined>): TaskUsage {
  const out: TaskUsage = { ...EMPTY_USAGE };
  for (const u of items) {
    if (!u) continue;
    out.input += u.input;
    out.output += u.output;
    out.turns += u.turns;
    if (hasFiniteCost(u.cachedInput)) out.cachedInput = (out.cachedInput ?? 0) + u.cachedInput;
    if (hasFiniteCost(u.costUsd)) out.costUsd = (out.costUsd ?? 0) + u.costUsd;
  }
  return out;
}

export function botUsage(bot: Pick<Bot, "tasks">): TaskUsage {
  return sumUsage((bot.tasks ?? []).map((t) => t.usage));
}

/** 950 → "950", 12_400 → "12.4k", 2_300_000 → "2.3M" */
export function formatTokens(n: number): string {
  if (!hasFiniteCost(n)) return "0";
  if (n < 1000) return String(n);
  if (n < 1_000_000) return `${trim(n / 1000)}k`;
  return `${trim(n / 1_000_000)}M`;
}
const trim = (x: number) => (x >= 100 ? Math.round(x).toString() : x.toFixed(1).replace(/\.0$/, ""));

/** Dollars, with enough precision that a cheap turn isn't "$0.00". */
export function formatUsd(usd: number): string {
  if (!hasFiniteCost(usd)) return "";
  if (usd === 0) return "$0";
  if (usd < 0.01) return `$${usd.toFixed(3)}`;
  return `$${usd.toFixed(2)}`;
}

/** How much of `input` the provider served from its prompt cache. Clamped to
 * `input` so a provider that reports cache reads outside its input figure
 * can never produce a negative "fresh" number. */
export function cachedInput(u: TaskUsage): number {
  return hasFiniteCost(u.cachedInput) ? Math.min(Math.max(0, u.cachedInput), u.input) : 0;
}

/** The in/out breakdown behind the headline figure, with the cached share
 * called out when there is one: "88.2k in (79k cached) · 1.2k out". The
 * headline counts every token the model processed — five short messages
 * on a thread with a system prompt and tool schemas really do cost the
 * model ~17k tokens of reading each turn — so the breakdown is where the
 * "was that really 100k?" question gets answered. */
export function usageDetail(u: TaskUsage): string {
  const cached = cachedInput(u);
  const input = cached > 0 ? `${formatTokens(u.input)} in (${formatTokens(cached)} cached)` : `${formatTokens(u.input)} in`;
  return `${input} · ${formatTokens(u.output)} out`;
}

/** The chip text: tokens, and cost when known. Empty string when nothing
 * has been spent — a fresh task shows no chip. */
export function usageChip(u: TaskUsage): string {
  if (u.turns === 0 && u.input + u.output === 0) return "";
  const parts = [`${formatTokens(u.input + u.output)} tok`];
  if (hasFiniteCost(u.costUsd)) parts.push(formatUsd(u.costUsd));
  return parts.join(" · ");
}

/** How to caption a cost figure given how the engine is billed. */
export function costCaption(billing: "metered" | "subscription" | undefined): string {
  if (billing === "subscription") return "equivalent — on your subscription, not billed";
  if (billing === "metered") return "billed to your API key";
  return "as reported by the engine";
}

export type WindowKind = "session" | "weekly" | "other";

/** Which window a person plans around: the 5-hour session or the week.
 * Known ids win; an unnamed window is classed by its length. */
export function windowKind(id: string, windowMinutes?: number): WindowKind {
  if (id === "five_hour") return "session";
  if (id.startsWith("seven_day")) return "weekly";
  if (hasFiniteCost(windowMinutes)) {
    if (windowMinutes <= 6 * 60) return "session";
    if (windowMinutes >= 6 * 24 * 60) return "weekly";
  }
  return "other";
}

/** Whole percent for display, null when the figure is unusable. Not capped:
 * an account in overage really is past 100. */
export function percentUsed(usedPercent: unknown): number | null {
  return hasFiniteCost(usedPercent) ? Math.max(0, Math.round(usedPercent)) : null;
}

/** True when the provider gave a reset time and it has passed: the fill
 * level was read before the reset, so it no longer describes the window. */
export function windowExpired(resetsAt: number | null | undefined, now = Date.now()): boolean {
  return hasFiniteCost(resetsAt) && resetsAt <= now;
}

/** Used percent for display. A passed reset makes the last fill history. */
export function windowFillPercent(
  window: { usedPercent: unknown; resetsAt?: number | null },
  now = Date.now(),
): number | null {
  return windowExpired(window.resetsAt, now) ? null : percentUsed(window.usedPercent);
}

export interface ResetCountdown {
  unit: "days" | "hours" | "minutes";
  value: number;
}

/** Time left before a window resets, coarsened to what a person plans
 * around: whole days when about a day or more is left, otherwise hours,
 * otherwise minutes, never below 1. null when the reset time is unknown or
 * has already passed. */
export function resetCountdown(resetsAt: number | null | undefined, now = Date.now()): ResetCountdown | null {
  if (!hasFiniteCost(resetsAt) || resetsAt <= now) return null;
  const minutes = Math.ceil((resetsAt - now) / 60_000);
  if (minutes < 60) return { unit: "minutes", value: Math.max(1, minutes) };
  const hours = Math.round(minutes / 60);
  if (hours < 24) return { unit: "hours", value: Math.max(1, hours) };
  return { unit: "days", value: Math.max(1, Math.round(hours / 24)) };
}

/** The complete phrase for a window's reset: a countdown, "not reported",
 * or "already reset". Singular and plural are separate phrases rather than
 * a glued "s", so the Korean word order survives. */
export function resetPhrase(
  resetsAt: number | null | undefined,
  now = Date.now(),
): { key: MessageKey; vars?: Record<string, number> } {
  if (!hasFiniteCost(resetsAt)) return { key: "usage.limits.resetUnknown" };
  const countdown = resetCountdown(resetsAt, now);
  if (!countdown) return { key: "usage.limits.resetPassed" };
  const one = countdown.value === 1;
  switch (countdown.unit) {
    case "days":
      return one ? { key: "usage.limits.resetsInOneDay" } : { key: "usage.limits.resetsInDays", vars: { days: countdown.value } };
    case "hours":
      return one ? { key: "usage.limits.resetsInOneHour" } : { key: "usage.limits.resetsInHours", vars: { hours: countdown.value } };
    default:
      return one
        ? { key: "usage.limits.resetsInOneMinute" }
        : { key: "usage.limits.resetsInMinutes", vars: { minutes: countdown.value } };
  }
}

export type CompactReset =
  | { key: "usage.limits.compactDh"; vars: { days: number; hours: number } }
  | { key: "usage.limits.compactD"; vars: { days: number } }
  | { key: "usage.limits.compactHm"; vars: { hours: number; minutes: number } }
  | { key: "usage.limits.compactH"; vars: { hours: number } }
  | { key: "usage.limits.compactM"; vars: { minutes: number } };

/** Remaining time as `1h55m` / `2d5h` — the under-chat strip, not a sentence. */
export function resetCompact(
  resetsAt: number | null | undefined,
  now = Date.now(),
): CompactReset | null {
  if (!hasFiniteCost(resetsAt) || resetsAt <= now) return null;
  const totalMinutes = Math.max(1, Math.ceil((resetsAt - now) / 60_000));
  const days = Math.floor(totalMinutes / (24 * 60));
  const hours = Math.floor((totalMinutes % (24 * 60)) / 60);
  const minutes = totalMinutes % 60;
  if (days > 0) {
    return hours > 0
      ? { key: "usage.limits.compactDh", vars: { days, hours } }
      : { key: "usage.limits.compactD", vars: { days } };
  }
  if (hours > 0) {
    return minutes > 0
      ? { key: "usage.limits.compactHm", vars: { hours, minutes } }
      : { key: "usage.limits.compactH", vars: { hours } };
  }
  return { key: "usage.limits.compactM", vars: { minutes } };
}

/** The 5-hour and weekly windows a chat strip can show. Stale fills drop
 * out — Settings still lists those rows with an empty bar. */
export function planMeterWindows(
  windows: RateLimitWindow[] | undefined,
  now = Date.now(),
): RateLimitWindow[] {
  if (!windows?.length) return [];
  const live = windows.filter((window) => !windowExpired(window.resetsAt, now));
  const pick = (kind: WindowKind, preferredId?: string) =>
    (preferredId ? live.find((window) => window.id === preferredId) : undefined) ??
    live.find((window) => windowKind(window.id, window.windowMinutes) === kind);
  return [pick("session", "five_hour"), pick("weekly", "seven_day")].filter(
    (window): window is RateLimitWindow => window !== undefined,
  );
}
