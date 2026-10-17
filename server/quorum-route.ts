// Quorum site stats for Settings. The token only ever leaves in the request header.

import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import { z } from "zod";

const STATS_URL = "https://heyquorum.com/api/admin/stats?days=7";
const TIMEOUT_MS = 10_000;
const MAX_DAYS = 90;
const TOKEN_RE = /^[0-9a-f]{64}$/i;
const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;

const count = z.number().nonnegative();
const date = z.string().regex(DAY_RE);
const provider = count.optional().catch(undefined);

const quorumDaySchema = z.object({
  day: date,
  costCents: count,
  costByProvider: z.object({ claude: provider, gpt: provider, gemini: provider, perplexity: provider, search: provider }).catch({}),
  visitors: count,
  signups: count,
});

const quorumStatsSchema = z.object({
  days: z.array(quorumDaySchema).min(1).max(MAX_DAYS),
  budget: z.object({ dailyCapCents: count, todayCountedCents: count }).nullable().catch(null),
  tracking: z.object({ costSince: date.nullable(), visitorsSince: date.nullable() }),
});

export type QuorumStats = z.output<typeof quorumStatsSchema>;

export type QuorumReply =
  | { state: "off" | "notEnabled" | "denied" }
  | { state: "ok"; stats: QuorumStats; fetchedAt: number; now: number }
  | { state: "error"; now: number; stats?: QuorumStats; fetchedAt?: number };

export function readQuorumToken(home: string = homedir()): string | null {
  try {
    return readFileSync(join(home, ".quorum-stats", "token.txt"), "utf8").trim();
  } catch {
    return null;
  }
}

/** The last good stats live in this closure, so a restart forgets them. */
export function createQuorumRoute(
  readToken: () => string | null = readQuorumToken,
  fetchImpl: typeof fetch = fetch,
  now: () => number = Date.now,
): () => Promise<QuorumReply> {
  let kept: { stats: QuorumStats; fetchedAt: number } | null = null;
  const failed = (): QuorumReply => (kept ? { state: "error", now: now(), ...kept } : { state: "error", now: now() });
  return async () => {
    const token = readToken();
    if (token === null) return { state: "off" };
    if (!TOKEN_RE.test(token)) return { state: "denied" };
    try {
      const response = await fetchImpl(STATS_URL, {
        headers: { Authorization: `Bearer ${token}` },
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
      if (response.status === 404) return { state: "notEnabled" };
      if (response.status === 401) return { state: "denied" };
      if (!response.ok) return failed();
      const parsed = quorumStatsSchema.safeParse(await response.json());
      if (!parsed.success) return failed();
      const stats = parsed.data;
      const fetchedAt = now();
      kept = { stats, fetchedAt };
      return { state: "ok", stats, fetchedAt, now: fetchedAt };
    } catch {
      return failed();
    }
  };
}

export const quorumRoute = createQuorumRoute();
