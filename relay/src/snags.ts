// Stuck-worker reports from team PCs, held for the owner's claim. One JSON
// line per snag, rewritten whole on each change; payloads never reach the log.

import { join } from "node:path";
import { z } from "zod";
import { LABEL_RE, teamSnagSchema, type TeamSnag } from "../../shared/relay-protocol.ts";
import { silentLogger, type Logger } from "./log.ts";
import { readText, writeAtomic } from "./team.ts";

const FILE = "team-snags";
const DAY_MS = 24 * 60 * 60 * 1000;
export const SNAG_KEEP_MS = 14 * DAY_MS;
export const SNAG_LEASE_MS = 10 * 60_000;
export const SNAG_STORE_BYTES = 4 * 1024 * 1024;
/** Per claim, and per ack. */
export const SNAG_CLAIM_MAX = 256;

const heldSchema = z.strictObject({
  label: z.string().regex(LABEL_RE),
  received: z.int().nonnegative(),
  lease: z.int().nonnegative(),
  snag: teamSnagSchema,
});
type Held = z.infer<typeof heldSchema>;

const bytes = (entry: Held) => Buffer.byteLength(JSON.stringify(entry), "utf8") + 1;

export type AddResult = "stored" | "duplicate" | "over-cap";

export class SnagStore {
  private held: Held[] = [];
  private size = 0;
  private readonly today = new Map<string, { day: number; count: number }>();
  private writes: Promise<void> = Promise.resolve();
  private queued = false;
  private readonly file: string;

  private constructor(
    dir: string,
    private readonly perLabelPerDay: number,
    private readonly now: () => number,
    private readonly log: Logger,
  ) {
    this.file = join(dir, FILE);
  }

  static async open(dir: string, perLabelPerDay: number, now: () => number = Date.now, log: Logger = silentLogger): Promise<SnagStore> {
    const store = new SnagStore(dir, perLabelPerDay, now, log);
    for (const line of (await readText(store.file)).split("\n")) {
      if (!line) continue;
      try {
        const parsed = heldSchema.safeParse(JSON.parse(line));
        if (parsed.success) store.keep(parsed.data);
      } catch {}
    }
    if (store.prune()) await store.save();
    return store;
  }

  add(label: string, snag: TeamSnag): AddResult {
    this.prune();
    if (this.held.some((entry) => entry.snag.id === snag.id)) return "duplicate";
    const day = Math.floor(this.now() / DAY_MS);
    const seen = this.today.get(label);
    const count = seen?.day === day ? seen.count : 0;
    if (count >= this.perLabelPerDay) return "over-cap";
    this.today.set(label, { day, count: count + 1 });
    this.keep({ label, received: this.now(), lease: 0, snag });
    // Oldest go first once the store is full.
    while (this.size > SNAG_STORE_BYTES && this.held.length > 1) this.size -= bytes(this.held.shift()!);
    void this.save();
    return "stored";
  }

  /** Unleased snags, oldest first, leased to the caller for SNAG_LEASE_MS. */
  claim(): { label: string; snag: TeamSnag }[] {
    const pruned = this.prune();
    const now = this.now();
    const out = this.held.filter((entry) => entry.lease <= now).slice(0, SNAG_CLAIM_MAX);
    for (const entry of out) entry.lease = now + SNAG_LEASE_MS;
    if (out.length || pruned) void this.save();
    return out.map(({ label, snag }) => ({ label, snag }));
  }

  ack(ids: readonly string[]): number {
    const drop = new Set(ids);
    const removed = this.drop((entry) => drop.has(entry.snag.id));
    if (removed) void this.save();
    return removed;
  }

  async close(): Promise<void> {
    await this.writes;
  }

  private keep(entry: Held): void {
    this.held.push(entry);
    this.size += bytes(entry);
  }

  private drop(match: (entry: Held) => boolean): number {
    const before = this.held.length;
    this.held = this.held.filter((entry) => {
      if (!match(entry)) return true;
      this.size -= bytes(entry);
      return false;
    });
    return before - this.held.length;
  }

  private prune(): boolean {
    const cutoff = this.now() - SNAG_KEEP_MS;
    return this.drop((entry) => entry.received < cutoff) > 0;
  }

  /** Writes the state as it stands when the previous write ends, so a burst costs one rewrite. */
  private save(): Promise<void> {
    if (this.queued) return this.writes;
    this.queued = true;
    const write = this.writes.then(() => {
      this.queued = false;
      return writeAtomic(this.file, this.held.map((entry) => `${JSON.stringify(entry)}\n`).join(""));
    });
    this.writes = write.catch(() => this.log.log("snags-write-failed", {}));
    return this.writes;
  }
}
