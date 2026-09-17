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
/** One decimal for display — but never rounded up across 100, because the
 * same number decides whether a window is spent and 99.96% still has room. */
const round1 = (value: number) => {
  const rounded = Math.round(value * 10) / 10;
  return rounded >= 100 && value < 100 ? 99.9 : rounded;
};

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

/** Grok Build ACP `x.ai/billing` / CLI `/usage`: one weekly included pool.
 * `creditUsagePercent` is already used 0-100. There is no 5-hour window. */
export function grokRateLimitWindows(payload: unknown): RateLimitWindow[] {
  if (!isRecord(payload) || !isRecord(payload.config)) return [];
  const config = payload.config;
  if (!finite(config.creditUsagePercent)) return [];
  const period = isRecord(config.currentPeriod) ? config.currentPeriod : null;
  if (!period || !String(period.type ?? "").includes("WEEKLY")) return [];
  const end = Date.parse(String(period.end ?? ""));
  return [
    {
      id: "seven_day",
      usedPercent: round1(config.creditUsagePercent),
      resetsAt: Number.isNaN(end) ? null : end,
      windowMinutes: SEVEN_DAYS,
    },
  ];
}

/** Antigravity quota buckets into subscription windows. Three wire shapes,
 * one account: the statusline JSON dict (`gemini-5h` / `gemini-weekly` with
 * `remaining_fraction` + `reset_in_seconds`), RetrieveUserQuotaSummary
 * `groups[].buckets[]` (the same RPC behind agy's own `/usage`), and the
 * legacy GetUserStatus model configs. A bucket is matched by the window
 * length named in its id or display name; anything without a fill level is
 * dropped. Both pools (Gemini, Claude + GPT) report the same two windows,
 * so each id keeps the most constrained pool — the binding constraint. */
export function antigravityRateLimitWindows(payload: unknown, now = Date.now()): RateLimitWindow[] {
  // Some transports wrap the message in a `response` envelope (seen live on
  // the quota-summary path). Unwrap only a real quota envelope — groups or
  // userStatus inside — because a bare payload can carry its own
  // record-valued `response` field, and replacing the payload with it would
  // discard valid sibling quota data.
  const envelope = isRecord(payload) ? payload.response : undefined;
  const body =
    isRecord(envelope) && (Array.isArray(envelope.groups) || isRecord(envelope.userStatus)) ? envelope : payload;
  const classify = (name: string): { id: string; windowMinutes: number } | null => {
    const text = name.toLowerCase();
    if (/weekly|7\s*d|seven[\s_-]?day/.test(text)) return { id: "seven_day", windowMinutes: SEVEN_DAYS };
    if (/5\s*h|five[\s_-]?hour|session/.test(text)) return { id: "five_hour", windowMinutes: FIVE_HOURS };
    if (/daily|24\s*h/.test(text)) return { id: "daily", windowMinutes: MINUTES_PER_DAY };
    return null;
  };
  const resetFromUnknown = (value: unknown): number | null => {
    if (typeof value === "string") {
      const parsed = Date.parse(value);
      return Number.isNaN(parsed) ? null : parsed;
    }
    return epochMs(value);
  };
  type Candidate = { name: string; fraction: unknown; resetMs: number | null };
  const candidates: Candidate[] = [];
  if (isRecord(body)) {
    for (const [bucket, entry] of Object.entries(body)) {
      if (bucket === "groups" || bucket === "userStatus") continue;
      if (!isRecord(entry)) continue;
      const seconds = entry.reset_in_seconds ?? entry.resetInSeconds;
      candidates.push({
        name: bucket,
        fraction: entry.remaining_fraction ?? entry.remainingFraction,
        resetMs:
          finite(seconds) && seconds > 0
            ? Math.round(now + seconds * 1000)
            : entry.resetTime === undefined
              ? null
              : resetFromUnknown(entry.resetTime),
      });
    }
    if (Array.isArray(body.groups)) {
      for (const group of body.groups) {
        if (!isRecord(group) || !Array.isArray(group.buckets)) continue;
        for (const bucket of group.buckets) {
          if (!isRecord(bucket)) continue;
          const remaining = isRecord(bucket.remaining) ? bucket.remaining : null;
          candidates.push({
            name: `${String(bucket.bucketId ?? "")} ${String(bucket.displayName ?? "")}`,
            fraction: remaining?.remainingFraction ?? bucket.remainingFraction ?? bucket.remaining_fraction,
            resetMs: resetFromUnknown(bucket.resetTime ?? bucket.resetsAt ?? bucket.reset_at),
          });
        }
      }
    }
    const userStatus = isRecord(body.userStatus) ? body.userStatus : null;
    const cascade = userStatus && isRecord(userStatus.cascadeModelConfigData) ? userStatus.cascadeModelConfigData : null;
    const configs = cascade && Array.isArray(cascade.clientModelConfigs) ? cascade.clientModelConfigs : [];
    for (const config of configs) {
      if (!isRecord(config)) continue;
      const info = isRecord(config.quotaInfo) ? config.quotaInfo : null;
      candidates.push({
        name: `${String(config.quotaWindow ?? "")} ${String(config.displayName ?? "")} ${String(config.model ?? "")}`,
        fraction: info?.remainingFraction ?? info?.remaining_fraction,
        resetMs: resetFromUnknown(info?.resetTime ?? info?.resetsAt),
      });
    }
  }
  const best = new Map<string, RateLimitWindow>();
  for (const candidate of candidates) {
    const kind = classify(candidate.name);
    if (!kind) continue;
    if (typeof candidate.fraction !== "number" || !Number.isFinite(candidate.fraction)) continue;
    if (candidate.fraction < 0 || candidate.fraction > 1) continue;
    const usedPercent = round1((1 - candidate.fraction) * 100);
    const current = best.get(kind.id);
    if (!current || usedPercent > current.usedPercent) {
      best.set(kind.id, { id: kind.id, usedPercent, resetsAt: candidate.resetMs, windowMinutes: kind.windowMinutes });
    }
  }
  const out: RateLimitWindow[] = [];
  for (const id of ["five_hour", "seven_day", "daily"] as const) {
    const window = best.get(id);
    if (window) out.push(window);
  }
  return out;
}

