// Phone open timings (src/lib/cold-open-timing.ts), kept on this PC only and never synced.
import { mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";

import { writeFileAtomic } from "./atomic.ts";

export const COLD_OPEN_FILE = join("diag", "cold-open.jsonl");
export const COLD_OPEN_MAX_BYTES = 8 * 1024;
export const COLD_OPEN_KEEP = 200;

const ms = z.number().finite();
const size = z.number().int().nonnegative();
const request = z.object({ start: ms, end: ms, transferSize: size, encodedBodySize: size }).strict();
const nav = z
  .object({
    fetchStart: ms,
    connectStart: ms,
    connectEnd: ms,
    secureConnectionStart: ms,
    requestStart: ms,
    responseStart: ms,
    responseEnd: ms,
    domInteractive: ms,
    domContentLoadedEventEnd: ms,
  })
  .partial()
  .strict();

export const coldOpenRecordSchema = z
  .object({
    label: z.enum(["notification", "open", "warm"]),
    t0: ms.optional(),
    nav: nav.optional(),
    firstPaint: ms.optional(),
    firstContentfulPaint: ms.optional(),
    mount: ms.optional(),
    sseOpen: ms.optional(),
    hello: ms.optional(),
    bots: request.optional(),
    taskSwitch: request.optional(),
    chatPaint: ms.optional(),
    jsCached: z.boolean().optional(),
    cssCached: z.boolean().optional(),
    navigationType: z.enum(["navigate", "reload", "back_forward", "prerender"]).optional(),
    displayMode: z.enum(["standalone", "browser"]),
    visibility: z.string().max(16),
    build: z.string().max(128).optional(),
    userAgent: z.string().max(512),
  })
  .strict();

type Received = { status: 200 } | { status: 400 | 413; error: string };

async function readCapped(body: AsyncIterable<Buffer>): Promise<string | null> {
  const chunks: Buffer[] = [];
  let bytes = 0;
  // Keep draining past the cap so the 413 still reaches the phone.
  for await (const chunk of body) {
    bytes += chunk.length;
    if (bytes <= COLD_OPEN_MAX_BYTES) chunks.push(chunk);
  }
  return bytes > COLD_OPEN_MAX_BYTES ? null : Buffer.concat(chunks).toString("utf8");
}

export async function receiveColdOpen(req: AsyncIterable<Buffer>, dataDir: string, now = Date.now()): Promise<Received> {
  const text = await readCapped(req);
  if (text === null) return { status: 413, error: "body too large" };
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    return { status: 400, error: "invalid JSON body" };
  }
  const parsed = coldOpenRecordSchema.safeParse(body);
  if (!parsed.success) return { status: 400, error: "invalid cold-open record" };
  const path = join(dataDir, COLD_OPEN_FILE);
  mkdirSync(join(dataDir, "diag"), { recursive: true });
  let lines: string[] = [];
  try {
    lines = readFileSync(path, "utf8").split("\n").filter(Boolean);
  } catch {
    // First record.
  }
  lines.push(JSON.stringify({ receivedAt: new Date(now).toISOString(), ...parsed.data }));
  writeFileAtomic(path, `${lines.slice(-COLD_OPEN_KEEP).join("\n")}\n`);
  return { status: 200 };
}
