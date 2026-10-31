// Phones that opened this PC's Wink, for Settings > Phone. PC-local, never synced.
import { mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";

import { writeFileAtomic } from "./atomic.ts";
import { parseJson } from "./schema.ts";

// Its own file: profile-sync.json and the Google binding are read strictly by older builds.
export const PHONE_VISITS_FILE = "phone-visits.json";
export const PHONE_VISIT_TTL_MS = 30 * 24 * 60 * 60_000;
const WRITE_MS = 60_000;
const MAX_VISITS = 20;
const ID_RE = /^[A-Za-z0-9-]{8,64}$/;

const kinds = ["android", "iphone", "ipad", "phone"] as const;
export type PhoneKind = (typeof kinds)[number];
export interface PhoneVisit {
  id: string;
  kind: PhoneKind;
  lastSeen: number;
}

const visitSchema = z.object({ id: z.string().regex(ID_RE), kind: z.enum(kinds), lastSeen: z.number().positive() });
const visitsFileSchema = z.object({ phones: z.array(z.unknown()) });

/** Null for a desktop browser. */
export function phoneKind(userAgent: string | undefined): PhoneKind | null {
  const ua = userAgent ?? "";
  if (/iPad/.test(ua)) return "ipad";
  if (/iPhone|iPod/.test(ua)) return "iphone";
  if (/Android.*Mobile/.test(ua)) return "android";
  if (/Android/.test(ua)) return "phone";
  return /Windows NT|Macintosh|CrOS|X11/.test(ua) ? null : "phone";
}

export class PhoneVisits {
  private readonly dataDir: string;
  private readonly now: () => number;
  private visits: PhoneVisit[] = [];
  private readonly written = new Map<string, number>();

  constructor(dataDir: string, now: () => number = Date.now) {
    this.dataDir = dataDir;
    this.now = now;
    try {
      const file = visitsFileSchema.safeParse(parseJson(readFileSync(join(dataDir, PHONE_VISITS_FILE), "utf8")));
      for (const entry of file.success ? file.data.phones : []) {
        const parsed = visitSchema.safeParse(entry);
        if (parsed.success) this.visits.push(parsed.data);
      }
    } catch {
      // First run, or unreadable: no phones yet.
    }
  }

  /** Newest first, without phones idle past the TTL. */
  list(): PhoneVisit[] {
    const cutoff = this.now() - PHONE_VISIT_TTL_MS;
    return this.visits.filter((visit) => visit.lastSeen > cutoff).sort((a, b) => b.lastSeen - a.lastSeen);
  }

  seen(id: string, userAgent: string | undefined): void {
    const kind = phoneKind(userAgent);
    if (!kind || !ID_RE.test(id)) return;
    const now = this.now();
    const visit = this.visits.find((entry) => entry.id === id);
    if (visit) Object.assign(visit, { kind, lastSeen: now });
    else this.visits.push({ id, kind, lastSeen: now });
    if (now - (this.written.get(id) ?? -Infinity) < WRITE_MS) return;
    this.written.set(id, now);
    this.visits = this.list().slice(0, MAX_VISITS);
    try {
      mkdirSync(this.dataDir, { recursive: true });
      writeFileAtomic(join(this.dataDir, PHONE_VISITS_FILE), `${JSON.stringify({ phones: this.visits }, null, 2)}\n`);
    } catch {
      // The list stays right in memory; the next minute retries.
    }
  }
}