type MuseUsageReport = { windows: RateLimitWindow[]; observedAt: string };

const safeInteger = (value: unknown): value is number => Number.isSafeInteger(value);

/** Stable MSP `usage/read` result or `usage/changed` params. */
export function museUsageReport(payload: unknown): MuseUsageReport | null {
  if (!isRecord(payload)) return null;
  const usage = isRecord(payload.usage) ? payload.usage : payload;
  const window = isRecord(usage.window) ? usage.window : null;
  const weekly = isRecord(usage.weekly) ? usage.weekly : null;
  if (!window || !weekly || typeof usage.tier !== "string") return null;
  if (!safeInteger(usage.observedAtMs) || usage.observedAtMs <= 0) return null;
  if (!safeInteger(window.usedPercent) || window.usedPercent < 0) return null;
  if (!safeInteger(window.windowDurationMins) || window.windowDurationMins <= 0) return null;
  if (!safeInteger(window.resetsAtMs) || window.resetsAtMs <= 0) return null;
  if (!safeInteger(weekly.usedPercent) || weekly.usedPercent < 0) return null;
  if (!safeInteger(weekly.resetsAtMs) || weekly.resetsAtMs <= 0) return null;
  const observedAt = new Date(usage.observedAtMs);
  if (!Number.isFinite(observedAt.getTime())) return null;
  return {
    observedAt: observedAt.toISOString(),
    windows: [
      {
        id: "five_hour",
        usedPercent: window.usedPercent,
        resetsAt: window.resetsAtMs,
        windowMinutes: window.windowDurationMins,
      },
      {
        id: "seven_day",
        usedPercent: weekly.usedPercent,
        resetsAt: weekly.resetsAtMs,
        windowMinutes: SEVEN_DAYS,
      },
    ],
  };
}

export function museRateLimitWindows(payload: unknown): RateLimitWindow[] {
  return museUsageReport(payload)?.windows ?? [];
}

