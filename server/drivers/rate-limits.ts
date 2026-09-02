// Subscription usage windows, normalized from each CLI's own wire shape into
// RateLimitWindow. Parsers are total: a window with a missing or malformed
// fill level is dropped rather than thrown mid-stream, and a window is only
// ever built from a fill level the provider actually sent.
import type { RateLimitWindow } from "../contracts.ts";

const MINUTES_PER_DAY = 24 * 60;
const FIVE_HOURS = 5 * 60;
const SEVEN_DAYS = 7 * MINUTES_PER_DAY;

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null;
const finite = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value);
const round1 = (value: number) => Math.round(value * 10) / 10;

/** Both CLIs send epoch seconds. A value that already looks like
 * milliseconds is kept as-is so a future wire change cannot land a reset
 * in the year 57,000. */
export function epochMs(value: unknown): number | null {
  if (!finite(value) || value <= 0) return null;
  return Math.round(value < 1e11 ? value * 1000 : value);
}

/** Claude Code stream-json `rate_limit_event.rate_limit_info`. The per-window
 * `unifiedWindows` block carries both subscription windows at once; without
 * it the top-level fields describe one window, whichever the API named as
 * the binding claim. Overage is a billing state, not a window. */
export function claudeRateLimitWindows(info: unknown): RateLimitWindow[] {
  if (!isRecord(info)) return [];
  const out: RateLimitWindow[] = [];
  const unified = isRecord(info.unifiedWindows) ? info.unifiedWindows : null;
  if (unified) {
    for (const [id, windowMinutes] of [["five_hour", FIVE_HOURS], ["seven_day", SEVEN_DAYS]] as const) {
      const window = unified[id];
      if (!isRecord(window) || !finite(window.utilization)) continue;
      out.push({ id, usedPercent: round1(window.utilization * 100), resetsAt: epochMs(window.resetsAt), windowMinutes });
    }
  }
  if (out.length === 0 && typeof info.rateLimitType === "string" && info.rateLimitType !== "overage" && finite(info.utilization)) {
    const id = info.rateLimitType;
    const window: RateLimitWindow = { id, usedPercent: round1(info.utilization * 100), resetsAt: epochMs(info.resetsAt) };
    if (id === "five_hour") window.windowMinutes = FIVE_HOURS;
    else if (id.startsWith("seven_day")) window.windowMinutes = SEVEN_DAYS;
    out.push(window);
  }
  return out;
}

/** Codex app-server `account/rateLimits/updated` params.rateLimits: `primary`
 * is the short window and `secondary` the long one, each with usedPercent,
 * windowDurationMins, and resetsAt in epoch seconds. */
export function codexRateLimitWindows(snapshot: unknown): RateLimitWindow[] {
  if (!isRecord(snapshot)) return [];
  const out: RateLimitWindow[] = [];
  for (const slot of ["primary", "secondary"] as const) {
    const window = snapshot[slot];
    if (!isRecord(window) || !finite(window.usedPercent)) continue;
    const windowMinutes = finite(window.windowDurationMins) && window.windowDurationMins > 0 ? window.windowDurationMins : undefined;
    const id = windowMinutes === FIVE_HOURS ? "five_hour" : windowMinutes === SEVEN_DAYS ? "seven_day" : slot;
    const normalized: RateLimitWindow = { id, usedPercent: round1(window.usedPercent), resetsAt: epochMs(window.resetsAt) };
    if (windowMinutes) normalized.windowMinutes = windowMinutes;
    out.push(normalized);
  }
  return out;
}
