import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { z } from "zod";

import { writeFileAtomic } from "./atomic.ts";
import { DATA_DIR } from "./config.ts";
import { EFFORT_LEVELS } from "./contracts.ts";

const rowSchema = z.object({
  id: z.string(), botId: z.string(), threadId: z.string(), ownerDeviceId: z.string(),
  selection: z.object({ instanceId: z.string(), model: z.string(), effort: z.enum(EFFORT_LEVELS).optional(), mode: z.enum(["automatic", "pinned"]).optional() }),
  controlKey: z.string(), turnId: z.string(), messageId: z.string(),
  createdAt: z.number(), expiresAt: z.number(), resetsAt: z.number().nullable(), nextCheckAt: z.number(),
  probe: z.number().int().nonnegative(), attempts: z.number().int().nonnegative(), weekly: z.boolean(),
  requiredWindows: z.array(z.string()), state: z.enum(["waiting", "dispatching", "manual"]),
  origin: z.object({ unattended: z.boolean().optional(), keepGoingWake: z.boolean().optional(), paneNoteWake: z.boolean().optional() }),
});
const fileSchema = z.object({ v: z.literal(1), rows: z.array(rowSchema) });
export type LimitWait = z.infer<typeof rowSchema>;
export type UsageWaitView = Pick<LimitWait, "id" | "ownerDeviceId" | "state" | "weekly"> & { resumesAt: number | null; cancelable?: boolean };

export class LimitWaitStore {
  private rows: LimitWait[] = [];
  private writing = false;

  constructor(readonly file = join(DATA_DIR, "limit-waits.json"), private readonly write = writeFileAtomic) {
    if (existsSync(file)) this.rows = fileSchema.parse(JSON.parse(readFileSync(file, "utf8"))).rows;
    for (const row of this.rows) if (row.state === "dispatching") this.set({ ...row, state: "manual" });
  }

  all(): readonly LimitWait[] { return this.rows; }
  get(id: string): LimitWait | undefined { return this.rows.find((row) => row.id === id); }

  set(row: LimitWait, remove = false): void {
    if (this.writing) throw new Error("limit-waits: reentrant write");
    this.writing = true;
    try {
      const rows = this.rows.filter((item) => item.id !== row.id);
      if (!remove) rows.push(row);
      mkdirSync(dirname(this.file), { recursive: true });
      this.write(this.file, `${JSON.stringify({ v: 1, rows })}\n`, { mode: 0o600 });
      this.rows = rows;
    } finally { this.writing = false; }
  }
}