// Unambiguous exhaustion: the account is out, whoever the provider is.
// Every branch needs a spent-ness word — a bare "quota" also appears in
// "quota configuration is unavailable", which is an outage. "limit" is not
// a noun here either: "rate limit exceeded" is the throttle below.
const EXHAUSTED_PATTERN =
  /usage limit|out of credits|(?:credits?|quotas?) (?:exhausted|exceeded|reached|used up)|(?:exhausted|exceeded|reached|used up|ran out of) (?:your )?[^"]{0,24}(?:quota|credits?)/i;

// A provider that names the failure in `data.error.type` has said it
// outright, and that beats any reading of prose. The split is the same one
// the patterns make: spent for certain, versus merely throttled.
const EXHAUSTED_TYPES = new Set(["quota_exceeded", "insufficient_quota", "usage_limit_reached", "credits_exhausted"]);
const THROTTLE_TYPES = new Set(["rate_limit_exceeded", "rate_limit", "too_many_requests"]);

// A throttle, which reads two ways. On a CLI that bills a subscription
// window it means the window is spent; on a per-minute API limit it means
// wait a moment and retry, so it only counts for the former.
const THROTTLE_PATTERN = /\b429\b|rate[_ -]?limit|too many requests/i;

// JSON-RPC protocol errors describe a malformed call, never an account.
// Transports differ on whether the code rides as a number or a string.
const PROTOCOL_ERROR_CODES = new Set([-32700, -32600, -32601, -32602]);

function protocolErrorCode(code: number | string | undefined): boolean {
  const numeric = finite(code) ? code : Number(String(code ?? "").trim());
  return Number.isInteger(numeric) && PROTOCOL_ERROR_CODES.has(numeric);
}

/** What a provider may say about when a spent window comes back: an
 * absolute time, or an offset. Every field is optional — the provider
 * decides how much it tells us, and several tell us nothing. */
export interface RejectionDetail {
  error?: { type?: string };
  resetsAt?: number;
  resets_at?: number;
  resetAt?: number;
  reset_at?: number;
  retryAfter?: number;
  retry_after?: number;
  retryAfterSeconds?: number;
}

/** The JSON-RPC fields an ACP rejection carries beside its message. */
export interface RejectionFields {
  code?: number | string;
  data?: RejectionDetail;
}

const RESET_FIELDS = ["resetsAt", "resets_at", "resetAt", "reset_at"] as const;
const RETRY_AFTER_FIELDS = ["retryAfter", "retry_after", "retryAfterSeconds"] as const;

/** The reset the rejection itself carried. Never guessed: no field, no time. */
function resetFromRejection(detail: RejectionDetail | undefined, now: number): number | null {
  if (!detail) return null;
  for (const field of RESET_FIELDS) {
    const at = epochMs(detail[field]);
    if (at !== null) return at;
  }
  for (const field of RETRY_AFTER_FIELDS) {
    const seconds = detail[field];
    if (finite(seconds) && seconds > 0) return now + Math.round(seconds * 1000);
  }
  return null;
}

/** A turn that failed because the account spent its subscription, not
 * because anything broke. Providers bury the reason at different depths —
 * Grok answers with a bare JSON-RPC "Internal error" and names the cause
 * under `data` — so the whole rejection is searched, not just its message.
 *
 * `subscription` is the driver's own `rateLimits` capability: without it a
 * bare 429 is a throttle to wait out, not a plan to top up. */
export function usageLimitFromError(
  error: Error,
  subscription: boolean,
  now = Date.now(),
): { resetsAt: number | null } | null {
  // SAFETY: the ACP transport copies the JSON-RPC `code` and `data` onto the
  // Error before rejecting; both stay optional, and neither is read as more
  // than the shape declared above.
  const { code, data } = error as Error & RejectionFields;
  if (protocolErrorCode(code)) return null;
  const named = data?.error?.type;
  if (named) {
    const spent = EXHAUSTED_TYPES.has(named) || (subscription && THROTTLE_TYPES.has(named));
    return spent ? { resetsAt: resetFromRejection(data, now) } : null;
  }
  let detail = "";
  try {
    detail = JSON.stringify({ code, data }) ?? "";
  } catch {
    // a rejection carrying a cycle still has its message to go on
  }
  const blob = `${error.message} ${detail}`;
  if (!EXHAUSTED_PATTERN.test(blob) && !(subscription && THROTTLE_PATTERN.test(blob))) return null;
  return { resetsAt: resetFromRejection(data, now) };
}

/** The provider ruled a usage limit out, as opposed to saying nothing
 * useful: it named a type that is not one, or the call never reached the
 * account at all. A failure like that keeps its own message — corroborating
 * evidence from billing would only bury it. */
export function isConfirmedNonUsage(error: Error): boolean {
  // SAFETY: same transport-assigned fields usageLimitFromError reads.
  const { code, data } = error as Error & RejectionFields;
  if (protocolErrorCode(code)) return true;
  const named = data?.error?.type;
  return Boolean(named) && !EXHAUSTED_TYPES.has(named!) && !THROTTLE_TYPES.has(named!);
}

/** The first window the account has actually used up. A window whose reset
 * has passed is history, not a limit; one with no reset at all stays spent,
 * because the caller only asks about a turn that already failed. */
export function exhaustedWindow(
  windows: readonly RateLimitWindow[] | undefined,
  now = Date.now(),
): RateLimitWindow | null {
  return windows?.find((w) => w.usedPercent >= 100 && !(w.resetsAt !== null && w.resetsAt <= now)) ?? null;
}
