// Newest subscription-window report per engine instance, persisted so usage
// bars survive a restart. Shape on disk mirrors the live map.
import { mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";

import { writeFileAtomic } from "./atomic.ts";
import type { RateLimitWindow } from "./contracts.ts";

export type RateLimitsReport = { windows: RateLimitWindow[]; observedAt: string };
export type RateLimitsMap = Map<string, RateLimitsReport>;

const windowSchema = z.object({
  id: z.string(),
  usedPercent: z.number().finite(),
  resetsAt: z.number().finite().nullable(),
  windowMinutes: z.number().finite().optional(),
});
const reportSchema = z.object({
  windows: z.array(windowSchema),
  observedAt: z.string().refine((value) => !Number.isNaN(Date.parse(value))),
});
const fileSchema = z.record(z.string(), reportSchema);

export function rateLimitsFile(dataDir: string): string {
  return join(dataDir, "rate-limits.json");
}

export function loadRateLimits(dataDir: string): RateLimitsMap {
  try {
    const parsed = fileSchema.safeParse(JSON.parse(readFileSync(rateLimitsFile(dataDir), "utf8")));
    if (!parsed.success) return new Map();
    return new Map(Object.entries(parsed.data));
  } catch {
    return new Map();
  }
}

export function saveRateLimits(map: RateLimitsMap, dataDir: string): void {
  mkdirSync(dataDir, { recursive: true });
  writeFileAtomic(rateLimitsFile(dataDir), JSON.stringify(Object.fromEntries(map), null, 2), { mode: 0o600 });
}

let saveTimer: ReturnType<typeof setTimeout> | null = null;

export function scheduleSaveRateLimits(map: RateLimitsMap, dataDir: string, delayMs = 1_000): void {
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    saveTimer = null;
    try {
      saveRateLimits(map, dataDir);
    } catch (error) {
      console.error("rate-limits: persist failed", error);
    }
  }, delayMs);
}
